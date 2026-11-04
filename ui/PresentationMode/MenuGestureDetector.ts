// Type dependencies:
import type { UiMenuGestureSample } from "./types.js"; // Physical pad samples inspected for the menu chord

/**
 *
 * Class
 *
 */

// Detects a configured full-button chord once per press for every connected gamepad.
export default class MenuGestureDetector {

    /* Instance Fields */
    private readonly _buttons: ReadonlyArray<number>;                     // Physical buttons required by the menu gesture
    private _previous = new Map<string, ReadonlyArray<boolean>>();        // Prior physical state by browser device identity

    // CONSTRUCTOR :: [NUMBER] -> menuGestureDetector
    // Retains one non-empty physical-button chord.
    constructor(buttons: ReadonlyArray<number>) {
        if (buttons.length === 0 || buttons.some((button) => !Number.isInteger(button) || button < 0)) {
            throw new TypeError("A menu gesture requires non-negative physical button indices.");
        }
        this._buttons = Object.freeze([...new Set(buttons)]);
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: uiMenuGestureSample -> BOOLEAN
    // True when the sample exposes every configured physical button.
    supports(sample: UiMenuGestureSample): boolean {
        return this._buttons.every((button) => button < sample.buttons.length);
    }

    // METHOD :: [uiMenuGestureSample] -> [STRING]
    // Returns device identities whose complete chord changed from not-held to held.
    sample(samples: ReadonlyArray<UiMenuGestureSample>): ReadonlyArray<string> {
        const fired: string[] = [];
        for (const sample of samples) {
            if (!this.supports(sample)) continue;
            const previous = this._previous.get(sample.id);
            const held = this._buttons.every((button) => sample.buttons[button] === true);
            const previouslyHeld = previous !== undefined
                && this._buttons.every((button) => previous[button] === true);
            if (held && !previouslyHeld) fired.push(sample.id);
        }
        this._previous = new Map(samples.map(({ id, buttons }) => [id, Object.freeze([...buttons])]));
        return Object.freeze(fired);
    }

    // METHOD :: VOID -> VOID
    // Clears retained edges when Presentation polling stops.
    reset(): void { this._previous.clear(); }
}
