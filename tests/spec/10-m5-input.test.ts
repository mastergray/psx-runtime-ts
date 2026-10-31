import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";
import {
    DEFAULT_KEYBOARD_MAP,
    GamepadSource,
    isGamepadSourceConfig,
    isKeyboardSourceConfig,
    isPsxInputChannel,
    KeyboardSource,
    PsxInput,
    PsxRuntimeError,
} from "../../src/index.ts";

import type {
    FrameScheduler,
    GamepadLike,
    Listener,
    PsxAxisControl,
    PsxButtonControl,
    PsxFrameEvent,
    PsxMachineInfo,
    PsxRumbleEvent,
    PsxSession,
    PsxSoundEvent,
    Unsubscribe,
} from "../../src/index.ts";
import type { TestFile } from "../run.ts";

const machine: PsxMachineInfo = {
    core: "Synthetic",
    coreVersion: "1",
    buildId: "a".repeat(64),
    gameId: "input",
    region: "ntsc-u",
    framesPerSecond: 60,
    sampleRate: 44_100,
    geometry: { width: 1, height: 1, aspectRatio: 1 },
    maxWidth: 1,
    maxHeight: 1,
    firmware: "bios",
    controllers: { 1: "dualshock", 2: "digital" },
    discCount: 1,
};

class FakeSession implements PsxSession {
    readonly machine = machine;
    readonly discIndex = 0;
    readonly trayOpen = false;
    readonly buttons: string[] = [];
    readonly axes: string[] = [];
    readonly ticks = new Set<Listener<void>>();
    readonly rumble = new Set<Listener<PsxRumbleEvent>>();

    setButton(control: PsxButtonControl, pressed: boolean): void {
        this.buttons.push(control.port + ":" + control.button + ":" + pressed);
    }

    setAxis(control: PsxAxisControl, value: number): void {
        this.axes.push(control.port + ":" + control.axis + ":" + Number(value.toFixed(3)));
    }

    pause(): void {}
    resume(): void {}
    async reset(): Promise<void> {}
    async setDisc(): Promise<void> {}
    async readMemoryCard(): Promise<Uint8Array> { return new Uint8Array(128 * 1024); }
    async serializeState(): Promise<Uint8Array> { return new Uint8Array([1]); }
    async unserializeState(): Promise<void> {}
    async exit(): Promise<void> {}

    onTick(listener: Listener<void>): Unsubscribe {
        this.ticks.add(listener);
        return () => this.ticks.delete(listener);
    }

    onFrame(_listener: Listener<PsxFrameEvent>): Unsubscribe { return () => undefined; }
    onSound(_listener: Listener<PsxSoundEvent>): Unsubscribe { return () => undefined; }

    onRumble(listener: Listener<PsxRumbleEvent>): Unsubscribe {
        this.rumble.add(listener);
        return () => this.rumble.delete(listener);
    }

    onExit(): Unsubscribe { return () => undefined; }

    tick(): void {
        [...this.ticks].forEach((listener) => listener());
    }

    emitRumble(event: PsxRumbleEvent): void {
        [...this.rumble].forEach((listener) => listener(event));
    }
}

class FakeTarget {
    visibilityState = "visible";
    readonly listeners = new Map<string, Set<(...arguments_: never[]) => void>>();

    addEventListener(type: "keydown" | "keyup", listener: (event: { code: string; preventDefault(): void }) => void): void;
    addEventListener(type: "blur" | "visibilitychange", listener: () => void): void;
    addEventListener(type: string, listener: (...arguments_: never[]) => void): void {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: "keydown" | "keyup", listener: (event: { code: string; preventDefault(): void }) => void): void;
    removeEventListener(type: "blur" | "visibilitychange", listener: () => void): void;
    removeEventListener(type: string, listener: (...arguments_: never[]) => void): void {
        this.listeners.get(type)?.delete(listener);
    }

    key(type: "keydown" | "keyup", code: string): number {
        let prevented = 0;
        const event = { code, preventDefault: () => { prevented++; } };
        this.listeners.get(type)?.forEach((listener) => listener(event as never));
        return prevented;
    }

    emit(type: "blur" | "visibilitychange"): void {
        this.listeners.get(type)?.forEach((listener) => listener());
    }
}

class ManualScheduler implements FrameScheduler {
    readonly callbacks = new Map<number, (time: number) => void>();
    id = 0;

    request(callback: (time: number) => void): number {
        const id = ++this.id;
        this.callbacks.set(id, callback);
        return id;
    }

    cancel(handle: number): void {
        this.callbacks.delete(handle);
    }

    pulse(): void {
        const callbacks = [...this.callbacks.values()];
        this.callbacks.clear();
        callbacks.forEach((callback) => callback(0));
    }
}

const buttons = (): Array<{ pressed: boolean; value: number }> =>
    Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));

const axes = (): number[] => [0, 0, 0, 0];

const codeOf = (action: () => unknown): number | null => {
    try {
        action();
        return null;
    } catch (error) {
        return PsxRuntimeError.is(error) ? error.code : -1;
    }
};

const testFile: TestFile = {
    label: "M5 input and browser sources",
    cases: [
        {
            label: "channels reference-count buttons, resolve opposing directions, and restore axis ownership",
            run: () => CTGTest.init("input channels")
                .assert("effective state", () => {
                    const session = new FakeSession();
                    const input = new PsxInput({ session });
                    const first = input.createChannel();
                    const second = input.createChannel();
                    const cross = { port: 1, button: "cross" } as const;
                    first.press(cross);
                    second.press(cross);
                    const held = input.snapshot;
                    first.release(cross);
                    second.release(cross);
                    first.press({ port: 1, button: "left" });
                    second.press({ port: 1, button: "right" });
                    second.release({ port: 1, button: "right" });
                    first.setAxis({ port: 1, axis: "left-x" }, 0.25);
                    second.setAxis({ port: 1, axis: "left-x" }, 0.75);
                    first.setAxis({ port: 1, axis: "left-x" }, -0.5);
                    const axesBefore = input.axes;
                    first.destroy();
                    second.destroy();
                    const destroyed = codeOf(() => first.press(cross));
                    input.destroy();
                    return {
                        validChannel: isPsxInputChannel(first),
                        held,
                        frozen: Object.isFrozen(held) && Object.isFrozen(held[0]),
                        axesBefore,
                        buttons: session.buttons,
                        axes: session.axes,
                        destroyed,
                    };
                }, P.equals<unknown>({
                    validChannel: true,
                    held: [{ port: 1, button: "cross" }],
                    frozen: true,
                    axesBefore: [{ control: { port: 1, axis: "left-x" }, value: -0.5 }],
                    buttons: [
                        "1:cross:true",
                        "1:cross:false",
                        "1:left:true",
                        "1:left:false",
                        "1:right:true",
                        "1:right:false",
                    ],
                    axes: [
                        "1:left-x:0.25",
                        "1:left-x:0.75",
                        "1:left-x:-0.5",
                        "1:left-x:0.75",
                        "1:left-x:0",
                    ],
                    destroyed: 11,
                }))
                .start(undefined),
        },
        {
            label: "keyboard mappings prevent only owned keys and analog emulation ramps on core ticks",
            run: () => CTGTest.init("keyboard source")
                .assert("keyboard behavior", () => {
                    const session = new FakeSession();
                    const input = new PsxInput({ session });
                    const target = new FakeTarget();
                    const config = {
                        input,
                        target,
                        analog: {
                            rampPerTick: 0.5,
                            bindings: {
                                KeyJ: { control: { port: 1 as const, axis: "left-x" as const }, direction: -1 as const },
                                KeyL: { control: { port: 1 as const, axis: "left-x" as const }, direction: 1 as const },
                            },
                        },
                    };
                    const source = new KeyboardSource(config);
                    source.attach();
                    const prevention = [
                        target.key("keydown", "KeyZ"),
                        target.key("keydown", "KeyZ"),
                        target.key("keydown", "KeyP"),
                        target.key("keyup", "KeyZ"),
                    ];
                    target.key("keydown", "KeyJ");
                    session.tick();
                    session.tick();
                    target.key("keydown", "KeyL");
                    session.tick();
                    target.key("keyup", "KeyL");
                    session.tick();
                    target.key("keyup", "KeyJ");
                    session.tick();
                    session.tick();
                    target.key("keydown", "ArrowUp");
                    target.emit("blur");
                    source.detach();
                    const detachedPrevention = target.key("keydown", "KeyZ");
                    source.destroy();
                    input.destroy();
                    return {
                        config: isKeyboardSourceConfig(config),
                        defaultFrozen: Object.isFrozen(DEFAULT_KEYBOARD_MAP)
                            && Object.isFrozen(DEFAULT_KEYBOARD_MAP.KeyZ),
                        prevention,
                        detachedPrevention,
                        buttons: session.buttons,
                        axes: session.axes,
                        attached: source.isAttached,
                    };
                }, P.equals<unknown>({
                    config: true,
                    defaultFrozen: true,
                    prevention: [1, 1, 0, 1],
                    detachedPrevention: 0,
                    buttons: [
                        "1:cross:true",
                        "1:cross:false",
                        "1:up:true",
                        "1:up:false",
                    ],
                    axes: [
                        "1:left-x:-0.5",
                        "1:left-x:-1",
                        "1:left-x:-0.5",
                        "1:left-x:-1",
                        "1:left-x:-0.5",
                        "1:left-x:0",
                    ],
                    attached: false,
                }))
                .start(undefined),
        },
        {
            label: "explicit gamepad assignments cover two ports, dead zones, inversion, disconnect, and rumble",
            run: () => CTGTest.init("gamepad source")
                .stage("poll pads", async () => {
                    const session = new FakeSession();
                    const input = new PsxInput({ session });
                    const scheduler = new ManualScheduler();
                    const target = new FakeTarget();
                    const rumbleCalls: unknown[] = [];
                    let resets = 0;
                    const firstButtons = buttons();
                    firstButtons[0] = { pressed: true, value: 1 };
                    firstButtons[6] = { pressed: false, value: 0.6 };
                    firstButtons[14] = { pressed: true, value: 1 };
                    const secondButtons = buttons();
                    secondButtons[9] = { pressed: true, value: 1 };
                    const firstPad: GamepadLike = {
                        id: "one",
                        index: 3,
                        connected: true,
                        mapping: "standard",
                        axes: [0.1, 0.6, 0, 0],
                        buttons: firstButtons,
                        vibrationActuator: {
                            playEffect: async (type, parameters) => { rumbleCalls.push({ type, parameters }); },
                            reset: async () => { resets++; },
                        },
                    };
                    const secondPad: GamepadLike = {
                        id: "two",
                        index: 7,
                        connected: true,
                        mapping: "standard",
                        axes: axes(),
                        buttons: secondButtons,
                    };
                    const pads: Array<GamepadLike | null> = Array.from({ length: 8 }, () => null);
                    pads[3] = firstPad;
                    pads[7] = secondPad;
                    const config = {
                        input,
                        provider: { getGamepads: () => pads },
                        scheduler,
                        target,
                        assignments: { 3: 1 as const, 7: 2 as const },
                        deadZone: 0.2,
                        triggerThreshold: 0.7,
                        invertAxes: { "left-y": true },
                    };
                    const source = new GamepadSource(config);
                    source.attach();
                    scheduler.pulse();
                    session.emitRumble({ port: 1, strong: 0.75, weak: 0.25 });
                    await Promise.resolve();
                    pads[3] = null;
                    scheduler.pulse();
                    source.enabled = false;
                    source.destroy();
                    input.destroy();
                    return {
                        config: isGamepadSourceConfig(config),
                        duplicateRejected: isGamepadSourceConfig({ ...config, assignments: { 3: 1, 7: 1 } }),
                        players: source.players,
                        buttons: session.buttons,
                        axes: session.axes,
                        rumbleCalls,
                        resets,
                        schedulerHandles: scheduler.callbacks.size,
                    };
                })
                .assert("gamepad behavior", ({ subject }) => subject, P.equals<unknown>({
                    config: true,
                    duplicateRejected: false,
                    players: [
                        { index: 3, port: 1, id: null },
                        { index: 7, port: 2, id: null },
                    ],
                    buttons: [
                        "1:cross:true",
                        "1:left:true",
                        "2:start:true",
                        "1:cross:false",
                        "1:left:false",
                        "2:start:false",
                    ],
                    axes: [
                        "1:left-y:-0.5",
                        "1:left-y:0",
                    ],
                    rumbleCalls: [{
                        type: "dual-rumble",
                        parameters: { duration: 100, strongMagnitude: 0.75, weakMagnitude: 0.25 },
                    }],
                    resets: 1,
                    schedulerHandles: 0,
                }))
                .start(undefined),
        },
    ],
};

export default testFile;
