import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";
import {
    isPsxAxisControl,
    isPsxButtonControl,
} from "../shared.types.js";
import { isPsxInputConfig } from "./types.js";

import type {
    Listener,
    PsxAxisControl,
    PsxButtonControl,
    PsxMachineInfo,
    PsxRumbleEvent,
    Unsubscribe,
} from "../shared.types.js";
import type { PsxInputChannel, PsxInputConfig } from "./types.js";

interface ChannelState {
    readonly buttons: Map<string, PsxButtonControl>;
    readonly axes: Map<string, AxisState>;
    destroyed: boolean;
}

interface HeldButton {
    readonly control: PsxButtonControl;
    readonly holders: Set<ChannelState>;
}

interface AxisState {
    readonly control: PsxAxisControl;
    value: number;
    sequence: number;
    readonly owner: ChannelState;
}

const buttonKey = ({ port, button }: PsxButtonControl): string => `${port}:${button}`;
const axisKey = ({ port, axis }: PsxAxisControl): string => `${port}:${axis}`;
const OPPOSITE: Readonly<Partial<Record<PsxButtonControl["button"], PsxButtonControl["button"]>>> = {
    up: "down",
    down: "up",
    left: "right",
    right: "left",
};

const invalid = (message: string, data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.INVALID_CONFIG,
    message,
    data,
});

export default class PsxInput {
    readonly #session: PsxInputConfig["session"];
    readonly #channels = new Set<ChannelState>();
    readonly #buttons = new Map<string, HeldButton>();
    readonly #axes = new Map<string, Map<ChannelState, AxisState>>();
    readonly #effectiveAxes = new Map<string, AxisState>();
    readonly #defaultChannel: PsxInputChannel;
    #sequence = 0;
    #destroyed = false;

    constructor(config: PsxInputConfig) {
        if (!isPsxInputConfig(config)) throw invalid("PsxInput config must contain a live session.", config);
        this.#session = config.session;
        this.#defaultChannel = this.createChannel();
    }

    get machine(): PsxMachineInfo {
        return this.#session.machine;
    }

    get snapshot(): ReadonlyArray<PsxButtonControl> {
        return Object.freeze([...this.#buttons.values()]
            .map(({ control }) => Object.freeze({ ...control }))
            .sort((left, right) => buttonKey(left).localeCompare(buttonKey(right))));
    }

    get axes(): ReadonlyArray<{ readonly control: PsxAxisControl; readonly value: number }> {
        return Object.freeze([...this.#effectiveAxes.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([, state]) => Object.freeze({ control: Object.freeze({ ...state.control }), value: state.value })));
    }

    createChannel(): PsxInputChannel {
        this.#assertLive();
        const state: ChannelState = { buttons: new Map(), axes: new Map(), destroyed: false };
        this.#channels.add(state);
        return {
            press: (control) => this.#press(state, control),
            release: (control) => this.#release(state, control),
            setAxis: (control, value) => this.#setAxis(state, control, value),
            releaseAll: () => this.#releaseChannel(state),
            destroy: () => this.#destroyChannel(state),
        };
    }

    press(control: PsxButtonControl): void {
        this.#defaultChannel.press(control);
    }

    release(control: PsxButtonControl): void {
        this.#defaultChannel.release(control);
    }

    setAxis(control: PsxAxisControl, value: number): void {
        this.#defaultChannel.setAxis(control, value);
    }

    releaseAll(): void {
        this.#assertLive();
        for (const channel of [...this.#channels]) this.#releaseChannel(channel);
    }

    onTick(listener: Listener<void>): Unsubscribe {
        this.#assertLive();
        if (typeof listener !== "function") throw invalid("PsxInput onTick requires a listener.", listener);
        return this.#session.onTick(listener);
    }

    onRumble(listener: Listener<PsxRumbleEvent>): Unsubscribe {
        this.#assertLive();
        if (typeof listener !== "function") throw invalid("PsxInput onRumble requires a listener.", listener);
        return this.#session.onRumble(listener);
    }

    destroy(): void {
        if (this.#destroyed) return;
        this.releaseAll();
        for (const channel of this.#channels) channel.destroyed = true;
        this.#channels.clear();
        this.#destroyed = true;
    }

    #press(channel: ChannelState, control: PsxButtonControl): void {
        this.#assertChannel(channel);
        if (!isPsxButtonControl(control)) throw invalid("PsxInput press requires a button control.", control);
        const stable = Object.freeze({ ...control });
        const key = buttonKey(stable);
        if (channel.buttons.has(key)) return;
        const opposite = OPPOSITE[stable.button];
        if (opposite !== undefined) this.#releaseEveryHolder(buttonKey({ port: stable.port, button: opposite }));
        const held = this.#buttons.get(key);
        if (held === undefined) {
            this.#buttons.set(key, { control: stable, holders: new Set([channel]) });
            this.#session.setButton(stable, true);
        } else {
            held.holders.add(channel);
        }
        channel.buttons.set(key, stable);
    }

    #release(channel: ChannelState, control: PsxButtonControl): void {
        this.#assertChannel(channel);
        if (!isPsxButtonControl(control)) throw invalid("PsxInput release requires a button control.", control);
        this.#releaseButton(channel, buttonKey(control));
    }

    #releaseButton(channel: ChannelState, key: string): void {
        if (!channel.buttons.has(key)) return;
        const held = this.#buttons.get(key);
        channel.buttons.delete(key);
        if (held === undefined) return;
        held.holders.delete(channel);
        if (held.holders.size === 0) {
            this.#buttons.delete(key);
            this.#session.setButton(held.control, false);
        }
    }

    #releaseEveryHolder(key: string): void {
        const held = this.#buttons.get(key);
        if (held === undefined) return;
        for (const holder of [...held.holders]) {
            holder.buttons.delete(key);
            held.holders.delete(holder);
        }
        this.#buttons.delete(key);
        this.#session.setButton(held.control, false);
    }

    #setAxis(channel: ChannelState, control: PsxAxisControl, value: number): void {
        this.#assertChannel(channel);
        if (!isPsxAxisControl(control) || !Number.isFinite(value)) {
            throw invalid("PsxInput setAxis requires an axis control and finite value.", { control, value });
        }
        const stable = Object.freeze({ ...control });
        const key = axisKey(stable);
        const normalized = Math.max(-1, Math.min(1, value));
        const state: AxisState = { control: stable, value: normalized, sequence: ++this.#sequence, owner: channel };
        channel.axes.set(key, state);
        const owners = this.#axes.get(key) ?? new Map<ChannelState, AxisState>();
        owners.set(channel, state);
        this.#axes.set(key, owners);
        this.#forwardAxis(key, state);
    }

    #releaseAxis(channel: ChannelState, key: string): void {
        const state = channel.axes.get(key);
        if (state === undefined) return;
        channel.axes.delete(key);
        const owners = this.#axes.get(key);
        if (owners === undefined) return;
        owners.delete(channel);
        if (owners.size === 0) {
            this.#axes.delete(key);
            const effective = this.#effectiveAxes.get(key);
            this.#effectiveAxes.delete(key);
            if (effective !== undefined && effective.value !== 0) this.#session.setAxis(effective.control, 0);
            return;
        }
        const next = [...owners.values()].sort((left, right) => right.sequence - left.sequence)[0]!;
        if (this.#effectiveAxes.get(key)?.owner === channel) this.#forwardAxis(key, next);
    }

    #forwardAxis(key: string, state: AxisState): void {
        const previous = this.#effectiveAxes.get(key);
        this.#effectiveAxes.set(key, state);
        if (previous?.value !== state.value || previous.owner !== state.owner) {
            this.#session.setAxis(state.control, state.value);
        }
    }

    #releaseChannel(channel: ChannelState): void {
        this.#assertChannel(channel);
        for (const key of [...channel.buttons.keys()].sort()) this.#releaseButton(channel, key);
        for (const key of [...channel.axes.keys()].sort()) this.#releaseAxis(channel, key);
    }

    #destroyChannel(channel: ChannelState): void {
        this.#assertLive();
        if (channel.destroyed) return;
        this.#releaseChannel(channel);
        channel.destroyed = true;
        this.#channels.delete(channel);
    }

    #assertChannel(channel: ChannelState): void {
        this.#assertLive();
        if (channel.destroyed) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "The PlayStation input channel has been destroyed.",
        });
    }

    #assertLive(): void {
        if (this.#destroyed) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "The PlayStation input coordinator has been destroyed.",
        });
    }
}
