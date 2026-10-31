import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";
import {
    isLibretroPsxAdapterConfig,
    isLibretroPsxAdapterInitConfig,
    isPsxSession,
    LibretroPsxAdapter,
    PsxRuntimeError,
} from "../../src/index.ts";
import WorkerEndpoint from "../../src/worker/WorkerEndpoint.ts";
import WorkerRuntime from "../../src/worker/WorkerRuntime.ts";

import type {
    BiosImage,
    DiscSet,
    FrameScheduler,
    PsxBuildInfo,
    PsxMachineInfo,
    PsxSession,
    PsxWorker,
    WorkerErrorEventLike,
    WorkerMessageEventLike,
} from "../../src/index.ts";
import type { WorkerStartPayload } from "../../src/LibretroPsxAdapter/protocol.ts";
import type { CoreRunOutput, WorkerCore } from "../../src/worker/WorkerRuntime.ts";
import type { TestFile } from "../run.ts";

const buildId = "c".repeat(64);
const build: PsxBuildInfo = {
    formatVersion: 1,
    adapter: "libretro-psx",
    buildId,
    core: "Synthetic PSX",
    coreVersion: "m4",
    coreCommit: "d".repeat(40),
    emsdkVersion: "6.0.2",
    artifacts: ["psx-core.js", "psx-core.wasm", "core.worker.js"],
    supportedContent: ["cue", "m3u", "sbi"],
    controllerTypes: ["none", "digital", "dualshock"],
    firmware: {
        required: true,
        byteLengths: [4],
        systemFilenames: {
            "ntsc-u": "scph5501.bin",
            "ntsc-j": "scph5500.bin",
            pal: "scph5502.bin",
        },
    },
    memory: { initialPages: 1024, maximumPages: 8192 },
    pthreads: false,
    licenses: [{ id: "test", notice: "notices/test.txt" }],
};

const cue = (name: string): string => [
    "FILE \"" + name + "\" BINARY",
    "TRACK 01 MODE2/2352",
    "INDEX 01 00:00:00",
    "",
].join("\n");

const game: DiscSet = {
    gameId: "m4-fixture",
    entry: "set/game.m3u",
    files: [
        { path: "set/game.m3u", blob: new Blob(["one/disc.cue\ntwo/disc.cue\n"]) },
        { path: "set/one/disc.cue", blob: new Blob([cue("track.bin")]) },
        { path: "set/one/track.bin", blob: new Blob([new Uint8Array([1, 2])]) },
        { path: "set/two/disc.cue", blob: new Blob([cue("track.bin")]) },
        { path: "set/two/track.bin", blob: new Blob([new Uint8Array([3, 4])]) },
    ],
};

const bios: BiosImage = {
    name: "Test firmware",
    region: "ntsc-u",
    blob: new Blob([new Uint8Array([1, 2, 3, 4])]),
};

class ManualScheduler implements FrameScheduler {
    readonly callbacks = new Map<number, (time: number) => void>();
    nextId = 0;
    time = 0;

    request(callback: (time: number) => void): number {
        const id = ++this.nextId;
        this.callbacks.set(id, callback);
        return id;
    }

    cancel(handle: number): void {
        this.callbacks.delete(handle);
    }

    async pulse(milliseconds = 17): Promise<void> {
        this.time += milliseconds;
        const pending = [...this.callbacks.values()];
        this.callbacks.clear();
        pending.forEach((callback) => callback(this.time));
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

class LoopbackCore implements WorkerCore {
    static readonly instances: LoopbackCore[] = [];
    readonly calls: string[] = [];
    cards: Record<1 | 2, Uint8Array> = {
        1: new Uint8Array(128 * 1024),
        2: new Uint8Array(128 * 1024),
    };
    frames = 0;
    stops = 0;

    constructor() {
        LoopbackCore.instances.push(this);
    }

    start(payload: WorkerStartPayload): PsxMachineInfo {
        this.calls.push("start:" + payload.contentPath);
        this.cards = {
            1: payload.memoryCards[1].slice(),
            2: payload.memoryCards[2].slice(),
        };
        return {
            core: build.core,
            coreVersion: build.coreVersion,
            buildId: build.buildId,
            gameId: payload.gameId,
            region: payload.region,
            framesPerSecond: 60,
            sampleRate: 44_100,
            geometry: { width: 1, height: 1, aspectRatio: 1 },
            maxWidth: 2,
            maxHeight: 1,
            firmware: "bios",
            controllers: payload.controllers,
            discCount: 2,
        };
    }

    runFrame(): CoreRunOutput {
        this.frames++;
        this.cards[1][20] = 42;
        if (this.frames === 1) {
            return {
                video: {
                    data: new Uint8Array([0x00, 0xf8]),
                    width: 1,
                    height: 1,
                    pitch: 2,
                    aspectRatio: 1,
                    format: "rgb565",
                },
                audio: new Int16Array([0, 1]),
                rumble: [{ port: 1, strong: 1, weak: 0.5 }],
            };
        }
        return {
            video: {
                data: new Uint8Array([0x00, 0xf8, 0xe0, 0x07]),
                width: 2,
                height: 1,
                pitch: 4,
                aspectRatio: 2,
                format: "rgb565",
            },
            audio: new Int16Array([2, 3]),
        };
    }

    setButton(port: 1 | 2, button: string, pressed: boolean): void {
        this.calls.push("button:" + port + ":" + button + ":" + pressed);
    }

    setAxis(port: 1 | 2, axis: string, value: number): void {
        this.calls.push("axis:" + port + ":" + axis + ":" + value);
    }

    reset(kind: "soft" | "hard"): void {
        this.calls.push("reset:" + kind);
    }

    setDisc(index: number): { discIndex: number; trayOpen: boolean } {
        this.calls.push("disc:" + index);
        return { discIndex: index, trayOpen: false };
    }

    readMemoryCard(slot: 1 | 2): Uint8Array {
        this.calls.push("card:" + slot);
        return this.cards[slot].slice();
    }

    serializeState(): Uint8Array {
        this.calls.push("serialize");
        return new Uint8Array([7, 8, 9]);
    }

    unserializeState(bytes: Uint8Array): void {
        this.calls.push("unserialize:" + [...bytes].join(","));
    }

    stop(): void {
        this.calls.push("stop");
        this.stops++;
    }
}

class LoopbackWorker implements PsxWorker {
    static readonly instances: LoopbackWorker[] = [];
    readonly messageListeners = new Set<(event: WorkerMessageEventLike) => void>();
    readonly errorListeners = new Set<(event: WorkerErrorEventLike) => void>();
    readonly core = new LoopbackCore();
    readonly endpoint: WorkerEndpoint;
    terminated = false;

    constructor() {
        LoopbackWorker.instances.push(this);
        this.endpoint = new WorkerEndpoint(new WorkerRuntime(this.core), {
            postMessage: (message) => {
                for (const listener of [...this.messageListeners]) listener({ data: message });
            },
        });
    }

    postMessage(message: unknown): void {
        void this.endpoint.receive(message);
    }

    addEventListener(
        type: "message" | "error",
        listener: ((event: WorkerMessageEventLike) => void) | ((event: WorkerErrorEventLike) => void),
    ): void {
        if (type === "message") this.messageListeners.add(listener as (event: WorkerMessageEventLike) => void);
        else this.errorListeners.add(listener as (event: WorkerErrorEventLike) => void);
    }

    removeEventListener(
        type: "message" | "error",
        listener: ((event: WorkerMessageEventLike) => void) | ((event: WorkerErrorEventLike) => void),
    ): void {
        if (type === "message") this.messageListeners.delete(listener as (event: WorkerMessageEventLike) => void);
        else this.errorListeners.delete(listener as (event: WorkerErrorEventLike) => void);
    }

    terminate(): void {
        this.terminated = true;
    }
}

const drive = async <T>(pending: Promise<T>, scheduler: ManualScheduler): Promise<T> => {
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    for (let attempt = 0; attempt < 12 && !settled; attempt++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await scheduler.pulse();
    }
    return pending;
};

const capture = async (action: () => Promise<unknown>): Promise<unknown> => {
    try {
        await action();
        return null;
    } catch (error) {
        return error;
    }
};

const codeOf = (value: unknown): number | null => PsxRuntimeError.is(value) ? value.code : null;

const freshAdapter = (scheduler: ManualScheduler): LibretroPsxAdapter => new LibretroPsxAdapter({
    buildUrl: "/build",
    build,
    createWorker: () => new LoopbackWorker(),
    scheduler,
    clock: () => scheduler.time,
});

const testFile: TestFile = {
    label: "M4 adapter and session",
    cases: [
        {
            label: "constructor and init boundaries validate metadata and injected browser dependencies",
            run: () => CTGTest.init("adapter construction")
                .stage("initialize", async () => {
                    const scheduler = new ManualScheduler();
                    const config = {
                        buildUrl: "/build",
                        build,
                        createWorker: () => new LoopbackWorker(),
                        scheduler,
                        clock: () => 0,
                    };
                    const initialized = await LibretroPsxAdapter.init({
                        buildUrl: "/assets",
                        fetch: async (url) => ({
                            ok: url === "/assets/build.json",
                            status: 200,
                            arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(build)).buffer,
                        }),
                        createWorker: config.createWorker,
                        scheduler,
                        clock: () => 0,
                    });
                    return {
                        config: isLibretroPsxAdapterConfig(config),
                        initConfig: isLibretroPsxAdapterInitConfig({
                            buildUrl: "/assets",
                            fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }),
                        }),
                        invalid: isLibretroPsxAdapterConfig({ ...config, createWorker: null }),
                        type: initialized.type,
                        buildIdentity: initialized.build === build,
                    };
                })
                .assert("validated construction", ({ subject }) => subject, P.equals<unknown>({
                    config: true,
                    initConfig: true,
                    invalid: false,
                    type: "libretro-psx",
                    buildIdentity: false,
                }))
                .start(undefined),
        },
        {
            label: "a session drives lifecycle, AV events, input, state, cards, disc change, and hard restart",
            run: () => CTGTest.init("session lifecycle")
                .stage("exercise", async () => {
                    LoopbackCore.instances.length = 0;
                    LoopbackWorker.instances.length = 0;
                    const scheduler = new ManualScheduler();
                    const adapter = freshAdapter(scheduler);
                    const session = await drive(adapter.start({
                        game,
                        bios,
                        controllers: { 1: "dualshock", 2: "digital" },
                    }), scheduler) as PsxSession;
                    const events = { ticks: 0, frames: [] as number[], sounds: 0, rumble: 0, exits: 0 };
                    session.onTick(() => { events.ticks++; });
                    session.onFrame((frame) => events.frames.push(frame.width));
                    session.onSound(() => { events.sounds++; });
                    session.onRumble(() => { events.rumble++; });
                    session.onExit(() => { events.exits++; });
                    session.setButton({ port: 1, button: "cross" }, true);
                    session.setAxis({ port: 1, axis: "left-x" }, 2);
                    await scheduler.pulse();
                    await session.reset("soft");
                    await session.setDisc(1);
                    const state = await session.serializeState();
                    await session.unserializeState(state);
                    const cardBefore = await session.readMemoryCard(1);
                    const hardReset = session.reset("hard");
                    await drive(hardReset, scheduler);
                    const cardAfter = await session.readMemoryCard(1);
                    await scheduler.pulse();
                    await session.exit();
                    let destroyed: unknown;
                    try {
                        session.setButton({ port: 1, button: "cross" }, false);
                    } catch (error) {
                        destroyed = error;
                    }
                    return {
                        valid: isPsxSession(session),
                        machine: {
                            controllers: session.machine.controllers,
                            geometry: session.machine.geometry,
                            discs: session.machine.discCount,
                        },
                        events,
                        state: [...state],
                        cards: [cardBefore[20], cardAfter[20]],
                        discAfterChange: 1,
                        workers: LoopbackWorker.instances.length,
                        terminated: LoopbackWorker.instances.map(({ terminated }) => terminated),
                        coreStops: LoopbackCore.instances.map(({ stops }) => stops),
                        firstCalls: LoopbackCore.instances[0]?.calls,
                        secondStartedWithCard: LoopbackCore.instances[1]?.cards[1][20],
                        finalCard: (session as PsxSession & { finalMemoryCards?: Record<1 | 2, Uint8Array> }).finalMemoryCards?.[1][20],
                        destroyed: codeOf(destroyed),
                        schedulerHandles: scheduler.callbacks.size,
                    };
                })
                .assert("complete lifecycle", ({ subject }) => subject, P.equals<unknown>({
                    valid: true,
                    machine: {
                        controllers: { 1: "dualshock", 2: "digital" },
                        geometry: { width: 2, height: 1, aspectRatio: 2 },
                        discs: 2,
                    },
                    events: { ticks: 2, frames: [2, 2], sounds: 2, rumble: 0, exits: 1 },
                    state: [7, 8, 9],
                    cards: [42, 42],
                    discAfterChange: 1,
                    workers: 2,
                    terminated: [true, true],
                    coreStops: [1, 1],
                    firstCalls: [
                        "start:/content/index/game.m3u",
                        "button:1:cross:true",
                        "axis:1:left-x:1",
                        "reset:soft",
                        "disc:1",
                        "serialize",
                        "unserialize:7,8,9",
                        "card:1",
                        "card:1",
                        "card:2",
                        "stop",
                    ],
                    secondStartedWithCard: 42,
                    finalCard: 42,
                    destroyed: 11,
                    schedulerHandles: 0,
                }))
                .start(undefined),
        },
        {
            label: "disc, BIOS, and option failures occur before Worker creation with typed errors",
            run: () => CTGTest.init("startup rejection")
                .stage("reject invalid inputs", async () => {
                    LoopbackWorker.instances.length = 0;
                    const scheduler = new ManualScheduler();
                    const adapter = freshAdapter(scheduler);
                    const missing: DiscSet = {
                        gameId: "missing",
                        entry: "game.cue",
                        files: [{ path: "game.cue", blob: new Blob([cue("missing.bin")]) }],
                    };
                    const errors = await Promise.all([
                        capture(() => adapter.start({ game: missing, bios })),
                        capture(() => adapter.start({
                            game,
                            bios: { ...bios, blob: new Blob([new Uint8Array([1])]) },
                        })),
                        capture(() => adapter.start({ game, bios, options: { unsupported: true } })),
                    ]);
                    return {
                        codes: errors.map(codeOf),
                        workers: LoopbackWorker.instances.length,
                    };
                })
                .assert("typed preflight", ({ subject }) => subject, P.equals<unknown>({
                    codes: [6, 7, 18],
                    workers: 0,
                }))
                .start(undefined),
        },
    ],
};

export default testFile;
