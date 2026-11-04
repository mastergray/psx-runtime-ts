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

// TYPE :: "system"|"game"|"library"|"memory"|"view"|"volume"
// Modal surfaces currently implemented by the production interface.
export type UiDialogId = "system" | "game" | "library" | "memory" | "view" | "volume";

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

// INTERFACE :: {title:STRING, filename:STRING, blocks:NUMBER}
// One live save-directory entry rendered from the first block of a PlayStation card file.
export interface PsxMemoryCardSaveSummary {
    readonly title: string;       // Shift-JIS or ASCII title, falling back to the internal filename
    readonly filename: string;    // Internal region, product, and save identifier from the directory
    readonly blocks: number;      // Declared 8 KiB block count occupied by the save
}

// INTERFACE :: {valid:BOOLEAN, usedBlocks:NUMBER, freeBlocks:NUMBER, saves:[psxMemoryCardSaveSummary]}
// Read-only interpretation of a raw 128 KiB PlayStation memory-card directory.
export interface PsxMemoryCardSummary {
    readonly valid: boolean;                                  // Whether the card has a recognizable MC header and directory
    readonly usedBlocks: number;                              // Active data blocks among the fifteen available blocks
    readonly freeBlocks: number;                              // Remaining blocks not marked active
    readonly saves: ReadonlyArray<PsxMemoryCardSaveSummary>;  // First-block file entries in directory order
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
        || value === "memory" || value === "view" || value === "volume";
}
