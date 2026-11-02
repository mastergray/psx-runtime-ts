// Dependencies:
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Reports archive, firmware, and configuration failures
import {
    isDiscPath,     // Rejects unsafe or non-normalized archive entry paths
    isPsxRegion,    // Validates an optional regional selection
} from "../shared.types.js";

// Type dependencies:
import type { PsxRegion } from "../shared.types.js";               // Supported firmware television region
import type { PsxLocalFileLike } from "../PsxConsole/types.js";    // Browser-compatible archive selected by a caller
import type { PsxFirmwareFile } from "./types.js";                 // Extracted firmware name and immutable blob

const MEBIBYTE = 1024 * 1024;    // Binary byte unit used by extraction limits

// METHOD :: STRING, UNKNOWN? -> psxRuntimeError
// Creates one invalid or unsafe archive error.
const archiveInvalid = (message: string, data?: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.ARCHIVE_INVALID,
    message,
    data,
});

// METHOD :: STRING, UNKNOWN? -> psxRuntimeError
// Creates one unsupported firmware-content error.
const biosInvalid = (message: string, data?: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.BIOS_INVALID,
    message,
    data,
});

// METHOD :: UNKNOWN -> psxRuntimeError
// Creates one extraction-constraint configuration error.
const invalidConfig = (data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.INVALID_CONFIG,
    message: "Firmware byte-length constraints are invalid.",
    data,
});

// METHOD :: UNKNOWN -> STRING
// Converts an arbitrary decompression failure into stable diagnostic text.
const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

// METHOD :: STRING -> STRING
// Returns the final normalized component of an archive path.
const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

// METHOD :: STRING -> psxRegion?
// Infers a firmware region from conventional labels and model numbers.
const regionForName = (name: string): PsxRegion | null => {
    const normalized = name.toLowerCase();
    const token = (pattern: string): boolean => new RegExp(`(?:^|[._ -])(?:${pattern})(?:[._ -]|$)`, "u")
        .test(normalized);
    if (token("us|usa|ntsc[-_ ]?u")) return "ntsc-u";
    if (token("jp|japan|ntsc[-_ ]?j")) return "ntsc-j";
    if (token("eu|eur|europe|pal")) return "pal";
    const model = /(?:scph|dtlh)[-_ ]?(\d{4,5})/u.exec(normalized)?.[1];
    if (model?.endsWith("1") === true) return "ntsc-u";
    if (model?.endsWith("0") === true) return "ntsc-j";
    if (model?.endsWith("2") === true) return "pal";
    return null;
};

/**
 *
 * Class
 *
 */

// Extracts exactly one supported firmware image from a bounded user-supplied ZIP.
export default class ZipFirmwareSource {

    /* Static Fields */
    static readonly MAX_ARCHIVE_BYTES = 8 * MEBIBYTE;     // Maximum compressed bytes accepted from one ZIP
    static readonly MAX_ENTRY_BYTES = 2 * MEBIBYTE;       // Maximum expanded bytes accepted from one entry
    static readonly MAX_EXPANDED_BYTES = 8 * MEBIBYTE;    // Maximum aggregate expanded bytes accepted
    static readonly MAX_FILES = 32;                       // Maximum non-directory entries inspected

    // CONSTRUCTOR :: VOID -> zipFirmwareSource
    // Prevents instances because extraction has no persistent state.
    private constructor() {}

    /**
     *
     * Static Methods
     *
     */

    // METHOD :: {name:STRING} -> BOOLEAN
    // Reports whether a selected file name has the ZIP extension.
    static isArchive(file: Pick<PsxLocalFileLike, "name">): boolean {
        return /\.zip$/iu.test(file.name);
    }

    // METHOD :: psxLocalFileLike, [NUMBER], psxRegion? -> PROMISE(psxFirmwareFile)
    // Streams and validates a bounded ZIP, then selects exactly one supported image.
    static async extract(
        archive: PsxLocalFileLike,
        supportedByteLengths: ReadonlyArray<number>,
        region?: PsxRegion,
    ): Promise<PsxFirmwareFile> {
        if (!Array.isArray(supportedByteLengths) || supportedByteLengths.length === 0
            || !supportedByteLengths.every((value) => Number.isSafeInteger(value) && value > 0)
            || new Set(supportedByteLengths).size !== supportedByteLengths.length) {
            throw invalidConfig(supportedByteLengths);
        }
        if (region !== undefined && !isPsxRegion(region)) throw invalidConfig(region);
        if (!(archive instanceof Blob) || !ZipFirmwareSource.isArchive(archive)) {
            throw archiveInvalid("The selected firmware archive must be a ZIP file.");
        }
        if (archive.size === 0) throw archiveInvalid("The selected firmware ZIP is empty.");
        if (!Number.isSafeInteger(archive.size) || archive.size > ZipFirmwareSource.MAX_ARCHIVE_BYTES) {
            throw archiveInvalid("The selected firmware ZIP exceeds the 8 MiB compressed-size limit.");
        }
        const signatureBytes = new Uint8Array(await archive.slice(0, 4).arrayBuffer());
        const signature = signatureBytes.length === 4
            ? new DataView(signatureBytes.buffer).getUint32(0, true)
            : 0;
        if (signature !== 0x04034b50 && signature !== 0x06054b50) {
            throw archiveInvalid("The selected firmware ZIP is malformed or truncated.");
        }

        const { Unzip, UnzipInflate } = await import("fflate");
        const outputs: Array<Promise<PsxFirmwareFile | null>> = [];
        const pending = new Set<(file: PsxFirmwareFile | null) => void>();
        const seen = new Set<string>();
        let announcedBytes = 0;
        let expandedBytes = 0;
        let failure: PsxRuntimeError | null = null;

        const fail = (message: string, data?: unknown): PsxRuntimeError => {
            const error = archiveInvalid(message, data);
            if (failure === null) {
                failure = error;
                for (const settle of pending) settle(null);
                pending.clear();
            }
            return error;
        };

        const unzip = new Unzip((entry) => {
            if (failure !== null) return;
            const directory = entry.name.endsWith("/");
            const path = directory ? entry.name.slice(0, -1) : entry.name;
            if (!isDiscPath(path)) {
                fail("The firmware ZIP contains an unsafe or non-normalized path.", entry.name);
                entry.terminate();
                return;
            }
            if (directory) {
                entry.ondata = (error) => {
                    if (error !== null) fail("A firmware ZIP directory could not be read.", reasonOf(error));
                };
                entry.start();
                return;
            }
            if (entry.compression !== 0 && entry.compression !== 8) {
                fail("The firmware ZIP uses an unsupported compression method.", entry.compression);
                entry.terminate();
                return;
            }
            const folded = path.toLowerCase();
            if (seen.has(folded)) {
                fail("The firmware ZIP contains duplicate paths when case-folded.", path);
                entry.terminate();
                return;
            }
            seen.add(folded);
            if (seen.size > ZipFirmwareSource.MAX_FILES) {
                fail("The firmware ZIP contains more than 32 files.");
                entry.terminate();
                return;
            }
            if (entry.originalSize !== undefined) {
                if (!Number.isSafeInteger(entry.originalSize)
                    || entry.originalSize > ZipFirmwareSource.MAX_ENTRY_BYTES) {
                    fail("A firmware ZIP entry exceeds the 2 MiB expanded-size limit.", path);
                    entry.terminate();
                    return;
                }
                announcedBytes += entry.originalSize;
                if (!Number.isSafeInteger(announcedBytes)
                    || announcedBytes > ZipFirmwareSource.MAX_EXPANDED_BYTES) {
                    fail("The firmware ZIP exceeds the 8 MiB expanded-size limit.");
                    entry.terminate();
                    return;
                }
            }

            let entryBytes = 0;
            const parts: BlobPart[] = [];
            let settled = false;
            let settle!: (file: PsxFirmwareFile | null) => void;
            const output = new Promise<PsxFirmwareFile | null>((resolve) => {
                settle = (file) => {
                    if (settled) return;
                    settled = true;
                    pending.delete(settle);
                    resolve(file);
                };
                pending.add(settle);
            });
            outputs.push(output);
            entry.ondata = (error, chunk, final) => {
                if (error !== null) {
                    fail("A firmware ZIP entry could not be decompressed.", reasonOf(error));
                    settle(null);
                    return;
                }
                entryBytes += chunk.byteLength;
                expandedBytes += chunk.byteLength;
                if (!Number.isSafeInteger(entryBytes)
                    || entryBytes > ZipFirmwareSource.MAX_ENTRY_BYTES) {
                    fail("A firmware ZIP entry exceeds the 2 MiB expanded-size limit.", path);
                    entry.terminate();
                    settle(null);
                    return;
                }
                if (!Number.isSafeInteger(expandedBytes)
                    || expandedBytes > ZipFirmwareSource.MAX_EXPANDED_BYTES) {
                    fail("The firmware ZIP exceeds the 8 MiB expanded-size limit.");
                    entry.terminate();
                    settle(null);
                    return;
                }
                if (chunk.byteLength > 0) parts.push(chunk.slice());
                if (final) settle(supportedByteLengths.includes(entryBytes)
                    ? Object.freeze({ name: basename(path), blob: new Blob(parts) })
                    : null);
            };
            try {
                entry.start();
            } catch (error) {
                fail("A firmware ZIP entry could not be decompressed.", reasonOf(error));
                settle(null);
            }
        });
        unzip.register(UnzipInflate);

        const reader = archive.stream().getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                unzip.push(value, false);
                if (failure !== null) {
                    await reader.cancel();
                    break;
                }
            }
            if (failure === null) unzip.push(new Uint8Array(), true);
        } catch (error) {
            failure ??= archiveInvalid("The selected firmware ZIP is malformed or truncated.", reasonOf(error));
            for (const settle of pending) settle(null);
            pending.clear();
        } finally {
            reader.releaseLock();
        }

        const candidates = (await Promise.all(outputs)).filter((file): file is PsxFirmwareFile => file !== null);
        if (failure !== null) throw failure;
        if (candidates.length === 0) throw biosInvalid(
            "The firmware ZIP does not contain an image with a supported byte length.",
            { candidates: 0, supportedByteLengths },
        );
        if (candidates.length === 1) return candidates[0]!;
        const regional = region === undefined
            ? []
            : candidates.filter(({ name }) => regionForName(name) === region);
        if (regional.length === 1) return regional[0]!;
        throw biosInvalid(
            region === undefined
                ? "The firmware ZIP contains more than one image with a supported byte length."
                : "The firmware ZIP does not identify exactly one supported image for the selected region.",
            { candidates: candidates.length, regionalCandidates: regional.length, supportedByteLengths, region },
        );
    }
}
