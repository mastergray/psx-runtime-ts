import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";
import {
    isWorkerCommand,
    isWorkerOutput,
} from "../../src/LibretroPsxAdapter/protocol.ts";
import FramePacer from "../../src/worker/FramePacer.ts";
import TransferBufferPool from "../../src/worker/TransferBufferPool.ts";
import WorkerEndpoint from "../../src/worker/WorkerEndpoint.ts";
import WorkerRuntime from "../../src/worker/WorkerRuntime.ts";
import { convertAudioSamples, convertVideoFrame } from "../../src/worker/av.ts";

import type {
    WorkerCommand,
    WorkerOutput,
    WorkerStartPayload,
} from "../../src/LibretroPsxAdapter/protocol.ts";
import type { PsxMachineInfo } from "../../src/index.ts";
import type { CoreRunOutput, WorkerCore } from "../../src/worker/WorkerRuntime.ts";
import type { TestFile } from "../run.ts";

const buildId = "a".repeat(64);
const machine: PsxMachineInfo = {
    core: "Synthetic PSX",
    coreVersion: "1",
    buildId,
    gameId: "fixture",
    region: "ntsc-u",
    framesPerSecond: 60,
    sampleRate: 44_100,
    geometry: { width: 2, height: 1, aspectRatio: 2 },
    maxWidth: 4,
    maxHeight: 2,
    firmware: "bios",
    controllers: { 1: "dualshock", 2: "digital" },
    discCount: 2,
};

const startPayload: WorkerStartPayload = {
    contentPath: "/content/index/game.cue",
    gameId: "fixture",
    region: "ntsc-u",
    controllers: { 1: "dualshock", 2: "digital" },
    options: {},
};

const command = <T extends WorkerCommand>(value: T): T => value;

class SyntheticCore implements WorkerCore {
    readonly calls: string[] = [];
    frames = 0;
    stops = 0;
    failReset = false;

    start(payload: WorkerStartPayload): PsxMachineInfo {
        this.calls.push(`start:${payload.gameId}`);
        return machine;
    }

    runFrame(): CoreRunOutput {
        this.frames++;
        this.calls.push(`frame:${this.frames}`);
        if (this.frames === 1) {
            return {
                video: {
                    data: new Uint8Array([0x00, 0xf8, 0x1f, 0x00]),
                    width: 2,
                    height: 1,
                    pitch: 4,
                    aspectRatio: 2,
                    format: "rgb565",
                },
                audio: new Int16Array([-32768, 32767]),
                rumble: [{ port: 1, strong: 1, weak: 0.5 }],
            };
        }
        return {
            video: {
                data: new Uint8Array([0x00, 0xff, 0x00, 0x00]),
                width: 1,
                height: 1,
                pitch: 4,
                aspectRatio: 1,
                format: "xrgb8888",
            },
            audio: new Int16Array([0, 0]),
        };
    }

    setButton(port: 1 | 2, button: string, pressed: boolean): void {
        this.calls.push(`button:${port}:${button}:${pressed}`);
    }

    setAxis(port: 1 | 2, axis: string, value: number): void {
        this.calls.push(`axis:${port}:${axis}:${value}`);
    }

    reset(kind: "soft" | "hard"): void {
        this.calls.push(`reset:${kind}`);
        if (this.failReset) throw new Error("synthetic reset failure");
    }

    setDisc(index: number): { discIndex: number; trayOpen: boolean } {
        this.calls.push(`disc:${index}`);
        return { discIndex: index, trayOpen: false };
    }

    readMemoryCard(slot: 1 | 2): Uint8Array {
        this.calls.push(`card:${slot}`);
        return new Uint8Array(128 * 1024).fill(slot);
    }

    serializeState(): Uint8Array {
        this.calls.push("serialize");
        return new Uint8Array([1, 2, 3]);
    }

    unserializeState(bytes: Uint8Array): void {
        this.calls.push(`unserialize:${bytes.join(",")}`);
    }

    stop(): void {
        this.calls.push("stop");
        this.stops++;
    }
}

const start = command({ type: "start", requestId: 1, generation: 1, payload: startPayload });

const frameOf = (outputs: WorkerOutput[]): Extract<WorkerOutput, { type: "frame" }> => {
    const frame = outputs.find((output): output is Extract<WorkerOutput, { type: "frame" }> => output.type === "frame");
    if (frame === undefined) throw new Error("expected a frame output");
    return frame;
};

const testFile: TestFile = {
    label: "M2 Worker foundation",
    cases: [
        {
            label: "the protocol rejects malformed envelopes and validates every output family",
            run: () => CTGTest.init("protocol")
                .assert("command verdicts", () => [
                    start,
                    { ...start, requestId: 0 },
                    { ...start, payload: { ...startPayload, contentPath: "../bad.cue" } },
                    command({ type: "tick", requestId: 2, generation: 1, timestamp: 10 }),
                    { type: "tick", requestId: 2, generation: 1, timestamp: -1 },
                    command({ type: "set-button", requestId: 3, generation: 1, port: 1, button: "cross", pressed: true }),
                    { type: "set-axis", requestId: 4, generation: 1, port: 1, axis: "left-x", value: 2 },
                ].map(isWorkerCommand), P.equals<boolean[]>([true, false, false, true, false, true, false]))
                .assert("output verdicts", () => [
                    { type: "response", command: "start", requestId: 1, generation: 1, ok: true, result: machine },
                    { type: "response", command: "reset", requestId: 2, generation: 1, ok: false, error: { code: 19, message: "failed", data: null } },
                    { type: "tick", generation: 1 },
                    { type: "geometry", generation: 1, width: 2, height: 1, aspectRatio: 2 },
                    { type: "frame", generation: 1, bufferId: 0, width: 2, height: 1, aspectRatio: 2, rgba: new ArrayBuffer(8) },
                    { type: "sound", generation: 1, frames: 1, samples: new ArrayBuffer(8) },
                    { type: "rumble", generation: 1, port: 1, strong: 1, weak: 0 },
                    { type: "dropped-time", generation: 1, milliseconds: 1, videoFrames: 0 },
                    { type: "frame", generation: 1, bufferId: 0, width: 2, height: 1, aspectRatio: 2, rgba: new ArrayBuffer(4) },
                ].map(isWorkerOutput), P.equals<boolean[]>([true, true, true, true, true, true, true, true, false]))
                .start(undefined),
        },
        {
            label: "the endpoint validates output and transfers only owned binary payloads",
            run: () => CTGTest.init("worker endpoint")
                .stage("post one emulated frame", async () => {
                    const messages: Array<{ output: WorkerOutput; transfers: Transferable[] }> = [];
                    const endpoint = new WorkerEndpoint(new WorkerRuntime(new SyntheticCore()), {
                        postMessage: (output, transfers) => messages.push({ output, transfers }),
                    });
                    await endpoint.receive(start);
                    await endpoint.receive(command({ type: "tick", requestId: 2, generation: 1, timestamp: 0 }));
                    await endpoint.receive(command({ type: "tick", requestId: 3, generation: 1, timestamp: 17 }));
                    await endpoint.receive({ type: "tick", requestId: 0, generation: 1, timestamp: 18 });
                    return messages;
                })
                .assert("transfer ownership", (state) => {
                    const last = state.subject.at(-1)?.output;
                    return {
                        valid: state.subject.every(({ output }) => isWorkerOutput(output)),
                        frameTransfers: state.subject
                            .filter(({ output }) => output.type === "frame")
                            .map(({ transfers }) => transfers.length),
                        soundTransfers: state.subject
                            .filter(({ output }) => output.type === "sound")
                            .map(({ transfers }) => transfers.length),
                        otherTransfers: state.subject
                            .filter(({ output }) => output.type !== "frame" && output.type !== "sound")
                            .every(({ transfers }) => transfers.length === 0),
                        invalidMessageCode: last?.type === "error" ? last.error.code : null,
                    };
                }, P.equals<unknown>({
                    valid: true,
                    frameTransfers: [1],
                    soundTransfers: [1],
                    otherTransfers: true,
                    invalidMessageCode: 2,
                }))
                .start(undefined),
        },
        {
            label: "pacing preserves PAL and NTSC rates, caps catch-up, and drops paused wall time",
            run: () => CTGTest.init("pacing")
                .assert("pacer measurements", () => {
                    const framesFor = (fps: number, hostHz: number): number => {
                        const pacer = new FramePacer(fps);
                        let frames = 0;
                        for (let tick = 0; tick <= hostHz; tick++) {
                            frames += pacer.advance(tick * 1000 / hostHz).frames;
                        }
                        return frames;
                    };
                    const backlog = new FramePacer(60);
                    backlog.advance(0);
                    const capped = backlog.advance(200);
                    const paused = new FramePacer(60);
                    paused.advance(0);
                    paused.pause();
                    const whilePaused = paused.advance(10_000);
                    paused.resume();
                    const resumedFirst = paused.advance(20_000);
                    const resumedSecond = paused.advance(20_000 + 1000 / 60);
                    return {
                        ntsc60: framesFor(60, 60),
                        ntsc120: framesFor(60, 120),
                        pal60: framesFor(50, 60),
                        pal120: framesFor(50, 120),
                        cappedFrames: capped.frames,
                        droppedFrames: Math.round(capped.droppedMilliseconds / (1000 / 60)),
                        paused: whilePaused.frames,
                        resumed: [resumedFirst.frames, resumedSecond.frames],
                    };
                }, P.equals<unknown>({
                    ntsc60: 60,
                    ntsc120: 60,
                    pal60: 50,
                    pal120: 50,
                    cappedFrames: 4,
                    droppedFrames: 8,
                    paused: 0,
                    resumed: [0, 1],
                }))
                .start(undefined),
        },
        {
            label: "the three-buffer pool enforces ownership, backpressure, resizing, and terminal cleanup",
            run: () => CTGTest.init("buffer pool")
                .assert("lease lifecycle", () => {
                    const pool = new TransferBufferPool(3);
                    const leases = [pool.acquire(8), pool.acquire(8), pool.acquire(8)];
                    const fourth = pool.acquire(8);
                    const first = leases[0]!;
                    if (first === null) throw new Error("missing first lease");
                    pool.release(first.id, first.buffer);
                    const resized = pool.acquire(16);
                    let duplicateReleaseRejected = false;
                    try {
                        pool.release(first.id, first.buffer);
                    } catch {
                        duplicateReleaseRejected = true;
                    }
                    pool.close();
                    let closedRejected = false;
                    try {
                        pool.acquire(8);
                    } catch {
                        closedRejected = true;
                    }
                    return {
                        ids: leases.map((lease) => lease?.id),
                        fourth,
                        drops: pool.dropped,
                        resizedBytes: resized?.buffer.byteLength,
                        duplicateReleaseRejected,
                        closedRejected,
                    };
                }, P.equals<unknown>({
                    ids: [0, 1, 2],
                    fourth: null,
                    drops: 1,
                    resizedBytes: 16,
                    duplicateReleaseRejected: true,
                    closedRejected: true,
                }))
                .start(undefined),
        },
        {
            label: "pixel and audio conversion honor all negotiated formats, pitch, and normalized ranges",
            run: () => CTGTest.init("AV conversion")
                .assert("converted values", () => {
                    const rgb565 = convertVideoFrame({
                        data: new Uint8Array([0x00, 0xf8, 0xe0, 0x07, 0xaa, 0xaa]),
                        width: 2, height: 1, pitch: 6, aspectRatio: 2, format: "rgb565",
                    }, new ArrayBuffer(8));
                    const rgb1555 = convertVideoFrame({
                        data: new Uint8Array([0x1f, 0x00]),
                        width: 1, height: 1, pitch: 2, aspectRatio: 1, format: "0rgb1555",
                    }, new ArrayBuffer(4));
                    const xrgb = convertVideoFrame({
                        data: new Uint8Array([0x33, 0x22, 0x11, 0xff]),
                        width: 1, height: 1, pitch: 4, aspectRatio: 1, format: "xrgb8888",
                    }, new ArrayBuffer(4));
                    const audio = convertAudioSamples(new Int16Array([-32768, 0, 32767]));
                    return {
                        rgb565: [...rgb565],
                        rgb1555: [...rgb1555],
                        xrgb: [...xrgb],
                        audio: [...audio].map((sample) => Math.round(sample * 32768)),
                    };
                }, P.equals<unknown>({
                    rgb565: [255, 0, 0, 255, 0, 255, 0, 255],
                    rgb1555: [0, 0, 255, 255],
                    xrgb: [17, 34, 51, 255],
                    audio: [-32768, 0, 32767],
                }))
                .start(undefined),
        },
        {
            label: "the synthetic core proves FIFO lifecycle, dynamic AV, state, cards, disc control, and exit",
            run: () => CTGTest.init("worker lifecycle")
                .stage("exercise runtime", async () => {
                    const core = new SyntheticCore();
                    const runtime = new WorkerRuntime(core);
                    const outputs: WorkerOutput[] = [];
                    outputs.push(...await runtime.dispatch(start));
                    outputs.push(...await runtime.dispatch(command({ type: "set-button", requestId: 2, generation: 1, port: 1, button: "cross", pressed: true })));
                    outputs.push(...await runtime.dispatch(command({ type: "set-axis", requestId: 3, generation: 1, port: 1, axis: "left-x", value: -0.5 })));
                    outputs.push(...await runtime.dispatch(command({ type: "tick", requestId: 4, generation: 1, timestamp: 0 })));
                    const firstTick = await runtime.dispatch(command({ type: "tick", requestId: 5, generation: 1, timestamp: 17 }));
                    outputs.push(...firstTick);
                    const firstFrame = frameOf(firstTick);
                    outputs.push(...await runtime.dispatch(command({ type: "return-video-buffer", requestId: 6, generation: 1, bufferId: firstFrame.bufferId, buffer: firstFrame.rgba })));
                    const secondTick = await runtime.dispatch(command({ type: "tick", requestId: 7, generation: 1, timestamp: 34 }));
                    outputs.push(...secondTick);
                    const secondFrame = frameOf(secondTick);
                    outputs.push(...await runtime.dispatch(command({ type: "return-video-buffer", requestId: 8, generation: 1, bufferId: secondFrame.bufferId, buffer: secondFrame.rgba })));
                    const fifo = await Promise.all([
                        runtime.dispatch(command({ type: "reset", requestId: 9, generation: 1, kind: "soft" })),
                        runtime.dispatch(command({ type: "set-disc", requestId: 10, generation: 1, index: 1 })),
                        runtime.dispatch(command({ type: "serialize-state", requestId: 11, generation: 1 })),
                        runtime.dispatch(command({ type: "unserialize-state", requestId: 12, generation: 1, bytes: new Uint8Array([9]) })),
                        runtime.dispatch(command({ type: "read-memory-card", requestId: 13, generation: 1, slot: 2 })),
                    ]);
                    fifo.forEach((batch) => outputs.push(...batch));
                    outputs.push(...await runtime.dispatch(command({ type: "pause", requestId: 14, generation: 1 })));
                    outputs.push(...await runtime.dispatch(command({ type: "tick", requestId: 15, generation: 1, timestamp: 10_000 })));
                    outputs.push(...await runtime.dispatch(command({ type: "resume", requestId: 16, generation: 1 })));
                    outputs.push(...await runtime.dispatch(command({ type: "exit", requestId: 17, generation: 1 })));
                    const late = await runtime.dispatch(command({ type: "tick", requestId: 18, generation: 1, timestamp: 20_000 }));
                    return { core, runtime, outputs, late };
                })
                .assert("all behavior and output are valid", (state) => ({
                    state: state.subject.runtime.state,
                    stoppedOnce: state.subject.core.stops === 1,
                    frameCount: state.subject.core.frames,
                    calls: state.subject.core.calls,
                    outputValid: state.subject.outputs.every(isWorkerOutput),
                    geometryBeforeSecondFrame: (() => {
                        const geometry = state.subject.outputs.findIndex((output) => output.type === "geometry");
                        const frames = state.subject.outputs
                            .map((output, index) => ({ output, index }))
                            .filter(({ output }) => output.type === "frame");
                        return geometry >= 0 && frames[1] !== undefined && geometry < frames[1].index;
                    })(),
                    soundFrames: state.subject.outputs
                        .filter((output): output is Extract<WorkerOutput, { type: "sound" }> => output.type === "sound")
                        .map((output) => output.frames),
                    hasRumble: state.subject.outputs.some((output) => output.type === "rumble"),
                    lateIgnored: state.subject.late.length === 0,
                }), P.equals<unknown>({
                    state: "exited",
                    stoppedOnce: true,
                    frameCount: 2,
                    calls: [
                        "start:fixture", "button:1:cross:true", "axis:1:left-x:-0.5", "frame:1", "frame:2",
                        "reset:soft", "disc:1", "serialize", "unserialize:9", "card:2", "stop",
                    ],
                    outputValid: true,
                    geometryBeforeSecondFrame: true,
                    soundFrames: [1, 1],
                    hasRumble: true,
                    lateIgnored: true,
                }))
                .start(undefined),
        },
        {
            label: "video backpressure drops only video while emulation and audio continue",
            run: () => CTGTest.init("backpressure")
                .stage("run four frames without returning buffers", async () => {
                    const core = new SyntheticCore();
                    const runtime = new WorkerRuntime(core, 3);
                    await runtime.dispatch(start);
                    await runtime.dispatch(command({ type: "tick", requestId: 2, generation: 1, timestamp: 0 }));
                    const outputs = await runtime.dispatch(command({ type: "tick", requestId: 3, generation: 1, timestamp: 100 }));
                    return { core, outputs };
                })
                .assert("only the fourth video is dropped", (state) => ({
                    runs: state.subject.core.frames,
                    frames: state.subject.outputs.filter((output) => output.type === "frame").length,
                    sounds: state.subject.outputs.filter((output) => output.type === "sound").length,
                    ticks: state.subject.outputs.filter((output) => output.type === "tick").length,
                    droppedVideo: state.subject.outputs
                        .find((output): output is Extract<WorkerOutput, { type: "dropped-time" }> => output.type === "dropped-time")
                        ?.videoFrames,
                }), P.equals<unknown>({ runs: 4, frames: 3, sounds: 4, ticks: 4, droppedVideo: 1 }))
                .start(undefined),
        },
        {
            label: "a core failure performs terminal cleanup once and rejects later-generation work",
            run: () => CTGTest.init("terminal failure")
                .stage("fail reset", async () => {
                    const core = new SyntheticCore();
                    core.failReset = true;
                    const runtime = new WorkerRuntime(core);
                    await runtime.dispatch(start);
                    const failure = await runtime.dispatch(command({ type: "reset", requestId: 2, generation: 1, kind: "hard" }));
                    const late = await runtime.dispatch(command({ type: "exit", requestId: 3, generation: 1 }));
                    return { core, runtime, failure, late };
                })
                .assert("terminal state", (state) => ({
                    state: state.subject.runtime.state,
                    stops: state.subject.core.stops,
                    failureValid: state.subject.failure.every(isWorkerOutput),
                    failureCode: state.subject.failure[0]?.type === "response" && !state.subject.failure[0].ok
                        ? state.subject.failure[0].error.code
                        : null,
                    late: state.subject.late.length,
                }), P.equals<unknown>({ state: "failed", stops: 1, failureValid: true, failureCode: 19, late: 0 }))
                .start(undefined),
        },
    ],
};

export default testFile;
