// Dependencies:
import { isAuditedDisc } from "../shared.types.js";    // Validates successful audit payloads

// Type dependencies:
import type { AuditedDisc } from "../shared.types.js"; // Resolved disc metadata returned after a successful audit

/**
 *
 * Type Declarations
 *
 */

// TYPE :: "error"|"warning"
// Severity assigned to one disc-set diagnostic.
export type DiscSetIssueSeverity = "error" | "warning";

// TYPE :: "invalid-path"|"duplicate-path"|"too-many-files"|"entry-missing"|"unsupported-entry"|"descriptor-empty"|"descriptor-too-large"|"descriptor-read-failed"|"invalid-utf8"|"control-character"|"cue-line-too-long"|"cue-syntax"|"unsupported-file-type"|"unsupported-track-mode"|"too-many-tracks"|"track-order"|"index-order"|"missing-index"|"missing-file"|"case-mismatch"|"empty-track"|"m3u-empty"|"too-many-discs"|"duplicate-disc"|"nested-playlist"|"unreferenced-file"
// Stable machine-readable diagnostic categories emitted by the audit.
export type DiscSetIssueCode =
    | "invalid-path"
    | "duplicate-path"
    | "too-many-files"
    | "entry-missing"
    | "unsupported-entry"
    | "descriptor-empty"
    | "descriptor-too-large"
    | "descriptor-read-failed"
    | "invalid-utf8"
    | "control-character"
    | "cue-line-too-long"
    | "cue-syntax"
    | "unsupported-file-type"
    | "unsupported-track-mode"
    | "too-many-tracks"
    | "track-order"
    | "index-order"
    | "missing-index"
    | "missing-file"
    | "case-mismatch"
    | "empty-track"
    | "m3u-empty"
    | "too-many-discs"
    | "duplicate-disc"
    | "nested-playlist"
    | "unreferenced-file";

// INTERFACE :: {severity:discSetIssueSeverity, code:discSetIssueCode, message:STRING, path:STRING?, line:NUMBER?}
// One structured audit diagnostic with optional source location.
export interface DiscSetIssue {
    readonly severity: DiscSetIssueSeverity;    // Whether the issue blocks use or only warns
    readonly code: DiscSetIssueCode;            // Stable programmatic diagnostic category
    readonly message: string;                   // Human-readable explanation
    readonly path?: string;                     // Related normalized content path
    readonly line?: number;                     // One-based descriptor line when applicable
}

// TYPE :: {ok:TRUE, audit:auditedDisc, issues:[discSetIssue]}|{ok:FALSE, issues:[discSetIssue]}
// Discriminated result containing resolved metadata only when no blocking issue exists.
export type DiscSetAuditResult =
    | {
        readonly ok: true;
        readonly audit: AuditedDisc;
        readonly issues: ReadonlyArray<DiscSetIssue>;
    }
    | {
        readonly ok: false;
        readonly issues: ReadonlyArray<DiscSetIssue>;
    };

const ISSUE_CODES: ReadonlyArray<DiscSetIssueCode> = [
    "invalid-path", "duplicate-path", "too-many-files", "entry-missing", "unsupported-entry",
    "descriptor-empty", "descriptor-too-large", "descriptor-read-failed", "invalid-utf8",
    "control-character", "cue-line-too-long", "cue-syntax", "unsupported-file-type",
    "unsupported-track-mode", "too-many-tracks", "track-order", "index-order", "missing-index",
    "missing-file", "case-mismatch", "empty-track", "m3u-empty", "too-many-discs",
    "duplicate-disc", "nested-playlist", "unreferenced-file",
];

/**
 *
 * Type Predicates
 *
 */

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a non-null object suitable for structural inspection.
const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a supported issue with valid optional location fields.
export function isDiscSetIssue(value: unknown): value is DiscSetIssue {
    return isObject(value) && (value.severity === "error" || value.severity === "warning")
        && ISSUE_CODES.includes(value.code as DiscSetIssueCode)
        && typeof value.message === "string" && value.message.trim().length > 0
        && (value.path === undefined || typeof value.path === "string")
        && (value.line === undefined
            || (typeof value.line === "number" && Number.isSafeInteger(value.line) && value.line > 0));
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a coherent success or failure audit result.
export function isDiscSetAuditResult(value: unknown): value is DiscSetAuditResult {
    if (!isObject(value) || typeof value.ok !== "boolean"
        || !Array.isArray(value.issues) || !value.issues.every(isDiscSetIssue)) return false;
    if (value.ok) {
        return isAuditedDisc(value.audit)
            && !(value.issues as DiscSetIssue[]).some(({ severity }) => severity === "error");
    }
    return (value.issues as DiscSetIssue[]).some(({ severity }) => severity === "error")
        && value.audit === undefined;
}
