import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";
import {
    isPsxStateRecord,
    isPsxStorageConfig,
    PsxRuntimeError,
    PsxStorage,
} from "../../src/index.ts";
import PsxCardAutoSave from "../../src/PsxStorage/PsxCardAutoSave.ts";

import type {
    Listener,
    PsxFrameEvent,
    PsxMachineInfo,
    PsxRumbleEvent,
    PsxSession,
    PsxSoundEvent,
    PsxStorageDriverLike,
    PsxStorageMutation,
    PsxStorageStore,
    Unsubscribe,
} from "../../src/index.ts";
import type { TestFile } from "../run.ts";

const machine: PsxMachineInfo = {
    core: "PCSX-ReARMed",
    coreVersion: "1.0",
    buildId: "d".repeat(64),
    gameId: "storage-game",
    region: "ntsc-u",
    framesPerSecond: 60,
    sampleRate: 44_100,
    geometry: { width: 320, height: 240, aspectRatio: 4 / 3 },
    maxWidth: 1024,
    maxHeight: 512,
    firmware: "bios",
    controllers: { 1: "digital", 2: "digital" },
    discCount: 2,
};

class MemoryDriver implements PsxStorageDriverLike {
    readonly stores: Record<PsxStorageStore, Map<string, unknown>> = {
        cards: new Map(),
        states: new Map(),
    };

    async read(store: PsxStorageStore, key: string): Promise<unknown> {
        const value = this.stores[store].get(key);
        return value === undefined ? undefined : structuredClone(value);
    }

    async write(store: PsxStorageStore, key: string, value: unknown): Promise<void> {
        this.stores[store].set(key, structuredClone(value));
    }

    async remove(store: PsxStorageStore, key: string): Promise<void> {
        this.stores[store].delete(key);
    }

    async list(store: PsxStorageStore): Promise<ReadonlyArray<unknown>> {
        return [...this.stores[store].values()].map((value) => structuredClone(value));
    }

    async update<T>(
        store: PsxStorageStore,
        key: string,
        updater: (current: unknown) => PsxStorageMutation<unknown, T>,
    ): Promise<T> {
        const current = this.stores[store].get(key);
        const mutation = updater(current === undefined ? undefined : structuredClone(current));
        if (mutation.delete === true) this.stores[store].delete(key);
        else this.stores[store].set(key, structuredClone(mutation.value));
        return structuredClone(mutation.result);
    }
}

class FakeSession implements PsxSession {
    readonly machine = machine;
    readonly discIndex = 0;
    readonly trayOpen = false;
    readonly cards = {
        1: new Uint8Array(128 * 1024),
        2: new Uint8Array(128 * 1024),
    };
    gate: Promise<void> | null = null;

    setButton(): void {}
    setAxis(): void {}
    pause(): void {}
    resume(): void {}
    async reset(): Promise<void> {}
    async setDisc(): Promise<void> {}
    async serializeState(): Promise<Uint8Array> { return new Uint8Array([1]); }
    async unserializeState(): Promise<void> {}
    async exit(): Promise<void> {}
    onTick(): Unsubscribe { return () => undefined; }
    onFrame(_listener: Listener<PsxFrameEvent>): Unsubscribe { return () => undefined; }
    onSound(_listener: Listener<PsxSoundEvent>): Unsubscribe { return () => undefined; }
    onRumble(_listener: Listener<PsxRumbleEvent>): Unsubscribe { return () => undefined; }
    onExit(): Unsubscribe { return () => undefined; }

    async readMemoryCard(slot: 1 | 2): Promise<Uint8Array> {
        const snapshot = this.cards[slot].slice();
        const gate = this.gate;
        this.gate = null;
        if (gate !== null) await gate;
        return snapshot;
    }
}

class ManualIntervalScheduler {
    readonly callbacks = new Set<() => void>();
    setInterval(callback: () => void): object {
        this.callbacks.add(callback);
        return callback;
    }
    clearInterval(handle: unknown): void { this.callbacks.delete(handle as () => void); }
}

const card = (value: number): Uint8Array => {
    const bytes = new Uint8Array(128 * 1024);
    bytes.fill(value);
    return bytes;
};

const codeOf = async (action: () => Promise<unknown>): Promise<number | null> => {
    try {
        await action();
        return null;
    } catch (error) {
        return PsxRuntimeError.is(error) ? error.code : -1;
    }
};

const testFile: TestFile = {
    label: "M7 persistent cards, states and auto-save",
    cases: [
        {
            label: "memory-card writes use optimistic revisions and retain the recoverable prior revision",
            run: () => CTGTest.init("memory cards")
                .stage("write revisions", async () => {
                    const driver = new MemoryDriver();
                    let now = Date.UTC(2026, 0, 1);
                    const storage = new PsxStorage({ driver, now: () => now++ });
                    const first = await storage.saveMemoryCard({
                        profileId: " player ", cardId: " shared ", expectedRevision: null, bytes: card(1),
                    });
                    const tabOne = await storage.loadMemoryCard("player", "shared");
                    const tabTwo = await storage.loadMemoryCard("player", "shared");
                    tabOne!.bytes[0] = 99;
                    const second = await storage.saveMemoryCard({
                        profileId: "player", cardId: "shared", expectedRevision: tabOne!.revision, bytes: card(2),
                    });
                    let conflictData: unknown = null;
                    const conflict = await codeOf(async () => {
                        try {
                            await storage.saveMemoryCard({
                                profileId: "player", cardId: "shared",
                                expectedRevision: tabTwo!.revision, bytes: card(3),
                            });
                        } catch (error) {
                            conflictData = PsxRuntimeError.is(error) ? error.data : null;
                            throw error;
                        }
                    });
                    const revisions = await storage.loadMemoryCardRevisions("player", "shared");
                    const loaded = await storage.loadMemoryCard("player", "shared");
                    await storage.deleteMemoryCard("player", "shared");
                    return {
                        config: isPsxStorageConfig({ driver, now: () => now }),
                        first: [first.profileId, first.cardId, first.revision, first.bytes[0]],
                        second: [second.revision, second.bytes[0]],
                        loaded: [loaded!.revision, loaded!.bytes[0]],
                        conflict,
                        conflictData,
                        revisions: revisions.map(({ revision, bytes }) => [revision, bytes[0]]),
                        deleted: await storage.loadMemoryCard("player", "shared"),
                    };
                })
                .assert("card behavior", ({ subject }) => subject, P.equals<unknown>({
                    config: true,
                    first: ["player", "shared", 1, 1],
                    second: [2, 2],
                    loaded: [2, 2],
                    conflict: 14,
                    conflictData: {
                        type: "revision-conflict",
                        profileId: "player",
                        cardId: "shared",
                        expectedRevision: 1,
                        actualRevision: 2,
                    },
                    revisions: [[2, 2], [1, 1]],
                    deleted: null,
                }))
                .start(undefined),
        },
        {
            label: "state names normalize while build, core and game identity remain exact",
            run: () => CTGTest.init("states")
                .stage("store state", async () => {
                    const driver = new MemoryDriver();
                    const storage = new PsxStorage({ driver, now: () => Date.UTC(2026, 5, 2, 3, 4, 5) });
                    const saved = await storage.saveState({
                        profileId: " main ",
                        name: "  Cafe\u0301  ",
                        machine,
                        discIndex: 1,
                        payload: new Uint8Array([4, 5, 6]),
                    });
                    const loaded = await storage.loadState({ profileId: "main", name: "Café", machine });
                    loaded!.payload[0] = 99;
                    const loadedAgain = await storage.loadState({ profileId: "main", name: "Café", machine });
                    const wrongBuild = await codeOf(() => storage.loadState({
                        profileId: "main",
                        name: "Café",
                        machine: { ...machine, buildId: "e".repeat(64) },
                    }));
                    const key = JSON.stringify(["main", machine.gameId, "Café"]);
                    const raw = driver.stores.states.get(key) as { metadata: { gameId: string } };
                    raw.metadata.gameId = "other-game";
                    driver.stores.states.set(key, raw);
                    const wrongGame = await codeOf(() => storage.loadState({
                        profileId: "main", name: "Café", machine,
                    }));
                    driver.stores.states.set(key, structuredClone(saved));
                    const listed = await storage.listStates("main", machine.gameId);
                    const invalidName = await codeOf(() => storage.saveState({
                        profileId: "main", name: "bad\u0001name", machine, discIndex: 0,
                        payload: new Uint8Array([1]),
                    }));
                    await storage.deleteState("main", machine.gameId, "Café");
                    return {
                        validRecord: isPsxStateRecord(saved),
                        identity: [saved.profileId, saved.name, saved.metadata.format,
                            saved.metadata.version, saved.metadata.adapter],
                        metadata: [saved.metadata.buildId, saved.metadata.gameId,
                            saved.metadata.discIndex, saved.metadata.createdAt],
                        defensivePayload: [...loadedAgain!.payload],
                        wrongBuild,
                        wrongGame,
                        listed: listed.map(({ name }) => name),
                        invalidName,
                        deleted: await storage.loadState({ profileId: "main", name: "Café", machine }),
                    };
                })
                .assert("state behavior", ({ subject }) => subject, P.equals<unknown>({
                    validRecord: true,
                    identity: ["main", "Café", "psx-runtime-state", 1, "libretro-psx"],
                    metadata: ["d".repeat(64), "storage-game", 1, "2026-06-02T03:04:05.000Z"],
                    defensivePayload: [4, 5, 6],
                    wrongBuild: 16,
                    wrongGame: 16,
                    listed: ["Café"],
                    invalidName: 1,
                    deleted: null,
                }))
                .start(undefined),
        },
        {
            label: "auto-save skips clean cards, coalesces overlap and keeps its baseline on conflict",
            run: () => CTGTest.init("auto-save")
                .stage("flush cards", async () => {
                    const driver = new MemoryDriver();
                    let now = Date.UTC(2026, 0, 1);
                    const storage = new PsxStorage({ driver, now: () => now++ });
                    const initialOne = await storage.saveMemoryCard({
                        profileId: "main", cardId: "one", expectedRevision: null, bytes: card(1),
                    });
                    const initialTwo = await storage.saveMemoryCard({
                        profileId: "main", cardId: "two", expectedRevision: null, bytes: card(2),
                    });
                    const session = new FakeSession();
                    session.cards[1].set(initialOne.bytes);
                    session.cards[2].set(initialTwo.bytes);
                    const scheduler = new ManualIntervalScheduler();
                    const errors: number[] = [];
                    const autoSave = new PsxCardAutoSave({
                        storage,
                        session,
                        profileId: "main",
                        cards: {
                            1: { cardId: "one", revision: 1, bytes: initialOne.bytes },
                            2: { cardId: "two", revision: 1, bytes: initialTwo.bytes },
                        },
                        scheduler,
                        onError: (error) => errors.push(PsxRuntimeError.is(error) ? error.code : -1),
                    });
                    autoSave.start();
                    await autoSave.flush();
                    session.cards[1].fill(3);
                    await autoSave.flush();
                    let release!: () => void;
                    session.gate = new Promise<void>((resolve) => { release = resolve; });
                    session.cards[1].fill(4);
                    const firstFlush = autoSave.flush();
                    await Promise.resolve();
                    session.cards[1].fill(5);
                    const followUp = autoSave.flush();
                    release();
                    await Promise.all([firstFlush, followUp]);
                    const afterOverlap = await storage.loadMemoryCard("main", "one");
                    const external = await storage.saveMemoryCard({
                        profileId: "main", cardId: "one",
                        expectedRevision: afterOverlap!.revision, bytes: card(9),
                    });
                    session.cards[1].fill(6);
                    const conflict = await codeOf(() => autoSave.flush());
                    const history = await storage.loadMemoryCardRevisions("main", "one");
                    await autoSave.stop(false);
                    autoSave.destroy();
                    return {
                        afterOverlap: [afterOverlap!.revision, afterOverlap!.bytes[0]],
                        external: [external.revision, external.bytes[0]],
                        conflict,
                        errors,
                        baseline: autoSave.revisions,
                        history: history.map(({ revision, bytes }) => [revision, bytes[0]]),
                        timers: scheduler.callbacks.size,
                    };
                })
                .assert("auto-save behavior", ({ subject }) => subject, P.equals<unknown>({
                    afterOverlap: [4, 5],
                    external: [5, 9],
                    conflict: 14,
                    errors: [14],
                    baseline: { 1: 4, 2: 1 },
                    history: [[5, 9], [4, 5]],
                    timers: 0,
                }))
                .start(undefined),
        },
    ],
};

export default testFile;
