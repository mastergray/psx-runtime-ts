/**
 *
 * Type Declarations
 *
 */

// TYPE :: "adaptive"|"low-latency"|"stable"|"rate-matched"
// Rendering-thread scheduling strategy sent by PsxAudio.
type WorkletBufferMode = "adaptive" | "low-latency" | "stable" | "rate-matched";

// INTERFACE :: {type:"configure", mode:workletBufferMode}
// Updates the prebuffer target used after startup or starvation.
interface ConfigureMessage {
    readonly type: "configure";         // Control-message discriminator
    readonly mode: WorkletBufferMode;   // Requested latency-versus-stability strategy
}

// INTERFACE :: {type:"push", left:float32Array, right:float32Array}
// Transfers one deinterleaved stereo PCM chunk into the rendering-thread queue.
interface PushMessage {
    readonly type: "push";          // PCM-message discriminator
    readonly left: Float32Array;     // Left-channel frames at the context sample rate
    readonly right: Float32Array;    // Right-channel frames at the context sample rate
}

// INTERFACE :: {type:"reset"}
// Clears transient PCM without resetting cumulative diagnostics.
interface ResetMessage {
    readonly type: "reset";    // Reset-message discriminator
}

// INTERFACE :: {type:"rate", ratio:NUMBER}
// Updates the bounded source-frame consumption ratio used by mobile rate matching.
interface RateMessage {
    readonly type: "rate";      // Control-message discriminator
    readonly ratio: number;     // Source frames consumed per output frame
}

// TYPE :: configureMessage|pushMessage|resetMessage|rateMessage
// Complete control-side input accepted by the processor.
type WorkletInputMessage = ConfigureMessage | PushMessage | ResetMessage | RateMessage;

// INTERFACE :: {left:float32Array, right:float32Array, readIndex:NUMBER, size:NUMBER, phase:NUMBER, consumptionRatio:NUMBER, targetConsumptionRatio:NUMBER, started:BOOLEAN, mode:workletBufferMode, adaptiveRecovery:BOOLEAN, underruns:NUMBER, droppedFrames:NUMBER}
// Mutable bounded stereo ring and diagnostics owned by the rendering thread.
interface WorkletState {
    readonly left: Float32Array;          // Fixed-capacity left-channel ring
    readonly right: Float32Array;         // Fixed-capacity right-channel ring
    readIndex: number;                    // Oldest queued frame
    size: number;                         // Queued stereo frames
    phase: number;                        // Fractional position between the oldest and next source frame
    consumptionRatio: number;             // Smoothed source-frame consumption per output frame
    targetConsumptionRatio: number;       // Requested bounded consumption ratio
    started: boolean;                     // Whether prebuffering has completed
    mode: WorkletBufferMode;              // Current latency-versus-stability strategy
    adaptiveRecovery: boolean;            // Whether Adaptive has observed starvation
    underruns: number;                    // Cumulative contiguous starvation episodes
    droppedFrames: number;                // Cumulative frames discarded by the hard cap
}

// INTERFACE :: {port:messagePort}
// Minimal processor base exposed by the AudioWorklet global scope.
interface AudioWorkletProcessorLike {
    readonly port: MessagePort;    // Control and PCM transfer channel
}

declare const AudioWorkletProcessor: {
    new(options?: unknown): AudioWorkletProcessorLike;
};
declare const sampleRate: number;
declare function registerProcessor(
    name: string,
    constructor: new(options?: unknown) => AudioWorkletProcessorLike,
): void;

/**
 *
 * Class
 *
 */

// Renders a persistent bounded stereo ring without main-thread source scheduling.
class PsxAudioRingProcessor extends AudioWorkletProcessor {

    /* Instance Fields */
    private readonly _state = createWorkletState();    // Rendering-thread ring and cumulative diagnostics

    // CONSTRUCTOR :: UNKNOWN? -> psxAudioRingProcessor
    // Binds control messages to the processor-owned ring.
    constructor(options?: unknown) {
        super(options);
        this.port.onmessage = (event: MessageEvent<unknown>): void => {
            handleWorkletMessage(this._state, this.port, event.data);
        };
    }

    // METHOD :: [[[float32Array]]], [[float32Array]] -> BOOLEAN
    // Fills one render quantum and remains active for the context lifetime.
    process(
        _inputs: ReadonlyArray<ReadonlyArray<Float32Array>>,
        outputs: ReadonlyArray<ReadonlyArray<Float32Array>>,
    ): boolean {
        const output = outputs[0];
        const left = output?.[0];
        const right = output?.[1];
        if (left !== undefined && right !== undefined) renderQuantum(this._state, this.port, left, right);
        return true;
    }
}

/**
 *
 *  Helper Functions
 *
 */

const MAXIMUM_BUFFER_MS = 120;
const TRIM_BUFFER_MS = 60;
const LOW_LATENCY_TARGET_MS = 20;
const STABLE_TARGET_MS = 80;
const MINIMUM_CONSUMPTION_RATIO = 0.94;
const RATE_SMOOTHING_PER_FRAME = 0.0001;

// HELPER :: NUMBER -> NUMBER
// Converts milliseconds to whole rendering-context frames.
const framesForMilliseconds = (milliseconds: number): number =>
    Math.max(1, Math.round(milliseconds / 1000 * sampleRate));

// HELPER :: VOID -> workletState
// Allocates one fixed-capacity stereo ring using the realized context rate.
const createWorkletState = (): WorkletState => {
    const capacity = framesForMilliseconds(MAXIMUM_BUFFER_MS);
    return {
        left: new Float32Array(capacity),
        right: new Float32Array(capacity),
        readIndex: 0,
        size: 0,
        phase: 0,
        consumptionRatio: 1,
        targetConsumptionRatio: 1,
        started: false,
        mode: "adaptive",
        adaptiveRecovery: false,
        underruns: 0,
        droppedFrames: 0,
    };
};

// HELPER :: UNKNOWN -> BOOLEAN
// True when value names one supported rendering-thread buffer mode.
const isWorkletBufferMode = (value: unknown): value is WorkletBufferMode =>
    value === "adaptive" || value === "low-latency" || value === "stable" || value === "rate-matched";

// HELPER :: UNKNOWN -> BOOLEAN
// True when value is a non-null object suitable for message inspection.
const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

// HELPER :: workletState, messagePort, UNKNOWN -> VOID
// Applies one validated configuration, queue-reset, or PCM transfer message.
const handleWorkletMessage = (state: WorkletState, port: MessagePort, message: unknown): void => {
    if (!isObject(message) || typeof message.type !== "string") return;
    if (message.type === "configure" && isWorkletBufferMode(message.mode)) {
        state.mode = message.mode;
        state.adaptiveRecovery = false;
        state.started = false;
        state.phase = 0;
        state.consumptionRatio = 1;
        state.targetConsumptionRatio = 1;
        postStatistics(state, port);
        return;
    }
    if (message.type === "rate" && typeof message.ratio === "number" && Number.isFinite(message.ratio)) {
        state.targetConsumptionRatio = state.mode === "rate-matched"
            ? Math.max(MINIMUM_CONSUMPTION_RATIO, Math.min(1, message.ratio))
            : 1;
        postStatistics(state, port);
        return;
    }
    if (message.type === "reset") {
        clearQueue(state);
        postStatistics(state, port);
        return;
    }
    if (message.type === "push" && message.left instanceof Float32Array
        && message.right instanceof Float32Array && message.left.length === message.right.length) {
        pushFrames(state, message.left, message.right);
        postStatistics(state, port);
    }
};

// HELPER :: workletState -> NUMBER
// Returns the prebuffer target for the active strategy and recovery state.
const targetFrames = (state: WorkletState): number =>
    state.mode === "stable" || state.mode === "rate-matched"
        || (state.mode === "adaptive" && state.adaptiveRecovery)
        ? framesForMilliseconds(STABLE_TARGET_MS)
        : framesForMilliseconds(LOW_LATENCY_TARGET_MS);

// HELPER :: workletState, float32Array, float32Array -> VOID
// Appends stereo frames while trimming the oldest latency on overflow.
const pushFrames = (state: WorkletState, left: Float32Array, right: Float32Array): void => {
    let offset = 0;
    if (state.size + left.length > state.left.length) {
        let excess = state.size + left.length - framesForMilliseconds(TRIM_BUFFER_MS);
        const queuedDrop = Math.min(state.size, excess);
        discardFrames(state, queuedDrop);
        excess -= queuedDrop;
        offset = Math.min(left.length, excess);
        state.droppedFrames += queuedDrop + offset;
    }
    for (let index = offset; index < left.length && state.size < state.left.length; index++) {
        const writeIndex = (state.readIndex + state.size) % state.left.length;
        state.left[writeIndex] = left[index] ?? 0;
        state.right[writeIndex] = right[index] ?? 0;
        state.size++;
    }
};

// HELPER :: workletState, NUMBER -> VOID
// Discards up to count oldest queued frames.
const discardFrames = (state: WorkletState, count: number): void => {
    const discarded = Math.min(state.size, Math.max(0, count));
    state.readIndex = (state.readIndex + discarded) % state.left.length;
    state.size -= discarded;
    if (discarded > 0) state.phase = 0;
};

// HELPER :: workletState -> VOID
// Clears transient PCM and returns output to prebuffering.
const clearQueue = (state: WorkletState): void => {
    state.readIndex = 0;
    state.size = 0;
    state.phase = 0;
    state.started = false;
};

// HELPER :: workletState, messagePort, float32Array, float32Array -> VOID
// Renders available stereo frames, outputting silence while prebuffering or starved.
const renderQuantum = (
    state: WorkletState,
    port: MessagePort,
    left: Float32Array,
    right: Float32Array,
): void => {
    left.fill(0);
    right.fill(0);
    if (!state.started && state.size >= targetFrames(state)) state.started = true;
    if (!state.started) return;
    let rendered = 0;
    for (; rendered < left.length && state.size > 0; rendered++) {
        const nextIndex = state.size > 1
            ? (state.readIndex + 1) % state.left.length
            : state.readIndex;
        const leftCurrent = state.left[state.readIndex] ?? 0;
        const rightCurrent = state.right[state.readIndex] ?? 0;
        left[rendered] = leftCurrent + ((state.left[nextIndex] ?? leftCurrent) - leftCurrent) * state.phase;
        right[rendered] = rightCurrent + ((state.right[nextIndex] ?? rightCurrent) - rightCurrent) * state.phase;
        state.consumptionRatio += (state.targetConsumptionRatio - state.consumptionRatio)
            * RATE_SMOOTHING_PER_FRAME;
        state.phase += state.consumptionRatio;
        if (state.phase >= 1) {
            state.phase -= 1;
            state.readIndex = (state.readIndex + 1) % state.left.length;
            state.size--;
        }
    }
    if (rendered === left.length) return;
    state.underruns++;
    if (state.mode === "adaptive") state.adaptiveRecovery = true;
    state.started = false;
    state.phase = 0;
    postStatistics(state, port);
};

// HELPER :: workletState, messagePort -> VOID
// Reports queue depth and cumulative rendering diagnostics to PsxAudio.
const postStatistics = (state: WorkletState, port: MessagePort): void => {
    port.postMessage({
        type: "stats",
        queuedFrames: state.size,
        underruns: state.underruns,
        droppedFrames: state.droppedFrames,
        adaptiveRecovery: state.adaptiveRecovery,
        consumptionRatio: state.consumptionRatio,
    });
};

registerProcessor("psx-audio-ring", PsxAudioRingProcessor);

export {};
