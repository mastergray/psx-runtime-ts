import { readFile } from "node:fs/promises";

import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";

import type { TestFile } from "../run.ts";

const readJson = async (path: URL): Promise<unknown> =>
    JSON.parse(await readFile(path, "utf8")) as unknown;

const evidence = await readJson(new URL("../../docs/probes/m0-results.json", import.meta.url));
const candidates = await readJson(new URL("../../core/probes/candidates.json", import.meta.url));
const fixtureToolchain = await readJson(new URL("../../fixtures/homebrew/TOOLCHAIN.json", import.meta.url));

interface EvidenceSummary {
    candidatePinsAgree: boolean;
    fixtureBuildsCompared: number;
    fixtureByteIdentical: boolean;
    fixtureCompiler: string;
    fixtureSdkVersion: string;
    fixtureSourcePinned: boolean;
    final: boolean;
    status: string;
    winner: string;
    workerfsCorrect: boolean;
}

const testFile: TestFile = {
    label: "M0 feasibility evidence",
    cases: [
        {
            label: "records a provisional candidate decision backed by reproducible inputs",
            run: () => CTGTest.init("M0 evidence")
                .assert(
                    "decision and source pins",
                    () => {
                        const result = evidence as {
                            status: string;
                            fixture: { byteIdentical: boolean; cleanBuildsCompared: number };
                            candidates: Record<string, { commit: string }>;
                            provisionalDecision: { final: boolean; winner: string };
                            workerfs: { correct: boolean };
                        };
                        const manifest = candidates as {
                            candidates: Array<{ commit: string; id: string }>;
                        };
                        const toolchain = fixtureToolchain as {
                            archiveSha256: string;
                            compiler: string;
                            version: string;
                        };

                        return {
                            candidatePinsAgree: manifest.candidates.every(
                                ({ commit, id }) => result.candidates[id]?.commit === commit,
                            ),
                            fixtureBuildsCompared: result.fixture.cleanBuildsCompared,
                            fixtureByteIdentical: result.fixture.byteIdentical,
                            fixtureCompiler: toolchain.compiler,
                            fixtureSdkVersion: toolchain.version,
                            fixtureSourcePinned: /^[a-f0-9]{64}$/u.test(toolchain.archiveSha256),
                            final: result.provisionalDecision.final,
                            status: result.status,
                            winner: result.provisionalDecision.winner,
                            workerfsCorrect: result.workerfs.correct,
                        };
                    },
                    P.equals<EvidenceSummary>({
                        candidatePinsAgree: true,
                        fixtureBuildsCompared: 2,
                        fixtureByteIdentical: true,
                        fixtureCompiler: "mipsel-none-elf-gcc (GCC) 11.1.0",
                        fixtureSdkVersion: "0.19",
                        fixtureSourcePinned: true,
                        final: false,
                        status: "in-progress",
                        winner: "pcsx-rearmed",
                        workerfsCorrect: true,
                    }),
                )
                .start(undefined),
        },
    ],
};

export default testFile;
