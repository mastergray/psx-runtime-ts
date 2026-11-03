import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";
import { deflateSync, strFromU8, strToU8, zipSync } from "fflate";

import {
    DiscSetAudit,
    MultiZipDiscSource,
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

const archive = (entries: Parameters<typeof zipSync>[0], name = "diagnostics.zip"): PsxLocalFileLike =>
    namedBlob(name, zipSync(entries));

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

const crc32 = (bytes: Uint8Array): number => {
    let value = 0xffffffff;
    for (const byte of bytes) {
        value ^= byte;
        for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
};

const descriptorArchive = (path: string, contents: Uint8Array): PsxLocalFileLike => {
    const name = strToU8(path);
    const compressed = deflateSync(contents, { level: 0 });
    const localBytes = 30 + name.byteLength + compressed.byteLength + 16;
    const centralBytes = 46 + name.byteLength;
    const bytes = new Uint8Array(localBytes + centralBytes + 22);
    const view = new DataView(bytes.buffer);
    const checksum = crc32(contents);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 8, true);
    view.setUint16(8, 8, true);
    view.setUint16(26, name.byteLength, true);
    bytes.set(name, 30);
    bytes.set(compressed, 30 + name.byteLength);
    const descriptor = 30 + name.byteLength + compressed.byteLength;
    view.setUint32(descriptor, 0x08074b50, true);
    view.setUint32(descriptor + 4, checksum, true);
    view.setUint32(descriptor + 8, compressed.byteLength, true);
    view.setUint32(descriptor + 12, contents.byteLength, true);
    const central = localBytes;
    view.setUint32(central, 0x02014b50, true);
    view.setUint16(central + 4, 20, true);
    view.setUint16(central + 6, 20, true);
    view.setUint16(central + 8, 8, true);
    view.setUint16(central + 10, 8, true);
    view.setUint32(central + 16, checksum, true);
    view.setUint32(central + 20, compressed.byteLength, true);
    view.setUint32(central + 24, contents.byteLength, true);
    view.setUint16(central + 28, name.byteLength, true);
    bytes.set(name, central + 46);
    const end = central + centralBytes;
    view.setUint32(end, 0x06054b50, true);
    view.setUint16(end + 8, 1, true);
    view.setUint16(end + 10, 1, true);
    view.setUint32(end + 12, centralBytes, true);
    view.setUint32(end + 16, central, true);
    return namedBlob("descriptor.zip", bytes);
};

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
            label: "data descriptors cannot truncate an entry when their signature occurs inside compressed data",
            run: () => CTGTest.init("descriptor signature collision")
                .stage("extract exact central-directory range", async () => {
                    const contents = strToU8("before-PK\u0007\b-after");
                    const files = await ZipDiscSource.extract(descriptorArchive("collision.bin", contents));
                    return [files[0]?.path, files[0]?.blob.size,
                        strFromU8(new Uint8Array(await files[0]!.blob.arrayBuffer()))];
                })
                .assert("complete entry", ({ subject }) => subject, P.equals<unknown>([
                    "collision.bin", 17, "before-PK\u0007\b-after",
                ]))
                .start(undefined),
        },
        {
            label: "a ZIP containing an M3U and two nested discs resolves and audits like raw files",
            run: () => CTGTest.init("diagnostic archive")
                .stage("resolve and audit", async () => {
                    const archive = diagnostics();
                    const descriptors = await ZipDiscSource.listDescriptors(archive);
                    const manifestText = await ZipDiscSource.readDescriptor(archive, "psx-runtime-diagnostics.m3u");
                    const game = await PsxConsole.resolveFiles([archive], { gameId: "diagnostics" });
                    const result = await DiscSetAudit.audit(game);
                    return {
                        descriptors,
                        manifestText,
                        entry: game.entry,
                        paths: game.files.map(({ path }) => path),
                        sizes: game.files.map(({ blob }) => blob.size),
                        audit: result.ok ? [result.audit.discs.length, result.audit.totalBytes] : result.issues,
                    };
                })
                .assert("canonical archive content", ({ subject }) => subject, P.equals<unknown>({
                    descriptors: [
                        "psx-runtime-diagnostics.m3u",
                        "controller/controller-test.cue",
                        "audio/audio-test.cue",
                    ],
                    manifestText: "controller/controller-test.cue\naudio/audio-test.cue\n",
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
            label: "ordered single-disc ZIPs generate one audited M3U-backed disc set",
            run: () => CTGTest.init("multi-ZIP disc set")
                .stage("inspect and build", async () => {
                    const first = archive({
                        "disc-one.cue": cue("disc-one.bin"),
                        "disc-one.bin": new Uint8Array([1, 2, 3]),
                    }, "Disc One.zip");
                    const second = archive({ nested: {
                        "disc-two.cue": cue("disc-two.bin"),
                        "disc-two.bin": new Uint8Array([4, 5, 6]),
                    } }, "Disc Two.zip");
                    const manifest = await MultiZipDiscSource.inspect([first, second]);
                    const built = await MultiZipDiscSource.build([first, second], { gameId: "combined" });
                    const resolved = await PsxConsole.resolveFiles([first, second], { gameId: "combined" });
                    const audit = await DiscSetAudit.audit(resolved);
                    return {
                        manifest,
                        built: [built.game.gameId, built.game.entry],
                        resolved: [resolved.gameId, resolved.entry, resolved.files.map(({ path }) => path)],
                        audit: audit.ok ? [audit.audit.discs.length, audit.audit.totalBytes] : audit.issues,
                    };
                })
                .assert("ordered combined content", ({ subject }) => subject, P.equals<unknown>({
                    manifest: {
                        name: "multi-disc.m3u",
                        text: "disc-1/disc-one.cue\ndisc-2/nested/disc-two.cue\n",
                        discs: [
                            { archiveName: "Disc One.zip", cuePath: "disc-one.cue", manifestPath: "disc-1/disc-one.cue" },
                            { archiveName: "Disc Two.zip", cuePath: "nested/disc-two.cue", manifestPath: "disc-2/nested/disc-two.cue" },
                        ],
                    },
                    built: ["combined", "multi-disc.m3u"],
                    resolved: ["combined", "multi-disc.m3u", [
                        "multi-disc.m3u",
                        "disc-1/disc-one.cue",
                        "disc-1/disc-one.bin",
                        "disc-2/nested/disc-two.cue",
                        "disc-2/nested/disc-two.bin",
                    ]],
                    audit: [2, 6],
                }))
                .start(undefined),
        },
        {
            label: "multi-ZIP inputs reject playlists, ambiguous discs, mixed files, and excess cardinality",
            run: () => CTGTest.init("multi-ZIP rejection")
                .stage("capture failures", async () => {
                    const single = archive({
                        "game.cue": cue("game.bin"),
                        "game.bin": new Uint8Array([1]),
                    }, "single.zip");
                    const ambiguous = archive({
                        "one.cue": cue("one.bin"), "one.bin": new Uint8Array([1]),
                        "two.cue": cue("two.bin"), "two.bin": new Uint8Array([2]),
                    }, "ambiguous.zip");
                    const failures = await Promise.all([
                        capture(() => MultiZipDiscSource.inspect([diagnostics(), single])),
                        capture(() => MultiZipDiscSource.inspect([ambiguous, single])),
                        capture(() => PsxConsole.resolveFiles([
                            single,
                            namedBlob("extra.cue", cue("extra.bin")),
                        ], { gameId: "mixed" })),
                        capture(() => MultiZipDiscSource.inspect(Array.from({ length: 9 }, () => single))),
                    ]);
                    return failures.map(errorSnapshot);
                })
                .assert("stable multi-ZIP errors", ({ subject }) => subject, P.equals<unknown>([
                    { label: "ARCHIVE_INVALID", message: "Each multi-disc input must be a single-disc ZIP containing exactly one CUE and no M3U." },
                    { label: "ARCHIVE_INVALID", message: "Each multi-disc input must be a single-disc ZIP containing exactly one CUE and no M3U." },
                    { label: "ARCHIVE_INVALID", message: "Do not mix ZIP archives with separately selected disc files." },
                    { label: "ARCHIVE_INVALID", message: "Select between two and eight single-disc ZIP archives." },
                ]))
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
                    { label: "ARCHIVE_INVALID", message: "Do not mix ZIP archives with separately selected disc files." },
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
