import {
    isPsxAxisControl,
    isPsxButtonControl,
} from "../shared.types.js";
import { isPsxInputLike } from "../PsxInput/types.js";

import type {
    PsxAxisControl,
    PsxButtonControl,
} from "../shared.types.js";
import type { PsxInputLike } from "../PsxInput/types.js";

export interface KeyboardEventLike {
    readonly code: string;
    preventDefault(): void;
}

export interface KeyboardEventTargetLike {
    readonly visibilityState?: string;
    addEventListener(type: "keydown" | "keyup", listener: (event: KeyboardEventLike) => void): void;
    addEventListener(type: "blur", listener: () => void): void;
    addEventListener(type: "visibilitychange", listener: () => void): void;
    removeEventListener(type: "keydown" | "keyup", listener: (event: KeyboardEventLike) => void): void;
    removeEventListener(type: "blur", listener: () => void): void;
    removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface KeyboardVisibilityTargetLike {
    readonly visibilityState?: string;
    addEventListener(type: "visibilitychange", listener: () => void): void;
    removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface KeyboardAnalogBinding {
    readonly control: PsxAxisControl;
    readonly direction: -1 | 1;
}

export interface KeyboardAnalogConfig {
    readonly bindings: Readonly<Record<string, KeyboardAnalogBinding>>;
    readonly rampPerTick?: number;
}

export type KeyboardMap = Readonly<Record<string, PsxButtonControl>>;

export interface KeyboardSourceConfig {
    readonly input: PsxInputLike;
    readonly target: KeyboardEventTargetLike;
    readonly visibilityTarget?: KeyboardVisibilityTargetLike;
    readonly map?: KeyboardMap;
    readonly analog?: KeyboardAnalogConfig;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const isTarget = (value: unknown): value is KeyboardEventTargetLike => isObject(value)
    && typeof value.addEventListener === "function" && typeof value.removeEventListener === "function";

export const isKeyboardMap = (value: unknown): value is KeyboardMap => isObject(value)
    && Object.entries(value).every(([code, control]) => code.length > 0 && isPsxButtonControl(control));

const isAnalog = (value: unknown): value is KeyboardAnalogConfig => {
    if (!isObject(value) || !isObject(value.bindings)) return false;
    if (value.rampPerTick !== undefined
        && (typeof value.rampPerTick !== "number" || !Number.isFinite(value.rampPerTick)
            || value.rampPerTick <= 0 || value.rampPerTick > 1)) return false;
    return Object.entries(value.bindings).every(([code, binding]) => code.length > 0
        && isObject(binding) && isPsxAxisControl(binding.control)
        && (binding.direction === -1 || binding.direction === 1));
};

export function isKeyboardSourceConfig(value: unknown): value is KeyboardSourceConfig {
    return isObject(value) && isPsxInputLike(value.input) && isTarget(value.target)
        && (value.visibilityTarget === undefined || isTarget(value.visibilityTarget))
        && (value.map === undefined || isKeyboardMap(value.map))
        && (value.analog === undefined || isAnalog(value.analog));
}
