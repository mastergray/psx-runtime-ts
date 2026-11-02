/**
 *
 * Type Declarations
 *
 */

// INTERFACE :: {name:STRING, blob:blob}
// One firmware image selected and extracted from a user-supplied archive.
export interface PsxFirmwareFile {
    readonly name: string;    // Archive basename retained for regional diagnostics
    readonly blob: Blob;      // Exact extracted firmware bytes
}

/**
 *
 * Type Predicates
 *
 */

// This module currently exposes no standalone runtime predicates; archive validation owns that boundary.
