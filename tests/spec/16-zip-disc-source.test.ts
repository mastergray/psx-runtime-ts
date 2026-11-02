import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";
import { strToU8, zipSync } from "fflate";

import {
    DiscSetAudit,
    PsxConsole,
    PsxRuntimeError,
    ZipDiscSource,
    ZipFirmwareSource,
} from "../../src/index.ts";

import type { PsxLocalFileLike } from "../../src/index.ts";
import type { TestFile } from "../run.ts";

const namedBlob = (name: string, contents: BlobPart | Uint8Array): PsxLocalFileLike => {
    const part = contents instanceof Uint8Array ? Uint8Array.from(contents).buffer : contents;
    const blob = new Blob([part]) as PsxLocalFileLike;
    Object.defineProperty(blob, "name", { value: name, enumerable: true });
    return blob;
};

const archive = (entries: Parameters<typeof zipSync>[0]): PsxLocalFileLike =>
    namedBlob("diagnostics.zip", zipSync(entries));

const cue = (track: string): Uint8Array => strToU8([
    `FILE "${track}" BINARY`,
    "TRACK 01 MODE2/2352",
    "INDEX 01 00:00:00",
    "",
].join("\n"));

const diagnostics = (): PsxLocalFileLike => archive({
    "psx-runtime-diagnostics.m3u": strToU8("controller/controller-test.cue\naudio/audio-test.cue\n"),
    controller: {
        "controller-test.cue": cue("controller-test.bin"),
        "controller-test.bin": new Uint8Array([1, 2, 3]),
    },
    audio: {
        "audio-test.cue": cue("audio-test.bin"),
        "audio-test.bin": new Uint8Array([4, 5, 6]),
    },
});

const capture = async (action: () => Promise<unknown>): Promise<unknown> => {
    try {
        await action();
        return null;
    } catch (error) {
        return error;
    }
};

const errorSnapshot = (error: unknown): unknown => PsxRuntimeError.is(error)
    ? { label: error.label, message: error.message }
    : error;

const testFile: TestFile = {
    label: "ZIP disc source",
    cases: [
        {
            label: "a ZIP containing an M3U and two nested discs resolves and audits like raw files",
            run: () => CTGTest.init("diagnostic archive")
                .stage("resolve and audit", async () => {
                    const game = await PsxConsole.resolveFiles([diagnostics()], { gameId: "diagnostics" });
                    const result = await DiscSetAudit.audit(game);
                    return {
                        entry: game.entry,
                        paths: game.files.map(({ path }) => path),
                        sizes: game.files.map(({ blob }) => blob.size),
                        audit: result.ok ? [result.audit.discs.length, result.audit.totalBytes] : result.issues,
                    };
                })
                .assert("canonical archive content", ({ subject }) => subject, P.equals<unknown>({
                    entry: "psx-runtime-diagnostics.m3u",
                    paths: [
                        "psx-runtime-diagnostics.m3u",
                        "controller/controller-test.cue",
                        "controller/controller-test.bin",
                        "audio/audio-test.cue",
                        "audio/audio-test.bin",
                    ],
                    sizes: [52, 72, 3, 67, 3],
                    audit: [2, 6],
                }))
                .start(undefined),
        },
        {
            label: "unsafe paths, case-folded duplicates, corrupt data and mixed selections fail explicitly",
            run: () => CTGTest.init("archive rejection")
                .stage("capture failures", async () => {
                    const failures = await Promise.all([
                        capture(() => ZipDiscSource.extract(archive({ "../escape.cue": strToU8("x") }))),
                        capture(() => ZipDiscSource.extract(archive({
                            "Game.cue": strToU8("x"),
                            "game.CUE": strToU8("y"),
                        }))),
                        capture(() => ZipDiscSource.extract(namedBlob("broken.zip", new Uint8Array([1, 2, 3])))),
                        capture(() => PsxConsole.resolveFiles([
                            diagnostics(),
                            namedBlob("extra.cue", cue("extra.bin")),
                        ], { gameId: "mixed" })),
                    ]);
                    return failures.map(errorSnapshot);
                })
                .assert("typed archive errors", ({ subject }) => subject, P.equals<unknown>([
                    { label: "ARCHIVE_INVALID", message: "The ZIP archive contains an unsafe or non-normalized path." },
                    { label: "ARCHIVE_INVALID", message: "The ZIP archive contains duplicate paths when case-folded." },
                    { label: "ARCHIVE_INVALID", message: "The selected ZIP archive is malformed or truncated." },
                    { label: "ARCHIVE_INVALID", message: "Select one ZIP archive by itself, or select the extracted disc files without a ZIP." },
                ]))
                .start(undefined),
        },
        {
            label: "raw selections retain their existing normalization path",
            run: () => CTGTest.init("raw compatibility")
                .stage("resolve", async () => {
                    const game = await PsxConsole.resolveFiles([
                        namedBlob("game.cue", cue("game.bin")),
                        namedBlob("game.bin", new Uint8Array([7])),
                    ], { gameId: "raw" });
                    return [game.gameId, game.entry, game.files.map(({ path }) => path)];
                })
                .assert("unchanged raw shape", ({ subject }) => subject, P.equals<unknown>([
                    "raw", "game.cue", ["game.cue", "game.bin"],
                ]))
                .start(undefined),
        },
        {
            label: "a firmware ZIP resolves exactly one image with a supported byte length",
            run: () => CTGTest.init("firmware archive")
                .stage("resolve and reject candidates", async () => {
                    const firmware = new Uint8Array(512 * 1024);
                    firmware[0] = 7;
                    const resolved = await ZipFirmwareSource.extract(archive({
                        "notes.txt": strToU8("user supplied"),
                        "system/firmware.bin": firmware,
                    }), [512 * 1024]);
                    const failures = await Promise.all([
                        capture(() => ZipFirmwareSource.extract(archive({
                            "small.bin": new Uint8Array(1024),
                        }), [512 * 1024])),
                        capture(() => ZipFirmwareSource.extract(archive({
                            "one.bin": firmware,
                            "two.bin": firmware,
                        }), [512 * 1024])),
                    ]);
                    const regional = await ZipFirmwareSource.extract(archive({
                        "firmware-us.bin": firmware,
                        "firmware-jp.bin": firmware,
                    }), [512 * 1024], "ntsc-u");
                    return {
                        resolved: [resolved.name, resolved.blob.size,
                            new Uint8Array(await resolved.blob.slice(0, 1).arrayBuffer())[0]],
                        failures: failures.map(errorSnapshot),
                        regional: [regional.name, regional.blob.size],
                    };
                })
                .assert("one supported image", ({ subject }) => subject, P.equals<unknown>({
                    resolved: ["firmware.bin", 524_288, 7],
                    failures: [
                        { label: "BIOS_INVALID", message: "The firmware ZIP does not contain an image with a supported byte length." },
                        { label: "BIOS_INVALID", message: "The firmware ZIP contains more than one image with a supported byte length." },
                    ],
                    regional: ["firmware-us.bin", 524_288],
                }))
                .start(undefined),
        },
    ],
};

export default testFile;
