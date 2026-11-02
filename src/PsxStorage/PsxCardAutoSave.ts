// Dependencies:
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Reports invalid configuration and destroyed lifecycle use
import { isPsxCardAutoSaveConfig } from "./types.js";                  // Validates every constructor dependency at runtime

// Type dependencies:
import type { ControllerPort } from "../shared.types.js";             // Identifies the two independently persisted card slots
import type {
    PsxCardAutoSaveConfig,         // Storage, session, scheduler, and initial card bindings
    PsxMemoryCardRecord,           // Revisioned record returned after a successful save
} from "./types.js";

/**
 *
 * Type Declarations
 *
 */

// TYPE :: {cardId:STRING, revision:NUMBER?, bytes:uint8Array?}
// Mutable auto-save baseline for one inserted memory card.
interface MutableBinding {
    readonly cardId: string;           // Persistent card identity selected for this slot
    revision: number | null;           // Optimistic revision expected by the next save
    bytes: Uint8Array | null;           // Last successfully persisted bytes used for dirty checks
}

/**
 *
 * Class
 *
 */

// Coalesces dirty memory-card writes and preserves optimistic revision baselines.
export default class PsxCardAutoSave {

    /* Static Fields */
    static readonly DEFAULT_INTERVAL_MS = 5_000;                         // Default dirty-check interval

    /* Instance Fields */
    private readonly _storage: PsxCardAutoSaveConfig["storage"];          // Revisioned card persistence boundary
    private readonly _session: PsxCardAutoSaveConfig["session"];          // Active core session supplying current card bytes
    private readonly _profileId: string;                                  // Normalized browser profile owning both cards
    private readonly _scheduler: PsxCardAutoSaveConfig["scheduler"];      // Injectable interval scheduler
    private readonly _intervalMs: number;                                 // Dirty-check cadence in milliseconds
    private readonly _onError: (error: unknown) => void;                  // Non-fatal error observer supplied by the player
    private readonly _cards: Record<ControllerPort, MutableBinding>;      // Per-slot identities and persisted baselines
    private _timer: unknown = null;                                       // Active interval handle, or NULL while stopped
    private _inFlight: Promise<void> | null = null;                       // Current coalesced flush operation
    private _pending = false;                                             // Whether another pass was requested during a flush
    private _destroyed = false;                                           // Whether lifecycle ownership has ended

    // CONSTRUCTOR :: psxCardAutoSaveConfig -> psxCardAutoSave
    // Validates dependencies and snapshots both initial card baselines.
    constructor(config: PsxCardAutoSaveConfig) {
        if (!isPsxCardAutoSaveConfig(config)) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.INVALID_CONFIG,
            message: "PsxCardAutoSave config is invalid.",
            data: config,
        });
        this._storage = config.storage;
        this._session = config.session;
        this._profileId = config.profileId.trim().normalize("NFC");
        this._scheduler = config.scheduler;
        this._intervalMs = config.intervalMs ?? PsxCardAutoSave.DEFAULT_INTERVAL_MS;
        this._onError = config.onError ?? (() => undefined);
        this._cards = {
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

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> BOOLEAN
    // Reports whether the periodic dirty-check timer is active.
    get isRunning(): boolean { return this._timer !== null; }

    // GETTER :: VOID -> ARRAY<controllerPort, NUMBER?>
    // Returns immutable current optimistic revisions for both slots.
    get revisions(): Readonly<Record<ControllerPort, number | null>> {
        return Object.freeze({ 1: this._cards[1].revision, 2: this._cards[2].revision });
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: VOID -> VOID
    // Starts periodic dirty checks once.
    start(): void {
        this._assertLive();
        if (this._timer !== null) return;
        this._timer = this._scheduler.setInterval(() => {
            void this.flush().catch(() => undefined);
        }, this._intervalMs);
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Coalesces concurrent requests and flushes until no follow-up remains.
    flush(): Promise<void> {
        this._assertLive();
        if (this._inFlight !== null) {
            this._pending = true;
            return this._inFlight;
        }
        const operation = (async () => {
            do {
                this._pending = false;
                await this._flushOnce();
            } while (this._pending);
        })();
        let tracked: Promise<void>;
        tracked = operation.finally(() => {
            if (this._inFlight === tracked) this._inFlight = null;
        });
        this._inFlight = tracked;
        return tracked;
    }

    // METHOD :: BOOLEAN? -> PROMISE(VOID)
    // Stops periodic checks and optionally flushes current card bytes.
    async stop(flush = true): Promise<void> {
        this._assertLive();
        if (this._timer !== null) {
            this._scheduler.clearInterval(this._timer);
            this._timer = null;
        }
        if (flush) await this.flush();
    }

    // METHOD :: VOID -> VOID
    // Cancels scheduling and permanently ends lifecycle ownership.
    destroy(): void {
        if (this._destroyed) return;
        if (this._timer !== null) this._scheduler.clearInterval(this._timer);
        this._timer = null;
        this._destroyed = true;
    }

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: VOID -> PROMISE(VOID)
    // Saves each dirty slot once and advances its revision baseline.
    private async _flushOnce(): Promise<void> {
        try {
            for (const slot of [1, 2] as const) {
                const binding = this._cards[slot];
                const bytes = await this._session.readMemoryCard(slot);
                if (binding.bytes !== null && equalBytes(binding.bytes, bytes)) continue;
                const saved: PsxMemoryCardRecord = await this._storage.saveMemoryCard({
                    profileId: this._profileId,
                    cardId: binding.cardId,
                    expectedRevision: binding.revision,
                    bytes,
                });
                binding.revision = saved.revision;
                binding.bytes = saved.bytes.slice();
            }
        } catch (error) {
            this._onError(error);
            throw error;
        }
    }

    // METHOD :: VOID -> VOID
    // Rejects operations after destruction.
    private _assertLive(): void {
        if (this._destroyed) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "PsxCardAutoSave has been destroyed.",
        });
    }
}

/**
 *
 *  Helper Functions
 *
 */

// HELPER :: uint8Array, uint8Array -> BOOLEAN
// Compares two memory-card images without allocating a copy.
const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
    if (left.byteLength !== right.byteLength) return false;
    for (let index = 0; index < left.byteLength; index++) {
        if (left[index] !== right[index]) return false;
    }
    return true;
};
