import DiscSetAudit from "../DiscSetAudit/DiscSetAudit.js";
import GamepadSource from "../GamepadSource/GamepadSource.js";
import KeyboardSource from "../KeyboardSource/KeyboardSource.js";
import PsxAudio from "../PsxAudio/PsxAudio.js";
import PsxDisplay from "../PsxDisplay/PsxDisplay.js";
import PsxPlayer from "../PsxPlayer/PsxPlayer.js";
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";
import { isControllerPort, isDiscPath } from "../shared.types.js";
import {
    isPsxConsoleConfig,
    isPsxConsoleInitConfig,
    isPsxFileListLike,
    isPsxLocalFilesConfig,
} from "./types.js";

import type { ControllerPort, DiscSet, PsxStartConfig } from "../shared.types.js";
import type { PsxInputLike } from "../PsxInput/types.js";
import type { PsxConsoleConfig, PsxConsoleInitConfig, PsxFileListLike, PsxLocalFilesConfig } from "./types.js";

const invalid = (message: string, data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.INVALID_CONFIG,
    message,
    data,
});

export default class PsxConsole {
    readonly #player: PsxConsoleConfig["player"];
    readonly #keyboardConfig: NonNullable<PsxConsoleConfig["keyboard"]> | null;
    readonly #gamepadConfig: NonNullable<PsxConsoleConfig["gamepad"]> | null;
    readonly #gameStore: NonNullable<PsxConsoleConfig["gameStore"]> | null;
    readonly #assignments = new Map<number, ControllerPort>();
    readonly #unsubscribeStatus: () => void;
    #keyboard: KeyboardSource | null = null;
    #gamepad: GamepadSource | null = null;
    #destroyed = false;

    constructor(config: PsxConsoleConfig) {
        if (!isPsxConsoleConfig(config)) throw invalid("PsxConsole config is invalid.", config);
        this.#player = config.player;
        this.#keyboardConfig = config.keyboard ?? null;
        this.#gamepadConfig = config.gamepad ?? null;
        this.#gameStore = config.gameStore ?? null;
        this.#unsubscribeStatus = config.player.on("status", (status) => {
            if (status === "running") this.#attachSources();
            else this.#destroySources();
        });
        if (config.player.status === "running") this.#attachSources();
    }

    get player(): PsxConsoleConfig["player"] { return this.#player; }

    bindGamepad(index: number, port: ControllerPort | null): void {
        this.#assertLive();
        if (!Number.isSafeInteger(index) || index < 0 || (port !== null && !isControllerPort(port))) {
            throw invalid("Gamepad binding is invalid.", { index, port });
        }
        this.#assignments.delete(index);
        if (port !== null) {
            for (const [assignedIndex, assignedPort] of this.#assignments) {
                if (assignedPort === port) this.#assignments.delete(assignedIndex);
            }
            this.#assignments.set(index, port);
        }
        if (this.#player.status === "running") this.#attachSources();
    }

    async startFiles(
        files: PsxFileListLike,
        local: PsxLocalFilesConfig,
        config: Omit<PsxStartConfig, "game">,
    ): Promise<void> {
        this.#assertLive();
        const game = PsxConsole.normalizeFiles(files, local);
        await this.#player.start({ ...config, game });
    }

    async auditFiles(files: PsxFileListLike, local: PsxLocalFilesConfig) {
        this.#assertLive();
        return DiscSetAudit.audit(PsxConsole.normalizeFiles(files, local));
    }

    async importFiles(files: PsxFileListLike, local: PsxLocalFilesConfig): Promise<DiscSet> {
        this.#assertLive();
        if (this.#gameStore === null) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.UNSUPPORTED,
            message: "Local game storage is not configured.",
        });
        const game = PsxConsole.normalizeFiles(files, local);
        const audit = await DiscSetAudit.audit(game);
        if (!audit.ok) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DISC_SET_INVALID,
            message: "The selected files failed disc-set validation.",
            data: audit,
        });
        const stored = await this.#gameStore.import(game, { displayTitle: local.gameId });
        const normalized = await this.#gameStore.get(stored.gameId);
        if (normalized === null) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.STORAGE_FAILED,
            message: "Imported game content could not be reloaded.",
        });
        return normalized;
    }

    async startStored(gameId: string, config: Omit<PsxStartConfig, "game">): Promise<void> {
        this.#assertLive();
        if (this.#gameStore === null) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.UNSUPPORTED,
            message: "Local game storage is not configured.",
        });
        const game = await this.#gameStore.get(gameId);
        if (game === null) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.CONTENT_LOAD_FAILED,
            message: "The stored game does not exist.",
        });
        await this.#player.start({ ...config, game });
    }

    stop(): Promise<void> {
        this.#assertLive();
        return this.#player.stop();
    }

    async destroy(): Promise<void> {
        if (this.#destroyed) return;
        this.#destroyed = true;
        this.#unsubscribeStatus();
        this.#destroySources();
        await this.#player.destroy();
    }

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
        const entry = config.entry ?? PsxConsole.inferEntry(normalized.map(({ path }) => path));
        if (!isDiscPath(entry) || !normalized.some(({ path }) => path === entry)) {
            throw invalid("The disc-set entry does not identify a selected file.", entry);
        }
        return Object.freeze({
            gameId: config.gameId,
            entry,
            files: Object.freeze(normalized.map((file) => Object.freeze(file))),
        });
    }

    static init(config: PsxConsoleInitConfig): PsxConsole {
        if (!isPsxConsoleInitConfig(config)) throw invalid("PsxConsole init config is invalid.", config);
        const display = PsxDisplay.init({ canvas: config.canvas, container: config.container });
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

    #attachSources(): void {
        this.#destroySources();
        const input = this.#player.input;
        if (input === null) return;
        if (this.#keyboardConfig !== null) {
            this.#keyboard = new KeyboardSource({ ...this.#keyboardConfig, input });
            this.#keyboard.attach();
        }
        if (this.#gamepadConfig !== null && this.#assignments.size > 0) {
            const assignments = Object.fromEntries(this.#assignments) as Record<number, ControllerPort>;
            this.#gamepad = new GamepadSource({ ...this.#gamepadConfig, input, assignments });
            this.#gamepad.attach();
        }
    }

    #destroySources(): void {
        this.#keyboard?.destroy();
        this.#keyboard = null;
        this.#gamepad?.destroy();
        this.#gamepad = null;
    }

    #assertLive(): void {
        if (this.#destroyed) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "PsxConsole has been destroyed.",
        });
    }

    private static inferEntry(paths: ReadonlyArray<string>): string {
        const playlists = paths.filter((path) => path.toLowerCase().endsWith(".m3u"));
        if (playlists.length === 1) return playlists[0]!;
        const cues = paths.filter((path) => path.toLowerCase().endsWith(".cue"));
        if (playlists.length === 0 && cues.length === 1) return cues[0]!;
        throw invalid("Select an explicit entry when the file set has multiple descriptors.", paths);
    }
}
