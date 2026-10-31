import { isPsxSession } from "../shared.types.js";

import type {
    Listener,
    PsxAxisControl,
    PsxButtonControl,
    PsxMachineInfo,
    PsxRumbleEvent,
    PsxSession,
    Unsubscribe,
} from "../shared.types.js";

export interface PsxInputConfig {
    readonly session: PsxSession;
}

export interface PsxInputChannel {
    press(control: PsxButtonControl): void;
    release(control: PsxButtonControl): void;
    setAxis(control: PsxAxisControl, value: number): void;
    releaseAll(): void;
    destroy(): void;
}

export interface PsxInputLike {
    readonly machine: PsxMachineInfo;
    createChannel(): PsxInputChannel;
    onTick(listener: Listener<void>): Unsubscribe;
    onRumble(listener: Listener<PsxRumbleEvent>): Unsubscribe;
}

export function isPsxInputConfig(value: unknown): value is PsxInputConfig {
    return typeof value === "object" && value !== null
        && isPsxSession((value as { session?: unknown }).session);
}

export function isPsxInputChannel(value: unknown): value is PsxInputChannel {
    if (typeof value !== "object" || value === null) return false;
    const channel = value as Partial<PsxInputChannel>;
    return typeof channel.press === "function" && typeof channel.release === "function"
        && typeof channel.setAxis === "function" && typeof channel.releaseAll === "function"
        && typeof channel.destroy === "function";
}

export function isPsxInputLike(value: unknown): value is PsxInputLike {
    if (typeof value !== "object" || value === null) return false;
    const input = value as Partial<PsxInputLike>;
    return typeof input.machine === "object" && input.machine !== null
        && typeof input.createChannel === "function" && typeof input.onTick === "function"
        && typeof input.onRumble === "function";
}
