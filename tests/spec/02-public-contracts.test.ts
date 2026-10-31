import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";
import {
    isAuditedDisc,
    isBiosImage,
    isControllerPort,
    isDiscFile,
    isDiscPath,
    isDiscSet,
    isFetchResponseLike,
    isFrameScheduler,
    isPsxAdapter,
    isPsxAxis,
    isPsxAxisControl,
    isPsxBuildInfo,
    isPsxButton,
    isPsxButtonControl,
    isPsxControllerType,
    isPsxFrameEvent,
    isPsxGeometry,
    isPsxMachineInfo,
    isPsxOptions,
    isPsxRegion,
    isPsxRumbleEvent,
    isPsxSession,
    isPsxSoundEvent,
    isPsxStartConfig,
} from "../../src/index.ts";

import type { PsxBuildInfo, PsxMachineInfo, PsxSession } from "../../src/index.ts";
import type { TestFile } from "../run.ts";

const blob = new Blob([new Uint8Array([1])]);
const buildId = "a".repeat(64);
const commit = "b".repeat(40);

const game = {
    gameId: "fixture-v1",
    entry: "disc/game.cue",
    files: [
        { path: "disc/game.cue", blob },
        { path: "disc/track01.bin", blob },
    ],
};

const bios = { name: "Firmware", region: "ntsc-u", blob, sha256: "c".repeat(64) };

const audited = {
    entry: "disc/game.cue",
    discs: [{
        cue: "disc/game.cue",
        tracks: [{ file: "disc/track01.bin", kind: "data", bytes: 1 }],
    }],
    totalBytes: 1,
    warnings: [],
};

const machine: PsxMachineInfo = {
    core: "PCSX-ReARMed",
    coreVersion: "1",
    buildId,
    gameId: "fixture-v1",
    region: "ntsc-u",
    framesPerSecond: 60,
    sampleRate: 44_100,
    geometry: { width: 320, height: 240, aspectRatio: 4 / 3 },
    maxWidth: 1024,
    maxHeight: 512,
    firmware: "bios",
    controllers: { 1: "dualshock", 2: "digital" },
    discCount: 2,
};

const unsubscribe = (): void => undefined;
const session: PsxSession = {
    machine,
    discIndex: 0,
    trayOpen: false,
    setButton: () => undefined,
    setAxis: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    reset: async () => undefined,
    setDisc: async () => undefined,
    readMemoryCard: async () => new Uint8Array(128 * 1024),
    serializeState: async () => new Uint8Array(),
    unserializeState: async () => undefined,
    exit: async () => undefined,
    onTick: () => unsubscribe,
    onFrame: () => unsubscribe,
    onSound: () => unsubscribe,
    onRumble: () => unsubscribe,
    onExit: () => unsubscribe,
};

const build: PsxBuildInfo = {
    formatVersion: 1,
    adapter: "libretro-psx",
    buildId,
    core: "PCSX-ReARMed",
    coreVersion: "1",
    coreCommit: commit,
    emsdkVersion: "6.0.2",
    artifacts: ["psx-core.js", "psx-core.wasm", "core.worker.js"],
    supportedContent: ["cue", "m3u", "sbi"],
    controllerTypes: ["none", "digital", "dualshock"],
    firmware: {
        required: true,
        byteLengths: [524_288],
        systemFilenames: {
            "ntsc-u": "scph5501.bin",
            "ntsc-j": "scph5500.bin",
            pal: "scph5502.bin",
        },
    },
    memory: { initialPages: 1024, maximumPages: 8192 },
    pthreads: false,
    licenses: [{ id: "GPL-2.0-or-later", notice: "notices/COPYING.txt" }],
};

const withKey = (value: object, key: string, replacement: unknown): unknown => ({
    ...value,
    [key]: replacement,
});

const testFile: TestFile = {
    label: "M1 public contracts",
    cases: [
        {
            label: "literal vocabularies and injected dependency boundaries validate structurally",
            run: () => CTGTest.init("vocabularies")
                .assert("accepted and rejected values", () => ({
                    regions: ["ntsc-u", "ntsc-j", "pal", "PAL"].map(isPsxRegion),
                    ports: [1, 2, 0, 3].map(isControllerPort),
                    controllers: ["none", "digital", "dualshock", "analog"].map(isPsxControllerType),
                    buttons: ["cross", "l3", "coin"].map(isPsxButton),
                    axes: ["left-x", "right-y", "z"].map(isPsxAxis),
                    scheduler: [
                        isFrameScheduler({ request: () => 1, cancel: () => undefined }),
                        isFrameScheduler({ request: () => 1 }),
                    ],
                    response: [
                        isFetchResponseLike({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }),
                        isFetchResponseLike({ ok: true, status: 600, arrayBuffer: async () => new ArrayBuffer(0) }),
                    ],
                }), P.equals({
                    regions: [true, true, true, false],
                    ports: [true, true, false, false],
                    controllers: [true, true, true, false],
                    buttons: [true, true, false],
                    axes: [true, true, false],
                    scheduler: [true, false],
                    response: [true, false],
                }))
                .start(undefined),
        },
        {
            label: "disc paths reject every unsafe path form",
            run: () => CTGTest.init("disc paths")
                .assert("only normalized relative POSIX paths pass", () => [
                    "disc/game.cue", "game.cue", "", " game.cue", "/game.cue", "C:/game.cue",
                    "https://example.test/game.cue", "disc\\game.cue", "disc//game.cue",
                    "disc/./game.cue", "disc/../game.cue", "disc/\u0000game.cue",
                ].map(isDiscPath), P.equals<boolean[]>([
                    true, true, false, false, false, false, false, false, false, false, false, false,
                ]))
                .start(undefined),
        },
        {
            label: "content and firmware contracts enforce identity, uniqueness, sizes, and limits",
            run: () => CTGTest.init("content")
                .assert("valid examples and one-field failures", () => ({
                    discFile: [
                        isDiscFile(game.files[0]),
                        isDiscFile({ path: "/bad", blob }),
                        isDiscFile({ path: "good", blob: new Uint8Array() }),
                    ],
                    set: [
                        isDiscSet(game),
                        isDiscSet(withKey(game, "gameId", " ")),
                        isDiscSet(withKey(game, "entry", "missing.cue")),
                        isDiscSet(withKey(game, "files", [])),
                        isDiscSet(withKey(game, "files", [...game.files, { path: "DISC/GAME.CUE", blob }])),
                        isDiscSet(withKey(game, "files", Array.from({ length: 65 }, (_, index) => ({ path: `f${index}`, blob })))),
                    ],
                    bios: [
                        isBiosImage(bios),
                        isBiosImage(withKey(bios, "name", "")),
                        isBiosImage(withKey(bios, "region", "ntsc")),
                        isBiosImage(withKey(bios, "sha256", "ABC")),
                    ],
                    audit: [
                        isAuditedDisc(audited),
                        isAuditedDisc(withKey(audited, "discs", [])),
                        isAuditedDisc(withKey(audited, "discs", Array.from({ length: 9 }, (_, index) => ({
                            cue: `disc${index}.cue`, tracks: [{ file: `track${index}.bin`, kind: "data", bytes: 1 }],
                        })))),
                        isAuditedDisc(withKey(audited, "totalBytes", 0)),
                    ],
                }), P.equals({
                    discFile: [true, false, false],
                    set: [true, false, false, false, false, false],
                    bios: [true, false, false, false],
                    audit: [true, false, false, false],
                }))
                .start(undefined),
        },
        {
            label: "input, geometry, frame, sound, and rumble event boundaries reject malformed values",
            run: () => CTGTest.init("events")
                .assert("event verdicts", () => ({
                    button: [isPsxButtonControl({ port: 1, button: "cross" }), isPsxButtonControl({ port: 3, button: "cross" })],
                    axis: [isPsxAxisControl({ port: 2, axis: "right-y" }), isPsxAxisControl({ port: 2, axis: "z" })],
                    geometry: [isPsxGeometry(machine.geometry), isPsxGeometry({ width: 0, height: 240, aspectRatio: 4 / 3 }), isPsxGeometry({ width: 320, height: 240, aspectRatio: Infinity })],
                    frame: [
                        isPsxFrameEvent({ width: 2, height: 1, aspectRatio: 2, rgba: new Uint8ClampedArray(8) }),
                        isPsxFrameEvent({ width: 2, height: 1, aspectRatio: 2, rgba: new Uint8ClampedArray(4) }),
                    ],
                    sound: [
                        isPsxSoundEvent({ frames: 2, samples: new Float32Array(4) }),
                        isPsxSoundEvent({ frames: 2, samples: new Float32Array(2) }),
                        isPsxSoundEvent({ frames: -1, samples: new Float32Array() }),
                    ],
                    rumble: [
                        isPsxRumbleEvent({ port: 1, strong: 0, weak: 1 }),
                        isPsxRumbleEvent({ port: 1, strong: -0.1, weak: 0 }),
                        isPsxRumbleEvent({ port: 1, strong: 0, weak: 1.1 }),
                    ],
                }), P.equals({
                    button: [true, false], axis: [true, false], geometry: [true, false, false],
                    frame: [true, false], sound: [true, false, false], rumble: [true, false, false],
                }))
                .start(undefined),
        },
        {
            label: "machine, startup, session, and adapter contracts validate their complete boundaries",
            run: () => CTGTest.init("runtime")
                .assert("runtime verdicts", () => ({
                    machine: [
                        isPsxMachineInfo(machine),
                        isPsxMachineInfo(withKey(machine, "buildId", "bad")),
                        isPsxMachineInfo(withKey(machine, "maxWidth", 100)),
                        isPsxMachineInfo(withKey(machine, "controllers", { 1: "digital" })),
                        isPsxMachineInfo(withKey(machine, "discCount", 9)),
                    ],
                    options: [isPsxOptions({ frameskip: false, level: 2, mode: "safe" }), isPsxOptions({ level: NaN }), isPsxOptions({ "": true })],
                    start: [
                        isPsxStartConfig({ game, bios }),
                        isPsxStartConfig({ game, bios, controllers: { 1: "digital" }, memoryCards: { 2: new Uint8Array(128 * 1024) } }),
                        isPsxStartConfig({ game, bios, controllers: { 3: "digital" } }),
                        isPsxStartConfig({ game, bios, memoryCards: { 1: new Uint8Array(2) } }),
                    ],
                    session: [isPsxSession(session), isPsxSession(withKey(session, "discIndex", 2)), isPsxSession(withKey(session, "exit", null))],
                    adapter: [isPsxAdapter({ type: "libretro-psx", start: async () => session }), isPsxAdapter({ type: "", start: async () => session })],
                }), P.equals({
                    machine: [true, false, false, false, false],
                    options: [true, false, false],
                    start: [true, true, false, false],
                    session: [true, false, false],
                    adapter: [true, false],
                }))
                .start(undefined),
        },
        {
            label: "build metadata accepts the complete production shape and rejects each material boundary",
            run: () => CTGTest.init("build metadata")
                .assert("metadata verdicts", () => [
                    build,
                    withKey(build, "formatVersion", 2),
                    withKey(build, "adapter", "libretro"),
                    withKey(build, "buildId", "a".repeat(63)),
                    withKey(build, "core", ""),
                    withKey(build, "coreCommit", "b".repeat(39)),
                    withKey(build, "artifacts", ["psx-core.js", "psx-core.js"]),
                    withKey(build, "supportedContent", ["cue", "cue"]),
                    withKey(build, "controllerTypes", ["analog"]),
                    withKey(build, "firmware", { ...build.firmware, required: false }),
                    withKey(build, "firmware", { ...build.firmware, byteLengths: [0] }),
                    withKey(build, "firmware", { ...build.firmware, systemFilenames: { ...build.firmware.systemFilenames, pal: "bad/name" } }),
                    withKey(build, "memory", { initialPages: 8192, maximumPages: 1024 }),
                    withKey(build, "pthreads", true),
                    withKey(build, "licenses", []),
                ].map(isPsxBuildInfo), P.equals<boolean[]>([
                    true, false, false, false, false, false, false, false, false, false, false, false,
                    false, false, false,
                ]))
                .start(undefined),
        },
    ],
};

export default testFile;
