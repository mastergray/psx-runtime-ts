import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";

import MenuGestureDetector from "../../ui/PresentationMode/MenuGestureDetector.ts";
import RuntimeShortcuts from "../../ui/RuntimeShortcuts.ts";
import { isUiQuickStatePreferences } from "../../ui/types.ts";

import type { PsxButton, PsxButtonControl, PsxPlaybackRate } from "../../src/index.ts";
import type { UiMenuGestureSample } from "../../ui/PresentationMode/types.ts";
import type { RuntimeQuickStateAction } from "../../ui/RuntimeShortcuts.ts";
import type { UiQuickStateSlot } from "../../ui/types.ts";
import type { TestFile } from "../run.ts";

const pad = (id: string, pressed: ReadonlyArray<number>, length = 16): UiMenuGestureSample => ({
    id,
    buttons: Array.from({ length }, (_, index) => pressed.includes(index)),
});

const controls = (port: 1 | 2, ...buttons: PsxButton[]): ReadonlyArray<PsxButtonControl> =>
    buttons.map((button) => ({ port, button }));

const testFile: TestFile = {
    label: "M13 Presentation mode",
    cases: [
        {
            label: "the menu gesture fires once on each complete L3 and R3 rising edge",
            run: () => CTGTest.init("presentation menu gesture")
                .stage("sample physical edges", () => {
                    const detector = new MenuGestureDetector([10, 11]);
                    const unsupported = pad("short", [], 8);
                    const sequence = [
                        detector.sample([pad("one", [10])]),
                        detector.sample([pad("one", [10, 11])]),
                        detector.sample([pad("one", [10, 11])]),
                        detector.sample([pad("one", [])]),
                        detector.sample([pad("one", [10, 11]), pad("two", [10, 11])]),
                    ];
                    detector.reset();
                    return {
                        unsupported: detector.supports(unsupported),
                        sequence,
                        afterReset: detector.sample([pad("one", [10, 11])]),
                    };
                })
                .assert("rising edges only", ({ subject }) => subject, P.equals<unknown>({
                    unsupported: false,
                    sequence: [[], ["one"], [], [], ["one", "two"]],
                    afterReset: ["one"],
                }))
                .start(undefined),
        },
        {
            label: "Play Mode quick-state assignments remain structurally validated",
            run: () => CTGTest.init("Play Mode quick-state preferences")
                .assert("validated storage boundary", () => ({
                    valid: isUiQuickStatePreferences({
                        version: 1,
                        games: { game: { 1: "Before boss", 2: "After boss" } },
                    }),
                    duplicate: isUiQuickStatePreferences({
                        version: 1,
                        games: { game: { 1: "Same", 2: "Same" } },
                    }),
                    unknownSlot: isUiQuickStatePreferences({
                        version: 1,
                        games: { game: { 3: "Unexpected" } },
                    }),
                    decomposed: isUiQuickStatePreferences({
                        version: 1,
                        games: { game: { 1: "Cafe\u0301" } },
                    }),
                }), P.equals<{ valid: boolean; duplicate: boolean; unknownSlot: boolean; decomposed: boolean }>({
                    valid: true,
                    duplicate: false,
                    unknownSlot: false,
                    decomposed: false,
                }))
                .start(undefined),
        },
        {
            label: "runtime fast-forward chords hold, cycle, and release on the same controller port",
            run: () => CTGTest.init("runtime fast-forward shortcuts")
                .stage("sample shortcut edges and holds", () => {
                    const rates: PsxPlaybackRate[] = [];
                    const selections: PsxPlaybackRate[] = [];
                    const shortcuts = new RuntimeShortcuts({
                        setPlaybackRate: (rate) => { rates.push(rate); },
                        selectFastForwardRate: (rate) => { selections.push(rate); },
                        runQuickState: () => undefined,
                    });
                    shortcuts.update(controls(1, "l3", "r1"), true);
                    shortcuts.update(controls(1, "l3", "r1"), true);
                    shortcuts.update([], true);
                    shortcuts.update(controls(1, "l3", "r2"), true);
                    shortcuts.update(controls(1, "l3", "r2"), true);
                    shortcuts.update([], true);
                    shortcuts.update(controls(1, "l3", "r1"), true);
                    shortcuts.update([], true);
                    shortcuts.update(controls(1, "l3", "l2"), true);
                    shortcuts.update([], true);
                    shortcuts.update([
                        ...controls(1, "l3"),
                        ...controls(2, "r1"),
                    ], true);
                    shortcuts.update(controls(1, "l3", "r1"), true);
                    shortcuts.update([], false);
                    return { rates, selections, selected: shortcuts.selectedFastForwardRate };
                })
                .assert("rate transitions", ({ subject }) => subject, P.equals<unknown>({
                    rates: [2, 1, 5, 1, 7, 1, 5, 1],
                    selections: [5],
                    selected: 5,
                }))
                .start(undefined),
        },
        {
            label: "runtime quick-state chords fire once per rising edge",
            run: () => CTGTest.init("runtime quick-state shortcuts")
                .stage("sample state shortcut edges", () => {
                    const actions: Array<readonly [RuntimeQuickStateAction, UiQuickStateSlot]> = [];
                    const shortcuts = new RuntimeShortcuts({
                        setPlaybackRate: () => undefined,
                        selectFastForwardRate: () => undefined,
                        runQuickState: (action, slot) => { actions.push([action, slot]); },
                    });
                    shortcuts.update(controls(1, "r3", "l1"), true);
                    shortcuts.update(controls(1, "r3", "l1"), true);
                    shortcuts.update([], true);
                    shortcuts.update(controls(2, "r3", "l2"), true);
                    shortcuts.update([], true);
                    shortcuts.update(controls(1, "r3", "r1"), true);
                    shortcuts.update([], true);
                    shortcuts.update(controls(2, "r3", "r2"), true);
                    shortcuts.update([], true);
                    shortcuts.update([
                        ...controls(1, "r3"),
                        ...controls(2, "l1"),
                    ], true);
                    return actions;
                })
                .assert("state operations", ({ subject }) => subject, P.equals<unknown>([
                    ["save", 1],
                    ["save", 2],
                    ["load", 1],
                    ["load", 2],
                ]))
                .start(undefined),
        },
    ],
};

export default testFile;
