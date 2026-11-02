// Dependencies:
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Reports stable archive-validation failures
import { isDiscPath } from "../shared.types.js";                       // Rejects unsafe or non-normalized entry paths

// Type dependencies:
import type { DiscFile } from "../shared.types.js";                    // Normalized Blob-backed files returned to the content pipeline
import type { PsxLocalFileLike } from "../PsxConsole/types.js";        // Browser file shape accepted at the archive boundary

const GIBIBYTE = 1024 * 1024 * 1024;

/**
 *
 * Class
 *
 */

// Expands one user-supplied ZIP into the normalized files used by raw selections.
export default class ZipDiscSource {

    /* Static Fields */
    static readonly MAX_ARCHIVE_BYTES = 8 * GIBIBYTE;                     // Maximum compressed archive size accepted
    static readonly MAX_ENTRY_BYTES = GIBIBYTE;                           // Maximum expanded size of one entry
    static readonly MAX_EXPANDED_BYTES = 8 * GIBIBYTE;                    // Maximum combined expanded size
    static readonly MAX_FILES = 64;                                       // Maximum normalized file count

    // CONSTRUCTOR :: VOID -> zipDiscSource
    // Prevents instances because archive operations are stateless.
    private constructor() {}

    /**
     *
     * Static Methods
     *
     */

    // METHOD :: {name:STRING} -> BOOLEAN
    // Reports whether a selected file name uses the ZIP extension.
    static isArchive(file: Pick<PsxLocalFileLike, "name">): boolean {
        return /\.zip$/iu.test(file.name);
    }

    // METHOD :: psxLocalFileLike -> PROMISE([discFile])
    // Streams, bounds, validates, and expands one ZIP archive.
    static async extract(archive: PsxLocalFileLike): Promise<ReadonlyArray<DiscFile>> {
        if (!(archive instanceof Blob) || !ZipDiscSource.isArchive(archive)) {
            throw invalid("The selected archive must be a ZIP file.");
        }
        if (archive.size === 0) throw invalid("The selected ZIP archive is empty.");
        if (!Number.isSafeInteger(archive.size) || archive.size > ZipDiscSource.MAX_ARCHIVE_BYTES) {
            throw invalid("The selected ZIP archive exceeds the 8 GiB compressed-size limit.");
        }
        const signatureBytes = new Uint8Array(await archive.slice(0, 4).arrayBuffer());
        const signature = signatureBytes.length === 4
            ? new DataView(signatureBytes.buffer).getUint32(0, true)
            : 0;
        if (signature !== 0x04034b50 && signature !== 0x06054b50) {
            throw invalid("The selected ZIP archive is malformed or truncated.");
        }
        const { Unzip, UnzipInflate } = await import("fflate");

        const outputs: Array<Promise<DiscFile | null>> = [];
        const seen = new Set<string>();
        let announcedBytes = 0;
        let expandedBytes = 0;
        let failure: PsxRuntimeError | null = null;

        const fail = (message: string, data?: unknown): PsxRuntimeError => {
            const error = invalid(message, data);
            failure ??= error;
            return error;
        };

        const unzip = new Unzip((entry) => {
            if (failure !== null) return;
            const directory = entry.name.endsWith("/");
            const path = directory ? entry.name.slice(0, -1) : entry.name;
            if (!isDiscPath(path)) {
                fail("The ZIP archive contains an unsafe or non-normalized path.", entry.name);
                entry.terminate();
                return;
            }
            if (directory) {
                entry.ondata = (error) => {
                    if (error !== null) fail("A ZIP directory entry could not be read.", reasonOf(error));
                };
                try {
                    entry.start();
                } catch (error) {
                    fail("A ZIP directory entry could not be read.", reasonOf(error));
                }
                return;
            }
            if (entry.compression !== 0 && entry.compression !== 8) {
                fail("The ZIP archive uses an unsupported compression method.", entry.compression);
                entry.terminate();
                return;
            }
            const folded = path.toLowerCase();
            if (seen.has(folded)) {
                fail("The ZIP archive contains duplicate paths when case-folded.", path);
                entry.terminate();
                return;
            }
            seen.add(folded);
            if (seen.size > ZipDiscSource.MAX_FILES) {
                fail("The ZIP archive contains more than 64 files.");
                entry.terminate();
                return;
            }
            if (entry.originalSize !== undefined) {
                if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize > ZipDiscSource.MAX_ENTRY_BYTES) {
                    fail("A ZIP entry exceeds the 1 GiB expanded-size limit.", path);
                    entry.terminate();
                    return;
                }
                announcedBytes += entry.originalSize;
                if (!Number.isSafeInteger(announcedBytes)
                    || announcedBytes > ZipDiscSource.MAX_EXPANDED_BYTES) {
                    fail("The ZIP archive exceeds the 8 GiB expanded-size limit.");
                    entry.terminate();
                    return;
                }
            }

            let entryBytes = 0;
            const parts: BlobPart[] = [];
            let finish: (file: DiscFile | null) => void = () => undefined;
            const output = new Promise<DiscFile | null>((resolve) => { finish = resolve; });
            outputs.push(output);
            entry.ondata = (error, chunk, final) => {
                if (error !== null) {
                    fail("A ZIP entry could not be decompressed. Encrypted archives are not supported.", reasonOf(error));
                    finish(null);
                    return;
                }
                entryBytes += chunk.byteLength;
                expandedBytes += chunk.byteLength;
                if (!Number.isSafeInteger(entryBytes) || entryBytes > ZipDiscSource.MAX_ENTRY_BYTES) {
                    fail("A ZIP entry exceeds the 1 GiB expanded-size limit.", path);
                    entry.terminate();
                    finish(null);
                    return;
                }
                if (!Number.isSafeInteger(expandedBytes)
                    || expandedBytes > ZipDiscSource.MAX_EXPANDED_BYTES) {
                    fail("The ZIP archive exceeds the 8 GiB expanded-size limit.");
                    entry.terminate();
                    finish(null);
                    return;
                }
                if (chunk.byteLength > 0) parts.push(chunk.slice());
                if (final) finish(Object.freeze({ path, blob: new Blob(parts) }));
            };
            try {
                entry.start();
            } catch (error) {
                fail("A ZIP entry could not be decompressed. Encrypted archives are not supported.", reasonOf(error));
                finish(null);
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
            failure ??= invalid("The selected ZIP archive is malformed or truncated.", reasonOf(error));
        } finally {
            reader.releaseLock();
        }

        const files = (await Promise.all(outputs)).filter((file): file is DiscFile => file !== null);
        if (failure !== null) throw failure;
        if (files.length === 0) throw invalid("The ZIP archive contains no files.");
        return Object.freeze(files);
    }
}

/**
 *
 *  Helper Functions
 *
 */

// Binary byte unit used by archive limits

// HELPER :: STRING, UNKNOWN? -> psxRuntimeError
// Creates one stable archive-validation error.
const invalid = (message: string, data?: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.ARCHIVE_INVALID,
    message,
    data,
});

// HELPER :: UNKNOWN -> STRING
// Normalizes arbitrary decompressor failures into a readable reason.
const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
