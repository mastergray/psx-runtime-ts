import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";

import MenuGestureDetector from "../../ui/PresentationMode/MenuGestureDetector.ts";
import { isUiQuickStatePreferences } from "../../ui/types.ts";

import type { UiMenuGestureSample } from "../../ui/PresentationMode/types.ts";
import type { TestFile } from "../run.ts";

const pad = (id: string, pressed: ReadonlyArray<number>, length = 16): UiMenuGestureSample => ({
    id,
    buttons: Array.from({ length }, (_, index) => pressed.includes(index)),
});

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
    ],
};

export default testFile;
