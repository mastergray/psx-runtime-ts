import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";
import { isPsxCardAutoSaveConfig } from "./types.js";

import type { ControllerPort } from "../shared.types.js";
import type {
    PsxCardAutoSaveConfig,
    PsxMemoryCardRecord,
} from "./types.js";

interface MutableBinding {
    readonly cardId: string;
    revision: number | null;
    bytes: Uint8Array | null;
}

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
    if (left.byteLength !== right.byteLength) return false;
    for (let index = 0; index < left.byteLength; index++) {
        if (left[index] !== right[index]) return false;
    }
    return true;
};

export default class PsxCardAutoSave {
    static readonly DEFAULT_INTERVAL_MS = 5_000;

    readonly #storage: PsxCardAutoSaveConfig["storage"];
    readonly #session: PsxCardAutoSaveConfig["session"];
    readonly #profileId: string;
    readonly #scheduler: PsxCardAutoSaveConfig["scheduler"];
    readonly #intervalMs: number;
    readonly #onError: (error: unknown) => void;
    readonly #cards: Record<ControllerPort, MutableBinding>;
    #timer: unknown = null;
    #inFlight: Promise<void> | null = null;
    #pending = false;
    #destroyed = false;

    constructor(config: PsxCardAutoSaveConfig) {
        if (!isPsxCardAutoSaveConfig(config)) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.INVALID_CONFIG,
            message: "PsxCardAutoSave config is invalid.",
            data: config,
        });
        this.#storage = config.storage;
        this.#session = config.session;
        this.#profileId = config.profileId.trim().normalize("NFC");
        this.#scheduler = config.scheduler;
        this.#intervalMs = config.intervalMs ?? PsxCardAutoSave.DEFAULT_INTERVAL_MS;
        this.#onError = config.onError ?? (() => undefined);
        this.#cards = {
            1: {
                cardId: config.cards[1].cardId,
                revision: config.cards[1].revision,
                bytes: config.cards[1].bytes?.slice() ?? null,
            },
            2: {
                cardId: config.cards[2].cardId,
                revision: config.cards[2].revision,
                bytes: config.cards[2].bytes?.slice() ?? null,
            },
        };
    }

    get isRunning(): boolean { return this.#timer !== null; }

    get revisions(): Readonly<Record<ControllerPort, number | null>> {
        return Object.freeze({ 1: this.#cards[1].revision, 2: this.#cards[2].revision });
    }

    start(): void {
        this.#assertLive();
        if (this.#timer !== null) return;
        this.#timer = this.#scheduler.setInterval(() => {
            void this.flush().catch(() => undefined);
        }, this.#intervalMs);
    }

    flush(): Promise<void> {
        this.#assertLive();
        if (this.#inFlight !== null) {
            this.#pending = true;
            return this.#inFlight;
        }
        const operation = (async () => {
            do {
                this.#pending = false;
                await this.#flushOnce();
            } while (this.#pending);
        })();
        let tracked: Promise<void>;
        tracked = operation.finally(() => {
            if (this.#inFlight === tracked) this.#inFlight = null;
        });
        this.#inFlight = tracked;
        return tracked;
    }

    async stop(flush = true): Promise<void> {
        this.#assertLive();
        if (this.#timer !== null) {
            this.#scheduler.clearInterval(this.#timer);
            this.#timer = null;
        }
        if (flush) await this.flush();
    }

    destroy(): void {
        if (this.#destroyed) return;
        if (this.#timer !== null) this.#scheduler.clearInterval(this.#timer);
        this.#timer = null;
        this.#destroyed = true;
    }

    async #flushOnce(): Promise<void> {
        try {
            for (const slot of [1, 2] as const) {
                const binding = this.#cards[slot];
                const bytes = await this.#session.readMemoryCard(slot);
                if (binding.bytes !== null && equalBytes(binding.bytes, bytes)) continue;
                const saved: PsxMemoryCardRecord = await this.#storage.saveMemoryCard({
                    profileId: this.#profileId,
                    cardId: binding.cardId,
                    expectedRevision: binding.revision,
                    bytes,
                });
                binding.revision = saved.revision;
                binding.bytes = saved.bytes.slice();
            }
        } catch (error) {
            this.#onError(error);
            throw error;
        }
    }

    #assertLive(): void {
        if (this.#destroyed) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "PsxCardAutoSave has been destroyed.",
        });
    }
}
