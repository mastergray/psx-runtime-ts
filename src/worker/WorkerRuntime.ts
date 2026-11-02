// Dependencies:
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Normalizes protocol, lifecycle, and core-operation failures
import {
    isPsxMachineInfo,     // Validates startup metadata returned by the core bridge
    isPsxRumbleEvent,     // Validates rumble output returned per frame
} from "../shared.types.js";
import {
    isWorkerCommand,        // Validates every main-thread command before dispatch
    isWorkerRequestType,    // Identifies commands that require correlated responses
} from "../LibretroPsxAdapter/protocol.js";
import FramePacer from "./FramePacer.js";                      // Converts timestamps into bounded core frame counts
import TransferBufferPool from "./TransferBufferPool.js";    // Reuses transferable RGBA buffers with bounded backpressure
import {
    convertAudioSamples,    // Converts signed 16-bit stereo samples to normalized float output
    convertVideoFrame,      // Converts supported core pixels into RGBA transfer buffers
} from "./av.js";

// Type dependencies:
import type {
    WorkerCommand,           // Validated main-thread command union
    WorkerErrorData,         // Cloneable normalized error payload
    WorkerOutput,            // Cloneable response and event union
    WorkerRequestType,       // Correlated command discriminants
    WorkerResponseResult,    // Successful correlated response union
    WorkerStartPayload,      // Fully resolved startup input for the core bridge
} from "../LibretroPsxAdapter/protocol.js";
import type {
    ControllerPort,     // Physical controller and memory-card slot
    PsxAxis,            // Closed set of analog controls
    PsxButton,          // Closed set of digital controls
    PsxMachineInfo,     // Core startup identity and capabilities
    PsxRumbleEvent,     // Strong and weak motor output
} from "../shared.types.js";
import type { CoreVideoFrame } from "./av.js";    // Raw core video frame accepted by the converter

/**
 *
 * Type Declarations
 *
 */

// TYPE :: T|PROMISE(T)
// Allows synchronous fake cores and asynchronous production bridges behind one runtime.
// NOTE: <T> is the operation result type.
type MaybePromise<T> = T | Promise<T>;

// TYPE :: {video:coreVideoFrame?, audio:int16Array?, rumble:[psxRumbleEvent]?}
// Optional video, audio, and controller output produced by one core frame.
export interface CoreRunOutput {
    readonly video?: CoreVideoFrame | null;               // Raw frame or duplicate-frame marker
    readonly audio?: Int16Array;                           // Interleaved signed 16-bit stereo samples
    readonly rumble?: ReadonlyArray<PsxRumbleEvent>;      // Motor states changed during the frame
}

// TYPE :: worker-facing emulation core lifecycle
// Backend contract serialized by WorkerRuntime.
export interface WorkerCore {
    // METHOD :: workerStartPayload -> maybePromise<psxMachineInfo>
    // Starts a core from fully resolved content and firmware.
    start(payload: WorkerStartPayload): MaybePromise<PsxMachineInfo>;
    // METHOD :: VOID -> maybePromise<coreRunOutput>
    // Executes one emulation frame and returns its outputs.
    runFrame(): MaybePromise<CoreRunOutput>;
    // METHOD :: controllerPort, psxButton, BOOLEAN -> VOID
    // Sets one digital controller state.
    setButton(port: ControllerPort, button: PsxButton, pressed: boolean): void;
    // METHOD :: controllerPort, psxAxis, NUMBER -> VOID
    // Sets one analog controller state.
    setAxis(port: ControllerPort, axis: PsxAxis, value: number): void;
    // METHOD :: "soft"|"hard" -> maybePromise(VOID)
    // Resets core execution state.
    reset(kind: "soft" | "hard"): MaybePromise<void>;
    // METHOD :: NUMBER -> maybePromise({discIndex:NUMBER, trayOpen:BOOLEAN})
    // Changes the active disc and reports drive state.
    setDisc(index: number): MaybePromise<{ readonly discIndex: number; readonly trayOpen: boolean }>;
    // METHOD :: controllerPort -> maybePromise(uint8Array)
    // Reads one physical memory-card image.
    readMemoryCard(slot: ControllerPort): MaybePromise<Uint8Array>;
    // METHOD :: VOID -> maybePromise(uint8Array)
    // Captures one core save-state payload.
    serializeState(): MaybePromise<Uint8Array>;
    // METHOD :: uint8Array -> maybePromise(VOID)
    // Restores one core save-state payload.
    unserializeState(bytes: Uint8Array): MaybePromise<void>;
    // METHOD :: VOID -> maybePromise(VOID)
    // Stops and releases core resources.
    stop(): MaybePromise<void>;
}

// TYPE :: "idle"|"running"|"paused"|"exited"|"failed"
// Worker-owned core lifecycle state.
type RuntimeState = "idle" | "running" | "paused" | "exited" | "failed";

/**
 *
 * Class
 *
 */

// Serializes validated worker commands around one core and emits transferable browser outputs.
export default class WorkerRuntime {

    /* Instance Fields */
    private readonly _core: WorkerCore;                         // Backend core bridge owned by this runtime
    private readonly _videoPool: TransferBufferPool;            // Bounded pool of transferable RGBA buffers
    private _tail: Promise<void> = Promise.resolve();           // Tail that serializes all command handling
    private _state: RuntimeState = "idle";                      // Current core lifecycle state
    private _generation = 0;                                    // Active main-thread client generation
    private _pacer: FramePacer | null = null;                   // Timestamp-to-frame accumulator after startup
    private _geometryKey = "";                                  // Last emitted geometry identity
    private _stopped = false;                                   // Whether core stop was already attempted

    // CONSTRUCTOR :: workerCore, NUMBER? -> workerRuntime
    // Retains the core and creates a bounded transferable video pool.
    constructor(core: WorkerCore, videoBufferCount = 3) {
        this._core = core;
        this._videoPool = new TransferBufferPool(videoBufferCount);
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> runtimeState
    // Returns the current worker-owned core lifecycle state.
    get state(): RuntimeState {
        return this._state;
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: UNKNOWN -> PROMISE([workerOutput])
    // Validates and serially dispatches one main-thread command.
    dispatch(value: unknown): Promise<WorkerOutput[]> {
        if (!isWorkerCommand(value)) {
            return Promise.reject(new PsxRuntimeError({
                code: PsxRuntimeError.CODE.INVALID_MESSAGE,
                message: "Worker command failed structural validation.",
                data: null,
            }));
        }
        const command = value;
        const operation = this._tail.then(async () => this._handle(command));
        this._tail = operation.then(() => undefined, () => undefined);
        return operation;
    }

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: workerCommand -> PROMISE([workerOutput])
    // Routes one validated command according to generation and lifecycle state.
    private async _handle(command: WorkerCommand): Promise<WorkerOutput[]> {
        if (command.type === "start") return this._start(command);
        if (this._generation !== 0 && command.generation !== this._generation) return [];
        if (this._state === "exited" || this._state === "failed") return [];
        if (this._state === "idle") {
            return this._notRunning(command);
        }
        try {
            switch (command.type) {
                case "tick": return this._tick(command.timestamp);
                case "set-button":
                    this._core.setButton(command.port, command.button, command.pressed);
                    return [];
                case "set-axis":
                    this._core.setAxis(command.port, command.axis, command.value);
                    return [];
                case "return-video-buffer":
                    this._videoPool.release(command.bufferId, command.buffer);
                    return [];
                case "pause":
                    this._state = "paused";
                    this._pacer!.pause();
                    return [requestSuccess(command, "pause", null)];
                case "resume":
                    this._state = "running";
                    this._pacer!.resume();
                    return [requestSuccess(command, "resume", null)];
                case "reset":
                    await this._core.reset(command.kind);
                    this._pacer!.reset();
                    return [requestSuccess(command, "reset", null)];
                case "set-disc": {
                    const result = await this._core.setDisc(command.index);
                    this._pacer!.reset();
                    return [requestSuccess(command, "set-disc", result)];
                }
                case "read-memory-card": {
                    const card = Uint8Array.from(await this._core.readMemoryCard(command.slot));
                    if (card.byteLength !== 128 * 1024) throw new Error("Core returned an invalid memory card");
                    return [requestSuccess(command, "read-memory-card", card)];
                }
                case "serialize-state": {
                    const state = Uint8Array.from(await this._core.serializeState());
                    if (state.byteLength === 0) throw new Error("Core returned an empty save state");
                    return [requestSuccess(command, "serialize-state", state)];
                }
                case "unserialize-state":
                    await this._core.unserializeState(Uint8Array.from(command.bytes));
                    this._pacer!.reset();
                    return [requestSuccess(command, "unserialize-state", null)];
                case "exit":
                    await this._stop();
                    this._state = "exited";
                    this._videoPool.close();
                    return [
                        requestSuccess(command, "exit", null),
                        { type: "exit", generation: this._generation },
                    ];
                default: return [];
            }
        } catch (error) {
            return this._fail(command, error);
        }
    }

    // METHOD :: startWorkerCommand -> PROMISE([workerOutput])
    // Starts the core once and initializes pacing and geometry state.
    private async _start(command: Extract<WorkerCommand, { type: "start" }>): Promise<WorkerOutput[]> {
        if (this._state !== "idle") {
            const error = new PsxRuntimeError({
                code: PsxRuntimeError.CODE.ALREADY_STARTED,
                message: "Worker core has already started.",
            });
            return [requestFailure(command, "start", error)];
        }
        this._generation = command.generation;
        try {
            const machine = await this._core.start(command.payload);
            if (!isPsxMachineInfo(machine)) throw new Error("Core returned invalid machine information");
            this._pacer = new FramePacer(machine.framesPerSecond);
            this._state = "running";
            this._geometryKey = [
                machine.geometry.width,
                machine.geometry.height,
                machine.geometry.aspectRatio,
            ].join(":");
            return [requestSuccess(command, "start", machine)];
        } catch (error) {
            return this._fail(command, error);
        }
    }

    // METHOD :: workerCommand -> [workerOutput]
    // Returns a typed not-started response for correlated idle commands.
    private _notRunning(command: WorkerCommand): WorkerOutput[] {
        if (!isWorkerRequestType(command.type)) return [];
        return [requestFailure(command, command.type, new PsxRuntimeError({
            code: PsxRuntimeError.CODE.NOT_STARTED,
            message: "Worker core has not started.",
        }))];
    }

    // METHOD :: NUMBER -> PROMISE([workerOutput])
    // Advances pacing and converts core video, audio, rumble, and timing outputs.
    private async _tick(timestamp: number): Promise<WorkerOutput[]> {
        if (this._state !== "running") return [];
        const pacing = this._pacer!.advance(timestamp);
        const output: WorkerOutput[] = [];
        let droppedVideoFrames = 0;
        for (let frameIndex = 0; frameIndex < pacing.frames; frameIndex++) {
            const frame = await this._core.runFrame();
            if (frame.video !== undefined && frame.video !== null) {
                const videoBytes = frame.video.width * frame.video.height * 4;
                const lease = this._videoPool.acquire(videoBytes);
                const geometryKey = [frame.video.width, frame.video.height, frame.video.aspectRatio].join(":");
                if (geometryKey !== this._geometryKey) {
                    this._geometryKey = geometryKey;
                    output.push({
                        type: "geometry",
                        generation: this._generation,
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
                        generation: this._generation,
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
                    generation: this._generation,
                    samples: samples.buffer as ArrayBuffer,
                    frames: samples.length / 2,
                });
            }
            for (const rumble of frame.rumble ?? []) {
                if (!isPsxRumbleEvent(rumble)) throw new Error("Core returned invalid rumble output");
                output.push({ type: "rumble", generation: this._generation, ...rumble });
            }
            output.push({ type: "tick", generation: this._generation });
        }
        if (pacing.droppedMilliseconds > 0 || droppedVideoFrames > 0) {
            output.push({
                type: "dropped-time",
                generation: this._generation,
                milliseconds: pacing.droppedMilliseconds,
                videoFrames: droppedVideoFrames,
            });
        }
        return output;
    }

    // METHOD :: workerCommand, UNKNOWN -> PROMISE([workerOutput])
    // Stops the core, closes buffers, and returns a correlated or event failure.
    private async _fail(command: WorkerCommand, caught: unknown): Promise<WorkerOutput[]> {
        const error = asRuntimeError(caught);
        await this._stop().catch(() => undefined);
        this._state = "failed";
        this._videoPool.close();
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

    // METHOD :: VOID -> PROMISE(VOID)
    // Stops the core at most once.
    private async _stop(): Promise<void> {
        if (this._stopped) return;
        this._stopped = true;
        await this._core.stop();
    }
}

/**
 *
 *  Helper Functions
 *
 */

// HELPER :: workerCommand, workerRequestType, psxRuntimeError -> workerOutput
// Builds one cloneable correlated failure response.
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

// HELPER :: workerCommand, workerRequestType, workerResponseResult -> workerOutput
// Builds one cloneable correlated success response.
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

// HELPER :: UNKNOWN -> psxRuntimeError
// Preserves typed errors and normalizes arbitrary core failures.
const asRuntimeError = (error: unknown): PsxRuntimeError => PsxRuntimeError.is(error)
    ? error
    : new PsxRuntimeError({
        code: PsxRuntimeError.CODE.WORKER_FAILED,
        message: error instanceof Error ? error.message : "Worker core operation failed.",
        data: null,
    });
