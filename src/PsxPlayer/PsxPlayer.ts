// Dependencies:
import PsxInput from "../PsxInput/PsxInput.js";                          // Coordinates input sources for each active session
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Reports lifecycle, validation, and optional-feature failures
import PsxCardAutoSave from "../PsxStorage/PsxCardAutoSave.js";        // Periodically persists active session memory cards
import {
    isControllerPort,     // Validates memory-card slot requests
    isPsxStartConfig,     // Validates complete session startup input
} from "../shared.types.js";
import {
    isPsxPlayerAudioLike,    // Validates audio objects returned by the injected factory
    isPsxPlayerConfig,       // Validates player construction dependencies
} from "./types.js";

// Type dependencies:
import type {
    ControllerPort,    // Physical memory-card and controller slot
    Listener,          // Observer accepted by player event streams
    PsxSession,        // Active emulation session owned by the player
    PsxStartConfig,    // Firmware, content, controller, and card startup input
    Unsubscribe,       // Cleanup returned by player and session subscriptions
} from "../shared.types.js";
import type {
    PsxMemoryCardRecord,    // Persisted card revision loaded or replaced by the player
    PsxStateRecord,         // Persisted save-state record returned to callers
} from "../PsxStorage/types.js";
import type {
    PsxPlayerAudioLike,    // Audio lifecycle surface composed with a session
    PsxPlayerConfig,       // Adapter, presentation, storage, and scheduler dependencies
    PsxPlayerEventMap,     // Status and error events emitted by the player
    PsxPlayerStatus,       // Closed lifecycle state set
} from "./types.js";

// METHOD :: UNKNOWN -> psxRuntimeError
// Creates one invalid player configuration or method-argument error.
const invalid = (data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.INVALID_CONFIG,
    message: "PsxPlayer config or method argument is invalid.",
    data,
});

// METHOD :: STRING -> psxRuntimeError
// Creates one unavailable optional-feature error.
const unsupported = (message: string): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.UNSUPPORTED,
    message,
});

/**
 *
 * Class
 *
 */

// Owns one emulation session graph across startup, runtime controls, persistence, and teardown.
export default class PsxPlayer {

    /* Instance Fields */
    private readonly _adapter: PsxPlayerConfig["adapter"];                            // Backend factory that starts emulation sessions
    private readonly _display: PsxPlayerConfig["display"];                            // Presentation lifecycle composed with each session
    private readonly _createAudio: PsxPlayerConfig["createAudio"];                    // Audio factory invoked after successful display startup
    private readonly _storage: NonNullable<PsxPlayerConfig["storage"]> | null;         // Optional firmware-independent cards and states store
    private readonly _profileId: string | null;                                        // Normalized persistence namespace
    private readonly _cardIds: NonNullable<PsxPlayerConfig["memoryCardIds"]> | null;   // Persistent card identities by physical slot
    private readonly _intervalScheduler: NonNullable<PsxPlayerConfig["intervalScheduler"]> | null; // Timer boundary used by card autosave
    private readonly _autoSaveIntervalMs: number;                                      // Period between dirty-card checks
    private readonly _listeners: { [K in keyof PsxPlayerEventMap]: Set<Listener<PsxPlayerEventMap[K]>> } = {
        status: new Set(),
        error: new Set(),
    };                                                                                  // Player observers partitioned by event type
    private _status: PsxPlayerStatus = "idle";                                          // Current lifecycle state
    private _session: PsxSession | null = null;                                         // Active backend session when started
    private _input: PsxInput | null = null;                                             // Input coordinator bound to the active session
    private _audio: PsxPlayerAudioLike | null = null;                                   // Audio output bound to the active session
    private _autoSave: PsxCardAutoSave | null = null;                                   // Card persistence monitor bound to the active session
    private _unsubscribeExit: Unsubscribe | null = null;                                // Unexpected session-exit listener cleanup
    private _operationInFlight = false;                                                 // Reentrancy guard for serialized async mutations

    // CONSTRUCTOR :: psxPlayerConfig -> psxPlayer
    // Validates dependencies and normalizes optional persistence settings.
    constructor(config: PsxPlayerConfig) {
        if (!isPsxPlayerConfig(config)) throw invalid(config);
        this._adapter = config.adapter;
        this._display = config.display;
        this._createAudio = config.createAudio;
        this._storage = config.storage ?? null;
        this._profileId = config.profileId?.trim().normalize("NFC") ?? null;
        this._cardIds = config.memoryCardIds ?? null;
        this._intervalScheduler = config.intervalScheduler ?? null;
        this._autoSaveIntervalMs = config.autoSaveIntervalMs ?? PsxCardAutoSave.DEFAULT_INTERVAL_MS;
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> psxPlayerStatus
    // Returns the current lifecycle state.
    get status(): PsxPlayerStatus { return this._status; }

    // GETTER :: VOID -> psxSession?
    // Returns the active session when the player is started.
    get session(): PsxSession | null { return this._session; }

    // GETTER :: VOID -> psxInput?
    // Returns the input coordinator for the active session.
    get input(): PsxInput | null { return this._input; }

    // GETTER :: VOID -> psxPlayerAudioLike?
    // Returns the audio output for the active session.
    get audio(): PsxPlayerAudioLike | null { return this._audio; }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: K, listener<event<K>> -> unsubscribe
    // Subscribes to one player event type.
    on<K extends keyof PsxPlayerEventMap>(
        type: K,
        listener: Listener<PsxPlayerEventMap[K]>,
    ): Unsubscribe {
        this._assertNotDestroyed();
        if (typeof listener !== "function") throw invalid(listener);
        this._listeners[type].add(listener);
        return () => this._listeners[type].delete(listener);
    }

    // METHOD :: psxStartConfig -> PROMISE(VOID)
    // Starts and composes a session, display, input, audio, and optional card autosave.
    async start(config: PsxStartConfig): Promise<void> {
        this._assertNotDestroyed();
        if (this._status !== "idle") throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.ALREADY_STARTED,
            message: "PsxPlayer is not idle.",
        });
        if (!isPsxStartConfig(config)) throw invalid(config);
        this._setStatus("starting");
        let session: PsxSession | null = null;
        let input: PsxInput | null = null;
        let audio: PsxPlayerAudioLike | null = null;
        let autoSave: PsxCardAutoSave | null = null;
        try {
            const cardRecords = await this._loadCards();
            const memoryCards = {
                ...(config.memoryCards ?? {}),
                ...(cardRecords[1] === null ? {} : { 1: cardRecords[1].bytes }),
                ...(cardRecords[2] === null ? {} : { 2: cardRecords[2].bytes }),
            };
            session = await this._adapter.start({
                ...config,
                ...(Object.keys(memoryCards).length === 0 ? {} : { memoryCards }),
            });
            this._session = session;
            this._unsubscribeExit = session.onExit(() => this._unexpectedExit());
            input = new PsxInput({ session });
            this._input = input;
            this._display.attach(session);
            if (!this._display.hasFrame) throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.CORE_START_FAILED,
                message: "The startup frame was not available to the display.",
            });
            const createdAudio = this._createAudio(session);
            if (!isPsxPlayerAudioLike(createdAudio)) throw invalid(createdAudio);
            audio = createdAudio;
            this._audio = audio;
            if (this._storage !== null && this._profileId !== null && this._cardIds !== null
                && this._intervalScheduler !== null) {
                const storage = this._storage;
                const profileId = this._profileId;
                const cardIds = this._cardIds;
                const scheduler = this._intervalScheduler;
                autoSave = new PsxCardAutoSave({
                    storage,
                    session,
                    profileId,
                    cards: {
                        1: {
                            cardId: cardIds[1],
                            revision: cardRecords[1]?.revision ?? null,
                            ...(cardRecords[1] === null ? {} : { bytes: cardRecords[1].bytes }),
                        },
                        2: {
                            cardId: cardIds[2],
                            revision: cardRecords[2]?.revision ?? null,
                            ...(cardRecords[2] === null ? {} : { bytes: cardRecords[2].bytes }),
                        },
                    },
                    scheduler,
                    intervalMs: this._autoSaveIntervalMs,
                    onError: (error) => this._emit("error", error),
                });
                autoSave.start();
                this._autoSave = autoSave;
            }
            this._setStatus("running");
        } catch (error) {
            autoSave?.destroy();
            audio?.destroy();
            this._display.detach();
            input?.destroy();
            this._unsubscribeExit?.();
            this._unsubscribeExit = null;
            if (session !== null) {
                try { await session.exit(); } catch { /* preserve startup failure */ }
            }
            this._clearSessionGraph();
            this._setStatus("idle");
            this._emit("error", error);
            throw error;
        }
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Pauses emulation after releasing input, resetting audio, and flushing cards.
    async pause(): Promise<void> {
        await this._exclusive(async () => {
            const session = this._requireStatus("running");
            this._input?.releaseAll();
            this._audio?.resetQueue();
            session.pause();
            this._setStatus("paused");
            await this._flushCards();
        });
    }

    // METHOD :: VOID -> VOID
    // Resumes a paused session when no async mutation is in flight.
    resume(): void {
        if (this._operationInFlight) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.INTERNAL_ERROR,
            message: "PsxPlayer has another operation in progress.",
        });
        const session = this._requireStatus("paused");
        session.resume();
        this._setStatus("running");
    }

    // METHOD :: "soft"|"hard" -> PROMISE(VOID)
    // Resets the active session after flushing transient and persistent state.
    async reset(kind: "soft" | "hard"): Promise<void> {
        await this._exclusive(async () => {
            const session = this._requireActive();
            if (kind !== "soft" && kind !== "hard") throw invalid(kind);
            this._input?.releaseAll();
            this._audio?.resetQueue();
            await this._flushCards();
            await session.reset(kind);
        });
    }

    // METHOD :: NUMBER -> PROMISE(VOID)
    // Changes the active disc after releasing transient input and audio state.
    async setDisc(index: number): Promise<void> {
        await this._exclusive(async () => {
            const session = this._requireActive();
            this._input?.releaseAll();
            this._audio?.resetQueue();
            await session.setDisc(index);
        });
    }

    // METHOD :: STRING -> PROMISE(psxStateRecord)
    // Serializes and persists a named state for the active session.
    async saveState(name: string): Promise<PsxStateRecord> {
        return this._exclusive(async () => {
            const session = this._requireActive();
            const storage = this._requireStorage();
            await this._flushCards();
            const payload = await session.serializeState();
            return storage.saveState({
                profileId: this._profileId!,
                name,
                machine: session.machine,
                discIndex: session.discIndex,
                payload,
            });
        });
    }

    // METHOD :: STRING -> PROMISE(VOID)
    // Loads a compatible named state while preserving prior run or pause status.
    async loadState(name: string): Promise<void> {
        await this._exclusive(async () => {
            const session = this._requireActive();
            const storage = this._requireStorage();
            const state = await storage.loadState({ profileId: this._profileId!, name, machine: session.machine });
            if (state === null) throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.STATE_FAILED,
                message: "The named save state does not exist.",
            });
            const resume = this._status === "running";
            if (resume) session.pause();
            this._input?.releaseAll();
            this._audio?.resetQueue();
            try {
                if (session.discIndex !== state.metadata.discIndex) await session.setDisc(state.metadata.discIndex);
                await session.unserializeState(state.payload);
                await this._flushCards();
            } finally {
                if (resume) session.resume();
            }
        });
    }

    // METHOD :: STRING -> PROMISE(VOID)
    // Deletes one named state for the active game and profile.
    async deleteState(name: string): Promise<void> {
        await this._exclusive(async () => {
            const session = this._requireActive();
            const storage = this._requireStorage();
            await storage.deleteState(this._profileId!, session.machine.gameId, name);
        });
    }

    // METHOD :: controllerPort -> PROMISE(uint8Array)
    // Reads a defensive memory-card image from the active session.
    downloadMemoryCard(slot: ControllerPort): Promise<Uint8Array> {
        if (!isControllerPort(slot)) return Promise.reject(invalid(slot));
        return this._requireActive().readMemoryCard(slot);
    }

    // METHOD :: controllerPort, uint8Array -> PROMISE(psxMemoryCardRecord)
    // Replaces one persisted card while the player is idle.
    async replaceMemoryCard(slot: ControllerPort, bytes: Uint8Array): Promise<PsxMemoryCardRecord> {
        this._assertNotDestroyed();
        if (this._status !== "idle") throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.ALREADY_STARTED,
            message: "Memory cards can only be replaced while the player is idle.",
        });
        if (!isControllerPort(slot) || !(bytes instanceof Uint8Array)
            || bytes.byteLength !== 128 * 1024) throw invalid({ slot, bytes });
        const storage = this._requireStorage();
        const cardId = this._cardIds![slot];
        const current = await storage.loadMemoryCard(this._profileId!, cardId);
        return storage.saveMemoryCard({
            profileId: this._profileId!,
            cardId,
            expectedRevision: current?.revision ?? null,
            bytes,
        });
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Flushes persistence and tears down the active session graph.
    async stop(): Promise<void> {
        this._assertNotDestroyed();
        if (this._operationInFlight) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.INTERNAL_ERROR,
            message: "PsxPlayer has another operation in progress.",
        });
        if (this._status !== "running" && this._status !== "paused" && this._status !== "failed") {
            if (this._status === "idle") return;
            throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.INTERNAL_ERROR,
                message: "PsxPlayer cannot stop during another lifecycle transition.",
            });
        }
        const wasRunning = this._status === "running";
        this._setStatus("stopping");
        let failure: unknown;
        if (wasRunning && this._session !== null) {
            this._input?.releaseAll();
            this._audio?.resetQueue();
            try { this._session.pause(); } catch (error) { failure = error; }
        }
        try { await this._autoSave?.stop(true); } catch (error) { failure ??= error; }
        this._autoSave?.destroy();
        this._autoSave = null;
        this._input?.destroy();
        this._input = null;
        this._audio?.destroy();
        this._audio = null;
        this._display.detach();
        this._unsubscribeExit?.();
        this._unsubscribeExit = null;
        const session = this._session;
        if (session !== null) {
            try { await session.exit(); } catch (error) { failure ??= error; }
        }
        this._session = null;
        if (failure !== undefined) {
            this._setStatus("failed");
            this._emit("error", failure);
            throw failure;
        }
        this._setStatus("idle");
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Performs terminal cleanup and destroys display ownership and observers.
    async destroy(): Promise<void> {
        if (this._status === "destroyed") return;
        if (this._operationInFlight) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.INTERNAL_ERROR,
            message: "PsxPlayer has another operation in progress.",
        });
        if (this._status !== "idle") {
            try { await this.stop(); } catch { /* terminal cleanup continues */ }
        }
        this._autoSave?.destroy();
        this._input?.destroy();
        this._audio?.destroy();
        this._display.detach();
        this._display.destroy();
        this._unsubscribeExit?.();
        this._clearSessionGraph();
        this._setStatus("destroyed");
        this._listeners.status.clear();
        this._listeners.error.clear();
    }

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: VOID -> PROMISE(ARRAY<controllerPort, psxMemoryCardRecord?>)
    // Loads both configured persistent card revisions before session startup.
    private async _loadCards(): Promise<Record<ControllerPort, PsxMemoryCardRecord | null>> {
        if (this._storage === null || this._profileId === null || this._cardIds === null) {
            return { 1: null, 2: null };
        }
        const storage = this._storage;
        const profileId = this._profileId;
        const cardIds = this._cardIds;
        const [first, second] = await Promise.all([
            storage.loadMemoryCard(profileId, cardIds[1]),
            storage.loadMemoryCard(profileId, cardIds[2]),
        ]);
        return { 1: first, 2: second };
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Flushes dirty cards when autosave is configured.
    private async _flushCards(): Promise<void> {
        await this._autoSave?.flush();
    }

    // METHOD :: (VOID -> PROMISE(T)) -> PROMISE(T)
    // Runs one async mutation under a non-reentrant operation guard.
    private async _exclusive<T>(operation: () => Promise<T>): Promise<T> {
        if (this._operationInFlight) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.INTERNAL_ERROR,
            message: "PsxPlayer has another operation in progress.",
        });
        this._operationInFlight = true;
        try {
            return await operation();
        } finally {
            this._operationInFlight = false;
        }
    }

    // METHOD :: VOID -> psxStorageLike
    // Returns configured persistence or reports an unsupported operation.
    private _requireStorage(): NonNullable<PsxPlayerConfig["storage"]> {
        if (this._storage === null || this._profileId === null || this._cardIds === null) {
            throw unsupported("Persistent storage is not configured.");
        }
        return this._storage;
    }

    // METHOD :: VOID -> psxSession
    // Returns the active session or reports a lifecycle error.
    private _requireActive(): PsxSession {
        this._assertNotDestroyed();
        if ((this._status !== "running" && this._status !== "paused") || this._session === null) {
            throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.NOT_STARTED,
                message: "PsxPlayer has no active session.",
            });
        }
        return this._session;
    }

    // METHOD :: "running"|"paused" -> psxSession
    // Returns the active session only in the required run state.
    private _requireStatus(status: "running" | "paused"): PsxSession {
        const session = this._requireActive();
        if (this._status !== status) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.INTERNAL_ERROR,
            message: `PsxPlayer must be ${status} for this operation.`,
        });
        return session;
    }

    // METHOD :: VOID -> VOID
    // Transitions to failed when the backend exits outside intentional teardown.
    private _unexpectedExit(): void {
        if (this._status === "stopping" || this._status === "idle" || this._status === "destroyed") return;
        this._setStatus("failed");
        this._emit("error", new PsxRuntimeError({
            code: PsxRuntimeError.CODE.WORKER_FAILED,
            message: "The emulation session exited unexpectedly.",
        }));
    }

    // METHOD :: VOID -> VOID
    // Clears all active-session object references after cleanup.
    private _clearSessionGraph(): void {
        this._session = null;
        this._input = null;
        this._audio = null;
        this._autoSave = null;
    }

    // METHOD :: psxPlayerStatus -> VOID
    // Changes lifecycle state and emits a status event exactly once.
    private _setStatus(status: PsxPlayerStatus): void {
        if (this._status === status) return;
        this._status = status;
        this._emit("status", status);
    }

    // METHOD :: K, event<K> -> VOID
    // Notifies a stable snapshot of observers without transferring lifecycle ownership.
    private _emit<K extends keyof PsxPlayerEventMap>(type: K, event: PsxPlayerEventMap[K]): void {
        for (const listener of [...this._listeners[type]]) {
            try { listener(event); } catch { /* observers do not own the lifecycle */ }
        }
    }

    // METHOD :: VOID -> VOID
    // Rejects operations after terminal destruction.
    private _assertNotDestroyed(): void {
        if (this._status === "destroyed") throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "PsxPlayer has been destroyed.",
        });
    }

    /**
     *
     * Static Methods
     *
     */

    // Static Factory Method :: psxPlayerConfig -> psxPlayer
    // Supplies browser interval scheduling when storage is configured.
    static init(config: Omit<PsxPlayerConfig, "intervalScheduler"> & {
        readonly intervalScheduler?: PsxPlayerConfig["intervalScheduler"];
    }): PsxPlayer {
        return new PsxPlayer({
            ...config,
            ...(config.storage === undefined ? {} : {
                intervalScheduler: config.intervalScheduler ?? {
                    setInterval: globalThis.setInterval.bind(globalThis),
                    clearInterval: globalThis.clearInterval.bind(globalThis),
                },
            }),
        });
    }
}
