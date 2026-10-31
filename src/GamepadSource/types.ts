import { isFrameScheduler, isPsxAxis } from "../shared.types.js";
import { isPsxInputLike } from "../PsxInput/types.js";

import type {
    ControllerPort,
    FrameScheduler,
    PsxAxis,
} from "../shared.types.js";
import type { PsxInputLike } from "../PsxInput/types.js";

export interface GamepadButtonLike {
    readonly pressed: boolean;
    readonly value: number;
}

export interface GamepadHapticActuatorLike {
    playEffect(type: "dual-rumble", parameters: {
        readonly duration: number;
        readonly strongMagnitude: number;
        readonly weakMagnitude: number;
    }): Promise<unknown>;
    reset?(): Promise<unknown>;
}

export interface GamepadLike {
    readonly id: string;
    readonly index: number;
    readonly connected: boolean;
    readonly mapping: string;
    readonly axes: ReadonlyArray<number>;
    readonly buttons: ReadonlyArray<GamepadButtonLike>;
    readonly vibrationActuator?: GamepadHapticActuatorLike | null;
}

export interface GamepadProviderLike {
    getGamepads(): ReadonlyArray<GamepadLike | null>;
}

export interface GamepadEventTargetLike {
    readonly visibilityState?: string;
    addEventListener(type: "blur" | "visibilitychange", listener: () => void): void;
    removeEventListener(type: "blur" | "visibilitychange", listener: () => void): void;
}

export interface GamepadSourceConfig {
    readonly input: PsxInputLike;
    readonly provider: GamepadProviderLike;
    readonly scheduler: FrameScheduler;
    readonly target: GamepadEventTargetLike;
    readonly assignments: Readonly<Record<number, ControllerPort>>;
    readonly deadZone?: number;
    readonly triggerThreshold?: number;
    readonly invertAxes?: Readonly<Partial<Record<PsxAxis, boolean>>>;
    readonly rumble?: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const inUnitRange = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1;

export function isGamepadSourceConfig(value: unknown): value is GamepadSourceConfig {
    if (!isObject(value) || !isPsxInputLike(value.input) || !isObject(value.provider)
        || typeof value.provider.getGamepads !== "function" || !isFrameScheduler(value.scheduler)
        || !isObject(value.target) || typeof value.target.addEventListener !== "function"
        || typeof value.target.removeEventListener !== "function" || !isObject(value.assignments)
        || (value.deadZone !== undefined && !inUnitRange(value.deadZone))
        || (value.triggerThreshold !== undefined && !inUnitRange(value.triggerThreshold))
        || (value.rumble !== undefined && typeof value.rumble !== "boolean")) return false;
    const ports = new Set<number>();
    for (const [index, port] of Object.entries(value.assignments)) {
        if (!/^\d+$/u.test(index) || (port !== 1 && port !== 2) || ports.has(port)) return false;
        ports.add(port);
    }
    return ports.size > 0 && (value.invertAxes === undefined || (isObject(value.invertAxes)
        && Object.entries(value.invertAxes).every(([axis, invert]) => isPsxAxis(axis)
            && typeof invert === "boolean")));
}
