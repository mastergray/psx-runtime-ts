// Dependencies:
import DiscSetAudit from "../DiscSetAudit/DiscSetAudit.js";              // Validates selected content before persistent import
import GamepadSource from "../GamepadSource/GamepadSource.js";          // Polls assigned browser gamepads into the active input
import KeyboardSource from "../KeyboardSource/KeyboardSource.js";      // Maps keyboard events into the active input
import MultiZipDiscSource from "../MultiZipDiscSource/MultiZipDiscSource.js"; // Builds one M3U-backed set from ordered single-disc ZIPs
import { isGamepadButtonMap } from "../GamepadSource/types.js";         // Validates runtime gamepad remapping
import { isKeyboardMap } from "../KeyboardSource/types.js";             // Validates runtime keyboard remapping
import PsxAudio from "../PsxAudio/PsxAudio.js";                          // Creates audio output for initialized players
import PsxDisplay from "../PsxDisplay/PsxDisplay.js";                    // Creates canvas output for initialized players
import PsxPlayer from "../PsxPlayer/PsxPlayer.js";                       // Owns the emulation session lifecycle
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Reports invalid state, content, and optional-feature errors
import ZipDiscSource from "../ZipDiscSource/ZipDiscSource.js";          // Expands a selected game archive into a disc set
import {
    isControllerPort,    // Validates physical controller assignments
    isDiscPath,          // Validates local and archived content paths
} from "../shared.types.js";
import {
    isPsxConsoleConfig,        // Validates direct construction dependencies
    isPsxConsoleInitConfig,    // Validates high-level factory dependencies
    isPsxFileListLike,         // Validates browser-compatible file selections
    isPsxLocalFilesConfig,     // Validates local disc-set identity and entry selection
} from "./types.js";

// Type dependencies:
import type {
    ControllerPort,     // Physical PSX controller port
    DiscSet,            // Normalized content supplied to a session
    PsxStartConfig,     // Session startup options excluding resolved content
} from "../shared.types.js";
import type { GamepadButtonMap } from "../GamepadSource/types.js";    // Per-device physical-to-PSX button mapping
import type { KeyboardMap } from "../KeyboardSource/types.js";        // Browser-code-to-PSX-control mapping
import type { PsxInputLike } from "../PsxInput/types.js";              // Active input surface exposed by the player
import type {
    PsxConsoleConfig,        // Direct construction dependencies
    PsxConsoleInitConfig,    // High-level browser factory dependencies
    PsxFileListLike,         // Browser-compatible indexed local files
    PsxLocalFilesConfig,     // Caller-supplied local identity and optional entry
} from "./types.js";

/**
 *
 * Class
 *
 */

// Composes player, content, storage, keyboard, and gamepad concerns for browser use.
export default class PsxConsole {

    /* Instance Fields */
    private readonly _player: PsxConsoleConfig["player"];                              // Emulation lifecycle owned by this console
    private readonly _keyboardConfig: NonNullable<PsxConsoleConfig["keyboard"]> | null; // Keyboard dependencies retained across sessions
    private readonly _gamepadConfig: NonNullable<PsxConsoleConfig["gamepad"]> | null;   // Gamepad dependencies retained across sessions
    private readonly _gameStore: NonNullable<PsxConsoleConfig["gameStore"]> | null;     // Optional persistent content library
    private readonly _assignments = new Map<number, ControllerPort>();                  // Browser gamepad index to physical port bindings
    private readonly _gamepadButtonMaps: Record<string, GamepadButtonMap> =             // Device-specific digital remapping retained across sessions
        Object.create(null) as Record<string, GamepadButtonMap>;
    private readonly _leftStickDpad: Record<ControllerPort, boolean> = { 1: false, 2: false }; // Per-port digital-game stick compatibility
    private readonly _unsubscribeStatus: () => void;                                    // Player-status observer cleanup
    private _keyboardMap: KeyboardMap | null;                                           // Current keyboard mapping override
    private _keyboard: KeyboardSource | null = null;                                    // Input source attached to the running session
    private _gamepad: GamepadSource | null = null;                                      // Input source attached to the running session
    private _destroyed = false;                                                         // Whether console ownership has ended

    // CONSTRUCTOR :: psxConsoleConfig -> psxConsole
    // Validates dependencies and synchronizes input sources with player status.
    constructor(config: PsxConsoleConfig) {
        if (!isPsxConsoleConfig(config)) throw invalid("PsxConsole config is invalid.", config);
        this._player = config.player;
        this._keyboardConfig = config.keyboard ?? null;
        this._gamepadConfig = config.gamepad ?? null;
        this._keyboardMap = config.keyboard?.map ?? null;
        Object.assign(this._gamepadButtonMaps, config.gamepad?.buttonMaps ?? {});
        Object.assign(this._leftStickDpad, config.gamepad?.leftStickDpad ?? {});
        this._gameStore = config.gameStore ?? null;
        this._unsubscribeStatus = config.player.on("status", (status) => {
            if (status === "running") this._attachSources();
            else this._destroySources();
        });
        if (config.player.status === "running") this._attachSources();
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> psxPlayerLike
    // Exposes the composed player for lifecycle and status operations.
    get player(): PsxConsoleConfig["player"] { return this._player; }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: NUMBER, controllerPort? -> VOID
    // Assigns one browser gamepad index to at most one physical controller port.
    bindGamepad(index: number, port: ControllerPort | null): void {
        this._assertLive();
        if (!Number.isSafeInteger(index) || index < 0 || (port !== null && !isControllerPort(port))) {
            throw invalid("Gamepad binding is invalid.", { index, port });
        }
        this._assignments.delete(index);
        if (port !== null) {
            for (const [assignedIndex, assignedPort] of this._assignments) {
                if (assignedPort === port) this._assignments.delete(assignedIndex);
            }
            this._assignments.set(index, port);
        }
        if (this._player.status === "running") this._attachSources();
    }

    // METHOD :: keyboardMap -> VOID
    // Replaces keyboard controls and reattaches input when a session is running.
    setKeyboardMap(map: KeyboardMap): void {
        this._assertLive();
        if (this._keyboardConfig === null || !isKeyboardMap(map)) {
            throw invalid("Keyboard mapping is invalid or keyboard input is not configured.", map);
        }
        this._keyboardMap = Object.freeze({ ...map });
        if (this._player.status === "running") this._attachSources();
    }

    // METHOD :: STRING, gamepadButtonMap? -> VOID
    // Sets or removes the digital mapping for one browser gamepad identity.
    setGamepadButtonMap(id: string, map: GamepadButtonMap | null): void {
        this._assertLive();
        if (this._gamepadConfig === null || typeof id !== "string" || id.trim().length === 0
            || (map !== null && !isGamepadButtonMap(map))) {
            throw invalid("Gamepad button mapping is invalid or gamepad input is not configured.", { id, map });
        }
        if (map === null) delete this._gamepadButtonMaps[id];
        else this._gamepadButtonMaps[id] = Object.freeze({ ...map });
        if (this._player.status === "running") this._attachSources();
    }

    // METHOD :: controllerPort, BOOLEAN -> VOID
    // Enables or disables left-stick-to-D-pad compatibility for one emulated port.
    setLeftStickDpad(port: ControllerPort, enabled: boolean): void {
        this._assertLive();
        if (this._gamepadConfig === null || !isControllerPort(port) || typeof enabled !== "boolean") {
            throw invalid("Left-stick D-pad compatibility is invalid or gamepad input is not configured.", {
                port,
                enabled,
            });
        }
        if (this._leftStickDpad[port] === enabled) return;
        this._leftStickDpad[port] = enabled;
        if (this._player.status === "running") this._attachSources();
    }

    // METHOD :: psxFileListLike, psxLocalFilesConfig, psxStartConfig -> PROMISE(VOID)
    // Resolves selected content, optionally persists it, and starts the player.
    async startFiles(
        files: PsxFileListLike,
        local: PsxLocalFilesConfig,
        config: Omit<PsxStartConfig, "game">,
    ): Promise<void> {
        this._assertLive();
        let game = await PsxConsole.resolveFiles(files, local);
        if (this._gameStore !== null) {
            const stored = await this._gameStore.import(game, { displayTitle: local.gameId });
            const normalized = await this._gameStore.get(stored.gameId);
            if (normalized === null) throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.STORAGE_FAILED,
                message: "Imported game content could not be reloaded.",
            });
            game = normalized;
        }
        await this._player.start({ ...config, game });
    }

    // METHOD :: psxFileListLike, psxLocalFilesConfig -> PROMISE(discSetAuditReport)
    // Resolves and audits local or archived content without starting it.
    async auditFiles(files: PsxFileListLike, local: PsxLocalFilesConfig) {
        this._assertLive();
        return DiscSetAudit.audit(await PsxConsole.resolveFiles(files, local));
    }

    // METHOD :: psxFileListLike, psxLocalFilesConfig -> PROMISE(discSet)
    // Audits and persists selected content, then returns its stored normalized form.
    async importFiles(files: PsxFileListLike, local: PsxLocalFilesConfig): Promise<DiscSet> {
        this._assertLive();
        if (this._gameStore === null) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.UNSUPPORTED,
            message: "Local game storage is not configured.",
        });
        const game = await PsxConsole.resolveFiles(files, local);
        const audit = await DiscSetAudit.audit(game);
        if (!audit.ok) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DISC_SET_INVALID,
            message: "The selected files failed disc-set validation.",
            data: audit,
        });
        const stored = await this._gameStore.import(game, { displayTitle: local.gameId });
        const normalized = await this._gameStore.get(stored.gameId);
        if (normalized === null) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.STORAGE_FAILED,
            message: "Imported game content could not be reloaded.",
        });
        return normalized;
    }

    // METHOD :: STRING, psxStartConfig -> PROMISE(VOID)
    // Loads a stored game by identity and starts the player.
    async startStored(gameId: string, config: Omit<PsxStartConfig, "game">): Promise<void> {
        this._assertLive();
        if (this._gameStore === null) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.UNSUPPORTED,
            message: "Local game storage is not configured.",
        });
        const game = await this._gameStore.get(gameId);
        if (game === null) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.CONTENT_LOAD_FAILED,
            message: "The stored game does not exist.",
        });
        if (this._player.status === "running" || this._player.status === "paused"
            || this._player.status === "failed") await this._player.stop();
        await this._player.start({ ...config, game });
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Stops the current player session while retaining the console.
    stop(): Promise<void> {
        this._assertLive();
        return this._player.stop();
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Detaches input sources and permanently destroys the composed player.
    async destroy(): Promise<void> {
        if (this._destroyed) return;
        this._destroyed = true;
        this._unsubscribeStatus();
        this._destroySources();
        await this._player.destroy();
    }

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: VOID -> VOID
    // Recreates configured input sources against the active session input.
    private _attachSources(): void {
        this._destroySources();
        const input = this._player.input;
        if (input === null) return;
        if (this._keyboardConfig !== null) {
            this._keyboard = new KeyboardSource({
                ...this._keyboardConfig,
                ...(this._keyboardMap === null ? {} : { map: this._keyboardMap }),
                input,
            });
            this._keyboard.attach();
        }
        if (this._gamepadConfig !== null && this._assignments.size > 0) {
            const assignments = Object.fromEntries(this._assignments) as Record<number, ControllerPort>;
            this._gamepad = new GamepadSource({
                ...this._gamepadConfig,
                input,
                assignments,
                leftStickDpad: this._leftStickDpad,
                buttonMaps: this._gamepadButtonMaps,
            });
            this._gamepad.attach();
        }
    }

    // METHOD :: VOID -> VOID
    // Destroys any input sources attached to the previous session.
    private _destroySources(): void {
        this._keyboard?.destroy();
        this._keyboard = null;
        this._gamepad?.destroy();
        this._gamepad = null;
    }

    // METHOD :: VOID -> VOID
    // Rejects console operations after destruction.
    private _assertLive(): void {
        if (this._destroyed) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "PsxConsole has been destroyed.",
        });
    }

    /**
     *
     * Static Methods
     *
     */

    // METHOD :: psxFileListLike, psxLocalFilesConfig -> discSet
    // Converts extracted browser files into a safe immutable disc set.
    static normalizeFiles(files: PsxFileListLike, config: PsxLocalFilesConfig): DiscSet {
        if (!isPsxFileListLike(files) || !isPsxLocalFilesConfig(config)) {
            throw invalid("Local file selection is invalid.", { files, config });
        }
        const normalized = Array.from({ length: files.length }, (_, index) => {
            const file = typeof files.item === "function" ? files.item(index)! : files[index]!;
            const path = file.webkitRelativePath?.length ? file.webkitRelativePath : file.name;
            if (!isDiscPath(path)) throw invalid("A selected file path is unsafe.", path);
            return { path, blob: file as Blob };
        });
        const entry = config.entry ?? inferEntry(normalized.map(({ path }) => path));
        if (!isDiscPath(entry) || !normalized.some(({ path }) => path === entry)) {
            throw invalid("The disc-set entry does not identify a selected file.", entry);
        }
        return Object.freeze({
            gameId: config.gameId,
            entry,
            files: Object.freeze(normalized.map((file) => Object.freeze(file))),
        });
    }

    // METHOD :: psxFileListLike, psxLocalFilesConfig -> PROMISE(discSet)
    // Resolves either one ZIP archive or an extracted browser file selection.
    static async resolveFiles(files: PsxFileListLike, config: PsxLocalFilesConfig): Promise<DiscSet> {
        if (!isPsxFileListLike(files) || !isPsxLocalFilesConfig(config)) {
            throw invalid("Local file selection is invalid.", { files, config });
        }
        const selected = Array.from({ length: files.length }, (_, index) =>
            typeof files.item === "function" ? files.item(index)! : files[index]!);
        const archives = selected.filter(ZipDiscSource.isArchive);
        if (archives.length === 0) return PsxConsole.normalizeFiles(files, config);
        if (archives.length === selected.length && archives.length > 1) {
            return (await MultiZipDiscSource.build(files, config)).game;
        }
        if (archives.length !== 1 || selected.length !== 1) {
            throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.ARCHIVE_INVALID,
                message: "Do not mix ZIP archives with separately selected disc files.",
            });
        }
        const normalized = await ZipDiscSource.extract(archives[0]!);
        const entry = config.entry ?? inferEntry(normalized.map(({ path }) => path));
        if (!isDiscPath(entry) || !normalized.some(({ path }) => path === entry)) {
            throw invalid("The disc-set entry does not identify a file inside the ZIP archive.", entry);
        }
        return Object.freeze({
            gameId: config.gameId,
            entry,
            files: normalized,
        });
    }

    // Static Factory Method :: psxConsoleInitConfig -> psxConsole
    // Creates the default display, player, audio, storage, and input composition.
    static init(config: PsxConsoleInitConfig): PsxConsole {
        if (!isPsxConsoleInitConfig(config)) throw invalid("PsxConsole init config is invalid.", config);
        const display = PsxDisplay.init({
            canvas: config.canvas,
            container: config.container,
            ...(config.fullscreenTarget === undefined ? {} : { fullscreenTarget: config.fullscreenTarget }),
        });
        const player = PsxPlayer.init({
            adapter: config.adapter,
            display,
            createAudio: (session) => {
                const audio = PsxAudio.init({ session, gestureSource: config.gestureSource });
                audio.armGestureUnlock();
                return audio;
            },
            ...(config.storage === undefined ? {} : {
                storage: config.storage,
                profileId: config.profileId!,
                memoryCardIds: config.memoryCardIds!,
                ...(config.intervalScheduler === undefined ? {} : { intervalScheduler: config.intervalScheduler }),
                ...(config.autoSaveIntervalMs === undefined ? {} : { autoSaveIntervalMs: config.autoSaveIntervalMs }),
            }),
        });
        return new PsxConsole({
            player,
            ...(config.keyboard === undefined ? {} : { keyboard: config.keyboard }),
            ...(config.gamepad === undefined ? {} : { gamepad: config.gamepad }),
            ...(config.gameStore === undefined ? {} : { gameStore: config.gameStore }),
        });
    }

}

/**
 *
 *  Helper Functions
 *
 */

// HELPER :: STRING, UNKNOWN -> psxRuntimeError
// Creates one invalid console configuration or local-selection error.
const invalid = (message: string, data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.INVALID_CONFIG,
    message,
    data,
});

// HELPER :: [STRING] -> STRING
// Infers the only unambiguous playlist or cue entry in a local file set.
const inferEntry = (paths: ReadonlyArray<string>): string => {
    const playlists = paths.filter((path) => path.toLowerCase().endsWith(".m3u"));
    if (playlists.length === 1) return playlists[0]!;
    const cues = paths.filter((path) => path.toLowerCase().endsWith(".cue"));
    if (playlists.length === 0 && cues.length === 1) return cues[0]!;
    throw invalid("Select an explicit entry when the file set has multiple descriptors.", paths);
};
