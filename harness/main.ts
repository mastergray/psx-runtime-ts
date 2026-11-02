import {
    DEFAULT_GAMEPAD_BUTTON_MAP,
    DEFAULT_KEYBOARD_MAP,
    LibretroPsxAdapter,
    PsxConsole,
    PsxGameStore,
    PsxRuntimeError,
    PsxStorage,
    ZipFirmwareSource,
    isGamepadButtonMaps,
    isKeyboardMap,
} from "../src/index.js";

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
} from "../src/index.js";

interface PreloadManifest {
    readonly available: boolean;
    readonly buildUrl?: string;
    readonly gameId?: string;
    readonly entry?: string;
    readonly bios?: { readonly name: string; readonly url: string; readonly region: "ntsc-u" | "ntsc-j" | "pal" };
    readonly files?: ReadonlyArray<{ readonly name: string; readonly path: string; readonly url: string }>;
}

const DEFAULT_FIRMWARE_REGION: PsxRegion = "ntsc-u";
const CONTROL_PROFILE_STORAGE_KEY = "psx-runtime:ui:controls";
const HARNESS_PROFILE_ID = "harness";

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
const noticeToast = element<HTMLDivElement>("notice-toast");
const gameMenuButton = element<HTMLButtonElement>("game-menu");
const libraryMenuButton = element<HTMLButtonElement>("library-menu");
const statesMenuButton = element<HTMLButtonElement>("states-menu");
const gameDialog = element<HTMLDialogElement>("game-dialog");
const libraryDialog = element<HTMLDialogElement>("library-dialog");
const deleteGameDialog = element<HTMLDialogElement>("delete-game-dialog");
const viewDialog = element<HTMLDialogElement>("view-dialog");
const sessionDialog = element<HTMLDialogElement>("session-dialog");
const statesDialog = element<HTMLDialogElement>("states-dialog");
const stateConfirmDialog = element<HTMLDialogElement>("state-confirm-dialog");
const canvas = element<HTMLCanvasElement>("screen");
const container = element<HTMLDivElement>("screen-stage");
const buildUrlInput = element<HTMLInputElement>("build-url");
const biosInput = element<HTMLInputElement>("bios");
const biosRegionInput = element<HTMLSelectElement>("bios-region");
biosRegionInput.value = DEFAULT_FIRMWARE_REGION;
const filesInput = element<HTMLInputElement>("game-files");
const gameDropZone = element<HTMLElement>("game-drop-zone");
const gameSelection = element<HTMLElement>("game-selection");
const gameTitleInput = element<HTMLInputElement>("game-id");
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
const controlStorageStatus = element<HTMLElement>("control-storage-status");
const restoreControlsButton = element<HTMLButtonElement>("restore-controls");
const memoryCardStatus = element<HTMLElement>("memory-card-status");
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
const storedTitleInput = element<HTMLInputElement>("stored-title");
const startStoredButton = element<HTMLButtonElement>("start-stored");
const renameStoredButton = element<HTMLButtonElement>("rename-stored");
const deleteStoredButton = element<HTMLButtonElement>("delete-stored");
const confirmDeleteStoredButton = element<HTMLButtonElement>("confirm-delete-stored");
const deleteGameName = element<HTMLElement>("delete-game-name");
const startButton = element<HTMLButtonElement>("start");
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
let preloadFiles: File[] | null = null;
let preloadBios: File | null = null;
let preloadRegion: "ntsc-u" | "ntsc-j" | "pal" = "ntsc-u";
let droppedFiles: File[] | null = null;
let runtime: PsxConsole | null = null;
let player: PsxPlayer | null = null;
let activeBuildUrl = "";
let supportedFirmwareByteLengths: ReadonlyArray<number> = [];
let activeFirmwareByteLengths: ReadonlyArray<number> = [];
let visibleFrameUnsubscribe: (() => void) | null = null;
let launchInProgress = false;
let pendingDiscCount: number | null = null;
let pendingStoredGameId: string | null = null;
let pendingDeleteGameId: string | null = null;
let screenMessageRevision = 0;
let generatedGameTitle = "";
let fullscreenExitChordHeld = false;
let stateRecords: ReadonlyArray<PsxStateRecord> = [];
let pendingStateAction: { readonly kind: "overwrite" | "delete"; readonly name: string } | null = null;
let modalPauseOwner: PsxPlayer | null = null;
let modalPauseTask: Promise<void> | null = null;
let noticeRevision = 0;
const storedGameTitles = new Map<string, string>();

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

const setDiscFeedback = (message: string, state: "idle" | "working" | "success" | "error"): void => {
    discFeedback.textContent = message;
    discFeedback.dataset.state = state;
};

const renderDiscControls = (): void => {
    const session = player?.session;
    const pendingCount = pendingDiscCount;
    const pendingGameId = pendingStoredGameId;
    const pendingGameReady = pendingCount !== null && pendingGameId !== null
        && (session === null || session === undefined || pendingGameId !== session.machine.gameId);
    if (pendingGameReady) {
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
    button.addEventListener("click", () => button.closest("dialog")?.close());
});

document.querySelectorAll<HTMLDialogElement>("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
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
    const files = filesInput.files !== null && filesInput.files.length > 0
        ? filesInput.files
        : droppedFiles !== null && droppedFiles.length > 0
            ? droppedFiles
            : preloadFiles !== null && preloadFiles.length > 0
                ? preloadFiles
                : null;
    if (files === null) {
        throw new Error("No game is selected. Choose one game ZIP; firmware is a separate input.");
    }
    const selection: PsxFileListLike = files;
    const first = typeof selection.item === "function" ? selection.item(0) : selection[0];
    if (selection.length !== 1 || first === null || first === undefined || !/\.zip$/iu.test(first.name)) {
        throw new Error("The harness accepts exactly one game ZIP.");
    }
    return selection;
};

const titleFromFile = (file: { readonly name: string }): string =>
    file.name.replace(/\.zip$/iu, "").trim() || "Local game";

const setGeneratedGameTitle = (file: File | undefined): void => {
    if (file === undefined) return;
    if (gameTitleInput.value.trim().length === 0 || gameTitleInput.value === generatedGameTitle) {
        generatedGameTitle = titleFromFile(file);
        gameTitleInput.value = generatedGameTitle;
    }
};

const selectGameFiles = (files: ReadonlyArray<File>, source: "drop" | "picker"): File | null => {
    const file = files.length === 1 && /\.zip$/iu.test(files[0]!.name) ? files[0]! : null;
    if (source === "drop") {
        filesInput.value = "";
        droppedFiles = file === null ? null : [file];
    } else {
        droppedFiles = null;
    }
    setGeneratedGameTitle(file ?? undefined);
    pendingDiscCount = null;
    pendingStoredGameId = null;
    renderDiscControls();
    if (file !== null) {
        gameDropZone.dataset.state = "selected";
        gameSelection.textContent = `Selected: ${file.name}`;
        setGameFeedback("Game ZIP selected. Ready to check and store.", "idle");
        return file;
    }
    const empty = files.length === 0;
    gameDropZone.dataset.state = empty ? "idle" : "error";
    gameSelection.textContent = empty ? "No game ZIP selected." : "Selection rejected: choose exactly one ZIP file.";
    setGameFeedback(
        empty ? "Choose a game ZIP, then run Check And Store." : "Choose exactly one game ZIP.",
        empty ? "idle" : "error",
    );
    return null;
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
    const file = selectGameFiles(files, "picker");
    if (file !== null) write(`Selected game ZIP: ${file.name}`);
});

const ensureRuntime = async (): Promise<PsxConsole> => {
    const buildUrl = buildUrlInput.value.trim();
    if (runtime !== null && activeBuildUrl === buildUrl) {
        supportedFirmwareByteLengths = activeFirmwareByteLengths;
        renderFirmwareStatus();
        return runtime;
    }
    if (runtime !== null) {
        stopWatchingForVisibleFrame();
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
    });
    player.on("error", report);
    activeBuildUrl = buildUrl;
    return runtime;
};

const localConfig = () => {
    const files = selectedFiles();
    const first = typeof files.item === "function" ? files.item(0) : files[0];
    const title = gameTitleInput.value.trim();
    return {
        gameId: title.length > 0 ? title : titleFromFile(first!),
        ...(element<HTMLInputElement>("entry").value.trim().length === 0
        ? {}
        : { entry: element<HTMLInputElement>("entry").value.trim() }),
    };
};

const run = (action: () => Promise<unknown> | unknown): void => {
    void Promise.resolve().then(async () => {
        const pauseTask = modalPauseTask;
        if (pauseTask !== null) await pauseTask;
        return action();
    }).catch(report);
};

const setStateFeedback = (message: string, state: "idle" | "working" | "success" | "error"): void => {
    stateFeedback.textContent = message;
    stateFeedback.dataset.state = state;
};

const requireStatePlayer = (): PsxPlayer => {
    const current = player;
    if (current === null || current.session === null) throw new Error("Start a game before managing save states.");
    return current;
};

const runStateAction = (action: () => Promise<void>): void => run(async () => {
    try {
        await action();
    } catch (error) {
        setStateFeedback(`Save-state operation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        throw error;
    }
});

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
        cell.colSpan = 5;
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
        cell.colSpan = 5;
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
        row.append(name, saved, disc, compatibility, actions);
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

const updateDiagnostics = (): void => {
    const input = player?.input as ({
        readonly snapshot?: ReadonlyArray<{ readonly port: number; readonly button: string }>;
        readonly axes?: ReadonlyArray<{
            readonly control: { readonly port: number; readonly axis: string };
            readonly value: number;
        }>;
    } | null);
    const snapshot = input?.snapshot ?? [];
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
    downloadCardButtons.forEach((button) => { button.disabled = !sessionActive; });
    replaceCardButtons.forEach((button) => { button.disabled = sessionActive; });
    replacementCardInput.disabled = sessionActive;
    memoryCardStatus.textContent = sessionActive
        ? "Download the current cards now; stop the game before replacing either card."
        : "Replacement cards can be selected while no game is running.";
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

const auditSelectedGame = async (console: PsxConsole): Promise<number | null> => {
    const result = await console.auditFiles(selectedFiles(), localConfig());
    if (result.ok) {
        const warnings = result.issues.filter(({ severity }) => severity === "warning").length;
        const message = `Audit passed: ${result.audit.discs.length} disc(s)${warnings === 0 ? "." : `, ${warnings} warning(s).`}`;
        setGameFeedback(message, "success");
        write(message);
        return result.audit.discs.length;
    }
    const details = result.issues.slice(0, 3).map(({ message }) => message).join(" ");
    const message = `Audit failed: ${result.issues.length} issue(s).${details.length === 0 ? "" : ` ${details}`}`;
    setGameFeedback(message, "error");
    write(message);
    return null;
};

auditButton.addEventListener("click", () => run(async () => {
    auditButton.disabled = true;
    pendingStoredGameId = null;
    setGameFeedback("Checking game ZIP…", "working");
    try {
        const console = await ensureRuntime();
        const discCount = await auditSelectedGame(console);
        if (discCount === null) {
            pendingDiscCount = null;
            renderDiscControls();
            return;
        }
        pendingDiscCount = discCount;
        startButton.disabled = true;
        setGameFeedback("Game check passed. Storing game…", "working");
        const imported = await console.importFiles(selectedFiles(), localConfig());
        await refreshGames();
        pendingStoredGameId = imported.gameId;
        storedGameInput.value = imported.gameId;
        renderStoredGameSelection();
        renderDiscControls();
        const message = "Game check passed and game was stored in this browser.";
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
}));

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
        const console = await ensureRuntime();
        const bios = await selectedBios();
        await console.startStored(gameId, startConfig(bios, Number(discSelect.value)));
        await prepareSessionAudio();
        pendingDiscCount = player?.session?.machine.discCount ?? pendingDiscCount;
        renderDiscControls();
        setScreenMessage("Session is running; waiting for video…");
        watchForVisibleFrame();
        gameDialog.close();
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
        gameDialog.close();
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

const selectedStoredGame = (): string => {
    const gameId = storedGameInput.value;
    if (gameId.length === 0) throw new Error("Select a stored game first.");
    return gameId;
};

const renderStoredGameSelection = (): void => {
    const gameId = storedGameInput.value;
    const hasSelection = gameId.length > 0 && storedGameTitles.has(gameId);
    startStoredButton.disabled = !hasSelection;
    renameStoredButton.disabled = !hasSelection;
    deleteStoredButton.disabled = !hasSelection;
    storedTitleInput.disabled = !hasSelection;
    if (hasSelection) storedTitleInput.value = storedGameTitles.get(gameId)!;
    else storedTitleInput.value = "";
};

const refreshGames = async (): Promise<void> => {
    const previous = storedGameInput.value;
    const games = await gameStore.list();
    storedGameTitles.clear();
    games.forEach((game) => storedGameTitles.set(game.gameId, game.displayTitle));
    storedGameInput.replaceChildren(...games.map((game) => {
        const option = document.createElement("option");
        option.value = game.gameId;
        option.textContent = `${game.displayTitle} (${game.discCount} disc${game.discCount === 1 ? "" : "s"})`;
        return option;
    }));
    if (games.some(({ gameId }) => gameId === previous)) storedGameInput.value = previous;
    renderStoredGameSelection();
};

libraryMenuButton.addEventListener("click", () => run(refreshGames));
statesMenuButton.addEventListener("click", () => run(refreshStates));
storedGameInput.addEventListener("change", renderStoredGameSelection);
startStoredButton.addEventListener("click", () => run(async () => {
    const gameId = selectedStoredGame();
    const switching = player?.session !== null && player?.session !== undefined;
    launchInProgress = true;
    stopWatchingForVisibleFrame();
    setScreenMessage(switching ? "Switching PlayStation games…" : "Starting stored PlayStation game…");
    const console = await ensureRuntime();
    const bios = await selectedBios();
    await console.startStored(gameId, startConfig(bios));
    await prepareSessionAudio();
    pendingStoredGameId = gameId;
    pendingDiscCount = player?.session?.machine.discCount ?? null;
    renderDiscControls();
    setScreenMessage("Session is running; waiting for video…");
    watchForVisibleFrame();
    libraryDialog.close();
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
        setDiscFeedback(
            `Disc ${index + 1} of ${pendingDiscCount} will be used when ${session === null || session === undefined ? "Start" : "Switch game"} is chosen.`,
            "idle",
        );
        return;
    }
    if (session === null || session === undefined) {
        if (pendingDiscCount !== null) {
            setDiscFeedback(
                `Disc ${index + 1} of ${pendingDiscCount} will be used when Start is chosen.`,
                "idle",
            );
        }
        return;
    }
    startButton.disabled = index === session.discIndex;
    startButton.textContent = index === session.discIndex ? "Disc active" : "Change disc";
    setDiscFeedback(
        index === session.discIndex
            ? `Disc ${index + 1} of ${session.machine.discCount} active.`
            : `Disc ${index + 1} selected. Choose Change disc to continue.`,
        index === session.discIndex ? "success" : "idle",
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
            await requireStatePlayer().deleteState(action.name);
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
        const bytes = await player?.downloadMemoryCard(port);
        if (bytes === undefined) return;
        const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const url = URL.createObjectURL(new Blob([copy]));
        const link = document.createElement("a");
        link.href = url;
        link.download = `card-${port}.mcd`;
        link.click();
        URL.revokeObjectURL(url);
    }));
    element(`replace-card-${port}`).addEventListener("click", () => run(async () => {
        const replacement = replacementCardInput.files?.[0];
        if (replacement === undefined) throw new Error("Select a replacement card first.");
        await player?.replaceMemoryCard(port, new Uint8Array(await replacement.arrayBuffer()));
    }));
}

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
    const file = selectGameFiles(files, "drop");
    write(file === null ? "Drop exactly one game ZIP." : `Selected game ZIP: ${file.name}`);
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
    if (manifest.gameId !== undefined) gameTitleInput.value = manifest.gameId;
    if (manifest.entry !== undefined) element<HTMLInputElement>("entry").value = manifest.entry;
    if (manifest.bios !== undefined) {
        const blob = await (await fetch(manifest.bios.url)).blob();
        preloadBios = new File([blob], manifest.bios.name);
        preloadRegion = manifest.bios.region;
        renderFirmwareStatus();
    }
    if (manifest.files !== undefined) {
        preloadFiles = await Promise.all(manifest.files.map(async (item) => {
            const blob = await (await fetch(item.url)).blob();
            const loaded = new File([blob], item.name);
            Object.defineProperty(loaded, "webkitRelativePath", { value: item.path });
            return loaded;
        }));
        if (manifest.gameId === undefined) setGeneratedGameTitle(preloadFiles[0]);
    }
    write("Private preload is ready.");
};

const initialize = async (): Promise<void> => {
    await loadPreload();
    await Promise.all([loadStoredFirmware(), refreshGames()]);
    await ensureRuntime();
};

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
