import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";
import * as runtime from "../../src/index.ts";

import type { TestFile } from "../run.ts";

const testFile: TestFile = {
    label: "package scaffold",
    cases: [
        {
            label: "the public entry point loads as an ES module",
            run: () => CTGTest.init("public entry point")
                .assert(
                    "package identity",
                    () => ({ packageName: runtime.PACKAGE_NAME }),
                    P.equals<{ packageName: string }>({ packageName: "psx-runtime-ts" }),
                )
                .start(undefined),
        },
    ],
};

export default testFile;
