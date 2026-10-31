import { isAuditedDisc } from "../shared.types.js";

import type { AuditedDisc } from "../shared.types.js";

export type DiscSetIssueSeverity = "error" | "warning";

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

export interface DiscSetIssue {
    readonly severity: DiscSetIssueSeverity;
    readonly code: DiscSetIssueCode;
    readonly message: string;
    readonly path?: string;
    readonly line?: number;
}

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

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

export function isDiscSetIssue(value: unknown): value is DiscSetIssue {
    return isObject(value) && (value.severity === "error" || value.severity === "warning")
        && ISSUE_CODES.includes(value.code as DiscSetIssueCode)
        && typeof value.message === "string" && value.message.trim().length > 0
        && (value.path === undefined || typeof value.path === "string")
        && (value.line === undefined
            || (typeof value.line === "number" && Number.isSafeInteger(value.line) && value.line > 0));
}

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
