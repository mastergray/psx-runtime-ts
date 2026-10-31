import { readdirSync } from "node:fs";
import {
    CTGTestConsoleFormatter,
    CTGTestResult,
} from "ctg-js-test";

import type { CTGTestState } from "ctg-js-test";

type SuiteName = "spec" | "browser";

export interface TestCase {
    label: string;
    run: () => Promise<CTGTestState>;
}

export interface TestFile {
    label: string;
    skip?: string;
    cases: TestCase[];
}

interface Tally {
    files: number;
    cases: number;
    passed: number;
    failed: number;
    skipped: number;
}

const { STATUS } = CTGTestResult;
const TEST_ROOT = new URL("./", import.meta.url);
const TEST_FILE_PATTERN = /\.test\.ts$/;
const VALID_SUITES = ["spec", "browser"] as const;

const requestedSuites = (args: string[]): SuiteName[] | null => {
    const suites = args.filter((arg): arg is SuiteName => (VALID_SUITES as readonly string[]).includes(arg));
    return suites.length === args.length && suites.length > 0 ? suites : null;
};

const testFilesFor = (suite: SuiteName): string[] =>
    readdirSync(new URL(`${suite}/`, TEST_ROOT))
        .filter((name) => TEST_FILE_PATTERN.test(name))
        .sort((a, b) => a.localeCompare(b));

const runTestFile = async (tally: Tally, suite: SuiteName, fileName: string): Promise<void> => {
    const filePath = `tests/${suite}/${fileName}`;
    let testFile: TestFile;

    tally.files++;

    try {
        testFile = ((await import(new URL(`${suite}/${fileName}`, TEST_ROOT).href)) as { default: TestFile }).default;
    } catch (error) {
        tally.cases++;
        tally.failed++;
        console.log(`FAIL ${filePath} :: could not load`);
        console.error(error);
        return;
    }

    tally.cases += testFile.cases.length;

    if (testFile.skip !== undefined) {
        tally.skipped += testFile.cases.length;
        console.log(`SKIP ${filePath} :: ${testFile.label} -- ${testFile.skip}`);
        return;
    }

    for (const testCase of testFile.cases) {
        const line = `${filePath} :: ${testFile.label} :: ${testCase.label}`;

        try {
            const state = await testCase.run();
            if (state.status === STATUS.PASS) {
                tally.passed++;
                console.log(`PASS ${line}`);
                continue;
            }
            tally.failed++;
            console.log(`FAIL ${line}`);
            console.log(CTGTestConsoleFormatter.format(state));
        } catch (error) {
            tally.failed++;
            console.log(`FAIL ${line}`);
            console.error(error);
        }
    }
};

const main = async (): Promise<void> => {
    const suites = requestedSuites(process.argv.slice(2));
    if (suites === null) {
        console.error(`Usage: tsx tests/run.ts <${VALID_SUITES.join("|")}> ...`);
        process.exitCode = 1;
        return;
    }

    const tally: Tally = { files: 0, cases: 0, passed: 0, failed: 0, skipped: 0 };
    for (const suite of suites) {
        for (const fileName of testFilesFor(suite)) {
            await runTestFile(tally, suite, fileName);
        }
    }

    console.log(`TALLY files=${tally.files} cases=${tally.cases} passed=${tally.passed} failed=${tally.failed} skipped=${tally.skipped}`);
    process.exitCode = tally.failed === 0 ? 0 : 1;
};

await main();
