// Dependencies:
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Reports stable archive-validation failures
import { isDiscPath } from "../shared.types.js";                       // Rejects unsafe or non-normalized entry paths

// Type dependencies:
import type { DiscFile } from "../shared.types.js";                    // Normalized Blob-backed files returned to the content pipeline
import type { PsxLocalFileLike } from "../PsxConsole/types.js";        // Browser file shape accepted at the archive boundary

const GIBIBYTE = 1024 * 1024 * 1024;
const END_RECORD_BYTES = 22;
const MAX_END_SEARCH_BYTES = END_RECORD_BYTES + 65_535;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const ZIP64_END_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

/**
 *
 * Type Declarations
 *
 */

// INTERFACE :: {path:STRING, flags:NUMBER, compression:NUMBER, compressedSize:NUMBER, originalSize:NUMBER, localOffset:NUMBER}
// One central-directory record with exact sizes and its corresponding local-header offset.
interface ZipEntryRecord {
    readonly path: string;              // Decoded entry path
    readonly flags: number;             // General-purpose ZIP flags
    readonly compression: number;       // ZIP compression method
    readonly compressedSize: number;    // Exact compressed payload length
    readonly originalSize: number;      // Declared expanded payload length
    readonly localOffset: number;       // Absolute local-header position
}

// INTERFACE :: {entryCount:NUMBER, centralOffset:NUMBER, centralSize:NUMBER}
// Archive-wide central-directory location resolved from classic or ZIP64 end records.
interface ZipDirectoryRecord {
    readonly entryCount: number;       // Number of central-directory entries
    readonly centralOffset: number;    // Absolute central-directory position
    readonly centralSize: number;      // Central-directory byte length
}

// INTERFACE :: {push:(uint8Array, BOOLEAN -> VOID)}
// Minimal raw-DEFLATE stream created by fflate for one exact entry payload.
interface RawInflateStream {
    push(bytes: Uint8Array, final?: boolean): void;    // Supplies compressed chunks and marks the terminal chunk
}

// TYPE :: (uint8Array, BOOLEAN -> VOID) -> rawInflateStream
// Factory for a streaming raw-DEFLATE decoder.
type RawInflateFactory = (onData: (bytes: Uint8Array<ArrayBuffer>, final: boolean) => void) => RawInflateStream;

// TYPE :: uint8Array, BOOLEAN? -> STRING
// ZIP filename decoder; the boolean requests the legacy single-byte form.
type ZipStringDecoder = (bytes: Uint8Array, latin1?: boolean) => string;

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
        const { Inflate, strFromU8 } = await import("fflate");
        const entries = await readCentralDirectory(archive, strFromU8);
        const files: DiscFile[] = [];
        const seen = new Set<string>();
        let announcedBytes = 0;
        let expandedBytes = 0;

        for (const entry of entries) {
            const directory = entry.path.endsWith("/");
            const path = directory ? entry.path.slice(0, -1) : entry.path;
            if (!isDiscPath(path)) {
                throw invalid("The ZIP archive contains an unsafe or non-normalized path.", entry.path);
            }
            if (directory) continue;
            if ((entry.flags & 1) !== 0) throw invalid("Encrypted ZIP archives are not supported.", path);
            if (entry.compression !== 0 && entry.compression !== 8) {
                throw invalid("The ZIP archive uses an unsupported compression method.", entry.compression);
            }
            const folded = path.toLowerCase();
            if (seen.has(folded)) {
                throw invalid("The ZIP archive contains duplicate paths when case-folded.", path);
            }
            seen.add(folded);
            if (seen.size > ZipDiscSource.MAX_FILES) {
                throw invalid("The ZIP archive contains more than 64 files.");
            }
            if (!Number.isSafeInteger(entry.originalSize)
                || entry.originalSize > ZipDiscSource.MAX_ENTRY_BYTES) {
                throw invalid("A ZIP entry exceeds the 1 GiB expanded-size limit.", path);
            }
            announcedBytes += entry.originalSize;
            if (!Number.isSafeInteger(announcedBytes)
                || announcedBytes > ZipDiscSource.MAX_EXPANDED_BYTES) {
                throw invalid("The ZIP archive exceeds the 8 GiB expanded-size limit.");
            }
            const compressed = await entryPayload(archive, entry);
            let blob: Blob;
            try {
                blob = entry.compression === 0
                    ? compressed
                    : await inflateBlob(compressed, entry.originalSize, (onData) => new Inflate(onData));
            } catch (error) {
                throw invalid("A ZIP entry could not be decompressed.", reasonOf(error));
            }
            if (blob.size !== entry.originalSize) {
                throw invalid("A ZIP entry expanded to an unexpected byte length.", {
                    path,
                    expected: entry.originalSize,
                    actual: blob.size,
                });
            }
            expandedBytes += blob.size;
            if (!Number.isSafeInteger(expandedBytes)
                || expandedBytes > ZipDiscSource.MAX_EXPANDED_BYTES) {
                throw invalid("The ZIP archive exceeds the 8 GiB expanded-size limit.");
            }
            files.push(Object.freeze({ path, blob }));
        }
        if (files.length === 0) throw invalid("The ZIP archive contains no files.");
        return Object.freeze(files);
    }
}

/**
 *
 *  Helper Functions
 *
 */

// HELPER :: psxLocalFileLike, zipStringDecoder -> PROMISE([zipEntryRecord])
// Reads exact entry sizes and local-header offsets from the authoritative central directory.
const readCentralDirectory = async (
    archive: PsxLocalFileLike,
    decode: ZipStringDecoder,
): Promise<ReadonlyArray<ZipEntryRecord>> => {
    const directory = await readDirectoryRecord(archive);
    if (directory.centralSize > 16 * 1024 * 1024 || directory.entryCount > 4096) {
        throw invalid("The ZIP archive central directory exceeds the supported metadata limits.");
    }
    const bytes = await readBytes(archive, directory.centralOffset, directory.centralSize);
    const view = dataView(bytes);
    const entries: ZipEntryRecord[] = [];
    let cursor = 0;
    for (let index = 0; index < directory.entryCount; index++) {
        if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== CENTRAL_FILE_SIGNATURE) {
            throw invalid("The selected ZIP archive has a malformed central directory.");
        }
        const flags = view.getUint16(cursor + 8, true);
        const compression = view.getUint16(cursor + 10, true);
        const compressed32 = view.getUint32(cursor + 20, true);
        const original32 = view.getUint32(cursor + 24, true);
        const nameBytes = view.getUint16(cursor + 28, true);
        const extraBytes = view.getUint16(cursor + 30, true);
        const commentBytes = view.getUint16(cursor + 32, true);
        const localOffset32 = view.getUint32(cursor + 42, true);
        const recordBytes = 46 + nameBytes + extraBytes + commentBytes;
        if (cursor + recordBytes > bytes.byteLength) {
            throw invalid("The selected ZIP archive has a truncated central-directory entry.");
        }
        const nameStart = cursor + 46;
        const extraStart = nameStart + nameBytes;
        const path = decode(bytes.subarray(nameStart, extraStart), (flags & 0x0800) === 0);
        const sizes = resolveEntrySizes(
            view,
            extraStart,
            extraBytes,
            compressed32,
            original32,
            localOffset32,
        );
        entries.push(Object.freeze({ path, flags, compression, ...sizes }));
        cursor += recordBytes;
    }
    return Object.freeze(entries);
};

// HELPER :: psxLocalFileLike -> PROMISE(zipDirectoryRecord)
// Locates the classic end record and follows its ZIP64 locator when sentinel fields require it.
const readDirectoryRecord = async (archive: PsxLocalFileLike): Promise<ZipDirectoryRecord> => {
    const tailOffset = Math.max(0, archive.size - MAX_END_SEARCH_BYTES);
    const tail = await readBytes(archive, tailOffset, archive.size - tailOffset);
    const view = dataView(tail);
    let endIndex = -1;
    for (let index = tail.byteLength - END_RECORD_BYTES; index >= 0; index--) {
        if (view.getUint32(index, true) !== END_SIGNATURE) continue;
        const commentBytes = view.getUint16(index + 20, true);
        if (index + END_RECORD_BYTES + commentBytes === tail.byteLength) {
            endIndex = index;
            break;
        }
    }
    if (endIndex < 0) throw invalid("The selected ZIP archive is malformed or truncated.");
    const disk = view.getUint16(endIndex + 4, true);
    const centralDisk = view.getUint16(endIndex + 6, true);
    const diskEntries = view.getUint16(endIndex + 8, true);
    const entryCount = view.getUint16(endIndex + 10, true);
    const centralSize = view.getUint32(endIndex + 12, true);
    const centralOffset = view.getUint32(endIndex + 16, true);
    if (disk !== 0 || centralDisk !== 0 || (diskEntries !== entryCount && diskEntries !== 0xffff)) {
        throw invalid("Multi-disk ZIP archives are not supported.");
    }
    if (entryCount !== 0xffff && centralSize !== 0xffffffff && centralOffset !== 0xffffffff) {
        assertDirectoryBounds(archive, entryCount, centralOffset, centralSize);
        return { entryCount, centralOffset, centralSize };
    }
    const absoluteEnd = tailOffset + endIndex;
    const locator = await readBytes(archive, absoluteEnd - 20, 20);
    const locatorView = dataView(locator);
    if (locatorView.getUint32(0, true) !== ZIP64_LOCATOR_SIGNATURE
        || locatorView.getUint32(4, true) !== 0 || locatorView.getUint32(16, true) !== 1) {
        throw invalid("The selected ZIP archive has an invalid ZIP64 locator.");
    }
    const zip64Offset = safeUint64(locatorView, 8);
    const zip64 = await readBytes(archive, zip64Offset, 56);
    const zip64View = dataView(zip64);
    if (zip64View.getUint32(0, true) !== ZIP64_END_SIGNATURE
        || zip64View.getUint32(16, true) !== 0 || zip64View.getUint32(20, true) !== 0) {
        throw invalid("The selected ZIP archive has an invalid ZIP64 end record.");
    }
    const resolved = {
        entryCount: safeUint64(zip64View, 32),
        centralSize: safeUint64(zip64View, 40),
        centralOffset: safeUint64(zip64View, 48),
    };
    assertDirectoryBounds(archive, resolved.entryCount, resolved.centralOffset, resolved.centralSize);
    return resolved;
};

// HELPER :: dataView, NUMBER, NUMBER, NUMBER, NUMBER, NUMBER -> {compressedSize:NUMBER, originalSize:NUMBER, localOffset:NUMBER}
// Resolves ZIP64 sentinel values from an entry's ordered ZIP64 extended-information field.
const resolveEntrySizes = (
    view: DataView,
    extraStart: number,
    extraBytes: number,
    compressed32: number,
    original32: number,
    localOffset32: number,
): Pick<ZipEntryRecord, "compressedSize" | "originalSize" | "localOffset"> => {
    const needsZip64 = compressed32 === 0xffffffff || original32 === 0xffffffff || localOffset32 === 0xffffffff;
    if (!needsZip64) return {
        compressedSize: compressed32,
        originalSize: original32,
        localOffset: localOffset32,
    };
    const extraEnd = extraStart + extraBytes;
    let cursor = extraStart;
    while (cursor + 4 <= extraEnd) {
        const identifier = view.getUint16(cursor, true);
        const size = view.getUint16(cursor + 2, true);
        const dataStart = cursor + 4;
        const dataEnd = dataStart + size;
        if (dataEnd > extraEnd) throw invalid("A ZIP entry contains malformed extra data.");
        if (identifier === 0x0001) {
            let valueOffset = dataStart;
            const take = (): number => {
                if (valueOffset + 8 > dataEnd) throw invalid("A ZIP entry has incomplete ZIP64 size data.");
                const value = safeUint64(view, valueOffset);
                valueOffset += 8;
                return value;
            };
            const originalSize = original32 === 0xffffffff ? take() : original32;
            const compressedSize = compressed32 === 0xffffffff ? take() : compressed32;
            const localOffset = localOffset32 === 0xffffffff ? take() : localOffset32;
            return { compressedSize, originalSize, localOffset };
        }
        cursor = dataEnd;
    }
    throw invalid("A ZIP entry is missing required ZIP64 size data.");
};

// HELPER :: psxLocalFileLike, zipEntryRecord -> PROMISE(BLOB)
// Resolves one exact compressed payload slice from its validated local header.
const entryPayload = async (archive: PsxLocalFileLike, entry: ZipEntryRecord): Promise<Blob> => {
    const header = await readBytes(archive, entry.localOffset, 30);
    const view = dataView(header);
    if (view.getUint32(0, true) !== LOCAL_FILE_SIGNATURE) {
        throw invalid("A ZIP entry has an invalid local header.", entry.path);
    }
    const flags = view.getUint16(6, true);
    const compression = view.getUint16(8, true);
    if ((flags & 1) !== 0) throw invalid("Encrypted ZIP archives are not supported.", entry.path);
    if (compression !== entry.compression) {
        throw invalid("A ZIP entry disagrees with its central-directory compression method.", entry.path);
    }
    const dataOffset = entry.localOffset + 30 + view.getUint16(26, true) + view.getUint16(28, true);
    const dataEnd = dataOffset + entry.compressedSize;
    if (!Number.isSafeInteger(dataOffset) || !Number.isSafeInteger(dataEnd) || dataEnd > archive.size) {
        throw invalid("A ZIP entry payload is malformed or truncated.", entry.path);
    }
    return archive.slice(dataOffset, dataEnd);
};

// HELPER :: BLOB, NUMBER, rawInflateFactory -> PROMISE(BLOB)
// Inflates an exact raw-DEFLATE payload while enforcing its central-directory output length.
const inflateBlob = async (
    compressed: Blob,
    originalSize: number,
    createInflate: RawInflateFactory,
): Promise<Blob> => {
    const parts: BlobPart[] = [];
    let expandedBytes = 0;
    let completed = false;
    const inflate = createInflate((bytes, final) => {
        expandedBytes += bytes.byteLength;
        if (!Number.isSafeInteger(expandedBytes) || expandedBytes > originalSize) {
            throw new Error("The expanded entry exceeded its declared byte length.");
        }
        if (bytes.byteLength > 0) parts.push(bytes);
        completed = final;
    });
    const reader = compressed.stream().getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                inflate.push(new Uint8Array(), true);
                break;
            }
            inflate.push(value, false);
        }
    } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
    } finally {
        reader.releaseLock();
    }
    if (!completed || expandedBytes !== originalSize) throw new Error("The expanded entry ended before its declared byte length.");
    return new Blob(parts);
};

// HELPER :: psxLocalFileLike, NUMBER, NUMBER -> PROMISE(uint8Array)
// Reads one exact bounded archive range and rejects truncation before binary parsing.
const readBytes = async (archive: PsxLocalFileLike, offset: number, length: number): Promise<Uint8Array> => {
    const end = offset + length;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
        || !Number.isSafeInteger(end) || end > archive.size) {
        throw invalid("The selected ZIP archive is malformed or truncated.");
    }
    const bytes = new Uint8Array(await archive.slice(offset, end).arrayBuffer());
    if (bytes.byteLength !== length) throw invalid("The selected ZIP archive is malformed or truncated.");
    return bytes;
};

// HELPER :: uint8Array -> dataView
// Creates an offset-aware little-endian view over one archive byte range.
const dataView = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// HELPER :: dataView, NUMBER -> NUMBER
// Converts one unsigned ZIP64 field only when JavaScript can represent it exactly.
const safeUint64 = (view: DataView, offset: number): number => {
    const value = view.getBigUint64(offset, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid("A ZIP64 value exceeds the safe integer range.");
    return Number(value);
};

// HELPER :: psxLocalFileLike, NUMBER, NUMBER, NUMBER -> VOID
// Validates a resolved central-directory span against the archive Blob.
const assertDirectoryBounds = (
    archive: PsxLocalFileLike,
    entryCount: number,
    centralOffset: number,
    centralSize: number,
): void => {
    const end = centralOffset + centralSize;
    if (!Number.isSafeInteger(entryCount) || !Number.isSafeInteger(centralOffset)
        || !Number.isSafeInteger(centralSize) || entryCount < 0 || centralOffset < 0 || centralSize < 0
        || !Number.isSafeInteger(end) || end > archive.size) {
        throw invalid("The selected ZIP archive has invalid central-directory bounds.");
    }
};

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
