import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";
import { DiscSetAudit } from "../../src/index.ts";
import {
    applyMountPlan,
    createMountPlan,
} from "../../src/worker/MountPlan.ts";

import type { DiscSet } from "../../src/index.ts";
import type {
    EmscriptenFsLike,
    MountPlan,
} from "../../src/worker/MountPlan.ts";
import type { TestFile } from "../run.ts";

class ObservedBlob extends Blob {
    reads = 0;
    readonly denyRead: boolean;
    readonly declaredSize?: number;

    constructor(parts: BlobPart[], options: { denyRead?: boolean; declaredSize?: number } = {}) {
        super(parts);
        this.denyRead = options.denyRead ?? false;
        this.declaredSize = options.declaredSize;
    }

    override get size(): number {
        return this.declaredSize ?? super.size;
    }

    override async arrayBuffer(): Promise<ArrayBuffer> {
        this.reads++;
        if (this.denyRead) throw new Error("track arrayBuffer must not be called");
        return super.arrayBuffer();
    }
}

class RecordingFs implements EmscriptenFsLike {
    readonly directories: string[] = [];
    readonly mounts: Array<{
        type: unknown;
        mountpoint: string;
        blobs: ReadonlyArray<{ readonly name: string; readonly data: Blob }>;
    }> = [];
    readonly writes: Array<{ path: string; bytes: Uint8Array }> = [];

    mkdir(path: string): void {
        this.directories.push(path);
    }

    mount(
        type: unknown,
        options: { readonly blobs: ReadonlyArray<{ readonly name: string; readonly data: Blob }> },
        mountpoint: string,
    ): void {
        this.mounts.push({ type, mountpoint, blobs: options.blobs });
    }

    writeFile(path: string, bytes: Uint8Array): void {
        this.writes.push({ path, bytes });
    }
}

const decoder = new TextDecoder();
const cue = (track: string): string => [
    "REM normalized by the planner",
    "FILE \"" + track + "\" BINARY",
    "  TRACK 01 MODE2/2352",
    "    INDEX 01 00:00:00",
    "",
].join("\r\n");

const largeOne = new ObservedBlob([], { denyRead: true, declaredSize: 700 * 1024 * 1024 });
const largeTwo = new ObservedBlob([], { denyRead: true, declaredSize: 650 * 1024 * 1024 });
const sidecar = new ObservedBlob([new Uint8Array([9, 8, 7])]);
const playlist = new ObservedBlob(["disc one/game one.cue\ndisc-two/game-two.cue\n"]);
const cueOne = new ObservedBlob([cue("large original one.bin")]);
const cueTwo = new ObservedBlob([cue("large-original-two.bin")]);

const game: DiscSet = {
    gameId: "mount-fixture",
    entry: "library/list.m3u",
    files: [
        { path: "library/list.m3u", blob: playlist },
        { path: "library/disc one/game one.cue", blob: cueOne },
        { path: "library/disc one/large original one.bin", blob: largeOne },
        { path: "library/disc one/game one.sbi", blob: sidecar },
        { path: "library/disc-two/game-two.cue", blob: cueTwo },
        { path: "library/disc-two/large-original-two.bin", blob: largeTwo },
    ],
};

const makePlan = async (): Promise<MountPlan> => {
    const result = await DiscSetAudit.audit(game);
    if (!result.ok) throw new Error("mount fixture did not audit");
    return createMountPlan(game, result.audit);
};

const testFile: TestFile = {
    label: "M3 mount plan",
    cases: [
        {
            label: "generated descriptors expose only flat deterministic content names",
            run: () => CTGTest.init("mount-plan generation")
                .stage("create plan", async () => {
                    const plan = await makePlan();
                    const descriptors = Object.fromEntries(plan.descriptors.map(({ path, bytes }) => [
                        path,
                        decoder.decode(bytes),
                    ]));
                    return {
                        entryPath: plan.entryPath,
                        trackNames: plan.tracks.map(({ name }) => name),
                        trackIdentity: [
                            plan.tracks[0]?.blob === largeOne,
                            plan.tracks[1]?.blob === largeTwo,
                        ],
                        descriptorPaths: plan.descriptors.map(({ path }) => path),
                        descriptors,
                        sidecars: plan.sidecars.map(({ path, blob }) => ({ path, identity: blob === sidecar })),
                        reads: {
                            tracks: [largeOne.reads, largeTwo.reads],
                            playlist: playlist.reads,
                            cues: [cueOne.reads, cueTwo.reads],
                            sidecar: sidecar.reads,
                        },
                    };
                })
                .assert("deterministic generated names", ({ subject }) => subject, P.equals<unknown>({
                    entryPath: "/content/index/game.m3u",
                    trackNames: ["track-000.bin", "track-001.bin"],
                    trackIdentity: [true, true],
                    descriptorPaths: [
                        "/content/index/disc-000.cue",
                        "/content/index/disc-001.cue",
                        "/content/index/game.m3u",
                    ],
                    descriptors: {
                        "/content/index/disc-000.cue": [
                            "REM normalized by the planner",
                            "FILE \"../blob/track-000.bin\" BINARY",
                            "  TRACK 01 MODE2/2352",
                            "    INDEX 01 00:00:00",
                            "",
                        ].join("\n"),
                        "/content/index/disc-001.cue": [
                            "REM normalized by the planner",
                            "FILE \"../blob/track-001.bin\" BINARY",
                            "  TRACK 01 MODE2/2352",
                            "    INDEX 01 00:00:00",
                            "",
                        ].join("\n"),
                        "/content/index/game.m3u": "disc-000.cue\ndisc-001.cue\n",
                    },
                    sidecars: [{ path: "/content/index/disc-000.sbi", identity: true }],
                    reads: {
                        tracks: [0, 0],
                        playlist: 1,
                        cues: [2, 2],
                        sidecar: 0,
                    },
                }))
                .start(undefined),
        },
        {
            label: "WORKERFS receives original track Blobs while MEMFS receives only small generated files",
            run: () => CTGTest.init("mount-plan application")
                .stage("apply plan", async () => {
                    const before = {
                        tracks: [largeOne.reads, largeTwo.reads],
                        sidecar: sidecar.reads,
                    };
                    const plan = await makePlan();
                    const fs = new RecordingFs();
                    const workerFs = { kind: "WORKERFS" };
                    await applyMountPlan(fs, workerFs, plan);
                    return {
                        directories: fs.directories,
                        mountpoint: fs.mounts[0]?.mountpoint,
                        workerFsIdentity: fs.mounts[0]?.type === workerFs,
                        mounted: fs.mounts[0]?.blobs.map(({ name, data }) => ({
                            name,
                            identity: data === largeOne || data === largeTwo,
                        })),
                        writes: fs.writes.map(({ path, bytes }) => ({ path, size: bytes.byteLength })),
                        readDelta: {
                            tracks: [largeOne.reads - before.tracks[0]!, largeTwo.reads - before.tracks[1]!],
                            sidecar: sidecar.reads - before.sidecar,
                        },
                    };
                })
                .assert("zero-copy track boundary", ({ subject }) => subject, P.equals<unknown>({
                    directories: ["/content", "/content/blob", "/content/index"],
                    mountpoint: "/content/blob",
                    workerFsIdentity: true,
                    mounted: [
                        { name: "track-000.bin", identity: true },
                        { name: "track-001.bin", identity: true },
                    ],
                    writes: [
                        { path: "/content/index/disc-000.cue", size: 110 },
                        { path: "/content/index/disc-001.cue", size: 110 },
                        { path: "/content/index/game.m3u", size: 26 },
                        { path: "/content/index/disc-000.sbi", size: 3 },
                    ],
                    readDelta: { tracks: [0, 0], sidecar: 1 },
                }))
                .start(undefined),
        },
    ],
};

export default testFile;
