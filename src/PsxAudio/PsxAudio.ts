import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";
import { isPsxSession, isPsxSoundEvent } from "../shared.types.js";
import {
    deinterleavePsxStereo,
    isPsxAudioConfig,
    isPsxAudioContextLike,
    isPsxGestureSourceLike,
    psxAudioQueueCapDecision,
} from "./types.js";

import type { PsxSoundEvent, Unsubscribe } from "../shared.types.js";
import type {
    PsxAudioBufferSourceLike,
    PsxAudioConfig,
    PsxAudioContextLike,
    PsxAudioContextFactory,
    PsxGainNodeLike,
    PsxGestureSourceLike,
} from "./types.js";

interface StereoChunk {
    readonly left: Float32Array;
    readonly right: Float32Array;
}

interface ScheduledChunk extends StereoChunk {
    readonly source: PsxAudioBufferSourceLike;
    readonly frames: number;
    readonly sampleRate: number;
    readonly startTime: number;
}

const invalid = (data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.INVALID_CONFIG,
    message: "PsxAudio config is invalid.",
    data,
});

const audioFailed = (message: string, data?: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.AUDIO_FAILED,
    message,
    data,
});

export default class PsxAudio {
    static readonly GESTURE_EVENTS = Object.freeze(["pointerdown", "keydown", "touchend"]);
    static readonly MAX_QUEUE_MS = 120;
    static readonly TRIM_QUEUE_MS = 60;
    static readonly MIN_CHUNK_MS = 16;
    static readonly LEAD_SECONDS = 0.02;
    static readonly TIMING_GAP_MS = 250;

    readonly #session: PsxAudioConfig["session"];
    readonly #gestureSource: PsxGestureSourceLike;
    readonly #createAudioContext: PsxAudioContextFactory;
    readonly #clock: (() => number) | null;
    readonly #unsubscribeSound: Unsubscribe;
    #context: PsxAudioContextLike | null = null;
    #muteGain: PsxGainNodeLike | null = null;
    #volumeGain: PsxGainNodeLike | null = null;
    #pending: StereoChunk[] = [];
    #pendingFrames = 0;
    #scheduled: ScheduledChunk[] = [];
    #nextStartTime = 0;
    #restartTrimmed = false;
    #droppedSamples = 0;
    #armed: Unsubscribe | null = null;
    #muted = false;
    #volume: number;
    #lastSoundMs: number | null = null;
    #destroyed = false;

    constructor(config: PsxAudioConfig) {
        if (!isPsxAudioConfig(config)) throw invalid(config);
        this.#session = config.session;
        this.#gestureSource = config.gestureSource;
        this.#createAudioContext = config.createAudioContext;
        this.#clock = config.clock ?? null;
        this.#volume = config.volume ?? 1;
        this.#unsubscribeSound = config.session.onSound((sound) => this.#enqueue(sound));
    }

    get isUnlocked(): boolean { return this.#context?.state === "running"; }
    get isMuted(): boolean { return this.#muted; }
    get volume(): number { return this.#volume; }
    get deviceSampleRate(): number | null { return this.#context?.sampleRate ?? null; }
    get droppedSamples(): number { return this.#droppedSamples; }

    get queuedMs(): number {
        const context = this.#context;
        const rate = this.#session.machine.sampleRate;
        let milliseconds = this.#pendingFrames / rate * 1000;
        if (context === null) return milliseconds;
        for (const chunk of this.#scheduled) {
            milliseconds += PsxAudio.remainingFrames(chunk, context.currentTime) / chunk.sampleRate * 1000;
        }
        return milliseconds;
    }

    set volume(value: number) {
        this.#assertLive();
        if (!Number.isFinite(value) || value < 0 || value > 1) throw invalid(value);
        this.#volume = value;
        if (this.#volumeGain !== null) this.#volumeGain.gain.value = value;
    }

    async unlock(): Promise<void> {
        this.#assertLive();
        const context = this.#ensureContext();
        if (context.state !== "running") {
            try {
                await context.resume();
            } catch (error) {
                throw audioFailed("The audio context could not be resumed.", error);
            }
        }
        this.#lastSoundMs = this.#nowMs();
        this.#flush();
    }

    armGestureUnlock(): Unsubscribe {
        this.#assertLive();
        if (this.#armed !== null) return this.#armed;
        const listener = (): void => { void this.unlock().then(remove, () => undefined); };
        const remove = (): void => {
            PsxAudio.GESTURE_EVENTS.forEach((type) => this.#gestureSource.removeEventListener(type, listener));
            this.#armed = null;
        };
        PsxAudio.GESTURE_EVENTS.forEach((type) => {
            this.#gestureSource.addEventListener(type, listener, { passive: true });
        });
        this.#armed = remove;
        return remove;
    }

    mute(): void {
        this.#assertLive();
        this.#muted = true;
        if (this.#muteGain !== null) this.#muteGain.gain.value = 0;
    }

    unmute(): void {
        this.#assertLive();
        this.#muted = false;
        if (this.#muteGain !== null) this.#muteGain.gain.value = 1;
    }

    resetQueue(): void {
        this.#assertLive();
        this.#cancelScheduled();
        this.#pending = [];
        this.#pendingFrames = 0;
        this.#restartTrimmed = false;
        this.#lastSoundMs = null;
    }

    destroy(): void {
        if (this.#destroyed) return;
        this.#unsubscribeSound();
        this.#armed?.();
        this.#cancelScheduled();
        this.#pending = [];
        this.#pendingFrames = 0;
        const context = this.#context;
        this.#context = null;
        this.#destroyed = true;
        if (context !== null) {
            try { void context.close().catch(() => undefined); } catch { /* close is best effort */ }
        }
    }

    #ensureContext(): PsxAudioContextLike {
        if (this.#context !== null) return this.#context;
        let context: PsxAudioContextLike | null = null;
        try {
            context = this.#createAudioContext({ sampleRate: this.#session.machine.sampleRate });
            if (!isPsxAudioContextLike(context)) throw new TypeError("Invalid AudioContext boundary.");
            const muteGain = context.createGain();
            const volumeGain = context.createGain();
            muteGain.gain.value = this.#muted ? 0 : 1;
            volumeGain.gain.value = this.#volume;
            muteGain.connect(volumeGain);
            volumeGain.connect(context.destination);
            this.#muteGain = muteGain;
            this.#volumeGain = volumeGain;
        } catch (error) {
            if (context !== null) {
                try { void context.close().catch(() => undefined); } catch { /* cleanup is best effort */ }
            }
            throw audioFailed("The audio context could not be created.", error);
        }
        this.#context = context;
        return context;
    }

    #enqueue(sound: PsxSoundEvent): void {
        if (this.#destroyed || !isPsxSoundEvent(sound) || sound.frames === 0) return;
        const now = this.#nowMs();
        if (this.#lastSoundMs !== null && now - this.#lastSoundMs > PsxAudio.TIMING_GAP_MS) {
            this.#cancelScheduled();
            this.#pending = [];
            this.#pendingFrames = 0;
            this.#restartTrimmed = false;
        }
        this.#lastSoundMs = now;
        this.#prunePlayed();
        const [left, right] = deinterleavePsxStereo(sound.samples);
        const rate = this.#session.machine.sampleRate;
        const decision = psxAudioQueueCapDecision(
            this.queuedMs,
            sound.frames,
            rate,
            PsxAudio.MAX_QUEUE_MS,
            PsxAudio.TRIM_QUEUE_MS,
        );
        if (decision.dropQueuedFrames > 0) this.#dropQueuedFrames(decision.dropQueuedFrames);
        this.#droppedSamples += (decision.dropQueuedFrames + decision.dropIncomingFrames) * 2;
        if (decision.dropIncomingFrames < sound.frames) {
            const offset = decision.dropIncomingFrames;
            const chunk = offset === 0
                ? { left, right }
                : { left: left.subarray(offset), right: right.subarray(offset) };
            this.#pending.push(chunk);
            this.#pendingFrames += chunk.left.length;
        }
        this.#flush();
    }

    #flush(): void {
        const context = this.#context;
        const gain = this.#muteGain;
        const rate = this.#session.machine.sampleRate;
        if (this.#destroyed || context?.state !== "running" || gain === null
            || this.#pendingFrames / rate * 1000 < PsxAudio.MIN_CHUNK_MS) return;
        const left = new Float32Array(this.#pendingFrames);
        const right = new Float32Array(this.#pendingFrames);
        let offset = 0;
        this.#pending.forEach((chunk) => {
            left.set(chunk.left, offset);
            right.set(chunk.right, offset);
            offset += chunk.left.length;
        });
        let source: PsxAudioBufferSourceLike | null = null;
        let scheduled: ScheduledChunk | null = null;
        try {
            const buffer = context.createBuffer(2, this.#pendingFrames, rate);
            buffer.getChannelData(0).set(left);
            buffer.getChannelData(1).set(right);
            source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(gain);
            const lead = this.#restartTrimmed ? 0 : PsxAudio.LEAD_SECONDS;
            const startTime = this.#nextStartTime > context.currentTime
                ? this.#nextStartTime
                : context.currentTime + lead;
            scheduled = {
                left,
                right,
                source,
                frames: buffer.length,
                sampleRate: buffer.sampleRate,
                startTime,
            };
            source.onended = () => { if (scheduled !== null) this.#removeScheduled(scheduled); };
            this.#scheduled.push(scheduled);
            source.start(startTime);
            this.#nextStartTime = startTime + buffer.length / buffer.sampleRate;
        } catch (error) {
            if (scheduled !== null) this.#removeScheduled(scheduled);
            if (source !== null) {
                source.onended = null;
                try { source.stop(); } catch { /* source was not started */ }
            }
            throw audioFailed("An audio buffer could not be scheduled.", error);
        }
        this.#pending = [];
        this.#pendingFrames = 0;
        this.#restartTrimmed = false;
    }

    #dropQueuedFrames(count: number): void {
        const context = this.#context;
        const chunks: StereoChunk[] = [];
        if (context !== null) {
            for (const scheduled of this.#scheduled) {
                const remaining = PsxAudio.remainingFrames(scheduled, context.currentTime);
                if (remaining === 0) continue;
                const consumed = scheduled.frames - remaining;
                chunks.push({ left: scheduled.left.subarray(consumed), right: scheduled.right.subarray(consumed) });
            }
        }
        chunks.push(...this.#pending);
        this.#cancelScheduled();
        this.#pending = [];
        this.#pendingFrames = 0;
        this.#restartTrimmed = true;
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
            this.#pending.push(retained);
            this.#pendingFrames += retained.left.length;
        }
    }

    #prunePlayed(): void {
        const context = this.#context;
        if (context === null) return;
        this.#scheduled = this.#scheduled.filter((chunk) => {
            if (PsxAudio.remainingFrames(chunk, context.currentTime) > 0) return true;
            chunk.source.onended = null;
            return false;
        });
        this.#nextStartTime = this.#scheduled.reduce(
            (latest, chunk) => Math.max(latest, chunk.startTime + chunk.frames / chunk.sampleRate),
            0,
        );
    }

    #cancelScheduled(): void {
        const scheduled = this.#scheduled;
        this.#scheduled = [];
        this.#nextStartTime = 0;
        scheduled.forEach(({ source }) => {
            source.onended = null;
            try { source.stop(); } catch { /* source already stopped */ }
        });
    }

    #removeScheduled(chunk: ScheduledChunk): void {
        const index = this.#scheduled.indexOf(chunk);
        if (index >= 0) this.#scheduled.splice(index, 1);
        this.#nextStartTime = this.#scheduled.reduce(
            (latest, item) => Math.max(latest, item.startTime + item.frames / item.sampleRate),
            0,
        );
    }

    #nowMs(): number {
        if (this.#clock !== null) return this.#clock();
        return (this.#context?.currentTime ?? 0) * 1000;
    }

    #assertLive(): void {
        if (this.#destroyed) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "PsxAudio has been destroyed.",
        });
    }

    static remainingFrames(chunk: ScheduledChunk, now: number): number {
        if (now <= chunk.startTime) return chunk.frames;
        const played = Math.floor((now - chunk.startTime) * chunk.sampleRate + 1e-7);
        return Math.max(0, chunk.frames - played);
    }

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
