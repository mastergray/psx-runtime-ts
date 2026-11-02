// Dependencies:
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Reports structurally invalid top-level audit input
import { isDiscPath } from "../shared.types.js";                       // Validates normalized relative content and descriptor paths

// Type dependencies:
import type {
    AuditedDiscEntry,    // Resolved cue, track, and optional sidecar result
    AuditedTrack,        // Resolved data or audio track metadata
    DiscFile,            // Supplied normalized path and blob pair
    DiscSet,             // Top-level identity, entry, and file collection
} from "../shared.types.js";
import type {
    DiscSetAuditResult,       // Success or failure report returned to callers
    DiscSetIssue,             // One structured audit diagnostic
    DiscSetIssueCode,         // Closed diagnostic category set
    DiscSetIssueSeverity,     // Error or warning classification
} from "./types.js";

/**
 *
 * Type Declarations
 *
 */

// TYPE :: {exact:MAP, folded:MAP}
// Exact and case-folded views used to resolve descriptor references deterministically.
interface FileLookup {
    readonly exact: ReadonlyMap<string, DiscFile>;                           // First file at each exact supplied path
    readonly folded: ReadonlyMap<string, ReadonlyArray<DiscFile>>;           // All files grouped by lowercase path
}

// TYPE :: {number:NUMBER, file:discFile?, kind:"data"|"audio"?, line:NUMBER, hasIndexOne:BOOLEAN, lastIndex:NUMBER, lastTime:NUMBER}
// Mutable parser state for the CUE track currently being accumulated.
interface PendingTrack {
    readonly number: number;                 // Declared one-based track number
    readonly file?: DiscFile;                // Resolved file active at the TRACK directive
    readonly kind?: "data" | "audio";       // Normalized supported track mode
    readonly line: number;                   // One-based source line for diagnostics
    hasIndexOne: boolean;                    // Whether required INDEX 01 was observed
    lastIndex: number;                       // Highest index number observed for ordering
    lastTime: number;                        // Latest MSF timestamp observed for ordering
}

const MAX_FILES = 64;                          // Maximum supplied files audited as one set
const MAX_DISCS = 8;                           // Maximum CUE entries accepted from one playlist
const MAX_TRACKS = 99;                         // Maximum sequential tracks accepted per CUE
const MAX_DESCRIPTOR_BYTES = 256 * 1024;       // Maximum bytes read from one CUE or M3U
const MAX_CUE_LINE_BYTES = 1024;                // Maximum encoded bytes accepted on one CUE line
const FILE_DIRECTIVE = /^\s*FILE\s+(?:"([^"\r\n]+)"|([^\s"]+))\s+([^\s]+)\s*$/iu; // Supported FILE syntax
const TRACK_DIRECTIVE = /^\s*TRACK\s+(\d{1,3})\s+([^\s]+)\s*$/iu;                     // Supported TRACK syntax
const INDEX_DIRECTIVE = /^\s*INDEX\s+(\d{1,3})\s+(\d{1,3}):(\d{2}):(\d{2})\s*$/iu; // Supported INDEX syntax
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;       // Forbidden descriptor controls excluding line whitespace
const SUPPORTED_TRACK_MODES = new Map<string, "data" | "audio">([                     // CUE modes normalized for runtime mounting
    ["AUDIO", "audio"],
    ["MODE1/2048", "data"],
    ["MODE1/2352", "data"],
    ["MODE2/2336", "data"],
    ["MODE2/2352", "data"],
]);

// METHOD :: UNKNOWN -> BOOLEAN
// Narrows a value to a non-null object for structural validation.
const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

// METHOD :: UNKNOWN -> BOOLEAN
// Narrows a value to the Blob operations and size semantics required by the audit.
const isBlobLike = (value: unknown): value is Blob => isObject(value)
    && typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0
    && typeof value.arrayBuffer === "function" && typeof value.slice === "function"
    && typeof value.stream === "function" && typeof value.text === "function";

// METHOD :: UNKNOWN -> BOOLEAN
// Narrows top-level input to a minimally shaped disc set before detailed diagnostics.
const isAuditInput = (value: unknown): value is DiscSet => isObject(value)
    && typeof value.gameId === "string" && value.gameId.trim().length > 0
    && typeof value.entry === "string" && Array.isArray(value.files)
    && value.files.every((file) => isObject(file)
        && typeof file.path === "string" && isBlobLike(file.blob));

// METHOD :: [discSetIssue], discSetIssueSeverity, discSetIssueCode, STRING, STRING?, NUMBER? -> VOID
// Appends one structured diagnostic with optional path and line context.
const addIssue = (
    issues: DiscSetIssue[],
    severity: DiscSetIssueSeverity,
    code: DiscSetIssueCode,
    message: string,
    path?: string,
    line?: number,
): void => {
    issues.push({ severity, code, message, ...(path === undefined ? {} : { path }), ...(line === undefined ? {} : { line }) });
};

// METHOD :: STRING -> STRING
// Returns the normalized parent directory portion of one content path.
const directoryOf = (path: string): string => {
    const slash = path.lastIndexOf("/");
    return slash < 0 ? "" : path.slice(0, slash);
};

// METHOD :: STRING, STRING -> STRING
// Resolves one descriptor reference relative to its normalized parent path.
const resolveRelativePath = (base: string, reference: string): string => {
    const directory = directoryOf(base);
    return directory.length === 0 ? reference : `${directory}/${reference}`;
};

// METHOD :: STRING -> STRING
// Returns a lowercase final-component extension or an empty string.
const extensionOf = (path: string): string => {
    const slash = path.lastIndexOf("/");
    const dot = path.lastIndexOf(".");
    return dot > slash ? path.slice(dot).toLowerCase() : "";
};

// METHOD :: [discFile] -> fileLookup
// Builds exact and case-folded lookup views for supplied content.
const lookupFor = (files: ReadonlyArray<DiscFile>): FileLookup => {
    const exact = new Map<string, DiscFile>();
    const folded = new Map<string, DiscFile[]>();
    for (const file of files) {
        if (!exact.has(file.path)) exact.set(file.path, file);
        const key = file.path.toLowerCase();
        const entries = folded.get(key) ?? [];
        entries.push(file);
        folded.set(key, entries);
    }
    return { exact, folded };
};

// METHOD :: STRING, STRING, fileLookup, [discSetIssue], NUMBER -> discFile?
// Resolves one safe reference and records missing, case, or ambiguity errors.
const resolveFile = (
    descriptorPath: string,
    reference: string,
    lookup: FileLookup,
    issues: DiscSetIssue[],
    line: number,
): DiscFile | undefined => {
    if (!isDiscPath(reference)) {
        addIssue(issues, "error", "invalid-path", `Unsafe descriptor reference: ${reference}`, descriptorPath, line);
        return undefined;
    }
    const resolved = resolveRelativePath(descriptorPath, reference);
    if (!isDiscPath(resolved)) {
        addIssue(issues, "error", "invalid-path", `Unsafe resolved descriptor path: ${resolved}`, descriptorPath, line);
        return undefined;
    }
    const exact = lookup.exact.get(resolved);
    if (exact !== undefined) return exact;
    const folded = lookup.folded.get(resolved.toLowerCase()) ?? [];
    if (folded.length === 1) {
        addIssue(
            issues,
            "error",
            "case-mismatch",
            `Reference case does not match supplied path: ${reference}`,
            descriptorPath,
            line,
        );
        return folded[0];
    }
    if (folded.length > 1) {
        addIssue(issues, "error", "duplicate-path", `Reference is ambiguous by case: ${reference}`, descriptorPath, line);
        return undefined;
    }
    addIssue(issues, "error", "missing-file", `Referenced file is missing: ${reference}`, descriptorPath, line);
    return undefined;
};

// METHOD :: discFile, [discSetIssue] -> PROMISE(STRING?)
// Reads one bounded descriptor as strict UTF-8 without forbidden controls.
const descriptorText = async (
    file: DiscFile,
    issues: DiscSetIssue[],
): Promise<string | undefined> => {
    if (file.blob.size === 0) {
        addIssue(issues, "error", "descriptor-empty", "Descriptor file is empty.", file.path);
        return undefined;
    }
    if (file.blob.size > MAX_DESCRIPTOR_BYTES) {
        addIssue(issues, "error", "descriptor-too-large", "Descriptor exceeds the 256 KiB limit.", file.path);
        return undefined;
    }
    let bytes: ArrayBuffer;
    try {
        bytes = await file.blob.arrayBuffer();
    } catch {
        addIssue(issues, "error", "descriptor-read-failed", "Descriptor bytes could not be read.", file.path);
        return undefined;
    }
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        addIssue(issues, "error", "invalid-utf8", "Descriptor is not valid UTF-8.", file.path);
        return undefined;
    }
    if (text.startsWith("\ufeff")) text = text.slice(1);
    if (CONTROL_CHARACTERS.test(text)) {
        addIssue(issues, "error", "control-character", "Descriptor contains a forbidden control character.", file.path);
        return undefined;
    }
    return text;
};

// METHOD :: discFile, fileLookup, [discSetIssue], SET<STRING> -> STRING?
// Resolves an optional same-basename SBI sidecar and records case errors.
const sidecarFor = (
    cue: DiscFile,
    lookup: FileLookup,
    issues: DiscSetIssue[],
    used: Set<string>,
): string | undefined => {
    const expected = `${cue.path.slice(0, -4)}.sbi`;
    const exact = lookup.exact.get(expected);
    if (exact !== undefined) {
        used.add(exact.path);
        return exact.path;
    }
    const folded = lookup.folded.get(expected.toLowerCase()) ?? [];
    if (folded.length === 1) {
        addIssue(issues, "error", "case-mismatch", "SBI sidecar case does not match its CUE basename.", cue.path);
        used.add(folded[0]!.path);
        return folded[0]!.path;
    }
    return undefined;
};

// METHOD :: discFile, fileLookup, [discSetIssue], SET<STRING> -> PROMISE(auditedDiscEntry)
// Parses and resolves one bounded CUE into ordered audited track metadata.
const auditCue = async (
    cue: DiscFile,
    lookup: FileLookup,
    issues: DiscSetIssue[],
    used: Set<string>,
): Promise<AuditedDiscEntry> => {
    used.add(cue.path);
    const tracks: AuditedTrack[] = [];
    const text = await descriptorText(cue, issues);
    if (text === undefined) return { cue: cue.path, tracks };

    const lines = text.split(/\r?\n/u);
    let currentFile: DiscFile | undefined;
    let currentFileLine: number | undefined;
    let currentFileHasTrack = false;
    let currentTrack: PendingTrack | undefined;
    let lastTrackNumber = 0;
    let trackCount = 0;
    const lastFileTime = new Map<string, number>();
    const emptyReported = new Set<string>();

    // METHOD :: VOID -> VOID
    // Validates and commits the pending track before parser state advances.
    const finishTrack = (): void => {
        if (currentTrack === undefined) return;
        if (!currentTrack.hasIndexOne) {
            addIssue(issues, "error", "missing-index", `Track ${currentTrack.number} has no INDEX 01.`, cue.path, currentTrack.line);
        }
        if (currentTrack.file !== undefined && currentTrack.kind !== undefined) {
            tracks.push({
                file: currentTrack.file.path,
                kind: currentTrack.kind,
                bytes: currentTrack.file.blob.size,
            });
        }
        currentTrack = undefined;
    };

    for (let index = 0; index < lines.length; index++) {
        const lineNumber = index + 1;
        const line = lines[index]!;
        if (new TextEncoder().encode(line).byteLength > MAX_CUE_LINE_BYTES) {
            addIssue(issues, "error", "cue-line-too-long", "CUE line exceeds 1 KiB.", cue.path, lineNumber);
            continue;
        }
        const trimmed = line.trim();
        if (trimmed.length === 0 || /^REM(?:\s|$)/iu.test(trimmed)) continue;

        if (/^FILE(?:\s|$)/iu.test(trimmed)) {
            finishTrack();
            if (currentFile !== undefined && !currentFileHasTrack) {
                addIssue(issues, "error", "cue-syntax", "FILE is not followed by a TRACK directive.", cue.path, currentFileLine);
            }
            const match = FILE_DIRECTIVE.exec(line);
            if (match === null) {
                addIssue(issues, "error", "cue-syntax", "Malformed FILE directive.", cue.path, lineNumber);
                currentFile = undefined;
                currentFileLine = undefined;
                continue;
            }
            if (match[3]!.toUpperCase() !== "BINARY") {
                addIssue(issues, "error", "unsupported-file-type", `Unsupported CUE file type: ${match[3]}`, cue.path, lineNumber);
            }
            currentFile = resolveFile(cue.path, match[1] ?? match[2]!, lookup, issues, lineNumber);
            currentFileLine = lineNumber;
            currentFileHasTrack = false;
            if (currentFile !== undefined) {
                used.add(currentFile.path);
                if (currentFile.blob.size === 0 && !emptyReported.has(currentFile.path)) {
                    addIssue(issues, "error", "empty-track", "Referenced track file is empty.", currentFile.path);
                    emptyReported.add(currentFile.path);
                }
            }
            continue;
        }

        if (/^TRACK(?:\s|$)/iu.test(trimmed)) {
            finishTrack();
            const match = TRACK_DIRECTIVE.exec(line);
            if (match === null) {
                addIssue(issues, "error", "cue-syntax", "Malformed TRACK directive.", cue.path, lineNumber);
                continue;
            }
            trackCount++;
            if (trackCount === MAX_TRACKS + 1) {
                addIssue(issues, "error", "too-many-tracks", "CUE exceeds 99 tracks.", cue.path, lineNumber);
            }
            const number = Number(match[1]);
            if (number < 1 || number > MAX_TRACKS || number !== lastTrackNumber + 1) {
                addIssue(issues, "error", "track-order", "Track numbers must be sequential from 1 through 99.", cue.path, lineNumber);
            }
            lastTrackNumber = number;
            const mode = match[2]!.toUpperCase();
            const kind = SUPPORTED_TRACK_MODES.get(mode);
            if (kind === undefined) {
                addIssue(issues, "error", "unsupported-track-mode", `Unsupported track mode: ${mode}`, cue.path, lineNumber);
            }
            if (currentFile === undefined) {
                addIssue(issues, "error", "cue-syntax", "TRACK appears before a valid FILE directive.", cue.path, lineNumber);
            } else {
                currentFileHasTrack = true;
            }
            currentTrack = {
                number,
                file: currentFile,
                kind,
                line: lineNumber,
                hasIndexOne: false,
                lastIndex: -1,
                lastTime: -1,
            };
            continue;
        }

        if (/^INDEX(?:\s|$)/iu.test(trimmed)) {
            const match = INDEX_DIRECTIVE.exec(line);
            if (match === null || currentTrack === undefined) {
                addIssue(issues, "error", "cue-syntax", "Malformed or misplaced INDEX directive.", cue.path, lineNumber);
                continue;
            }
            const number = Number(match[1]);
            const minutes = Number(match[2]);
            const seconds = Number(match[3]);
            const frames = Number(match[4]);
            const time = (minutes * 60 + seconds) * 75 + frames;
            if (number < 0 || number > 99 || number <= currentTrack.lastIndex
                || seconds >= 60 || frames >= 75 || time < currentTrack.lastTime) {
                addIssue(issues, "error", "index-order", "INDEX numbers and timestamps must increase and use valid MSF values.", cue.path, lineNumber);
            }
            currentTrack.lastIndex = number;
            currentTrack.lastTime = time;
            if (number === 1) {
                currentTrack.hasIndexOne = true;
                if (currentTrack.file !== undefined) {
                    const previous = lastFileTime.get(currentTrack.file.path);
                    if (previous !== undefined && time < previous) {
                        addIssue(issues, "error", "index-order", "Track INDEX 01 timestamps must increase within a file.", cue.path, lineNumber);
                    }
                    lastFileTime.set(currentTrack.file.path, time);
                }
            }
            continue;
        }

        if (/^(TITLE|PERFORMER|SONGWRITER|FLAGS|PREGAP|POSTGAP|CATALOG|CDTEXTFILE|ISRC)(?:\s|$)/iu.test(trimmed)) {
            continue;
        }
        addIssue(issues, "error", "cue-syntax", "Unsupported or malformed CUE directive.", cue.path, lineNumber);
    }
    finishTrack();
    if (currentFile !== undefined && !currentFileHasTrack) {
        addIssue(issues, "error", "cue-syntax", "FILE is not followed by a TRACK directive.", cue.path, currentFileLine);
    }
    if (trackCount === 0) addIssue(issues, "error", "cue-syntax", "CUE contains no TRACK directives.", cue.path);
    const sbi = sidecarFor(cue, lookup, issues, used);
    return { cue: cue.path, tracks, ...(sbi === undefined ? {} : { sbi }) };
};

/**
 *
 * Class
 *
 */

// Provides a stateless bounded audit for CUE and M3U PlayStation disc sets.
export default class DiscSetAudit {

    // CONSTRUCTOR :: VOID -> discSetAudit
    // Prevents instances because auditing has no persistent state.
    private constructor() {}

    /**
     *
     * Static Methods
     *
     */

    // METHOD :: discSet -> PROMISE(discSetAuditResult)
    // Validates paths, descriptors, disc limits, tracks, sidecars, and references.
    static async audit(set: DiscSet): Promise<DiscSetAuditResult> {
        if (!isAuditInput(set)) {
            throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.INVALID_CONFIG,
                message: "DiscSetAudit input is structurally invalid.",
                data: "set",
            });
        }

        const issues: DiscSetIssue[] = [];
        const used = new Set<string>();
        if (set.files.length > MAX_FILES) {
            addIssue(issues, "error", "too-many-files", "Disc set exceeds 64 files.");
        }
        const seenPaths = new Map<string, string>();
        for (const file of set.files) {
            if (!isDiscPath(file.path)) {
                addIssue(issues, "error", "invalid-path", "File path is not a normalized relative POSIX path.", file.path);
                continue;
            }
            const folded = file.path.toLowerCase();
            const previous = seenPaths.get(folded);
            if (previous !== undefined) {
                addIssue(issues, "error", "duplicate-path", `Path duplicates ${previous} when case-folded.`, file.path);
            } else {
                seenPaths.set(folded, file.path);
            }
        }

        const lookup = lookupFor(set.files);
        let entry: DiscFile | undefined;
        if (!isDiscPath(set.entry)) {
            addIssue(issues, "error", "invalid-path", "Entry path is not a normalized relative POSIX path.", set.entry);
        } else {
            entry = lookup.exact.get(set.entry);
            if (entry === undefined) {
                const folded = lookup.folded.get(set.entry.toLowerCase()) ?? [];
                if (folded.length === 1) {
                    addIssue(issues, "error", "case-mismatch", "Entry path case does not match the supplied file.", set.entry);
                    entry = folded[0];
                } else {
                    addIssue(issues, "error", "entry-missing", "Disc-set entry file is missing.", set.entry);
                }
            }
        }

        const discs: AuditedDiscEntry[] = [];
        if (entry !== undefined) {
            used.add(entry.path);
            const extension = extensionOf(entry.path);
            if (extension === ".cue") {
                discs.push(await auditCue(entry, lookup, issues, used));
            } else if (extension === ".m3u") {
                const text = await descriptorText(entry, issues);
                if (text !== undefined) {
                    const cuePaths = new Set<string>();
                    const lines = text.split(/\r?\n/u);
                    for (let index = 0; index < lines.length; index++) {
                        const reference = lines[index]!.trim();
                        if (reference.length === 0 || reference.startsWith("#")) continue;
                        const file = resolveFile(entry.path, reference, lookup, issues, index + 1);
                        if (file === undefined) continue;
                        const extension = extensionOf(file.path);
                        if (extension === ".m3u") {
                            addIssue(issues, "error", "nested-playlist", "Nested M3U playlists are not supported.", entry.path, index + 1);
                            continue;
                        }
                        if (extension !== ".cue") {
                            addIssue(issues, "error", "unsupported-entry", "M3U entries must reference CUE files.", entry.path, index + 1);
                            continue;
                        }
                        const folded = file.path.toLowerCase();
                        if (cuePaths.has(folded)) {
                            addIssue(issues, "error", "duplicate-disc", "M3U references the same CUE more than once.", entry.path, index + 1);
                            continue;
                        }
                        cuePaths.add(folded);
                        if (cuePaths.size === MAX_DISCS + 1) {
                            addIssue(issues, "error", "too-many-discs", "M3U exceeds eight discs.", entry.path, index + 1);
                        }
                        discs.push(await auditCue(file, lookup, issues, used));
                    }
                    if (cuePaths.size === 0) {
                        addIssue(issues, "error", "m3u-empty", "M3U contains no CUE entries.", entry.path);
                    }
                }
            } else {
                addIssue(issues, "error", "unsupported-entry", "Disc-set entry must be a CUE or M3U file.", entry.path);
            }
        }

        for (const file of set.files) {
            if (isDiscPath(file.path) && !used.has(file.path)) {
                addIssue(issues, "warning", "unreferenced-file", "Supplied file is not referenced by the disc set.", file.path);
            }
        }

        if (issues.some(({ severity }) => severity === "error")) return { ok: false, issues };
        const trackPaths = new Set(discs.flatMap(({ tracks }) => tracks.map(({ file }) => file)));
        const totalBytes = set.files
            .filter(({ path }) => trackPaths.has(path))
            .reduce((total, { blob }) => total + blob.size, 0);
        return {
            ok: true,
            audit: {
                entry: set.entry,
                discs,
                totalBytes,
                warnings: issues.filter(({ severity }) => severity === "warning").map(({ message }) => message),
            },
            issues,
        };
    }
}
