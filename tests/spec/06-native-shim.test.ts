import { execFileSync } from "node:child_process";

import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";

import type { TestFile } from "../run.ts";

const testFile: TestFile = {
    label: "M2 native libretro shim",
    cases: [
        {
            label: "the narrow C ABI passes lifecycle, AV, input, state, card, and disc tests",
            run: () => CTGTest.init("native shim")
                .stage("compile and run the synthetic libretro core", () => {
                    const output = execFileSync(
                        process.execPath,
                        ["scripts/test-native-shim.mjs"],
                        { cwd: new URL("../../", import.meta.url), encoding: "utf8" },
                    );
                    return JSON.parse(output.trim()) as unknown;
                })
                .assert("native result", (state) => state.subject, P.equals<unknown>({
                    ok: true,
                    lifecycleRuns: 2,
                    dynamicGeometry: true,
                    cards: 2,
                    discs: 2,
                }))
                .start(undefined),
        },
    ],
};

export default testFile;
