// Dependencies:
import PresentationInput from "./PresentationInput.js"; // Routes controller, keyboard, and touch navigation into the TV menu

// Type dependencies:
import type { PsxScalingMode } from "../../src/index.js";
import type {
    UiPresentationFeedbackState,
    UiPresentationGame,
    UiPresentationModeConfig,
    UiPresentationSnapshot,
} from "./types.js";

const PRESENTATION_MODE_STORAGE_KEY = "psx-runtime:ui:presentation-mode";
const SCALING_MODES = Object.freeze(["fit", "integer", "fill", "stretch"] as const);

/**
 *
 * Class
 *
 */

// Owns the controller-first television skin while delegating all emulator operations to the application.
export default class PresentationMode {

    /* Instance Fields */
    private readonly _document: Document;                         // Production document containing both skins
    private readonly _storage: Storage | null;                    // Browser-local mode persistence
    private readonly _config: UiPresentationModeConfig;           // Runtime and library operations
    private readonly _input: PresentationInput;                   // Controller-first focus and menu gestures
    private _snapshot: UiPresentationSnapshot;                    // Latest immutable application view model
    private _active = false;                                      // Whether the TV skin replaces Play Mode
    private _menuOpen = false;                                    // Whether the TV menu covers the game
    private _pauseOwned = false;                                  // Whether opening the menu paused the current game
    private _busy = false;                                        // Whether one menu operation is unsettled
    private _loadingMessage: string | null = null;                 // Blocking startup or session-operation status
    private _discPickerGameId: string | null = null;              // Multi-disc title awaiting an explicit disc choice
    private _activeGameId: string | null = null;                  // Session identity used to reset disc selection
    private _hintShown = false;                                   // Session-local first-start hint guard
    private _hintTimer: ReturnType<typeof globalThis.setTimeout> | null = null; // Pending hint dismissal

    // CONSTRUCTOR :: uiPresentationModeConfig -> presentationMode
    // Retains application operations and composes the Presentation input layer.
    constructor(config: UiPresentationModeConfig) {
        this._document = config.document;
        this._storage = config.storage;
        this._config = config;
        this._snapshot = config.getSnapshot();
        this._active = storedPresentationMode(this._storage);
        this._input = new PresentationInput({
            document: this._document,
            root: element(this._document, "presentation-menu"),
            gestureTarget: element(this._document, "play-stage"),
            getGamepads: () => browserWindow(this._document).navigator.getGamepads(),
            scheduler: {
                request: (callback) => browserWindow(this._document).requestAnimationFrame(callback),
                cancel: (handle) => browserWindow(this._document).cancelAnimationFrame(handle),
                now: () => browserWindow(this._document).performance.now(),
            },
            onToggle: () => { void this.toggleMenu(); },
            onBack: () => { void this.back(); },
            onAdjust: (setting, step) => this.adjust(setting, step),
        });
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> BOOLEAN
    // Reports whether the application currently uses the television skin.
    get active(): boolean { return this._active; }

    // GETTER :: VOID -> BOOLEAN
    // Reports whether the Presentation menu currently owns navigation.
    get menuOpen(): boolean { return this._menuOpen; }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: VOID -> VOID
    // Binds every Presentation action and restores a persisted TV skin without forcing fullscreen.
    initialize(): void {
        element<HTMLButtonElement>(this._document, "presentation-resume").addEventListener("click", () => {
            void this.closeMenu(true);
        });
        element<HTMLButtonElement>(this._document, "presentation-reset").addEventListener("click", () => {
            void this._run("Resetting the session…", () => this._config.reset(), "Session reset.", true);
        });
        element<HTMLButtonElement>(this._document, "presentation-switch-disc").addEventListener("click", () => {
            const gameId = this._snapshot.session?.gameId;
            const game = this._snapshot.games.find((candidate) => candidate.gameId === gameId);
            if (game !== undefined && game.discCount > 1) this._openDiscPicker(game);
        });
        element<HTMLButtonElement>(this._document, "presentation-scaling").addEventListener("click", () => {
            this.adjust("scaling", 1);
        });
        element<HTMLButtonElement>(this._document, "presentation-play-mode").addEventListener("click", () => {
            void this.leave();
        });
        element<HTMLButtonElement>(this._document, "presentation-disc-cancel").addEventListener("click", () => {
            this._closeDiscPicker();
        });
        this._applyMode();
        this.sync();
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Enters the TV skin, persists it, and uses the current gesture for best-effort fullscreen.
    async enter(): Promise<void> {
        if (this._active) return;
        this._active = true;
        persistPresentationMode(this._storage, true);
        this._applyMode();
        this.sync();
        if (this._snapshot.session === null) await this.openMenu();
        else {
            this._menuOpen = false;
            this._input.menuOpen = false;
            this._render();
            this._showHint();
        }
        try { await this._config.enterFullscreen(); }
        catch (error) { this.feedback(`Fullscreen was unavailable: ${errorMessage(error)}`, "error"); }
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Returns to Play Mode without resuming a game paused beneath the TV menu.
    async leave(): Promise<void> {
        if (!this._active) return;
        this._active = false;
        this._menuOpen = false;
        this._discPickerGameId = null;
        this._pauseOwned = false;
        this._input.menuOpen = false;
        persistPresentationMode(this._storage, false);
        this._clearHint();
        this._applyMode();
        try { await this._config.leaveFullscreen(); }
        catch { /* The browser may already have left fullscreen through its own system gesture. */ }
    }

    // METHOD :: VOID -> VOID
    // Reloads runtime, library, and availability into the current TV view.
    sync(): void {
        const previousGameId = this._activeGameId;
        this._snapshot = this._config.getSnapshot();
        this._activeGameId = this._snapshot.session?.gameId ?? null;
        if (this._activeGameId !== previousGameId) {
            if (this._active && this._activeGameId !== null && !this._menuOpen) this._showHint();
        }
        if (this._discPickerGameId !== null
            && !this._snapshot.games.some(({ gameId }) => gameId === this._discPickerGameId)) {
            this._discPickerGameId = null;
        }
        if (this._active && this._snapshot.session === null && !this._menuOpen) {
            void this.openMenu();
            return;
        }
        this._render();
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Pauses a running game once and opens the focus-first Library menu.
    async openMenu(): Promise<void> {
        if (!this._active || this._menuOpen) return;
        this._menuOpen = true;
        try { this._pauseOwned = await this._config.pauseForMenu(); }
        catch (error) {
            this._menuOpen = false;
            this.feedback(`The Presentation menu could not pause the session: ${errorMessage(error)}`, "error");
            return;
        }
        this._snapshot = this._config.getSnapshot();
        this._clearHint();
        this._render();
        this._input.menuOpen = true;
    }

    // METHOD :: BOOLEAN? -> PROMISE(VOID)
    // Closes the menu; the explicit Resume action also releases a pre-existing pause.
    async closeMenu(forceResume = false): Promise<void> {
        if (!this._active || !this._menuOpen || this._snapshot.session === null) return;
        const ownedPause = this._pauseOwned;
        this._pauseOwned = false;
        this._menuOpen = false;
        this._discPickerGameId = null;
        this._input.menuOpen = false;
        await this._input.waitForActivationRelease();
        this._config.resumeFromMenu(forceResume || ownedPause);
        this._snapshot = this._config.getSnapshot();
        this._render();
        try { await this._config.enterFullscreen(); } catch { /* Resume remains valid without fullscreen. */ }
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Opens or closes the menu from L3 + R3, Escape, or a two-finger tap.
    async toggleMenu(): Promise<void> {
        if (!this._active || this._busy) return;
        if (this._menuOpen && this._discPickerGameId !== null) this._closeDiscPicker();
        else if (this._menuOpen) await this.closeMenu();
        else await this.openMenu();
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Closes disc selection first, then returns to the active game when one exists.
    async back(): Promise<void> {
        if (!this._active || !this._menuOpen || this._busy) return;
        if (this._discPickerGameId !== null) {
            this._closeDiscPicker();
        } else {
            await this.closeMenu();
        }
    }

    // METHOD :: STRING, -1|1 -> VOID
    // Changes controller-addressable selectors without opening native form controls.
    adjust(setting: string, step: -1 | 1): void {
        if (this._busy) return;
        if (setting === "scaling") {
            const index = SCALING_MODES.indexOf(this._snapshot.scaling);
            const scaling = SCALING_MODES[cycle(index < 0 ? 0 : index, step, SCALING_MODES.length)]!;
            this._config.setScaling(scaling);
            this._snapshot = this._config.getSnapshot();
            this.feedback("", "idle");
        }
        this._render();
    }

    // METHOD :: STRING, uiPresentationFeedbackState -> VOID
    // Renders one status message inside the Presentation window.
    feedback(message: string, state: UiPresentationFeedbackState): void {
        const feedback = element<HTMLElement>(this._document, "presentation-feedback");
        feedback.textContent = message;
        feedback.dataset.state = state;
        feedback.hidden = message.length === 0;
    }

    // METHOD :: VOID -> VOID
    // Releases browser listeners owned by the Presentation layer.
    destroy(): void {
        this._clearHint();
        this._input.destroy();
    }

    // METHOD :: uiPresentationGame -> VOID
    // Opens a controller-focused disc choice before launching one multi-disc title.
    private _openDiscPicker(game: UiPresentationGame): void {
        this._discPickerGameId = game.gameId;
        this._renderDiscPicker();
        this._input.focusFirst();
    }

    // METHOD :: VOID -> VOID
    // Returns from disc selection to the unchanged Library list.
    private _closeDiscPicker(): void {
        this._discPickerGameId = null;
        this._renderDiscPicker();
        this._input.focusFirst("content");
    }

    // METHOD :: NUMBER -> PROMISE(VOID)
    // Inserts the selected library disc for the active game without rebuilding the session.
    private async _changeDisc(discIndex: number): Promise<void> {
        const session = this._snapshot.session;
        if (session === null || discIndex === session.discIndex) {
            this.feedback(session === null ? "Start a game before changing discs." : "That disc is already active.", "idle");
            return;
        }
        await this._run(
            `Changing to Disc ${discIndex + 1}…`,
            () => this._config.changeDisc(discIndex),
            `Disc ${discIndex + 1} inserted.`,
            true,
        );
    }

    // METHOD :: uiPresentationGame, NUMBER -> PROMISE(VOID)
    // Starts, resumes, or changes disc as soon as one library title is activated.
    private async _playGame(game: UiPresentationGame, discIndex: number): Promise<void> {
        this._discPickerGameId = null;
        const session = this._snapshot.session;
        if (session?.gameId === game.gameId && session.discIndex === discIndex) {
            await this.closeMenu(true);
            return;
        }
        if (session?.gameId === game.gameId) {
            await this._changeDisc(discIndex);
            return;
        }
        await this._run(
            `Starting “${game.title}”…`,
            () => this._config.startGame(game.gameId, discIndex),
            `Started “${game.title}”.`,
            true,
        );
    }

    // METHOD :: STRING, (VOID -> PROMISE(VOID)), STRING, BOOLEAN? -> PROMISE(VOID)
    // Serializes a menu operation, retains failures in the overlay, and optionally returns to play.
    private async _run(
        working: string,
        operation: () => Promise<void>,
        success: string,
        closeAfter = false,
    ): Promise<void> {
        if (this._busy) return;
        this._busy = true;
        this._loadingMessage = working;
        this.feedback("", "idle");
        this._render();
        try {
            if (closeAfter) await this._input.waitForActivationRelease();
            await operation();
            this._snapshot = this._config.getSnapshot();
            this._loadingMessage = null;
            this.feedback(success, "success");
            if (closeAfter && this._snapshot.session !== null) {
                const ownedPause = this._pauseOwned;
                this._pauseOwned = false;
                this._menuOpen = false;
                this._discPickerGameId = null;
                this._input.menuOpen = false;
                this._config.resumeFromMenu(ownedPause);
                this._render();
                try { await this._config.enterFullscreen(); } catch { /* The session still starts without fullscreen. */ }
            }
        } catch (error) {
            this._loadingMessage = null;
            this._snapshot = this._config.getSnapshot();
            this.feedback(errorMessage(error), "error");
        } finally {
            this._busy = false;
            this._loadingMessage = null;
            this._snapshot = this._config.getSnapshot();
            this._render();
        }
    }

    // METHOD :: VOID -> VOID
    // Applies root mode attributes, menu visibility, and gamepad polling ownership.
    private _applyMode(): void {
        const app = element<HTMLElement>(this._document, "ui-app");
        app.dataset.mode = this._active ? "presentation" : "play";
        element<HTMLElement>(this._document, "presentation-menu").hidden = !this._active || !this._menuOpen;
        this._input.active = this._active;
        if (!this._active) this._input.menuOpen = false;
    }

    // METHOD :: VOID -> VOID
    // Renders current game actions, library rows, and TV mode visibility.
    private _render(): void {
        this._applyMode();
        const menu = element<HTMLElement>(this._document, "presentation-menu");
        menu.hidden = !this._active || !this._menuOpen;
        const session = this._snapshot.session;
        this._setText("presentation-header-status", session === null
            ? "No game loaded"
            : `${session.title} · Disc ${session.discIndex + 1} of ${session.discCount}`);
        const storedBytes = this._snapshot.games.reduce((total, game) => total + game.totalBytes, 0);
        this._setText(
            "presentation-library-count",
            `${this._snapshot.games.length} Title${this._snapshot.games.length === 1 ? "" : "s"} (${formatStorageSize(storedBytes)})`,
        );
        const resume = element<HTMLButtonElement>(this._document, "presentation-resume");
        resume.disabled = session === null || this._busy;
        this._renderSessionActions();
        this._renderLibrary();
        this._renderDiscPicker();
        this._renderLoading();
    }

    // METHOD :: VOID -> VOID
    // Renders values and availability for the left action column.
    private _renderSessionActions(): void {
        const session = this._snapshot.session;
        this._setText("presentation-scaling-value", scalingLabel(this._snapshot.scaling));
        this._setText("presentation-switch-disc-value", session === null || session.discCount < 2
            ? "No multi-disc game"
            : `Disc ${session.discIndex + 1} of ${session.discCount}`);
        element<HTMLButtonElement>(this._document, "presentation-reset").disabled = session === null || this._busy;
        element<HTMLButtonElement>(this._document, "presentation-switch-disc").disabled = session === null
            || session.discCount < 2 || this._busy;
        element<HTMLButtonElement>(this._document, "presentation-scaling").disabled = this._busy;
        element<HTMLButtonElement>(this._document, "presentation-play-mode").disabled = this._busy;
    }

    // METHOD :: VOID -> VOID
    // Builds one direct launch button for every stored game.
    private _renderLibrary(): void {
        const list = element<HTMLElement>(this._document, "presentation-game-list");
        list.replaceChildren(...this._snapshot.games.map((game) => {
            const row = this._document.createElement("div");
            row.className = "presentation-game-row";
            row.dataset.gameId = game.gameId;
            const play = this._document.createElement("button");
            play.type = "button";
            play.className = "presentation-game-play";
            play.dataset.presentationFocus = "";
            play.dataset.presentationColumn = "content";
            play.dataset.gameId = game.gameId;
            play.disabled = !this._snapshot.firmwareReady || this._busy;
            play.setAttribute("aria-current", String(this._snapshot.session?.gameId === game.gameId));
            const title = this._document.createElement("strong");
            title.textContent = game.title;
            const status = this._document.createElement("span");
            status.textContent = libraryActionLabel(game, this._snapshot);
            play.append(title, status);
            play.addEventListener("click", () => {
                if (game.discCount > 1) this._openDiscPicker(game);
                else void this._playGame(game, 0);
            });
            row.append(play);
            return row;
        }));
    }

    // METHOD :: VOID -> VOID
    // Builds the blocking multi-disc choice and removes background actions from navigation.
    private _renderDiscPicker(): void {
        const picker = element<HTMLElement>(this._document, "presentation-disc-picker");
        const columns = this._document.querySelector<HTMLElement>(".presentation-columns");
        const game = this._snapshot.games.find(({ gameId }) => gameId === this._discPickerGameId);
        picker.hidden = game === undefined;
        picker.inert = this._loadingMessage !== null;
        if (columns !== null) columns.inert = game !== undefined || this._loadingMessage !== null;
        const options = element<HTMLElement>(this._document, "presentation-disc-options");
        if (game === undefined) {
            options.replaceChildren();
            return;
        }
        this._setText("presentation-disc-picker-title", game.title);
        options.replaceChildren(...Array.from({ length: game.discCount }, (_, discIndex) => {
            const disc = this._document.createElement("button");
            disc.type = "button";
            disc.dataset.presentationFocus = "";
            disc.dataset.presentationColumn = "dialog";
            disc.textContent = `Disc ${discIndex + 1}`;
            if (this._snapshot.session?.gameId === game.gameId
                && this._snapshot.session.discIndex === discIndex) {
                disc.textContent += " · Current";
            }
            disc.addEventListener("click", () => { void this._playGame(game, discIndex); });
            return disc;
        }));
    }

    // METHOD :: VOID -> VOID
    // Covers the menu with the current startup or session-operation status.
    private _renderLoading(): void {
        const loading = element<HTMLElement>(this._document, "presentation-loading");
        loading.hidden = this._loadingMessage === null;
        if (this._loadingMessage !== null) {
            this._setText("presentation-loading-status", this._loadingMessage);
        }
    }

    // METHOD :: VOID -> VOID
    // Shows the menu gesture hint once after the first Presentation start in this page session.
    private _showHint(): void {
        if (this._hintShown || !this._active) return;
        this._hintShown = true;
        const hint = element<HTMLElement>(this._document, "presentation-hint");
        hint.hidden = false;
        if (this._hintTimer !== null) globalThis.clearTimeout(this._hintTimer);
        this._hintTimer = globalThis.setTimeout(() => this._clearHint(), 3_100);
    }

    // METHOD :: VOID -> VOID
    // Hides the transient menu hint and clears its timer.
    private _clearHint(): void {
        element<HTMLElement>(this._document, "presentation-hint").hidden = true;
        if (this._hintTimer !== null) globalThis.clearTimeout(this._hintTimer);
        this._hintTimer = null;
    }

    // METHOD :: STRING, STRING -> VOID
    // Writes safe text into one required Presentation element.
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
// Resolves one required Presentation element or reports a broken document contract.
const element = <T extends HTMLElement>(document: Document, id: string): T => {
    const value = document.getElementById(id);
    if (value === null) throw new Error(`Missing Presentation element: ${id}`);
    return value as T;
};

// HELPER :: DOCUMENT -> WINDOW
// Returns the document's owning browser window.
const browserWindow = (document: Document): Window => {
    if (document.defaultView === null) throw new Error("Presentation mode requires a browser Window.");
    return document.defaultView;
};

// HELPER :: STORAGE? -> BOOLEAN
// Restores the persisted TV skin without making storage availability fatal.
const storedPresentationMode = (storage: Storage | null): boolean => {
    try { return storage?.getItem(PRESENTATION_MODE_STORAGE_KEY) === "presentation"; }
    catch { return false; }
};

// HELPER :: STORAGE?, BOOLEAN -> VOID
// Persists the selected application skin when browser storage is available.
const persistPresentationMode = (storage: Storage | null, active: boolean): void => {
    try { storage?.setItem(PRESENTATION_MODE_STORAGE_KEY, active ? "presentation" : "play"); }
    catch { /* Page-local mode remains usable. */ }
};

// HELPER :: NUMBER, -1|1, NUMBER -> NUMBER
// Wraps one zero-based controller selector within its available values.
const cycle = (index: number, step: -1 | 1, length: number): number =>
    length <= 0 ? 0 : (index + step + length) % length;

// HELPER :: psxScalingMode -> STRING
// Formats runtime scaling for television-distance copy.
const scalingLabel = (scaling: PsxScalingMode): string => scaling === "fit"
    ? "Fit"
    : scaling === "integer"
        ? "Integer"
        : scaling === "fill" ? "Fill" : "Stretch";

// HELPER :: NUMBER -> STRING
// Formats aggregate Library storage in compact decimal units for television distance.
const formatStorageSize = (bytes: number): string => {
    if (bytes <= 0) return "0 MB";
    if (bytes >= 1_000_000_000) return `${compactDecimal(bytes / 1_000_000_000)} GB`;
    if (bytes >= 1_000_000) return `${compactDecimal(bytes / 1_000_000)} MB`;
    if (bytes >= 1_000) return `${compactDecimal(bytes / 1_000)} KB`;
    return `${bytes} B`;
};

// HELPER :: NUMBER -> STRING
// Retains at most one useful decimal place without displaying a trailing zero.
const compactDecimal = (value: number): string => String(Number(value.toFixed(1)));

// HELPER :: uiPresentationGame, uiPresentationSnapshot -> STRING
// Labels direct launch behavior while routing multi-disc titles through the picker.
const libraryActionLabel = (
    game: UiPresentationGame,
    snapshot: UiPresentationSnapshot,
): string => {
    const session = snapshot.session;
    if (session?.gameId === game.gameId) {
        return game.discCount > 1 ? `Playing · Disc ${session.discIndex + 1}` : "Resume";
    }
    if (game.discCount > 1) return "Choose Disc";
    return session === null ? "Play" : "Switch Game";
};

// HELPER :: UNKNOWN -> STRING
// Normalizes application and browser failures for Presentation feedback.
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
