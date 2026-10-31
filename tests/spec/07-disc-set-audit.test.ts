import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";
import {
    DiscSetAudit,
    isDiscSetAuditResult,
    isDiscSetIssue,
    PsxRuntimeError,
} from "../../src/index.ts";

import type { DiscSet, DiscSetAuditResult } from "../../src/index.ts";
import type { TestFile } from "../run.ts";

const bytes = (values: BlobPart[]): Blob => new Blob(values);
const text = (value: string): Blob => bytes([value]);
const file = (path: string, blob: Blob): { path: string; blob: Blob } => ({ path, blob });
const set = (entry: string, files: DiscSet["files"]): DiscSet => ({ gameId: "audit-fixture", entry, files });
const errorCodes = (result: DiscSetAuditResult): string[] => result.issues
    .filter(({ severity }) => severity === "error")
    .map(({ code }) => code);

const directCue = [
    "\ufeffFILE \"disc image.bin\" BINARY",
    "  TRACK 01 MODE2/2352",
    "    INDEX 01 00:00:00",
    "  TRACK 02 AUDIO",
    "    INDEX 00 00:02:00",
    "    INDEX 01 00:04:00",
    "",
].join("\r\n");

const validSet = set("media/Game.cue", [
    file("media/Game.cue", text(directCue)),
    file("media/disc image.bin", bytes([new Uint8Array([1, 2, 3, 4])])),
    file("media/Game.sbi", bytes([new Uint8Array([5, 6])])),
    file("notes.txt", text("unused")),
]);

const simpleCue = (track: string): string => [
    "FILE \"" + track + "\" BINARY",
    "  TRACK 01 MODE2/2352",
    "    INDEX 01 00:00:00",
    "",
].join("\n");

const invalidResult = async (cue: string, trackFiles: DiscSet["files"] = []): Promise<DiscSetAuditResult> =>
    DiscSetAudit.audit(set("game.cue", [file("game.cue", text(cue)), ...trackFiles]));

const captureAsync = async (action: () => Promise<unknown>): Promise<unknown> => {
    try {
        await action();
        return null;
    } catch (error) {
        return error;
    }
};

const testFile: TestFile = {
    label: "M3 disc-set audit",
    cases: [
        {
            label: "a BOM CUE supports shared multi-track media, audio, and a same-basename SBI",
            run: () => CTGTest.init("valid CUE")
                .stage("audit", () => DiscSetAudit.audit(validSet))
                .assert("normalized audit", ({ subject }) => subject.ok ? {
                    predicate: isDiscSetAuditResult(subject),
                    entry: subject.audit.entry,
                    discs: subject.audit.discs,
                    totalBytes: subject.audit.totalBytes,
                    issues: subject.issues.map(({ severity, code, path }) => ({ severity, code, path })),
                } : subject, P.equals<unknown>({
                    predicate: true,
                    entry: "media/Game.cue",
                    discs: [{
                        cue: "media/Game.cue",
                        tracks: [
                            { file: "media/disc image.bin", kind: "data", bytes: 4 },
                            { file: "media/disc image.bin", kind: "audio", bytes: 4 },
                        ],
                        sbi: "media/Game.sbi",
                    }],
                    totalBytes: 4,
                    issues: [{ severity: "warning", code: "unreferenced-file", path: "notes.txt" }],
                }))
                .start(undefined),
        },
        {
            label: "M3U comments and relative CUEs preserve public disc order",
            run: () => {
                const playlist = set("collection/game.m3u", [
                    file("collection/game.m3u", text("# ordered discs\nfirst/disc.cue\n\nsecond/disc.cue\n")),
                    file("collection/first/disc.cue", text(simpleCue("track.bin"))),
                    file("collection/first/track.bin", bytes([new Uint8Array([1, 2])])),
                    file("collection/second/disc.cue", text(simpleCue("track.bin").replace("\"track.bin\"", "track.bin"))),
                    file("collection/second/track.bin", bytes([new Uint8Array([3, 4, 5])])),
                ]);
                return CTGTest.init("valid M3U")
                    .stage("audit", () => DiscSetAudit.audit(playlist))
                    .assert("disc ordering", ({ subject }) => subject.ok ? {
                        cues: subject.audit.discs.map(({ cue }) => cue),
                        tracks: subject.audit.discs.map(({ tracks }) => tracks[0]?.file),
                        totalBytes: subject.audit.totalBytes,
                        issues: subject.issues,
                    } : subject, P.equals<unknown>({
                        cues: ["collection/first/disc.cue", "collection/second/disc.cue"],
                        tracks: ["collection/first/track.bin", "collection/second/track.bin"],
                        totalBytes: 5,
                        issues: [],
                    }))
                    .start(undefined);
            },
        },
        {
            label: "unsafe, missing, mismatched-case, and duplicate paths are reported without short-circuiting",
            run: () => CTGTest.init("path failures")
                .stage("audit variants", async () => {
                    const [unsafe, missing, mismatch, duplicates] = await Promise.all([
                        invalidResult(simpleCue("../track.bin"), [file("track.bin", bytes(["x"]))]),
                        invalidResult(simpleCue("missing.bin")),
                        invalidResult(simpleCue("TRACK.BIN"), [file("track.bin", bytes(["x"]))]),
                        DiscSetAudit.audit(set("game.cue", [
                            file("game.cue", text(simpleCue("track.bin"))),
                            file("track.bin", bytes(["x"])),
                            file("TRACK.BIN", bytes(["y"])),
                        ])),
                    ]);
                    return [unsafe, missing, mismatch, duplicates].map(errorCodes);
                })
                .assert("ordered error codes", ({ subject }) => subject, P.equals<string[][]>([
                    ["invalid-path", "cue-syntax"],
                    ["missing-file", "cue-syntax"],
                    ["case-mismatch"],
                    ["duplicate-path"],
                ]))
                .start(undefined),
        },
        {
            label: "descriptor byte, encoding, control, and CUE grammar limits fail explicitly",
            run: () => CTGTest.init("descriptor limits")
                .stage("audit variants", async () => {
                    const oversized = new Blob([new Uint8Array(256 * 1024 + 1)]);
                    const variants = await Promise.all([
                        DiscSetAudit.audit(set("game.cue", [file("game.cue", oversized)])),
                        DiscSetAudit.audit(set("game.cue", [file("game.cue", bytes([new Uint8Array([0xff])]))])),
                        invalidResult(simpleCue("track.bin") + "\u0000", [file("track.bin", bytes(["x"]))]),
                        invalidResult(" ".repeat(1025) + "\n"),
                        invalidResult("FILE track.bin WAVE\nTRACK 01 MODE9/9999\nINDEX 02 00:99:99\n", [
                            file("track.bin", new Blob([])),
                        ]),
                        invalidResult("FILE track.bin BINARY\nTRACK 02 MODE2/2352\nINDEX 01 00:00:00\nINDEX 00 00:00:00\n", [
                            file("track.bin", bytes(["x"])),
                        ]),
                    ]);
                    return variants.map(errorCodes);
                })
                .assert("specific failures", ({ subject }) => subject, P.equals<string[][]>([
                    ["descriptor-too-large"],
                    ["invalid-utf8"],
                    ["control-character"],
                    ["cue-line-too-long", "cue-syntax"],
                    ["unsupported-file-type", "empty-track", "unsupported-track-mode", "index-order", "missing-index"],
                    ["track-order", "index-order"],
                ]))
                .start(undefined),
        },
        {
            label: "M3U cardinality, uniqueness, nesting, and reference constraints are enforced",
            run: () => CTGTest.init("M3U failures")
                .stage("audit variants", async () => {
                    const cueFiles = Array.from({ length: 9 }, (_, index) => [
                        file("d" + index + ".cue", text(simpleCue("d" + index + ".bin"))),
                        file("d" + index + ".bin", bytes([String(index)])),
                    ]).flat();
                    const entries = Array.from({ length: 9 }, (_, index) => "d" + index + ".cue").join("\n") + "\n";
                    const variants = await Promise.all([
                        DiscSetAudit.audit(set("game.m3u", [file("game.m3u", text("# none\n"))])),
                        DiscSetAudit.audit(set("game.m3u", [
                            file("game.m3u", text("other.m3u\n")), file("other.m3u", text("")),
                        ])),
                        DiscSetAudit.audit(set("game.m3u", [
                            file("game.m3u", text("d0.cue\nd0.cue\n")), ...cueFiles.slice(0, 2),
                        ])),
                        DiscSetAudit.audit(set("game.m3u", [
                            file("game.m3u", text(entries)), ...cueFiles,
                        ])),
                        DiscSetAudit.audit(set("game.m3u", [file("game.m3u", text("https://invalid.test/disc.cue\n"))])),
                    ]);
                    return variants.map(errorCodes);
                })
                .assert("specific failures", ({ subject }) => subject, P.equals<string[][]>([
                    ["m3u-empty"],
                    ["nested-playlist", "m3u-empty"],
                    ["duplicate-disc"],
                    ["too-many-discs"],
                    ["invalid-path", "m3u-empty"],
                ]))
                .start(undefined),
        },
        {
            label: "file and track cardinality limits produce stable audit issues",
            run: () => CTGTest.init("cardinality limits")
                .stage("audit variants", async () => {
                    const extraFiles = Array.from({ length: 63 }, (_, index) =>
                        file("unused-" + index + ".bin", bytes(["x"])));
                    const tracks = Array.from({ length: 100 }, (_, index) => {
                        const number = index + 1;
                        return "TRACK " + number + " MODE2/2352\nINDEX 01 " + number + ":00:00";
                    }).join("\n");
                    const variants = await Promise.all([
                        DiscSetAudit.audit(set("game.cue", [
                            file("game.cue", text(simpleCue("track.bin"))),
                            file("track.bin", bytes(["x"])),
                            ...extraFiles,
                        ])),
                        invalidResult("FILE track.bin BINARY\n" + tracks + "\n", [
                            file("track.bin", bytes(["x"])),
                        ]),
                    ]);
                    return variants.map(errorCodes);
                })
                .assert("limit failures", ({ subject }) => subject, P.equals<string[][]>([
                    ["too-many-files"],
                    ["too-many-tracks", "track-order"],
                ]))
                .start(undefined),
        },
        {
            label: "result predicates and malformed-call rejection keep the public boundary discriminated",
            run: () => CTGTest.init("audit boundary")
                .stage("capture", async () => ({
                    failure: await invalidResult(simpleCue("missing.bin")),
                    thrown: await captureAsync(() => DiscSetAudit.audit({ gameId: "", entry: "x", files: [] })),
                }))
                .assert("boundary behavior", ({ subject }) => ({
                    failurePredicate: isDiscSetAuditResult(subject.failure),
                    issues: subject.failure.issues.every(isDiscSetIssue),
                    error: PsxRuntimeError.is(subject.thrown)
                        ? { code: subject.thrown.code, label: subject.thrown.label }
                        : null,
                    malformedResults: [
                        isDiscSetAuditResult({ ok: false, issues: [] }),
                        isDiscSetAuditResult({ ok: true, issues: subject.failure.issues }),
                    ],
                }), P.equals<unknown>({
                    failurePredicate: true,
                    issues: true,
                    error: { code: 1, label: "INVALID_CONFIG" },
                    malformedResults: [false, false],
                }))
                .start(undefined),
        },
    ],
};

export default testFile;
