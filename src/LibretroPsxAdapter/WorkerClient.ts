import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";
import { isWorkerOutput } from "./protocol.js";

import type {
    FrameScheduler,
    Listener,
    PsxFrameEvent,
    PsxGeometry,
    PsxAxis,
    PsxButton,
    PsxMachineInfo,
    PsxRumbleEvent,
    PsxSoundEvent,
    Unsubscribe,
} from "../shared.types.js";
import type {
    WorkerCommand,
    WorkerOutput,
    WorkerRequestType,
    WorkerResponseResult,
    WorkerStartPayload,
} from "./protocol.js";
import type {
    PsxClock,
    PsxWorker,
    WorkerErrorEventLike,
    WorkerMessageEventLike,
} from "./types.js";

interface PendingRequest {
    readonly command: WorkerRequestType;
    readonly resolve: (value: WorkerResponseResult) => void;
    readonly reject: (reason: unknown) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
}

type CommandBody = WorkerCommand extends infer Command
    ? Command extends WorkerCommand ? Omit<Command, "requestId" | "generation"> : never
    : never;

interface ClientEvents {
    readonly tick: void;
    readonly frame: PsxFrameEvent;
    readonly sound: PsxSoundEvent;
    readonly rumble: PsxRumbleEvent;
    readonly geometry: PsxGeometry;
    readonly exit: void;
    readonly failure: PsxRuntimeError;
}

const asWorkerError = (value: unknown, fallback: string): PsxRuntimeError => {
    if (PsxRuntimeError.is(value)) return value;
    if (typeof value === "object" && value !== null) {
        const candidate = value as { code?: unknown; message?: unknown; data?: unknown };
        if (typeof candidate.code === "number" && Number.isSafeInteger(candidate.code)
            && candidate.code >= 1 && candidate.code <= 20
            && typeof candidate.message === "string" && candidate.message.trim().length > 0) {
            return new PsxRuntimeError({
                code: candidate.code,
                message: candidate.message,
                data: candidate.data ?? null,
            });
        }
    }
    return new PsxRuntimeError({
        code: PsxRuntimeError.CODE.WORKER_FAILED,
        message: value instanceof Error && value.message.trim().length > 0 ? value.message : fallback,
        data: null,
    });
};

export default class WorkerClient {
    readonly #worker: PsxWorker;
    readonly #scheduler: FrameScheduler;
    readonly #clock: PsxClock;
    readonly #generation: number;
    readonly #pending = new Map<number, PendingRequest>();
    readonly #listeners: { [K in keyof ClientEvents]: Set<Listener<ClientEvents[K]>> } = {
        tick: new Set(),
        frame: new Set(),
        sound: new Set(),
        rumble: new Set(),
        geometry: new Set(),
        exit: new Set(),
        failure: new Set(),
    };
    readonly #messageListener = (event: WorkerMessageEventLike): void => this.#receive(event.data);
    readonly #errorListener = (event: WorkerErrorEventLike): void => {
        this.#fail(event.error ?? event.message);
    };
    #requestId = 0;
    #schedulerHandle: number | null = null;
    #terminated = false;
    #firstFrameSeen = false;
    #startupFrame: PsxFrameEvent | null = null;
    #resolveFirstFrame: (() => void) | null = null;
    #rejectFirstFrame: ((reason: unknown) => void) | null = null;
    readonly #firstFrame = new Promise<void>((resolve, reject) => {
        this.#resolveFirstFrame = resolve;
        this.#rejectFirstFrame = reject;
    });

    constructor(worker: PsxWorker, scheduler: FrameScheduler, clock: PsxClock, generation: number) {
        this.#worker = worker;
        this.#scheduler = scheduler;
        this.#clock = clock;
        this.#generation = generation;
        worker.addEventListener("message", this.#messageListener);
        worker.addEventListener("error", this.#errorListener);
    }

    get startupFrame(): PsxFrameEvent | null {
        if (this.#startupFrame === null) return null;
        return { ...this.#startupFrame, rgba: this.#startupFrame.rgba.slice() };
    }

    async start(payload: WorkerStartPayload): Promise<PsxMachineInfo> {
        const machine = await this.#request("start", { type: "start", payload });
        if (machine === null || machine instanceof Uint8Array || !("core" in machine)) {
            throw this.#fail(new Error("Worker returned invalid startup metadata."));
        }
        this.#schedule();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                this.#firstFrame,
                new Promise<never>((_resolve, reject) => {
                    timeout = setTimeout(() => reject(new PsxRuntimeError({
                        code: PsxRuntimeError.CODE.CORE_START_FAILED,
                        message: "The PlayStation core did not produce its first frame in time.",
                    })), 15_000);
                }),
            ]);
        } catch (error) {
            throw this.#fail(error);
        } finally {
            if (timeout !== undefined) clearTimeout(timeout);
        }
        return machine;
    }

    setButton(port: 1 | 2, button: PsxButton, pressed: boolean): void {
        this.#post({ type: "set-button", port, button, pressed });
    }

    setAxis(port: 1 | 2, axis: PsxAxis, value: number): void {
        this.#post({ type: "set-axis", port, axis, value });
    }

    pause(): void {
        void this.#request("pause", { type: "pause" }).catch((error) => this.#fail(error));
    }

    resume(): void {
        void this.#request("resume", { type: "resume" }).catch((error) => this.#fail(error));
    }

    async reset(): Promise<void> {
        await this.#request("reset", { type: "reset", kind: "soft" });
    }

    async setDisc(index: number): Promise<{ readonly discIndex: number; readonly trayOpen: boolean }> {
        const result = await this.#request("set-disc", { type: "set-disc", index });
        if (result === null || result instanceof Uint8Array || !("discIndex" in result)) {
            throw this.#fail(new Error("Worker returned invalid disc state."));
        }
        return result;
    }

    async readMemoryCard(slot: 1 | 2): Promise<Uint8Array> {
        const result = await this.#request("read-memory-card", { type: "read-memory-card", slot });
        if (!(result instanceof Uint8Array)) throw this.#fail(new Error("Worker returned invalid card bytes."));
        return result.slice();
    }

    async serializeState(): Promise<Uint8Array> {
        const result = await this.#request("serialize-state", { type: "serialize-state" });
        if (!(result instanceof Uint8Array)) throw this.#fail(new Error("Worker returned invalid state bytes."));
        return result.slice();
    }

    async unserializeState(bytes: Uint8Array): Promise<void> {
        await this.#request("unserialize-state", { type: "unserialize-state", bytes: bytes.slice() });
    }

    async exit(): Promise<void> {
        if (this.#terminated) return;
        try {
            await this.#request("exit", { type: "exit" });
        } finally {
            this.terminate();
        }
    }

    terminate(): void {
        if (this.#terminated) return;
        this.#terminated = true;
        if (this.#schedulerHandle !== null) this.#scheduler.cancel(this.#schedulerHandle);
        this.#schedulerHandle = null;
        this.#worker.removeEventListener("message", this.#messageListener);
        this.#worker.removeEventListener("error", this.#errorListener);
        this.#worker.terminate();
        const error = new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "The Worker client has terminated.",
        });
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.#pending.clear();
        if (!this.#firstFrameSeen) this.#rejectFirstFrame?.(error);
    }

    on<K extends keyof ClientEvents>(type: K, listener: Listener<ClientEvents[K]>): Unsubscribe {
        this.#listeners[type].add(listener);
        return () => this.#listeners[type].delete(listener);
    }

    #schedule(): void {
        if (this.#terminated || this.#schedulerHandle !== null) return;
        this.#schedulerHandle = this.#scheduler.request((timestamp) => {
            this.#schedulerHandle = null;
            if (this.#terminated) return;
            const time = Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : this.#clock();
            this.#post({ type: "tick", timestamp: time });
            this.#schedule();
        });
    }

    #request(
        command: WorkerRequestType,
        value: CommandBody,
    ): Promise<WorkerResponseResult> {
        if (this.#terminated) return Promise.reject(new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "The Worker client has terminated.",
        }));
        const requestId = ++this.#requestId;
        return new Promise<WorkerResponseResult>((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (!this.#pending.has(requestId)) return;
                this.#pending.delete(requestId);
                const error = new PsxRuntimeError({
                    code: PsxRuntimeError.CODE.WORKER_FAILED,
                    message: `The Worker did not answer the ${command} request in time.`,
                });
                reject(error);
                this.#fail(error);
            }, 15_000);
            this.#pending.set(requestId, { command, resolve, reject, timeout });
            try {
                this.#worker.postMessage({ ...value, requestId, generation: this.#generation });
            } catch (error) {
                clearTimeout(timeout);
                this.#pending.delete(requestId);
                reject(asWorkerError(error, "Worker message delivery failed."));
            }
        });
    }

    #post(value: CommandBody, transfer: Transferable[] = []): void {
        if (this.#terminated) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "The Worker client has terminated.",
        });
        this.#worker.postMessage({ ...value, requestId: ++this.#requestId, generation: this.#generation }, transfer);
    }

    #receive(value: unknown): void {
        if (this.#terminated) return;
        if (!isWorkerOutput(value)) {
            this.#fail(new PsxRuntimeError({
                code: PsxRuntimeError.CODE.INVALID_MESSAGE,
                message: "Worker output failed structural validation.",
            }));
            return;
        }
        const output = value;
        if (output.generation !== this.#generation) return;
        if (output.type === "response") {
            const pending = this.#pending.get(output.requestId);
            if (pending === undefined || pending.command !== output.command) {
                this.#fail(new Error("Worker response does not match a pending request."));
                return;
            }
            this.#pending.delete(output.requestId);
            clearTimeout(pending.timeout);
            if (output.ok) pending.resolve(output.result);
            else pending.reject(asWorkerError(output.error, "Worker request failed."));
            return;
        }
        this.#receiveEvent(output);
    }

    #receiveEvent(output: Exclude<WorkerOutput, { type: "response" }>): void {
        switch (output.type) {
            case "tick": this.#emit("tick", undefined); break;
            case "geometry": this.#emit("geometry", {
                width: output.width,
                height: output.height,
                aspectRatio: output.aspectRatio,
            }); break;
            case "frame": {
                const frame: PsxFrameEvent = {
                    width: output.width,
                    height: output.height,
                    aspectRatio: output.aspectRatio,
                    rgba: new Uint8ClampedArray(output.rgba),
                };
                if (!this.#firstFrameSeen) this.#startupFrame = { ...frame, rgba: frame.rgba.slice() };
                this.#firstFrameSeen = true;
                this.#resolveFirstFrame?.();
                this.#emit("frame", frame);
                this.#post({ type: "return-video-buffer", bufferId: output.bufferId, buffer: output.rgba }, [output.rgba]);
                break;
            }
            case "sound": this.#emit("sound", {
                samples: new Float32Array(output.samples),
                frames: output.frames,
            }); break;
            case "rumble": this.#emit("rumble", {
                port: output.port,
                strong: output.strong,
                weak: output.weak,
            }); break;
            case "error": this.#fail(output.error); break;
            case "exit": this.#emit("exit", undefined); break;
            case "dropped-time": break;
        }
    }

    #emit<K extends keyof ClientEvents>(type: K, event: ClientEvents[K]): void {
        for (const listener of [...this.#listeners[type]]) {
            try {
                listener(event);
            } catch {
                // Consumer listener failures do not corrupt the Worker lifecycle.
            }
        }
    }

    #fail(value: unknown): PsxRuntimeError {
        const error = asWorkerError(value, "The emulation Worker failed.");
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.#pending.clear();
        if (!this.#firstFrameSeen) this.#rejectFirstFrame?.(error);
        this.#emit("failure", error);
        this.terminate();
        return error;
    }
}
