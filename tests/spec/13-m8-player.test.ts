import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";
import {
    isPsxPlayerConfig,
    PsxPlayer,
    PsxRuntimeError,
} from "../../src/index.ts";

import type {
    BiosImage,
    DiscSet,
    Listener,
    PsxAdapter,
    PsxAxisControl,
    PsxButtonControl,
    PsxFrameEvent,
    PsxMachineInfo,
    PsxMemoryCardRecord,
    PsxMemoryCardSaveConfig,
    PsxRumbleEvent,
    PsxSession,
    PsxSoundEvent,
    PsxStartConfig,
    PsxStateLoadConfig,
    PsxStateRecord,
    PsxStateSaveConfig,
    Unsubscribe,
} from "../../src/index.ts";
import type { TestFile } from "../run.ts";

const game: DiscSet = {
    gameId: "player-game",
    entry: "game.cue",
    files: [
        { path: "game.cue", blob: new Blob(["FILE \"track.bin\" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:00:00\n"]) },
        { path: "track.bin", blob: new Blob([new Uint8Array([1])]) },
    ],
};

const bios: BiosImage = {
    name: "firmware",
    region: "ntsc-u",
    blob: new Blob([new Uint8Array([1])]),
};

const machine: PsxMachineInfo = {
    core: "Player fake",
    coreVersion: "1",
    buildId: "1".repeat(64),
    gameId: game.gameId,
    region: "ntsc-u",
    framesPerSecond: 60,
    sampleRate: 44_100,
    geometry: { width: 2, height: 1, aspectRatio: 2 },
    maxWidth: 2,
    maxHeight: 1,
    firmware: "bios",
    controllers: { 1: "digital", 2: "digital" },
    discCount: 2,
};

class FakeSession implements PsxSession {
    readonly machine = machine;
    discIndex = 0;
    trayOpen = false;
    readonly calls: string[] = [];
    readonly frameListeners = new Set<Listener<PsxFrameEvent>>();
    readonly exitListeners = new Set<Listener<void>>();
    readonly cards = { 1: new Uint8Array(128 * 1024), 2: new Uint8Array(128 * 1024) };
    replayFrame = true;

    constructor(initial?: Readonly<Partial<Record<1 | 2, Uint8Array>>>) {
        if (initial?.[1] !== undefined) this.cards[1].set(initial[1]);
        if (initial?.[2] !== undefined) this.cards[2].set(initial[2]);
    }

    setButton(control: PsxButtonControl, pressed: boolean): void {
        this.calls.push(`button:${control.port}:${control.button}:${pressed}`);
    }
    setAxis(control: PsxAxisControl, value: number): void {
        this.calls.push(`axis:${control.port}:${control.axis}:${value}`);
    }
    pause(): void { this.calls.push("pause"); }
    resume(): void { this.calls.push("resume"); }
    async reset(kind: "soft" | "hard"): Promise<void> { this.calls.push(`reset:${kind}`); }
    async setDisc(index: number): Promise<void> { this.calls.push(`disc:${index}`); this.discIndex = index; }
    async readMemoryCard(slot: 1 | 2): Promise<Uint8Array> {
        this.calls.push(`card:${slot}`);
        return this.cards[slot].slice();
    }
    async serializeState(): Promise<Uint8Array> { this.calls.push("serialize"); return new Uint8Array([5, 6]); }
    async unserializeState(bytes: Uint8Array): Promise<void> {
        this.calls.push(`unserialize:${[...bytes].join(",")}`);
        this.cards[2][0] = 7;
    }
    async exit(): Promise<void> {
        this.calls.push("exit");
        this.exitListeners.forEach((listener) => listener());
    }
    onTick(): Unsubscribe { return () => undefined; }
    onSound(_listener: Listener<PsxSoundEvent>): Unsubscribe { return () => undefined; }
    onRumble(_listener: Listener<PsxRumbleEvent>): Unsubscribe { return () => undefined; }
    onFrame(listener: Listener<PsxFrameEvent>): Unsubscribe {
        this.frameListeners.add(listener);
        if (this.replayFrame) listener({
            width: 2, height: 1, aspectRatio: 2,
            rgba: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]),
        });
        return () => this.frameListeners.delete(listener);
    }
    onExit(listener: Listener<void>): Unsubscribe {
        this.exitListeners.add(listener);
        return () => this.exitListeners.delete(listener);
    }
}

class FakeAdapter implements PsxAdapter {
    readonly type = "fake";
    readonly starts: PsxStartConfig[] = [];
    readonly sessions: FakeSession[] = [];
    replayFrame = true;
    failStart = false;
    async start(config: PsxStartConfig): Promise<PsxSession> {
        this.starts.push(config);
        if (this.failStart) throw new Error("adapter start failed");
        const session = new FakeSession(config.memoryCards);
        session.replayFrame = this.replayFrame;
        this.sessions.push(session);
        return session;
    }
}

class FakeDisplay {
    hasFrame = false;
    frames = 0;
    detached = 0;
    destroyed = 0;
    unsubscribe: Unsubscribe | null = null;
    failAttach = false;
    attach(session: PsxSession): Unsubscribe {
        this.hasFrame = false;
        this.unsubscribe = session.onFrame(() => { this.frames++; this.hasFrame = true; });
        if (this.failAttach) throw new Error("display attach failed");
        return this.unsubscribe;
    }
    detach(): void { this.unsubscribe?.(); this.unsubscribe = null; this.detached++; }
    destroy(): void { this.destroyed++; }
}

class FakeAudio {
    resets = 0;
    destroyed = 0;
    resetQueue(): void { this.resets++; }
    destroy(): void { this.destroyed++; }
}

class FakeStorage {
    readonly cards = new Map<string, PsxMemoryCardRecord>();
    readonly states = new Map<string, PsxStateRecord>();
    saves = 0;
    failLoad = false;

    key(profileId: string, cardId: string): string { return `${profileId}:${cardId}`; }
    async loadMemoryCard(profileId: string, cardId: string): Promise<PsxMemoryCardRecord | null> {
        if (this.failLoad) throw new Error("card load failed");
        const value = this.cards.get(this.key(profileId, cardId));
        return value === undefined ? null : { ...value, bytes: value.bytes.slice() };
    }
    async saveMemoryCard(config: PsxMemoryCardSaveConfig): Promise<PsxMemoryCardRecord> {
        const key = this.key(config.profileId, config.cardId);
        const current = this.cards.get(key);
        if ((current?.revision ?? null) !== config.expectedRevision) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.STORAGE_FAILED, message: "conflict",
        });
        const record = {
            profileId: config.profileId,
            cardId: config.cardId,
            revision: (current?.revision ?? 0) + 1,
            updatedAt: "2026-01-01T00:00:00.000Z",
            bytes: config.bytes.slice(),
        };
        this.cards.set(key, record);
        this.saves++;
        return { ...record, bytes: record.bytes.slice() };
    }
    async saveState(config: PsxStateSaveConfig): Promise<PsxStateRecord> {
        const record: PsxStateRecord = {
            profileId: config.profileId,
            name: config.name,
            metadata: {
                format: "psx-runtime-state", version: 1, adapter: "libretro-psx",
                buildId: config.machine.buildId, core: config.machine.core,
                coreVersion: config.machine.coreVersion, gameId: config.machine.gameId,
                discIndex: config.discIndex, createdAt: "2026-01-01T00:00:00.000Z",
            },
            payload: config.payload.slice(),
        };
        this.states.set(`${config.profileId}:${config.machine.gameId}:${config.name}`, record);
        return record;
    }
    async loadState(config: PsxStateLoadConfig): Promise<PsxStateRecord | null> {
        return this.states.get(`${config.profileId}:${config.machine.gameId}:${config.name}`) ?? null;
    }
    async deleteState(profileId: string, gameId: string, name: string): Promise<void> {
        this.states.delete(`${profileId}:${gameId}:${name}`);
    }
}

class ManualIntervals {
    readonly handles = new Set<() => void>();
    failSet = false;
    setInterval(callback: () => void): unknown {
        if (this.failSet) throw new Error("timer start failed");
        this.handles.add(callback);
        return callback;
    }
    clearInterval(handle: unknown): void { this.handles.delete(handle as () => void); }
}

const bytes = (value: number): Uint8Array => {
    const result = new Uint8Array(128 * 1024);
    result.fill(value);
    return result;
};

const codeOf = async (operation: () => unknown | Promise<unknown>): Promise<number | null> => {
    try { await operation(); return null; } catch (error) {
        return PsxRuntimeError.is(error) ? error.code : -1;
    }
};

const testFile: TestFile = {
    label: "M8 player lifecycle",
    cases: [
        {
            label: "player composes frames, input, audio, cards, states, discs and reusable lifecycle",
            run: () => CTGTest.init("player")
                .stage("exercise player", async () => {
                    const adapter = new FakeAdapter();
                    const display = new FakeDisplay();
                    const storage = new FakeStorage();
                    const intervals = new ManualIntervals();
                    await storage.saveMemoryCard({
                        profileId: "main", cardId: "one", expectedRevision: null, bytes: bytes(1),
                    });
                    await storage.saveMemoryCard({
                        profileId: "main", cardId: "two", expectedRevision: null, bytes: bytes(2),
                    });
                    const audios: FakeAudio[] = [];
                    const config = {
                        adapter,
                        display,
                        createAudio: () => { const audio = new FakeAudio(); audios.push(audio); return audio; },
                        storage,
                        profileId: "main",
                        memoryCardIds: { 1: "one", 2: "two" },
                        intervalScheduler: intervals,
                    } as const;
                    const player = new PsxPlayer(config);
                    const statuses: string[] = [];
                    player.on("status", (status) => statuses.push(status));
                    await player.start({ game, bios });
                    const first = adapter.sessions[0]!;
                    const initialCards = [first.cards[1][0], first.cards[2][0]];
                    player.input!.press({ port: 1, button: "cross" });
                    first.cards[1].fill(3);
                    await player.pause();
                    player.resume();
                    const state = await player.saveState("slot");
                    await player.setDisc(1);
                    await player.loadState("slot");
                    await player.reset("soft");
                    const downloaded = await player.downloadMemoryCard(2);
                    await player.deleteState("slot");
                    await player.stop();
                    const replacement = await player.replaceMemoryCard(1, bytes(8));
                    await player.start({ game, bios });
                    const second = adapter.sessions[1]!;
                    const restartedCard = second.cards[1][0];
                    await player.stop();
                    const audioSummary = audios.map((audio) => [audio.resets, audio.destroyed]);
                    await player.destroy();
                    const destroyed = await codeOf(() => player.start({ game, bios }));
                    return {
                        valid: isPsxPlayerConfig(config),
                        initialCards,
                        state: [state.name, state.metadata.discIndex, [...state.payload]],
                        calls: first.calls.filter((call) => !call.startsWith("card:")),
                        downloaded: downloaded[0],
                        replacement: [replacement.revision, replacement.bytes[0]],
                        restartedCard,
                        statuses,
                        displayExposed: player.display === display,
                        display: [display.frames, display.detached, display.destroyed],
                        audioSummary,
                        timers: intervals.handles.size,
                        destroyed,
                    };
                })
                .assert("player behavior", ({ subject }) => subject, P.equals<unknown>({
                    valid: true,
                    initialCards: [1, 2],
                    state: ["slot", 0, [5, 6]],
                    calls: [
                        "button:1:cross:true",
                        "button:1:cross:false",
                        "pause",
                        "resume",
                        "serialize",
                        "disc:1",
                        "pause",
                        "disc:0",
                        "unserialize:5,6",
                        "resume",
                        "reset:soft",
                        "pause",
                        "exit",
                    ],
                    downloaded: 7,
                    replacement: [3, 8],
                    restartedCard: 8,
                    statuses: [
                        "starting", "running", "paused", "running", "stopping", "idle",
                        "starting", "running", "stopping", "idle", "destroyed",
                    ],
                    displayExposed: true,
                    display: [2, 3, 1],
                    audioSummary: [[5, 1], [1, 1]],
                    timers: 0,
                    destroyed: 11,
                }))
                .start(undefined),
        },
        {
            label: "startup failure unwinds the graph and leaves the same player reusable",
            run: () => CTGTest.init("player rollback")
                .stage("fail then retry", async () => {
                    const adapter = new FakeAdapter();
                    adapter.replayFrame = false;
                    const display = new FakeDisplay();
                    const audios: FakeAudio[] = [];
                    const player = new PsxPlayer({
                        adapter,
                        display,
                        createAudio: () => { const audio = new FakeAudio(); audios.push(audio); return audio; },
                    });
                    const failure = await codeOf(() => player.start({ game, bios }));
                    const afterFailure = {
                        status: player.status,
                        exits: adapter.sessions[0]!.calls.filter((call) => call === "exit").length,
                        detached: display.detached,
                        audios: audios.length,
                    };
                    adapter.replayFrame = true;
                    await player.start({ game, bios });
                    const duplicate = await codeOf(() => player.start({ game, bios }));
                    await player.stop();
                    await player.destroy();
                    return { failure, afterFailure, duplicate, final: player.status };
                })
                .assert("rollback behavior", ({ subject }) => subject, P.equals<unknown>({
                    failure: 8,
                    afterFailure: { status: "idle", exits: 1, detached: 1, audios: 0 },
                    duplicate: 10,
                    final: "destroyed",
                }))
                .start(undefined),
        },
        {
            label: "every startup phase unwinds listeners, timers, audio and session ownership",
            run: () => CTGTest.init("startup phase matrix")
                .stage("fail each phase", async () => {
                    const results = [];
                    for (const phase of [
                        "card-load", "adapter", "display", "first-frame",
                        "audio-create", "audio-validate", "timer",
                    ] as const) {
                        const adapter = new FakeAdapter();
                        const display = new FakeDisplay();
                        const storage = new FakeStorage();
                        const intervals = new ManualIntervals();
                        const audios: FakeAudio[] = [];
                        if (phase === "card-load") storage.failLoad = true;
                        if (phase === "adapter") adapter.failStart = true;
                        if (phase === "display") display.failAttach = true;
                        if (phase === "first-frame") adapter.replayFrame = false;
                        if (phase === "timer") intervals.failSet = true;
                        const createAudio = phase === "audio-create"
                            ? () => { throw new Error("audio create failed"); }
                            : phase === "audio-validate"
                                ? (() => ({})) as unknown as () => FakeAudio
                                : () => {
                                    const audio = new FakeAudio();
                                    audios.push(audio);
                                    return audio;
                                };
                        const player = new PsxPlayer({
                            adapter,
                            display,
                            createAudio,
                            storage,
                            profileId: "release",
                            memoryCardIds: { 1: "one", 2: "two" },
                            intervalScheduler: intervals,
                        });
                        const failure = await codeOf(() => player.start({ game, bios }));
                        const session = adapter.sessions[0];
                        results.push({
                            phase,
                            failed: failure !== null,
                            status: player.status,
                            sessions: adapter.sessions.length,
                            exits: session?.calls.filter((call) => call === "exit").length ?? 0,
                            frameListeners: session?.frameListeners.size ?? 0,
                            exitListeners: session?.exitListeners.size ?? 0,
                            displayAttached: display.unsubscribe !== null,
                            timers: intervals.handles.size,
                            audioLive: audios.filter((audio) => audio.destroyed === 0).length,
                            writes: storage.saves,
                        });
                        await player.destroy();
                    }
                    return results;
                })
                .assert("all phases are clean", ({ subject }) => subject, P.equals<unknown>([
                    { phase: "card-load", failed: true, status: "idle", sessions: 0, exits: 0,
                        frameListeners: 0, exitListeners: 0, displayAttached: false, timers: 0,
                        audioLive: 0, writes: 0 },
                    { phase: "adapter", failed: true, status: "idle", sessions: 0, exits: 0,
                        frameListeners: 0, exitListeners: 0, displayAttached: false, timers: 0,
                        audioLive: 0, writes: 0 },
                    { phase: "display", failed: true, status: "idle", sessions: 1, exits: 1,
                        frameListeners: 0, exitListeners: 0, displayAttached: false, timers: 0,
                        audioLive: 0, writes: 0 },
                    { phase: "first-frame", failed: true, status: "idle", sessions: 1, exits: 1,
                        frameListeners: 0, exitListeners: 0, displayAttached: false, timers: 0,
                        audioLive: 0, writes: 0 },
                    { phase: "audio-create", failed: true, status: "idle", sessions: 1, exits: 1,
                        frameListeners: 0, exitListeners: 0, displayAttached: false, timers: 0,
                        audioLive: 0, writes: 0 },
                    { phase: "audio-validate", failed: true, status: "idle", sessions: 1, exits: 1,
                        frameListeners: 0, exitListeners: 0, displayAttached: false, timers: 0,
                        audioLive: 0, writes: 0 },
                    { phase: "timer", failed: true, status: "idle", sessions: 1, exits: 1,
                        frameListeners: 0, exitListeners: 0, displayAttached: false, timers: 0,
                        audioLive: 0, writes: 0 },
                ]))
                .start(undefined),
        },
    ],
};

export default testFile;
