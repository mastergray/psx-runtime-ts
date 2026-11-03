// Dependencies:
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Reports invalid arguments and exited-session use
import {
    isControllerPort,      // Validates memory-card slot requests
    isPsxAxisControl,      // Validates analog input coordinates
    isPsxButtonControl,    // Validates digital input coordinates
    isPsxPlaybackRate,     // Validates normal and fast-forward multipliers
} from "../shared.types.js";

// Type dependencies:
import type {
    ControllerPort,                    // Physical controller and memory-card slot
    Listener,                          // Observer accepted by session event streams
    PsxAxisControl,                    // Port and analog-axis coordinate
    PsxButtonControl,                  // Port and digital-button coordinate
    PsxFrameEvent,                     // RGBA video output from the worker
    PsxMachineInfo,                    // Active core, build, geometry, and content identity
    PsxPlaybackRate,                   // Normal or accelerated emulation-time multiplier
    PsxRumbleEvent,                    // Strong and weak motor output from the worker
    PsxSession as PsxSessionContract,  // Public session contract implemented by this class
    PsxSoundEvent,                     // Interleaved stereo output from the worker
    Unsubscribe,                       // Cleanup returned by worker and public subscriptions
} from "../shared.types.js";
import type WorkerClient from "./WorkerClient.js";    // Worker messaging and pacing owner wrapped by the session

/**
 *
 * Type Declarations
 *
 */

// TYPE :: {client:workerClient, machine:psxMachineInfo, discIndex:NUMBER}
// Fully started worker state used for initial startup and hard-reset replacement.
export interface SessionWorker {
    readonly client: WorkerClient;          // Live messaging client for the worker generation
    readonly machine: PsxMachineInfo;       // Validated machine identity reported by the core
    readonly discIndex: number;             // Active zero-based disc index after startup
}

// TYPE :: ARRAY<controllerPort, uint8Array> -> PROMISE(sessionWorker)
// Adapter closure that starts a replacement worker while preserving card contents.
export type RestartSession = (
    cards: Readonly<Record<ControllerPort, Uint8Array>>,
) => Promise<SessionWorker>;

/**
 *
 * Class
 *
 */

// Exposes a restartable, evented public session over one worker generation at a time.
export default class PsxSession implements PsxSessionContract {

    /* Instance Fields */
    private _machine: PsxMachineInfo;                                              // Current core and geometry identity
    private _client: WorkerClient;                                                 // Client for the current worker generation
    private readonly _restart: RestartSession;                                     // Adapter closure used for hard reset
    private readonly _tickListeners = new Set<Listener<void>>();                   // Public emulation-tick observers
    private readonly _frameListeners = new Set<Listener<PsxFrameEvent>>();         // Public video-frame observers
    private readonly _soundListeners = new Set<Listener<PsxSoundEvent>>();         // Public audio observers
    private readonly _rumbleListeners = new Set<Listener<PsxRumbleEvent>>();       // Public rumble observers
    private readonly _exitListeners = new Set<Listener<void>>();                   // Public terminal-exit observers
    private _clientUnsubscribes: Unsubscribe[] = [];                               // Current worker-client event cleanups
    private _operationTail: Promise<void> = Promise.resolve();                     // Tail that serializes asynchronous core operations
    private _exitPromise: Promise<void> | null = null;                             // Idempotent terminal cleanup result
    private _destroyed = false;                                                    // Whether the session has exited or failed
    private _paused = false;                                                       // Requested worker pacing state
    private _playbackRate: PsxPlaybackRate = 1;                                    // Requested normal or fast-forward multiplier
    private _discIndex = 0;                                                        // Active zero-based disc index
    private _trayOpen = false;                                                     // Core-reported virtual tray state
    private _exitEmitted = false;                                                  // Whether terminal observers were already notified
    private _finalCards: Readonly<Record<ControllerPort, Uint8Array>> | null = null; // Defensive card snapshots captured at exit
    private _startupFrame: PsxFrameEvent | null = null;                            // First frame retained until a display subscribes

    // CONSTRUCTOR :: sessionWorker, restartSession -> psxSession
    // Retains a started worker and attaches its event streams.
    constructor(worker: SessionWorker, restart: RestartSession) {
        this._machine = worker.machine;
        this._client = worker.client;
        this._discIndex = worker.discIndex;
        this._restart = restart;
        this._attachClient();
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> psxMachineInfo
    // Returns the current machine identity and geometry.
    get machine(): PsxMachineInfo {
        return this._machine;
    }

    // GETTER :: VOID -> NUMBER
    // Returns the active zero-based disc index.
    get discIndex(): number {
        return this._discIndex;
    }

    // GETTER :: VOID -> BOOLEAN
    // Returns the core-reported virtual tray state.
    get trayOpen(): boolean {
        return this._trayOpen;
    }

    // GETTER :: VOID -> psxPlaybackRate
    // Returns the requested normal or fast-forward multiplier.
    get playbackRate(): PsxPlaybackRate {
        return this._playbackRate;
    }

    // GETTER :: VOID -> ARRAY<controllerPort, uint8Array>?
    // Returns defensive final card snapshots after exit cleanup.
    get finalMemoryCards(): Readonly<Record<ControllerPort, Uint8Array>> | null {
        if (this._finalCards === null) return null;
        return { 1: this._finalCards[1].slice(), 2: this._finalCards[2].slice() };
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: psxButtonControl, BOOLEAN -> VOID
    // Validates and forwards one digital input transition.
    setButton(control: PsxButtonControl, pressed: boolean): void {
        this._assertLive();
        if (!isPsxButtonControl(control) || typeof pressed !== "boolean") throw invalid({ control, pressed });
        this._client.setButton(control.port, control.button, pressed);
    }

    // METHOD :: psxAxisControl, NUMBER -> VOID
    // Validates, clamps, and forwards one analog input value.
    setAxis(control: PsxAxisControl, value: number): void {
        this._assertLive();
        if (!isPsxAxisControl(control) || !Number.isFinite(value)) throw invalid({ control, value });
        this._client.setAxis(control.port, control.axis, Math.max(-1, Math.min(1, value)));
    }

    // METHOD :: psxPlaybackRate -> VOID
    // Selects the session's best-effort execution multiplier.
    setPlaybackRate(rate: PsxPlaybackRate): void {
        this._assertLive();
        if (!isPsxPlaybackRate(rate)) throw invalid(rate);
        if (rate === this._playbackRate) return;
        this._playbackRate = rate;
        this._client.setPlaybackRate(rate);
    }

    // METHOD :: VOID -> VOID
    // Pauses worker pacing idempotently.
    pause(): void {
        this._assertLive();
        if (this._paused) return;
        this._paused = true;
        this._client.pause();
    }

    // METHOD :: VOID -> VOID
    // Resumes worker pacing idempotently.
    resume(): void {
        this._assertLive();
        if (!this._paused) return;
        this._paused = false;
        this._client.resume();
    }

    // METHOD :: "soft"|"hard" -> PROMISE(VOID)
    // Resets the current core or replaces its worker while preserving cards.
    reset(kind: "soft" | "hard"): Promise<void> {
        this._assertLive();
        if (kind !== "soft" && kind !== "hard") return Promise.reject(invalid(kind));
        return this._queue(async () => {
            if (kind === "soft") {
                await this._client.reset();
                return;
            }
            const cards = await this._readBothCards();
            const previous = this._client;
            this._detachClient();
            await previous.exit();
            try {
                const replacement = await this._restart(cards);
                this._client = replacement.client;
                this._machine = replacement.machine;
                this._discIndex = replacement.discIndex;
                this._trayOpen = false;
                this._paused = false;
                replacement.client.setPlaybackRate(this._playbackRate);
                this._attachClient();
            } catch (error) {
                this._destroyed = true;
                this._emitExit();
                throw error;
            }
        });
    }

    // METHOD :: NUMBER -> PROMISE(VOID)
    // Changes the active disc and records core-reported tray state.
    setDisc(index: number): Promise<void> {
        this._assertLive();
        if (!Number.isSafeInteger(index) || index < 0 || index >= this._machine.discCount) {
            return Promise.reject(invalid(index));
        }
        return this._queue(async () => {
            const state = await this._client.setDisc(index);
            this._discIndex = state.discIndex;
            this._trayOpen = state.trayOpen;
        });
    }

    // METHOD :: controllerPort -> PROMISE(uint8Array)
    // Serially reads one defensive memory-card image from the worker.
    readMemoryCard(slot: ControllerPort): Promise<Uint8Array> {
        this._assertLive();
        if (!isControllerPort(slot)) return Promise.reject(invalid(slot));
        return this._queue(() => this._client.readMemoryCard(slot));
    }

    // METHOD :: VOID -> PROMISE(uint8Array)
    // Serially captures a core save-state payload.
    serializeState(): Promise<Uint8Array> {
        this._assertLive();
        return this._queue(() => this._client.serializeState());
    }

    // METHOD :: uint8Array -> PROMISE(VOID)
    // Serially restores a non-empty core save-state payload.
    unserializeState(bytes: Uint8Array): Promise<void> {
        this._assertLive();
        if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return Promise.reject(invalid(bytes));
        return this._queue(() => this._client.unserializeState(bytes));
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Captures final cards and idempotently terminates the session.
    exit(): Promise<void> {
        if (this._exitPromise !== null) return this._exitPromise;
        this._assertLive();
        this._exitPromise = this._queue(async () => {
            let caught: unknown;
            try {
                this._finalCards = await this._readBothCards();
            } catch (error) {
                caught = error;
            }
            this._detachClient();
            try {
                await this._client.exit();
            } catch (error) {
                caught ??= error;
                this._client.terminate();
            }
            this._destroyed = true;
            this._emitExit();
            if (caught !== undefined) throw caught;
        });
        return this._exitPromise;
    }

    // METHOD :: listener -> unsubscribe
    // Subscribes to completed worker ticks.
    onTick(listener: Listener<void>): Unsubscribe {
        return this._subscribe(this._tickListeners, listener);
    }

    // METHOD :: listener -> unsubscribe
    // Subscribes to frames and immediately replays a retained startup frame.
    onFrame(listener: Listener<PsxFrameEvent>): Unsubscribe {
        const unsubscribe = this._subscribe(this._frameListeners, listener);
        if (this._startupFrame !== null) listener(this._startupFrame);
        return unsubscribe;
    }

    // METHOD :: listener -> unsubscribe
    // Subscribes to session audio events.
    onSound(listener: Listener<PsxSoundEvent>): Unsubscribe {
        return this._subscribe(this._soundListeners, listener);
    }

    // METHOD :: listener -> unsubscribe
    // Subscribes to session rumble events.
    onRumble(listener: Listener<PsxRumbleEvent>): Unsubscribe {
        return this._subscribe(this._rumbleListeners, listener);
    }

    // METHOD :: listener -> unsubscribe
    // Subscribes to the single terminal exit notification.
    onExit(listener: Listener<void>): Unsubscribe {
        return this._subscribe(this._exitListeners, listener);
    }

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: VOID -> VOID
    // Bridges current client events into stable public session observers.
    private _attachClient(): void {
        this._startupFrame = this._client.startupFrame;
        this._clientUnsubscribes = [
            this._client.on("tick", () => this._emit(this._tickListeners, undefined)),
            this._client.on("frame", (frame) => {
                this._startupFrame = null;
                if (frame.width !== this._machine.geometry.width
                    || frame.height !== this._machine.geometry.height
                    || frame.aspectRatio !== this._machine.geometry.aspectRatio) {
                    this._machine = { ...this._machine, geometry: {
                        width: frame.width,
                        height: frame.height,
                        aspectRatio: frame.aspectRatio,
                    } };
                }
                this._emit(this._frameListeners, frame);
            }),
            this._client.on("geometry", (geometry) => {
                this._machine = { ...this._machine, geometry };
            }),
            this._client.on("sound", (sound) => this._emit(this._soundListeners, sound)),
            this._client.on("rumble", (rumble) => this._emit(this._rumbleListeners, rumble)),
            this._client.on("failure", () => {
                this._destroyed = true;
                this._emitExit();
            }),
            this._client.on("exit", () => {
                if (!this._destroyed) {
                    this._destroyed = true;
                    this._emitExit();
                }
            }),
        ];
        if (this._startupFrame !== null && this._frameListeners.size > 0) {
            this._emit(this._frameListeners, this._startupFrame);
            this._startupFrame = null;
        }
    }

    // METHOD :: VOID -> VOID
    // Removes every event bridge from the current client.
    private _detachClient(): void {
        this._clientUnsubscribes.splice(0).forEach((unsubscribe) => unsubscribe());
    }

    // METHOD :: VOID -> PROMISE(ARRAY<controllerPort, uint8Array>)
    // Reads both card slots in deterministic order.
    private async _readBothCards(): Promise<Readonly<Record<ControllerPort, Uint8Array>>> {
        const first = await this._client.readMemoryCard(1);
        const second = await this._client.readMemoryCard(2);
        return { 1: first, 2: second };
    }

    // METHOD :: (VOID -> PROMISE(T)) -> PROMISE(T)
    // Appends one asynchronous core operation to the serial session tail.
    private _queue<T>(operation: () => Promise<T>): Promise<T> {
        const next = this._operationTail.then(operation);
        this._operationTail = next.then(() => undefined, () => undefined);
        return next;
    }

    // METHOD :: VOID -> VOID
    // Rejects operations after terminal exit or failure.
    private _assertLive(): void {
        if (this._destroyed) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "The PlayStation session has exited.",
        });
    }

    // METHOD :: SET<listener<T>>, listener<T> -> unsubscribe
    // Validates and registers one public event observer.
    private _subscribe<T>(listeners: Set<Listener<T>>, listener: Listener<T>): Unsubscribe {
        this._assertLive();
        if (typeof listener !== "function") throw invalid(listener);
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    // METHOD :: SET<listener<T>>, T -> VOID
    // Notifies a stable observer snapshot without transferring lifecycle ownership.
    private _emit<T>(listeners: Set<Listener<T>>, event: T): void {
        for (const listener of [...listeners]) {
            try {
                listener(event);
            } catch {
                // Event consumers do not own the emulation lifecycle.
            }
        }
    }

    // METHOD :: VOID -> VOID
    // Emits terminal exit exactly once.
    private _emitExit(): void {
        if (this._exitEmitted) return;
        this._exitEmitted = true;
        this._emit(this._exitListeners, undefined);
    }
}

/**
 *
 *  Helper Functions
 *
 */

// HELPER :: UNKNOWN -> psxRuntimeError
// Creates one invalid public session method-argument error.
const invalid = (data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.INVALID_CONFIG,
    message: "The PlayStation session method received an invalid argument.",
    data,
});
