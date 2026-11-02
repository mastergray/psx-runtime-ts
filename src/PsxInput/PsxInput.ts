// Dependencies:
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Reports invalid input and destroyed lifecycle use
import {
    isPsxAxisControl,       // Validates analog control coordinates
    isPsxButtonControl,     // Validates digital control coordinates
} from "../shared.types.js";
import { isPsxInputConfig } from "./types.js";                         // Validates the injected emulation session

// Type dependencies:
import type {
    Listener,            // Observer accepted by session event streams
    PsxAxisControl,      // Physical port and analog-axis coordinate
    PsxButtonControl,    // Physical port and digital-button coordinate
    PsxMachineInfo,      // Immutable identity of the active emulation session
    PsxRumbleEvent,      // Strong and weak motor command from the core
    Unsubscribe,         // Cleanup returned by an event subscription
} from "../shared.types.js";
import type {
    PsxInputChannel,     // Isolated ownership handle for one input source
    PsxInputConfig,      // Session dependency used by the coordinator
} from "./types.js";

/**
 *
 * Type Declarations
 *
 */

// TYPE :: {buttons:MAP, axes:MAP, destroyed:BOOLEAN}
// Controls owned by one independently releasable input source.
interface ChannelState {
    readonly buttons: Map<string, PsxButtonControl>;    // Digital controls currently held by this source
    readonly axes: Map<string, AxisState>;              // Last analog value supplied by this source
    destroyed: boolean;                                 // Whether this channel has relinquished ownership
}

// TYPE :: {control:psxButtonControl, holders:SET}
// Shared digital control and every channel that currently holds it.
interface HeldButton {
    readonly control: PsxButtonControl;     // Stable coordinate forwarded to the session
    readonly holders: Set<ChannelState>;    // Channels that must all release before key-up
}

// TYPE :: {control:psxAxisControl, value:NUMBER, sequence:NUMBER, owner:channelState}
// One channel's latest candidate value for a physical analog axis.
interface AxisState {
    readonly control: PsxAxisControl;    // Stable coordinate forwarded to the session
    value: number;                       // Normalized value in the inclusive -1 to 1 range
    sequence: number;                    // Monotonic precedence for competing sources
    readonly owner: ChannelState;        // Channel that supplied this value
}

const OPPOSITE: Readonly<Partial<Record<PsxButtonControl["button"], PsxButtonControl["button"]>>> = { // Mutually exclusive D-pad directions
    up: "down",
    down: "up",
    left: "right",
    right: "left",
};

// METHOD :: psxButtonControl -> STRING
// Produces the canonical ownership key for one digital control.
const buttonKey = ({ port, button }: PsxButtonControl): string => `${port}:${button}`;

// METHOD :: psxAxisControl -> STRING
// Produces the canonical ownership key for one analog control.
const axisKey = ({ port, axis }: PsxAxisControl): string => `${port}:${axis}`;

// METHOD :: STRING, UNKNOWN -> psxRuntimeError
// Creates one invalid input configuration or operation error.
const invalid = (message: string, data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.INVALID_CONFIG,
    message,
    data,
});

/**
 *
 * Class
 *
 */

// Coordinates multiple input sources into one deterministic PSX session state.
export default class PsxInput {

    /* Instance Fields */
    private readonly _session: PsxInputConfig["session"];                         // Active session receiving effective input state
    private readonly _channels = new Set<ChannelState>();                         // Live ownership channels
    private readonly _buttons = new Map<string, HeldButton>();                    // Effective digital controls and their owners
    private readonly _axes = new Map<string, Map<ChannelState, AxisState>>();      // Axis candidates grouped by physical coordinate
    private readonly _effectiveAxes = new Map<string, AxisState>();                // Candidate currently forwarded for each axis
    private readonly _defaultChannel: PsxInputChannel;                             // Backward-compatible direct-call ownership channel
    private _sequence = 0;                                                         // Monotonic precedence assigned to analog writes
    private _destroyed = false;                                                    // Whether session input ownership has ended

    // CONSTRUCTOR :: psxInputConfig -> psxInput
    // Validates the session dependency and creates the default ownership channel.
    constructor(config: PsxInputConfig) {
        if (!isPsxInputConfig(config)) throw invalid("PsxInput config must contain a live session.", config);
        this._session = config.session;
        this._defaultChannel = this.createChannel();
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> psxMachineInfo
    // Exposes the active machine identity from the session.
    get machine(): PsxMachineInfo {
        return this._session.machine;
    }

    // GETTER :: VOID -> [psxButtonControl]
    // Returns a stable immutable snapshot of effective digital controls.
    get snapshot(): ReadonlyArray<PsxButtonControl> {
        return Object.freeze([...this._buttons.values()]
            .map(({ control }) => Object.freeze({ ...control }))
            .sort((left, right) => buttonKey(left).localeCompare(buttonKey(right))));
    }

    // GETTER :: VOID -> [{control:psxAxisControl, value:NUMBER}]
    // Returns a stable immutable snapshot of effective analog controls.
    get axes(): ReadonlyArray<{ readonly control: PsxAxisControl; readonly value: number }> {
        return Object.freeze([...this._effectiveAxes.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([, state]) => Object.freeze({ control: Object.freeze({ ...state.control }), value: state.value })));
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: VOID -> psxInputChannel
    // Creates an isolated channel whose controls can be released as one unit.
    createChannel(): PsxInputChannel {
        this._assertLive();
        const state: ChannelState = { buttons: new Map(), axes: new Map(), destroyed: false };
        this._channels.add(state);
        return {
            press: (control) => this._press(state, control),
            release: (control) => this._release(state, control),
            setAxis: (control, value) => this._setAxis(state, control, value),
            releaseAll: () => this._releaseChannel(state),
            destroy: () => this._destroyChannel(state),
        };
    }

    // METHOD :: psxButtonControl -> VOID
    // Presses one control through the default ownership channel.
    press(control: PsxButtonControl): void {
        this._defaultChannel.press(control);
    }

    // METHOD :: psxButtonControl -> VOID
    // Releases one control from the default ownership channel.
    release(control: PsxButtonControl): void {
        this._defaultChannel.release(control);
    }

    // METHOD :: psxAxisControl, NUMBER -> VOID
    // Sets one analog value through the default ownership channel.
    setAxis(control: PsxAxisControl, value: number): void {
        this._defaultChannel.setAxis(control, value);
    }

    // METHOD :: VOID -> VOID
    // Releases controls owned by every live channel.
    releaseAll(): void {
        this._assertLive();
        for (const channel of [...this._channels]) this._releaseChannel(channel);
    }

    // METHOD :: listener -> unsubscribe
    // Subscribes to completed emulation ticks.
    onTick(listener: Listener<void>): Unsubscribe {
        this._assertLive();
        if (typeof listener !== "function") throw invalid("PsxInput onTick requires a listener.", listener);
        return this._session.onTick(listener);
    }

    // METHOD :: listener -> unsubscribe
    // Subscribes to core rumble events.
    onRumble(listener: Listener<PsxRumbleEvent>): Unsubscribe {
        this._assertLive();
        if (typeof listener !== "function") throw invalid("PsxInput onRumble requires a listener.", listener);
        return this._session.onRumble(listener);
    }

    // METHOD :: VOID -> VOID
    // Releases all state and permanently closes every channel.
    destroy(): void {
        if (this._destroyed) return;
        this.releaseAll();
        for (const channel of this._channels) channel.destroyed = true;
        this._channels.clear();
        this._destroyed = true;
    }

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: channelState, psxButtonControl -> VOID
    // Adds one channel as a holder and forwards the first effective press.
    private _press(channel: ChannelState, control: PsxButtonControl): void {
        this._assertChannel(channel);
        if (!isPsxButtonControl(control)) throw invalid("PsxInput press requires a button control.", control);
        const stable = Object.freeze({ ...control });
        const key = buttonKey(stable);
        if (channel.buttons.has(key)) return;
        const opposite = OPPOSITE[stable.button];
        if (opposite !== undefined) this._releaseEveryHolder(buttonKey({ port: stable.port, button: opposite }));
        const held = this._buttons.get(key);
        if (held === undefined) {
            this._buttons.set(key, { control: stable, holders: new Set([channel]) });
            this._session.setButton(stable, true);
        } else {
            held.holders.add(channel);
        }
        channel.buttons.set(key, stable);
    }

    // METHOD :: channelState, psxButtonControl -> VOID
    // Validates and releases one channel's digital control.
    private _release(channel: ChannelState, control: PsxButtonControl): void {
        this._assertChannel(channel);
        if (!isPsxButtonControl(control)) throw invalid("PsxInput release requires a button control.", control);
        this._releaseButton(channel, buttonKey(control));
    }

    // METHOD :: channelState, STRING -> VOID
    // Removes one holder and forwards release after the final owner leaves.
    private _releaseButton(channel: ChannelState, key: string): void {
        if (!channel.buttons.has(key)) return;
        const held = this._buttons.get(key);
        channel.buttons.delete(key);
        if (held === undefined) return;
        held.holders.delete(channel);
        if (held.holders.size === 0) {
            this._buttons.delete(key);
            this._session.setButton(held.control, false);
        }
    }

    // METHOD :: STRING -> VOID
    // Removes a mutually exclusive direction from every owning channel.
    private _releaseEveryHolder(key: string): void {
        const held = this._buttons.get(key);
        if (held === undefined) return;
        for (const holder of [...held.holders]) {
            holder.buttons.delete(key);
            held.holders.delete(holder);
        }
        this._buttons.delete(key);
        this._session.setButton(held.control, false);
    }

    // METHOD :: channelState, psxAxisControl, NUMBER -> VOID
    // Records one normalized axis candidate and gives it latest-write precedence.
    private _setAxis(channel: ChannelState, control: PsxAxisControl, value: number): void {
        this._assertChannel(channel);
        if (!isPsxAxisControl(control) || !Number.isFinite(value)) {
            throw invalid("PsxInput setAxis requires an axis control and finite value.", { control, value });
        }
        const stable = Object.freeze({ ...control });
        const key = axisKey(stable);
        const normalized = Math.max(-1, Math.min(1, value));
        const state: AxisState = { control: stable, value: normalized, sequence: ++this._sequence, owner: channel };
        channel.axes.set(key, state);
        const owners = this._axes.get(key) ?? new Map<ChannelState, AxisState>();
        owners.set(channel, state);
        this._axes.set(key, owners);
        this._forwardAxis(key, state);
    }

    // METHOD :: channelState, STRING -> VOID
    // Removes an axis candidate and restores the next-most-recent owner.
    private _releaseAxis(channel: ChannelState, key: string): void {
        const state = channel.axes.get(key);
        if (state === undefined) return;
        channel.axes.delete(key);
        const owners = this._axes.get(key);
        if (owners === undefined) return;
        owners.delete(channel);
        if (owners.size === 0) {
            this._axes.delete(key);
            const effective = this._effectiveAxes.get(key);
            this._effectiveAxes.delete(key);
            if (effective !== undefined && effective.value !== 0) this._session.setAxis(effective.control, 0);
            return;
        }
        const next = [...owners.values()].sort((left, right) => right.sequence - left.sequence)[0]!;
        if (this._effectiveAxes.get(key)?.owner === channel) this._forwardAxis(key, next);
    }

    // METHOD :: STRING, axisState -> VOID
    // Promotes and forwards one effective analog value when it changed.
    private _forwardAxis(key: string, state: AxisState): void {
        const previous = this._effectiveAxes.get(key);
        this._effectiveAxes.set(key, state);
        if (previous?.value !== state.value || previous.owner !== state.owner) {
            this._session.setAxis(state.control, state.value);
        }
    }

    // METHOD :: channelState -> VOID
    // Deterministically releases all digital and analog state for one channel.
    private _releaseChannel(channel: ChannelState): void {
        this._assertChannel(channel);
        for (const key of [...channel.buttons.keys()].sort()) this._releaseButton(channel, key);
        for (const key of [...channel.axes.keys()].sort()) this._releaseAxis(channel, key);
    }

    // METHOD :: channelState -> VOID
    // Releases and permanently removes one ownership channel.
    private _destroyChannel(channel: ChannelState): void {
        this._assertLive();
        if (channel.destroyed) return;
        this._releaseChannel(channel);
        channel.destroyed = true;
        this._channels.delete(channel);
    }

    // METHOD :: channelState -> VOID
    // Rejects operations through a closed channel or coordinator.
    private _assertChannel(channel: ChannelState): void {
        this._assertLive();
        if (channel.destroyed) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "The PlayStation input channel has been destroyed.",
        });
    }

    // METHOD :: VOID -> VOID
    // Rejects operations after coordinator destruction.
    private _assertLive(): void {
        if (this._destroyed) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "The PlayStation input coordinator has been destroyed.",
        });
    }
}
