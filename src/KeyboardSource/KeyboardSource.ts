import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";
import { isKeyboardSourceConfig } from "./types.js";

import type { PsxAxisControl, PsxButtonControl, Unsubscribe } from "../shared.types.js";
import type {
    KeyboardAnalogBinding,
    KeyboardEventLike,
    KeyboardMap,
    KeyboardSourceConfig,
} from "./types.js";

const frozenControl = (port: 1 | 2, button: PsxButtonControl["button"]): PsxButtonControl =>
    Object.freeze({ port, button });

export const DEFAULT_KEYBOARD_MAP: KeyboardMap = Object.freeze({
    ArrowUp: frozenControl(1, "up"),
    ArrowDown: frozenControl(1, "down"),
    ArrowLeft: frozenControl(1, "left"),
    ArrowRight: frozenControl(1, "right"),
    KeyZ: frozenControl(1, "cross"),
    KeyX: frozenControl(1, "circle"),
    KeyA: frozenControl(1, "square"),
    KeyS: frozenControl(1, "triangle"),
    KeyQ: frozenControl(1, "l1"),
    KeyW: frozenControl(1, "r1"),
    Digit1: frozenControl(1, "l2"),
    Digit2: frozenControl(1, "r2"),
    Enter: frozenControl(1, "start"),
    ShiftRight: frozenControl(1, "select"),
});

interface HeldAnalog extends KeyboardAnalogBinding {
    readonly sequence: number;
}

const invalid = (message: string, data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.INVALID_CONFIG,
    message,
    data,
});

const axisKey = ({ port, axis }: PsxAxisControl): string => `${port}:${axis}`;

export default class KeyboardSource {
    readonly #input: KeyboardSourceConfig["input"];
    readonly #target: KeyboardSourceConfig["target"];
    readonly #visibilityTarget: NonNullable<KeyboardSourceConfig["visibilityTarget"]>;
    readonly #map: KeyboardMap;
    readonly #analog: Readonly<Record<string, KeyboardAnalogBinding>>;
    readonly #ramp: number;
    readonly #channel;
    readonly #pressed = new Set<string>();
    readonly #analogHeld = new Map<string, HeldAnalog>();
    readonly #axisValues = new Map<string, { control: PsxAxisControl; value: number }>();
    #sequence = 0;
    #unsubscribeTick: Unsubscribe | null = null;
    #attached = false;
    #enabled = true;
    #destroyed = false;

    readonly #keydown = (event: KeyboardEventLike): void => this.#key(event, true);
    readonly #keyup = (event: KeyboardEventLike): void => this.#key(event, false);
    readonly #blur = (): void => this.#releaseHeld();
    readonly #visibility = (): void => {
        if (this.#visibilityTarget.visibilityState === undefined
            || this.#visibilityTarget.visibilityState === "hidden") this.#releaseHeld();
    };

    constructor(config: KeyboardSourceConfig) {
        if (!isKeyboardSourceConfig(config)) throw invalid("KeyboardSource config is invalid.", config);
        this.#input = config.input;
        this.#target = config.target;
        this.#visibilityTarget = config.visibilityTarget ?? config.target;
        this.#map = config.map ?? DEFAULT_KEYBOARD_MAP;
        this.#analog = config.analog?.bindings ?? {};
        this.#ramp = config.analog?.rampPerTick ?? 0.125;
        this.#channel = this.#input.createChannel();
    }

    get isAttached(): boolean {
        return this.#attached;
    }

    get enabled(): boolean {
        return this.#enabled;
    }

    set enabled(value: boolean) {
        this.#assertLive();
        if (typeof value !== "boolean") throw invalid("KeyboardSource enabled must be boolean.", value);
        if (value === this.#enabled) return;
        this.#enabled = value;
        if (!value) this.#releaseHeld();
    }

    attach(): void {
        this.#assertLive();
        if (this.#attached) return;
        this.#target.addEventListener("keydown", this.#keydown);
        this.#target.addEventListener("keyup", this.#keyup);
        this.#target.addEventListener("blur", this.#blur);
        this.#visibilityTarget.addEventListener("visibilitychange", this.#visibility);
        this.#unsubscribeTick = this.#input.onTick(() => this.#tick());
        this.#attached = true;
    }

    detach(): void {
        if (!this.#attached) return;
        this.#target.removeEventListener("keydown", this.#keydown);
        this.#target.removeEventListener("keyup", this.#keyup);
        this.#target.removeEventListener("blur", this.#blur);
        this.#visibilityTarget.removeEventListener("visibilitychange", this.#visibility);
        this.#unsubscribeTick?.();
        this.#unsubscribeTick = null;
        this.#attached = false;
        this.#releaseHeld();
    }

    destroy(): void {
        if (this.#destroyed) return;
        this.detach();
        this.#channel.destroy();
        this.#destroyed = true;
    }

    #key(event: KeyboardEventLike, pressed: boolean): void {
        if (!this.#attached || !this.#enabled) return;
        const digital = this.#map[event.code];
        const analog = this.#analog[event.code];
        if (digital === undefined && analog === undefined) return;
        event.preventDefault();
        if (pressed) {
            if (this.#pressed.has(event.code)) return;
            this.#pressed.add(event.code);
            if (digital !== undefined) this.#channel.press(digital);
            if (analog !== undefined) this.#analogHeld.set(event.code, { ...analog, sequence: ++this.#sequence });
        } else {
            if (!this.#pressed.delete(event.code)) return;
            if (digital !== undefined) this.#channel.release(digital);
            if (analog !== undefined) this.#analogHeld.delete(event.code);
        }
    }

    #tick(): void {
        if (!this.#attached || !this.#enabled) return;
        const keys = new Set<string>([
            ...this.#axisValues.keys(),
            ...[...this.#analogHeld.values()].map(({ control }) => axisKey(control)),
        ]);
        for (const key of [...keys].sort()) {
            const held = [...this.#analogHeld.values()]
                .filter(({ control }) => axisKey(control) === key)
                .sort((left, right) => right.sequence - left.sequence)[0];
            const previous = this.#axisValues.get(key);
            const control = held?.control ?? previous?.control;
            if (control === undefined) continue;
            const target = held?.direction ?? 0;
            const current = previous?.value ?? 0;
            const value = current < target
                ? Math.min(target, current + this.#ramp)
                : Math.max(target, current - this.#ramp);
            if (value !== current) this.#channel.setAxis(control, value);
            if (value === 0 && target === 0) this.#axisValues.delete(key);
            else this.#axisValues.set(key, { control, value });
        }
    }

    #releaseHeld(): void {
        this.#pressed.clear();
        this.#analogHeld.clear();
        this.#axisValues.clear();
        this.#channel.releaseAll();
    }

    #assertLive(): void {
        if (this.#destroyed) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "KeyboardSource has been destroyed.",
        });
    }
}
