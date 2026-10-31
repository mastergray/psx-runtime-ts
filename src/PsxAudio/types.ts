import { isPsxSession } from "../shared.types.js";

import type { PsxSession } from "../shared.types.js";

export interface PsxGestureSourceLike {
    addEventListener(type: string, listener: () => void, options?: { readonly passive?: boolean }): void;
    removeEventListener(type: string, listener: () => void): void;
}

export interface PsxAudioParamLike {
    value: number;
}

export interface PsxAudioNodeLike {
    connect(destination: PsxAudioNodeLike): unknown;
}

export interface PsxGainNodeLike extends PsxAudioNodeLike {
    readonly gain: PsxAudioParamLike;
}

export interface PsxAudioBufferLike {
    readonly length: number;
    readonly sampleRate: number;
    getChannelData(channel: number): Float32Array;
}

export interface PsxAudioBufferSourceLike extends PsxAudioNodeLike {
    buffer: PsxAudioBufferLike | null;
    onended: (() => void) | null;
    start(when?: number): void;
    stop(): void;
}

export interface PsxAudioContextLike {
    readonly state: "suspended" | "running" | "closed" | "interrupted";
    readonly sampleRate: number;
    readonly currentTime: number;
    readonly destination: PsxAudioNodeLike;
    resume(): Promise<void>;
    close(): Promise<void>;
    createBuffer(channels: number, length: number, sampleRate: number): PsxAudioBufferLike;
    createBufferSource(): PsxAudioBufferSourceLike;
    createGain(): PsxGainNodeLike;
}

export type PsxAudioContextFactory = (options: { readonly sampleRate: number }) => PsxAudioContextLike;

export interface PsxAudioConfig {
    readonly session: PsxSession;
    readonly gestureSource: PsxGestureSourceLike;
    readonly createAudioContext: PsxAudioContextFactory;
    readonly volume?: number;
    readonly clock?: () => number;
}

export interface PsxAudioQueueCapDecision {
    readonly dropQueuedFrames: number;
    readonly dropIncomingFrames: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);

export function isPsxGestureSourceLike(value: unknown): value is PsxGestureSourceLike {
    return isObject(value) && typeof value.addEventListener === "function"
        && typeof value.removeEventListener === "function";
}

export function isPsxAudioContextLike(value: unknown): value is PsxAudioContextLike {
    return isObject(value)
        && (value.state === "suspended" || value.state === "running"
            || value.state === "closed" || value.state === "interrupted")
        && isFiniteNumber(value.sampleRate) && value.sampleRate > 0
        && isFiniteNumber(value.currentTime) && value.currentTime >= 0
        && isObject(value.destination) && typeof value.resume === "function"
        && typeof value.close === "function" && typeof value.createBuffer === "function"
        && typeof value.createBufferSource === "function" && typeof value.createGain === "function";
}

export function isPsxAudioConfig(value: unknown): value is PsxAudioConfig {
    return isObject(value) && isPsxSession(value.session)
        && isPsxGestureSourceLike(value.gestureSource)
        && typeof value.createAudioContext === "function"
        && (value.volume === undefined
            || (isFiniteNumber(value.volume) && value.volume >= 0 && value.volume <= 1))
        && (value.clock === undefined || typeof value.clock === "function");
}

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
