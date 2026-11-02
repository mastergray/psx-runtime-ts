// Dependencies:
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Reports invalid configuration, audio failures, and destroyed use
import {
    isPsxSession,       // Validates the high-level factory session boundary
    isPsxSoundEvent,    // Rejects malformed sound callbacks from the session
} from "../shared.types.js";
import {
    deinterleavePsxStereo,        // Splits interleaved samples into Web Audio channels
    isPsxAudioConfig,             // Validates direct construction dependencies
    isPsxAudioContextLike,        // Validates the context returned by an injected factory
    isPsxGestureSourceLike,       // Validates the browser gesture boundary
    psxAudioQueueCapDecision,     // Calculates deterministic latency trimming
} from "./types.js";

// Type dependencies:
import type {
    PsxSoundEvent,    // Interleaved signed 16-bit stereo frames from the core
    Unsubscribe,      // Cleanup for sound and gesture listeners
} from "../shared.types.js";
import type {
    PsxAudioBufferSourceLike,    // Schedulable Web Audio source boundary
    PsxAudioConfig,              // Session, gesture, context, and volume dependencies
    PsxAudioContextLike,         // Minimal Web Audio context used by the runtime
    PsxAudioContextFactory,      // Injectable context constructor
    PsxGainNodeLike,             // Minimal gain-node boundary for mute and volume
    PsxGestureSourceLike,        // Event target capable of authorizing audio playback
} from "./types.js";

/**
 *
 * Type Declarations
 *
 */

// TYPE :: {left:float32Array, right:float32Array}
// Deinterleaved stereo frames waiting to be scheduled.
interface StereoChunk {
    readonly left: Float32Array;     // Left-channel samples in playback order
    readonly right: Float32Array;    // Right-channel samples in playback order
}

// TYPE :: stereoChunk & {source:psxAudioBufferSourceLike, frames:NUMBER, sampleRate:NUMBER, startTime:NUMBER}
// Stereo frames already scheduled on the device timeline.
interface ScheduledChunk extends StereoChunk {
    readonly source: PsxAudioBufferSourceLike;    // Web Audio source controlling this chunk
    readonly frames: number;                      // Total stereo frames in the buffer
    readonly sampleRate: number;                  // Device playback rate used for timing
    readonly startTime: number;                   // Context timestamp at which playback begins
}

// METHOD :: UNKNOWN -> psxRuntimeError
// Creates one invalid audio configuration or property error.
const invalid = (data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.INVALID_CONFIG,
    message: "PsxAudio config is invalid.",
    data,
});

// METHOD :: STRING, UNKNOWN? -> psxRuntimeError
// Creates one Web Audio construction, resume, or scheduling error.
const audioFailed = (message: string, data?: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.AUDIO_FAILED,
    message,
    data,
});

/**
 *
 * Class
 *
 */

// Buffers core PCM events onto a bounded, gesture-authorized Web Audio timeline.
export default class PsxAudio {

    /* Static Fields */
    static readonly GESTURE_EVENTS = Object.freeze(["pointerdown", "keydown", "touchend"]); // Browser events that may authorize playback
    static readonly MAX_QUEUE_MS = 120;                                                       // Hard latency ceiling before incoming audio is trimmed
    static readonly TRIM_QUEUE_MS = 60;                                                       // Target latency retained after overflow
    static readonly MIN_CHUNK_MS = 16;                                                        // Minimum pending duration scheduled as one buffer
    static readonly LEAD_SECONDS = 0.02;                                                      // Startup cushion preventing immediate underrun
    static readonly TIMING_GAP_MS = 250;                                                      // Core event gap that resets a stale queue

    /* Instance Fields */
    private readonly _session: PsxAudioConfig["session"];               // Active session producing sound events
    private readonly _gestureSource: PsxGestureSourceLike;               // Browser event target used for autoplay authorization
    private readonly _createAudioContext: PsxAudioContextFactory;        // Injectable Web Audio context factory
    private readonly _clock: (() => number) | null;                      // Optional monotonic wall clock for gap detection
    private readonly _unsubscribeSound: Unsubscribe;                     // Session sound-listener cleanup
    private _context: PsxAudioContextLike | null = null;                 // Lazily created device audio context
    private _muteGain: PsxGainNodeLike | null = null;                    // Binary mute stage connected to scheduled sources
    private _volumeGain: PsxGainNodeLike | null = null;                  // User volume stage connected to the destination
    private _pending: StereoChunk[] = [];                                // Deinterleaved frames awaiting scheduling
    private _pendingFrames = 0;                                          // Aggregate frame count in the pending queue
    private _scheduled: ScheduledChunk[] = [];                           // Buffers placed on the device timeline
    private _nextStartTime = 0;                                          // End timestamp of the latest scheduled buffer
    private _restartTrimmed = false;                                     // Whether overflow recovery should omit startup lead
    private _droppedSamples = 0;                                         // Aggregate interleaved samples discarded for latency
    private _armed: Unsubscribe | null = null;                           // Gesture-listener cleanup while authorization is pending
    private _muted = false;                                              // Requested mute state retained before context creation
    private _volume: number;                                             // Requested normalized volume retained before context creation
    private _lastSoundMs: number | null = null;                          // Monotonic timestamp of the previous core sound event
    private _destroyed = false;                                          // Whether audio ownership has ended

    // CONSTRUCTOR :: psxAudioConfig -> psxAudio
    // Validates dependencies and subscribes to session sound events.
    constructor(config: PsxAudioConfig) {
        if (!isPsxAudioConfig(config)) throw invalid(config);
        this._session = config.session;
        this._gestureSource = config.gestureSource;
        this._createAudioContext = config.createAudioContext;
        this._clock = config.clock ?? null;
        this._volume = config.volume ?? 1;
        this._unsubscribeSound = config.session.onSound((sound) => this._enqueue(sound));
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> BOOLEAN
    // Reports whether the device context is actively running.
    get isUnlocked(): boolean { return this._context?.state === "running"; }

    // GETTER :: VOID -> BOOLEAN
    // Reports the requested mute state.
    get isMuted(): boolean { return this._muted; }

    // GETTER :: VOID -> NUMBER
    // Returns normalized output volume.
    get volume(): number { return this._volume; }

    // GETTER :: VOID -> NUMBER?
    // Returns the realized device sample rate after context creation.
    get deviceSampleRate(): number | null { return this._context?.sampleRate ?? null; }

    // GETTER :: VOID -> NUMBER
    // Returns the aggregate interleaved samples dropped for latency control.
    get droppedSamples(): number { return this._droppedSamples; }

    // GETTER :: VOID -> NUMBER
    // Estimates pending and unplayed scheduled audio duration in milliseconds.
    get queuedMs(): number {
        const context = this._context;
        const rate = this._session.machine.sampleRate;
        let milliseconds = this._pendingFrames / rate * 1000;
        if (context === null) return milliseconds;
        for (const chunk of this._scheduled) {
            milliseconds += PsxAudio.remainingFrames(chunk, context.currentTime) / chunk.sampleRate * 1000;
        }
        return milliseconds;
    }

    // SETTER :: NUMBER -> VOID
    // Sets normalized output volume and updates an existing gain stage.
    set volume(value: number) {
        this._assertLive();
        if (!Number.isFinite(value) || value < 0 || value > 1) throw invalid(value);
        this._volume = value;
        if (this._volumeGain !== null) this._volumeGain.gain.value = value;
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: VOID -> PROMISE(VOID)
    // Creates and resumes the context from an authorized user gesture.
    async unlock(): Promise<void> {
        this._assertLive();
        const context = this._ensureContext();
        if (context.state !== "running") {
            try {
                await context.resume();
            } catch (error) {
                throw audioFailed("The audio context could not be resumed.", error);
            }
        }
        this._lastSoundMs = this._nowMs();
        this._flush();
    }

    // METHOD :: VOID -> unsubscribe
    // Installs one-shot gesture listeners that unlock audio when permitted.
    armGestureUnlock(): Unsubscribe {
        this._assertLive();
        if (this._armed !== null) return this._armed;
        const listener = (): void => { void this.unlock().then(remove, () => undefined); };
        const remove = (): void => {
            PsxAudio.GESTURE_EVENTS.forEach((type) => this._gestureSource.removeEventListener(type, listener));
            this._armed = null;
        };
        PsxAudio.GESTURE_EVENTS.forEach((type) => {
            this._gestureSource.addEventListener(type, listener, { passive: true });
        });
        this._armed = remove;
        return remove;
    }

    // METHOD :: VOID -> VOID
    // Silences output without discarding queued audio.
    mute(): void {
        this._assertLive();
        this._muted = true;
        if (this._muteGain !== null) this._muteGain.gain.value = 0;
    }

    // METHOD :: VOID -> VOID
    // Restores output without changing normalized volume.
    unmute(): void {
        this._assertLive();
        this._muted = false;
        if (this._muteGain !== null) this._muteGain.gain.value = 1;
    }

    // METHOD :: VOID -> VOID
    // Cancels pending playback and resets timing continuity.
    resetQueue(): void {
        this._assertLive();
        this._cancelScheduled();
        this._pending = [];
        this._pendingFrames = 0;
        this._restartTrimmed = false;
        this._lastSoundMs = null;
    }

    // METHOD :: VOID -> VOID
    // Unsubscribes, cancels playback, and closes the device context.
    destroy(): void {
        if (this._destroyed) return;
        this._unsubscribeSound();
        this._armed?.();
        this._cancelScheduled();
        this._pending = [];
        this._pendingFrames = 0;
        const context = this._context;
        this._context = null;
        this._destroyed = true;
        if (context !== null) {
            try { void context.close().catch(() => undefined); } catch { /* close is best effort */ }
        }
    }

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: VOID -> psxAudioContextLike
    // Lazily creates and connects validated mute and volume stages.
    private _ensureContext(): PsxAudioContextLike {
        if (this._context !== null) return this._context;
        let context: PsxAudioContextLike | null = null;
        try {
            context = this._createAudioContext({ sampleRate: this._session.machine.sampleRate });
            if (!isPsxAudioContextLike(context)) throw new TypeError("Invalid AudioContext boundary.");
            const muteGain = context.createGain();
            const volumeGain = context.createGain();
            muteGain.gain.value = this._muted ? 0 : 1;
            volumeGain.gain.value = this._volume;
            muteGain.connect(volumeGain);
            volumeGain.connect(context.destination);
            this._muteGain = muteGain;
            this._volumeGain = volumeGain;
        } catch (error) {
            if (context !== null) {
                try { void context.close().catch(() => undefined); } catch { /* cleanup is best effort */ }
            }
            throw audioFailed("The audio context could not be created.", error);
        }
        this._context = context;
        return context;
    }

    // METHOD :: psxSoundEvent -> VOID
    // Deinterleaves, caps, queues, and attempts to schedule one core audio event.
    private _enqueue(sound: PsxSoundEvent): void {
        if (this._destroyed || !isPsxSoundEvent(sound) || sound.frames === 0) return;
        const now = this._nowMs();
        if (this._lastSoundMs !== null && now - this._lastSoundMs > PsxAudio.TIMING_GAP_MS) {
            this._cancelScheduled();
            this._pending = [];
            this._pendingFrames = 0;
            this._restartTrimmed = false;
        }
        this._lastSoundMs = now;
        this._prunePlayed();
        const [left, right] = deinterleavePsxStereo(sound.samples);
        const rate = this._session.machine.sampleRate;
        const decision = psxAudioQueueCapDecision(
            this.queuedMs,
            sound.frames,
            rate,
            PsxAudio.MAX_QUEUE_MS,
            PsxAudio.TRIM_QUEUE_MS,
        );
        if (decision.dropQueuedFrames > 0) this._dropQueuedFrames(decision.dropQueuedFrames);
        this._droppedSamples += (decision.dropQueuedFrames + decision.dropIncomingFrames) * 2;
        if (decision.dropIncomingFrames < sound.frames) {
            const offset = decision.dropIncomingFrames;
            const chunk = offset === 0
                ? { left, right }
                : { left: left.subarray(offset), right: right.subarray(offset) };
            this._pending.push(chunk);
            this._pendingFrames += chunk.left.length;
        }
        this._flush();
    }

    // METHOD :: VOID -> VOID
    // Combines pending frames into one device buffer when scheduling is ready.
    private _flush(): void {
        const context = this._context;
        const gain = this._muteGain;
        const rate = this._session.machine.sampleRate;
        if (this._destroyed || context?.state !== "running" || gain === null
            || this._pendingFrames / rate * 1000 < PsxAudio.MIN_CHUNK_MS) return;
        const left = new Float32Array(this._pendingFrames);
        const right = new Float32Array(this._pendingFrames);
        let offset = 0;
        this._pending.forEach((chunk) => {
            left.set(chunk.left, offset);
            right.set(chunk.right, offset);
            offset += chunk.left.length;
        });
        let source: PsxAudioBufferSourceLike | null = null;
        let scheduled: ScheduledChunk | null = null;
        try {
            const buffer = context.createBuffer(2, this._pendingFrames, rate);
            buffer.getChannelData(0).set(left);
            buffer.getChannelData(1).set(right);
            source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(gain);
            const lead = this._restartTrimmed ? 0 : PsxAudio.LEAD_SECONDS;
            const startTime = this._nextStartTime > context.currentTime
                ? this._nextStartTime
                : context.currentTime + lead;
            scheduled = {
                left,
                right,
                source,
                frames: buffer.length,
                sampleRate: buffer.sampleRate,
                startTime,
            };
            source.onended = () => { if (scheduled !== null) this._removeScheduled(scheduled); };
            this._scheduled.push(scheduled);
            source.start(startTime);
            this._nextStartTime = startTime + buffer.length / buffer.sampleRate;
        } catch (error) {
            if (scheduled !== null) this._removeScheduled(scheduled);
            if (source !== null) {
                source.onended = null;
                try { source.stop(); } catch { /* source was not started */ }
            }
            throw audioFailed("An audio buffer could not be scheduled.", error);
        }
        this._pending = [];
        this._pendingFrames = 0;
        this._restartTrimmed = false;
    }

    // METHOD :: NUMBER -> VOID
    // Drops the oldest unplayed frames across scheduled and pending chunks.
    private _dropQueuedFrames(count: number): void {
        const context = this._context;
        const chunks: StereoChunk[] = [];
        if (context !== null) {
            for (const scheduled of this._scheduled) {
                const remaining = PsxAudio.remainingFrames(scheduled, context.currentTime);
                if (remaining === 0) continue;
                const consumed = scheduled.frames - remaining;
                chunks.push({ left: scheduled.left.subarray(consumed), right: scheduled.right.subarray(consumed) });
            }
        }
        chunks.push(...this._pending);
        this._cancelScheduled();
        this._pending = [];
        this._pendingFrames = 0;
        this._restartTrimmed = true;
        let remainingDrop = count;
        for (const chunk of chunks) {
            if (remainingDrop >= chunk.left.length) {
                remainingDrop -= chunk.left.length;
                continue;
            }
            const retained = remainingDrop === 0
                ? chunk
                : { left: chunk.left.subarray(remainingDrop), right: chunk.right.subarray(remainingDrop) };
            remainingDrop = 0;
            this._pending.push(retained);
            this._pendingFrames += retained.left.length;
        }
    }

    // METHOD :: VOID -> VOID
    // Removes buffers whose device timeline has fully elapsed.
    private _prunePlayed(): void {
        const context = this._context;
        if (context === null) return;
        this._scheduled = this._scheduled.filter((chunk) => {
            if (PsxAudio.remainingFrames(chunk, context.currentTime) > 0) return true;
            chunk.source.onended = null;
            return false;
        });
        this._nextStartTime = this._scheduled.reduce(
            (latest, chunk) => Math.max(latest, chunk.startTime + chunk.frames / chunk.sampleRate),
            0,
        );
    }

    // METHOD :: VOID -> VOID
    // Stops and forgets every scheduled buffer source.
    private _cancelScheduled(): void {
        const scheduled = this._scheduled;
        this._scheduled = [];
        this._nextStartTime = 0;
        scheduled.forEach(({ source }) => {
            source.onended = null;
            try { source.stop(); } catch { /* source already stopped */ }
        });
    }

    // METHOD :: scheduledChunk -> VOID
    // Removes one completed source and recalculates the queue end time.
    private _removeScheduled(chunk: ScheduledChunk): void {
        const index = this._scheduled.indexOf(chunk);
        if (index >= 0) this._scheduled.splice(index, 1);
        this._nextStartTime = this._scheduled.reduce(
            (latest, item) => Math.max(latest, item.startTime + item.frames / item.sampleRate),
            0,
        );
    }

    // METHOD :: VOID -> NUMBER
    // Returns the injected clock or a context-derived millisecond timeline.
    private _nowMs(): number {
        if (this._clock !== null) return this._clock();
        return (this._context?.currentTime ?? 0) * 1000;
    }

    // METHOD :: VOID -> VOID
    // Rejects operations after audio destruction.
    private _assertLive(): void {
        if (this._destroyed) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "PsxAudio has been destroyed.",
        });
    }

    /**
     *
     * Static Methods
     *
     */

    // METHOD :: scheduledChunk, NUMBER -> NUMBER
    // Calculates the unplayed frames for a scheduled chunk at one context time.
    static remainingFrames(chunk: ScheduledChunk, now: number): number {
        if (now <= chunk.startTime) return chunk.frames;
        const played = Math.floor((now - chunk.startTime) * chunk.sampleRate + 1e-7);
        return Math.max(0, chunk.frames - played);
    }

    // Static Factory Method :: psxAudioConfig -> psxAudio
    // Creates audio from an injected context factory or the browser AudioContext.
    static init(config: Omit<PsxAudioConfig, "createAudioContext"> & {
        readonly createAudioContext?: PsxAudioContextFactory;
    }): PsxAudio {
        if (config.createAudioContext !== undefined) {
            return new PsxAudio({ ...config, createAudioContext: config.createAudioContext });
        }
        if (!isPsxSession(config.session) || !isPsxGestureSourceLike(config.gestureSource)) {
            throw invalid(config);
        }
        const AudioContextImplementation = globalThis.AudioContext;
        if (typeof AudioContextImplementation !== "function") {
            throw audioFailed("AudioContext is unavailable.");
        }
        const createAudioContext: PsxAudioContextFactory = ({ sampleRate }) =>
            new AudioContextImplementation({ sampleRate }) as unknown as PsxAudioContextLike;
        return new PsxAudio({
            ...config,
            clock: config.clock ?? (() => performance.now()),
            createAudioContext,
        });
    }
}
