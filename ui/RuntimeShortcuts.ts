// Type dependencies:
import type {
    ControllerPort,    // Controller whose same-player chord activates one shortcut
    PsxButton,         // Logical button inspected in an effective input snapshot
    PsxButtonControl,  // Effective pressed-button record supplied by PsxInput
    PsxPlaybackRate,   // Supported normal and accelerated execution multiplier
} from "../src/index.js";
import type { UiQuickStateSlot } from "./types.js"; // Persistent quick-state assignment selected by a shortcut

const CONTROLLER_PORTS = Object.freeze([1, 2] as const);
const FAST_FORWARD_RATES = Object.freeze([2, 5, 7] as const);

/**
 *
 * Type Declarations
 *
 */

// TYPE :: "save"|"load"
// State operation requested by one R3 and shoulder-button rising edge.
export type RuntimeQuickStateAction = "save" | "load";

// INTERFACE :: {setPlaybackRate:(psxPlaybackRate -> VOID), selectFastForwardRate:(psxPlaybackRate -> VOID), runQuickState:(runtimeQuickStateAction, uiQuickStateSlot -> VOID)}
// Application operations invoked by the input-only shortcut interpreter.
export interface RuntimeShortcutsConfig {
    readonly setPlaybackRate: (rate: PsxPlaybackRate) => void; // Applies a changed hold multiplier
    readonly selectFastForwardRate: (rate: PsxPlaybackRate) => void; // Reports a newly cycled multiplier
    readonly runQuickState: (action: RuntimeQuickStateAction, slot: UiQuickStateSlot) => void; // Runs one edge-triggered state operation
}

/**
 *
 * Class
 *
 */

// Interprets same-player L3/R3 shoulder chords independently of each physical input source.
export default class RuntimeShortcuts {

    /* Instance Fields */
    private readonly _config: RuntimeShortcutsConfig;          // Runtime operations receiving interpreted shortcut changes
    private readonly _held = new Set<string>();                // Edge-triggered shortcut keys held during the prior sample
    private _selectedFastForwardRate: PsxPlaybackRate = 2;     // Multiplier used by the L3 and R1 hold chord
    private _requestedPlaybackRate: PsxPlaybackRate = 1;       // Last multiplier sent to the application

    // CONSTRUCTOR :: runtimeShortcutsConfig -> runtimeShortcuts
    // Retains application callbacks while keeping input interpretation deterministic and browser independent.
    constructor(config: RuntimeShortcutsConfig) {
        this._config = config;
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> psxPlaybackRate
    // Returns the multiplier currently selected for the L3 and R1 hold chord.
    get selectedFastForwardRate(): PsxPlaybackRate { return this._selectedFastForwardRate; }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: [psxButtonControl], BOOLEAN -> VOID
    // Interprets one effective input sample or releases every shortcut when the runtime is inactive.
    update(snapshot: ReadonlyArray<PsxButtonControl>, active: boolean): void {
        if (!active) {
            this.reset();
            return;
        }

        const activeEdges = new Set<string>();
        for (const port of CONTROLLER_PORTS) {
            const l3 = hasButton(snapshot, port, "l3");
            const r3 = hasButton(snapshot, port, "r3");
            if (l3 && hasButton(snapshot, port, "r2")) {
                this._onPress(activeEdges, `${port}:cycle-fast-forward`, () => this._cycleFastForwardRate());
            }
            if (r3 && hasButton(snapshot, port, "l1")) {
                this._onPress(activeEdges, `${port}:save-quick-state-1`, () => this._config.runQuickState("save", 1));
            }
            if (r3 && hasButton(snapshot, port, "l2")) {
                this._onPress(activeEdges, `${port}:save-quick-state-2`, () => this._config.runQuickState("save", 2));
            }
            if (r3 && hasButton(snapshot, port, "r1")) {
                this._onPress(activeEdges, `${port}:load-quick-state-1`, () => this._config.runQuickState("load", 1));
            }
            if (r3 && hasButton(snapshot, port, "r2")) {
                this._onPress(activeEdges, `${port}:load-quick-state-2`, () => this._config.runQuickState("load", 2));
            }
        }
        this._held.clear();
        activeEdges.forEach((shortcut) => this._held.add(shortcut));

        const requestedRates: PsxPlaybackRate[] = [1];
        for (const port of CONTROLLER_PORTS) {
            if (!hasButton(snapshot, port, "l3")) continue;
            if (hasButton(snapshot, port, "l1")) requestedRates.push(2);
            if (hasButton(snapshot, port, "l2")) requestedRates.push(7);
            if (hasButton(snapshot, port, "r1")) requestedRates.push(this._selectedFastForwardRate);
        }
        this._requestPlaybackRate(Math.max(...requestedRates) as PsxPlaybackRate);
    }

    // METHOD :: VOID -> VOID
    // Clears held edges and restores normal execution after a session or input lifecycle boundary.
    reset(): void {
        this._held.clear();
        this._requestPlaybackRate(1);
    }

    // METHOD :: SET<STRING>, STRING, (VOID -> VOID) -> VOID
    // Invokes an action once when a complete shortcut changes from released to held.
    private _onPress(active: Set<string>, key: string, action: () => void): void {
        active.add(key);
        if (!this._held.has(key)) action();
    }

    // METHOD :: VOID -> VOID
    // Advances the selected hold rate through every supported accelerated multiplier.
    private _cycleFastForwardRate(): void {
        const index = FAST_FORWARD_RATES.indexOf(
            this._selectedFastForwardRate as typeof FAST_FORWARD_RATES[number],
        );
        this._selectedFastForwardRate = FAST_FORWARD_RATES[(index + 1) % FAST_FORWARD_RATES.length]!;
        this._config.selectFastForwardRate(this._selectedFastForwardRate);
    }

    // METHOD :: psxPlaybackRate -> VOID
    // Sends only changed execution multipliers to avoid resetting audio repeatedly during a hold.
    private _requestPlaybackRate(rate: PsxPlaybackRate): void {
        if (rate === this._requestedPlaybackRate) return;
        this._requestedPlaybackRate = rate;
        this._config.setPlaybackRate(rate);
    }
}

/**
 *
 *  Helper Functions
 *
 */

// HELPER :: [psxButtonControl], controllerPort, psxButton -> BOOLEAN
// True when one effective input snapshot contains the requested same-player button.
const hasButton = (
    snapshot: ReadonlyArray<PsxButtonControl>,
    port: ControllerPort,
    button: PsxButton,
): boolean => snapshot.some((control) => control.port === port && control.button === button);
