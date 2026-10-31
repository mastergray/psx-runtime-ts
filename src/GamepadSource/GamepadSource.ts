import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";
import { isGamepadSourceConfig } from "./types.js";

import type {
    ControllerPort,
    PsxAxis,
    PsxAxisControl,
    PsxButton,
    PsxButtonControl,
    PsxRumbleEvent,
    Unsubscribe,
} from "../shared.types.js";
import type {
    GamepadLike,
    GamepadSourceConfig,
} from "./types.js";

interface Assignment {
    readonly index: number;
    readonly port: ControllerPort;
    readonly channel: ReturnType<GamepadSourceConfig["input"]["createChannel"]>;
    readonly active: Map<string, PsxButtonControl>;
    readonly axes: Map<PsxAxis, number>;
    pad: GamepadLike | null;
}

const BUTTONS: ReadonlyArray<readonly [number, PsxButton]> = [
    [0, "cross"], [1, "circle"], [2, "square"], [3, "triangle"],
    [4, "l1"], [5, "r1"], [6, "l2"], [7, "r2"],
    [8, "select"], [9, "start"], [10, "l3"], [11, "r3"],
    [12, "up"], [13, "down"], [14, "left"], [15, "right"],
];

const AXES: ReadonlyArray<readonly [number, PsxAxis]> = [
    [0, "left-x"], [1, "left-y"], [2, "right-x"], [3, "right-y"],
];

const invalid = (data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.INVALID_CONFIG,
    message: "GamepadSource config is invalid.",
    data,
});

const buttonDown = (pad: GamepadLike, index: number, triggerThreshold: number): boolean => {
    const button = pad.buttons[index];
    if (button === undefined) return false;
    return button.pressed || button.value >= (index === 6 || index === 7 ? triggerThreshold : 0.5);
};

const normalizedAxis = (value: number, deadZone: number): number => {
    if (!Number.isFinite(value)) return 0;
    const clamped = Math.max(-1, Math.min(1, value));
    const magnitude = Math.abs(clamped);
    if (magnitude <= deadZone) return 0;
    return Math.sign(clamped) * (magnitude - deadZone) / (1 - deadZone);
};

export default class GamepadSource {
    readonly #input: GamepadSourceConfig["input"];
    readonly #provider: GamepadSourceConfig["provider"];
    readonly #scheduler: GamepadSourceConfig["scheduler"];
    readonly #target: GamepadSourceConfig["target"];
    readonly #deadZone: number;
    readonly #triggerThreshold: number;
    readonly #invertAxes: NonNullable<GamepadSourceConfig["invertAxes"]>;
    readonly #rumbleEnabled: boolean;
    readonly #assignments: Assignment[];
    #frameHandle: number | null = null;
    #unsubscribeRumble: Unsubscribe | null = null;
    #attached = false;
    #enabled = true;
    #destroyed = false;

    readonly #frame = (): void => {
        this.#frameHandle = null;
        if (!this.#attached || !this.#enabled || this.#destroyed) return;
        this.#poll();
        this.#schedule();
    };
    readonly #blur = (): void => this.#releaseAll();
    readonly #visibility = (): void => {
        if (this.#target.visibilityState === undefined || this.#target.visibilityState === "hidden") this.#releaseAll();
    };

    constructor(config: GamepadSourceConfig) {
        if (!isGamepadSourceConfig(config)) throw invalid(config);
        this.#input = config.input;
        this.#provider = config.provider;
        this.#scheduler = config.scheduler;
        this.#target = config.target;
        this.#deadZone = config.deadZone ?? 0.2;
        this.#triggerThreshold = config.triggerThreshold ?? 0.5;
        this.#invertAxes = config.invertAxes ?? {};
        this.#rumbleEnabled = config.rumble ?? true;
        this.#assignments = Object.entries(config.assignments)
            .map(([index, port]) => ({
                index: Number(index),
                port,
                channel: this.#input.createChannel(),
                active: new Map(),
                axes: new Map(),
                pad: null,
            }))
            .sort((left, right) => left.port - right.port);
    }

    get isAttached(): boolean {
        return this.#attached;
    }

    get enabled(): boolean {
        return this.#enabled;
    }

    set enabled(value: boolean) {
        this.#assertLive();
        if (typeof value !== "boolean") throw invalid(value);
        if (value === this.#enabled) return;
        this.#enabled = value;
        if (value) {
            if (this.#attached) this.#schedule();
        } else {
            this.#cancel();
            this.#releaseAll();
        }
    }

    get players(): ReadonlyArray<{ readonly index: number; readonly port: ControllerPort; readonly id: string | null }> {
        return Object.freeze(this.#assignments.map(({ index, port, pad }) =>
            Object.freeze({ index, port, id: pad?.id ?? null })));
    }

    attach(): void {
        this.#assertLive();
        if (this.#attached) return;
        this.#target.addEventListener("blur", this.#blur);
        this.#target.addEventListener("visibilitychange", this.#visibility);
        this.#unsubscribeRumble = this.#input.onRumble((event) => this.#rumble(event));
        this.#attached = true;
        if (this.#enabled) this.#schedule();
    }

    detach(): void {
        if (!this.#attached) return;
        this.#cancel();
        this.#target.removeEventListener("blur", this.#blur);
        this.#target.removeEventListener("visibilitychange", this.#visibility);
        this.#unsubscribeRumble?.();
        this.#unsubscribeRumble = null;
        this.#attached = false;
        this.#releaseAll();
    }

    destroy(): void {
        if (this.#destroyed) return;
        this.detach();
        this.#assignments.forEach(({ channel }) => channel.destroy());
        this.#destroyed = true;
    }

    #schedule(): void {
        if (this.#frameHandle !== null || !this.#attached || !this.#enabled || this.#destroyed) return;
        this.#frameHandle = this.#scheduler.request(this.#frame);
    }

    #cancel(): void {
        if (this.#frameHandle === null) return;
        this.#scheduler.cancel(this.#frameHandle);
        this.#frameHandle = null;
    }

    #poll(): void {
        const pads = this.#provider.getGamepads();
        for (const assignment of this.#assignments) {
            const pad = pads[assignment.index];
            if (pad === null || pad === undefined || !pad.connected || pad.mapping !== "standard") {
                if (assignment.pad !== null) this.#release(assignment);
                continue;
            }
            assignment.pad = pad;
            this.#forwardButtons(assignment, pad);
            this.#forwardAxes(assignment, pad);
        }
    }

    #forwardButtons(assignment: Assignment, pad: GamepadLike): void {
        const next = new Map<string, PsxButtonControl>();
        for (const [index, button] of BUTTONS) {
            if (!buttonDown(pad, index, this.#triggerThreshold)) continue;
            const control = { port: assignment.port, button } as const;
            next.set(button, control);
            if (!assignment.active.has(button)) assignment.channel.press(control);
        }
        for (const [button, control] of assignment.active) {
            if (!next.has(button)) assignment.channel.release(control);
        }
        assignment.active.clear();
        next.forEach((control, key) => assignment.active.set(key, control));
    }

    #forwardAxes(assignment: Assignment, pad: GamepadLike): void {
        for (const [index, axis] of AXES) {
            let value = normalizedAxis(pad.axes[index] ?? 0, this.#deadZone);
            if (this.#invertAxes[axis] === true) value = -value;
            const previous = assignment.axes.get(axis);
            if ((previous === undefined && value === 0) || previous === value) continue;
            const control: PsxAxisControl = { port: assignment.port, axis };
            assignment.channel.setAxis(control, value);
            assignment.axes.set(axis, value);
        }
    }

    #release(assignment: Assignment): void {
        this.#stopRumble(assignment.pad);
        assignment.channel.releaseAll();
        assignment.active.clear();
        assignment.axes.clear();
        assignment.pad = null;
    }

    #releaseAll(): void {
        this.#assignments.forEach((assignment) => this.#release(assignment));
    }

    #rumble(event: PsxRumbleEvent): void {
        if (!this.#rumbleEnabled || !this.#attached || !this.#enabled) return;
        const pad = this.#assignments.find(({ port }) => port === event.port)?.pad;
        const actuator = pad?.vibrationActuator;
        if (actuator === undefined || actuator === null) return;
        void actuator.playEffect("dual-rumble", {
            duration: 100,
            strongMagnitude: event.strong,
            weakMagnitude: event.weak,
        }).catch(() => undefined);
    }

    #stopRumble(pad: GamepadLike | null): void {
        const reset = pad?.vibrationActuator?.reset;
        if (reset !== undefined) void reset.call(pad?.vibrationActuator).catch(() => undefined);
    }

    #assertLive(): void {
        if (this.#destroyed) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "GamepadSource has been destroyed.",
        });
    }
}
