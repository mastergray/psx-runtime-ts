// Dependencies:
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Normalizes worker, timeout, protocol, and lifecycle failures
import { isWorkerOutput } from "./protocol.js";                        // Validates every message received from the worker

// Type dependencies:
import type {
    FrameScheduler,    // Animation-frame boundary used to issue worker ticks
    Listener,          // Observer accepted by client event streams
    PsxFrameEvent,     // Browser-ready RGBA frame emitted to sessions
    PsxGeometry,       // Dynamic core geometry update
    PsxAxis,           // Closed set of analog controls
    PsxButton,         // Closed set of digital controls
    PsxMachineInfo,    // Validated startup metadata returned by the worker
    PsxRumbleEvent,    // Browser-ready rumble output
    PsxSoundEvent,     // Browser-ready stereo audio output
    Unsubscribe,       // Cleanup returned by client subscriptions
} from "../shared.types.js";
import type {
    WorkerCommand,           // Validated command union accepted by the worker
    WorkerOutput,            // Validated response and event union emitted by the worker
    WorkerRequestType,       // Commands whose responses are correlated
    WorkerResponseResult,    // Union of successful response payloads
    WorkerStartPayload,      // Fully resolved core startup input
} from "./protocol.js";
import type {
    PsxClock,                 // Monotonic fallback clock for invalid scheduler timestamps
    PsxWorker,                // Minimal module-worker messaging boundary
    WorkerErrorEventLike,     // Error event received from the worker
    WorkerMessageEventLike,   // Message event received from the worker
} from "./types.js";

/**
 *
 * Type Declarations
 *
 */

// TYPE :: {command:workerRequestType, resolve:(workerResponseResult -> VOID), reject:(UNKNOWN -> VOID), timeout:timeout}
// Correlation state for one command awaiting a worker response.
interface PendingRequest {
    readonly command: WorkerRequestType;                         // Expected response command discriminant
    readonly resolve: (value: WorkerResponseResult) => void;     // Successful request settlement
    readonly reject: (reason: unknown) => void;                  // Failed request settlement
    readonly timeout: ReturnType<typeof setTimeout>;             // Deadline handle cleared on settlement
}

// TYPE :: workerCommand without correlation metadata
// Command payload accepted before request identity and generation are attached.
type CommandBody = WorkerCommand extends infer Command
    ? Command extends WorkerCommand ? Omit<Command, "requestId" | "generation"> : never
    : never;

// TYPE :: {tick:VOID, frame:psxFrameEvent, sound:psxSoundEvent, rumble:psxRumbleEvent, geometry:psxGeometry, exit:VOID, failure:psxRuntimeError}
// Event payload map exposed to a session wrapper.
interface ClientEvents {
    readonly tick: void;                    // One completed emulation tick
    readonly frame: PsxFrameEvent;          // One browser-ready video frame
    readonly sound: PsxSoundEvent;          // One browser-ready audio chunk
    readonly rumble: PsxRumbleEvent;        // One controller motor update
    readonly geometry: PsxGeometry;         // One dynamic video-geometry update
    readonly exit: void;                    // Intentional worker shutdown
    readonly failure: PsxRuntimeError;      // Terminal normalized worker failure
}

// METHOD :: UNKNOWN, STRING -> psxRuntimeError
// Preserves structured runtime errors and normalizes arbitrary worker failures.
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

/**
 *
 * Class
 *
 */

// Correlates worker requests, paces ticks, converts transfer events, and owns termination.
export default class WorkerClient {

    /* Instance Fields */
    private readonly _worker: PsxWorker;                                  // Module worker owned by this client
    private readonly _scheduler: FrameScheduler;                          // Animation-frame pacing boundary
    private readonly _clock: PsxClock;                                    // Monotonic fallback clock
    private readonly _generation: number;                                 // Worker generation expected on all outputs
    private readonly _pending = new Map<number, PendingRequest>();        // Requests awaiting correlated responses
    private readonly _listeners: { [K in keyof ClientEvents]: Set<Listener<ClientEvents[K]>> } = {
        tick: new Set(),
        frame: new Set(),
        sound: new Set(),
        rumble: new Set(),
        geometry: new Set(),
        exit: new Set(),
        failure: new Set(),
    };                                                                     // Client observers partitioned by event type
    private readonly _messageListener = (event: WorkerMessageEventLike): void => this._receive(event.data); // Stable worker-message callback
    private readonly _errorListener = (event: WorkerErrorEventLike): void => { // Stable worker-error callback
        this._fail(event.error ?? event.message);
    };
    private _requestId = 0;                                                // Monotonic command correlation identity
    private _schedulerHandle: number | null = null;                        // Outstanding animation-frame callback
    private _terminated = false;                                           // Whether worker ownership has ended
    private _firstFrameSeen = false;                                       // Whether startup presentation has completed
    private _startupFrame: PsxFrameEvent | null = null;                    // Defensive first frame retained for late display attachment
    private _resolveFirstFrame: (() => void) | null = null;                // Startup-frame barrier success settlement
    private _rejectFirstFrame: ((reason: unknown) => void) | null = null;  // Startup-frame barrier failure settlement
    private readonly _firstFrame = new Promise<void>((resolve, reject) => {
        this._resolveFirstFrame = resolve;
        this._rejectFirstFrame = reject;
    });                                                                     // Barrier that requires visible output before start resolves

    // CONSTRUCTOR :: psxWorker, frameScheduler, psxClock, NUMBER -> workerClient
    // Attaches worker listeners and initializes request and pacing state.
    constructor(worker: PsxWorker, scheduler: FrameScheduler, clock: PsxClock, generation: number) {
        this._worker = worker;
        this._scheduler = scheduler;
        this._clock = clock;
        this._generation = generation;
        worker.addEventListener("message", this._messageListener);
        worker.addEventListener("error", this._errorListener);
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> psxFrameEvent?
    // Returns a defensive copy of the first frame retained during startup.
    get startupFrame(): PsxFrameEvent | null {
        if (this._startupFrame === null) return null;
        return { ...this._startupFrame, rgba: this._startupFrame.rgba.slice() };
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: workerStartPayload -> PROMISE(psxMachineInfo)
    // Starts the worker and requires a first frame before reporting success.
    async start(payload: WorkerStartPayload): Promise<PsxMachineInfo> {
        const machine = await this._request("start", { type: "start", payload });
        if (machine === null || machine instanceof Uint8Array || !("core" in machine)) {
            throw this._fail(new Error("Worker returned invalid startup metadata."));
        }
        this._schedule();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                this._firstFrame,
                new Promise<never>((_resolve, reject) => {
                    timeout = setTimeout(() => reject(new PsxRuntimeError({
                        code: PsxRuntimeError.CODE.CORE_START_FAILED,
                        message: "The PlayStation core did not produce its first frame in time.",
                    })), 15_000);
                }),
            ]);
        } catch (error) {
            throw this._fail(error);
        } finally {
            if (timeout !== undefined) clearTimeout(timeout);
        }
        return machine;
    }

    // METHOD :: 1|2, psxButton, BOOLEAN -> VOID
    // Posts one uncorrelated digital input transition.
    setButton(port: 1 | 2, button: PsxButton, pressed: boolean): void {
        this._post({ type: "set-button", port, button, pressed });
    }

    // METHOD :: 1|2, psxAxis, NUMBER -> VOID
    // Posts one uncorrelated analog input value.
    setAxis(port: 1 | 2, axis: PsxAxis, value: number): void {
        this._post({ type: "set-axis", port, axis, value });
    }

    // METHOD :: VOID -> VOID
    // Requests worker pacing pause and routes asynchronous failure to the client.
    pause(): void {
        void this._request("pause", { type: "pause" }).catch((error) => this._fail(error));
    }

    // METHOD :: VOID -> VOID
    // Requests worker pacing resume and routes asynchronous failure to the client.
    resume(): void {
        void this._request("resume", { type: "resume" }).catch((error) => this._fail(error));
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Requests a correlated soft reset.
    async reset(): Promise<void> {
        await this._request("reset", { type: "reset", kind: "soft" });
    }

    // METHOD :: NUMBER -> PROMISE({discIndex:NUMBER, trayOpen:BOOLEAN})
    // Requests a disc change and validates returned drive state.
    async setDisc(index: number): Promise<{ readonly discIndex: number; readonly trayOpen: boolean }> {
        const result = await this._request("set-disc", { type: "set-disc", index });
        if (result === null || result instanceof Uint8Array || !("discIndex" in result)) {
            throw this._fail(new Error("Worker returned invalid disc state."));
        }
        return result;
    }

    // METHOD :: 1|2 -> PROMISE(uint8Array)
    // Reads and defensively copies one memory-card image.
    async readMemoryCard(slot: 1 | 2): Promise<Uint8Array> {
        const result = await this._request("read-memory-card", { type: "read-memory-card", slot });
        if (!(result instanceof Uint8Array)) throw this._fail(new Error("Worker returned invalid card bytes."));
        return result.slice();
    }

    // METHOD :: VOID -> PROMISE(uint8Array)
    // Captures and defensively copies a core save-state payload.
    async serializeState(): Promise<Uint8Array> {
        const result = await this._request("serialize-state", { type: "serialize-state" });
        if (!(result instanceof Uint8Array)) throw this._fail(new Error("Worker returned invalid state bytes."));
        return result.slice();
    }

    // METHOD :: uint8Array -> PROMISE(VOID)
    // Sends a defensive save-state payload for restoration.
    async unserializeState(bytes: Uint8Array): Promise<void> {
        await this._request("unserialize-state", { type: "unserialize-state", bytes: bytes.slice() });
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Requests graceful worker exit and always terminates local ownership.
    async exit(): Promise<void> {
        if (this._terminated) return;
        try {
            await this._request("exit", { type: "exit" });
        } finally {
            this.terminate();
        }
    }

    // METHOD :: VOID -> VOID
    // Cancels pacing, detaches listeners, rejects requests, and ends worker ownership.
    terminate(): void {
        if (this._terminated) return;
        this._terminated = true;
        if (this._schedulerHandle !== null) this._scheduler.cancel(this._schedulerHandle);
        this._schedulerHandle = null;
        this._worker.removeEventListener("message", this._messageListener);
        this._worker.removeEventListener("error", this._errorListener);
        this._worker.terminate();
        const error = new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "The Worker client has terminated.",
        });
        for (const pending of this._pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this._pending.clear();
        if (!this._firstFrameSeen) this._rejectFirstFrame?.(error);
    }

    // METHOD :: K, listener<clientEvent<K>> -> unsubscribe
    // Subscribes to one normalized client event type.
    on<K extends keyof ClientEvents>(type: K, listener: Listener<ClientEvents[K]>): Unsubscribe {
        this._listeners[type].add(listener);
        return () => this._listeners[type].delete(listener);
    }

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: VOID -> VOID
    // Maintains a single animation-frame loop that posts timestamped ticks.
    private _schedule(): void {
        if (this._terminated || this._schedulerHandle !== null) return;
        this._schedulerHandle = this._scheduler.request((timestamp) => {
            this._schedulerHandle = null;
            if (this._terminated) return;
            const time = Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : this._clock();
            this._post({ type: "tick", timestamp: time });
            this._schedule();
        });
    }

    // METHOD :: workerRequestType, commandBody -> PROMISE(workerResponseResult)
    // Posts one correlated command with a terminal response deadline.
    private _request(
        command: WorkerRequestType,
        value: CommandBody,
    ): Promise<WorkerResponseResult> {
        if (this._terminated) return Promise.reject(new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "The Worker client has terminated.",
        }));
        const requestId = ++this._requestId;
        return new Promise<WorkerResponseResult>((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (!this._pending.has(requestId)) return;
                this._pending.delete(requestId);
                const error = new PsxRuntimeError({
                    code: PsxRuntimeError.CODE.WORKER_FAILED,
                    message: `The Worker did not answer the ${command} request in time.`,
                });
                reject(error);
                this._fail(error);
            }, 15_000);
            this._pending.set(requestId, { command, resolve, reject, timeout });
            try {
                this._worker.postMessage({ ...value, requestId, generation: this._generation });
            } catch (error) {
                clearTimeout(timeout);
                this._pending.delete(requestId);
                reject(asWorkerError(error, "Worker message delivery failed."));
            }
        });
    }

    // METHOD :: commandBody, [transferable]? -> VOID
    // Posts one uncorrelated command for the active generation.
    private _post(value: CommandBody, transfer: Transferable[] = []): void {
        if (this._terminated) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "The Worker client has terminated.",
        });
        this._worker.postMessage({ ...value, requestId: ++this._requestId, generation: this._generation }, transfer);
    }

    // METHOD :: UNKNOWN -> VOID
    // Validates, generation-filters, and routes one worker output.
    private _receive(value: unknown): void {
        if (this._terminated) return;
        if (!isWorkerOutput(value)) {
            this._fail(new PsxRuntimeError({
                code: PsxRuntimeError.CODE.INVALID_MESSAGE,
                message: "Worker output failed structural validation.",
            }));
            return;
        }
        const output = value;
        if (output.generation !== this._generation) return;
        if (output.type === "response") {
            const pending = this._pending.get(output.requestId);
            if (pending === undefined || pending.command !== output.command) {
                this._fail(new Error("Worker response does not match a pending request."));
                return;
            }
            this._pending.delete(output.requestId);
            clearTimeout(pending.timeout);
            if (output.ok) pending.resolve(output.result);
            else pending.reject(asWorkerError(output.error, "Worker request failed."));
            return;
        }
        this._receiveEvent(output);
    }

    // METHOD :: workerEventOutput -> VOID
    // Converts and emits one validated worker event, returning video buffers after use.
    private _receiveEvent(output: Exclude<WorkerOutput, { type: "response" }>): void {
        switch (output.type) {
            case "tick": this._emit("tick", undefined); break;
            case "geometry": this._emit("geometry", {
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
                if (!this._firstFrameSeen) this._startupFrame = { ...frame, rgba: frame.rgba.slice() };
                this._firstFrameSeen = true;
                this._resolveFirstFrame?.();
                this._emit("frame", frame);
                this._post({ type: "return-video-buffer", bufferId: output.bufferId, buffer: output.rgba }, [output.rgba]);
                break;
            }
            case "sound": this._emit("sound", {
                samples: new Float32Array(output.samples),
                frames: output.frames,
            }); break;
            case "rumble": this._emit("rumble", {
                port: output.port,
                strong: output.strong,
                weak: output.weak,
            }); break;
            case "error": this._fail(output.error); break;
            case "exit": this._emit("exit", undefined); break;
            case "dropped-time": break;
        }
    }

    // METHOD :: K, clientEvent<K> -> VOID
    // Notifies a stable observer snapshot without transferring lifecycle ownership.
    private _emit<K extends keyof ClientEvents>(type: K, event: ClientEvents[K]): void {
        for (const listener of [...this._listeners[type]]) {
            try {
                listener(event);
            } catch {
                // Consumer listener failures do not corrupt the Worker lifecycle.
            }
        }
    }

    // METHOD :: UNKNOWN -> psxRuntimeError
    // Normalizes one terminal failure, rejects requests, emits it, and terminates.
    private _fail(value: unknown): PsxRuntimeError {
        const error = asWorkerError(value, "The emulation Worker failed.");
        for (const pending of this._pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this._pending.clear();
        if (!this._firstFrameSeen) this._rejectFirstFrame?.(error);
        this._emit("failure", error);
        this.terminate();
        return error;
    }
}
