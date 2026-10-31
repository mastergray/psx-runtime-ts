import { createHash } from "node:crypto";
import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";
import {
    DiscSetAudit,
    isPsxStoredGame,
    PsxGameStore,
    PsxRuntimeError,
} from "../../src/index.ts";
import Sha256 from "../../src/PsxGameStore/Sha256.ts";

import type {
    DiscSet,
    PsxBlobHasherLike,
    PsxGameStoreDriverLike,
} from "../../src/index.ts";
import type { TestFile } from "../run.ts";

class MemoryGameDriver implements PsxGameStoreDriverLike {
    readonly records = new Map<string, unknown>();
    writes = 0;
    failWrite = false;

    async read(gameId: string): Promise<unknown> { return this.records.get(gameId); }
    async list(): Promise<ReadonlyArray<unknown>> { return [...this.records.values()]; }
    async write(gameId: string, value: unknown): Promise<void> {
        if (this.failWrite) throw new Error("quota exceeded");
        this.writes++;
        this.records.set(gameId, value);
    }
    async remove(gameId: string): Promise<void> { this.records.delete(gameId); }
    async update<T>(gameId: string, updater: (current: unknown) => {
        readonly value: unknown;
        readonly result: T;
    }): Promise<T> {
        const mutation = updater(this.records.get(gameId));
        this.records.set(gameId, mutation.value);
        return mutation.result;
    }
}

class StreamingHasher implements PsxBlobHasherLike {
    calls = 0;
    maxChunk = 0;

    async hash(blob: Blob, signal?: AbortSignal): Promise<string> {
        this.calls++;
        const hash = createHash("sha256");
        for (let offset = 0; offset < blob.size; offset += 64 * 1024) {
            if (signal?.aborted === true) throw new Error("cancelled");
            const value = new Uint8Array(await blob.slice(offset, offset + 64 * 1024).arrayBuffer());
            this.maxChunk = Math.max(this.maxChunk, value.byteLength);
            hash.update(value);
        }
        return hash.digest("hex");
    }
}

const makeSet = (directory: string, cueName: string, trackName: string, bytes: Uint8Array): DiscSet => ({
    gameId: `${directory}-display`,
    entry: `${directory}/${cueName}`,
    files: [
        {
            path: `${directory}/${cueName}`,
            blob: new Blob([`FILE "${trackName}" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:00:00\n`]),
        },
        { path: `${directory}/${trackName}`, blob: new Blob([Uint8Array.from(bytes).buffer]) },
    ],
});

const errorDetails = async (operation: () => Promise<unknown>): Promise<{
    readonly code: number | null;
    readonly data: unknown;
}> => {
    try {
        await operation();
        return { code: null, data: null };
    } catch (error) {
        return PsxRuntimeError.is(error) ? { code: error.code, data: error.data } : { code: -1, data: null };
    }
};

const testFile: TestFile = {
    label: "M9 content-addressed game library",
    cases: [
        {
            label: "incremental SHA-256 remains correct across arbitrary chunk boundaries",
            run: () => CTGTest.init("sha256")
                .stage("hash vectors", () => {
                    const lengths = [0, 1, 55, 56, 57, 63, 64, 65, 1024, 65_537];
                    return lengths.map((length) => {
                        const bytes = Uint8Array.from({ length }, (_, index) => index % 251);
                        const subject = new Sha256();
                        for (let offset = 0; offset < bytes.length; offset += 17) {
                            subject.update(bytes.subarray(offset, offset + 17));
                        }
                        return subject.digestHex() === createHash("sha256").update(bytes).digest("hex");
                    });
                })
                .assert("all vectors", ({ subject }) => subject, P.equals([true, true, true, true, true,
                    true, true, true, true, true]))
                .start(undefined),
        },
        {
            label: "large Blob imports normalize names, deduplicate and retain Blob-backed content",
            run: () => CTGTest.init("game store")
                .stage("import and manage", async () => {
                    const bytes = new Uint8Array(4 * 1024 * 1024);
                    for (let index = 0; index < bytes.length; index += 4093) bytes[index] = index & 0xff;
                    const first = makeSet("first", "alpha.cue", "alpha.bin", bytes);
                    const second = makeSet("renamed", "different.cue", "different.bin", bytes);
                    const driver = new MemoryGameDriver();
                    const hasher = new StreamingHasher();
                    const store = new PsxGameStore({
                        driver,
                        hasher,
                        now: () => Date.UTC(2026, 9, 30, 12),
                        storageManager: { estimate: async () => ({ usage: 1_000, quota: 20_000_000 }) },
                    });
                    const imported = await store.import(first, { displayTitle: "  Alpha  " });
                    const duplicate = await store.import(second, { displayTitle: "Other name" });
                    const game = await store.get(imported.gameId);
                    const audit = await DiscSetAudit.audit(game!);
                    const track = game!.files.find(({ path }) => path.endsWith(".bin"))!;
                    const record = driver.records.get(imported.gameId) as { game: DiscSet };
                    const storedTrack = record.game.files.find(({ path }) => path.endsWith(".bin"))!;
                    const renamed = await store.renameDisplayTitle(imported.gameId, "Renamed");
                    const listed = await store.list();
                    await store.delete(imported.gameId);
                    return {
                        valid: isPsxStoredGame(imported),
                        ids: [imported.gameId.startsWith("psx-v1-"),
                            duplicate.gameId.startsWith("psx-v1-"), imported.gameId === duplicate.gameId],
                        writes: driver.writes,
                        canonical: [game!.entry, game!.files.map(({ path }) => path)],
                        audit: audit.ok,
                        blobBacked: [track.blob instanceof Blob, storedTrack.blob === first.files[1]!.blob],
                        streaming: [hasher.calls, hasher.maxChunk < bytes.byteLength],
                        renamed: [renamed.displayTitle, listed[0]!.displayTitle],
                        deleted: await store.get(imported.gameId),
                    };
                })
                .assert("library behavior", ({ subject }) => subject, P.equals<unknown>({
                    valid: true,
                    ids: [true, true, true],
                    writes: 1,
                    canonical: ["disc-000.cue", ["disc-000.cue", "track-000.bin"]],
                    audit: true,
                    blobBacked: [true, true],
                    streaming: [4, true],
                    renamed: ["Renamed", "Renamed"],
                    deleted: null,
                }))
                .start(undefined),
        },
        {
            label: "audit, cancellation, quota and failed commits leave no partial record",
            run: () => CTGTest.init("atomic failures")
                .stage("fail each phase", async () => {
                    const set = makeSet("content", "game.cue", "track.bin", new Uint8Array(1024));
                    const quotaDriver = new MemoryGameDriver();
                    const quota = new PsxGameStore({
                        driver: quotaDriver,
                        hasher: new StreamingHasher(),
                        now: Date.now,
                        storageManager: { estimate: async () => ({ usage: 90, quota: 100 }) },
                    });
                    const quotaError = await errorDetails(() => quota.import(set));
                    const cancelledDriver = new MemoryGameDriver();
                    const cancelled = new PsxGameStore({
                        driver: cancelledDriver, hasher: new StreamingHasher(), now: Date.now,
                    });
                    const controller = new AbortController();
                    controller.abort();
                    const cancelledError = await errorDetails(() => cancelled.import(set, {
                        signal: controller.signal,
                    }));
                    const invalidDriver = new MemoryGameDriver();
                    const invalid = new PsxGameStore({
                        driver: invalidDriver, hasher: new StreamingHasher(), now: Date.now,
                    });
                    const invalidError = await errorDetails(() => invalid.import({
                        ...set,
                        files: set.files.slice(0, 1),
                    }));
                    const failedDriver = new MemoryGameDriver();
                    failedDriver.failWrite = true;
                    const failed = new PsxGameStore({
                        driver: failedDriver,
                        hasher: new StreamingHasher(),
                        now: Date.now,
                        storageManager: { estimate: async () => ({ usage: 20, quota: 10_000 }) },
                    });
                    const commitError = await errorDetails(() => failed.import(set));
                    return {
                        quota: {
                            code: quotaError.code,
                            data: quotaError.data,
                            requiredExceedsAvailable: (quotaError.data as { requiredBytes: number }).requiredBytes > 10,
                        },
                        cancelled: cancelledError,
                        invalid: invalidError.code,
                        commit: {
                            code: commitError.code,
                            data: commitError.data,
                            requiredPositive: (commitError.data as { requiredBytes: number }).requiredBytes > 0,
                        },
                        sizes: [quotaDriver.records.size, cancelledDriver.records.size,
                            invalidDriver.records.size, failedDriver.records.size],
                    };
                })
                .assert("failure behavior", ({ subject }) => subject, P.equals<unknown>({
                    quota: {
                        code: 14,
                        data: { type: "quota", requiredBytes: 1_090, availableBytes: 10 },
                        requiredExceedsAvailable: true,
                    },
                    cancelled: { code: 14, data: { type: "cancelled" } },
                    invalid: 6,
                    commit: {
                        code: 14,
                        data: {
                            type: "quota",
                            requiredBytes: 1_090,
                            availableBytes: 9_980,
                            cause: "quota exceeded",
                        },
                        requiredPositive: true,
                    },
                    sizes: [0, 0, 0, 0],
                }))
                .start(undefined),
        },
    ],
};

export default testFile;
