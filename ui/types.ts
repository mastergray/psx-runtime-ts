// Dependencies:
import { isGamepadButtonMaps, isKeyboardMap, isPsxControllerType } from "../src/index.js"; // Validates persisted control preferences

// Type dependencies:
import type {
    ControllerPort,    // Physical player port used by assignments and controller preferences
    GamepadButtonMaps, // Device-specific digital mappings persisted by the production UI
    KeyboardMap,       // Browser-code-to-PlayStation mappings persisted by the production UI
    PsxButton,         // Logical PlayStation button selected during binding capture
    PsxControllerType, // Emulated controller device selected for one game and port
    PsxGameStore,     // Persistent game library owned by the application
    PsxPlayerStatus,  // Runtime lifecycle state rendered by the stage
    PsxRegion,        // Firmware partition rendered by System
    PsxScalingMode,   // Windowed display scaling accepted by the runtime
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

// TYPE :: "session"|"import"
// Game modal panel selected while an active session makes both workflows available.
export type UiGamePanel = "session" | "import";

// TYPE :: "firmware"|"controls"
// System modal panel selected by its top-level tabs.
export type UiSystemPanel = "firmware" | "controls";

// TYPE :: psxScalingMode|"fullscreen-fit"|"fullscreen-stretch"
// Deferred View selection combining windowed scaling with the two supported fullscreen presentations.
export type UiViewMode = PsxScalingMode | "fullscreen-fit" | "fullscreen-stretch";

// TYPE :: "defaults"|"loaded"|"invalid"|"unavailable"
// Result of loading the browser-local control profile.
export type UiControlProfileLoadStatus = "defaults" | "loaded" | "invalid" | "unavailable";

// INTERFACE :: {document:DOCUMENT, storage:STORAGE?}
// Browser dependencies used by the production control-mapping surface.
export interface UiControlSettingsConfig {
    readonly document: Document;       // Document containing System Controls elements
    readonly storage: Storage | null;  // Browser-local profile storage; null keeps changes page-local
}

// INTERFACE :: {index:NUMBER, id:STRING}
// One connected standard gamepad assigned to a PlayStation controller port.
export interface UiGamepadAssignment {
    readonly index: number;  // Browser Gamepad API slot
    readonly id: string;     // Stable browser device identity used for mappings and preferences
}

// INTERFACE :: {buttons:[BOOLEAN]}
// Pressed-button snapshot captured before waiting for a fresh gamepad input.
export interface UiBindingCaptureBaseline {
    readonly buttons: boolean[];  // Per-index pressed state updated after held buttons are released
}

// TYPE :: {kind:"binding", port:controllerPort, button:psxButton, baseline:MAP(NUMBER, uiBindingCaptureBaseline), frame:NUMBER}|{kind:"assignment", port:controllerPort, baseline:MAP(NUMBER, uiBindingCaptureBaseline), frame:NUMBER}
// Active keyboard/gamepad binding capture or gamepad-to-player assignment capture.
export type UiControlCapture = {
    readonly kind: "binding";
    readonly port: ControllerPort;
    readonly button: PsxButton;
    readonly baseline: Map<number, UiBindingCaptureBaseline>;
    frame: number;
} | {
    readonly kind: "assignment";
    readonly port: ControllerPort;
    readonly baseline: Map<number, UiBindingCaptureBaseline>;
    frame: number;
};

// INTERFACE :: {keyboard:HTMLELEMENT, gamepad:HTMLELEMENT, change:HTMLBUTTONELEMENT}
// Rendered cells and action retained for one logical PlayStation control row.
export interface UiControlBindingView {
    readonly keyboard: HTMLElement;           // Current keyboard binding label
    readonly gamepad: HTMLElement;            // Current assigned-device button label
    readonly change: HTMLButtonElement;       // Capture toggle for this logical control
}

// INTERFACE :: {version:1, keyboard:keyboardMap, gamepads:gamepadButtonMaps, gamepadPorts:ARRAY<STRING, controllerPort>?, leftStickDpad:ARRAY<controllerPort, BOOLEAN>?}
// Versioned browser-local keyboard, gamepad, assignment, and compatibility preferences.
export interface UiStoredControlProfile {
    readonly version: 1;                                                   // Storage schema version
    readonly keyboard: KeyboardMap;                                        // Complete two-player keyboard mapping
    readonly gamepads: GamepadButtonMaps;                                  // Device-specific gamepad overrides
    readonly gamepadPorts?: Readonly<Record<string, ControllerPort>>;      // Preferred player port by device identity
    readonly leftStickDpad?: Readonly<Record<ControllerPort, boolean>>;    // Per-player digital-game stick compatibility
}

// INTERFACE :: {version:1, games:ARRAY<STRING, ARRAY<controllerPort, psxControllerType>>}
// Per-game emulated controller types retained for subsequent starts.
export interface UiControllerTypePreferences {
    readonly version: 1;   // Storage schema version
    readonly games: Readonly<Record<string, Readonly<Record<ControllerPort, PsxControllerType>>>>; // Types by game and port
}

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

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is one supported windowed or fullscreen View selection.
export function isUiViewMode(value: unknown): value is UiViewMode {
    return value === "fit" || value === "integer" || value === "fill" || value === "stretch"
        || value === "fullscreen-fit" || value === "fullscreen-stretch";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a complete version-one control profile with valid optional assignment maps.
export function isUiStoredControlProfile(value: unknown): value is UiStoredControlProfile {
    const profile = objectRecord(value);
    return profile !== null && profile.version === 1
        && isKeyboardMap(profile.keyboard) && isGamepadButtonMaps(profile.gamepads)
        && (profile.gamepadPorts === undefined || isStoredGamepadPorts(profile.gamepadPorts))
        && (profile.leftStickDpad === undefined || isStoredLeftStickDpad(profile.leftStickDpad));
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value contains complete per-port controller types for every non-empty game identity.
export function isUiControllerTypePreferences(value: unknown): value is UiControllerTypePreferences {
    const preferences = objectRecord(value);
    const games = objectRecord(preferences?.games);
    return preferences?.version === 1 && games !== null && Object.entries(games).every(([gameId, ports]) => {
        const controllers = objectRecord(ports);
        return gameId.trim().length > 0 && controllers !== null
            && Object.keys(controllers).every((port) => port === "1" || port === "2")
            && isPsxControllerType(controllers[1]) && isPsxControllerType(controllers[2]);
    });
}

/**
 *
 *  Helper Functions
 *
 */

// HELPER :: UNKNOWN -> ARRAY<STRING, UNKNOWN>?
// Narrows one non-array object for persisted-profile inspection.
const objectRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;

// HELPER :: UNKNOWN -> BOOLEAN
// True when value maps non-empty gamepad identities to unique physical controller ports.
const isStoredGamepadPorts = (value: unknown): value is Readonly<Record<string, ControllerPort>> => {
    const ports = objectRecord(value);
    return ports !== null && Object.entries(ports).every(([id, port]) => id.trim().length > 0
        && (port === 1 || port === 2));
};

// HELPER :: UNKNOWN -> BOOLEAN
// True when value supplies both controller-port compatibility flags.
const isStoredLeftStickDpad = (value: unknown): value is Readonly<Record<ControllerPort, boolean>> => {
    const ports = objectRecord(value);
    return ports !== null && Object.keys(ports).every((port) => port === "1" || port === "2")
        && typeof ports[1] === "boolean" && typeof ports[2] === "boolean";
};
