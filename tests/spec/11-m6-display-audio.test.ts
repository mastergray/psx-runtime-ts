import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";
import {
    deinterleavePsxStereo,
    isPsxAudioBufferMode,
    isPsxAudioConfig,
    isPsxDisplayConfig,
    PsxAudio,
    PsxDisplay,
    psxAudioQueueCapDecision,
} from "../../src/index.ts";

import type {
    Listener,
    PsxAudioBufferLike,
    PsxAudioBufferSourceLike,
    PsxAudioContextLike,
    PsxAudioMessagePortLike,
    PsxAudioNodeLike,
    PsxAudioWorkletLike,
    PsxAudioWorkletNodeLike,
    PsxCanvasContextLike,
    PsxFrameEvent,
    PsxGainNodeLike,
    PsxImageDataLike,
    PsxMachineInfo,
    PsxRumbleEvent,
    PsxSession,
    PsxSoundEvent,
    Unsubscribe,
} from "../../src/index.ts";
import type { TestFile } from "../run.ts";

const machine: PsxMachineInfo = {
    core: "Synthetic",
    coreVersion: "1",
    buildId: "b".repeat(64),
    gameId: "m6",
    region: "ntsc-u",
    framesPerSecond: 60,
    sampleRate: 44_100,
    geometry: { width: 320, height: 240, aspectRatio: 4 / 3 },
    maxWidth: 1024,
    maxHeight: 512,
    firmware: "bios",
    controllers: { 1: "digital", 2: "digital" },
    discCount: 1,
};

class FakeSession implements PsxSession {
    readonly machine = machine;
    readonly discIndex = 0;
    readonly trayOpen = false;
    playbackRate = 1 as const;
    readonly frames = new Set<Listener<PsxFrameEvent>>();
    readonly sounds = new Set<Listener<PsxSoundEvent>>();

    setButton(): void {}
    setAxis(): void {}
    setPlaybackRate(): void {}
    pause(): void {}
    resume(): void {}
    async reset(): Promise<void> {}
    async setDisc(): Promise<void> {}
    async readMemoryCard(): Promise<Uint8Array> { return new Uint8Array(128 * 1024); }
    async serializeState(): Promise<Uint8Array> { return new Uint8Array(); }
    async unserializeState(): Promise<void> {}
    async exit(): Promise<void> {}
    onTick(): Unsubscribe { return () => undefined; }
    onRumble(_listener: Listener<PsxRumbleEvent>): Unsubscribe { return () => undefined; }
    onExit(): Unsubscribe { return () => undefined; }

    onFrame(listener: Listener<PsxFrameEvent>): Unsubscribe {
        this.frames.add(listener);
        return () => this.frames.delete(listener);
    }

    onSound(listener: Listener<PsxSoundEvent>): Unsubscribe {
        this.sounds.add(listener);
        return () => this.sounds.delete(listener);
    }

    frame(event: PsxFrameEvent): void { this.frames.forEach((listener) => listener(event)); }
    sound(event: PsxSoundEvent): void { this.sounds.forEach((listener) => listener(event)); }
}

class FakeCanvasContext implements PsxCanvasContextLike {
    imageSmoothingEnabled = true;
    readonly images: PsxImageDataLike[] = [];
    readonly draws: number[] = [];
    clears = 0;

    createImageData(width: number, height: number): PsxImageDataLike {
        const image = { width, height, data: new Uint8ClampedArray(width * height * 4) };
        this.images.push(image);
        return image;
    }

    putImageData(image: PsxImageDataLike): void { this.draws.push(image.data[0] ?? -1); }
    clearRect(): void { this.clears++; }
}

class FakeGestureSource {
    readonly listeners = new Map<string, Set<() => void>>();

    addEventListener(type: string, listener: () => void): void {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: () => void): void {
        this.listeners.get(type)?.delete(listener);
    }

    emit(type: string): void { this.listeners.get(type)?.forEach((listener) => listener()); }
}

class FakeAudioNode implements PsxAudioNodeLike {
    readonly connections: PsxAudioNodeLike[] = [];
    connect(destination: PsxAudioNodeLike): void { this.connections.push(destination); }
}

class FakeGainNode extends FakeAudioNode implements PsxGainNodeLike {
    readonly gain = { value: 1 };
}

class FakeAudioBuffer implements PsxAudioBufferLike {
    readonly channels: Float32Array[];
    constructor(readonly length: number, readonly sampleRate: number) {
        this.channels = [new Float32Array(length), new Float32Array(length)];
    }
    getChannelData(channel: number): Float32Array { return this.channels[channel]!; }
}

class FakeAudioSource extends FakeAudioNode implements PsxAudioBufferSourceLike {
    buffer: PsxAudioBufferLike | null = null;
    onended: (() => void) | null = null;
    startTime = -1;
    stopped = false;
    start(when = 0): void { this.startTime = when; }
    stop(): void { this.stopped = true; }
}

class FakeAudioContext implements PsxAudioContextLike {
    state: PsxAudioContextLike["state"] = "suspended";
    currentTime = 0;
    readonly sampleRate = 48_000;
    readonly destination = new FakeAudioNode();
    readonly buffers: FakeAudioBuffer[] = [];
    readonly sources: FakeAudioSource[] = [];
    readonly gains: FakeGainNode[] = [];
    resumeCount = 0;
    closeCount = 0;

    async resume(): Promise<void> { this.resumeCount++; this.state = "running"; }
    async close(): Promise<void> { this.closeCount++; this.state = "closed"; }
    createBuffer(_channels: number, length: number, sampleRate: number): FakeAudioBuffer {
        const buffer = new FakeAudioBuffer(length, sampleRate);
        this.buffers.push(buffer);
        return buffer;
    }
    createBufferSource(): FakeAudioSource {
        const source = new FakeAudioSource();
        this.sources.push(source);
        return source;
    }
    createGain(): FakeGainNode {
        const gain = new FakeGainNode();
        this.gains.push(gain);
        return gain;
    }
}

class FakeAudioWorklet implements PsxAudioWorkletLike {
    readonly modules: string[] = [];
    async addModule(moduleUrl: string): Promise<void> { this.modules.push(moduleUrl); }
}

class FakeWorkletPort implements PsxAudioMessagePortLike {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    readonly messages: unknown[] = [];
    closed = false;
    postMessage(message: unknown): void { this.messages.push(message); }
    close(): void { this.closed = true; }
    emit(data: unknown): void { this.onmessage?.({ data } as MessageEvent<unknown>); }
}

class FakeWorkletNode extends FakeAudioNode implements PsxAudioWorkletNodeLike {
    readonly port = new FakeWorkletPort();
    disconnected = false;
    disconnect(): void { this.disconnected = true; }
}

class FakeWorkletAudioContext extends FakeAudioContext {
    readonly audioWorklet = new FakeAudioWorklet();
}

const sound = (frames = 735): PsxSoundEvent => {
    const samples = new Float32Array(frames * 2);
    for (let frame = 0; frame < frames; frame++) {
        samples[frame * 2] = frame / frames;
        samples[frame * 2 + 1] = -frame / frames;
    }
    return { frames, samples };
};

const roundedLayout = (layout: ReturnType<typeof PsxDisplay.layoutFor>): number[] =>
    [layout.left, layout.top, layout.width, layout.height, layout.scale]
        .map((value) => Number(value.toFixed(3)));

const testFile: TestFile = {
    label: "M6 display and audio",
    cases: [
        {
            label: "display layout preserves reported aspect, dynamic backing geometry, filtering and fullscreen",
            run: () => CTGTest.init("display")
                .stage("exercise display", async () => {
                    const session = new FakeSession();
                    const context = new FakeCanvasContext();
                    const style = { width: "", height: "", imageRendering: "", visibility: "" };
                    const canvas = { width: 0, height: 0, style, getContext: () => context };
                    const rect = { left: 0, top: 0, width: 800, height: 600 };
                    const container = { getBoundingClientRect: () => ({ ...rect }) };
                    const target = {};
                    const document = {
                        fullscreenElement: null as object | null,
                        listeners: new Set<() => void>(),
                        addEventListener(_type: "fullscreenchange", listener: () => void) {
                            this.listeners.add(listener);
                        },
                        removeEventListener(_type: "fullscreenchange", listener: () => void) {
                            this.listeners.delete(listener);
                        },
                    };
                    const fullscreen: string[] = [];
                    const config = {
                        canvas,
                        container,
                        context,
                        fullscreenTarget: target,
                        document,
                        requestFullscreen: async (requested: object) => {
                            fullscreen.push(requested === target ? "enter" : "wrong");
                            document.fullscreenElement = requested;
                        },
                        exitFullscreen: async () => {
                            fullscreen.push("exit");
                            document.fullscreenElement = null;
                        },
                    };
                    const display = new PsxDisplay(config);
                    const placeholder = { hidden: true };
                    display.showPlaceholder(placeholder);
                    display.attach(session);
                    const rgba = new Uint8ClampedArray(640 * 240 * 4);
                    rgba[0] = 77;
                    session.frame({ width: 640, height: 240, aspectRatio: 4 / 3, rgba });
                    display.scaling = "integer";
                    display.imageRendering = "smooth";
                    await display.fullscreen();
                    const inFullscreen = display.isFullscreen;
                    await display.exitFullscreen();
                    const result = {
                        valid: isPsxDisplayConfig(config),
                        layouts: {
                            fit: roundedLayout(PsxDisplay.layoutFor(
                                { left: 0, top: 0, width: 800, height: 600 },
                                { width: 320, height: 240 }, 4 / 3, "fit",
                            )),
                            integer: roundedLayout(PsxDisplay.layoutFor(
                                { left: 0, top: 0, width: 1000, height: 700 },
                                { width: 320, height: 240 }, 4 / 3, "integer",
                            )),
                            fill: roundedLayout(PsxDisplay.layoutFor(
                                { left: 0, top: 0, width: 1000, height: 500 },
                                { width: 320, height: 240 }, 4 / 3, "fill",
                            )),
                            stretch: roundedLayout(PsxDisplay.layoutFor(
                                { left: 0, top: 0, width: 1000, height: 500 },
                                { width: 320, height: 240 }, 4 / 3, "stretch",
                            )),
                        },
                        backing: [canvas.width, canvas.height],
                        dynamicLayout: roundedLayout(display.layout),
                        draw: context.draws,
                        placeholder: [placeholder.hidden, style.visibility],
                        filter: [context.imageSmoothingEnabled, style.imageRendering],
                        fullscreen,
                        inFullscreen,
                    };
                    display.destroy();
                    return result;
                })
                .assert("display behavior", ({ subject }) => subject, P.equals<unknown>({
                    valid: true,
                    layouts: {
                        fit: [0, 0, 800, 600, 2.5],
                        integer: [180, 110, 640, 480, 2],
                        fill: [0, -125, 1000, 750, 3.125],
                        stretch: [0, 0, 1000, 500, 3.125],
                    },
                    backing: [640, 240],
                    dynamicLayout: [80, 60, 640, 480, 1],
                    draw: [77],
                    placeholder: [true, ""],
                    filter: [true, "auto"],
                    fullscreen: ["enter", "exit"],
                    inFullscreen: true,
                }))
                .start(undefined),
        },
        {
            label: "lazy audio unlock de-interleaves at the core rate and stays bounded for 60 seconds",
            run: () => CTGTest.init("audio")
                .stage("exercise audio", async () => {
                    const session = new FakeSession();
                    const gestures = new FakeGestureSource();
                    const context = new FakeAudioContext();
                    const requestedRates: number[] = [];
                    const config = {
                        session,
                        gestureSource: gestures,
                        createAudioContext: ({ sampleRate }: { sampleRate: number }) => {
                            requestedRates.push(sampleRate);
                            return context;
                        },
                        clock: () => context.currentTime * 1000,
                        volume: 0.75,
                    };
                    const audio = new PsxAudio(config);
                    const first = sound();
                    session.sound(first);
                    const beforeUnlock = {
                        requested: requestedRates.length,
                        queued: Number(audio.queuedMs.toFixed(3)),
                    };
                    audio.mute();
                    await audio.unlock();
                    audio.unmute();
                    audio.volume = 0.5;
                    let maximumQueue = audio.queuedMs;
                    for (let frame = 1; frame <= 3_600; frame++) {
                        context.currentTime = frame / 60;
                        session.sound(first);
                        maximumQueue = Math.max(maximumQueue, audio.queuedMs);
                    }
                    const afterMinute = {
                        queued: Number(audio.queuedMs.toFixed(3)),
                        maximum: Number(maximumQueue.toFixed(3)),
                        dropped: audio.droppedSamples,
                        production: Number((audio.productionRate ?? 0).toFixed(3)),
                        maximumGap: Number(audio.maximumSoundGapMs.toFixed(3)),
                    };
                    const stoppedBeforeOverload = context.sources.filter(({ stopped }) => stopped).length;
                    for (let index = 0; index < 10; index++) session.sound(first);
                    const afterOverload = {
                        queued: Number(audio.queuedMs.toFixed(3)),
                        dropped: audio.droppedSamples,
                    };
                    context.currentTime += 0.5;
                    session.sound(first);
                    const afterGap = {
                        queued: Number(audio.queuedMs.toFixed(3)),
                        stopped: context.sources.filter(({ stopped }) => stopped).length > stoppedBeforeOverload,
                        lead: Number((context.sources.at(-1)!.startTime - context.currentTime).toFixed(3)),
                        underruns: audio.underrunCount,
                        recovery: audio.isAdaptiveRecovery,
                        mode: audio.bufferMode,
                        targetLead: audio.bufferLeadMs,
                    };
                    const firstBuffer = context.buffers[0]!;
                    const deviceRate = audio.deviceSampleRate;
                    const channelProbe = [
                        Number(firstBuffer.getChannelData(0)[1]!.toFixed(6)),
                        Number(firstBuffer.getChannelData(1)[1]!.toFixed(6)),
                    ];
                    audio.resetQueue();
                    const resetQueue = audio.queuedMs;
                    audio.destroy();
                    await Promise.resolve();
                    const lowSession = new FakeSession();
                    const lowContext = new FakeAudioContext();
                    const low = new PsxAudio({
                        session: lowSession,
                        gestureSource: new FakeGestureSource(),
                        createAudioContext: () => lowContext,
                        clock: () => lowContext.currentTime * 1000,
                        bufferMode: "low-latency",
                    });
                    lowSession.sound(first);
                    await low.unlock();
                    const lowInitialLead = lowContext.sources.at(-1)!.startTime - lowContext.currentTime;
                    lowContext.currentTime = 0.1;
                    lowSession.sound(first);
                    const lowRecoveryLead = lowContext.sources.at(-1)!.startTime - lowContext.currentTime;
                    const lowUnderruns = low.underrunCount;
                    low.destroy();
                    const stableSession = new FakeSession();
                    const stableContext = new FakeAudioContext();
                    const stable = new PsxAudio({
                        session: stableSession,
                        gestureSource: new FakeGestureSource(),
                        createAudioContext: () => stableContext,
                        bufferMode: "stable",
                    });
                    stableSession.sound(first);
                    await stable.unlock();
                    const stableLead = stableContext.sources.at(-1)!.startTime - stableContext.currentTime;
                    stable.destroy();
                    const workletSession = new FakeSession();
                    const workletContext = new FakeWorkletAudioContext();
                    const workletNode = new FakeWorkletNode();
                    const worklet = new PsxAudio({
                        session: workletSession,
                        gestureSource: new FakeGestureSource(),
                        createAudioContext: () => workletContext,
                        createAudioWorkletNode: () => workletNode,
                        audioWorkletModuleUrl: "https://example.test/PsxAudioWorklet.js",
                        bufferMode: "stable",
                    });
                    workletSession.sound(first);
                    await worklet.unlock();
                    workletNode.port.emit({
                        type: "stats",
                        queuedFrames: 2_205,
                        underruns: 2,
                        droppedFrames: 10,
                        adaptiveRecovery: false,
                        consumptionRatio: 1,
                    });
                    worklet.bufferMode = "adaptive";
                    workletNode.port.emit({
                        type: "stats",
                        queuedFrames: 1_470,
                        underruns: 3,
                        droppedFrames: 12,
                        adaptiveRecovery: true,
                        consumptionRatio: 1,
                    });
                    const workletDiagnostics = {
                        backend: worklet.backend,
                        queued: Number(worklet.queuedMs.toFixed(3)),
                        underruns: worklet.underrunCount,
                        dropped: worklet.droppedSamples,
                        recovery: worklet.isAdaptiveRecovery,
                        targetLead: worklet.bufferLeadMs,
                        modules: workletContext.audioWorklet.modules,
                    };
                    worklet.resetQueue();
                    const workletMessages = workletNode.port.messages.map((message) =>
                        typeof message === "object" && message !== null && "type" in message
                            ? (message as { readonly type: unknown }).type
                            : null);
                    worklet.destroy();
                    return {
                        valid: isPsxAudioConfig(config),
                        backend: audio.backend,
                        modes: {
                            predicates: [
                                isPsxAudioBufferMode("adaptive"),
                                isPsxAudioBufferMode("low-latency"),
                                isPsxAudioBufferMode("stable"),
                                isPsxAudioBufferMode("rate-matched"),
                                isPsxAudioBufferMode("invalid"),
                            ],
                            invalidConfig: isPsxAudioConfig({ ...config, bufferMode: "invalid" }),
                            low: [
                                Number(lowInitialLead.toFixed(3)),
                                Number(lowRecoveryLead.toFixed(3)),
                                lowUnderruns,
                            ],
                            stable: Number(stableLead.toFixed(3)),
                        },
                        worklet: {
                            diagnostics: workletDiagnostics,
                            messages: workletMessages,
                            resetQueue: worklet.queuedMs,
                            closed: workletNode.port.closed,
                            disconnected: workletNode.disconnected,
                        },
                        pure: {
                            channels: deinterleavePsxStereo(new Float32Array([1, -1, 0.5, -0.5]))
                                .map((values) => [...values]),
                            cap: psxAudioQueueCapDecision(100, 2_000, 44_100, 120, 60),
                        },
                        beforeUnlock,
                        request: requestedRates,
                        deviceRate,
                        coreBufferRate: firstBuffer.sampleRate,
                        channelProbe,
                        gains: context.gains.map(({ gain }) => gain.value),
                        afterMinute,
                        afterOverload,
                        afterGap,
                        resetQueue,
                        lifecycle: [context.resumeCount, context.closeCount],
                    };
                })
                .assert("audio behavior", ({ subject }) => subject, P.equals<unknown>({
                    valid: true,
                    backend: "scheduled",
                    modes: {
                        predicates: [true, true, true, false, false],
                        invalidConfig: false,
                        low: [0.02, 0.02, 1],
                        stable: 0.08,
                    },
                    worklet: {
                        diagnostics: {
                            backend: "worklet",
                            queued: 33.333,
                            underruns: 3,
                            dropped: 24,
                            recovery: true,
                            targetLead: 80,
                            modules: ["https://example.test/PsxAudioWorklet.js"],
                        },
                        messages: ["configure", "push", "configure", "reset"],
                        resetQueue: 0,
                        closed: true,
                        disconnected: true,
                    },
                    pure: {
                        channels: [[1, 0.5], [-1, -0.5]],
                        cap: { dropQueuedFrames: 3_764, dropIncomingFrames: 0 },
                    },
                    beforeUnlock: { requested: 0, queued: 16.667 },
                    request: [44_100],
                    deviceRate: 48_000,
                    coreBufferRate: 44_100,
                    channelProbe: [0.001361, -0.001361],
                    gains: [1, 0.5],
                    afterMinute: {
                        queued: 36.667,
                        maximum: 36.667,
                        dropped: 0,
                        production: 1,
                        maximumGap: 16.667,
                    },
                    afterOverload: { queued: 60, dropped: 12_642 },
                    afterGap: {
                        queued: 16.667,
                        stopped: true,
                        lead: 0.08,
                        underruns: 1,
                        recovery: true,
                        mode: "adaptive",
                        targetLead: 80,
                    },
                    resetQueue: 0,
                    lifecycle: [1, 1],
                }))
                .start(undefined),
        },
    ],
};

export default testFile;
