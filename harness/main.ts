import {
    DEFAULT_GAMEPAD_BUTTON_MAP,
    DEFAULT_KEYBOARD_MAP,
    LibretroPsxAdapter,
    MultiZipDiscSource,
    PsxConsole,
    PsxGameStore,
    PsxRuntimeError,
    PsxStorage,
    ZipDiscSource,
    ZipFirmwareSource,
    isGamepadButtonMaps,
    isKeyboardMap,
} from "../src/index.js";
import TouchController from "./TouchController.js";

import type {
    BiosImage,
    ControllerPort,
    GamepadButtonMap,
    GamepadButtonMaps,
    KeyboardMap,
    PsxButton,
    PsxControllerType,
    PsxFileListLike,
    PsxFirmwareRecord,
    PsxPlayer,
    PsxRegion,
    PsxScalingMode,
    PsxStateRecord,
    PsxStoredGame,
    PsxMultiZipManifest,
    PsxPlaybackRate,
} from "../src/index.js";

interface PreloadManifest {
    readonly available: boolean;
    readonly buildUrl?: string;
    readonly entry?: string;
    readonly bios?: { readonly name: string; readonly url: string; readonly region: "ntsc-u" | "ntsc-j" | "pal" };
    readonly files?: ReadonlyArray<{ readonly name: string; readonly path: string; readonly url: string }>;
}

const DEFAULT_FIRMWARE_REGION: PsxRegion = "ntsc-u";
const CONTROL_PROFILE_STORAGE_KEY = "psx-runtime:ui:controls";
const QUICK_STATE_STORAGE_KEY = "psx-runtime:ui:quick-states";
const TOUCH_CONTROLLER_STORAGE_KEY = "psx-runtime:ui:touch-controller";
const HARNESS_PROFILE_ID = "harness";
const FAST_FORWARD_RATES = [2, 5, 7] as const;
const QUICK_STATE_NAMES = ["Quick State 1", "Quick State 2"] as const;

const element = <T extends HTMLElement>(id: string): T => {
    const value = document.querySelector(`#${id}`);
    if (value === null) throw new Error(`Missing harness element: ${id}`);
    return value as T;
};

const logElement = element<HTMLPreElement>("log");
const statusElement = element<HTMLElement>("status");
const statusStrip = element<HTMLElement>("status-strip");
const statusDetail = element<HTMLElement>("status-detail");
const screenMessage = element<HTMLElement>("screen-message");
const pauseOverlay = element<HTMLElement>("pause-overlay");
const speedIndicator = element<HTMLElement>("speed-indicator");
const noticeToast = element<HTMLDivElement>("notice-toast");
const gameMenuButton = element<HTMLButtonElement>("game-menu");
const libraryMenuButton = element<HTMLButtonElement>("library-menu");
const statesMenuButton = element<HTMLButtonElement>("states-menu");
const gameDialog = element<HTMLDialogElement>("game-dialog");
const gameDialogCloseButton = element<HTMLButtonElement>("game-dialog-close");
const gameControls = element<HTMLFieldSetElement>("game-controls");
const libraryDialog = element<HTMLDialogElement>("library-dialog");
const deleteGameDialog = element<HTMLDialogElement>("delete-game-dialog");
const viewDialog = element<HTMLDialogElement>("view-dialog");
const sessionDialog = element<HTMLDialogElement>("session-dialog");
const statesDialog = element<HTMLDialogElement>("states-dialog");
const stateConfirmDialog = element<HTMLDialogElement>("state-confirm-dialog");
const canvas = element<HTMLCanvasElement>("screen");
const container = element<HTMLDivElement>("screen-stage");
const playStage = element<HTMLDivElement>("play-stage");
const touchControllerElement = element<HTMLElement>("touch-controller");
const touchControllerViewInput = element<HTMLSelectElement>("touch-controller-view");
const touchControllerPortInput = element<HTMLSelectElement>("touch-controller-port");
const touchControllerSwapInput = element<HTMLInputElement>("touch-controller-swap");
const touchControllerStatus = element<HTMLElement>("touch-controller-status");
const touchPortLabel = element<HTMLElement>("touch-port-label");
const touchControllerToggle = element<HTMLButtonElement>("touch-controller-toggle");
const buildUrlInput = element<HTMLInputElement>("build-url");
const biosInput = element<HTMLInputElement>("bios");
const biosRegionInput = element<HTMLSelectElement>("bios-region");
biosRegionInput.value = DEFAULT_FIRMWARE_REGION;
const filesInput = element<HTMLInputElement>("game-files");
const gameDropZone = element<HTMLElement>("game-drop-zone");
const gameSelection = element<HTMLElement>("game-selection");
const gameArchiveList = element<HTMLOListElement>("game-archive-list");
const clearGameSelectionButton = element<HTMLButtonElement>("clear-game-selection");
const entryChoice = element<HTMLElement>("entry-choice");
const entrySelect = element<HTMLSelectElement>("entry-select");
const m3uPanel = element<HTMLElement>("m3u-panel");
const m3uDescription = element<HTMLElement>("m3u-description");
const m3uPreview = element<HTMLPreElement>("m3u-preview");
const controllerOneInput = element<HTMLSelectElement>("controller-1");
const controllerTwoInput = element<HTMLSelectElement>("controller-2");
const leftStickDpadInputs: Record<ControllerPort, HTMLInputElement> = {
    1: element<HTMLInputElement>("left-stick-dpad-1"),
    2: element<HTMLInputElement>("left-stick-dpad-2"),
};
const controllersDialog = element<HTMLDialogElement>("controllers-dialog");
const controllerTabs: Record<ControllerPort, HTMLButtonElement> = {
    1: element<HTMLButtonElement>("player-tab-1"),
    2: element<HTMLButtonElement>("player-tab-2"),
};
const controllerPanels: Record<ControllerPort, HTMLElement> = {
    1: element<HTMLElement>("player-panel-1"),
    2: element<HTMLElement>("player-panel-2"),
};
const padLabels: Record<ControllerPort, HTMLElement> = {
    1: element<HTMLElement>("pad-label-1"),
    2: element<HTMLElement>("pad-label-2"),
};
const bindingBodies: Record<ControllerPort, HTMLTableSectionElement> = {
    1: element<HTMLTableSectionElement>("bindings-1"),
    2: element<HTMLTableSectionElement>("bindings-2"),
};
const bindingStatuses: Record<ControllerPort, HTMLElement> = {
    1: element<HTMLElement>("binding-status-1"),
    2: element<HTMLElement>("binding-status-2"),
};
const bindingViews: Record<ControllerPort, Map<PsxButton, {
    readonly keyboard: HTMLElement;
    readonly gamepad: HTMLElement;
    readonly change: HTMLButtonElement;
}>> = { 1: new Map(), 2: new Map() };
const controllerTypeStatus = element<HTMLElement>("controller-type-status");
const fastForwardSelection = element<HTMLElement>("fast-forward-selection");
const controlStorageStatus = element<HTMLElement>("control-storage-status");
const restoreControlsButton = element<HTMLButtonElement>("restore-controls");
const memoryCardStatus = element<HTMLElement>("memory-card-status");
const memoryCardFeedback = element<HTMLElement>("memory-card-feedback");
const replacementCardInput = element<HTMLInputElement>("replacement-card");
const downloadCardButtons = [
    element<HTMLButtonElement>("download-card-1"),
    element<HTMLButtonElement>("download-card-2"),
];
const replaceCardButtons = [
    element<HTMLButtonElement>("replace-card-1"),
    element<HTMLButtonElement>("replace-card-2"),
];
const inputStatus = element<HTMLElement>("input-status");
const audioStatus = element<HTMLElement>("audio-status");
const sessionAudioStatus = element<HTMLElement>("session-audio-status");
const firmwareStatus = element<HTMLElement>("firmware-status");
const gameFeedback = element<HTMLElement>("game-feedback");
const discFeedback = element<HTMLElement>("disc-feedback");
const discSelect = element<HTMLSelectElement>("disc-index");
const storedGameInput = element<HTMLSelectElement>("stored-game");
const storedDiscSelect = element<HTMLSelectElement>("stored-disc-index");
const storedDiscFeedback = element<HTMLElement>("stored-disc-feedback");
const storedTitleInput = element<HTMLInputElement>("stored-title");
const librarySummary = element<HTMLElement>("library-summary");
const storedGameDetails = element<HTMLElement>("stored-game-details");
const startStoredButton = element<HTMLButtonElement>("start-stored");
const downloadStoredM3uButton = element<HTMLButtonElement>("download-stored-m3u");
const renameStoredButton = element<HTMLButtonElement>("rename-stored");
const deleteStoredButton = element<HTMLButtonElement>("delete-stored");
const confirmDeleteStoredButton = element<HTMLButtonElement>("confirm-delete-stored");
const deleteGameName = element<HTMLElement>("delete-game-name");
const startButton = element<HTMLButtonElement>("start");
const restartDiscButton = element<HTMLButtonElement>("restart-disc");
const auditButton = element<HTMLButtonElement>("audit");
const firmwareStoreButton = element<HTMLButtonElement>("check-store-firmware");
const deleteFirmwareButton = element<HTMLButtonElement>("delete-firmware");
const pauseButton = element<HTMLButtonElement>("pause");
const resetButton = element<HTMLButtonElement>("soft-reset");
const muteAudioButton = element<HTMLButtonElement>("mute-audio");
const newStateNameInput = element<HTMLInputElement>("new-state-name");
const saveNewStateButton = element<HTMLButtonElement>("save-new-state");
const stateGame = element<HTMLElement>("state-game");
const stateFeedback = element<HTMLElement>("state-feedback");
const stateList = element<HTMLTableSectionElement>("state-list");
const stateConfirmTitle = element<HTMLElement>("state-confirm-title");
const stateConfirmMessage = element<HTMLElement>("state-confirm-message");
const confirmStateActionButton = element<HTMLButtonElement>("confirm-state-action");
const fullscreenButtons: Readonly<Record<"fit" | "stretch", HTMLButtonElement>> = {
    fit: element<HTMLButtonElement>("fullscreen-fit"),
    stretch: element<HTMLButtonElement>("fullscreen-stretch"),
};
const viewStatus = element<HTMLElement>("view-status");
let preloadBios: File | null = null;
let preloadRegion: "ntsc-u" | "ntsc-j" | "pal" = "ntsc-u";
let selectedGameArchives: File[] = [];
let storedM3u: { readonly name: string; readonly blob: Blob } | null = null;
let storedM3uRevision = 0;
let runtime: PsxConsole | null = null;
let player: PsxPlayer | null = null;
let activeBuildUrl = "";
let supportedFirmwareByteLengths: ReadonlyArray<number> = [];
let activeFirmwareByteLengths: ReadonlyArray<number> = [];
let visibleFrameUnsubscribe: (() => void) | null = null;
let launchInProgress = false;
let gameImportInProgress = false;
let pendingDiscCount: number | null = null;
let pendingStoredGameId: string | null = null;
let pendingDeleteGameId: string | null = null;
let screenMessageRevision = 0;
let entryInspectionRevision = 0;
let fullscreenExitChordHeld = false;
let selectedFastForwardRate: PsxPlaybackRate = 2;
let quickStateOperationInProgress = false;
const heldRuntimeShortcuts = new Set<string>();
let quickStateAssignments: QuickStateAssignments = {};
let stateRecords: ReadonlyArray<PsxStateRecord> = [];
let pendingStateAction: { readonly kind: "overwrite" | "delete"; readonly name: string } | null = null;
let modalPauseOwner: PsxPlayer | null = null;
let modalPauseTask: Promise<void> | null = null;
let noticeRevision = 0;
const storedGameTitles = new Map<string, string>();
const storedGames = new Map<string, PsxStoredGame>();

type TouchControllerView = "auto" | "show" | "hide";

interface TouchControllerPreferences {
    readonly version: 1;
    readonly view: TouchControllerView;
    readonly port: ControllerPort;
    readonly swap: boolean;
}

let touchControllerPreferences: TouchControllerPreferences = {
    version: 1,
    view: "auto",
    port: 1,
    swap: false,
};
const touchController = new TouchController({ root: touchControllerElement });

interface GamepadAssignment {
    readonly index: number;
    readonly id: string;
}

const gamepadAssignments: Record<ControllerPort, GamepadAssignment | null> = { 1: null, 2: null };
const gamepadPortPreferences: Record<string, ControllerPort> = Object.create(null) as Record<string, ControllerPort>;
const gamepadButtonMaps: Record<string, GamepadButtonMap> = Object.create(null) as Record<string, GamepadButtonMap>;
const leftStickDpad: Record<ControllerPort, boolean> = { 1: false, 2: false };

interface BindingCaptureBaseline {
    readonly buttons: boolean[];
}

interface BindingCapture {
    readonly port: ControllerPort;
    readonly button: PsxButton;
    readonly baseline: Map<number, BindingCaptureBaseline>;
    frame: number;
}

let bindingCapture: BindingCapture | null = null;
const gameStore = PsxGameStore.init();
const storage = PsxStorage.init();
const storedFirmware = new Map<PsxRegion, PsxFirmwareRecord>();
const reportedErrors = new WeakSet<object>();

const DEFAULT_HARNESS_KEYBOARD_MAP: KeyboardMap = Object.freeze({
    ...DEFAULT_KEYBOARD_MAP,
    KeyI: { port: 2, button: "up" },
    KeyK: { port: 2, button: "down" },
    KeyJ: { port: 2, button: "left" },
    KeyL: { port: 2, button: "right" },
    KeyN: { port: 2, button: "cross" },
    KeyM: { port: 2, button: "circle" },
    KeyV: { port: 2, button: "square" },
    KeyB: { port: 2, button: "triangle" },
    KeyU: { port: 2, button: "l1" },
    KeyO: { port: 2, button: "r1" },
    Digit7: { port: 2, button: "l2" },
    Digit8: { port: 2, button: "r2" },
    KeyP: { port: 2, button: "start" },
    KeyY: { port: 2, button: "select" },
});

let keyboardMap: KeyboardMap = DEFAULT_HARNESS_KEYBOARD_MAP;

const write = (message: string): void => {
    logElement.textContent = `${new Date().toISOString()} ${message}\n${logElement.textContent ?? ""}`.slice(0, 12_000);
    statusDetail.textContent = message;
    statusDetail.title = message;
};

type ControlProfileLoadStatus = "defaults" | "loaded" | "invalid" | "unavailable";

type QuickStateSlot = 1 | 2;

type QuickStateAssignments = Record<string, Partial<Record<QuickStateSlot, string>>>;

interface StoredControlProfile {
    readonly version: 1;
    readonly keyboard: KeyboardMap;
    readonly gamepads: GamepadButtonMaps;
    readonly gamepadPorts?: Readonly<Record<string, ControllerPort>>;
    readonly leftStickDpad?: Readonly<Record<ControllerPort, boolean>>;
}

const record = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;

const loadQuickStateAssignments = (): void => {
    let source: string | null;
    try {
        source = localStorage.getItem(QUICK_STATE_STORAGE_KEY);
    } catch {
        return;
    }
    if (source === null) return;
    try {
        const stored = record(JSON.parse(source));
        const games = record(stored?.games);
        if (stored?.version !== 1 || games === null) return;
        const loaded: QuickStateAssignments = {};
        for (const [gameId, value] of Object.entries(games)) {
            const slots = record(value);
            if (gameId.trim().length === 0 || slots === null
                || Object.keys(slots).some((slot) => slot !== "1" && slot !== "2")) return;
            const one = slots[1];
            const two = slots[2];
            if ((one !== undefined && (typeof one !== "string" || one.trim().length === 0 || one.length > 80))
                || (two !== undefined && (typeof two !== "string" || two.trim().length === 0 || two.length > 80))
                || (typeof one === "string" && one === two)) return;
            loaded[gameId] = {
                ...(typeof one === "string" ? { 1: one.normalize("NFC") } : {}),
                ...(typeof two === "string" ? { 2: two.normalize("NFC") } : {}),
            };
        }
        quickStateAssignments = loaded;
    } catch {
        // Invalid or unavailable browser data leaves quick slots unassigned.
    }
};

const persistQuickStateAssignments = (): boolean => {
    try {
        localStorage.setItem(QUICK_STATE_STORAGE_KEY, JSON.stringify({
            version: 1,
            games: quickStateAssignments,
        }));
        return true;
    } catch {
        return false;
    }
};

const quickStateNameFor = (gameId: string, slot: QuickStateSlot): string | null => {
    const stored = quickStateAssignments[gameId];
    if (stored !== undefined) return stored[slot] ?? null;
    const fallback = slot === 1 ? QUICK_STATE_NAMES[0] : QUICK_STATE_NAMES[1];
    return stateRecords.some((record) => record.name === fallback) ? fallback : null;
};

const assignQuickState = (gameId: string, slot: QuickStateSlot, name: string): boolean => {
    const otherSlot: QuickStateSlot = slot === 1 ? 2 : 1;
    const previousOne = quickStateNameFor(gameId, 1);
    const previousTwo = quickStateNameFor(gameId, 2);
    const previousTarget = slot === 1 ? previousOne : previousTwo;
    const previousOther = otherSlot === 1 ? previousOne : previousTwo;
    const next: Partial<Record<QuickStateSlot, string>> = {};
    if (previousOne !== null) next[1] = previousOne;
    if (previousTwo !== null) next[2] = previousTwo;
    next[slot] = name;
    if (previousOther === name) {
        if (previousTarget === null || previousTarget === name) delete next[otherSlot];
        else next[otherSlot] = previousTarget;
    }
    quickStateAssignments = { ...quickStateAssignments, [gameId]: next };
    return persistQuickStateAssignments();
};

const clearQuickStateName = (gameId: string, name: string): void => {
    const current = quickStateAssignments[gameId];
    if (current === undefined || (current[1] !== name && current[2] !== name)) return;
    const next: Partial<Record<QuickStateSlot, string>> = { ...current };
    if (next[1] === name) delete next[1];
    if (next[2] === name) delete next[2];
    const remaining = Object.keys(next).length === 0
        ? Object.fromEntries(Object.entries(quickStateAssignments).filter(([id]) => id !== gameId))
        : { ...quickStateAssignments, [gameId]: next };
    quickStateAssignments = remaining;
    persistQuickStateAssignments();
};

const frozenKeyboardMap = (map: KeyboardMap): KeyboardMap => Object.freeze(Object.fromEntries(
    Object.entries(map).map(([code, control]) => [code, Object.freeze({ ...control })]),
));

const isStoredLeftStickDpad = (value: unknown): value is Readonly<Record<ControllerPort, boolean>> => {
    const map = record(value);
    return map !== null && Object.keys(map).every((port) => port === "1" || port === "2")
        && typeof map[1] === "boolean" && typeof map[2] === "boolean";
};

const isStoredGamepadPorts = (value: unknown): value is Readonly<Record<string, ControllerPort>> => {
    const map = record(value);
    return map !== null && Object.entries(map).every(([id, port]) => id.trim().length > 0
        && (port === 1 || port === 2));
};

const loadControlProfile = (): ControlProfileLoadStatus => {
    let source: string | null;
    try {
        source = localStorage.getItem(CONTROL_PROFILE_STORAGE_KEY);
    } catch {
        return "unavailable";
    }
    if (source === null) return "defaults";
    try {
        const profile = record(JSON.parse(source));
        if (profile?.version !== 1 || !isKeyboardMap(profile.keyboard)
            || !isGamepadButtonMaps(profile.gamepads)
            || (profile.gamepadPorts !== undefined
                && !isStoredGamepadPorts(profile.gamepadPorts))
            || (profile.leftStickDpad !== undefined
                && !isStoredLeftStickDpad(profile.leftStickDpad))) return "invalid";
        keyboardMap = frozenKeyboardMap(profile.keyboard);
        for (const [id, map] of Object.entries(profile.gamepads)) {
            gamepadButtonMaps[id] = Object.freeze({ ...map });
        }
        if (isStoredGamepadPorts(profile.gamepadPorts)) {
            Object.assign(gamepadPortPreferences, profile.gamepadPorts);
        }
        if (isStoredLeftStickDpad(profile.leftStickDpad)) {
            leftStickDpad[1] = profile.leftStickDpad[1];
            leftStickDpad[2] = profile.leftStickDpad[2];
        }
        return "loaded";
    } catch {
        return "invalid";
    }
};

const persistControlProfile = (): boolean => {
    const profile: StoredControlProfile = {
        version: 1,
        keyboard: keyboardMap,
        gamepads: gamepadButtonMaps,
        gamepadPorts: gamepadPortPreferences,
        leftStickDpad: { ...leftStickDpad },
    };
    try {
        localStorage.setItem(CONTROL_PROFILE_STORAGE_KEY, JSON.stringify(profile));
        controlStorageStatus.textContent = "Control bindings are stored in this browser and will survive reloads.";
        return true;
    } catch {
        controlStorageStatus.textContent = "Bindings changed for this session, but browser storage is unavailable.";
        return false;
    }
};

const removeStoredControlProfile = (): boolean => {
    try {
        localStorage.removeItem(CONTROL_PROFILE_STORAGE_KEY);
        controlStorageStatus.textContent = "Default bindings restored; the stored control profile was removed.";
        return true;
    } catch {
        controlStorageStatus.textContent = "Default bindings restored for this session, but browser storage is unavailable.";
        return false;
    }
};

const connectedStandardGamepads = (): ReadonlyArray<Gamepad> =>
    [...navigator.getGamepads()].filter((pad): pad is Gamepad =>
        pad !== null && pad.connected && pad.mapping === "standard");

const loadTouchControllerPreferences = (): void => {
    try {
        const source = localStorage.getItem(TOUCH_CONTROLLER_STORAGE_KEY);
        if (source !== null) {
            const stored = record(JSON.parse(source));
            if (stored?.version === 1
                && (stored.view === "auto" || stored.view === "show" || stored.view === "hide")
                && (stored.port === 1 || stored.port === 2) && typeof stored.swap === "boolean") {
                touchControllerPreferences = {
                    version: 1,
                    view: stored.view,
                    port: stored.port,
                    swap: stored.swap,
                };
            }
        }
    } catch { /* unavailable or invalid preferences use defaults */ }
    touchControllerViewInput.value = touchControllerPreferences.view;
    touchControllerPortInput.value = String(touchControllerPreferences.port);
    touchControllerSwapInput.checked = touchControllerPreferences.swap;
};

const persistTouchControllerPreferences = (): void => {
    try {
        localStorage.setItem(TOUCH_CONTROLLER_STORAGE_KEY, JSON.stringify(touchControllerPreferences));
    } catch { /* preferences remain active for the page */ }
};

const updateTouchControllerPreferences = (): void => {
    touchControllerPreferences = {
        version: 1,
        view: touchControllerViewInput.value as TouchControllerView,
        port: Number(touchControllerPortInput.value) as ControllerPort,
        swap: touchControllerSwapInput.checked,
    };
    persistTouchControllerPreferences();
    syncTouchController();
};

const syncTouchController = (): void => {
    const input = player?.input ?? null;
    touchController.attach(input);
    if (touchController.port !== touchControllerPreferences.port) {
        touchController.port = touchControllerPreferences.port;
    }
    const sessionType = player?.session?.machine.controllers[touchControllerPreferences.port];
    const controllerType = sessionType
        ?? (touchControllerPreferences.port === 1 ? controllerOneInput : controllerTwoInput).value as PsxControllerType;
    if (touchController.controllerType !== controllerType) touchController.controllerType = controllerType;
    const automatic = navigator.maxTouchPoints > 0 && connectedStandardGamepads().length === 0;
    const visible = touchControllerPreferences.view === "show"
        || (touchControllerPreferences.view === "auto" && automatic);
    touchControllerElement.hidden = !visible;
    touchControllerElement.dataset.swapped = String(touchControllerPreferences.swap);
    playStage.dataset.touchVisible = String(visible);
    touchControllerToggle.textContent = visible ? "Hide Controls" : "Show Controls";
    touchControllerToggle.setAttribute("aria-pressed", String(visible));
    const active = visible && player?.status === "running" && controllerType !== "none";
    if (touchController.enabled !== active) touchController.enabled = active;
    const viewLabel = touchControllerPreferences.view === "auto"
        ? `automatic (${visible ? "shown" : "hidden"})`
        : visible ? "shown" : "hidden";
    const stateLabel = controllerType === "none"
        ? "controller disabled for this player"
        : player?.status === "running" ? controllerType : "waiting for a running game";
    touchControllerStatus.textContent = `${viewLabel} · player ${touchControllerPreferences.port} · ${stateLabel}`;
    touchPortLabel.textContent = `On-screen controller · player ${touchControllerPreferences.port}`;
};

const gamepadName = (pad: Gamepad): string => pad.id.trim() || "Connected gamepad";

const CONTROL_DEFINITIONS: ReadonlyArray<{ readonly button: PsxButton; readonly label: string }> = [
    { button: "up", label: "D-pad up" },
    { button: "down", label: "D-pad down" },
    { button: "left", label: "D-pad left" },
    { button: "right", label: "D-pad right" },
    { button: "cross", label: "Cross" },
    { button: "circle", label: "Circle" },
    { button: "square", label: "Square" },
    { button: "triangle", label: "Triangle" },
    { button: "l1", label: "L1" },
    { button: "r1", label: "R1" },
    { button: "l2", label: "L2" },
    { button: "r2", label: "R2" },
    { button: "start", label: "Start" },
    { button: "select", label: "Select" },
    { button: "l3", label: "L3" },
    { button: "r3", label: "R3" },
];

const GAMEPAD_BUTTON_LABELS: Readonly<Record<number, string>> = Object.freeze({
    0: "A", 1: "B", 2: "X", 3: "Y", 4: "LB", 5: "RB", 6: "LT", 7: "RT",
    8: "Select", 9: "Start", 10: "L3", 11: "R3", 12: "D-pad up", 13: "D-pad down",
    14: "D-pad left", 15: "D-pad right",
});

const keyLabel = (code: string | null): string => {
    if (code === null) return "unbound";
    const labels: Readonly<Record<string, string>> = {
        ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
        ControlLeft: "Left Ctrl", ControlRight: "Right Ctrl", ShiftLeft: "Left Shift",
        ShiftRight: "Right Shift", AltLeft: "Left Alt", AltRight: "Right Alt",
        Space: "Space", Enter: "Enter",
    };
    return labels[code] ?? code.replace(/^Key/u, "").replace(/^Digit/u, "").replace(/^Numpad/u, "Numpad ");
};

const gamepadButtonLabel = (index: number | null): string => index === null
    ? "unbound"
    : GAMEPAD_BUTTON_LABELS[index] ?? `Button ${index}`;

const keyboardCodeFor = (port: ControllerPort, button: PsxButton): string | null =>
    Object.entries(keyboardMap).find(([, control]) => control.port === port && control.button === button)?.[0] ?? null;

const sameGamepadAssignment = (
    left: GamepadAssignment | null,
    right: GamepadAssignment | null,
): boolean => left?.index === right?.index && left?.id === right?.id;

const applyGamepadAssignments = (
    next: Readonly<Record<ControllerPort, GamepadAssignment | null>>,
): void => {
    const previous: Readonly<Record<ControllerPort, GamepadAssignment | null>> = {
        1: gamepadAssignments[1],
        2: gamepadAssignments[2],
    };
    for (const port of [1, 2] as const) {
        const assignment = previous[port];
        if (!sameGamepadAssignment(assignment, next[port]) && assignment !== null) {
            runtime?.bindGamepad(assignment.index, null);
        }
    }
    for (const port of [1, 2] as const) gamepadAssignments[port] = next[port];
    for (const port of [1, 2] as const) {
        const assignment = next[port];
        if (!sameGamepadAssignment(previous[port], assignment) && assignment !== null) {
            runtime?.bindGamepad(assignment.index, port);
        }
    }
};

const syncGamepadAssignments = (): void => {
    const pads = connectedStandardGamepads();
    const next: Record<ControllerPort, GamepadAssignment | null> = { 1: null, 2: null };
    const claimedIndices = new Set<number>();
    for (const pad of pads) {
        const preferredPort = gamepadPortPreferences[pad.id];
        if (preferredPort === undefined || next[preferredPort] !== null) continue;
        next[preferredPort] = { index: pad.index, id: pad.id };
        claimedIndices.add(pad.index);
    }
    for (const port of [1, 2] as const) {
        const current = gamepadAssignments[port];
        if (next[port] !== null || current === null || claimedIndices.has(current.index)) continue;
        const pad = pads.find((candidate) => candidate.index === current.index && candidate.id === current.id);
        if (pad === undefined) continue;
        next[port] = current;
        claimedIndices.add(current.index);
    }
    for (const pad of pads) {
        if (claimedIndices.has(pad.index)) continue;
        const port = ([1, 2] as const).find((candidate) => next[candidate] === null);
        if (port === undefined) break;
        next[port] = { index: pad.index, id: pad.id };
        claimedIndices.add(pad.index);
    }
    const changed = ([1, 2] as const).some((port) => !sameGamepadAssignment(gamepadAssignments[port], next[port]));
    if (!changed) return;
    applyGamepadAssignments(next);
    renderBindings();
};

const assignedPad = (port: ControllerPort): Gamepad | null => {
    const assignment = gamepadAssignments[port];
    if (assignment === null) return null;
    const pad = navigator.getGamepads()[assignment.index] ?? null;
    return pad !== null && pad.connected && pad.mapping === "standard" && pad.id === assignment.id ? pad : null;
};

const gamepadButtonFor = (padId: string | null, button: PsxButton): number | null => {
    if (padId === null || !Object.hasOwn(gamepadButtonMaps, padId)
        || gamepadButtonMaps[padId]![button] === undefined) return DEFAULT_GAMEPAD_BUTTON_MAP[button];
    return gamepadButtonMaps[padId]![button] ?? null;
};

const selectControllerTab = (port: ControllerPort): void => {
    for (const candidate of [1, 2] as const) {
        const selected = candidate === port;
        controllerTabs[candidate].setAttribute("aria-selected", String(selected));
        controllerTabs[candidate].tabIndex = selected ? 0 : -1;
        controllerPanels[candidate].hidden = !selected;
    }
};

const renderBindings = (): void => {
    for (const port of [1, 2] as const) {
        const pad = assignedPad(port);
        padLabels[port].textContent = pad === null ? "not connected" : gamepadName(pad);
        leftStickDpadInputs[port].checked = leftStickDpad[port];
        for (const { button } of CONTROL_DEFINITIONS) {
            const view = bindingViews[port].get(button)!;
            view.keyboard.textContent = keyLabel(keyboardCodeFor(port, button));
            view.gamepad.textContent = gamepadButtonLabel(gamepadButtonFor(pad?.id ?? null, button));
            const capturing = bindingCapture?.port === port && bindingCapture.button === button;
            view.change.textContent = capturing ? "Press a key or button…" : "Change…";
            view.change.dataset.capturing = String(capturing);
        }
    }
};

const initializeBindingTables = (): void => {
    for (const port of [1, 2] as const) {
        for (const { button, label } of CONTROL_DEFINITIONS) {
            const row = document.createElement("tr");
            const controlCell = document.createElement("td");
            controlCell.textContent = label;
            const keyboardCell = document.createElement("td");
            keyboardCell.id = `keyboard-${port}-${button}`;
            const gamepadCell = document.createElement("td");
            gamepadCell.id = `gamepad-${port}-${button}`;
            const changeCell = document.createElement("td");
            const change = document.createElement("button");
            change.id = `change-${port}-${button}`;
            change.className = "binding-change";
            change.type = "button";
            change.addEventListener("click", () => beginBindingCapture(port, button));
            changeCell.append(change);
            row.append(controlCell, keyboardCell, gamepadCell, changeCell);
            bindingBodies[port].append(row);
            bindingViews[port].set(button, { keyboard: keyboardCell, gamepad: gamepadCell, change });
        }
    }
};

const finishBindingCapture = (message?: string): void => {
    const capture = bindingCapture;
    if (capture === null) return;
    cancelAnimationFrame(capture.frame);
    bindingCapture = null;
    renderBindings();
    if (message !== undefined) bindingStatuses[capture.port].textContent = message;
};

const assignGamepadToPort = (port: ControllerPort, pad: Gamepad): void => {
    const otherPort: ControllerPort = port === 1 ? 2 : 1;
    const previous = gamepadAssignments[port];
    const other = gamepadAssignments[otherPort];
    const selected = { index: pad.index, id: pad.id };
    const selectedWasOther = other?.index === pad.index && other.id === pad.id;
    const next: Record<ControllerPort, GamepadAssignment | null> = {
        1: gamepadAssignments[1],
        2: gamepadAssignments[2],
    };
    next[port] = selected;
    if (selectedWasOther) next[otherPort] = previous;
    gamepadPortPreferences[pad.id] = port;
    if (selectedWasOther && previous !== null) gamepadPortPreferences[previous.id] = otherPort;
    applyGamepadAssignments(next);
    renderBindings();
};

const moveKeyboardBinding = (port: ControllerPort, button: PsxButton, code: string): void => {
    keyboardMap = Object.freeze(Object.fromEntries(Object.entries(keyboardMap).filter(([candidateCode, control]) =>
        candidateCode !== code && !(control.port === port && control.button === button)).concat([
        [code, Object.freeze({ port, button })],
    ])));
    runtime?.setKeyboardMap(keyboardMap);
    persistControlProfile();
    finishBindingCapture(`${keyLabel(code)} assigned to ${CONTROL_DEFINITIONS.find((control) => control.button === button)!.label}.`);
};

const moveGamepadBinding = (port: ControllerPort, button: PsxButton, pad: Gamepad, index: number): void => {
    const current = Object.hasOwn(gamepadButtonMaps, pad.id) ? gamepadButtonMaps[pad.id]! : {};
    const next: Partial<Record<PsxButton, number | null>> = { ...current };
    for (const { button: candidate } of CONTROL_DEFINITIONS) {
        if (candidate !== button && gamepadButtonFor(pad.id, candidate) === index) next[candidate] = null;
    }
    next[button] = index;
    gamepadButtonMaps[pad.id] = Object.freeze(next);
    runtime?.setGamepadButtonMap(pad.id, gamepadButtonMaps[pad.id]!);
    assignGamepadToPort(port, pad);
    persistControlProfile();
    finishBindingCapture(`${gamepadButtonLabel(index)} on ${gamepadName(pad)} assigned to ${CONTROL_DEFINITIONS.find((control) => control.button === button)!.label}.`);
};

const restoreDefaultBindings = (): void => {
    finishBindingCapture();
    const mappedGamepads = Object.keys(gamepadButtonMaps);
    keyboardMap = DEFAULT_HARNESS_KEYBOARD_MAP;
    runtime?.setKeyboardMap(keyboardMap);
    for (const id of mappedGamepads) {
        delete gamepadButtonMaps[id];
        runtime?.setGamepadButtonMap(id, null);
    }
    for (const id of Object.keys(gamepadPortPreferences)) delete gamepadPortPreferences[id];
    applyGamepadAssignments({ 1: null, 2: null });
    syncGamepadAssignments();
    for (const port of [1, 2] as const) {
        leftStickDpad[port] = false;
        runtime?.setLeftStickDpad(port, false);
    }
    removeStoredControlProfile();
    bindingStatuses[1].textContent = "Default bindings restored.";
    bindingStatuses[2].textContent = "Default bindings restored.";
    renderBindings();
};

const pollBindingCapture = (): void => {
    const capture = bindingCapture;
    if (capture === null) return;
    for (const pad of connectedStandardGamepads()) {
        let baseline = capture.baseline.get(pad.index);
        if (baseline === undefined) {
            baseline = {
                buttons: pad.buttons.map(({ pressed, value }) => pressed || value >= 0.5),
            };
            capture.baseline.set(pad.index, baseline);
        }
        for (let index = 0; index < pad.buttons.length; index++) {
            const pressed = pad.buttons[index]!.pressed || pad.buttons[index]!.value >= 0.5;
            if (baseline.buttons[index] === true) {
                if (!pressed) baseline.buttons[index] = false;
            } else if (pressed) {
                moveGamepadBinding(capture.port, capture.button, pad, index);
                return;
            }
        }
    }
    capture.frame = requestAnimationFrame(pollBindingCapture);
};

const beginBindingCapture = (port: ControllerPort, button: PsxButton): void => {
    finishBindingCapture();
    const baseline = new Map<number, BindingCaptureBaseline>();
    for (const pad of connectedStandardGamepads()) {
        baseline.set(pad.index, {
            buttons: pad.buttons.map(({ pressed, value }) => pressed || value >= 0.5),
        });
    }
    bindingCapture = { port, button, baseline, frame: 0 };
    bindingStatuses[port].textContent = "Press a keyboard key or gamepad button. Escape cancels.";
    renderBindings();
    bindingCapture.frame = requestAnimationFrame(pollBindingCapture);
};

const setScreenMessage = (message: string | null): void => {
    screenMessageRevision++;
    screenMessage.hidden = message === null;
    if (message !== null) screenMessage.textContent = message;
};

const setTimedScreenMessage = (message: string, milliseconds: number): void => {
    setScreenMessage(message);
    const revision = screenMessageRevision;
    setTimeout(() => {
        if (screenMessageRevision === revision) setScreenMessage(null);
    }, milliseconds);
};

const showNotice = (message: string, milliseconds = 3_000): void => {
    noticeRevision++;
    const revision = noticeRevision;
    write(message);
    noticeToast.textContent = message;
    if (noticeToast.matches(":popover-open")) noticeToast.hidePopover();
    noticeToast.showPopover();
    setTimeout(() => {
        if (noticeRevision === revision && noticeToast.matches(":popover-open")) noticeToast.hidePopover();
    }, milliseconds);
};

const setGameFeedback = (message: string, state: "idle" | "working" | "success" | "error"): void => {
    gameFeedback.textContent = message;
    gameFeedback.dataset.state = state;
};

const setGameImportInProgress = (inProgress: boolean): void => {
    gameImportInProgress = inProgress;
    gameControls.disabled = inProgress;
    gameDialogCloseButton.disabled = inProgress;
    gameDialogCloseButton.title = inProgress ? "Wait for Check And Store to finish." : "";
    gameDialog.toggleAttribute("aria-busy", inProgress);
};

const setDiscFeedback = (message: string, state: "idle" | "working" | "success" | "error"): void => {
    discFeedback.textContent = message;
    discFeedback.dataset.state = state;
};

const setMemoryCardFeedback = (message: string, state: "idle" | "working" | "success" | "error"): void => {
    memoryCardFeedback.textContent = message;
    memoryCardFeedback.dataset.state = state;
};

const renderDiscControls = (): void => {
    const session = player?.session;
    const pendingCount = pendingDiscCount;
    const pendingGameId = pendingStoredGameId;
    const pendingGameReady = pendingCount !== null && pendingGameId !== null
        && (session === null || session === undefined || pendingGameId !== session.machine.gameId);
    if (pendingGameReady) {
        restartDiscButton.hidden = true;
        restartDiscButton.disabled = true;
        const selected = Number(discSelect.value);
        discSelect.replaceChildren(...Array.from({ length: pendingCount }, (_, index) =>
            new Option(`Disc ${index + 1}`, String(index))));
        discSelect.value = Number.isSafeInteger(selected) && selected >= 0 && selected < pendingCount
            ? String(selected)
            : "0";
        discSelect.disabled = pendingCount < 2;
        startButton.textContent = session === null || session === undefined ? "Start" : "Switch game";
        startButton.disabled = false;
        setDiscFeedback(
            `Disc ${Number(discSelect.value) + 1} of ${pendingCount} will be used when ${startButton.textContent} is chosen.`,
            "idle",
        );
        gameMenuButton.textContent = session === null || session === undefined ? "Game" : "Game · New game ready";
        gameMenuButton.title = session === null || session === undefined
            ? ""
            : "A checked game is ready to replace the active session.";
        return;
    }
    if (session === null || session === undefined) {
        restartDiscButton.hidden = true;
        restartDiscButton.disabled = true;
        discSelect.replaceChildren(new Option("No checked game", ""));
        discSelect.disabled = true;
        startButton.textContent = "Start";
        startButton.disabled = true;
        setDiscFeedback("Check and store a game to select its starting disc.", "idle");
        gameMenuButton.textContent = "Game";
        gameMenuButton.title = "";
        return;
    }
    const count = session.machine.discCount;
    discSelect.replaceChildren(...Array.from({ length: count }, (_, index) =>
        new Option(`Disc ${index + 1}`, String(index))));
    discSelect.value = String(session.discIndex);
    discSelect.disabled = count < 2;
    startButton.textContent = "Disc active";
    startButton.disabled = true;
    restartDiscButton.hidden = true;
    restartDiscButton.disabled = true;
    const active = `Disc ${session.discIndex + 1} of ${count} active.`;
    setDiscFeedback(active, "success");
    gameMenuButton.textContent = `Game · Disc ${session.discIndex + 1}/${count}`;
    gameMenuButton.title = active;
};

const stopWatchingForVisibleFrame = (): void => {
    visibleFrameUnsubscribe?.();
    visibleFrameUnsubscribe = null;
};

const hasVisiblePixel = (rgba: Uint8ClampedArray): boolean => {
    for (let index = 0; index < rgba.length; index += 4) {
        if (rgba[index] !== 0 || rgba[index + 1] !== 0 || rgba[index + 2] !== 0) return true;
    }
    return false;
};

const watchForVisibleFrame = (): void => {
    stopWatchingForVisibleFrame();
    const session = player?.session;
    if (session === null || session === undefined) return;
    let visibleFrameSeen = false;
    const unsubscribe = session.onFrame((frame) => {
        if (!hasVisiblePixel(frame.rgba)) return;
        visibleFrameSeen = true;
        setScreenMessage(null);
        stopWatchingForVisibleFrame();
    });
    if (visibleFrameSeen) unsubscribe();
    else visibleFrameUnsubscribe = unsubscribe;
};

const report = (error: unknown): void => {
    if (typeof error === "object" && error !== null) {
        if (reportedErrors.has(error)) return;
        reportedErrors.add(error);
    }
    const label = PsxRuntimeError.is(error) ? error.label : "ERROR";
    const message = error instanceof Error ? error.message : String(error);
    write(`${label}: ${message}`);
    if (launchInProgress) {
        setScreenMessage(`Start failed: ${message}`);
        setGameFeedback(`Start failed: ${message}`, "error");
        launchInProgress = false;
        renderDiscControls();
    }
};

const hasOpenDialog = (): boolean => document.querySelector("dialog[open]") !== null;

const releaseModalPause = (): void => {
    if (hasOpenDialog()) return;
    const task = modalPauseTask;
    if (task !== null) {
        void task.then(releaseModalPause, releaseModalPause);
        return;
    }
    const owner = modalPauseOwner;
    modalPauseOwner = null;
    if (owner === null || owner !== player || owner.status !== "paused") return;
    try {
        owner.resume();
    } catch (error) {
        report(error);
    }
};

// HELPER :: htmlDialogElement -> VOID
// Closes an initiating modal and resumes its owned pause before a player mutation can lock the session.
const closeDialogForSessionAction = (dialog: HTMLDialogElement): void => {
    dialog.close();
    releaseModalPause();
};

const pauseForModal = (): void => {
    const owner = player;
    if (owner === null || owner.status !== "running" || modalPauseOwner !== null) return;
    modalPauseOwner = owner;
    const task = owner.pause();
    modalPauseTask = task;
    void task.catch((error) => {
        if (modalPauseOwner === owner) modalPauseOwner = null;
        report(error);
    }).finally(() => {
        if (modalPauseTask === task) modalPauseTask = null;
        releaseModalPause();
    });
};

document.querySelectorAll<HTMLButtonElement>("[data-open-dialog]").forEach((button) => {
    button.addEventListener("click", () => {
        const dialogId = button.dataset.openDialog;
        if (dialogId === undefined) return;
        const dialog = element<HTMLDialogElement>(dialogId);
        if (!dialog.open) {
            dialog.showModal();
            button.setAttribute("aria-expanded", "true");
            pauseForModal();
        }
    });
});

document.querySelectorAll<HTMLButtonElement>("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => {
        const dialog = button.closest("dialog");
        if (dialog === gameDialog && gameImportInProgress) return;
        dialog?.close();
    });
});

document.querySelectorAll<HTMLDialogElement>("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
        if (event.target === dialog && (dialog !== gameDialog || !gameImportInProgress)) dialog.close();
    });
    dialog.addEventListener("cancel", (event) => {
        if (dialog === gameDialog && gameImportInProgress) event.preventDefault();
    });
    dialog.addEventListener("close", () => {
        if (dialog === controllersDialog) finishBindingCapture();
        document.querySelectorAll<HTMLButtonElement>(`[data-open-dialog="${dialog.id}"]`)
            .forEach((button) => button.setAttribute("aria-expanded", "false"));
        releaseModalPause();
    });
});

for (const port of [1, 2] as const) {
    controllerTabs[port].addEventListener("click", () => selectControllerTab(port));
    controllerTabs[port].addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next: ControllerPort = event.key === "ArrowLeft" || event.key === "Home" ? 1 : 2;
        selectControllerTab(next);
        controllerTabs[next].focus();
    });
}

window.addEventListener("keydown", (event) => {
    const capture = bindingCapture;
    if (capture === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === "Escape") finishBindingCapture("Binding change cancelled.");
    else if (event.code.length > 0) moveKeyboardBinding(capture.port, capture.button, event.code);
}, true);
window.addEventListener("gamepadconnected", syncGamepadAssignments);
window.addEventListener("gamepaddisconnected", syncGamepadAssignments);
for (const port of [1, 2] as const) {
    leftStickDpadInputs[port].addEventListener("change", () => {
        const enabled = leftStickDpadInputs[port].checked;
        leftStickDpad[port] = enabled;
        runtime?.setLeftStickDpad(port, enabled);
        persistControlProfile();
        bindingStatuses[port].textContent = enabled
            ? "The left stick now also controls the D-pad for digital-only games."
            : "Left-stick D-pad compatibility is off.";
    });
}
restoreControlsButton.addEventListener("click", restoreDefaultBindings);

const selectedFiles = (): PsxFileListLike => {
    if (selectedGameArchives.length === 0) {
        throw new Error("No game is selected. Choose one or more game ZIPs; firmware is a separate input.");
    }
    return selectedGameArchives;
};

const titleFromFile = (file: { readonly name: string }): string =>
    file.name.replace(/\.zip$/iu, "").trim() || "Local game";

const formatBytes = (bytes: number): string => {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(digits)} ${units[unit]}`;
};

const ambiguousDescriptors = (descriptors: ReadonlyArray<string>): ReadonlyArray<string> => {
    const playlists = descriptors.filter((path) => path.toLowerCase().endsWith(".m3u"));
    if (playlists.length > 1) return playlists;
    if (playlists.length === 1) return [];
    const cues = descriptors.filter((path) => path.toLowerCase().endsWith(".cue"));
    return cues.length > 1 ? cues : [];
};

const renderManifest = (
    manifest: Pick<PsxMultiZipManifest, "name" | "text"> | null,
    source: "generated" | "included" = "generated",
): void => {
    m3uPanel.hidden = manifest === null;
    m3uDescription.textContent = manifest === null
        ? ""
        : source === "generated"
            ? "A new M3U will be generated and stored with this multi-disc game during Check And Store."
            : "This ZIP already contains an M3U; its normalized manifest will be stored with the game.";
    m3uPreview.textContent = manifest?.text ?? "";
};

const archiveActionButton = (
    label: string,
    title: string,
    action: () => void,
    disabled = false,
): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    button.disabled = disabled;
    button.addEventListener("click", action);
    return button;
};

const renderGameArchives = (): void => {
    const multiple = selectedGameArchives.length > 1;
    gameArchiveList.hidden = selectedGameArchives.length === 0;
    clearGameSelectionButton.hidden = selectedGameArchives.length === 0;
    gameArchiveList.replaceChildren(...selectedGameArchives.map((file, index) => {
        const row = document.createElement("li");
        row.className = "archive-row";
        const name = document.createElement("span");
        name.className = "archive-name";
        name.textContent = multiple ? `Disc ${index + 1} · ${file.name}` : `Game ZIP · ${file.name}`;
        name.title = file.name;
        const actions = document.createElement("span");
        actions.className = "archive-actions";
        actions.append(
            archiveActionButton("↑", `Move ${file.name} earlier`, () => {
                const previous = selectedGameArchives[index - 1];
                if (previous === undefined) return;
                selectedGameArchives[index - 1] = file;
                selectedGameArchives[index] = previous;
                void refreshGameSelection();
            }, !multiple || index === 0),
            archiveActionButton("↓", `Move ${file.name} later`, () => {
                const next = selectedGameArchives[index + 1];
                if (next === undefined) return;
                selectedGameArchives[index + 1] = file;
                selectedGameArchives[index] = next;
                void refreshGameSelection();
            }, !multiple || index === selectedGameArchives.length - 1),
            archiveActionButton("Remove", `Remove ${file.name}`, () => {
                selectedGameArchives.splice(index, 1);
                void refreshGameSelection();
            }),
        );
        row.append(name, actions);
        return row;
    }));
};

const inspectGameSelection = async (
    revision: number,
    preferredEntry?: string,
): Promise<void> => {
    try {
        const archives = [...selectedGameArchives];
        if (archives.length === 1) {
            const file = archives[0]!;
            const descriptors = await ZipDiscSource.listDescriptors(file);
            const choices = ambiguousDescriptors(descriptors);
            if (entryInspectionRevision !== revision) return;
            entrySelect.replaceChildren(...choices.map((path) => new Option(path, path)));
            entryChoice.hidden = choices.length === 0;
            if (preferredEntry !== undefined && choices.includes(preferredEntry)) entrySelect.value = preferredEntry;
            const automaticPlaylist = descriptors.filter((path) => path.toLowerCase().endsWith(".m3u"));
            const selectedEntry = choices.length > 0 ? entrySelect.value
                : automaticPlaylist.length === 1 ? automaticPlaylist[0]! : null;
            if (selectedEntry !== null && selectedEntry.toLowerCase().endsWith(".m3u")) {
                const text = await ZipDiscSource.readDescriptor(file, selectedEntry);
                if (entryInspectionRevision !== revision) return;
                renderManifest({ name: selectedEntry.split("/").at(-1)!, text }, "included");
            } else {
                renderManifest(null);
            }
            setGameFeedback(
                choices.length === 0
                    ? "Game ZIP selected. Ready to check and store."
                    : "This ZIP has multiple possible entries. Choose one, then run Check And Store.",
                "idle",
            );
        } else {
            const manifest = await MultiZipDiscSource.inspect(archives);
            if (entryInspectionRevision !== revision) return;
            entryChoice.hidden = true;
            entrySelect.replaceChildren();
            renderManifest(manifest);
            setGameFeedback(
                `${archives.length} single-disc ZIPs are ordered and ready to check and store.`,
                "idle",
            );
        }
        auditButton.disabled = false;
    } catch (error) {
        if (entryInspectionRevision !== revision) return;
        const message = error instanceof Error ? error.message : String(error);
        entryChoice.hidden = true;
        entrySelect.replaceChildren();
        renderManifest(null);
        setGameFeedback(`Game ZIP inspection failed: ${message}`, "error");
        auditButton.disabled = true;
        report(error);
    }
};

const refreshGameSelection = async (preferredEntry?: string): Promise<void> => {
    const revision = ++entryInspectionRevision;
    entryChoice.hidden = true;
    entrySelect.replaceChildren();
    renderManifest(null);
    pendingDiscCount = null;
    pendingStoredGameId = null;
    renderDiscControls();
    renderGameArchives();
    if (selectedGameArchives.length === 0) {
        gameDropZone.dataset.state = "idle";
        gameSelection.textContent = "No game ZIPs selected.";
        setGameFeedback("Choose one or more game ZIPs, then run Check And Store.", "idle");
        auditButton.disabled = true;
        return;
    }
    gameDropZone.dataset.state = "selected";
    gameSelection.textContent = selectedGameArchives.length === 1
        ? `Selected: ${selectedGameArchives[0]!.name}`
        : `${selectedGameArchives.length} ZIPs selected for a ${selectedGameArchives.length}-disc game.`;
    setGameFeedback("Inspecting game ZIP metadata…", "working");
    auditButton.disabled = true;
    await inspectGameSelection(revision, preferredEntry);
};

const addGameFiles = async (
    files: ReadonlyArray<File>,
    replace = false,
    preferredEntry?: string,
): Promise<number> => {
    if (files.length === 0) return 0;
    if (!files.every((file) => /\.zip$/iu.test(file.name))) {
        setGameFeedback("Selection rejected: every selected game file must be a ZIP.", "error");
        return 0;
    }
    const next = replace ? [...files] : [...selectedGameArchives, ...files];
    if (next.length > MultiZipDiscSource.MAX_ARCHIVES) {
        setGameFeedback(`Selection rejected: multi-disc games support at most ${MultiZipDiscSource.MAX_ARCHIVES} ZIPs.`, "error");
        return 0;
    }
    selectedGameArchives = next;
    filesInput.value = "";
    await refreshGameSelection(preferredEntry);
    return files.length;
};

const selectedRegion = (): PsxRegion => biosRegionInput.value as PsxRegion;

const updateFirmwareGate = (): void => {
    const stored = storedFirmware.get(selectedRegion());
    const valid = stored !== undefined && supportedFirmwareByteLengths.length > 0
        && supportedFirmwareByteLengths.includes(stored.blob.size);
    for (const button of [gameMenuButton, libraryMenuButton]) {
        button.disabled = !valid;
        button.title = valid ? "" : "Check and store valid firmware in System first.";
    }
};

const renderFirmwareStatus = (): void => {
    const region = selectedRegion();
    const selected = biosInput.files?.[0];
    const stored = storedFirmware.get(region);
    const hasPreload = preloadBios !== null && preloadRegion === region;
    const sizesKnown = supportedFirmwareByteLengths.length > 0;
    const supports = (blob: Blob): boolean => sizesKnown
        && supportedFirmwareByteLengths.includes(blob.size);
    const selectedArchive = selected !== undefined && ZipFirmwareSource.isArchive(selected);
    const selectedValid = selected !== undefined && (selectedArchive || !sizesKnown || supports(selected));
    const storedValid = stored !== undefined && supports(stored.blob);
    const preloadValid = hasPreload && (!sizesKnown || supports(preloadBios!));
    firmwareStatus.textContent = selected !== undefined
        ? selectedArchive
            ? "selected firmware ZIP ready to inspect (not stored)"
            : selectedValid
                ? "user-selected image ready (not stored)"
                : "selected image has an unsupported byte length"
        : stored !== undefined
            ? !sizesKnown
                ? "stored in this browser; core validation pending"
                : storedValid
                ? "stored in this browser and ready"
                : "stored image has an unsupported byte length; forget and replace it"
            : hasPreload
                ? preloadValid
                    ? "private testing preload ready (not stored)"
                    : "private testing preload has an unsupported byte length"
                : "select a user-supplied image";
    firmwareStoreButton.disabled = selected === undefined
        ? stored !== undefined || !preloadValid
        : !selectedValid;
    deleteFirmwareButton.hidden = stored === undefined;
    deleteFirmwareButton.disabled = stored === undefined;
    updateFirmwareGate();
};

const resolveFirmwareFile = async (file: File): Promise<{ readonly name: string; readonly blob: Blob }> => {
    if (supportedFirmwareByteLengths.length === 0) {
        throw new Error("The core build has not reported its supported firmware sizes.");
    }
    if (ZipFirmwareSource.isArchive(file)) {
        return ZipFirmwareSource.extract(file, supportedFirmwareByteLengths, selectedRegion());
    }
    if (!supportedFirmwareByteLengths.includes(file.size)) {
        throw new Error(`The selected firmware image is ${file.size.toLocaleString()} bytes; expected ${supportedFirmwareByteLengths.map((size) => size.toLocaleString()).join(" or ")} bytes.`);
    }
    return { name: file.name, blob: file };
};

const selectedBios = async (): Promise<BiosImage> => {
    const region = selectedRegion();
    const selected = biosInput.files?.[0];
    if (selected !== undefined) return { ...await resolveFirmwareFile(selected), region };
    const stored = storedFirmware.get(region);
    if (stored !== undefined) {
        if (!supportedFirmwareByteLengths.includes(stored.blob.size)) {
            throw new Error("The stored firmware has an unsupported byte length. Forget it, then store a valid raw image or ZIP.");
        }
        return stored;
    }
    if (preloadBios !== null && preloadRegion === region) {
        if (!supportedFirmwareByteLengths.includes(preloadBios.size)) {
            throw new Error("The private testing preload has an unsupported byte length.");
        }
        return { name: preloadBios.name, region, blob: preloadBios };
    }
    throw new Error("Select firmware for the chosen region first.");
};

biosInput.addEventListener("change", renderFirmwareStatus);
biosRegionInput.addEventListener("change", renderFirmwareStatus);
buildUrlInput.addEventListener("input", () => {
    supportedFirmwareByteLengths = buildUrlInput.value.trim() === activeBuildUrl
        ? activeFirmwareByteLengths
        : [];
    renderFirmwareStatus();
});

firmwareStoreButton.addEventListener("click", () => run(async () => {
    firmwareStoreButton.disabled = true;
    firmwareStatus.textContent = "checking firmware…";
    try {
        await ensureRuntime();
        const stored = await storage.saveFirmware(await selectedBios());
        storedFirmware.set(stored.region, stored);
        biosInput.value = "";
        renderFirmwareStatus();
        write("Firmware check passed and firmware was stored in this browser.");
    } catch (error) {
        renderFirmwareStatus();
        const message = error instanceof Error ? error.message : String(error);
        firmwareStatus.textContent = `check or storage failed: ${message}`;
        throw error;
    }
}));

deleteFirmwareButton.addEventListener("click", () => run(async () => {
    const region = selectedRegion();
    deleteFirmwareButton.disabled = true;
    await storage.deleteFirmware(region);
    storedFirmware.delete(region);
    renderFirmwareStatus();
    write("Stored firmware removed from this browser.");
}));

filesInput.addEventListener("change", () => {
    const files = filesInput.files === null ? [] : [...filesInput.files];
    run(async () => {
        const added = await addGameFiles(files);
        if (added > 0) write(`Added ${added} game ZIP${added === 1 ? "" : "s"}.`);
    });
});
clearGameSelectionButton.addEventListener("click", () => run(async () => {
    selectedGameArchives = [];
    await refreshGameSelection();
    write("Game ZIP selection cleared.");
}));
entrySelect.addEventListener("change", () => run(() => refreshGameSelection(entrySelect.value)));

const ensureRuntime = async (): Promise<PsxConsole> => {
    const buildUrl = buildUrlInput.value.trim();
    if (runtime !== null && activeBuildUrl === buildUrl) {
        supportedFirmwareByteLengths = activeFirmwareByteLengths;
        renderFirmwareStatus();
        return runtime;
    }
    if (runtime !== null) {
        stopWatchingForVisibleFrame();
        touchController.detach();
        await runtime.destroy();
    }
    const adapter = await LibretroPsxAdapter.init({ buildUrl });
    activeFirmwareByteLengths = adapter.build.firmware.byteLengths;
    supportedFirmwareByteLengths = activeFirmwareByteLengths;
    renderFirmwareStatus();
    runtime = PsxConsole.init({
        adapter,
        canvas,
        container,
        fullscreenTarget: playStage,
        gestureSource: document,
        storage,
        profileId: HARNESS_PROFILE_ID,
        memoryCardIds: { 1: "card-1", 2: "card-2" },
        keyboard: { target: window, map: keyboardMap },
        gamepad: {
            provider: { getGamepads: () => navigator.getGamepads() },
            scheduler: {
                request: requestAnimationFrame.bind(globalThis),
                cancel: cancelAnimationFrame.bind(globalThis),
            },
            target: document,
            leftStickDpad,
            buttonMaps: gamepadButtonMaps,
        },
        gameStore,
    });
    syncGamepadAssignments();
    for (const port of [1, 2] as const) {
        const assignment = gamepadAssignments[port];
        if (assignment !== null) runtime.bindGamepad(assignment.index, port);
    }
    player = runtime.player as PsxPlayer;
    player.on("status", (status) => {
        statusElement.textContent = status;
        statusStrip.dataset.state = status;
        pauseOverlay.hidden = status !== "paused";
        syncTouchController();
    });
    player.on("error", report);
    activeBuildUrl = buildUrl;
    return runtime;
};

const localConfig = () => {
    const files = selectedFiles();
    const first = typeof files.item === "function" ? files.item(0) : files[0];
    return {
        gameId: titleFromFile(first!),
        ...(files.length !== 1 || entryChoice.hidden || entrySelect.value.length === 0
            ? {}
            : { entry: entrySelect.value }),
    };
};

const run = (action: () => Promise<unknown> | unknown): Promise<void> =>
    Promise.resolve().then(async () => {
        const pauseTask = modalPauseTask;
        if (pauseTask !== null) await pauseTask;
        await action();
    }).catch(report);

const setStateFeedback = (message: string, state: "idle" | "working" | "success" | "error"): void => {
    stateFeedback.textContent = message;
    stateFeedback.dataset.state = state;
};

const requireStatePlayer = (): PsxPlayer => {
    const current = player;
    if (current === null || current.session === null) throw new Error("Start a game before managing save states.");
    return current;
};

const runStateAction = (action: () => Promise<void>): void => {
    void run(async () => {
        try {
            await action();
        } catch (error) {
            setStateFeedback(`Save-state operation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
            throw error;
        }
    });
};

const stateIsCompatible = (record: PsxStateRecord): boolean => {
    const machine = player?.session?.machine;
    return machine !== undefined && record.metadata.gameId === machine.gameId
        && record.metadata.buildId === machine.buildId && record.metadata.core === machine.core
        && record.metadata.coreVersion === machine.coreVersion;
};

const stateActionButton = (
    label: string,
    action: () => void,
    disabled = false,
): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener("click", action);
    return button;
};

const openStateConfirmation = (kind: "overwrite" | "delete", name: string): void => {
    pendingStateAction = { kind, name };
    const overwrite = kind === "overwrite";
    stateConfirmTitle.textContent = overwrite ? "Overwrite save state?" : "Delete save state?";
    stateConfirmMessage.textContent = overwrite
        ? `Replace “${name}” with the game’s current state? The previous state cannot be recovered.`
        : `Delete “${name}” from this browser? This cannot be undone.`;
    confirmStateActionButton.textContent = overwrite ? "Overwrite state" : "Delete state";
    if (!stateConfirmDialog.open) stateConfirmDialog.showModal();
};

const renderStateManager = (): void => {
    const session = player?.session;
    if (session === null || session === undefined) {
        stateGame.textContent = "Start a game to manage its save states.";
        saveNewStateButton.disabled = true;
        newStateNameInput.disabled = true;
        const cell = document.createElement("td");
        cell.colSpan = 6;
        cell.className = "state-empty";
        cell.textContent = "Start a game to view its states.";
        const row = document.createElement("tr");
        row.append(cell);
        stateList.replaceChildren(row);
        return;
    }
    const title = storedGameTitles.get(session.machine.gameId) ?? "Active game";
    stateGame.textContent = `${title} · ${stateRecords.length} saved state${stateRecords.length === 1 ? "" : "s"}`;
    saveNewStateButton.disabled = false;
    newStateNameInput.disabled = false;
    if (stateRecords.length === 0) {
        const cell = document.createElement("td");
        cell.colSpan = 6;
        cell.className = "state-empty";
        cell.textContent = "No save states for this game.";
        const row = document.createElement("tr");
        row.append(cell);
        stateList.replaceChildren(row);
        return;
    }
    stateList.replaceChildren(...stateRecords.map((record) => {
        const compatible = stateIsCompatible(record);
        const row = document.createElement("tr");
        const name = document.createElement("td");
        name.textContent = record.name;
        const saved = document.createElement("td");
        saved.textContent = new Date(record.metadata.createdAt).toLocaleString();
        const disc = document.createElement("td");
        disc.textContent = String(record.metadata.discIndex + 1);
        const compatibility = document.createElement("td");
        compatibility.textContent = compatible ? "Ready" : "Different core build";
        const quickSlots = document.createElement("td");
        quickSlots.className = "quick-state-slots";
        for (const slot of [1, 2] as const) {
            const label = document.createElement("label");
            const radio = document.createElement("input");
            radio.type = "radio";
            radio.name = `quick-state-${slot}`;
            radio.value = record.name;
            radio.checked = quickStateNameFor(session.machine.gameId, slot) === record.name;
            radio.disabled = !compatible;
            radio.setAttribute("aria-label", `Use “${record.name}” as Quick State ${slot}`);
            radio.addEventListener("change", () => {
                if (!radio.checked) return;
                const otherSlot: QuickStateSlot = slot === 1 ? 2 : 1;
                const previousTarget = quickStateNameFor(session.machine.gameId, slot);
                const swapsSlots = previousTarget !== null && previousTarget !== record.name
                    && quickStateNameFor(session.machine.gameId, otherSlot) === record.name;
                const persisted = assignQuickState(session.machine.gameId, slot, record.name);
                renderStateManager();
                const assignment = swapsSlots
                    ? `“${record.name}” assigned to Quick State ${slot}; “${previousTarget}” moved to Quick State ${otherSlot}`
                    : `“${record.name}” assigned to Quick State ${slot}`;
                const message = assignment
                    + (persisted ? "." : " for this page; browser storage is unavailable.");
                setStateFeedback(message, persisted ? "success" : "error");
                showNotice(message);
            });
            label.append(radio, ` Q${slot}`);
            quickSlots.append(label);
        }
        const actions = document.createElement("td");
        const controls = document.createElement("div");
        controls.className = "state-actions";
        controls.append(
            stateActionButton("Load", () => runStateAction(async () => {
                setStateFeedback(`Loading “${record.name}”…`, "working");
                await requireStatePlayer().loadState(record.name);
                renderDiscControls();
                setStateFeedback(`Loaded “${record.name}”.`, "success");
                statesDialog.close();
                showNotice(`Loaded save state “${record.name}”.`);
            }), !compatible),
            stateActionButton("Overwrite", () => openStateConfirmation("overwrite", record.name)),
            stateActionButton("Delete", () => openStateConfirmation("delete", record.name)),
        );
        actions.append(controls);
        row.append(name, saved, disc, compatibility, quickSlots, actions);
        return row;
    }));
};

const refreshStates = async (): Promise<void> => {
    const session = player?.session;
    stateRecords = session === null || session === undefined
        ? []
        : await storage.listStates(HARNESS_PROFILE_ID, session.machine.gameId);
    renderStateManager();
};

interface HarnessDisplay {
    readonly isFullscreen: boolean;
    scaling: PsxScalingMode;
    fullscreen(): Promise<void>;
    exitFullscreen(): Promise<void>;
}

interface HarnessInputControl {
    readonly port: number;
    readonly button: string;
}

const sessionDisplay = (): HarnessDisplay | null => {
    const display = player?.display;
    return display !== undefined && typeof display.isFullscreen === "boolean"
        && display.scaling !== undefined && typeof display.fullscreen === "function"
        && typeof display.exitFullscreen === "function"
        ? display as HarnessDisplay
        : null;
};

const enterFullscreen = async (scaling: "fit" | "stretch"): Promise<void> => {
    const display = sessionDisplay();
    if (display === null || player?.session === null || player?.session === undefined) {
        throw new Error("Start a game before entering fullscreen.");
    }
    display.scaling = scaling;
    await display.fullscreen();
    viewDialog.close();
    write(`Fullscreen ${scaling} view enabled.`);
};

const hasRuntimeButton = (
    snapshot: ReadonlyArray<HarnessInputControl>,
    port: ControllerPort,
    button: PsxButton,
): boolean => snapshot.some((control) => control.port === port && control.button === button);

const cycleFastForwardRate = (): void => {
    const index = FAST_FORWARD_RATES.indexOf(selectedFastForwardRate as typeof FAST_FORWARD_RATES[number]);
    selectedFastForwardRate = FAST_FORWARD_RATES[(index + 1) % FAST_FORWARD_RATES.length]!;
    fastForwardSelection.textContent = `×${selectedFastForwardRate}`;
    showNotice(`Fast-forward speed selected: ×${selectedFastForwardRate}.`);
};

const runQuickStateShortcut = (action: "save" | "load", slot: 1 | 2): void => {
    if (quickStateOperationInProgress) {
        showNotice("Another quick-state operation is still in progress.");
        return;
    }
    const shortcutName = slot === 1 ? QUICK_STATE_NAMES[0] : QUICK_STATE_NAMES[1];
    quickStateOperationInProgress = true;
    void run(async () => {
        const current = requireStatePlayer();
        const gameId = current.session!.machine.gameId;
        await refreshStates();
        const assignedName = quickStateNameFor(gameId, slot);
        const name = assignedName ?? shortcutName;
        try {
            if (action === "save") {
                await current.saveState(name);
                assignQuickState(gameId, slot, name);
            } else {
                if (assignedName === null) {
                    throw new Error(`${shortcutName} has no saved state. Assign one in the States menu or use its controller save shortcut first.`);
                }
                const record = stateRecords.find((candidate) => candidate.name === name);
                if (record === undefined) {
                    throw new Error(`${shortcutName} has no saved state. Assign one in the States menu or use its controller save shortcut first.`);
                }
                if (!stateIsCompatible(record)) {
                    throw new Error(`The state assigned to ${shortcutName} belongs to a different core build.`);
                }
                await current.loadState(name);
            }
            await refreshStates();
            renderDiscControls();
            const message = action === "save"
                ? `Saved ${shortcutName} to “${name}”.`
                : `Loaded ${shortcutName} from “${name}”.`;
            setStateFeedback(message, "success");
            showNotice(message);
        } catch (error) {
            const message = `${action === "save" ? "Save" : "Load"} ${shortcutName} failed: `
                + (error instanceof Error ? error.message : String(error));
            setStateFeedback(message, "error");
            showNotice(message, 5_000);
            throw error;
        }
    }).finally(() => {
        quickStateOperationInProgress = false;
    });
};

const updateRuntimeShortcuts = (snapshot: ReadonlyArray<HarnessInputControl>): void => {
    const current = player;
    if (current?.session === null || current?.session === undefined
        || (current.status !== "running" && current.status !== "paused")) {
        heldRuntimeShortcuts.clear();
        speedIndicator.hidden = true;
        return;
    }
    const activeShortcuts = new Set<string>();
    const onPress = (key: string, action: () => void): void => {
        activeShortcuts.add(key);
        if (!heldRuntimeShortcuts.has(key)) action();
    };
    for (const port of [1, 2] as const) {
        const l3 = hasRuntimeButton(snapshot, port, "l3");
        const r3 = hasRuntimeButton(snapshot, port, "r3");
        const l1 = hasRuntimeButton(snapshot, port, "l1");
        const l2 = hasRuntimeButton(snapshot, port, "l2");
        const r1 = hasRuntimeButton(snapshot, port, "r1");
        const r2 = hasRuntimeButton(snapshot, port, "r2");
        if (l3 && r2) onPress(`${port}:cycle-fast-forward`, cycleFastForwardRate);
        if (r3 && l1) onPress(`${port}:save-quick-state-1`, () => runQuickStateShortcut("save", 1));
        if (r3 && l2) onPress(`${port}:save-quick-state-2`, () => runQuickStateShortcut("save", 2));
        if (r3 && r1) onPress(`${port}:load-quick-state-1`, () => runQuickStateShortcut("load", 1));
        if (r3 && r2) onPress(`${port}:load-quick-state-2`, () => runQuickStateShortcut("load", 2));
    }
    heldRuntimeShortcuts.clear();
    activeShortcuts.forEach((shortcut) => heldRuntimeShortcuts.add(shortcut));

    const requestedRates: PsxPlaybackRate[] = [1];
    for (const port of [1, 2] as const) {
        if (!hasRuntimeButton(snapshot, port, "l3")) continue;
        if (hasRuntimeButton(snapshot, port, "l1")) requestedRates.push(2);
        if (hasRuntimeButton(snapshot, port, "l2")) requestedRates.push(7);
        if (hasRuntimeButton(snapshot, port, "r1")) requestedRates.push(selectedFastForwardRate);
    }
    const requestedRate = Math.max(...requestedRates) as PsxPlaybackRate;
    if (current.playbackRate !== requestedRate) current.setPlaybackRate(requestedRate);
    speedIndicator.textContent = `×${requestedRate}`;
    speedIndicator.hidden = requestedRate === 1;
};

const updateDiagnostics = (): void => {
    syncTouchController();
    const input = player?.input as ({
        readonly snapshot?: ReadonlyArray<HarnessInputControl>;
        readonly axes?: ReadonlyArray<{
            readonly control: { readonly port: number; readonly axis: string };
            readonly value: number;
        }>;
    } | null);
    const snapshot = input?.snapshot ?? [];
    updateRuntimeShortcuts(snapshot);
    const buttons = snapshot.map(({ port, button }) => `${port}:${button}`);
    const axes = input?.axes?.filter(({ value }) => Math.abs(value) > 0.01)
        .map(({ control, value }) => `${control.port}:${control.axis}=${value.toFixed(2)}`) ?? [];
    inputStatus.textContent = [...buttons, ...axes].join(", ") || "none";
    const display = sessionDisplay();
    const exitChord = ([1, 2] as const).some((port) =>
        snapshot.some((control) => control.port === port && control.button === "l3")
        && snapshot.some((control) => control.port === port && control.button === "r3"));
    if (exitChord && !fullscreenExitChordHeld && display?.isFullscreen === true) {
        fullscreenExitChordHeld = true;
        void display.exitFullscreen().catch(report);
    } else if (!exitChord) {
        fullscreenExitChordHeld = false;
    }
    viewStatus.textContent = `${display?.isFullscreen === true ? "fullscreen" : "windowed"} · ${display?.scaling ?? "fit"}`;
    const audio = player?.audio as ({
        readonly isUnlocked?: boolean;
        readonly isMuted?: boolean;
        readonly queuedMs?: number;
        readonly droppedSamples?: number;
        readonly deviceSampleRate?: number | null;
    } | null);
    const availability = audio === null || audio === undefined
        ? "unavailable until a game starts"
        : audio.isUnlocked
            ? `enabled, ${audio.isMuted ? "muted" : "audible"}`
            : `waiting for browser permission; output ${audio.isMuted ? "muted" : "will be audible"}`;
    sessionAudioStatus.textContent = availability;
    muteAudioButton.disabled = audio === null || audio === undefined;
    muteAudioButton.textContent = audio?.isMuted === true ? "Unmute" : "Mute";
    audioStatus.textContent = audio === null || audio === undefined
        ? availability
        : `${availability}, queue=${(audio.queuedMs ?? 0).toFixed(1)}ms, `
            + `dropped=${audio.droppedSamples ?? 0}, device=${audio.deviceSampleRate ?? "pending"}Hz`;
    const sessionActive = player?.session !== null && player?.session !== undefined;
    const sessionStatus = player?.status;
    pauseButton.disabled = sessionStatus !== "running" && sessionStatus !== "paused";
    pauseButton.textContent = sessionStatus === "paused" ? "Resume" : "Pause";
    resetButton.disabled = !sessionActive;
    statesMenuButton.disabled = !sessionActive;
    fullscreenButtons.fit.disabled = !sessionActive || display === null;
    fullscreenButtons.stretch.disabled = !sessionActive || display === null;
    controllerOneInput.disabled = sessionActive;
    controllerTwoInput.disabled = sessionActive;
    controllerTypeStatus.textContent = sessionActive
        ? "Controller types are fixed for the active session; stop the game to change them."
        : "Emulated controller types apply when the next game starts.";
    downloadCardButtons.forEach((button) => { button.disabled = false; });
    replaceCardButtons.forEach((button) => { button.disabled = sessionActive; });
    replacementCardInput.disabled = sessionActive;
    memoryCardStatus.textContent = sessionActive
        ? "Download the current cards now; stop the game before replacing either card."
        : "Download stored cards or select a replacement while no game is running.";
    requestAnimationFrame(updateDiagnostics);
};

const startConfig = (bios: BiosImage, initialDiscIndex = 0) => ({
    bios,
    initialDiscIndex,
    controllers: {
        1: controllerOneInput.value as PsxControllerType,
        2: controllerTwoInput.value as PsxControllerType,
    },
});

interface HarnessAudio {
    readonly isMuted: boolean;
    volume: number;
    mute(): void;
    unmute(): void;
    unlock(): Promise<void>;
}

const sessionAudio = (): HarnessAudio | null => player?.audio as HarnessAudio | null;

const prepareSessionAudio = async (): Promise<void> => {
    const audio = sessionAudio();
    if (audio === null) return;
    audio.volume = Number(element<HTMLInputElement>("audio-volume").value);
    try {
        await audio.unlock();
    } catch {
        write("Audio will enable on the next click or key press.");
    }
};

const requireSessionAudio = (): HarnessAudio => {
    const audio = sessionAudio();
    if (audio === null) throw new Error("Start a game before enabling audio.");
    return audio;
};

auditButton.addEventListener("click", () => {
    setGameImportInProgress(true);
    void run(async () => {
        auditButton.disabled = true;
        pendingStoredGameId = null;
        setGameFeedback("Checking and storing game content…", "working");
        try {
            const console = await ensureRuntime();
            const imported = await console.importFiles(selectedFiles(), localConfig());
            await refreshGames();
            const stored = storedGames.get(imported.gameId);
            if (stored === undefined) throw new Error("The stored game summary could not be reloaded.");
            pendingDiscCount = stored.discCount;
            pendingStoredGameId = imported.gameId;
            storedGameInput.value = imported.gameId;
            renderStoredGameSelection();
            renderDiscControls();
            const message = `Game check passed: ${stored.discCount} disc${stored.discCount === 1 ? "" : "s"}; stored in this browser.`;
            setGameFeedback(message, "success");
            write(message);
        } catch (error) {
            pendingDiscCount = null;
            pendingStoredGameId = null;
            renderDiscControls();
            const message = error instanceof Error ? error.message : String(error);
            setGameFeedback(`Game check or storage failed: ${message}`, "error");
            report(error);
        } finally {
            auditButton.disabled = false;
        }
    }).finally(() => setGameImportInProgress(false));
});

startButton.addEventListener("click", () => run(async () => {
    const activeSession = player?.session;
    const gameId = pendingStoredGameId;
    const startsPendingGame = gameId !== null && pendingDiscCount !== null
        && (activeSession === null || activeSession === undefined || gameId !== activeSession.machine.gameId);
    if (startsPendingGame) {
        const switching = activeSession !== null && activeSession !== undefined;
        launchInProgress = true;
        stopWatchingForVisibleFrame();
        startButton.disabled = true;
        startButton.textContent = switching ? "Switching…" : "Starting…";
        setGameFeedback(switching ? "Switching sessions…" : "Starting session…", "working");
        setScreenMessage(switching ? "Switching PlayStation games…" : "Starting PlayStation…");
        write(switching
            ? "Switching sessions; the first image may take a few seconds."
            : "Starting session; the first image may take a few seconds.");
        closeDialogForSessionAction(gameDialog);
        const console = await ensureRuntime();
        const bios = await selectedBios();
        await console.startStored(gameId, startConfig(bios, Number(discSelect.value)));
        await prepareSessionAudio();
        pendingDiscCount = player?.session?.machine.discCount ?? pendingDiscCount;
        renderDiscControls();
        setScreenMessage("Session is running; waiting for video…");
        watchForVisibleFrame();
        launchInProgress = false;
        setGameFeedback(
            switching ? "The active game was replaced." : "Session started. The game is stored in this browser.",
            "success",
        );
        write(switching ? "The active session was replaced." : "Session started; game stored in browser library.");
        return;
    }
    if (activeSession !== null && activeSession !== undefined) {
        const index = Number(discSelect.value);
        startButton.disabled = true;
        startButton.textContent = "Changing disc…";
        setDiscFeedback(`Changing to Disc ${index + 1}…`, "working");
        closeDialogForSessionAction(gameDialog);
        setScreenMessage(`Changing to Disc ${index + 1}…`);
        try {
            await player?.setDisc(index);
            renderDiscControls();
            setTimedScreenMessage(`Disc ${index + 1} is active. Waiting for the game to respond…`, 2_500);
            write(`Disc ${index + 1} of ${activeSession.machine.discCount} is now active; content may take a moment to respond.`);
        } catch (error) {
            startButton.disabled = false;
            startButton.textContent = "Change disc";
            setDiscFeedback(`Disc change failed: ${error instanceof Error ? error.message : String(error)}`, "error");
            setScreenMessage(`Disc change failed: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
        return;
    }
    throw new Error("Check and store the selected game before starting it.");
}));

restartDiscButton.addEventListener("click", () => run(async () => {
    const activeSession = player?.session;
    if (activeSession === null || activeSession === undefined) throw new Error("Start a game before restarting from a disc.");
    const index = Number(discSelect.value);
    const gameId = activeSession.machine.gameId;
    const discCount = activeSession.machine.discCount;
    if (!Number.isSafeInteger(index) || index < 0 || index >= discCount) throw new Error("Select a valid disc first.");
    launchInProgress = true;
    stopWatchingForVisibleFrame();
    restartDiscButton.disabled = true;
    restartDiscButton.textContent = "Restarting…";
    setDiscFeedback(`Restarting from Disc ${index + 1}…`, "working");
    setScreenMessage(`Restarting PlayStation from Disc ${index + 1}…`);
    closeDialogForSessionAction(gameDialog);
    const console = await ensureRuntime();
    const bios = await selectedBios();
    await console.startStored(gameId, startConfig(bios, index));
    await prepareSessionAudio();
    pendingStoredGameId = gameId;
    pendingDiscCount = discCount;
    renderDiscControls();
    setScreenMessage("Session is running; waiting for video…");
    watchForVisibleFrame();
    launchInProgress = false;
    setGameFeedback(`Session restarted directly from Disc ${index + 1}.`, "success");
    showNotice(`Restarted from Disc ${index + 1}.`);
}));

const selectedStoredGame = (): string => {
    const gameId = storedGameInput.value;
    if (gameId.length === 0) throw new Error("Select a stored game first.");
    return gameId;
};

const storedM3uFilename = (title: string): string => {
    const safe = title.replace(/[\\/:*?"<>|]/gu, "_").trim();
    return `${safe.length === 0 ? "game" : safe}.m3u`;
};

const refreshStoredM3u = async (gameId: string): Promise<void> => {
    const revision = ++storedM3uRevision;
    storedM3u = null;
    downloadStoredM3uButton.hidden = true;
    downloadStoredM3uButton.disabled = true;
    if (gameId.length === 0) return;
    const game = await gameStore.get(gameId);
    if (storedM3uRevision !== revision || game === null || !game.entry.toLowerCase().endsWith(".m3u")) return;
    const manifest = game.files.find(({ path }) => path === game.entry);
    const summary = storedGames.get(gameId);
    if (manifest === undefined || summary === undefined) return;
    storedM3u = { name: storedM3uFilename(summary.displayTitle), blob: manifest.blob };
    downloadStoredM3uButton.hidden = false;
    downloadStoredM3uButton.disabled = false;
};

const renderStoredGameSelection = (): void => {
    const gameId = storedGameInput.value;
    const game = storedGames.get(gameId);
    const hasSelection = game !== undefined;
    const selectedDisc = storedDiscSelect.dataset.gameId === gameId
        ? Number(storedDiscSelect.value)
        : 0;
    startStoredButton.disabled = !hasSelection;
    renameStoredButton.disabled = !hasSelection;
    deleteStoredButton.disabled = !hasSelection;
    storedTitleInput.disabled = !hasSelection;
    if (game !== undefined) {
        storedTitleInput.value = game.displayTitle;
        storedGameDetails.textContent = `${formatBytes(game.totalBytes)} · ${game.fileCount} file${game.fileCount === 1 ? "" : "s"} · ${game.discCount} disc${game.discCount === 1 ? "" : "s"}${game.discCount > 1 ? " · M3U stored" : ""} · imported ${new Date(game.importedAt).toLocaleString()}`;
        storedDiscSelect.replaceChildren(...Array.from({ length: game.discCount }, (_, index) =>
            new Option(`Disc ${index + 1}`, String(index))));
        storedDiscSelect.value = Number.isSafeInteger(selectedDisc)
            && selectedDisc >= 0 && selectedDisc < game.discCount ? String(selectedDisc) : "0";
        storedDiscSelect.dataset.gameId = gameId;
        storedDiscSelect.disabled = game.discCount < 2;
        storedDiscFeedback.textContent = game.discCount < 2
            ? "This stored game has one disc."
            : `Disc ${Number(storedDiscSelect.value) + 1} of ${game.discCount} will be used when Start stored is chosen.`;
    } else {
        storedTitleInput.value = "";
        storedGameDetails.textContent = "Select a stored game to view its storage details.";
        storedDiscSelect.replaceChildren(new Option("No stored game", ""));
        storedDiscSelect.dataset.gameId = "";
        storedDiscSelect.disabled = true;
        storedDiscFeedback.textContent = "Select a stored game to choose its starting disc.";
    }
    void refreshStoredM3u(gameId).catch(report);
};

const refreshGames = async (): Promise<void> => {
    const previous = storedGameInput.value;
    const games = await gameStore.list();
    storedGameTitles.clear();
    storedGames.clear();
    games.forEach((game) => {
        storedGameTitles.set(game.gameId, game.displayTitle);
        storedGames.set(game.gameId, game);
    });
    const totalBytes = games.reduce((total, game) => total + game.totalBytes, 0);
    librarySummary.textContent = games.length === 0
        ? "No games stored."
        : `${games.length} game${games.length === 1 ? "" : "s"} · ${formatBytes(totalBytes)} of game content stored`;
    storedGameInput.replaceChildren(...games.map((game) => {
        const option = document.createElement("option");
        option.value = game.gameId;
        option.textContent = `${game.displayTitle} · ${formatBytes(game.totalBytes)} · ${game.discCount} disc${game.discCount === 1 ? "" : "s"}`;
        return option;
    }));
    if (games.some(({ gameId }) => gameId === previous)) storedGameInput.value = previous;
    renderStoredGameSelection();
};

libraryMenuButton.addEventListener("click", () => run(refreshGames));
statesMenuButton.addEventListener("click", () => run(refreshStates));
storedGameInput.addEventListener("change", renderStoredGameSelection);
storedDiscSelect.addEventListener("change", renderStoredGameSelection);
downloadStoredM3uButton.addEventListener("click", () => run(() => {
    const manifest = storedM3u;
    if (manifest === null) throw new Error("The selected stored game does not include an M3U.");
    const url = URL.createObjectURL(manifest.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = manifest.name;
    link.click();
    URL.revokeObjectURL(url);
    showNotice(`Downloaded stored M3U “${manifest.name}”.`);
}));
startStoredButton.addEventListener("click", () => run(async () => {
    const gameId = selectedStoredGame();
    const initialDiscIndex = Number(storedDiscSelect.value);
    const switching = player?.session !== null && player?.session !== undefined;
    launchInProgress = true;
    stopWatchingForVisibleFrame();
    setScreenMessage(switching ? "Switching PlayStation games…" : "Starting stored PlayStation game…");
    closeDialogForSessionAction(libraryDialog);
    const console = await ensureRuntime();
    const bios = await selectedBios();
    await console.startStored(gameId, startConfig(bios, initialDiscIndex));
    await prepareSessionAudio();
    pendingStoredGameId = gameId;
    pendingDiscCount = player?.session?.machine.discCount ?? null;
    renderDiscControls();
    setScreenMessage("Session is running; waiting for video…");
    watchForVisibleFrame();
    launchInProgress = false;
    write(switching ? "Stored session replaced the previous game." : "Stored session started.");
}));
renameStoredButton.addEventListener("click", () => run(async () => {
    await gameStore.renameDisplayTitle(
        selectedStoredGame(),
        storedTitleInput.value,
    );
    await refreshGames();
}));
deleteStoredButton.addEventListener("click", () => run(() => {
    pendingDeleteGameId = selectedStoredGame();
    deleteGameName.textContent = storedGameTitles.get(pendingDeleteGameId) ?? "this game";
    if (!deleteGameDialog.open) deleteGameDialog.showModal();
}));
confirmDeleteStoredButton.addEventListener("click", () => run(async () => {
    const gameId = pendingDeleteGameId;
    if (gameId === null) throw new Error("No stored game is awaiting removal.");
    confirmDeleteStoredButton.disabled = true;
    try {
        await gameStore.delete(gameId);
        await refreshGames();
        deleteGameDialog.close();
        write("Stored game removed from this browser.");
    } finally {
        confirmDeleteStoredButton.disabled = false;
    }
}));
deleteGameDialog.addEventListener("close", () => {
    pendingDeleteGameId = null;
    deleteGameName.textContent = "this game";
});

element("stop").addEventListener("click", () => run(async () => {
    stopWatchingForVisibleFrame();
    await runtime?.stop();
    renderDiscControls();
    setScreenMessage("Session stopped. Open Game to start again.");
    sessionDialog.close();
    write("Session stopped.");
}));
pauseButton.addEventListener("click", () => run(async () => {
    if (player?.status === "paused") {
        player.resume();
        write("Session resumed.");
        return;
    }
    await player?.pause();
    write("Session paused.");
}));
resetButton.addEventListener("click", () => run(async () => {
    await player?.reset("soft");
    write("Session reset.");
}));
element("hard-reset").addEventListener("click", () => run(async () => { await player?.reset("hard"); }));
discSelect.addEventListener("change", () => {
    const session = player?.session;
    const index = Number(discSelect.value);
    const selectsPendingGame = pendingStoredGameId !== null && pendingDiscCount !== null
        && (session === null || session === undefined || pendingStoredGameId !== session.machine.gameId);
    if (selectsPendingGame) {
        restartDiscButton.hidden = true;
        restartDiscButton.disabled = true;
        setDiscFeedback(
            `Disc ${index + 1} of ${pendingDiscCount} will be used when ${session === null || session === undefined ? "Start" : "Switch game"} is chosen.`,
            "idle",
        );
        return;
    }
    if (session === null || session === undefined) {
        restartDiscButton.hidden = true;
        restartDiscButton.disabled = true;
        if (pendingDiscCount !== null) {
            setDiscFeedback(
                `Disc ${index + 1} of ${pendingDiscCount} will be used when Start is chosen.`,
                "idle",
            );
        }
        return;
    }
    const selectedDiscIsActive = index === session.discIndex;
    startButton.disabled = selectedDiscIsActive;
    startButton.textContent = selectedDiscIsActive ? "Disc active" : "Change disc";
    restartDiscButton.hidden = selectedDiscIsActive;
    restartDiscButton.disabled = selectedDiscIsActive;
    restartDiscButton.textContent = "Restart from disc";
    setDiscFeedback(
        selectedDiscIsActive
            ? `Disc ${index + 1} of ${session.machine.discCount} active.`
            : `Disc ${index + 1} selected. Change disc preserves the running game for an in-game insert-disc prompt; Restart from disc boots it directly.`,
        selectedDiscIsActive ? "success" : "idle",
    );
});
muteAudioButton.addEventListener("click", () => run(async () => {
    const audio = requireSessionAudio();
    if (audio.isMuted) {
        audio.unmute();
        await audio.unlock();
        write("Audio unmuted.");
        return;
    }
    audio.mute();
    write("Audio muted.");
}));
element("audio-volume").addEventListener("input", () => run(() => {
    const audio = sessionAudio();
    if (audio !== null) audio.volume = Number(element<HTMLInputElement>("audio-volume").value);
}));
fullscreenButtons.fit.addEventListener("click", () => run(() => enterFullscreen("fit")));
fullscreenButtons.stretch.addEventListener("click", () => run(() => enterFullscreen("stretch")));
touchControllerViewInput.addEventListener("change", updateTouchControllerPreferences);
touchControllerPortInput.addEventListener("change", updateTouchControllerPreferences);
touchControllerSwapInput.addEventListener("change", updateTouchControllerPreferences);
touchControllerToggle.addEventListener("click", () => {
    const visible = !touchControllerElement.hidden;
    touchControllerViewInput.value = visible ? "hide" : "show";
    updateTouchControllerPreferences();
});

saveNewStateButton.addEventListener("click", () => runStateAction(async () => {
    const name = newStateNameInput.value.trim().normalize("NFC");
    if (name.length === 0) {
        setStateFeedback("Enter a name for the new state.", "error");
        newStateNameInput.focus();
        return;
    }
    if (stateRecords.some((record) => record.name === name)) {
        setStateFeedback(`“${name}” already exists. Use its Overwrite action to replace it.`, "error");
        return;
    }
    setStateFeedback(`Saving “${name}”…`, "working");
    await requireStatePlayer().saveState(name);
    newStateNameInput.value = "";
    await refreshStates();
    setStateFeedback(`Saved “${name}”.`, "success");
    showNotice(`Saved new state “${name}”.`);
}));
newStateNameInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    saveNewStateButton.click();
});
confirmStateActionButton.addEventListener("click", () => runStateAction(async () => {
    const action = pendingStateAction;
    if (action === null) throw new Error("No save-state change is awaiting confirmation.");
    confirmStateActionButton.disabled = true;
    try {
        if (action.kind === "overwrite") {
            setStateFeedback(`Overwriting “${action.name}”…`, "working");
            await requireStatePlayer().saveState(action.name);
        } else {
            setStateFeedback(`Deleting “${action.name}”…`, "working");
            const current = requireStatePlayer();
            const gameId = current.session!.machine.gameId;
            await current.deleteState(action.name);
            clearQuickStateName(gameId, action.name);
        }
        await refreshStates();
        stateConfirmDialog.close();
        const message = action.kind === "overwrite"
            ? `Overwrote save state “${action.name}”.`
            : `Deleted save state “${action.name}”.`;
        setStateFeedback(message, "success");
        showNotice(message);
    } finally {
        confirmStateActionButton.disabled = false;
    }
}));
stateConfirmDialog.addEventListener("close", () => {
    pendingStateAction = null;
    stateConfirmTitle.textContent = "Confirm state change";
    stateConfirmMessage.textContent = "Confirm this save-state change.";
    confirmStateActionButton.textContent = "Confirm";
});

for (const port of [1, 2] as const) {
    element(`download-card-${port}`).addEventListener("click", () => run(async () => {
        const currentPlayer = player;
        if (currentPlayer === null) throw new Error("Check and store firmware before downloading a memory card.");
        setMemoryCardFeedback(`Preparing card ${port} download…`, "working");
        try {
            const bytes = await currentPlayer.downloadMemoryCard(port);
            const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
            const url = URL.createObjectURL(new Blob([copy]));
            const link = document.createElement("a");
            link.href = url;
            link.download = `card-${port}.mcd`;
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 0);
            const message = `Downloaded card ${port} (${formatBytes(bytes.byteLength)}).`;
            setMemoryCardFeedback(message, "success");
            showNotice(message);
        } catch (error) {
            setMemoryCardFeedback(
                `Card ${port} download failed: ${error instanceof Error ? error.message : String(error)}`,
                "error",
            );
            throw error;
        }
    }));
    element(`replace-card-${port}`).addEventListener("click", () => run(async () => {
        const replacement = replacementCardInput.files?.[0];
        if (replacement === undefined) throw new Error("Select a replacement card first.");
        const currentPlayer = player;
        if (currentPlayer === null) throw new Error("Check and store firmware before replacing a memory card.");
        setMemoryCardFeedback(`Replacing card ${port} with “${replacement.name}”…`, "working");
        try {
            await currentPlayer.replaceMemoryCard(port, new Uint8Array(await replacement.arrayBuffer()));
            const message = `Card ${port} was replaced with “${replacement.name}” and stored in this browser.`;
            setMemoryCardFeedback(message, "success");
            showNotice(message);
        } catch (error) {
            setMemoryCardFeedback(
                `Card ${port} replacement failed: ${error instanceof Error ? error.message : String(error)}`,
                "error",
            );
            throw error;
        }
    }));
}

replacementCardInput.addEventListener("change", () => {
    const replacement = replacementCardInput.files?.[0];
    setMemoryCardFeedback(
        replacement === undefined
            ? "Select a card image, then choose the slot to replace."
            : `Selected “${replacement.name}” (${formatBytes(replacement.size)}). Choose card 1 or card 2.`,
        "idle",
    );
});

for (const type of ["dragenter", "dragover"] as const) {
    gameDropZone.addEventListener(type, (event) => {
        if (event.dataTransfer === null || ![...event.dataTransfer.types].includes("Files")) return;
        event.preventDefault();
        gameDropZone.dataset.dragging = "true";
        event.dataTransfer.dropEffect = "copy";
    });
}
gameDropZone.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Node && gameDropZone.contains(event.relatedTarget)) return;
    gameDropZone.dataset.dragging = "false";
});
gameDropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    gameDropZone.dataset.dragging = "false";
    const files = event.dataTransfer === null ? [] : [...event.dataTransfer.files];
    run(async () => {
        const added = await addGameFiles(files);
        if (added > 0) write(`Added ${added} dropped game ZIP${added === 1 ? "" : "s"}.`);
    });
});

const loadStoredFirmware = async (): Promise<void> => {
    storedFirmware.clear();
    for (const record of await storage.listFirmware()) storedFirmware.set(record.region, record);
    renderFirmwareStatus();
};

const loadPreload = async (): Promise<void> => {
    const response = await fetch("/__preload");
    if (!response.ok) return;
    const manifest = await response.json() as PreloadManifest;
    if (!manifest.available) return;
    if (manifest.buildUrl !== undefined) buildUrlInput.value = manifest.buildUrl;
    if (manifest.bios !== undefined) {
        const blob = await (await fetch(manifest.bios.url)).blob();
        preloadBios = new File([blob], manifest.bios.name);
        preloadRegion = manifest.bios.region;
        renderFirmwareStatus();
    }
    if (manifest.files !== undefined) {
        const files = await Promise.all(manifest.files.map(async (item) => {
            const blob = await (await fetch(item.url)).blob();
            const loaded = new File([blob], item.name);
            Object.defineProperty(loaded, "webkitRelativePath", { value: item.path });
            return loaded;
        }));
        await addGameFiles(files, true, manifest.entry);
    }
    write("Private preload is ready.");
};

const initialize = async (): Promise<void> => {
    await loadPreload();
    await Promise.all([loadStoredFirmware(), refreshGames()]);
    await ensureRuntime();
};

loadQuickStateAssignments();
loadTouchControllerPreferences();
const controlProfileLoadStatus = loadControlProfile();
controlStorageStatus.textContent = controlProfileLoadStatus === "loaded"
    ? "Stored control bindings loaded from this browser."
    : controlProfileLoadStatus === "invalid"
        ? "The stored control profile is invalid and was ignored; default bindings are active."
        : controlProfileLoadStatus === "unavailable"
            ? "Browser storage is unavailable; binding changes will last only for this page."
            : "Default control bindings are active; changes will be stored in this browser.";
renderFirmwareStatus();
initializeBindingTables();
selectControllerTab(1);
syncGamepadAssignments();
renderBindings();
void initialize().catch(report);
requestAnimationFrame(updateDiagnostics);
