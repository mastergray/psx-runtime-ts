// Type dependencies:
import type {
    PsxGameStore,     // Persistent game library owned by the application
    PsxPlayerStatus,  // Runtime lifecycle state rendered by the stage
    PsxRegion,        // Firmware partition rendered by System
    PsxStorage,       // Firmware, card, and state storage owned by the application
    PsxStoredGame,    // Lightweight game metadata rendered by Library
} from "../src/index.js";

/**
 *
 * Type Declarations
 *
 */

// TYPE :: "system"|"game"|"library"|"memory"|"view"
// Modal surfaces currently implemented by the production interface.
export type UiDialogId = "system" | "game" | "library" | "memory" | "view";

// TYPE :: "loading"|"firmware-required"|"ready"|psxPlayerStatus|"failed"
// Closed presentation states for the central emulator stage.
export type UiStageState = "loading" | "firmware-required" | "ready" | PsxPlayerStatus | "failed";

// TYPE :: "idle"|"working"|"success"|"error"
// Visual severity attached to operation feedback.
export type UiFeedbackState = "idle" | "working" | "success" | "error";

// INTERFACE :: {document:DOCUMENT, storage:psxStorage, gameStore:psxGameStore, buildUrl:STRING}
// Browser and runtime dependencies required to construct the production application.
export interface UiApplicationConfig {
    readonly document: Document;        // Document containing the production UI contract
    readonly storage: PsxStorage;       // Browser-local firmware and memory-card persistence
    readonly gameStore: PsxGameStore;   // Browser-local audited game library
    readonly buildUrl: string;          // Root URL containing the PlayStation core build
}

// INTERFACE :: {region:psxRegion, stored:BOOLEAN, name:STRING?, bytes:NUMBER?}
// One regional firmware slot summarized for display without exposing its Blob.
export interface UiFirmwareSlot {
    readonly region: PsxRegion;    // Firmware region represented by the slot
    readonly stored: boolean;      // Whether browser storage contains a record
    readonly name?: string;        // User-supplied filename when stored
    readonly bytes?: number;       // Stored image byte length when present
}

// INTERFACE :: {games:[psxStoredGame], totalBytes:NUMBER}
// Browser-library snapshot rendered by the shell and Library dialog.
export interface UiLibrarySnapshot {
    readonly games: ReadonlyArray<PsxStoredGame>;    // Stored games ordered by the game store
    readonly totalBytes: number;                     // Aggregate stored content bytes
}

/**
 *
 * Type Predicates
 *
 */

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value names one production dialog.
export function isUiDialogId(value: unknown): value is UiDialogId {
    return value === "system" || value === "game" || value === "library"
        || value === "memory" || value === "view";
}
