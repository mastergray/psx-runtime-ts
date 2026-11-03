/**
 *
 * Type Declarations
 *
 */

// TYPE :: {frames:NUMBER, droppedMilliseconds:NUMBER}
// Result of advancing the emulator clock to one host timestamp.
export interface FramePacerAdvance {
    readonly frames: number;                  // Emulated frames due during this host tick
    readonly droppedMilliseconds: number;     // Excess elapsed time discarded by the catch-up cap
}

/**
 *
 * Class
 *
 */

// Converts monotonic host timestamps into bounded emulator frame counts.
export default class FramePacer {

    /* Instance Fields */
    private readonly _framesPerSecond: number;          // Core-reported emulated frame rate
    private readonly _maximumFramesPerTick: number;     // Catch-up cap applied to one host tick
    private _accumulator = 0;                           // Fractional elapsed milliseconds awaiting frames
    private _lastTimestamp: number | null = null;       // Previous accepted host timestamp
    private _paused = false;                            // Whether host time must be ignored

    // CONSTRUCTOR :: NUMBER, NUMBER? -> framePacer
    // Creates a pacer for one emulated frame rate and catch-up cap.
    constructor(framesPerSecond: number, maximumFramesPerTick = 4) {
        if (!Number.isFinite(framesPerSecond) || framesPerSecond <= 0) {
            throw new TypeError("framesPerSecond must be positive and finite");
        }
        if (!Number.isSafeInteger(maximumFramesPerTick) || maximumFramesPerTick <= 0) {
            throw new TypeError("maximumFramesPerTick must be a positive integer");
        }
        this._framesPerSecond = framesPerSecond;
        this._maximumFramesPerTick = maximumFramesPerTick;
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> NUMBER
    // Returns the configured emulated frame rate.
    get framesPerSecond(): number { return this._framesPerSecond; }

    // GETTER :: VOID -> NUMBER
    // Returns the maximum frames emitted by one advance.
    get maximumFramesPerTick(): number { return this._maximumFramesPerTick; }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: NUMBER, NUMBER? -> framePacerAdvance
    // Advances the host clock and returns due-frame work under the configured or supplied cap.
    advance(timestamp: number, maximumFramesPerTick = this._maximumFramesPerTick): FramePacerAdvance {
        if (!Number.isFinite(timestamp) || timestamp < 0) {
            throw new TypeError("timestamp must be finite and non-negative");
        }
        if (!Number.isSafeInteger(maximumFramesPerTick) || maximumFramesPerTick <= 0) {
            throw new TypeError("maximumFramesPerTick must be a positive integer");
        }
        if (this._paused) return { frames: 0, droppedMilliseconds: 0 };
        if (this._lastTimestamp === null) {
            this._lastTimestamp = timestamp;
            return { frames: 0, droppedMilliseconds: 0 };
        }
        if (timestamp <= this._lastTimestamp) return { frames: 0, droppedMilliseconds: 0 };
        const elapsed = Math.max(0, timestamp - this._lastTimestamp);
        this._lastTimestamp = timestamp;
        const period = 1000 / this._framesPerSecond;
        this._accumulator += elapsed;
        const tolerance = period * 1e-9;
        const due = Math.floor((this._accumulator + tolerance) / period);
        if (due === 0) return { frames: 0, droppedMilliseconds: 0 };
        const frames = Math.min(due, maximumFramesPerTick);
        const droppedFrames = due - frames;
        this._accumulator -= due * period;
        if (this._accumulator < 0 && this._accumulator > -tolerance) this._accumulator = 0;
        return { frames, droppedMilliseconds: droppedFrames * period };
    }

    // METHOD :: VOID -> VOID
    // Pauses pacing and discards accumulated host time.
    pause(): void {
        this._paused = true;
        this._accumulator = 0;
        this._lastTimestamp = null;
    }

    // METHOD :: VOID -> VOID
    // Resumes pacing from a fresh host-time baseline.
    resume(): void {
        this._paused = false;
        this._accumulator = 0;
        this._lastTimestamp = null;
    }

    // METHOD :: VOID -> VOID
    // Clears timing history without changing the paused state.
    reset(): void {
        this._accumulator = 0;
        this._lastTimestamp = null;
    }
}
