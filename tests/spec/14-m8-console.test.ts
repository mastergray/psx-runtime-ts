import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";
import {
    DEFAULT_KEYBOARD_MAP,
    isPsxConsoleConfig,
    PsxConsole,
} from "../../src/index.ts";

import type {
    DiscSet,
    FrameScheduler,
    Listener,
    PsxInputChannel,
    PsxMachineInfo,
    PsxPlayerStatus,
    PsxRumbleEvent,
    PsxStartConfig,
    Unsubscribe,
} from "../../src/index.ts";
import type { TestFile } from "../run.ts";

const machine: PsxMachineInfo = {
    core: "Console fake", coreVersion: "1", buildId: "2".repeat(64), gameId: "console",
    region: "ntsc-u", framesPerSecond: 60, sampleRate: 44_100,
    geometry: { width: 1, height: 1, aspectRatio: 1 }, maxWidth: 1, maxHeight: 1,
    firmware: "bios", controllers: { 1: "digital", 2: "digital" }, discCount: 1,
};

class FakeInput {
    readonly machine = machine;
    readonly calls: string[] = [];
    createChannel(): PsxInputChannel {
        const held = new Set<string>();
        return {
            press: (control) => { held.add(`${control.port}:${control.button}`); this.calls.push(`down:${control.port}:${control.button}`); },
            release: (control) => { held.delete(`${control.port}:${control.button}`); this.calls.push(`up:${control.port}:${control.button}`); },
            setAxis: (control, value) => this.calls.push(`axis:${control.port}:${control.axis}:${value}`),
            releaseAll: () => {
                held.forEach((key) => this.calls.push(`release:${key}`));
                held.clear();
            },
            destroy: () => {
                held.forEach((key) => this.calls.push(`release:${key}`));
                held.clear();
            },
        };
    }
    onTick(_listener: Listener<void>): Unsubscribe { return () => undefined; }
    onRumble(_listener: Listener<PsxRumbleEvent>): Unsubscribe { return () => undefined; }
}

class FakePlayer {
    status: PsxPlayerStatus = "idle";
    input: FakeInput | null = null;
    readonly starts: PsxStartConfig[] = [];
    readonly listeners = new Set<(status: PsxPlayerStatus) => void>();
    destroyed = 0;
    async start(config: PsxStartConfig): Promise<void> {
        this.starts.push(config);
        this.input = new FakeInput();
        this.status = "running";
        this.listeners.forEach((listener) => listener(this.status));
    }
    async stop(): Promise<void> {
        this.status = "idle";
        this.listeners.forEach((listener) => listener(this.status));
        this.input = null;
    }
    async destroy(): Promise<void> {
        this.destroyed++;
        this.status = "destroyed";
        this.listeners.forEach((listener) => listener(this.status));
        this.input = null;
    }
    on(_type: "status", listener: (status: PsxPlayerStatus) => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

class FakeTarget {
    visibilityState = "visible";
    readonly listeners = new Map<string, Set<(...arguments_: never[]) => void>>();
    addEventListener(type: string, listener: (...arguments_: never[]) => void): void {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }
    removeEventListener(type: string, listener: (...arguments_: never[]) => void): void {
        this.listeners.get(type)?.delete(listener);
    }
    key(type: "keydown" | "keyup", code: string): void {
        const event = { code, preventDefault() {} };
        this.listeners.get(type)?.forEach((listener) => listener(event as never));
    }
}

class ManualFrames implements FrameScheduler {
    readonly callbacks = new Map<number, (time: number) => void>();
    id = 0;
    request(callback: (time: number) => void): number { const id = ++this.id; this.callbacks.set(id, callback); return id; }
    cancel(handle: number): void { this.callbacks.delete(handle); }
    pulse(): void {
        const callbacks = [...this.callbacks.values()];
        this.callbacks.clear();
        callbacks.forEach((callback) => callback(0));
    }
}

class FakeGameStore {
    readonly games = new Map<string, DiscSet>();
    imports = 0;
    async import(game: DiscSet): Promise<{ readonly gameId: string }> {
        this.games.set(game.gameId, game);
        this.imports++;
        return { gameId: game.gameId };
    }
    async get(gameId: string): Promise<DiscSet | null> { return this.games.get(gameId) ?? null; }
}

const file = (name: string, contents: BlobPart): Blob & { readonly name: string } => {
    const blob = new Blob([contents]) as Blob & { readonly name: string };
    Object.defineProperty(blob, "name", { value: name, enumerable: true });
    return blob;
};

const files = [
    file("game.cue", "FILE \"track.bin\" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:00:00\n"),
    file("track.bin", new Uint8Array([1, 2, 3])),
];

const testFile: TestFile = {
    label: "M8 console composition",
    cases: [
        {
            label: "local and stored games share one player path while input sources follow its lifecycle",
            run: () => CTGTest.init("console")
                .stage("exercise console", async () => {
                    const player = new FakePlayer();
                    const keyboardTarget = new FakeTarget();
                    const gamepadTarget = new FakeTarget();
                    const scheduler = new ManualFrames();
                    const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
                    buttons[0] = { pressed: true, value: 1 };
                    const pad = { id: "pad", index: 3, connected: true, mapping: "standard", axes: [-1, 0, 0, 0], buttons };
                    const pads = Array.from({ length: 4 }, () => null) as Array<typeof pad | null>;
                    pads[3] = pad;
                    const gameStore = new FakeGameStore();
                    const config = {
                        player,
                        keyboard: { target: keyboardTarget },
                        gamepad: {
                            provider: { getGamepads: () => pads },
                            scheduler,
                            target: gamepadTarget,
                        },
                        gameStore,
                    };
                    const console = new PsxConsole(config);
                    console.bindGamepad(3, 2);
                    const audit = await console.auditFiles(files, { gameId: "local" });
                    await console.startFiles(files, { gameId: "local" }, { bios: {
                        name: "firmware", region: "ntsc-u", blob: new Blob([new Uint8Array([1])]),
                    } });
                    const localInput = player.input!;
                    console.setKeyboardMap({ ...DEFAULT_KEYBOARD_MAP, KeyZ: { port: 2, button: "circle" } });
                    console.setGamepadButtonMap("pad", { cross: null, triangle: 0 });
                    console.setLeftStickDpad(2, true);
                    keyboardTarget.key("keydown", "KeyZ");
                    keyboardTarget.key("keyup", "KeyZ");
                    scheduler.pulse();
                    await console.stop();
                    const imported = await console.importFiles(files, { gameId: "stored" });
                    await console.startStored("stored", { bios: {
                        name: "firmware", region: "ntsc-u", blob: new Blob([new Uint8Array([1])]),
                    } });
                    const storedInput = player.input!;
                    keyboardTarget.key("keydown", "ArrowUp");
                    await console.stop();
                    await console.destroy();
                    return {
                        valid: isPsxConsoleConfig(config),
                        audit: [audit.ok, audit.ok ? audit.audit.discs.length : 0],
                        starts: player.starts.map(({ game }) => [game.gameId, game.entry, game.files.length]),
                        samePathShape: player.starts[0]!.game.files.map(({ path }) => path),
                        localInput: localInput.calls,
                        storedInput: storedInput.calls,
                        imported: [imported.gameId, gameStore.imports],
                        cleanup: [scheduler.callbacks.size, keyboardTarget.listeners.get("keydown")?.size ?? 0,
                            player.destroyed],
                    };
                })
                .assert("console behavior", ({ subject }) => subject, P.equals<unknown>({
                    valid: true,
                    audit: [true, 1],
                    starts: [["local", "game.cue", 2], ["stored", "game.cue", 2]],
                    samePathShape: ["game.cue", "track.bin"],
                    localInput: [
                        "down:2:circle", "up:2:circle", "down:2:triangle", "down:2:left",
                        "axis:2:left-x:-1", "release:2:triangle", "release:2:left",
                    ],
                    storedInput: ["down:1:up", "release:1:up"],
                    imported: ["stored", 2],
                    cleanup: [0, 0, 1],
                }))
                .start(undefined),
        },
    ],
};

export default testFile;
