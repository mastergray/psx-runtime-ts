export interface FramePacerAdvance {
    readonly frames: number;
    readonly droppedMilliseconds: number;
}

export default class FramePacer {
    readonly framesPerSecond: number;
    readonly maximumFramesPerTick: number;

    #accumulator = 0;
    #lastTimestamp: number | null = null;
    #paused = false;

    constructor(framesPerSecond: number, maximumFramesPerTick = 4) {
        if (!Number.isFinite(framesPerSecond) || framesPerSecond <= 0) {
            throw new TypeError("framesPerSecond must be positive and finite");
        }
        if (!Number.isSafeInteger(maximumFramesPerTick) || maximumFramesPerTick <= 0) {
            throw new TypeError("maximumFramesPerTick must be a positive integer");
        }
        this.framesPerSecond = framesPerSecond;
        this.maximumFramesPerTick = maximumFramesPerTick;
    }

    advance(timestamp: number): FramePacerAdvance {
        if (!Number.isFinite(timestamp) || timestamp < 0) {
            throw new TypeError("timestamp must be finite and non-negative");
        }
        if (this.#paused) return { frames: 0, droppedMilliseconds: 0 };
        if (this.#lastTimestamp === null) {
            this.#lastTimestamp = timestamp;
            return { frames: 0, droppedMilliseconds: 0 };
        }
        if (timestamp <= this.#lastTimestamp) return { frames: 0, droppedMilliseconds: 0 };
        const elapsed = Math.max(0, timestamp - this.#lastTimestamp);
        this.#lastTimestamp = timestamp;
        const period = 1000 / this.framesPerSecond;
        this.#accumulator += elapsed;
        const tolerance = period * 1e-9;
        const due = Math.floor((this.#accumulator + tolerance) / period);
        if (due === 0) return { frames: 0, droppedMilliseconds: 0 };
        const frames = Math.min(due, this.maximumFramesPerTick);
        const droppedFrames = due - frames;
        this.#accumulator -= due * period;
        if (this.#accumulator < 0 && this.#accumulator > -tolerance) this.#accumulator = 0;
        return { frames, droppedMilliseconds: droppedFrames * period };
    }

    pause(): void {
        this.#paused = true;
        this.#accumulator = 0;
        this.#lastTimestamp = null;
    }

    resume(): void {
        this.#paused = false;
        this.#accumulator = 0;
        this.#lastTimestamp = null;
    }

    reset(): void {
        this.#accumulator = 0;
        this.#lastTimestamp = null;
    }
}
