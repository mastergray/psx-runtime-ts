import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";
import { isPsxMachineInfo, isPsxRumbleEvent } from "../shared.types.js";
import {
    isWorkerCommand,
    isWorkerRequestType,
} from "../LibretroPsxAdapter/protocol.js";
import FramePacer from "./FramePacer.js";
import TransferBufferPool from "./TransferBufferPool.js";
import { convertAudioSamples, convertVideoFrame } from "./av.js";

import type {
    WorkerCommand,
    WorkerErrorData,
    WorkerOutput,
    WorkerRequestType,
    WorkerResponseResult,
    WorkerStartPayload,
} from "../LibretroPsxAdapter/protocol.js";
import type {
    ControllerPort,
    PsxAxis,
    PsxButton,
    PsxMachineInfo,
    PsxRumbleEvent,
} from "../shared.types.js";
import type { CoreVideoFrame } from "./av.js";

type MaybePromise<T> = T | Promise<T>;

export interface CoreRunOutput {
    readonly video?: CoreVideoFrame | null;
    readonly audio?: Int16Array;
    readonly rumble?: ReadonlyArray<PsxRumbleEvent>;
}

export interface WorkerCore {
    start(payload: WorkerStartPayload): MaybePromise<PsxMachineInfo>;
    runFrame(): MaybePromise<CoreRunOutput>;
    setButton(port: ControllerPort, button: PsxButton, pressed: boolean): void;
    setAxis(port: ControllerPort, axis: PsxAxis, value: number): void;
    reset(kind: "soft" | "hard"): MaybePromise<void>;
    setDisc(index: number): MaybePromise<{ readonly discIndex: number; readonly trayOpen: boolean }>;
    readMemoryCard(slot: ControllerPort): MaybePromise<Uint8Array>;
    serializeState(): MaybePromise<Uint8Array>;
    unserializeState(bytes: Uint8Array): MaybePromise<void>;
    stop(): MaybePromise<void>;
}

type RuntimeState = "idle" | "running" | "paused" | "exited" | "failed";

const requestFailure = (
    command: WorkerCommand,
    type: WorkerRequestType,
    error: PsxRuntimeError,
): WorkerOutput => ({
    type: "response",
    command: type,
    requestId: command.requestId,
    generation: command.generation,
    ok: false,
    error: { code: error.code, message: error.message, data: error.data },
});

const requestSuccess = (
    command: WorkerCommand,
    type: WorkerRequestType,
    result: WorkerResponseResult,
): WorkerOutput => ({
    type: "response",
    command: type,
    requestId: command.requestId,
    generation: command.generation,
    ok: true,
    result,
});

const asRuntimeError = (error: unknown): PsxRuntimeError => PsxRuntimeError.is(error)
    ? error
    : new PsxRuntimeError({
        code: PsxRuntimeError.CODE.WORKER_FAILED,
        message: error instanceof Error ? error.message : "Worker core operation failed.",
        data: null,
    });

export default class WorkerRuntime {
    readonly #core: WorkerCore;
    readonly #videoPool: TransferBufferPool;
    #tail: Promise<void> = Promise.resolve();
    #state: RuntimeState = "idle";
    #generation = 0;
    #pacer: FramePacer | null = null;
    #geometryKey = "";
    #stopped = false;

    constructor(core: WorkerCore, videoBufferCount = 3) {
        this.#core = core;
        this.#videoPool = new TransferBufferPool(videoBufferCount);
    }

    get state(): RuntimeState {
        return this.#state;
    }

    dispatch(value: unknown): Promise<WorkerOutput[]> {
        if (!isWorkerCommand(value)) {
            return Promise.reject(new PsxRuntimeError({
                code: PsxRuntimeError.CODE.INVALID_MESSAGE,
                message: "Worker command failed structural validation.",
                data: null,
            }));
        }
        const command = value;
        const operation = this.#tail.then(async () => this.#handle(command));
        this.#tail = operation.then(() => undefined, () => undefined);
        return operation;
    }

    async #handle(command: WorkerCommand): Promise<WorkerOutput[]> {
        if (command.type === "start") return this.#start(command);
        if (this.#generation !== 0 && command.generation !== this.#generation) return [];
        if (this.#state === "exited" || this.#state === "failed") return [];
        if (this.#state === "idle") {
            return this.#notRunning(command);
        }
        try {
            switch (command.type) {
                case "tick": return this.#tick(command.timestamp);
                case "set-button":
                    this.#core.setButton(command.port, command.button, command.pressed);
                    return [];
                case "set-axis":
                    this.#core.setAxis(command.port, command.axis, command.value);
                    return [];
                case "return-video-buffer":
                    this.#videoPool.release(command.bufferId, command.buffer);
                    return [];
                case "pause":
                    this.#state = "paused";
                    this.#pacer!.pause();
                    return [requestSuccess(command, "pause", null)];
                case "resume":
                    this.#state = "running";
                    this.#pacer!.resume();
                    return [requestSuccess(command, "resume", null)];
                case "reset":
                    await this.#core.reset(command.kind);
                    this.#pacer!.reset();
                    return [requestSuccess(command, "reset", null)];
                case "set-disc": {
                    const result = await this.#core.setDisc(command.index);
                    this.#pacer!.reset();
                    return [requestSuccess(command, "set-disc", result)];
                }
                case "read-memory-card": {
                    const card = Uint8Array.from(await this.#core.readMemoryCard(command.slot));
                    if (card.byteLength !== 128 * 1024) throw new Error("Core returned an invalid memory card");
                    return [requestSuccess(command, "read-memory-card", card)];
                }
                case "serialize-state": {
                    const state = Uint8Array.from(await this.#core.serializeState());
                    if (state.byteLength === 0) throw new Error("Core returned an empty save state");
                    return [requestSuccess(command, "serialize-state", state)];
                }
                case "unserialize-state":
                    await this.#core.unserializeState(Uint8Array.from(command.bytes));
                    this.#pacer!.reset();
                    return [requestSuccess(command, "unserialize-state", null)];
                case "exit":
                    await this.#stop();
                    this.#state = "exited";
                    this.#videoPool.close();
                    return [
                        requestSuccess(command, "exit", null),
                        { type: "exit", generation: this.#generation },
                    ];
                default: return [];
            }
        } catch (error) {
            return this.#fail(command, error);
        }
    }

    async #start(command: Extract<WorkerCommand, { type: "start" }>): Promise<WorkerOutput[]> {
        if (this.#state !== "idle") {
            const error = new PsxRuntimeError({
                code: PsxRuntimeError.CODE.ALREADY_STARTED,
                message: "Worker core has already started.",
            });
            return [requestFailure(command, "start", error)];
        }
        this.#generation = command.generation;
        try {
            const machine = await this.#core.start(command.payload);
            if (!isPsxMachineInfo(machine)) throw new Error("Core returned invalid machine information");
            this.#pacer = new FramePacer(machine.framesPerSecond);
            this.#state = "running";
            this.#geometryKey = [
                machine.geometry.width,
                machine.geometry.height,
                machine.geometry.aspectRatio,
            ].join(":");
            return [requestSuccess(command, "start", machine)];
        } catch (error) {
            return this.#fail(command, error);
        }
    }

    #notRunning(command: WorkerCommand): WorkerOutput[] {
        if (!isWorkerRequestType(command.type)) return [];
        return [requestFailure(command, command.type, new PsxRuntimeError({
            code: PsxRuntimeError.CODE.NOT_STARTED,
            message: "Worker core has not started.",
        }))];
    }

    async #tick(timestamp: number): Promise<WorkerOutput[]> {
        if (this.#state !== "running") return [];
        const pacing = this.#pacer!.advance(timestamp);
        const output: WorkerOutput[] = [];
        let droppedVideoFrames = 0;
        for (let frameIndex = 0; frameIndex < pacing.frames; frameIndex++) {
            const frame = await this.#core.runFrame();
            if (frame.video !== undefined && frame.video !== null) {
                const videoBytes = frame.video.width * frame.video.height * 4;
                const lease = this.#videoPool.acquire(videoBytes);
                const geometryKey = [frame.video.width, frame.video.height, frame.video.aspectRatio].join(":");
                if (geometryKey !== this.#geometryKey) {
                    this.#geometryKey = geometryKey;
                    output.push({
                        type: "geometry",
                        generation: this.#generation,
                        width: frame.video.width,
                        height: frame.video.height,
                        aspectRatio: frame.video.aspectRatio,
                    });
                }
                if (lease === null) {
                    droppedVideoFrames++;
                } else {
                    convertVideoFrame(frame.video, lease.buffer);
                    output.push({
                        type: "frame",
                        generation: this.#generation,
                        bufferId: lease.id,
                        width: frame.video.width,
                        height: frame.video.height,
                        aspectRatio: frame.video.aspectRatio,
                        rgba: lease.buffer,
                    });
                }
            }
            if (frame.audio !== undefined && frame.audio.length > 0) {
                if (frame.audio.length % 2 !== 0) throw new Error("Core returned non-stereo audio");
                const samples = convertAudioSamples(frame.audio);
                output.push({
                    type: "sound",
                    generation: this.#generation,
                    samples: samples.buffer as ArrayBuffer,
                    frames: samples.length / 2,
                });
            }
            for (const rumble of frame.rumble ?? []) {
                if (!isPsxRumbleEvent(rumble)) throw new Error("Core returned invalid rumble output");
                output.push({ type: "rumble", generation: this.#generation, ...rumble });
            }
            output.push({ type: "tick", generation: this.#generation });
        }
        if (pacing.droppedMilliseconds > 0 || droppedVideoFrames > 0) {
            output.push({
                type: "dropped-time",
                generation: this.#generation,
                milliseconds: pacing.droppedMilliseconds,
                videoFrames: droppedVideoFrames,
            });
        }
        return output;
    }

    async #fail(command: WorkerCommand, caught: unknown): Promise<WorkerOutput[]> {
        const error = asRuntimeError(caught);
        await this.#stop().catch(() => undefined);
        this.#state = "failed";
        this.#videoPool.close();
        const errorData: WorkerErrorData = { code: error.code, message: error.message, data: error.data };
        if (isWorkerRequestType(command.type)) {
            return [{
                type: "response",
                command: command.type,
                requestId: command.requestId,
                generation: command.generation,
                ok: false,
                error: errorData,
            }];
        }
        return [{ type: "error", generation: command.generation, error: errorData }];
    }

    async #stop(): Promise<void> {
        if (this.#stopped) return;
        this.#stopped = true;
        await this.#core.stop();
    }
}
