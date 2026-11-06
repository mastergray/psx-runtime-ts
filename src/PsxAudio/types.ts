// Dependencies:
import { isPsxSession } from "../shared.types.js";    // Validates the session supplying audio events

// Type dependencies:
import type { PsxSession } from "../shared.types.js"; // Session source composed with browser audio

/**
 *
 * Type Declarations
 *
 */

// TYPE :: "adaptive"|"low-latency"|"stable"
// Audio buffering strategy balancing latency and stall resilience.
export type PsxAudioBufferMode = "adaptive" | "low-latency" | "stable";

// TYPE :: "scheduled"|"worklet"
// Active browser-audio implementation selected from runtime capabilities.
export type PsxAudioBackend = "scheduled" | "worklet";

// INTERFACE :: {addEventListener:(STRING, (VOID -> VOID), {passive:BOOLEAN?}? -> VOID), removeEventListener:(STRING, (VOID -> VOID) -> VOID)}
// Browser gesture event boundary used to satisfy autoplay policy.
export interface PsxGestureSourceLike {
    addEventListener(type: string, listener: () => void, options?: { readonly passive?: boolean }): void; // Installs one authorization listener
    removeEventListener(type: string, listener: () => void): void;                                          // Removes one authorization listener
}

// INTERFACE :: {value:NUMBER}
// Mutable scalar parameter used by Web Audio gain nodes.
export interface PsxAudioParamLike {
    value: number;    // Current gain value
}

// INTERFACE :: {connect:(psxAudioNodeLike -> UNKNOWN)}
// Minimal connectable Web Audio graph node.
export interface PsxAudioNodeLike {
    connect(destination: PsxAudioNodeLike): unknown;    // Connects output to the next graph node
}

// INTERFACE :: {addModule:(STRING -> PROMISE(VOID))}
// Secure-context module loader exposed by a Web Audio context.
export interface PsxAudioWorkletLike {
    addModule(moduleUrl: string): Promise<void>;    // Loads one processor module into the audio rendering scope
}

// INTERFACE :: {onmessage:((messageEvent<UNKNOWN> -> VOID))?, postMessage:(UNKNOWN, [transferable]? -> VOID), close:(VOID -> VOID)}
// Message boundary connecting PsxAudio to its rendering-thread processor.
export interface PsxAudioMessagePortLike {
    onmessage: ((event: MessageEvent<unknown>) => void) | null;           // Receives queue statistics from the processor
    postMessage(message: unknown, transfer?: Transferable[]): void;      // Transfers PCM or control messages to the processor
    close(): void;                                                       // Releases the control-side message endpoint
}

// INTERFACE :: psxAudioNodeLike & {port:psxAudioMessagePortLike, disconnect:(VOID -> UNKNOWN)}
// Persistent stereo source node backed by an AudioWorkletProcessor.
export interface PsxAudioWorkletNodeLike extends PsxAudioNodeLike {
    readonly port: PsxAudioMessagePortLike;    // Processor control and PCM transfer channel
    disconnect(): unknown;                    // Removes the node from the output graph
}

// INTERFACE :: psxAudioNodeLike & {gain:psxAudioParamLike}
// Gain node used for independent mute and volume stages.
export interface PsxGainNodeLike extends PsxAudioNodeLike {
    readonly gain: PsxAudioParamLike;    // Mutable scalar gain parameter
}

// INTERFACE :: {length:NUMBER, sampleRate:NUMBER, getChannelData:(NUMBER -> float32Array)}
// Writable stereo buffer scheduled on the device timeline.
export interface PsxAudioBufferLike {
    readonly length: number;                           // Frames allocated per channel
    readonly sampleRate: number;                       // Device playback rate
    getChannelData(channel: number): Float32Array;     // Writable samples for one channel
}

// INTERFACE :: psxAudioNodeLike & {buffer:psxAudioBufferLike?, onended:(VOID -> VOID)?, start:(NUMBER? -> VOID), stop:(VOID -> VOID)}
// Schedulable source node owning one audio buffer.
export interface PsxAudioBufferSourceLike extends PsxAudioNodeLike {
    buffer: PsxAudioBufferLike | null;    // Buffer played by this source
    onended: (() => void) | null;         // Completion callback used for queue cleanup
    start(when?: number): void;           // Schedules playback on the context timeline
    stop(): void;                         // Cancels playback
}

// INTERFACE :: Web Audio context operations required by PsxAudio
// Minimal device context boundary supporting graph creation and scheduling.
export interface PsxAudioContextLike {
    readonly state: "suspended" | "running" | "closed" | "interrupted"; // Current device lifecycle state
    readonly sampleRate: number;                                          // Realized device sample rate
    readonly currentTime: number;                                         // Monotonic scheduling time in seconds
    readonly destination: PsxAudioNodeLike;                               // Device output node
    readonly audioWorklet?: PsxAudioWorkletLike;                          // Secure-context processor loader when supported
    resume(): Promise<void>;                                              // Requests active playback
    close(): Promise<void>;                                               // Releases device resources
    createBuffer(channels: number, length: number, sampleRate: number): PsxAudioBufferLike; // Allocates channel storage
    createBufferSource(): PsxAudioBufferSourceLike;                       // Creates one schedulable source
    createGain(): PsxGainNodeLike;                                        // Creates one scalar gain stage
}

// TYPE :: {sampleRate:NUMBER} -> psxAudioContextLike
// Injectable context constructor receiving the core's native sample rate.
export type PsxAudioContextFactory = (options: { readonly sampleRate: number }) => PsxAudioContextLike;

// TYPE :: psxAudioContextLike, STRING -> psxAudioWorkletNodeLike
// Injectable constructor for the persistent stereo AudioWorklet source.
export type PsxAudioWorkletNodeFactory = (
    context: PsxAudioContextLike,
    processorName: string,
) => PsxAudioWorkletNodeLike;

// INTERFACE :: {session:psxSession, gestureSource:psxGestureSourceLike, createAudioContext:psxAudioContextFactory, createAudioWorkletNode:psxAudioWorkletNodeFactory?, audioWorkletModuleUrl:STRING?, volume:NUMBER?, bufferMode:psxAudioBufferMode?, clock:(VOID -> NUMBER)?}
// Dependencies and initial options for browser audio output.
export interface PsxAudioConfig {
    readonly session: PsxSession;                                  // Active session producing sound events
    readonly gestureSource: PsxGestureSourceLike;                   // Event source authorizing playback
    readonly createAudioContext: PsxAudioContextFactory;            // Context construction boundary
    readonly createAudioWorkletNode?: PsxAudioWorkletNodeFactory;   // Optional persistent-node constructor paired with its module URL
    readonly audioWorkletModuleUrl?: string;                        // Compiled processor module paired with its node constructor
    readonly volume?: number;                                      // Initial normalized gain; defaults to one
    readonly bufferMode?: PsxAudioBufferMode;                       // Scheduling strategy; defaults to adaptive
    readonly clock?: () => number;                                 // Optional millisecond clock for gap detection
}

// INTERFACE :: {dropQueuedFrames:NUMBER, dropIncomingFrames:NUMBER}
// Deterministic latency-cap decision split between old and new audio.
export interface PsxAudioQueueCapDecision {
    readonly dropQueuedFrames: number;      // Oldest unplayed frames removed from the queue
    readonly dropIncomingFrames: number;    // Leading frames removed from the arriving chunk
}

/**
 *
 * Type Predicates
 *
 */

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a non-null object suitable for structural inspection.
const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a finite number.
const isFiniteNumber = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value names one supported audio scheduling strategy.
export function isPsxAudioBufferMode(value: unknown): value is PsxAudioBufferMode {
    return value === "adaptive" || value === "low-latency" || value === "stable";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value supplies gesture listener installation and removal.
export function isPsxGestureSourceLike(value: unknown): value is PsxGestureSourceLike {
    return isObject(value) && typeof value.addEventListener === "function"
        && typeof value.removeEventListener === "function";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value exposes a coherent minimal Web Audio context surface.
export function isPsxAudioContextLike(value: unknown): value is PsxAudioContextLike {
    return isObject(value)
        && (value.state === "suspended" || value.state === "running"
            || value.state === "closed" || value.state === "interrupted")
        && isFiniteNumber(value.sampleRate) && value.sampleRate > 0
        && isFiniteNumber(value.currentTime) && value.currentTime >= 0
        && isObject(value.destination) && typeof value.resume === "function"
        && typeof value.close === "function" && typeof value.createBuffer === "function"
        && typeof value.createBufferSource === "function" && typeof value.createGain === "function"
        && (value.audioWorklet === undefined
            || (isObject(value.audioWorklet) && typeof value.audioWorklet.addModule === "function"));
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value exposes a connectable AudioWorklet node and message port.
export function isPsxAudioWorkletNodeLike(value: unknown): value is PsxAudioWorkletNodeLike {
    return isObject(value) && typeof value.connect === "function" && typeof value.disconnect === "function"
        && isObject(value.port) && typeof value.port.postMessage === "function"
        && typeof value.port.close === "function";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value supplies a session, gesture source, context factory, and bounded options.
export function isPsxAudioConfig(value: unknown): value is PsxAudioConfig {
    return isObject(value) && isPsxSession(value.session)
        && isPsxGestureSourceLike(value.gestureSource)
        && typeof value.createAudioContext === "function"
        && ((value.createAudioWorkletNode === undefined && value.audioWorkletModuleUrl === undefined)
            || (typeof value.createAudioWorkletNode === "function"
                && typeof value.audioWorkletModuleUrl === "string"
                && value.audioWorkletModuleUrl.length > 0))
        && (value.volume === undefined
            || (isFiniteNumber(value.volume) && value.volume >= 0 && value.volume <= 1))
        && (value.bufferMode === undefined || isPsxAudioBufferMode(value.bufferMode))
        && (value.clock === undefined || typeof value.clock === "function");
}

/**
 *
 *  Helper Functions
 *
 */

// HELPER :: float32Array -> [float32Array, float32Array]
// Splits interleaved stereo frames into independent left and right channels.
export function deinterleavePsxStereo(
    samples: Float32Array,
): readonly [Float32Array, Float32Array] {
    const frames = Math.floor(samples.length / 2);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let index = 0; index < frames; index++) {
        left[index] = samples[index * 2] ?? 0;
        right[index] = samples[index * 2 + 1] ?? 0;
    }
    return [left, right];
}

// HELPER :: NUMBER, NUMBER, NUMBER, NUMBER, NUMBER? -> psxAudioQueueCapDecision
// Calculates how many old and incoming frames must be discarded to enforce latency limits.
export function psxAudioQueueCapDecision(
    queuedMs: number,
    incomingFrames: number,
    sampleRate: number,
    maximumMs: number,
    trimMs: number = maximumMs,
): PsxAudioQueueCapDecision {
    const queuedFrames = Math.max(0, Math.round(queuedMs / 1000 * sampleRate));
    const capacityFrames = Math.max(0, Math.floor(maximumMs / 1000 * sampleRate));
    const trimFrames = Math.min(capacityFrames, Math.max(0, Math.floor(trimMs / 1000 * sampleRate)));
    const excess = queuedFrames + incomingFrames > capacityFrames
        ? queuedFrames + incomingFrames - trimFrames
        : 0;
    const dropQueuedFrames = Math.min(queuedFrames, excess);
    return Object.freeze({
        dropQueuedFrames,
        dropIncomingFrames: excess - dropQueuedFrames,
    });
}
