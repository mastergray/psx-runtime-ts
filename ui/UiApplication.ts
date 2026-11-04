// Dependencies:
import {
    LibretroPsxAdapter,
    PsxAudio,
    PsxConsole,
    PsxPlayer,
    ZipDiscSource,
    ZipFirmwareSource,
} from "../src/index.js";
import ControlSettings from "./ControlSettings.js";              // Owns persistent keyboard and gamepad mappings
import { summarizeMemoryCard } from "./MemoryCardDirectory.js"; // Interprets card directory entries for read-only display
import PresentationMode from "./PresentationMode/PresentationMode.js"; // Owns the controller-first television skin
import TouchController from "./TouchController.js";            // Routes the production touch surface into session input
import {
    isUiControllerTypePreferences, // Validates per-game emulated controller preferences
    isUiDialogId,                  // Validates declarative dialog targets
    isUiQuickStatePreferences,     // Validates quick-slot assignments shared with the harness
    isUiViewMode,                  // Validates deferred View selections
} from "./types.js";

// Type dependencies:
import type {
    BiosImage,          // Stored firmware supplied when a session starts
    ControllerPort,     // Physical port used by automatic browser-gamepad binding
    PsxFirmwareRecord,  // Stored firmware metadata rendered by System
    PsxMachineInfo,     // Active core and content identity used for state compatibility
    PsxControllerType,  // Per-game emulated controller device selected for one port
    PsxPlayerStatus,    // Lifecycle status rendered by the stage
    PsxRegion,          // Selected firmware region
    PsxScalingMode,     // Display layout selected in View
    PsxStateRecord,     // Stored named state rendered by the active Game panel
    PsxStoredGame,      // Lightweight game metadata rendered by Library
} from "../src/index.js";
import type {
    PsxMemoryCardSummary,  // Read-only card-directory summary rendered in Memory Cards
    UiApplicationConfig,    // Browser and runtime dependencies supplied by main
    UiControllerTypePreferences, // Persisted per-game emulated controller selections
    UiDialogId,             // Supported production dialog identifiers
    UiFeedbackState,        // Operation feedback severity
    UiGamePanel,            // Active-session or import panel shown by Game
    UiQuickStatePreferences, // Persisted per-game quick-slot assignments
    UiQuickStateSlot,       // Quick State 1 or 2 selected from a controller
    UiStageState,           // Closed central-stage presentation state
    UiSystemPanel,          // Firmware or Controls System tab
    UiViewMode,             // Deferred windowed or fullscreen View selection
} from "./types.js";
import type { UiPresentationSnapshot } from "./PresentationMode/types.js"; // Runtime and library data shown in TV mode

const PROFILE_ID = "web-emulator";
const CARD_IDS = Object.freeze({ 1: "card-1", 2: "card-2" });
const REGIONS = Object.freeze(["ntsc-u", "ntsc-j", "pal"] as const);
const DEFAULT_CONTROLLER_TYPES = Object.freeze({ 1: "dualshock", 2: "dualshock" } as const);
const TOUCH_CONTROLLER_STORAGE_KEY = "psx-runtime:ui:on-screen-controller";
const CONTROLLER_TYPE_STORAGE_KEY = "psx-runtime:ui:controller-types";
const QUICK_STATE_STORAGE_KEY = "psx-runtime:ui:quick-states";
const QUICK_STATE_NAMES = Object.freeze(["Quick State 1", "Quick State 2"] as const);

/**
 *
 * Class
 *
 */

// Owns the production browser interface and delegates emulation concerns to the runtime package.
export default class UiApplication {

    /* Instance Fields */
    private readonly _document: Document;                         // Production document containing the required DOM contract
    private readonly _storage: UiApplicationConfig["storage"];   // Firmware and memory-card persistence
    private readonly _gameStore: UiApplicationConfig["gameStore"]; // Audited game-library persistence
    private readonly _buildUrl: string;                           // PlayStation core build root
    private readonly _controls: ControlSettings;                  // Persistent two-player physical input configuration
    private readonly _presentation: PresentationMode;             // Controller-first fullscreen television skin
    private readonly _touchController: TouchController;           // Player-one pointer controller rendered below or over the stage
    private readonly _firmware = new Map<PsxRegion, PsxFirmwareRecord>(); // Stored firmware records by region
    private _adapter: LibretroPsxAdapter | null = null;           // Loaded core metadata and worker factory
    private _runtime: PsxConsole | null = null;                   // Composed browser runtime
    private _player: PsxPlayer | null = null;                     // Concrete player surface used by supported UI controls
    private _games: ReadonlyArray<PsxStoredGame> = [];            // Current ordered browser library
    private _selectedArchives: File[] = [];                       // Ordered ZIP selection awaiting import
    private _importedGameId: string | null = null;                // Stored identity produced by the current selection
    private _selectedGamePanel: UiGamePanel = "import";           // Current context-sensitive Game modal panel
    private _selectedSystemPanel: UiSystemPanel = "firmware";     // Current System firmware or control-mapping panel
    private _controllerTypePreferences: UiControllerTypePreferences; // Per-game emulated controller devices
    private _quickStatePreferences: UiQuickStatePreferences;       // Per-game Quick State 1/2 assignments
    private _stateRecords: ReadonlyArray<PsxStateRecord> = [];     // Named states loaded for the active game
    private _selectedLibraryGameId: string | null = null;         // Game currently displayed in Library details
    private _selectedLibraryDiscIndex = 0;                        // Initial or replacement disc selected in Library
    private _busyDialog: UiDialogId | null = null;                // Dialog protected from dismissal during a mutation
    private _resumeAfterDialog = false;                           // Whether the active dialog paused a running session
    private _switchingDialogs = false;                            // Prevents transient resume between modal surfaces
    private _noticeTimer: ReturnType<typeof globalThis.setTimeout> | null = null; // Pending notice dismissal timer
    private _muted = false;                                      // Requested audio mute state for the active session
    private _selectedScaling: PsxScalingMode = "fit";            // Active or pending display scaling shared by both modes
    private _firmwareBusy = false;                               // Whether one firmware validation/storage operation is active
    private _memoryImportBusy = false;                            // Whether one card replacement is reading or persisting bytes
    private _touchControllerVisible = false;                      // Persisted preference controlling touch-surface presentation

    // CONSTRUCTOR :: uiApplicationConfig -> uiApplication
    // Retains validated composition dependencies; initialize() binds the document and loads persistent state.
    constructor(config: UiApplicationConfig) {
        this._document = config.document;
        this._storage = config.storage;
        this._gameStore = config.gameStore;
        this._buildUrl = config.buildUrl;
        const localStorage = browserStorage(this._document);
        this._controls = new ControlSettings({ document: this._document, storage: localStorage });
        this._touchController = new TouchController({
            root: element(this._document, "touch-controller"),
            document: this._document,
        });
        this._touchControllerVisible = storedBoolean(
            localStorage,
            TOUCH_CONTROLLER_STORAGE_KEY,
        );
        this._controllerTypePreferences = loadControllerTypePreferences(localStorage);
        this._quickStatePreferences = loadQuickStatePreferences(localStorage);
        this._presentation = new PresentationMode({
            document: this._document,
            storage: localStorage,
            getSnapshot: () => this._presentationSnapshot(),
            pauseForMenu: () => this._pauseForPresentation(),
            resumeFromMenu: (ownedPause) => this._resumeFromPresentation(ownedPause),
            enterFullscreen: () => this._enterPresentationFullscreen(),
            leaveFullscreen: () => this._leavePresentationFullscreen(),
            startGame: (gameId, discIndex) => this._startStoredGame(gameId, discIndex),
            changeDisc: (discIndex) => this._changePresentationDisc(discIndex),
            reset: () => this._resetSession(),
            setScaling: (scaling) => this._setPresentationScaling(scaling),
        });
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: VOID -> PROMISE(VOID)
    // Binds the production document, loads the core and storage, and renders the first actionable state.
    async initialize(): Promise<void> {
        this._controls.initialize();
        this._presentation.initialize();
        this._bindDocument();
        this._renderStage("loading");
        try {
            this._adapter = await LibretroPsxAdapter.init({ buildUrl: this._buildUrl });
            this._createRuntime(this._adapter);
            await Promise.all([this._refreshFirmware(), this._refreshLibrary(), this._refreshMemoryCards()]);
            this._renderStage(this._hasSelectedFirmware() ? "ready" : "firmware-required");
        } catch (error) {
            this._renderStage("failed", errorMessage(error));
            throw error;
        }
    }

    // METHOD :: VOID -> VOID
    // Binds declarative navigation and supported workflow controls exactly once.
    private _bindDocument(): void {
        element<HTMLInputElement>(this._document, "touch-controller-visible").checked = this._touchControllerVisible;
        this._syncTouchController();
        for (const trigger of this._document.querySelectorAll<HTMLElement>("[data-open-dialog]")) {
            trigger.addEventListener("click", () => {
                const dialog = trigger.dataset.openDialog;
                if (isUiDialogId(dialog)) void this._openDialog(dialog);
            });
        }
        for (const dialogId of ["system", "game", "library", "memory", "view", "volume"] as const) {
            const dialog = element<HTMLDialogElement>(this._document, `${dialogId}-dialog`);
            dialog.addEventListener("cancel", (event) => {
                if (this._busyDialog === dialogId) event.preventDefault();
            });
            dialog.addEventListener("close", () => {
                if (dialogId === "system") this._controls.cancelCapture();
                if (dialogId === "memory") this._resetMemoryCardView();
                void this._dialogClosed();
            });
        }

        element<HTMLButtonElement>(this._document, "system-firmware-tab").addEventListener("click", () => {
            this._selectSystemPanel("firmware");
        });
        element<HTMLButtonElement>(this._document, "system-controls-tab").addEventListener("click", () => {
            this._selectSystemPanel("controls");
        });

        element<HTMLSelectElement>(this._document, "firmware-region").addEventListener("change", () => {
            this._renderFirmware();
            if (this._player?.status === "idle") {
                this._renderStage(this._hasSelectedFirmware() ? "ready" : "firmware-required");
            }
        });
        element<HTMLInputElement>(this._document, "firmware-file").addEventListener("change", () => {
            const file = element<HTMLInputElement>(this._document, "firmware-file").files?.[0];
            this._renderFirmware();
            if (file === undefined) {
                this._feedback("firmware", "Select a user-supplied firmware image for the chosen region.", "idle");
                return;
            }
            this._feedback(
                "firmware",
                this._hasSelectedFirmware()
                    ? `Selected “${file.name}”. Check and replace the stored firmware after validation.`
                    : `Selected “${file.name}”. Check and store it for ${regionLabel(this._selectedRegion())}.`,
                "idle",
            );
        });
        element<HTMLButtonElement>(this._document, "store-firmware").addEventListener("click", () => {
            void this._storeFirmware();
        });
        element<HTMLButtonElement>(this._document, "forget-firmware").addEventListener("click", () => {
            void this._forgetFirmware();
        });
        element<HTMLButtonElement>(this._document, "system-stop-session").addEventListener("click", () => {
            void this._stopSession();
        });

        const screenStage = element<HTMLElement>(this._document, "screen-stage");
        for (const eventName of ["dragenter", "dragover"]) {
            screenStage.addEventListener(eventName, (event) => {
                if (!this._acceptsStageDrop()) return;
                event.preventDefault();
                screenStage.dataset.dragging = "true";
            });
        }
        for (const eventName of ["dragleave", "dragend"]) {
            screenStage.addEventListener(eventName, () => { screenStage.dataset.dragging = "false"; });
        }
        screenStage.addEventListener("drop", (event) => {
            if (!this._acceptsStageDrop()) return;
            event.preventDefault();
            screenStage.dataset.dragging = "false";
            const files = event.dataTransfer === null ? [] : [...event.dataTransfer.files];
            if (this._acceptsFirmwareDrop()) {
                if (files.length !== 1) {
                    this._showNotice("Drop exactly one firmware image or ZIP.");
                    return;
                }
                void this._storeFirmwareFile(files[0]!, false);
                return;
            }
            void this._addArchives(files).then(() => this._openDialog("game"));
        });

        const gameInput = element<HTMLInputElement>(this._document, "game-files");
        gameInput.addEventListener("change", () => {
            void this._addArchives(gameInput.files === null ? [] : [...gameInput.files]);
            gameInput.value = "";
        });
        const dropZone = element<HTMLElement>(this._document, "game-drop-zone");
        const gameDialog = element<HTMLDialogElement>(this._document, "game-dialog");
        for (const eventName of ["dragenter", "dragover"]) {
            dropZone.addEventListener(eventName, (event) => {
                event.preventDefault();
                event.stopPropagation();
                dropZone.dataset.dragging = "true";
                gameDialog.dataset.dragging = "true";
            });
            gameDialog.addEventListener(eventName, (event) => {
                event.preventDefault();
                dropZone.dataset.dragging = "true";
                gameDialog.dataset.dragging = "true";
            });
        }
        for (const eventName of ["dragleave", "dragend"]) {
            dropZone.addEventListener(eventName, (event) => {
                event.stopPropagation();
                dropZone.dataset.dragging = "false";
                gameDialog.dataset.dragging = "false";
            });
            gameDialog.addEventListener(eventName, () => {
                dropZone.dataset.dragging = "false";
                gameDialog.dataset.dragging = "false";
            });
        }
        dropZone.addEventListener("drop", (event) => {
            event.preventDefault();
            event.stopPropagation();
            dropZone.dataset.dragging = "false";
            gameDialog.dataset.dragging = "false";
            void this._addArchives(event.dataTransfer === null ? [] : [...event.dataTransfer.files]);
        });
        gameDialog.addEventListener("drop", (event) => {
            event.preventDefault();
            dropZone.dataset.dragging = "false";
            gameDialog.dataset.dragging = "false";
            void this._addArchives(event.dataTransfer === null ? [] : [...event.dataTransfer.files])
                .then(() => this._selectGamePanel("import"));
        });
        element<HTMLButtonElement>(this._document, "clear-game").addEventListener("click", () => {
            this._selectedArchives = [];
            this._importedGameId = null;
            void this._renderArchiveSelection();
        });
        element<HTMLButtonElement>(this._document, "store-game").addEventListener("click", () => {
            void this._storeSelectedGame(false);
        });
        element<HTMLButtonElement>(this._document, "start-imported-game").addEventListener("click", () => {
            void this._storeSelectedGame(true);
        });
        element<HTMLButtonElement>(this._document, "game-session-tab").addEventListener("click", () => {
            void this._selectGamePanel("session");
        });
        element<HTMLButtonElement>(this._document, "game-import-tab").addEventListener("click", () => {
            void this._selectGamePanel("import");
        });
        element<HTMLSelectElement>(this._document, "active-game-disc").addEventListener("change", () => {
            this._renderActiveDiscActions();
            this._describeActiveDiscSelection();
        });
        element<HTMLButtonElement>(this._document, "change-active-disc").addEventListener("click", () => {
            void this._changeActiveDisc();
        });
        element<HTMLButtonElement>(this._document, "restart-active-disc").addEventListener("click", () => {
            void this._restartFromActiveDisc();
        });
        for (const port of [1, 2] as const) {
            element<HTMLSelectElement>(this._document, `active-controller-type-${port}`).addEventListener("change", () => {
                this._controllerTypesChanged();
            });
        }
        element<HTMLButtonElement>(this._document, "apply-controller-types").addEventListener("click", () => {
            void this._restartWithControllerTypes();
        });
        element<HTMLButtonElement>(this._document, "save-new-state").addEventListener("click", () => {
            void this._saveNewState();
        });
        element<HTMLInputElement>(this._document, "new-state-name").addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void this._saveNewState();
        });
        element<HTMLSelectElement>(this._document, "entry-select").addEventListener("change", () => {
            this._importedGameId = null;
            this._renderGameActions();
            this._feedback("game", "Entry changed. Check and store the updated selection.", "idle");
        });

        element<HTMLButtonElement>(this._document, "pause-session").addEventListener("click", () => {
            void this._togglePause();
        });
        element<HTMLButtonElement>(this._document, "reset-session").addEventListener("click", () => {
            void this._resetSession();
        });
        element<HTMLButtonElement>(this._document, "mute-session").addEventListener("click", () => {
            void this._toggleMute();
        });
        element<HTMLInputElement>(this._document, "volume-level").addEventListener("input", () => {
            const volume = this._selectedVolume();
            this._setText("volume-value", `${Math.round(volume * 100)}%`);
            const audio = this._sessionAudio();
            if (audio !== null) audio.volume = volume;
            this._presentation.sync();
        });

        element<HTMLSelectElement>(this._document, "scaling-mode").addEventListener("change", () => {
            this._syncViewActions();
        });
        element<HTMLInputElement>(this._document, "touch-controller-visible").addEventListener("change", () => {
            this._syncViewActions();
        });
        element<HTMLButtonElement>(this._document, "apply-view").addEventListener("click", () => {
            void this._applyView();
        });
        element<HTMLButtonElement>(this._document, "enter-presentation").addEventListener("click", () => {
            element<HTMLDialogElement>(this._document, "view-dialog").close();
            void this._presentation.enter();
        });
        for (const port of [1, 2] as const) {
            element<HTMLButtonElement>(this._document, `download-card-${port}`).addEventListener("click", () => {
                void this._downloadMemoryCard(port);
            });
            element<HTMLButtonElement>(this._document, `import-card-${port}`).addEventListener("click", () => {
                void this._importMemoryCard(port);
            });
        }
        element<HTMLInputElement>(this._document, "memory-card-file").addEventListener("change", () => {
            const file = element<HTMLInputElement>(this._document, "memory-card-file").files?.[0];
            this._syncMemoryCardImportActions();
            if (file === undefined) {
                this._feedback("memory", "Select a 128 KiB card image to import, or download an existing card.", "idle");
            } else if (file.size !== 128 * 1024) {
                this._feedback("memory", `“${file.name}” is not a 128 KiB PlayStation memory card image.`, "error");
            } else if (this._player?.status !== "idle") {
                this._feedback("memory", `“${file.name}” is valid. Stop the current session before importing it.`, "idle");
            } else {
                this._feedback("memory", `“${file.name}” is ready. Choose the card slot to replace.`, "idle");
            }
        });
    }

    // METHOD :: libretroPsxAdapter -> VOID
    // Creates the reusable runtime and binds its lifecycle to the production stage.
    private _createRuntime(adapter: LibretroPsxAdapter): void {
        const canvas = element<HTMLCanvasElement>(this._document, "screen");
        const screenStage = element<HTMLElement>(this._document, "screen-stage");
        const playStage = element<HTMLElement>(this._document, "play-stage");
        this._runtime = PsxConsole.init({
            adapter,
            canvas,
            container: screenStage,
            fullscreenTarget: playStage,
            gestureSource: this._document,
            storage: this._storage,
            profileId: PROFILE_ID,
            memoryCardIds: CARD_IDS,
            keyboard: { target: globalThis, map: this._controls.keyboardMap },
            gamepad: {
                provider: { getGamepads: () => navigator.getGamepads() },
                scheduler: {
                    request: requestAnimationFrame.bind(globalThis),
                    cancel: cancelAnimationFrame.bind(globalThis),
                },
                target: this._document,
                leftStickDpad: this._controls.leftStickDpad,
                buttonMaps: this._controls.gamepadButtonMaps,
            },
            gameStore: this._gameStore,
        });
        this._player = this._runtime.player as PsxPlayer;
        this._controls.attachRuntime(this._runtime);
        this._player.on("status", (status) => this._playerStatusChanged(status));
        this._player.on("error", (error) => {
            const message = errorMessage(error);
            if (element<HTMLDialogElement>(this._document, "game-dialog").open) {
                if (this._selectedGamePanel === "session") {
                    this._panelFeedback("active-game-feedback", `Start failed: ${message}`, "error");
                } else {
                    this._feedback("game", `Start failed: ${message}`, "error");
                }
                return;
            }
            if (element<HTMLDialogElement>(this._document, "library-dialog").open) {
                this._libraryFeedback(`Start failed: ${message}`, "error");
                return;
            }
            this._showNotice(message);
            this._renderStage("failed", message);
        });
        this._syncTouchController();
    }

    // METHOD :: psxPlayerStatus -> VOID
    // Synchronizes stage presentation and session controls with one lifecycle transition.
    private _playerStatusChanged(status: PsxPlayerStatus): void {
        this._renderStage(status === "idle"
            ? (this._hasSelectedFirmware() ? "ready" : "firmware-required")
            : status);
        if (status === "running") {
            const audio = this._sessionAudio();
            if (audio !== null) {
                audio.volume = this._selectedVolume();
                if (this._muted) audio.mute();
                void audio.unlock().catch(() => undefined);
            }
        }
        this._syncTouchController();
        if (element<HTMLDialogElement>(this._document, "game-dialog").open) {
            void this._refreshActiveGame();
        }
        this._presentation.sync();
        void this._refreshMemoryCards();
    }

    // METHOD :: uiStageState, STRING? -> VOID
    // Renders one closed central-stage state and all dependent command availability.
    private _renderStage(state: UiStageState, detail = ""): void {
        const app = element<HTMLElement>(this._document, "ui-app");
        app.dataset.stage = state;
        const hasFirmware = this._hasSelectedFirmware();
        element<HTMLButtonElement>(this._document, "game-nav").disabled = !hasFirmware;
        element<HTMLButtonElement>(this._document, "library-nav").disabled = !hasFirmware;
        const sessionActive = state === "running" || state === "paused" || state === "failed";
        element<HTMLButtonElement>(this._document, "pause-session").disabled = state !== "running" && state !== "paused";
        element<HTMLButtonElement>(this._document, "pause-session").textContent = state === "paused" ? "Resume" : "Pause";
        element<HTMLButtonElement>(this._document, "reset-session").disabled = state !== "running" && state !== "paused";
        element<HTMLButtonElement>(this._document, "mute-session").disabled = state !== "running" && state !== "paused";
        element<HTMLButtonElement>(this._document, "volume-session").disabled = state !== "running" && state !== "paused";
        const systemStop = element<HTMLButtonElement>(this._document, "system-stop-session");
        systemStop.hidden = !sessionActive;
        systemStop.disabled = !sessionActive;
        this._syncViewActions();
        element<HTMLElement>(this._document, "pause-overlay").hidden = state !== "paused";
        this._setText("runtime-status", this._runtimeLabel(state));

        const presentation = stagePresentation(state, detail, this._games.length);
        this._setText("stage-code", presentation.code);
        this._setText("stage-title", presentation.title);
        this._setText("stage-description", presentation.description);
        const primary = element<HTMLButtonElement>(this._document, "stage-primary");
        primary.hidden = presentation.primary === null;
        primary.textContent = presentation.primary?.label ?? "";
        primary.onclick = presentation.primary === null ? null : () => { void this._openDialog(presentation.primary!.dialog); };
        const secondary = element<HTMLButtonElement>(this._document, "stage-secondary");
        secondary.hidden = presentation.secondary === null;
        secondary.textContent = presentation.secondary?.label ?? "";
        secondary.onclick = presentation.secondary === null ? null : () => { void this._openDialog(presentation.secondary!.dialog); };
        const formats = element<HTMLElement>(this._document, "stage-formats");
        formats.hidden = state !== "ready" && state !== "firmware-required";
        formats.textContent = state === "firmware-required"
            ? "DROP BIN · ROM · ZIP"
            : "DROP ONE OR MORE GAME ZIPS";
        this._renderTelemetry();
    }

    // METHOD :: uiDialogId -> PROMISE(VOID)
    // Pauses a running session and opens one supported modal surface.
    private async _openDialog(dialogId: UiDialogId): Promise<void> {
        if (dialogId !== "system" && !this._hasSelectedFirmware()
            && (dialogId === "game" || dialogId === "library")) {
            await this._openDialog("system");
            return;
        }
        const openDialog = this._document.querySelector<HTMLDialogElement>("dialog[open]");
        if (openDialog !== null) {
            this._switchingDialogs = true;
            openDialog.close();
            this._switchingDialogs = false;
        }
        if (this._player?.status === "running") {
            await this._player.pause();
            this._resumeAfterDialog = true;
        }
        if (dialogId === "system") {
            this._selectSystemPanel(this._hasSelectedFirmware() ? this._selectedSystemPanel : "firmware");
        }
        if (dialogId === "library") {
            this._libraryFeedback(null);
            this._renderLibrary();
        }
        if (dialogId === "memory") await this._refreshMemoryCards();
        if (dialogId === "view") this._resetViewForm();
        if (dialogId === "game") {
            this._selectedGamePanel = this._player?.session === null || this._player?.session === undefined
                ? "import"
                : "session";
            element<HTMLInputElement>(this._document, "new-state-name").value = "";
            element<HTMLSelectElement>(this._document, "active-game-disc").replaceChildren();
            await this._refreshActiveGame();
        }
        element<HTMLDialogElement>(this._document, `${dialogId}-dialog`).showModal();
    }

    // METHOD :: uiSystemPanel -> VOID
    // Selects the Firmware or Controls System workflow and updates tab semantics.
    private _selectSystemPanel(panel: UiSystemPanel): void {
        this._controls.cancelCapture();
        this._selectedSystemPanel = panel;
        for (const candidate of ["firmware", "controls"] as const) {
            const selected = candidate === panel;
            const tab = element<HTMLButtonElement>(this._document, `system-${candidate}-tab`);
            tab.setAttribute("aria-selected", String(selected));
            tab.tabIndex = selected ? 0 : -1;
            element<HTMLElement>(this._document, `system-${candidate}-panel`).hidden = !selected;
        }
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Resumes only sessions paused by modal entry after the final dialog closes.
    private async _dialogClosed(): Promise<void> {
        if (this._switchingDialogs || this._document.querySelector("dialog[open]") !== null) return;
        if (this._resumeAfterDialog && this._player?.status === "paused") {
            this._resumeAfterDialog = false;
            this._player.resume();
        } else {
            this._resumeAfterDialog = false;
        }
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Reloads all regional firmware slots and updates gated navigation.
    private async _refreshFirmware(): Promise<void> {
        this._firmware.clear();
        for (const record of await this._storage.listFirmware()) this._firmware.set(record.region, record);
        this._renderFirmware();
    }

    // METHOD :: VOID -> VOID
    // Renders regional firmware availability and selected-region actions.
    private _renderFirmware(): void {
        const slots = element<HTMLElement>(this._document, "firmware-slots");
        slots.replaceChildren(...REGIONS.map((region) => {
            const record = this._firmware.get(region);
            const slot = this._document.createElement("div");
            slot.className = "firmware-slot";
            slot.dataset.stored = String(record !== undefined);
            const title = this._document.createElement("strong");
            title.textContent = regionLabel(region);
            const status = this._document.createElement("span");
            status.textContent = record === undefined ? "EMPTY" : `${formatBytes(record.blob.size)} · STORED`;
            slot.append(title, status);
            return slot;
        }));
        const record = this._firmware.get(this._selectedRegion());
        const firmwareFile = element<HTMLInputElement>(this._document, "firmware-file").files?.[0];
        const store = element<HTMLButtonElement>(this._document, "store-firmware");
        store.textContent = record === undefined ? "Check And Store" : "Check And Replace";
        store.hidden = firmwareFile === undefined;
        store.disabled = firmwareFile === undefined || this._firmwareBusy;
        const forget = element<HTMLButtonElement>(this._document, "forget-firmware");
        forget.hidden = record === undefined;
        forget.disabled = record === undefined;
        element<HTMLButtonElement>(this._document, "game-nav").disabled = record === undefined;
        element<HTMLButtonElement>(this._document, "library-nav").disabled = record === undefined;
        this._renderTelemetry();
        this._presentation.sync();
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Validates and stores the selected user-supplied firmware in its regional slot.
    private async _storeFirmware(): Promise<void> {
        const input = element<HTMLInputElement>(this._document, "firmware-file");
        const file = input.files?.[0];
        if (file === undefined) {
            this._feedback("firmware", "Select a firmware image or ZIP first.", "error");
            return;
        }
        const stored = await this._storeFirmwareFile(file, true);
        if (stored) input.value = "";
        this._renderFirmware();
    }

    // METHOD :: FILE, BOOLEAN -> PROMISE(BOOLEAN)
    // Validates and stores firmware selected in System or dropped on the firmware-required stage.
    private async _storeFirmwareFile(file: File, protectDialog: boolean): Promise<boolean> {
        if (this._firmwareBusy) {
            this._showNotice("Firmware validation is already in progress.");
            return false;
        }
        const adapter = this._adapter;
        if (adapter === null) {
            this._feedback("firmware", "Core metadata is unavailable; reload the application and try again.", "error");
            return false;
        }
        let stored = false;
        const operation = async (): Promise<void> => {
            this._firmwareBusy = true;
            this._renderFirmware();
            this._feedback("firmware", `Checking “${file.name}”…`, "working");
            if (!protectDialog) this._showNotice(`Checking “${file.name}”…`);
            try {
                const region = this._selectedRegion();
                const image = await firmwareImage(file, region, adapter.build.firmware.byteLengths);
                await this._storage.saveFirmware(image);
                await this._refreshFirmware();
                const message = `Firmware passed validation and was stored for ${regionLabel(region)}.`;
                this._feedback("firmware", message, "success");
                stored = true;
                if (!protectDialog) this._showNotice(message);
                if (this._player?.status === "idle") this._renderStage("ready");
            } catch (error) {
                const message = `Check or storage failed: ${errorMessage(error)}`;
                this._feedback("firmware", message, "error");
                if (!protectDialog) {
                    this._renderStage("firmware-required");
                    this._showNotice(message);
                }
            } finally {
                this._firmwareBusy = false;
                this._renderFirmware();
            }
        };
        if (protectDialog) await this._withBusyDialog("system", operation);
        else await operation();
        return stored;
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Removes firmware from the selected regional slot after explicit confirmation.
    private async _forgetFirmware(): Promise<void> {
        const region = this._selectedRegion();
        if (!this._firmware.has(region)) return;
        if (!globalThis.confirm(
            `Delete the stored ${regionLabel(region)} firmware from this browser?`,
        )) return;
        await this._storage.deleteFirmware(region);
        await this._refreshFirmware();
        this._feedback("firmware", `Stored ${regionLabel(region)} firmware was removed.`, "success");
        if (this._player?.status === "idle") {
            this._renderStage(this._hasSelectedFirmware() ? "ready" : "firmware-required");
        }
    }

    // METHOD :: [FILE] -> PROMISE(VOID)
    // Appends valid ZIPs to the ordered import selection and inspects supported entry choices.
    private async _addArchives(files: ReadonlyArray<File>): Promise<void> {
        const archives = files.filter((file) => ZipDiscSource.isArchive(file));
        if (archives.length !== files.length) {
            this._feedback("game", "Game import accepts ZIP archives only.", "error");
        }
        if (archives.length === 0) return;
        this._selectedArchives.push(...archives);
        this._importedGameId = null;
        await this._renderArchiveSelection();
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Renders ordered selected archives and any explicit entry choice needed for one ZIP.
    private async _renderArchiveSelection(): Promise<void> {
        const list = element<HTMLOListElement>(this._document, "game-archives");
        const selection = element<HTMLElement>(this._document, "game-selection");
        const clear = element<HTMLButtonElement>(this._document, "clear-game");
        const entryChoice = element<HTMLElement>(this._document, "entry-choice");
        const entrySelect = element<HTMLSelectElement>(this._document, "entry-select");
        const hasSelection = this._selectedArchives.length > 0;
        selection.textContent = hasSelection
            ? `${this._selectedArchives.length} ZIP${this._selectedArchives.length === 1 ? "" : "s"} selected in disc order.`
            : "No game ZIPs selected.";
        list.hidden = !hasSelection;
        clear.hidden = !hasSelection;
        this._renderGameActions();
        list.replaceChildren(...this._selectedArchives.map((file, index) => {
            const item = this._document.createElement("li");
            const fileDetails = this._document.createElement("div");
            fileDetails.className = "archive-file";
            const name = this._document.createElement("span");
            name.textContent = file.name;
            const size = this._document.createElement("small");
            size.textContent = formatBytes(file.size);
            fileDetails.append(name, size);
            const actions = this._document.createElement("div");
            actions.className = "archive-actions";
            const up = button(this._document, "Move Up");
            up.dataset.archiveAction = "up";
            up.disabled = index === 0;
            up.setAttribute("aria-label", `Move ${file.name} up`);
            up.addEventListener("click", () => this._moveArchive(index, -1));
            const down = button(this._document, "Move Down");
            down.dataset.archiveAction = "down";
            down.disabled = index === this._selectedArchives.length - 1;
            down.setAttribute("aria-label", `Move ${file.name} down`);
            down.addEventListener("click", () => this._moveArchive(index, 1));
            const remove = button(this._document, "Remove");
            remove.dataset.archiveAction = "remove";
            remove.setAttribute("aria-label", `Remove ${file.name}`);
            remove.addEventListener("click", () => this._removeArchive(index));
            actions.append(up, down, remove);
            item.append(fileDetails, actions);
            return item;
        }));
        entryChoice.hidden = true;
        entrySelect.replaceChildren();
        if (!hasSelection) {
            this._feedback("game", "Choose game content to begin.", "idle");
            return;
        }
        if (this._selectedArchives.length > 1) {
            this._feedback(
                "game",
                `All ${this._selectedArchives.length} ZIPs will be checked and stored together as one ${this._selectedArchives.length}-disc Library game with a generated M3U.`,
                "idle",
            );
            return;
        }
        try {
            const descriptors = await ZipDiscSource.listDescriptors(this._selectedArchives[0]!);
            if (descriptors.length > 1) {
                entrySelect.replaceChildren(...descriptors.map((path) => option(this._document, path, path)));
                const playlist = descriptors.find((path) => path.toLowerCase().endsWith(".m3u"));
                if (playlist !== undefined) entrySelect.value = playlist;
                entryChoice.hidden = false;
                this._feedback("game", "Choose the disc-set entry, then check and store the game.", "idle");
            } else {
                this._feedback("game", "ZIP recognized. Check and store it before launch, or choose Start to do both.", "idle");
            }
        } catch (error) {
            this._feedback("game", `ZIP inspection failed: ${errorMessage(error)}`, "error");
            element<HTMLButtonElement>(this._document, "store-game").disabled = true;
            element<HTMLButtonElement>(this._document, "start-imported-game").disabled = true;
        }
    }

    // METHOD :: BOOLEAN -> PROMISE(VOID)
    // Audits and stores the current selection, optionally launching the resulting library game.
    private async _storeSelectedGame(startAfterStore: boolean): Promise<void> {
        const runtime = this._runtime;
        if (runtime === null || this._selectedArchives.length === 0) return;
        await this._withBusyDialog("game", async () => {
            let phase: "storage" | "start" = "storage";
            try {
                let gameId = this._importedGameId;
                if (gameId === null) {
                    const title = titleFromArchive(this._selectedArchives[0]!.name);
                    const entryChoice = element<HTMLElement>(this._document, "entry-choice");
                    const entry = element<HTMLSelectElement>(this._document, "entry-select").value;
                    this._renderGameActions();
                    this._feedback(
                        "game",
                        this._selectedArchives.length === 1
                            ? `Checking and storing “${title}”…`
                            : `Checking and storing all ${this._selectedArchives.length} ZIPs as one multi-disc game…`,
                        "working",
                    );
                    const game = await runtime.importFiles(this._selectedArchives, {
                        gameId: title,
                        ...(this._selectedArchives.length === 1 && !entryChoice.hidden && entry.length > 0
                            ? { entry }
                            : {}),
                    });
                    gameId = game.gameId;
                    this._importedGameId = gameId;
                    await this._refreshLibrary();
                    this._feedback(
                        "game",
                        this._selectedArchives.length === 1
                            ? `“${title}” passed validation and was stored in Library.`
                            : `All ${this._selectedArchives.length} ZIPs passed validation and were stored as one ${this._selectedArchives.length}-disc Library game, “${title}”.`,
                        "success",
                    );
                }
                if (startAfterStore) {
                    phase = "start";
                    await this._startStoredGame(gameId, 0);
                    element<HTMLDialogElement>(this._document, "game-dialog").close();
                }
            } catch (error) {
                this._feedback(
                    "game",
                    `${phase === "start" ? "Start" : "Game check or storage"} failed: ${errorMessage(error)}`,
                    "error",
                );
            }
        });
        this._renderGameActions();
    }

    // METHOD :: VOID -> VOID
    // Aligns and gates Game actions around selection, storage completion, and active mutations.
    private _renderGameActions(): void {
        const hasSelection = this._selectedArchives.length > 0;
        const stored = this._importedGameId !== null;
        const busy = this._busyDialog === "game";
        const store = element<HTMLButtonElement>(this._document, "store-game");
        const start = element<HTMLButtonElement>(this._document, "start-imported-game");
        const clear = element<HTMLButtonElement>(this._document, "clear-game");
        store.textContent = stored ? "Checked And Stored" : "Check And Store";
        store.disabled = !hasSelection || stored || busy;
        start.hidden = !stored;
        start.disabled = !stored || busy;
        clear.hidden = !hasSelection;
        clear.disabled = busy;
        element<HTMLButtonElement>(this._document, "game-session-tab").disabled = busy;
        element<HTMLButtonElement>(this._document, "game-import-tab").disabled = busy;
        const rows = [...this._document.querySelectorAll<HTMLElement>("#game-archives li")];
        rows.forEach((row, index) => {
            for (const action of row.querySelectorAll<HTMLButtonElement>("[data-archive-action]")) {
                action.disabled = busy
                    || (action.dataset.archiveAction === "up" && index === 0)
                    || (action.dataset.archiveAction === "down" && index === rows.length - 1);
            }
        });
    }

    // METHOD :: NUMBER, -1|1 -> VOID
    // Moves one selected ZIP while preserving the exact displayed disc order.
    private _moveArchive(index: number, offset: -1 | 1): void {
        const destination = index + offset;
        if (this._busyDialog === "game" || index < 0 || destination < 0
            || index >= this._selectedArchives.length || destination >= this._selectedArchives.length) return;
        const reordered = [...this._selectedArchives];
        const [archive] = reordered.splice(index, 1);
        reordered.splice(destination, 0, archive!);
        this._selectedArchives = reordered;
        this._importedGameId = null;
        void this._renderArchiveSelection();
    }

    // METHOD :: NUMBER -> VOID
    // Removes one selected ZIP and invalidates any previously stored selection result.
    private _removeArchive(index: number): void {
        if (this._busyDialog === "game" || index < 0 || index >= this._selectedArchives.length) return;
        this._selectedArchives = this._selectedArchives.filter((_, archiveIndex) => archiveIndex !== index);
        this._importedGameId = null;
        void this._renderArchiveSelection();
    }

    // METHOD :: uiGamePanel -> PROMISE(VOID)
    // Selects one Game workflow while preventing an unavailable active-session panel.
    private async _selectGamePanel(panel: UiGamePanel): Promise<void> {
        const session = this._player?.session;
        this._selectedGamePanel = panel === "session" && (session === null || session === undefined)
            ? "import"
            : panel;
        if (this._selectedGamePanel === "session") await this._refreshActiveGame();
        else this._renderGamePanels();
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Loads state metadata for the active game and renders the context-sensitive Game modal.
    private async _refreshActiveGame(): Promise<void> {
        const session = this._player?.session;
        if (session === null || session === undefined) {
            this._stateRecords = [];
            this._selectedGamePanel = "import";
            this._renderGamePanels();
            this._presentation.sync();
            return;
        }
        try {
            this._stateRecords = await this._storage.listStates(PROFILE_ID, session.machine.gameId);
            this._renderGamePanels();
            this._describeActiveDiscSelection();
            this._describeControllerTypes(session);
            this._panelFeedback(
                "state-feedback",
                "Save, load, overwrite, or delete named states for the active game.",
                "idle",
            );
            this._presentation.sync();
        } catch (error) {
            this._stateRecords = [];
            this._renderGamePanels();
            this._panelFeedback("state-feedback", `State storage failed: ${errorMessage(error)}`, "error");
            this._presentation.sync();
        }
    }

    // METHOD :: VOID -> VOID
    // Renders Game tabs and the selected active-session or import workflow.
    private _renderGamePanels(): void {
        const session = this._player?.session;
        const active = session !== null && session !== undefined;
        if (!active) this._selectedGamePanel = "import";
        const tabs = element<HTMLElement>(this._document, "game-tabs");
        const sessionTab = element<HTMLButtonElement>(this._document, "game-session-tab");
        const importTab = element<HTMLButtonElement>(this._document, "game-import-tab");
        const sessionSelected = active && this._selectedGamePanel === "session";
        const busy = this._busyDialog === "game";
        tabs.hidden = !active;
        sessionTab.disabled = busy;
        importTab.disabled = busy;
        sessionTab.setAttribute("aria-selected", String(sessionSelected));
        sessionTab.tabIndex = sessionSelected ? 0 : -1;
        importTab.setAttribute("aria-selected", String(!sessionSelected));
        importTab.tabIndex = sessionSelected ? -1 : 0;
        element<HTMLElement>(this._document, "game-session-panel").hidden = !sessionSelected;
        element<HTMLElement>(this._document, "game-import-panel").hidden = sessionSelected;
        this._setText("game-title", sessionSelected ? "[ CURRENT GAME ]" : "[ IMPORT GAME ]");
        if (active) this._renderActiveGame(session);
    }

    // METHOD :: psxSession -> VOID
    // Renders active title, disc selection, and stored state records.
    private _renderActiveGame(session: NonNullable<PsxPlayer["session"]>): void {
        this._setText("active-game-title", this._activeGameTitle());
        this._setText(
            "active-game-disc-status",
            `Disc ${session.discIndex + 1} of ${session.machine.discCount} active`,
        );
        this._renderControllerTypeActions(session);
        const discSelect = element<HTMLSelectElement>(this._document, "active-game-disc");
        const selectedDisc = discSelect.options.length === 0 ? session.discIndex : Number(discSelect.value);
        discSelect.replaceChildren(...Array.from(
            { length: session.machine.discCount },
            (_, index) => option(this._document, String(index), `Disc ${index + 1}`),
        ));
        discSelect.value = String(Number.isInteger(selectedDisc)
            && selectedDisc >= 0 && selectedDisc < session.machine.discCount
            ? selectedDisc
            : session.discIndex);
        discSelect.disabled = this._busyDialog === "game";
        element<HTMLInputElement>(this._document, "new-state-name").disabled = this._busyDialog === "game";
        element<HTMLButtonElement>(this._document, "save-new-state").disabled = this._busyDialog === "game";
        this._renderActiveDiscActions();
        const stateList = element<HTMLElement>(this._document, "state-list");
        if (this._stateRecords.length === 0) {
            const empty = this._document.createElement("div");
            empty.className = "state-empty";
            empty.textContent = "[ NO SAVED STATES ]";
            stateList.replaceChildren(empty);
            return;
        }
        stateList.replaceChildren(...this._stateRecords.map((record) => this._stateItem(record, session.machine)));
    }

    // METHOD :: psxSession -> VOID
    // Renders persisted per-game controller types and gates restart around realized session types.
    private _renderControllerTypeActions(session: NonNullable<PsxPlayer["session"]>): void {
        const selected = this._controllerTypesForGame(session.machine.gameId);
        for (const port of [1, 2] as const) {
            const input = element<HTMLSelectElement>(this._document, `active-controller-type-${port}`);
            input.value = selected[port];
            input.disabled = this._busyDialog === "game";
        }
        const changed = ([1, 2] as const).some((port) => selected[port] !== session.machine.controllers[port]);
        const apply = element<HTMLButtonElement>(this._document, "apply-controller-types");
        apply.disabled = !changed || this._busyDialog === "game";
        apply.textContent = changed ? "Restart To Apply" : "Controllers Active";
    }

    // METHOD :: psxSession -> VOID
    // Describes whether stored controller types match the active emulated devices.
    private _describeControllerTypes(session: NonNullable<PsxPlayer["session"]>): void {
        const selected = this._controllerTypesForGame(session.machine.gameId);
        const changed = ([1, 2] as const).some((port) => selected[port] !== session.machine.controllers[port]);
        this._panelFeedback(
            "controller-type-feedback",
            changed
                ? "Stored controller types are waiting for a restart."
                : "The selected controller types are active for this game.",
            changed ? "working" : "success",
        );
    }

    // METHOD :: VOID -> VOID
    // Persists current Game controller selections and reports whether a restart is required.
    private _controllerTypesChanged(): void {
        const session = this._player?.session;
        if (session === null || session === undefined) return;
        const controllers: Readonly<Record<ControllerPort, PsxControllerType>> = {
            1: element<HTMLSelectElement>(this._document, "active-controller-type-1").value as PsxControllerType,
            2: element<HTMLSelectElement>(this._document, "active-controller-type-2").value as PsxControllerType,
        };
        this._controllerTypePreferences = {
            version: 1,
            games: { ...this._controllerTypePreferences.games, [session.machine.gameId]: controllers },
        };
        persistControllerTypePreferences(browserStorage(this._document), this._controllerTypePreferences);
        this._renderControllerTypeActions(session);
        const changed = ([1, 2] as const).some((port) => controllers[port] !== session.machine.controllers[port]);
        this._panelFeedback(
            "controller-type-feedback",
            changed
                ? "Controller types stored for this game. Restart to apply them."
                : "The selected controller types are already active.",
            changed ? "working" : "success",
        );
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Restarts the active game and disc with its persisted emulated controller types.
    private async _restartWithControllerTypes(): Promise<void> {
        const session = this._player?.session;
        if (session === null || session === undefined) return;
        await this._withBusyDialog("game", async () => {
            this._panelFeedback("controller-type-feedback", "Restarting with the selected controllers…", "working");
            try {
                await this._startStoredGame(session.machine.gameId, session.discIndex);
                element<HTMLDialogElement>(this._document, "game-dialog").close();
            } catch (error) {
                this._panelFeedback(
                    "controller-type-feedback",
                    `Controller restart failed: ${errorMessage(error)}`,
                    "error",
                );
            }
        });
        if (this._player?.session !== null && this._player?.session !== undefined) {
            this._renderControllerTypeActions(this._player.session);
        }
    }

    // METHOD :: STRING -> ARRAY<controllerPort, psxControllerType>
    // Returns stored controller types for one game or the DualShock defaults.
    private _controllerTypesForGame(gameId: string): Readonly<Record<ControllerPort, PsxControllerType>> {
        return this._controllerTypePreferences.games[gameId] ?? DEFAULT_CONTROLLER_TYPES;
    }

    // METHOD :: STRING, uiQuickStateSlot -> STRING?
    // Resolves one explicit quick-slot assignment or its existing conventional state name.
    private _quickStateNameFor(gameId: string, slot: UiQuickStateSlot): string | null {
        const assigned = this._quickStatePreferences.games[gameId]?.[slot];
        if (assigned !== undefined) return assigned;
        const fallback = QUICK_STATE_NAMES[slot - 1]!;
        return this._stateRecords.some((record) => record.metadata.gameId === gameId && record.name === fallback)
            ? fallback
            : null;
    }

    // METHOD :: STRING, uiQuickStateSlot, STRING -> VOID
    // Assigns one named state, swapping slots when the target already belongs to the other slot.
    private _assignQuickState(gameId: string, slot: UiQuickStateSlot, name: string): void {
        const otherSlot: UiQuickStateSlot = slot === 1 ? 2 : 1;
        const previousTarget = this._quickStateNameFor(gameId, slot);
        const previousOther = this._quickStateNameFor(gameId, otherSlot);
        const next: Partial<Record<UiQuickStateSlot, string>> = {
            ...(this._quickStatePreferences.games[gameId] ?? {}),
            [slot]: name,
        };
        if (previousOther === name) {
            if (previousTarget === null || previousTarget === name) delete next[otherSlot];
            else next[otherSlot] = previousTarget;
        }
        this._quickStatePreferences = {
            version: 1,
            games: { ...this._quickStatePreferences.games, [gameId]: next },
        };
        persistQuickStatePreferences(browserStorage(this._document), this._quickStatePreferences);
    }

    // METHOD :: STRING, STRING -> VOID
    // Clears deleted state names from both quick slots and removes empty per-game records.
    private _clearQuickStateName(gameId: string, name: string): void {
        const current = this._quickStatePreferences.games[gameId];
        if (current === undefined || (current[1] !== name && current[2] !== name)) return;
        const next: Partial<Record<UiQuickStateSlot, string>> = { ...current };
        if (next[1] === name) delete next[1];
        if (next[2] === name) delete next[2];
        const games = { ...this._quickStatePreferences.games };
        if (Object.keys(next).length === 0) delete games[gameId];
        else games[gameId] = next;
        this._quickStatePreferences = { version: 1, games };
        persistQuickStatePreferences(browserStorage(this._document), this._quickStatePreferences);
    }

    // METHOD :: VOID -> STRING
    // Returns the active library title without exposing content identity in fallback copy.
    private _activeGameTitle(): string {
        const gameId = this._player?.session?.machine.gameId;
        return this._games.find((game) => game.gameId === gameId)?.displayTitle ?? "Current game";
    }

    // METHOD :: VOID -> VOID
    // Gates disc insertion around the active disc and Game mutation state.
    private _renderActiveDiscActions(): void {
        const session = this._player?.session;
        const selected = Number(element<HTMLSelectElement>(this._document, "active-game-disc").value);
        const change = element<HTMLButtonElement>(this._document, "change-active-disc");
        const restart = element<HTMLButtonElement>(this._document, "restart-active-disc");
        const selectedIsActive = session !== null && session !== undefined && selected === session.discIndex;
        const unavailable = session === null || session === undefined || this._busyDialog === "game";
        change.disabled = unavailable || selectedIsActive;
        change.textContent = selectedIsActive ? "Current Disc" : "Change Disc";
        restart.hidden = session === null || session === undefined || selectedIsActive;
        restart.disabled = unavailable || selectedIsActive;
    }

    // METHOD :: VOID -> VOID
    // Explains the behavioral difference between inserting and booting the selected disc.
    private _describeActiveDiscSelection(): void {
        const session = this._player?.session;
        if (session === null || session === undefined || this._busyDialog === "game") return;
        const selected = Number(element<HTMLSelectElement>(this._document, "active-game-disc").value);
        const message = session.machine.discCount === 1
            ? "This game has one disc."
            : selected === session.discIndex
                ? `Disc ${session.discIndex + 1} of ${session.machine.discCount} is active.`
                : `Disc ${selected + 1} selected. Change Disc preserves the running game; Restart From Disc boots it directly.`;
        this._panelFeedback("active-game-feedback", message, "idle");
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Inserts the selected disc, closes Game, and lets modal lifecycle resume the session.
    private async _changeActiveDisc(): Promise<void> {
        const player = this._player;
        const session = player?.session;
        if (player === null || session === null || session === undefined) return;
        const discIndex = Number(element<HTMLSelectElement>(this._document, "active-game-disc").value);
        if (!Number.isInteger(discIndex) || discIndex < 0 || discIndex >= session.machine.discCount
            || discIndex === session.discIndex) return;
        let changed = false;
        await this._withBusyDialog("game", async () => {
            this._renderActiveGame(session);
            this._panelFeedback("active-game-feedback", `Changing to Disc ${discIndex + 1}…`, "working");
            try {
                await player.setDisc(discIndex);
                this._selectedLibraryDiscIndex = discIndex;
                this._setText("runtime-status", this._runtimeLabel(player.status));
                changed = true;
            } catch (error) {
                this._panelFeedback("active-game-feedback", `Disc change failed: ${errorMessage(error)}`, "error");
            }
        });
        this._renderActiveGame(session);
        if (!changed) return;
        element<HTMLDialogElement>(this._document, "game-dialog").close();
        this._showNotice(`Disc ${discIndex + 1} inserted.`);
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Rebuilds the active game from the selected disc after warning about volatile progress loss.
    private async _restartFromActiveDisc(): Promise<void> {
        const session = this._player?.session;
        if (session === null || session === undefined) return;
        const discIndex = Number(element<HTMLSelectElement>(this._document, "active-game-disc").value);
        if (!Number.isInteger(discIndex) || discIndex < 0 || discIndex >= session.machine.discCount
            || discIndex === session.discIndex) return;
        if (!globalThis.confirm(
            `Restart “${this._activeGameTitle()}” from Disc ${discIndex + 1}? Unsaved progress since the last in-game save or save state will be lost.`,
        )) return;
        let restarted = false;
        await this._withBusyDialog("game", async () => {
            this._renderActiveGame(session);
            this._panelFeedback(
                "active-game-feedback",
                `Restarting from Disc ${discIndex + 1}…`,
                "working",
            );
            try {
                await this._startStoredGame(session.machine.gameId, discIndex);
                this._selectedLibraryDiscIndex = discIndex;
                restarted = true;
            } catch (error) {
                this._panelFeedback(
                    "active-game-feedback",
                    `Restart from disc failed: ${errorMessage(error)}`,
                    "error",
                );
            }
        });
        if (!restarted) {
            const activeSession = this._player?.session;
            if (activeSession !== null && activeSession !== undefined) this._renderActiveGame(activeSession);
            return;
        }
        this._resumeAfterDialog = false;
        element<HTMLDialogElement>(this._document, "game-dialog").close();
        this._showNotice(`Restarted from Disc ${discIndex + 1}.`);
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Saves one new uniquely named state for the active game.
    private async _saveNewState(): Promise<void> {
        const player = this._player;
        if (player?.session === null || player?.session === undefined) return;
        const input = element<HTMLInputElement>(this._document, "new-state-name");
        const name = input.value.trim().normalize("NFC");
        if (name.length === 0) {
            this._panelFeedback("state-feedback", "Enter a name for the new state.", "error");
            input.focus();
            return;
        }
        if (this._stateRecords.some((record) => record.name === name)) {
            this._panelFeedback("state-feedback", `“${name}” already exists. Use Overwrite to replace it.`, "error");
            return;
        }
        await this._runStateMutation(`Saving “${name}”…`, async () => {
            await player.saveState(name);
            input.value = "";
        }, `Saved “${name}”.`);
    }

    // METHOD :: psxStateRecord -> PROMISE(VOID)
    // Loads one compatible state and closes Game so normal modal resume behavior restores play.
    private async _loadState(record: PsxStateRecord): Promise<void> {
        const player = this._player;
        const session = player?.session;
        if (player === null || session === null || session === undefined
            || !stateCompatible(record, session.machine)) return;
        let loaded = false;
        await this._withBusyDialog("game", async () => {
            this._renderActiveGame(session);
            this._panelFeedback("state-feedback", `Loading “${record.name}”…`, "working");
            try {
                await player.loadState(record.name);
                this._selectedLibraryDiscIndex = record.metadata.discIndex;
                this._setText("runtime-status", this._runtimeLabel(player.status));
                loaded = true;
            } catch (error) {
                this._panelFeedback("state-feedback", `State load failed: ${errorMessage(error)}`, "error");
            }
        });
        if (!loaded) {
            this._renderActiveGame(session);
            return;
        }
        element<HTMLDialogElement>(this._document, "game-dialog").close();
        this._showNotice(`Loaded save state “${record.name}”.`);
    }

    // METHOD :: psxStateRecord -> PROMISE(VOID)
    // Replaces one named state after explicit confirmation.
    private async _overwriteState(record: PsxStateRecord): Promise<void> {
        const player = this._player;
        if (player?.session === null || player?.session === undefined) return;
        if (!globalThis.confirm(`Overwrite save state “${record.name}”?`)) return;
        await this._runStateMutation(
            `Overwriting “${record.name}”…`,
            async () => { await player.saveState(record.name); },
            `Overwrote “${record.name}”.`,
        );
    }

    // METHOD :: psxStateRecord -> PROMISE(VOID)
    // Removes one named state after explicit confirmation.
    private async _deleteState(record: PsxStateRecord): Promise<void> {
        const player = this._player;
        if (player?.session === null || player?.session === undefined) return;
        if (!globalThis.confirm(`Delete save state “${record.name}”?`)) return;
        await this._runStateMutation(
            `Deleting “${record.name}”…`,
            async () => {
                await player.deleteState(record.name);
                this._clearQuickStateName(player.session!.machine.gameId, record.name);
            },
            `Deleted “${record.name}”.`,
        );
    }

    // METHOD :: STRING, (VOID -> PROMISE(VOID)), STRING -> PROMISE(VOID)
    // Runs one protected state mutation, refreshes records, and reports its result in both UI surfaces.
    private async _runStateMutation(
        working: string,
        mutation: () => Promise<void>,
        success: string,
    ): Promise<void> {
        await this._withBusyDialog("game", async () => {
            const activeSession = this._player?.session;
            if (activeSession !== null && activeSession !== undefined) this._renderActiveGame(activeSession);
            this._panelFeedback("state-feedback", working, "working");
            try {
                await mutation();
                const session = this._player?.session;
                this._stateRecords = session === null || session === undefined
                    ? []
                    : await this._storage.listStates(PROFILE_ID, session.machine.gameId);
                if (session !== null && session !== undefined) this._renderActiveGame(session);
                this._panelFeedback("state-feedback", success, "success");
                this._showNotice(success);
                this._presentation.sync();
            } catch (error) {
                this._panelFeedback("state-feedback", `State change failed: ${errorMessage(error)}`, "error");
            }
        });
        const session = this._player?.session;
        if (session !== null && session !== undefined) this._renderActiveGame(session);
    }

    // METHOD :: psxStateRecord, psxMachineInfo -> HTMLElement
    // Builds one safe state summary with compatible load, overwrite, and destructive delete actions.
    private _stateItem(record: PsxStateRecord, machine: PsxMachineInfo): HTMLElement {
        const item = this._document.createElement("article");
        item.className = "state-item";
        const summary = this._document.createElement("div");
        summary.className = "state-summary";
        const name = this._document.createElement("strong");
        name.textContent = record.name;
        const metadata = this._document.createElement("span");
        const compatible = stateCompatible(record, machine);
        metadata.textContent = `${new Date(record.metadata.createdAt).toLocaleString()} · Disc ${record.metadata.discIndex + 1} · ${compatible ? "Ready" : "Different core build"}`;
        const quick = this._document.createElement("div");
        quick.className = "state-quick-slots";
        for (const slot of [1, 2] as const) {
            const assign = button(this._document, `Q${slot}`);
            assign.setAttribute("aria-label", `Use “${record.name}” as Quick State ${slot}`);
            assign.setAttribute("aria-pressed", String(this._quickStateNameFor(machine.gameId, slot) === record.name));
            assign.disabled = !compatible || this._busyDialog === "game";
            assign.addEventListener("click", () => {
                this._assignQuickState(machine.gameId, slot, record.name);
                const session = this._player?.session;
                if (session !== null && session !== undefined) this._renderActiveGame(session);
                const message = `“${record.name}” assigned to Quick State ${slot}.`;
                this._panelFeedback("state-feedback", message, "success");
                this._showNotice(message);
                this._presentation.sync();
            });
            quick.append(assign);
        }
        summary.append(name, metadata, quick);
        const actions = this._document.createElement("div");
        actions.className = "state-actions";
        const load = button(this._document, "Load");
        load.disabled = !compatible || this._busyDialog === "game";
        load.addEventListener("click", () => { void this._loadState(record); });
        const overwrite = button(this._document, "Overwrite");
        overwrite.disabled = this._busyDialog === "game";
        overwrite.addEventListener("click", () => { void this._overwriteState(record); });
        const remove = button(this._document, "Delete");
        remove.className = "danger-action";
        remove.disabled = this._busyDialog === "game";
        remove.addEventListener("click", () => { void this._deleteState(record); });
        actions.append(load, overwrite, remove);
        item.append(summary, actions);
        return item;
    }

    // METHOD :: STRING, STRING, uiFeedbackState -> VOID
    // Updates one Game session feedback surface and its visual severity.
    private _panelFeedback(
        id: "active-game-feedback" | "controller-type-feedback" | "state-feedback",
        message: string,
        state: UiFeedbackState,
    ): void {
        const feedback = element<HTMLElement>(this._document, id);
        feedback.textContent = message;
        feedback.dataset.state = state;
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Reloads the persistent library and retains a valid details selection.
    private async _refreshLibrary(): Promise<void> {
        this._games = await this._gameStore.list();
        if (this._selectedLibraryGameId === null
            || !this._games.some(({ gameId }) => gameId === this._selectedLibraryGameId)) {
            this._selectedLibraryGameId = this._games[0]?.gameId ?? null;
            this._selectedLibraryDiscIndex = 0;
        }
        this._renderLibrary();
        this._renderTelemetry();
        this._presentation.sync();
        if (this._player?.session !== null && this._player?.session !== undefined) {
            this._setText("runtime-status", this._runtimeLabel(this._player.status));
        }
    }

    // METHOD :: VOID -> VOID
    // Renders stored games, total storage, and the selected game's supported actions.
    private _renderLibrary(): void {
        const list = element<HTMLElement>(this._document, "library-list");
        this._setText("library-count", `${String(this._games.length).padStart(2, "0")} TITLES`);
        list.replaceChildren(...this._games.map((game) => {
            const item = this._document.createElement("button");
            item.type = "button";
            item.className = "library-item";
            item.setAttribute("role", "option");
            item.setAttribute("aria-selected", String(game.gameId === this._selectedLibraryGameId));
            const title = this._document.createElement("strong");
            title.textContent = game.displayTitle;
            const discs = this._document.createElement("span");
            discs.textContent = `${game.discCount} DISC${game.discCount === 1 ? "" : "S"}`;
            const size = this._document.createElement("span");
            size.textContent = formatBytes(game.totalBytes);
            item.append(title, discs, size);
            item.addEventListener("click", () => {
                this._selectedLibraryGameId = game.gameId;
                this._selectedLibraryDiscIndex = 0;
                this._renderLibrary();
            });
            return item;
        }));
        const detail = element<HTMLElement>(this._document, "library-detail");
        const game = this._games.find(({ gameId }) => gameId === this._selectedLibraryGameId);
        if (game === undefined) {
            const placeholder = this._document.createElement("div");
            placeholder.className = "library-placeholder";
            placeholder.textContent = "[ NO STORED GAMES ]";
            detail.replaceChildren(placeholder);
            return;
        }
        detail.replaceChildren(this._gameDetail(game));
    }

    // METHOD :: psxStoredGame -> HTMLElement
    // Builds safe Library details and binds launch, rename, and removal actions.
    private _gameDetail(game: PsxStoredGame): HTMLElement {
        const wrapper = this._document.createElement("div");
        wrapper.className = "game-detail";
        const eyebrow = this._document.createElement("p");
        eyebrow.className = "eyebrow";
        eyebrow.textContent = "// STORED GAME";
        const title = this._document.createElement("h3");
        title.textContent = game.displayTitle;
        const metrics = this._document.createElement("div");
        metrics.className = "game-metrics";
        metrics.append(
            metric(this._document, String(game.discCount), "DISCS"),
            metric(this._document, String(game.fileCount), "FILES"),
            metric(this._document, formatBytes(game.totalBytes), "STORED"),
        );
        const discLabel = this._document.createElement("label");
        discLabel.textContent = "Disc to start or insert";
        const discSelect = this._document.createElement("select");
        for (let index = 0; index < game.discCount; index++) {
            discSelect.append(option(this._document, String(index), `Disc ${index + 1}`));
        }
        discSelect.value = String(Math.min(this._selectedLibraryDiscIndex, game.discCount - 1));
        discSelect.addEventListener("change", () => {
            this._selectedLibraryDiscIndex = Number(discSelect.value);
            this._renderLibrary();
        });
        discLabel.append(discSelect);
        const actions = this._document.createElement("div");
        actions.className = "game-detail-actions";
        const start = button(this._document, this._libraryStartLabel(game));
        start.className = "primary-action";
        start.addEventListener("click", () => { void this._launchLibrarySelection(game); });
        const rename = button(this._document, "Rename");
        rename.addEventListener("click", () => { void this._renameGame(game); });
        const remove = button(this._document, "Remove");
        remove.className = "danger-action";
        remove.addEventListener("click", () => { void this._deleteGame(game); });
        actions.append(start, rename, remove);
        wrapper.append(eyebrow, title, metrics, discLabel, actions);
        return wrapper;
    }

    // METHOD :: psxStoredGame -> STRING
    // Describes whether Library will start, restart, or insert the selected disc.
    private _libraryStartLabel(game: PsxStoredGame): string {
        const session = this._player?.session;
        if (session?.machine.gameId !== game.gameId) return session === null || session === undefined ? "Start" : "Switch Game";
        return session.discIndex === this._selectedLibraryDiscIndex ? "Restart" : "Change Disc";
    }

    // METHOD :: psxStoredGame -> PROMISE(VOID)
    // Starts a selected library game or performs an in-session disc insertion for the active game.
    private async _launchLibrarySelection(game: PsxStoredGame): Promise<void> {
        this._libraryFeedback(`${this._libraryStartLabel(game)} “${game.displayTitle}”…`, "working");
        try {
            const player = this._player;
            const session = player?.session;
            if (player !== null && player !== undefined && session?.machine.gameId === game.gameId
                && session.discIndex !== this._selectedLibraryDiscIndex) {
                await player.setDisc(this._selectedLibraryDiscIndex);
                this._setText("runtime-status", this._runtimeLabel(player.status));
                if (this._resumeAfterDialog && player.status === "paused") {
                    this._resumeAfterDialog = false;
                    player.resume();
                }
                this._showNotice(`Disc ${this._selectedLibraryDiscIndex + 1} inserted.`);
            } else {
                await this._startStoredGame(game.gameId, this._selectedLibraryDiscIndex);
            }
            element<HTMLDialogElement>(this._document, "library-dialog").close();
        } catch (error) {
            this._libraryFeedback(`Start failed: ${errorMessage(error)}`, "error");
        }
    }

    // METHOD :: STRING, NUMBER -> PROMISE(VOID)
    // Starts one stored game with the selected stored firmware and supported controller defaults.
    private async _startStoredGame(gameId: string, discIndex: number): Promise<void> {
        const runtime = this._runtime;
        const bios = this._selectedFirmware();
        if (runtime === null) throw new Error("The PlayStation runtime is unavailable.");
        if (bios === null) throw new Error("Check and store firmware before starting a game.");
        await runtime.startStored(gameId, {
            bios,
            initialDiscIndex: discIndex,
            controllers: this._controllerTypesForGame(gameId),
        });
        if (this._player !== null) this._player.display.scaling = this._selectedScaling;
        this._muted = false;
        const audio = this._sessionAudio();
        if (audio !== null) {
            audio.volume = this._selectedVolume();
            await audio.unlock().catch(() => undefined);
        }
        this._presentation.sync();
        this._showNotice(`Session started on disc ${discIndex + 1}.`);
    }

    // METHOD :: psxStoredGame -> PROMISE(VOID)
    // Renames one stored game using explicit user input without changing its content identity.
    private async _renameGame(game: PsxStoredGame): Promise<void> {
        const title = globalThis.prompt("Game title", game.displayTitle)?.trim();
        if (title === undefined || title.length === 0 || title === game.displayTitle) return;
        try {
            await this._gameStore.renameDisplayTitle(game.gameId, title);
            await this._refreshLibrary();
            this._showNotice(`Renamed game to “${title}”.`);
        } catch (error) {
            this._showNotice(`Rename failed: ${errorMessage(error)}`);
        }
    }

    // METHOD :: psxStoredGame -> PROMISE(VOID)
    // Removes one stored game only after an explicit destructive-action confirmation.
    private async _deleteGame(game: PsxStoredGame): Promise<void> {
        if (!globalThis.confirm(`Remove “${game.displayTitle}” from this browser?`)) return;
        try {
            if (this._player?.session?.machine.gameId === game.gameId) await this._runtime?.stop();
            await this._gameStore.delete(game.gameId);
            await this._refreshLibrary();
            this._showNotice(`Removed “${game.displayTitle}”.`);
        } catch (error) {
            this._showNotice(`Removal failed: ${errorMessage(error)}`);
        }
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Pauses or resumes the active session from the top command bar.
    private async _togglePause(): Promise<void> {
        try {
            if (this._player?.status === "paused") this._player.resume();
            else if (this._player?.status === "running") await this._player.pause();
        } catch (error) {
            this._showNotice(errorMessage(error));
        }
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Performs one supported soft reset and resumes when reset was requested from pause.
    private async _resetSession(): Promise<void> {
        const player = this._player;
        if (player === null) return;
        const resumeAfterReset = player.status === "paused";
        try {
            await player.reset("soft");
            if (resumeAfterReset && player.status === "paused") player.resume();
            this._showNotice("Session reset.");
        } catch (error) {
            this._showNotice(`Reset failed: ${errorMessage(error)}`);
        }
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Toggles active-session audio without changing its configured volume.
    private async _toggleMute(): Promise<void> {
        const audio = this._sessionAudio();
        if (audio === null) return;
        try {
            this._muted = !this._muted;
            if (this._muted) audio.mute();
            else {
                audio.unmute();
                await audio.unlock();
            }
            element<HTMLButtonElement>(this._document, "mute-session").textContent = this._muted ? "Unmute" : "Mute";
            this._showNotice(this._muted ? "Audio muted." : "Audio unmuted.");
            this._presentation.sync();
        } catch (error) {
            this._showNotice(`Audio change failed: ${errorMessage(error)}`);
        }
    }

    // METHOD :: VOID -> uiPresentationSnapshot
    // Builds the immutable runtime and library view consumed by TV mode.
    private _presentationSnapshot(): UiPresentationSnapshot {
        const session = this._player?.session;
        const active = session === null || session === undefined ? null : {
            gameId: session.machine.gameId,
            title: this._games.find(({ gameId }) => gameId === session.machine.gameId)?.displayTitle ?? "Current game",
            discIndex: session.discIndex,
            discCount: session.machine.discCount,
        };
        return {
            firmwareReady: this._hasSelectedFirmware(),
            scaling: this._selectedScaling,
            games: this._games.map(({ gameId, displayTitle, discCount, totalBytes }) => ({
                gameId, title: displayTitle, discCount, totalBytes,
            })),
            session: active,
        };
    }

    // METHOD :: VOID -> PROMISE(BOOLEAN)
    // Pauses a running game for the Presentation menu and reports whether the menu owns that pause.
    private async _pauseForPresentation(): Promise<boolean> {
        const player = this._player;
        const ownedPause = player?.status === "running";
        if (ownedPause) await player.pause();
        return ownedPause;
    }

    // METHOD :: BOOLEAN -> VOID
    // Resumes only a pause taken by the Presentation menu itself.
    private _resumeFromPresentation(ownedPause: boolean): void {
        if (ownedPause && this._player?.status === "paused") this._player.resume();
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Requests fullscreen on the complete play stage and locks landscape when the browser permits it.
    private async _enterPresentationFullscreen(): Promise<void> {
        const display = this._player?.display;
        if (display?.fullscreen === undefined) throw new Error("Fullscreen is unavailable in this browser.");
        await display.fullscreen();
        const orientation = browserWindow(this._document).screen.orientation as ScreenOrientation & {
            lock?: (orientation: string) => Promise<void>;
        };
        if (typeof orientation.lock === "function") {
            try { await orientation.lock("landscape"); } catch { /* Fullscreen remains useful when locking is refused. */ }
        }
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Leaves root fullscreen and releases a Presentation orientation lock.
    private async _leavePresentationFullscreen(): Promise<void> {
        const display = this._player?.display;
        if (display?.isFullscreen === true && display.exitFullscreen !== undefined) await display.exitFullscreen();
        try { browserWindow(this._document).screen.orientation.unlock?.(); }
        catch { /* Some browsers expose orientation without allowing programmatic unlock. */ }
        this._syncTouchController();
    }

    // METHOD :: NUMBER -> PROMISE(VOID)
    // Inserts one valid disc while preserving the active Presentation session.
    private async _changePresentationDisc(discIndex: number): Promise<void> {
        const player = this._player;
        const session = player?.session;
        if (player === null || session === null || session === undefined) throw new Error("Start a game before changing discs.");
        if (!Number.isInteger(discIndex) || discIndex < 0 || discIndex >= session.machine.discCount) {
            throw new Error("The selected disc is unavailable.");
        }
        if (discIndex === session.discIndex) return;
        await player.setDisc(discIndex);
        this._selectedLibraryDiscIndex = discIndex;
        this._presentation.sync();
    }

    // METHOD :: psxScalingMode -> VOID
    // Applies one Presentation selector value to the live display.
    private _setPresentationScaling(scaling: PsxScalingMode): void {
        this._selectedScaling = scaling;
        if (this._player !== null) this._player.display.scaling = scaling;
        element<HTMLSelectElement>(this._document, "scaling-mode").value = scaling;
        this._presentation.sync();
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Stops the active session while preserving stored firmware, games, and cards.
    private async _stopSession(): Promise<void> {
        if (!globalThis.confirm(
            "Stop the current session? Progress since the last in-game save or save state will be lost.",
        )) return;
        try {
            await this._runtime?.stop();
            this._resumeAfterDialog = false;
            this._showNotice("Session stopped.");
        } catch (error) {
            this._showNotice(`Stop failed: ${errorMessage(error)}`);
        }
    }

    // METHOD :: VOID -> VOID
    // Restores the View form from applied runtime and controller preferences before each opening.
    private _resetViewForm(): void {
        element<HTMLSelectElement>(this._document, "scaling-mode").value = this._selectedScaling;
        element<HTMLInputElement>(this._document, "touch-controller-visible").checked = this._touchControllerVisible;
        this._syncViewActions();
    }

    // METHOD :: VOID -> VOID
    // Enables Apply only when the selected presentation can be entered in the current lifecycle state.
    private _syncViewActions(): void {
        const rawMode = element<HTMLSelectElement>(this._document, "scaling-mode").value;
        const fullscreen = rawMode === "fullscreen-fit" || rawMode === "fullscreen-stretch";
        const sessionActive = this._player?.status === "running" || this._player?.status === "paused";
        element<HTMLButtonElement>(this._document, "apply-view").disabled = fullscreen && !sessionActive;
        this._viewFeedback(fullscreen && !sessionActive
            ? "Start a game before applying a fullscreen presentation."
            : null);
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Applies the deferred scaling, fullscreen, and on-screen-controller selections as one View action.
    private async _applyView(): Promise<void> {
        const rawMode = element<HTMLSelectElement>(this._document, "scaling-mode").value;
        if (!isUiViewMode(rawMode)) {
            this._viewFeedback("The selected view mode is unsupported.");
            return;
        }
        const fullscreenScaling = fullscreenScalingFor(rawMode);
        const runtimeScaling = runtimeScalingFor(rawMode);
        if (fullscreenScaling !== null && !await this._enterFullscreen(fullscreenScaling)) return;
        this._selectedScaling = runtimeScaling;
        if (fullscreenScaling === null && this._player !== null) this._player.display.scaling = runtimeScaling;
        this._touchControllerVisible = element<HTMLInputElement>(
            this._document,
            "touch-controller-visible",
        ).checked;
        storeBoolean(
            browserStorage(this._document),
            TOUCH_CONTROLLER_STORAGE_KEY,
            this._touchControllerVisible,
        );
        this._syncTouchController();
        element<HTMLDialogElement>(this._document, "view-dialog").close();
        this._showNotice(
            `View applied: ${fullscreenScaling === null ? "" : "Fullscreen · "}${displayScaling(runtimeScaling)}.`,
        );
    }

    // METHOD :: psxScalingMode -> PROMISE(BOOLEAN)
    // Applies one supported scaling mode and requests fullscreen presentation.
    private async _enterFullscreen(scaling: PsxScalingMode): Promise<boolean> {
        const display = this._player?.display;
        if (display?.fullscreen === undefined) return false;
        try {
            display.scaling = scaling;
            await display.fullscreen();
            return true;
        } catch (error) {
            this._viewFeedback(`Fullscreen failed: ${errorMessage(error)}`);
            return false;
        }
    }

    // METHOD :: STRING? -> VOID
    // Shows View feedback only when an actionable issue needs to remain in the modal.
    private _viewFeedback(message: string | null): void {
        const feedback = element<HTMLElement>(this._document, "view-feedback");
        feedback.textContent = message ?? "";
        feedback.hidden = message === null;
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Refreshes the two current card summaries and download availability.
    private async _refreshMemoryCards(): Promise<void> {
        for (const port of [1, 2] as const) {
            try {
                const record = await this._storage.loadMemoryCard(PROFILE_ID, CARD_IDS[port]);
                const active = this._player?.session !== null && this._player?.session !== undefined;
                const bytes = active
                    ? await this._player!.downloadMemoryCard(port).catch(() => record?.bytes ?? null)
                    : record?.bytes ?? null;
                if (bytes === null) {
                    this._setText(`card-status-${port}`, "No stored card yet; one is created when a game starts.");
                    this._renderMemoryCardSummary(port, null);
                } else {
                    const summary = summarizeMemoryCard(bytes);
                    const revision = record === null ? "" : ` · revision ${record.revision}`;
                    this._setText(`card-status-${port}`, summary.valid
                        ? `${summary.saves.length} save${summary.saves.length === 1 ? "" : "s"} · ${summary.usedBlocks}/15 blocks used${revision}`
                        : `Unrecognized card directory · ${formatBytes(bytes.byteLength)}${revision}`);
                    this._renderMemoryCardSummary(port, summary);
                }
                element<HTMLButtonElement>(this._document, `download-card-${port}`).disabled = record === null && !active;
            } catch (error) {
                this._setText(`card-status-${port}`, `Storage error: ${errorMessage(error)}`);
                this._renderMemoryCardSummary(port, null);
                element<HTMLButtonElement>(this._document, `download-card-${port}`).disabled = true;
            }
        }
        this._syncMemoryCardImportActions();
    }

    // METHOD :: controllerPort, psxMemoryCardSummary? -> VOID
    // Renders recognized saves, identifiers, and block counts without exposing or changing card bytes.
    private _renderMemoryCardSummary(port: ControllerPort, summary: PsxMemoryCardSummary | null): void {
        const list = element<HTMLUListElement>(this._document, `card-saves-${port}`);
        list.replaceChildren();
        if (summary === null) {
            list.hidden = true;
            return;
        }
        if (!summary.valid || summary.saves.length === 0) {
            const item = this._document.createElement("li");
            item.className = "card-empty";
            item.textContent = summary.valid ? "[ EMPTY CARD ]" : "[ UNRECOGNIZED DIRECTORY ]";
            list.append(item);
            list.hidden = false;
            return;
        }
        for (const save of summary.saves) {
            const item = this._document.createElement("li");
            const title = this._document.createElement("strong");
            title.textContent = save.title;
            const detail = this._document.createElement("span");
            detail.textContent = `${save.filename || "No internal filename"} · ${save.blocks} block${save.blocks === 1 ? "" : "s"}`;
            item.append(title, detail);
            list.append(item);
        }
        list.hidden = false;
    }

    // METHOD :: VOID -> VOID
    // Clears transient Memory Cards input and feedback while preserving current card summaries.
    private _resetMemoryCardView(): void {
        if (this._memoryImportBusy) return;
        element<HTMLInputElement>(this._document, "memory-card-file").value = "";
        this._syncMemoryCardImportActions();
        this._feedback(
            "memory",
            "Select a 128 KiB card image to import, or download an existing card.",
            "idle",
        );
    }

    // METHOD :: VOID -> VOID
    // Enables card import targets only for one valid image while the player is idle.
    private _syncMemoryCardImportActions(): void {
        const file = element<HTMLInputElement>(this._document, "memory-card-file").files?.[0];
        const enabled = file !== undefined && file.size === 128 * 1024
            && this._player?.status === "idle" && !this._memoryImportBusy;
        for (const port of [1, 2] as const) {
            element<HTMLButtonElement>(this._document, `import-card-${port}`).disabled = !enabled;
        }
    }

    // METHOD :: controllerPort -> PROMISE(VOID)
    // Confirms and imports one exact PlayStation card image into browser storage.
    private async _importMemoryCard(port: ControllerPort): Promise<void> {
        const player = this._player;
        const file = element<HTMLInputElement>(this._document, "memory-card-file").files?.[0];
        if (player === null || file === undefined) return;
        if (file.size !== 128 * 1024) {
            this._feedback("memory", "Memory card images must contain exactly 128 KiB.", "error");
            return;
        }
        if (player.status !== "idle") {
            this._feedback("memory", "Stop the current session before importing a memory card.", "error");
            return;
        }
        if (!globalThis.confirm(`Replace Card ${port} with “${file.name}”?`)) return;
        await this._withBusyDialog("memory", async () => {
            this._memoryImportBusy = true;
            this._syncMemoryCardImportActions();
            this._feedback("memory", `Importing “${file.name}” to Card ${port}…`, "working");
            try {
                await player.replaceMemoryCard(port, new Uint8Array(await file.arrayBuffer()));
                await this._refreshMemoryCards();
                const message = `Imported “${file.name}” to Card ${port} and stored it in this browser.`;
                this._feedback("memory", message, "success");
                this._showNotice(message);
            } catch (error) {
                this._feedback("memory", `Card import failed: ${errorMessage(error)}`, "error");
            } finally {
                this._memoryImportBusy = false;
                this._syncMemoryCardImportActions();
            }
        });
    }

    // METHOD :: controllerPort -> PROMISE(VOID)
    // Downloads a defensive copy of one active or persisted memory card.
    private async _downloadMemoryCard(port: ControllerPort): Promise<void> {
        if (this._player === null) return;
        this._feedback("memory", `Preparing card ${port}…`, "working");
        try {
            const bytes = await this._player.downloadMemoryCard(port);
            const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
            download(this._document, new Blob([copy]), `card-${port}.mcd`);
            this._feedback("memory", `Downloaded card ${port} (${formatBytes(bytes.byteLength)}).`, "success");
        } catch (error) {
            this._feedback("memory", `Card download failed: ${errorMessage(error)}`, "error");
        }
    }

    // METHOD :: VOID -> VOID
    // Reflects the persisted View preference and current player input on the player-one touch surface.
    private _syncTouchController(): void {
        const root = element<HTMLElement>(this._document, "touch-controller");
        const playStage = element<HTMLElement>(this._document, "play-stage");
        const controllerType = this._player?.session?.machine.controllers[1] ?? "dualshock";
        this._touchController.attach(this._player?.input ?? null);
        if (this._touchController.controllerType !== controllerType) {
            this._touchController.controllerType = controllerType;
        }
        root.hidden = !this._touchControllerVisible;
        playStage.dataset.touchVisible = String(this._touchControllerVisible);
        this._touchController.enabled = this._touchControllerVisible
            && !this._presentation.active
            && this._player?.status === "running"
            && controllerType !== "none";
    }

    // METHOD :: uiDialogId, (VOID -> PROMISE(VOID)) -> PROMISE(VOID)
    // Prevents one dialog from being dismissed until its mutation has settled.
    private async _withBusyDialog(dialogId: UiDialogId, operation: () => Promise<void>): Promise<void> {
        this._busyDialog = dialogId;
        const dialog = element<HTMLDialogElement>(this._document, `${dialogId}-dialog`);
        const close = dialog.querySelector<HTMLButtonElement>("button[value='cancel']");
        if (close !== null) close.disabled = true;
        try {
            await operation();
        } finally {
            this._busyDialog = null;
            if (close !== null) close.disabled = false;
        }
    }

    // METHOD :: VOID -> psxRegion
    // Returns the System region selection, whose options are closed by the document contract.
    private _selectedRegion(): PsxRegion {
        return element<HTMLSelectElement>(this._document, "firmware-region").value as PsxRegion;
    }

    // METHOD :: VOID -> BOOLEAN
    // True while the empty-system stage can accept one user-supplied firmware drop.
    private _acceptsFirmwareDrop(): boolean {
        return !this._firmwareBusy
            && element<HTMLElement>(this._document, "ui-app").dataset.stage === "firmware-required";
    }

    // METHOD :: VOID -> BOOLEAN
    // True while the central stage can accept firmware or game content for its current state.
    private _acceptsStageDrop(): boolean {
        const state = element<HTMLElement>(this._document, "ui-app").dataset.stage;
        return this._acceptsFirmwareDrop() || state === "ready";
    }

    // METHOD :: VOID -> biosImage?
    // Returns selected-region firmware or the first available regional record.
    private _selectedFirmware(): BiosImage | null {
        return this._firmware.get(this._selectedRegion()) ?? null;
    }

    // METHOD :: VOID -> BOOLEAN
    // True when the currently selected region has a validated stored firmware record.
    private _hasSelectedFirmware(): boolean {
        return this._firmware.has(this._selectedRegion());
    }

    // METHOD :: VOID -> psxAudio?
    // Narrows the concrete audio object created by the default runtime composition.
    private _sessionAudio(): PsxAudio | null {
        return this._player?.audio instanceof PsxAudio ? this._player.audio : null;
    }

    // METHOD :: VOID -> NUMBER
    // Returns the production Volume slider as a normalized Web Audio gain.
    private _selectedVolume(): number {
        return Number(element<HTMLInputElement>(this._document, "volume-level").value) / 100;
    }

    // METHOD :: uiStageState -> STRING
    // Produces a lifecycle label that identifies the active stored game and mounted disc.
    private _runtimeLabel(state: UiStageState): string {
        if (state === "running" || state === "paused" || state === "failed") {
            const session = this._player?.session;
            if (session !== null && session !== undefined) {
                const title = this._games.find(({ gameId }) => gameId === session.machine.gameId)?.displayTitle
                    ?? "Stored game";
                const lifecycle = state === "running" ? "Playing" : state === "paused" ? "Paused" : "Failed";
                return `${lifecycle} · ${title} · Disc ${session.discIndex + 1}/${session.machine.discCount}`;
            }
        }
        return runtimeLabel(state);
    }

    // METHOD :: STRING, STRING, uiFeedbackState -> VOID
    // Updates one operation-feedback region and its visual severity.
    private _feedback(name: "firmware" | "game" | "memory", message: string, state: UiFeedbackState): void {
        const feedback = element<HTMLElement>(this._document, `${name}-feedback`);
        feedback.textContent = message;
        feedback.dataset.state = state;
    }

    // METHOD :: STRING?, uiFeedbackState? -> VOID
    // Updates or clears the Library operation-feedback region.
    private _libraryFeedback(message: string | null, state: UiFeedbackState = "idle"): void {
        const feedback = element<HTMLElement>(this._document, "library-feedback");
        feedback.textContent = message ?? "";
        feedback.dataset.state = state;
        feedback.hidden = message === null;
    }

    // METHOD :: VOID -> VOID
    // Updates compact firmware and game-library telemetry.
    private _renderTelemetry(): void {
        this._setText("firmware-telemetry", `FIRMWARE // ${this._firmware.size === 0 ? "REQUIRED" : `${this._firmware.size} STORED`}`);
        this._setText("library-telemetry", `LIBRARY // ${this._games.length} TITLE${this._games.length === 1 ? "" : "S"} · ${formatBytes(this._games.reduce((total, game) => total + game.totalBytes, 0))}`);
    }

    // METHOD :: STRING -> VOID
    // Displays a short non-modal status notification over the stage.
    private _showNotice(message: string): void {
        const notice = element<HTMLElement>(this._document, "screen-notice");
        notice.textContent = message;
        notice.hidden = false;
        if (this._noticeTimer !== null) globalThis.clearTimeout(this._noticeTimer);
        this._noticeTimer = globalThis.setTimeout(() => {
            notice.hidden = true;
            this._noticeTimer = null;
        }, 3200);
    }

    // METHOD :: STRING, STRING -> VOID
    // Writes text to one required production element.
    private _setText(id: string, value: string): void {
        element<HTMLElement>(this._document, id).textContent = value;
    }
}

/**
 *
 *  Helper Functions
 *
 */

// HELPER :: DOCUMENT, STRING -> T
// Returns one required production element or fails fast when the document contract is incomplete.
const element = <T extends HTMLElement>(document: Document, id: string): T => {
    const value = document.getElementById(id);
    if (value === null) throw new Error(`Missing production UI element: ${id}`);
    return value as T;
};

// HELPER :: storage?, STRING -> BOOLEAN
// Reads one opt-in browser preference and defaults safely when storage is unavailable.
const storedBoolean = (storage: Storage | null, key: string): boolean => {
    try { return storage?.getItem(key) === "true"; } catch { return false; }
};

// HELPER :: storage?, STRING, BOOLEAN -> VOID
// Persists one browser preference without making unavailable storage fatal to the UI.
const storeBoolean = (storage: Storage | null, key: string, value: boolean): void => {
    try { storage?.setItem(key, String(value)); } catch { /* Preferences are best effort. */ }
};

// HELPER :: DOCUMENT -> STORAGE?
// Returns browser-local storage without allowing privacy or origin restrictions to block startup.
const browserStorage = (document: Document): Storage | null => {
    try { return document.defaultView?.localStorage ?? null; } catch { return null; }
};

// HELPER :: DOCUMENT -> WINDOW
// Returns the owning browser window required by fullscreen orientation handling.
const browserWindow = (document: Document): Window => {
    if (document.defaultView === null) throw new Error("The production UI requires a browser Window.");
    return document.defaultView;
};

// HELPER :: STORAGE? -> uiControllerTypePreferences
// Loads validated per-game controller types or returns an empty versioned preference set.
const loadControllerTypePreferences = (storage: Storage | null): UiControllerTypePreferences => {
    try {
        const source = storage?.getItem(CONTROLLER_TYPE_STORAGE_KEY);
        if (source === null || source === undefined) return { version: 1, games: {} };
        const value: unknown = JSON.parse(source);
        return isUiControllerTypePreferences(value) ? value : { version: 1, games: {} };
    } catch {
        return { version: 1, games: {} };
    }
};

// HELPER :: STORAGE?, uiControllerTypePreferences -> VOID
// Persists per-game emulated controller types without making storage availability fatal.
const persistControllerTypePreferences = (
    storage: Storage | null,
    preferences: UiControllerTypePreferences,
): void => {
    try { storage?.setItem(CONTROLLER_TYPE_STORAGE_KEY, JSON.stringify(preferences)); } catch { /* Best effort. */ }
};

// HELPER :: STORAGE? -> uiQuickStatePreferences
// Loads validated quick-slot assignments shared by the production interface and harness.
const loadQuickStatePreferences = (storage: Storage | null): UiQuickStatePreferences => {
    try {
        const source = storage?.getItem(QUICK_STATE_STORAGE_KEY);
        if (source === null || source === undefined) return { version: 1, games: {} };
        const value: unknown = JSON.parse(source);
        return isUiQuickStatePreferences(value) ? value : { version: 1, games: {} };
    } catch {
        return { version: 1, games: {} };
    }
};

// HELPER :: STORAGE?, uiQuickStatePreferences -> VOID
// Persists quick-slot assignments without making browser storage availability fatal.
const persistQuickStatePreferences = (
    storage: Storage | null,
    preferences: UiQuickStatePreferences,
): void => {
    try { storage?.setItem(QUICK_STATE_STORAGE_KEY, JSON.stringify(preferences)); }
    catch { /* Assignments remain page-local when storage is unavailable. */ }
};

// HELPER :: FILE, psxRegion, [NUMBER] -> PROMISE(biosImage)
// Extracts a ZIP or validates one raw firmware image against core build metadata.
const firmwareImage = async (
    file: File,
    region: PsxRegion,
    supportedByteLengths: ReadonlyArray<number>,
): Promise<BiosImage> => {
    if (ZipFirmwareSource.isArchive(file)) {
        const extracted = await ZipFirmwareSource.extract(file, supportedByteLengths, region);
        return Object.freeze({ ...extracted, region });
    }
    if (!supportedByteLengths.includes(file.size)) {
        throw new Error("The firmware image has an unsupported byte length.");
    }
    return Object.freeze({ name: file.name, region, blob: file });
};

// HELPER :: uiStageState, STRING, NUMBER -> stagePresentation
// Maps one application state to the central stage's actionable copy.
const stagePresentation = (
    state: UiStageState,
    detail: string,
    gameCount: number,
): {
    readonly code: string;
    readonly title: string;
    readonly description: string;
    readonly primary: { readonly label: string; readonly dialog: UiDialogId } | null;
    readonly secondary: { readonly label: string; readonly dialog: UiDialogId } | null;
} => {
    if (state === "loading") return {
        code: "// BOOT", title: "[ INITIALIZING ]", description: "LOADING CORE METADATA AND BROWSER STORAGE",
        primary: null, secondary: null,
    };
    if (state === "firmware-required") return {
        code: "// SYSTEM REQUIRED", title: "[ FIRMWARE REQUIRED ]",
        description: "DROP USER-SUPPLIED PLAYSTATION FIRMWARE HERE OR OPEN SYSTEM",
        primary: { label: "Configure System", dialog: "system" }, secondary: null,
    };
    if (state === "ready" || state === "idle") return {
        code: "// READY", title: gameCount === 0 ? "[ IMPORT A GAME ]" : "[ SELECT A GAME ]",
        description: gameCount === 0 ? "ADD ONE OR MORE GAME ZIPS TO THE LOCAL LIBRARY" : "START A STORED TITLE OR IMPORT ANOTHER GAME",
        primary: { label: gameCount === 0 ? "Import Game" : "Browse Library", dialog: gameCount === 0 ? "game" : "library" },
        secondary: gameCount === 0 ? null : { label: "Import Game", dialog: "game" },
    };
    if (state === "starting") return {
        code: "// SESSION", title: "[ STARTING ]", description: "MOUNTING GAME CONTENT AND WAITING FOR THE FIRST FRAME",
        primary: null, secondary: null,
    };
    if (state === "stopping") return {
        code: "// SESSION", title: "[ STOPPING ]", description: "FLUSHING MEMORY CARDS AND RELEASING THE CORE",
        primary: null, secondary: null,
    };
    if (state === "failed") return {
        code: "// ERROR", title: "[ SESSION FAILED ]", description: detail.length === 0 ? "THE PLAYSTATION SESSION COULD NOT CONTINUE" : detail.toUpperCase(),
        primary: { label: "Browse Library", dialog: "library" }, secondary: { label: "System", dialog: "system" },
    };
    return { code: "// SESSION", title: "[ ACTIVE ]", description: "PLAYSTATION SESSION ACTIVE", primary: null, secondary: null };
};

// HELPER :: uiStageState -> STRING
// Produces the compact top-bar lifecycle label.
const runtimeLabel = (state: UiStageState): string => state === "firmware-required"
    ? "System required"
    : state === "ready" || state === "idle"
        ? "Ready"
        : state.charAt(0).toUpperCase() + state.slice(1);

// HELPER :: psxRegion -> STRING
// Formats one closed firmware region for user-facing status.
const regionLabel = (region: PsxRegion): string => ({
    "ntsc-u": "NTSC-U · United States",
    "ntsc-j": "NTSC-J · Japan",
    pal: "PAL · Europe",
})[region];

// HELPER :: NUMBER -> STRING
// Formats byte totals using a compact binary unit.
const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KiB", "MiB", "GiB"];
    let value = bytes / 1024;
    let unit = units[0]!;
    for (let index = 1; index < units.length && value >= 1024; index++) {
        value /= 1024;
        unit = units[index]!;
    }
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
};

// HELPER :: UNKNOWN -> STRING
// Normalizes caught failures into actionable UI copy.
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

// HELPER :: STRING -> STRING
// Derives an initial game title from one archive basename.
const titleFromArchive = (name: string): string => name
    .replace(/\.zip$/iu, "")
    .replace(/[\s._-]*(?:disc|disk|cd)[\s._-]*0?1$/iu, "")
    .trim() || "Imported Game";

// HELPER :: DOCUMENT, STRING, STRING -> htmlOptionElement
// Creates one safe select option without HTML string interpolation.
const option = (document: Document, value: string, label: string): HTMLOptionElement => {
    const item = document.createElement("option");
    item.value = value;
    item.textContent = label;
    return item;
};

// HELPER :: DOCUMENT, STRING, STRING -> htmlElement
// Creates one compact Library metric.
const metric = (document: Document, value: string, label: string): HTMLElement => {
    const item = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = value;
    const span = document.createElement("span");
    span.textContent = label;
    item.append(strong, span);
    return item;
};

// HELPER :: DOCUMENT, STRING -> htmlButtonElement
// Creates one non-submitting dialog action.
const button = (document: Document, label: string): HTMLButtonElement => {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = label;
    return item;
};

// HELPER :: DOCUMENT, BLOB, STRING -> VOID
// Starts one local Blob download and revokes its temporary URL.
const download = (document: Document, blob: Blob, name: string): void => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
};

// HELPER :: uiViewMode -> psxScalingMode?
// Returns the runtime scaling requested by a fullscreen View option, or null for a windowed option.
const fullscreenScalingFor = (mode: UiViewMode): PsxScalingMode | null => mode === "fullscreen-fit"
    ? "fit"
    : mode === "fullscreen-stretch" ? "stretch" : null;

// HELPER :: uiViewMode -> psxScalingMode
// Returns the runtime scaling carried by any windowed or fullscreen View option.
const runtimeScalingFor = (mode: UiViewMode): PsxScalingMode => mode === "fullscreen-fit"
    ? "fit"
    : mode === "fullscreen-stretch" ? "stretch" : mode;

// HELPER :: psxStateRecord, psxMachineInfo -> BOOLEAN
// True when one stored state matches the exact active content and deterministic core build.
const stateCompatible = (record: PsxStateRecord, machine: PsxMachineInfo): boolean =>
    record.metadata.gameId === machine.gameId
    && record.metadata.buildId === machine.buildId
    && record.metadata.core === machine.core
    && record.metadata.coreVersion === machine.coreVersion;

// HELPER :: psxScalingMode -> STRING
// Formats a supported scaling mode for View feedback.
const displayScaling = (scaling: PsxScalingMode): string => scaling.charAt(0).toUpperCase() + scaling.slice(1);
