// Dependencies:
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Reports invalid configuration, audio failures, and destroyed use
import {
    isPsxSession,       // Validates the high-level factory session boundary
    isPsxSoundEvent,    // Rejects malformed sound callbacks from the session
} from "../shared.types.js";
import {
    deinterleavePsxStereo,        // Splits interleaved samples into Web Audio channels
    isPsxAudioConfig,             // Validates direct construction dependencies
    isPsxAudioBufferMode,         // Validates live scheduling-mode changes
    isPsxAudioContextLike,        // Validates the context returned by an injected factory
    isPsxAudioWorkletNodeLike,    // Validates the persistent node returned by an injected factory
    isPsxGestureSourceLike,       // Validates the browser gesture boundary
    psxAudioQueueCapDecision,     // Calculates deterministic latency trimming
} from "./types.js";

// Type dependencies:
import type {
    PsxSoundEvent,    // Interleaved signed 16-bit stereo frames from the core
    PsxPerformanceTiming, // Latest aggregated worker-stage timing window
    Unsubscribe,      // Cleanup for sound and gesture listeners
} from "../shared.types.js";
import type {
    PsxAudioBufferSourceLike,    // Schedulable Web Audio source boundary
    PsxAudioBackend,             // Selected scheduled or rendering-thread implementation
    PsxAudioBufferMode,          // Output strategy balancing latency and stall resilience
    PsxAudioConfig,              // Session, gesture, context, and volume dependencies
    PsxAudioContextLike,         // Minimal Web Audio context used by the runtime
    PsxAudioContextFactory,      // Injectable context constructor
    PsxGainNodeLike,             // Minimal gain-node boundary for mute and volume
    PsxGestureSourceLike,        // Event target capable of authorizing audio playback
    PsxAudioWorkletNodeFactory,  // Injectable persistent-node constructor
    PsxAudioWorkletNodeLike,     // Persistent rendering-thread stereo source
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

// INTERFACE :: {type:"stats", queuedFrames:NUMBER, underruns:NUMBER, droppedFrames:NUMBER, starvationFrames:NUMBER, longestStarvationFrames:NUMBER, adaptiveRecovery:BOOLEAN, consumptionRatio:NUMBER}
// Rendering-thread queue statistics reported by the persistent processor.
interface WorkletStatistics {
    readonly type: "stats";                  // Message discriminator
    readonly queuedFrames: number;           // Stereo frames waiting in the ring
    readonly underruns: number;              // Contiguous starvation episodes
    readonly droppedFrames: number;          // Frames discarded by latency capping
    readonly starvationFrames: number;       // Cumulative post-start silent output frames
    readonly longestStarvationFrames: number; // Longest contiguous post-start starvation episode
    readonly adaptiveRecovery: boolean;      // Whether Adaptive has entered stable recovery
    readonly consumptionRatio: number;       // Source frames consumed for each device output frame
}

// INTERFACE :: {timeMs:NUMBER, frames:NUMBER}
// One recent core-audio delivery used to compare emulated sound duration with wall time.
interface AudioProductionSample {
    readonly timeMs: number;    // Monotonic arrival time on the browser main thread
    readonly frames: number;    // Stereo frames delivered by the core in this event
}

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
    static readonly LEAD_SECONDS = 0.02;                                                      // Low-latency startup cushion preventing immediate underrun
    static readonly STABLE_LEAD_SECONDS = 0.08;                                               // Mobile-oriented cushion surviving transient browser stalls
    static readonly TIMING_GAP_MS = 250;                                                      // Core event gap that resets a stale queue
    static readonly PRODUCTION_WINDOW_MS = 5_000;                                             // Rolling interval used for source-throughput diagnostics
    static readonly PRODUCTION_MINIMUM_MS = 1_000;                                            // Observation required before reporting sustained throughput

    /* Instance Fields */
    private readonly _session: PsxAudioConfig["session"];               // Active session producing sound events
    private readonly _gestureSource: PsxGestureSourceLike;               // Browser event target used for autoplay authorization
    private readonly _createAudioContext: PsxAudioContextFactory;        // Injectable Web Audio context factory
    private readonly _createAudioWorkletNode: PsxAudioWorkletNodeFactory | null; // Optional persistent-node constructor
    private readonly _audioWorkletModuleUrl: string | null;              // Compiled processor module URL paired with its constructor
    private readonly _clock: (() => number) | null;                      // Optional monotonic wall clock for gap detection
    private readonly _unsubscribeSound: Unsubscribe;                     // Session sound-listener cleanup
    private _context: PsxAudioContextLike | null = null;                 // Lazily created device audio context
    private _muteGain: PsxGainNodeLike | null = null;                    // Binary mute stage connected to scheduled sources
    private _volumeGain: PsxGainNodeLike | null = null;                  // User volume stage connected to the destination
    private _workletNode: PsxAudioWorkletNodeLike | null = null;         // Persistent rendering-thread stereo source when available
    private _workletInitialization: Promise<void> | null = null;         // One-time module and node initialization
    private _workletLoading = false;                                     // Whether pending PCM must wait instead of using fallback scheduling
    private _backend: PsxAudioBackend = "scheduled";                     // Active persistent or scheduled output implementation
    private _workletQueuedFrames = 0;                                    // Most recently reported rendering-thread queue depth
    private _workletDroppedSampleBase = 0;                               // Scheduled-path drops retained when the Worklet takes ownership
    private _workletUnderrunBase = 0;                                    // Scheduled-path underruns retained when the Worklet takes ownership
    private _workletStarvationFrames = 0;                                // Post-start silent output frames reported by the Worklet
    private _workletLongestStarvationFrames = 0;                         // Longest Worklet starvation episode
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
    private _bufferMode: PsxAudioBufferMode;                             // Active latency-versus-resilience strategy
    private _adaptiveRecovery = false;                                   // Whether adaptive mode has observed an underrun this session
    private _hasScheduledAudio = false;                                  // Whether a prior non-reset buffer can expose a real underrun
    private _underrunCount = 0;                                          // Device-timeline exhaustions observed during this session
    private _productionSamples: AudioProductionSample[] = [];            // Recent core-audio deliveries used to measure sustained throughput
    private _transportSamples = 0;                                       // Instrumented PCM payloads received on the main thread
    private _productionToPostMilliseconds = 0;                           // Aggregate completed-PCM wait before endpoint post
    private _postToReceiptMilliseconds = 0;                              // Aggregate endpoint-post to main-receipt delay
    private _transportMilliseconds = 0;                                  // Aggregate completed-PCM to main-receipt delay
    private _transportMaximumMs = 0;                                     // Longest completed-PCM to main-receipt delay
    private _destroyed = false;                                          // Whether audio ownership has ended

    // CONSTRUCTOR :: psxAudioConfig -> psxAudio
    // Validates dependencies and subscribes to session sound events.
    constructor(config: PsxAudioConfig) {
        if (!isPsxAudioConfig(config)) throw invalid(config);
        this._session = config.session;
        this._gestureSource = config.gestureSource;
        this._createAudioContext = config.createAudioContext;
        this._createAudioWorkletNode = config.createAudioWorkletNode ?? null;
        this._audioWorkletModuleUrl = config.audioWorkletModuleUrl ?? null;
        this._clock = config.clock ?? null;
        this._volume = config.volume ?? 1;
        this._bufferMode = config.bufferMode ?? "adaptive";
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

    // GETTER :: VOID -> psxAudioBackend
    // Returns the active persistent Worklet or scheduled-source implementation.
    get backend(): PsxAudioBackend { return this._backend; }

    // GETTER :: VOID -> NUMBER
    // Estimates pending and unplayed scheduled audio duration in milliseconds.
    get queuedMs(): number {
        const context = this._context;
        const rate = this._session.machine.sampleRate;
        let milliseconds = this._pendingFrames / rate * 1000;
        if (context === null) return milliseconds;
        if (this._workletNode !== null) return milliseconds + this._workletQueuedFrames / rate * 1000;
        for (const chunk of this._scheduled) {
            milliseconds += PsxAudio.remainingFrames(chunk, context.currentTime) / chunk.sampleRate * 1000;
        }
        return milliseconds;
    }

    // GETTER :: VOID -> psxAudioBufferMode
    // Returns the active scheduling strategy.
    get bufferMode(): PsxAudioBufferMode { return this._bufferMode; }

    // GETTER :: VOID -> NUMBER
    // Returns the lead cushion currently used when the device timeline runs dry.
    get bufferLeadMs(): number {
        return audioBufferLeadSeconds(this._bufferMode, this._adaptiveRecovery) * 1000;
    }

    // GETTER :: VOID -> BOOLEAN
    // Reports whether Adaptive mode has moved into its stable recovery state.
    get isAdaptiveRecovery(): boolean { return this._bufferMode === "adaptive" && this._adaptiveRecovery; }

    // GETTER :: VOID -> NUMBER
    // Returns cumulative device-timeline underruns for this audio session.
    get underrunCount(): number { return this._underrunCount; }

    // GETTER :: VOID -> NUMBER?
    // Reports cumulative post-start silent output duration when the Worklet backend can measure it.
    get starvationMs(): number | null {
        const rate = this._context?.sampleRate;
        return this._backend === "worklet" && rate !== undefined
            ? this._workletStarvationFrames / rate * 1000
            : null;
    }

    // GETTER :: VOID -> NUMBER?
    // Reports the longest contiguous post-start silent output duration when measurable.
    get longestStarvationMs(): number | null {
        const rate = this._context?.sampleRate;
        return this._backend === "worklet" && rate !== undefined
            ? this._workletLongestStarvationFrames / rate * 1000
            : null;
    }

    // GETTER :: VOID -> NUMBER
    // Reports how many instrumented PCM payloads contributed transport timing.
    get transportSamples(): number { return this._transportSamples; }

    // GETTER :: VOID -> NUMBER?
    // Reports average completed-PCM wait before the Worker endpoint posted it.
    get productionToPostAverageMs(): number | null {
        return this._transportSamples === 0
            ? null
            : this._productionToPostMilliseconds / this._transportSamples;
    }

    // GETTER :: VOID -> NUMBER?
    // Reports average endpoint-post to main-thread receipt delay.
    get postToReceiptAverageMs(): number | null {
        return this._transportSamples === 0
            ? null
            : this._postToReceiptMilliseconds / this._transportSamples;
    }

    // GETTER :: VOID -> NUMBER?
    // Reports average completed-PCM to main-thread receipt delay.
    get transportAverageMs(): number | null {
        return this._transportSamples === 0
            ? null
            : this._transportMilliseconds / this._transportSamples;
    }

    // GETTER :: VOID -> NUMBER?
    // Reports the longest completed-PCM to main-thread receipt delay.
    get transportMaximumMs(): number | null {
        return this._transportSamples === 0 ? null : this._transportMaximumMs;
    }

    // GETTER :: VOID -> NUMBER?
    // Reports recent produced audio duration divided by elapsed wall time; one is real time.
    get productionRate(): number | null {
        if (this._productionSamples.length < 2) return null;
        const first = this._productionSamples[0]!;
        const last = this._productionSamples.at(-1)!;
        const elapsedMs = last.timeMs - first.timeMs;
        if (elapsedMs < PsxAudio.PRODUCTION_MINIMUM_MS) return null;
        const frames = this._productionSamples
            .slice(1)
            .reduce((total, sample) => total + sample.frames, 0);
        return frames / this._session.machine.sampleRate * 1000 / elapsedMs;
    }

    // GETTER :: VOID -> NUMBER
    // Reports the longest recent wall-time gap between core-audio deliveries.
    get maximumSoundGapMs(): number {
        let maximum = 0;
        for (let index = 1; index < this._productionSamples.length; index++) {
            maximum = Math.max(
                maximum,
                this._productionSamples[index]!.timeMs - this._productionSamples[index - 1]!.timeMs,
            );
        }
        return maximum;
    }

    // GETTER :: VOID -> psxPerformanceTiming?
    // Returns the latest worker-stage timing window exposed by the concrete session.
    get workerPerformance(): PsxPerformanceTiming | null {
        return this._session.performance ?? null;
    }

    // SETTER :: NUMBER -> VOID
    // Sets normalized output volume and updates an existing gain stage.
    set volume(value: number) {
        this._assertLive();
        if (!Number.isFinite(value) || value < 0 || value > 1) throw invalid(value);
        this._volume = value;
        if (this._volumeGain !== null) this._volumeGain.gain.value = value;
    }

    // SETTER :: psxAudioBufferMode -> VOID
    // Changes future dry-timeline scheduling and restarts Adaptive in low-latency mode.
    set bufferMode(value: PsxAudioBufferMode) {
        this._assertLive();
        if (!isPsxAudioBufferMode(value)) throw invalid(value);
        if (value === this._bufferMode) return;
        this._bufferMode = value;
        this._adaptiveRecovery = false;
        this._workletNode?.port.postMessage({ type: "configure", mode: value });
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
        const worklet = this._ensureWorklet(context);
        if (context.state !== "running") {
            try {
                await context.resume();
            } catch (error) {
                throw audioFailed("The audio context could not be resumed.", error);
            }
        }
        await worklet;
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
        this._resetOutputQueue();
        this._lastSoundMs = null;
        this._productionSamples = [];
    }

    // METHOD :: VOID -> VOID
    // Unsubscribes, cancels playback, and closes the device context.
    destroy(): void {
        if (this._destroyed) return;
        this._unsubscribeSound();
        this._armed?.();
        this._workletNode?.port.close();
        try { this._workletNode?.disconnect(); } catch { /* context close remains authoritative */ }
        this._workletNode = null;
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

    // METHOD :: psxAudioContextLike -> PROMISE(VOID)
    // Loads and connects the persistent rendering-thread source when the browser supports it.
    private _ensureWorklet(context: PsxAudioContextLike): Promise<void> {
        if (this._workletInitialization !== null) return this._workletInitialization;
        const loader = context.audioWorklet;
        const factory = this._createAudioWorkletNode;
        const moduleUrl = this._audioWorkletModuleUrl;
        if (loader === undefined || factory === null || moduleUrl === null) return Promise.resolve();
        this._workletLoading = true;
        this._workletInitialization = (async (): Promise<void> => {
            let node: PsxAudioWorkletNodeLike | null = null;
            try {
                await loader.addModule(moduleUrl);
                if (this._destroyed) return;
                node = factory(context, "psx-audio-ring");
                if (!isPsxAudioWorkletNodeLike(node)) throw new TypeError("Invalid AudioWorkletNode boundary.");
                const gain = this._muteGain;
                if (gain === null) throw new TypeError("Audio gain graph is unavailable.");
                node.port.onmessage = (event): void => this._receiveWorkletStatistics(event.data);
                node.connect(gain);
                this._workletDroppedSampleBase = this._droppedSamples;
                this._workletUnderrunBase = this._underrunCount;
                this._workletNode = node;
                this._backend = "worklet";
                node.port.postMessage({ type: "configure", mode: this._bufferMode });
            } catch {
                node?.port.close();
                try { node?.disconnect(); } catch { /* fallback scheduling remains available */ }
                this._workletNode = null;
                this._backend = "scheduled";
            } finally {
                this._workletLoading = false;
                this._flush();
            }
        })();
        return this._workletInitialization;
    }

    // METHOD :: UNKNOWN -> VOID
    // Synchronizes rendering-thread queue depth and cumulative diagnostics.
    private _receiveWorkletStatistics(message: unknown): void {
        if (!isWorkletStatistics(message)) return;
        this._workletQueuedFrames = message.queuedFrames;
        this._underrunCount = this._workletUnderrunBase + message.underruns;
        this._droppedSamples = this._workletDroppedSampleBase + message.droppedFrames * 2;
        this._workletStarvationFrames = message.starvationFrames;
        this._workletLongestStarvationFrames = message.longestStarvationFrames;
        this._adaptiveRecovery = this._bufferMode === "adaptive" && message.adaptiveRecovery;
    }

    // METHOD :: BOOLEAN? -> VOID
    // Clears pending, scheduled, and rendering-thread PCM without resetting diagnostics.
    private _resetOutputQueue(preserveScheduledContinuity = false): void {
        this._workletNode?.port.postMessage({ type: "reset" });
        this._workletQueuedFrames = 0;
        this._cancelScheduled();
        this._pending = [];
        this._pendingFrames = 0;
        this._restartTrimmed = false;
        if (!preserveScheduledContinuity) this._hasScheduledAudio = false;
    }

    // METHOD :: psxSoundEvent -> VOID
    // Deinterleaves, caps, queues, and attempts to schedule one core audio event.
    private _enqueue(sound: PsxSoundEvent): void {
        if (this._destroyed || !isPsxSoundEvent(sound) || sound.frames === 0) return;
        const now = this._nowMs();
        this._recordProduction(now, sound.frames);
        if (sound.transport !== undefined) {
            this._transportSamples++;
            this._productionToPostMilliseconds += sound.transport.productionToPostMs;
            this._postToReceiptMilliseconds += sound.transport.postToReceiptMs;
            this._transportMilliseconds += sound.transport.productionToReceiptMs;
            this._transportMaximumMs = Math.max(
                this._transportMaximumMs,
                sound.transport.productionToReceiptMs,
            );
        }
        if (this._lastSoundMs !== null && now - this._lastSoundMs > PsxAudio.TIMING_GAP_MS) {
            this._resetOutputQueue(true);
        }
        this._lastSoundMs = now;
        const [left, right] = deinterleavePsxStereo(sound.samples);
        const rate = this._session.machine.sampleRate;
        let incomingOffset = 0;
        if (this._workletNode === null) {
            this._prunePlayed();
            const decision = psxAudioQueueCapDecision(
                this.queuedMs,
                sound.frames,
                rate,
                PsxAudio.MAX_QUEUE_MS,
                PsxAudio.TRIM_QUEUE_MS,
            );
            if (decision.dropQueuedFrames > 0) this._dropQueuedFrames(decision.dropQueuedFrames);
            this._droppedSamples += (decision.dropQueuedFrames + decision.dropIncomingFrames) * 2;
            incomingOffset = decision.dropIncomingFrames;
        }
        if (incomingOffset < sound.frames) {
            const offset = incomingOffset;
            const chunk = offset === 0
                ? { left, right }
                : { left: left.subarray(offset), right: right.subarray(offset) };
            this._pending.push(chunk);
            this._pendingFrames += chunk.left.length;
        }
        this._flush();
    }

    // METHOD :: NUMBER, NUMBER -> VOID
    // Retains enough recent deliveries to calculate rolling source throughput and delivery gaps.
    private _recordProduction(timeMs: number, frames: number): void {
        if (!Number.isFinite(timeMs) || timeMs < 0) return;
        this._productionSamples.push({ timeMs, frames });
        const cutoff = timeMs - PsxAudio.PRODUCTION_WINDOW_MS;
        while (this._productionSamples.length > 2 && this._productionSamples[1]!.timeMs < cutoff) {
            this._productionSamples.shift();
        }
    }

    // METHOD :: VOID -> VOID
    // Combines pending frames into one device buffer when scheduling is ready.
    private _flush(): void {
        const context = this._context;
        const gain = this._muteGain;
        const rate = this._session.machine.sampleRate;
        if (this._destroyed || this._workletLoading || context?.state !== "running" || gain === null) return;
        if (this._workletNode !== null) {
            if (this._pendingFrames === 0) return;
            const [left, right] = combineStereoChunks(this._pending, this._pendingFrames);
            this._pending = [];
            this._pendingFrames = 0;
            this._restartTrimmed = false;
            this._workletNode.port.postMessage(
                { type: "push", left, right },
                [left.buffer, right.buffer],
            );
            return;
        }
        if (this._pendingFrames / rate * 1000 < PsxAudio.MIN_CHUNK_MS) return;
        const [left, right] = combineStereoChunks(this._pending, this._pendingFrames);
        let source: PsxAudioBufferSourceLike | null = null;
        let scheduled: ScheduledChunk | null = null;
        try {
            const buffer = context.createBuffer(2, this._pendingFrames, rate);
            buffer.getChannelData(0).set(left);
            buffer.getChannelData(1).set(right);
            source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(gain);
            const ranDry = this._hasScheduledAudio && !this._restartTrimmed
                && this._nextStartTime <= context.currentTime;
            if (ranDry) {
                this._underrunCount++;
                if (this._bufferMode === "adaptive") this._adaptiveRecovery = true;
            }
            const lead = this._restartTrimmed
                ? 0
                : audioBufferLeadSeconds(this._bufferMode, this._adaptiveRecovery);
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
            this._hasScheduledAudio = true;
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
        const suppliedWorkletFactory = config.createAudioWorkletNode;
        const suppliedWorkletModuleUrl = config.audioWorkletModuleUrl;
        if ((suppliedWorkletFactory === undefined) !== (suppliedWorkletModuleUrl === undefined)) {
            throw invalid(config);
        }
        const AudioWorkletNodeImplementation = globalThis.AudioWorkletNode;
        const browserWorklet = typeof AudioWorkletNodeImplementation === "function"
            ? {
                createAudioWorkletNode: ((context, processorName) => new AudioWorkletNodeImplementation(
                    context as unknown as BaseAudioContext,
                    processorName,
                    {
                        numberOfInputs: 0,
                        numberOfOutputs: 1,
                        outputChannelCount: [2],
                        channelCount: 2,
                        channelCountMode: "explicit",
                    },
                ) as unknown as PsxAudioWorkletNodeLike) satisfies PsxAudioWorkletNodeFactory,
                audioWorkletModuleUrl: new URL("./PsxAudioWorklet.js", import.meta.url).href,
            }
            : {};
        return new PsxAudio({
            ...config,
            clock: config.clock ?? (() => performance.now()),
            createAudioContext,
            ...(suppliedWorkletFactory === undefined ? browserWorklet : {
                createAudioWorkletNode: suppliedWorkletFactory,
                audioWorkletModuleUrl: suppliedWorkletModuleUrl!,
            }),
        });
    }
}

/**
 *
 *  Helper Functions
 *
 */

// HELPER :: [stereoChunk], NUMBER -> [float32Array, float32Array]
// Combines ordered pending chunks into exact transferable channel buffers.
const combineStereoChunks = (
    chunks: ReadonlyArray<StereoChunk>,
    frames: number,
): readonly [Float32Array, Float32Array] => {
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    let offset = 0;
    chunks.forEach((chunk) => {
        left.set(chunk.left, offset);
        right.set(chunk.right, offset);
        offset += chunk.left.length;
    });
    return [left, right];
};

// HELPER :: UNKNOWN -> BOOLEAN
// True when value is one coherent rendering-thread statistics message.
const isWorkletStatistics = (value: unknown): value is WorkletStatistics => {
    if (typeof value !== "object" || value === null) return false;
    const message = value as Partial<WorkletStatistics>;
    return message.type === "stats"
        && typeof message.queuedFrames === "number" && Number.isInteger(message.queuedFrames)
        && message.queuedFrames >= 0
        && typeof message.underruns === "number" && Number.isInteger(message.underruns)
        && message.underruns >= 0
        && typeof message.droppedFrames === "number" && Number.isInteger(message.droppedFrames)
        && message.droppedFrames >= 0
        && typeof message.starvationFrames === "number" && Number.isInteger(message.starvationFrames)
        && message.starvationFrames >= 0
        && typeof message.longestStarvationFrames === "number" && Number.isInteger(message.longestStarvationFrames)
        && message.longestStarvationFrames >= 0
        && message.longestStarvationFrames <= message.starvationFrames
        && typeof message.adaptiveRecovery === "boolean"
        && typeof message.consumptionRatio === "number" && message.consumptionRatio === 1;
};

// HELPER :: psxAudioBufferMode, BOOLEAN -> NUMBER
// Resolves the dry-timeline lead in seconds for one scheduling strategy and recovery state.
const audioBufferLeadSeconds = (mode: PsxAudioBufferMode, adaptiveRecovery: boolean): number =>
    mode === "stable" || (mode === "adaptive" && adaptiveRecovery)
        ? PsxAudio.STABLE_LEAD_SECONDS
        : PsxAudio.LEAD_SECONDS;

// HELPER :: UNKNOWN -> psxRuntimeError
// Creates one invalid audio configuration or property error.
const invalid = (data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.INVALID_CONFIG,
    message: "PsxAudio config is invalid.",
    data,
});

// HELPER :: STRING, UNKNOWN? -> psxRuntimeError
// Creates one Web Audio construction, resume, or scheduling error.
const audioFailed = (message: string, data?: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.AUDIO_FAILED,
    message,
    data,
});
