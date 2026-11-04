// Type dependencies:
import type {
    PsxScalingMode,     // Runtime display scaling adjusted from the controller
} from "../../src/index.js";

/**
 *
 * Type Declarations
 *
 */

// TYPE :: "idle"|"working"|"success"|"error"
// Presentation feedback severity rendered without opening a local-mode dialog.
export type UiPresentationFeedbackState = "idle" | "working" | "success" | "error";

// INTERFACE :: {id:STRING, buttons:[BOOLEAN]}
// Physical button sample consumed by the rising-edge menu-gesture detector.
export interface UiMenuGestureSample {
    readonly id: string;                       // Device identity including its current browser index
    readonly buttons: ReadonlyArray<boolean>;  // Pressed state by physical standard-gamepad index
}

// INTERFACE :: {gameId:STRING, title:STRING, discCount:NUMBER, totalBytes:NUMBER}
// Stored game row available to the Presentation library.
export interface UiPresentationGame {
    readonly gameId: string;      // Content identity accepted by the game store
    readonly title: string;       // User-facing browser-local title
    readonly discCount: number;   // Selectable initial discs
    readonly totalBytes: number;  // Browser storage represented by the row
}

// INTERFACE :: {gameId:STRING, title:STRING, discIndex:NUMBER, discCount:NUMBER}
// Active session details required by Presentation without owning the emulator.
export interface UiPresentationSession {
    readonly gameId: string;              // Active stored-game identity
    readonly title: string;               // Browser-local display title shown in the TV header
    readonly discIndex: number;           // Mounted zero-based disc index
    readonly discCount: number;           // Number of discs in the active set
}

// INTERFACE :: {firmwareReady:BOOLEAN, scaling:psxScalingMode, games:[uiPresentationGame], session:uiPresentationSession?}
// Complete immutable view model supplied by the production application.
export interface UiPresentationSnapshot {
    readonly firmwareReady: boolean;                    // Whether stored content can be started
    readonly scaling: PsxScalingMode;                   // Current or pending fullscreen scaling
    readonly games: ReadonlyArray<UiPresentationGame>;  // Stored library rows
    readonly session: UiPresentationSession | null;     // Active game when one exists
}

// INTERFACE :: {document:DOCUMENT, storage:STORAGE?, getSnapshot:(VOID -> uiPresentationSnapshot), pauseForMenu:(VOID -> PROMISE(BOOLEAN)), resumeFromMenu:(BOOLEAN -> VOID), enterFullscreen:(VOID -> PROMISE(VOID)), leaveFullscreen:(VOID -> PROMISE(VOID)), startGame:(STRING, NUMBER -> PROMISE(VOID)), changeDisc:(NUMBER -> PROMISE(VOID)), reset:(VOID -> PROMISE(VOID)), setScaling:(psxScalingMode -> VOID)}
// Browser and application operations composed by the Presentation controller.
export interface UiPresentationModeConfig {
    readonly document: Document;                                       // Document containing the Presentation contract
    readonly storage: Storage | null;                                  // Browser-local mode persistence
    readonly getSnapshot: () => UiPresentationSnapshot;                // Current runtime and library view model
    readonly pauseForMenu: () => Promise<boolean>;                     // Pauses a running game and reports ownership
    readonly resumeFromMenu: (ownedPause: boolean) => void;            // Resumes only a menu-owned pause
    readonly enterFullscreen: () => Promise<void>;                     // Best-effort root fullscreen and orientation lock
    readonly leaveFullscreen: () => Promise<void>;                     // Best-effort fullscreen exit and orientation unlock
    readonly startGame: (gameId: string, discIndex: number) => Promise<void>; // Starts one stored title and initial disc
    readonly changeDisc: (discIndex: number) => Promise<void>;         // Inserts a disc without restarting
    readonly reset: () => Promise<void>;                               // Performs one soft reset
    readonly setScaling: (scaling: PsxScalingMode) => void;            // Applies runtime display scaling
}

// INTERFACE :: {document:DOCUMENT, root:HTMLELEMENT, gestureTarget:HTMLELEMENT, getGamepads:(VOID -> [GAMEPAD?]), scheduler:{request:((VOID -> VOID) -> NUMBER), cancel:(NUMBER -> VOID), now:(VOID -> NUMBER)}, onToggle:(VOID -> VOID), onBack:(VOID -> VOID), onAdjust:(STRING, -1|1 -> VOID)}
// Controller, keyboard, and touch dependencies for Presentation focus navigation.
export interface UiPresentationInputConfig {
    readonly document: Document;                                  // Owning document for focus and keyboard events
    readonly root: HTMLElement;                                   // Menu root containing focusable controls
    readonly gestureTarget: HTMLElement;                          // Surface accepting the two-finger menu gesture
    readonly getGamepads: () => ReadonlyArray<Gamepad | null>;    // Browser gamepad snapshot provider
    readonly scheduler: {
        readonly request: (callback: () => void) => number;        // Animation-frame scheduling
        readonly cancel: (handle: number) => void;                 // Animation-frame cancellation
        readonly now: () => number;                               // Monotonic navigation-repeat clock
    };
    readonly onToggle: () => void;                                // Opens or closes the Presentation menu
    readonly onBack: () => void;                                  // Steps back one Presentation view level
    readonly onAdjust: (setting: string, step: -1 | 1) => void;   // Changes a focused inline selector
}
