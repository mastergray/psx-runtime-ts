import PsxInput from "../PsxInput/PsxInput.js";
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";
import PsxCardAutoSave from "../PsxStorage/PsxCardAutoSave.js";
import {
    isControllerPort,
    isPsxStartConfig,
} from "../shared.types.js";
import {
    isPsxPlayerAudioLike,
    isPsxPlayerConfig,
} from "./types.js";

import type {
    ControllerPort,
    Listener,
    PsxSession,
    PsxStartConfig,
    Unsubscribe,
} from "../shared.types.js";
import type { PsxMemoryCardRecord, PsxStateRecord } from "../PsxStorage/types.js";
import type {
    PsxPlayerAudioLike,
    PsxPlayerConfig,
    PsxPlayerEventMap,
    PsxPlayerStatus,
} from "./types.js";

const invalid = (data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.INVALID_CONFIG,
    message: "PsxPlayer config or method argument is invalid.",
    data,
});

const unsupported = (message: string): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.UNSUPPORTED,
    message,
});

export default class PsxPlayer {
    readonly #adapter: PsxPlayerConfig["adapter"];
    readonly #display: PsxPlayerConfig["display"];
    readonly #createAudio: PsxPlayerConfig["createAudio"];
    readonly #storage: NonNullable<PsxPlayerConfig["storage"]> | null;
    readonly #profileId: string | null;
    readonly #cardIds: NonNullable<PsxPlayerConfig["memoryCardIds"]> | null;
    readonly #intervalScheduler: NonNullable<PsxPlayerConfig["intervalScheduler"]> | null;
    readonly #autoSaveIntervalMs: number;
    readonly #listeners: { [K in keyof PsxPlayerEventMap]: Set<Listener<PsxPlayerEventMap[K]>> } = {
        status: new Set(),
        error: new Set(),
    };
    #status: PsxPlayerStatus = "idle";
    #session: PsxSession | null = null;
    #input: PsxInput | null = null;
    #audio: PsxPlayerAudioLike | null = null;
    #autoSave: PsxCardAutoSave | null = null;
    #unsubscribeExit: Unsubscribe | null = null;
    #operationInFlight = false;

    constructor(config: PsxPlayerConfig) {
        if (!isPsxPlayerConfig(config)) throw invalid(config);
        this.#adapter = config.adapter;
        this.#display = config.display;
        this.#createAudio = config.createAudio;
        this.#storage = config.storage ?? null;
        this.#profileId = config.profileId?.trim().normalize("NFC") ?? null;
        this.#cardIds = config.memoryCardIds ?? null;
        this.#intervalScheduler = config.intervalScheduler ?? null;
        this.#autoSaveIntervalMs = config.autoSaveIntervalMs ?? PsxCardAutoSave.DEFAULT_INTERVAL_MS;
    }

    get status(): PsxPlayerStatus { return this.#status; }
    get session(): PsxSession | null { return this.#session; }
    get input(): PsxInput | null { return this.#input; }
    get audio(): PsxPlayerAudioLike | null { return this.#audio; }

    on<K extends keyof PsxPlayerEventMap>(
        type: K,
        listener: Listener<PsxPlayerEventMap[K]>,
    ): Unsubscribe {
        this.#assertNotDestroyed();
        if (typeof listener !== "function") throw invalid(listener);
        this.#listeners[type].add(listener);
        return () => this.#listeners[type].delete(listener);
    }

    async start(config: PsxStartConfig): Promise<void> {
        this.#assertNotDestroyed();
        if (this.#status !== "idle") throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.ALREADY_STARTED,
            message: "PsxPlayer is not idle.",
        });
        if (!isPsxStartConfig(config)) throw invalid(config);
        this.#setStatus("starting");
        let session: PsxSession | null = null;
        let input: PsxInput | null = null;
        let audio: PsxPlayerAudioLike | null = null;
        let autoSave: PsxCardAutoSave | null = null;
        try {
            const cardRecords = await this.#loadCards();
            const memoryCards = {
                ...(config.memoryCards ?? {}),
                ...(cardRecords[1] === null ? {} : { 1: cardRecords[1].bytes }),
                ...(cardRecords[2] === null ? {} : { 2: cardRecords[2].bytes }),
            };
            session = await this.#adapter.start({
                ...config,
                ...(Object.keys(memoryCards).length === 0 ? {} : { memoryCards }),
            });
            this.#session = session;
            this.#unsubscribeExit = session.onExit(() => this.#unexpectedExit());
            input = new PsxInput({ session });
            this.#input = input;
            this.#display.attach(session);
            if (!this.#display.hasFrame) throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.CORE_START_FAILED,
                message: "The startup frame was not available to the display.",
            });
            audio = this.#createAudio(session);
            if (!isPsxPlayerAudioLike(audio)) throw invalid(audio);
            this.#audio = audio;
            if (this.#storage !== null && this.#profileId !== null && this.#cardIds !== null
                && this.#intervalScheduler !== null) {
                const storage = this.#storage;
                const profileId = this.#profileId;
                const cardIds = this.#cardIds;
                const scheduler = this.#intervalScheduler;
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
                    intervalMs: this.#autoSaveIntervalMs,
                    onError: (error) => this.#emit("error", error),
                });
                autoSave.start();
                this.#autoSave = autoSave;
            }
            this.#setStatus("running");
        } catch (error) {
            autoSave?.destroy();
            audio?.destroy();
            this.#display.detach();
            input?.destroy();
            this.#unsubscribeExit?.();
            this.#unsubscribeExit = null;
            if (session !== null) {
                try { await session.exit(); } catch { /* preserve startup failure */ }
            }
            this.#clearSessionGraph();
            this.#setStatus("idle");
            this.#emit("error", error);
            throw error;
        }
    }

    async pause(): Promise<void> {
        await this.#exclusive(async () => {
            const session = this.#requireStatus("running");
            this.#input?.releaseAll();
            this.#audio?.resetQueue();
            session.pause();
            this.#setStatus("paused");
            await this.#flushCards();
        });
    }

    resume(): void {
        if (this.#operationInFlight) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.INTERNAL_ERROR,
            message: "PsxPlayer has another operation in progress.",
        });
        const session = this.#requireStatus("paused");
        session.resume();
        this.#setStatus("running");
    }

    async reset(kind: "soft" | "hard"): Promise<void> {
        await this.#exclusive(async () => {
            const session = this.#requireActive();
            if (kind !== "soft" && kind !== "hard") throw invalid(kind);
            this.#input?.releaseAll();
            this.#audio?.resetQueue();
            await this.#flushCards();
            await session.reset(kind);
        });
    }

    async setDisc(index: number): Promise<void> {
        await this.#exclusive(async () => {
            const session = this.#requireActive();
            this.#input?.releaseAll();
            this.#audio?.resetQueue();
            await session.setDisc(index);
        });
    }

    async saveState(name: string): Promise<PsxStateRecord> {
        return this.#exclusive(async () => {
            const session = this.#requireActive();
            const storage = this.#requireStorage();
            await this.#flushCards();
            const payload = await session.serializeState();
            return storage.saveState({
                profileId: this.#profileId!,
                name,
                machine: session.machine,
                discIndex: session.discIndex,
                payload,
            });
        });
    }

    async loadState(name: string): Promise<void> {
        await this.#exclusive(async () => {
            const session = this.#requireActive();
            const storage = this.#requireStorage();
            const state = await storage.loadState({ profileId: this.#profileId!, name, machine: session.machine });
            if (state === null) throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.STATE_FAILED,
                message: "The named save state does not exist.",
            });
            const resume = this.#status === "running";
            if (resume) session.pause();
            this.#input?.releaseAll();
            this.#audio?.resetQueue();
            try {
                if (session.discIndex !== state.metadata.discIndex) await session.setDisc(state.metadata.discIndex);
                await session.unserializeState(state.payload);
                await this.#flushCards();
            } finally {
                if (resume) session.resume();
            }
        });
    }

    async deleteState(name: string): Promise<void> {
        await this.#exclusive(async () => {
            const session = this.#requireActive();
            const storage = this.#requireStorage();
            await storage.deleteState(this.#profileId!, session.machine.gameId, name);
        });
    }

    downloadMemoryCard(slot: ControllerPort): Promise<Uint8Array> {
        if (!isControllerPort(slot)) return Promise.reject(invalid(slot));
        return this.#requireActive().readMemoryCard(slot);
    }

    async replaceMemoryCard(slot: ControllerPort, bytes: Uint8Array): Promise<PsxMemoryCardRecord> {
        this.#assertNotDestroyed();
        if (this.#status !== "idle") throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.ALREADY_STARTED,
            message: "Memory cards can only be replaced while the player is idle.",
        });
        if (!isControllerPort(slot) || !(bytes instanceof Uint8Array)
            || bytes.byteLength !== 128 * 1024) throw invalid({ slot, bytes });
        const storage = this.#requireStorage();
        const cardId = this.#cardIds![slot];
        const current = await storage.loadMemoryCard(this.#profileId!, cardId);
        return storage.saveMemoryCard({
            profileId: this.#profileId!,
            cardId,
            expectedRevision: current?.revision ?? null,
            bytes,
        });
    }

    async stop(): Promise<void> {
        this.#assertNotDestroyed();
        if (this.#operationInFlight) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.INTERNAL_ERROR,
            message: "PsxPlayer has another operation in progress.",
        });
        if (this.#status !== "running" && this.#status !== "paused" && this.#status !== "failed") {
            if (this.#status === "idle") return;
            throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.INTERNAL_ERROR,
                message: "PsxPlayer cannot stop during another lifecycle transition.",
            });
        }
        const wasRunning = this.#status === "running";
        this.#setStatus("stopping");
        let failure: unknown;
        if (wasRunning && this.#session !== null) {
            this.#input?.releaseAll();
            this.#audio?.resetQueue();
            try { this.#session.pause(); } catch (error) { failure = error; }
        }
        try { await this.#autoSave?.stop(true); } catch (error) { failure ??= error; }
        this.#autoSave?.destroy();
        this.#autoSave = null;
        this.#input?.destroy();
        this.#input = null;
        this.#audio?.destroy();
        this.#audio = null;
        this.#display.detach();
        this.#unsubscribeExit?.();
        this.#unsubscribeExit = null;
        const session = this.#session;
        if (session !== null) {
            try { await session.exit(); } catch (error) { failure ??= error; }
        }
        this.#session = null;
        if (failure !== undefined) {
            this.#setStatus("failed");
            this.#emit("error", failure);
            throw failure;
        }
        this.#setStatus("idle");
    }

    async destroy(): Promise<void> {
        if (this.#status === "destroyed") return;
        if (this.#operationInFlight) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.INTERNAL_ERROR,
            message: "PsxPlayer has another operation in progress.",
        });
        if (this.#status !== "idle") {
            try { await this.stop(); } catch { /* terminal cleanup continues */ }
        }
        this.#autoSave?.destroy();
        this.#input?.destroy();
        this.#audio?.destroy();
        this.#display.detach();
        this.#display.destroy();
        this.#unsubscribeExit?.();
        this.#clearSessionGraph();
        this.#setStatus("destroyed");
        this.#listeners.status.clear();
        this.#listeners.error.clear();
    }

    async #loadCards(): Promise<Record<ControllerPort, PsxMemoryCardRecord | null>> {
        if (this.#storage === null || this.#profileId === null || this.#cardIds === null) {
            return { 1: null, 2: null };
        }
        const storage = this.#storage;
        const profileId = this.#profileId;
        const cardIds = this.#cardIds;
        const [first, second] = await Promise.all([
            storage.loadMemoryCard(profileId, cardIds[1]),
            storage.loadMemoryCard(profileId, cardIds[2]),
        ]);
        return { 1: first, 2: second };
    }

    async #flushCards(): Promise<void> {
        await this.#autoSave?.flush();
    }

    async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
        if (this.#operationInFlight) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.INTERNAL_ERROR,
            message: "PsxPlayer has another operation in progress.",
        });
        this.#operationInFlight = true;
        try {
            return await operation();
        } finally {
            this.#operationInFlight = false;
        }
    }

    #requireStorage(): NonNullable<PsxPlayerConfig["storage"]> {
        if (this.#storage === null || this.#profileId === null || this.#cardIds === null) {
            throw unsupported("Persistent storage is not configured.");
        }
        return this.#storage;
    }

    #requireActive(): PsxSession {
        this.#assertNotDestroyed();
        if ((this.#status !== "running" && this.#status !== "paused") || this.#session === null) {
            throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.NOT_STARTED,
                message: "PsxPlayer has no active session.",
            });
        }
        return this.#session;
    }

    #requireStatus(status: "running" | "paused"): PsxSession {
        const session = this.#requireActive();
        if (this.#status !== status) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.INTERNAL_ERROR,
            message: `PsxPlayer must be ${status} for this operation.`,
        });
        return session;
    }

    #unexpectedExit(): void {
        if (this.#status === "stopping" || this.#status === "idle" || this.#status === "destroyed") return;
        this.#setStatus("failed");
        this.#emit("error", new PsxRuntimeError({
            code: PsxRuntimeError.CODE.WORKER_FAILED,
            message: "The emulation session exited unexpectedly.",
        }));
    }

    #clearSessionGraph(): void {
        this.#session = null;
        this.#input = null;
        this.#audio = null;
        this.#autoSave = null;
    }

    #setStatus(status: PsxPlayerStatus): void {
        if (this.#status === status) return;
        this.#status = status;
        this.#emit("status", status);
    }

    #emit<K extends keyof PsxPlayerEventMap>(type: K, event: PsxPlayerEventMap[K]): void {
        for (const listener of [...this.#listeners[type]]) {
            try { listener(event); } catch { /* observers do not own the lifecycle */ }
        }
    }

    #assertNotDestroyed(): void {
        if (this.#status === "destroyed") throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "PsxPlayer has been destroyed.",
        });
    }

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
