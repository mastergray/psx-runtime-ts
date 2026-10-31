import { readFile } from "node:fs/promises";

import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";

import type { TestFile } from "../run.ts";

const readJson = async (path: URL): Promise<unknown> =>
    JSON.parse(await readFile(path, "utf8")) as unknown;

const evidence = await readJson(new URL("../../docs/probes/m0-results.json", import.meta.url));
const candidates = await readJson(new URL("../../core/probes/candidates.json", import.meta.url));
const productionSource = await readJson(new URL("../../core/SOURCE.json", import.meta.url));
const fixtureToolchain = await readJson(new URL("../../fixtures/homebrew/TOOLCHAIN.json", import.meta.url));
const emsdkVersion = (await readFile(
    new URL("../../core/EMSDK_VERSION", import.meta.url),
    "utf8",
)).trim();

interface EvidenceSummary {
    allFixtureVariantsPinned: boolean;
    allProbesPass: boolean;
    biosPass: boolean;
    buildsPass: boolean;
    candidatePinsAgree: boolean;
    cardsPass: boolean;
    decisionFinal: boolean;
    enduranceCases: number;
    enduranceDeterministic: boolean;
    enduranceNoDropsOrUnderruns: boolean;
    enduranceNonIsolated: boolean;
    endurancePass: boolean;
    fixtureBuildsCompared: number;
    fixtureByteIdentical: boolean;
    fixtureCompiler: string;
    fixtureSdkVersion: string;
    fixtureSourcePinned: boolean;
    geometryPass: boolean;
    mediaPass: boolean;
    nearMaximumDiscPass: boolean;
    productionEmsdkPinned: boolean;
    productionSourcePinned: boolean;
    remainingProbes: number;
    sourceVerificationPass: boolean;
    stateAndDiscPass: boolean;
    status: string;
    winner: string;
    workerfsCorrect: boolean;
}

const testFile: TestFile = {
    label: "M0 feasibility evidence",
    cases: [
        {
            label: "records a final candidate decision backed by all twelve probes",
            run: () => CTGTest.init("M0 evidence")
                .assert(
                    "decision, evidence, and production pins",
                    () => {
                        const result = evidence as {
                            builds: { pass: boolean };
                            candidates: Record<string, { commit: string; tree: string }>;
                            decision: {
                                final: boolean;
                                remainingProbeIds: string[];
                                winner: string;
                            };
                            endurance: {
                                aggregate: {
                                    keptRealtime: boolean;
                                    missingVideoCallbacks: number;
                                    nullVideoFrames: number;
                                    simulatedAudioUnderrunFrames: number;
                                };
                                cases: unknown[];
                                crossOriginIsolated: boolean;
                                deterministic: Record<string, { repeatableAcrossCadencesAndRuns: boolean }>;
                                pass: boolean;
                            };
                            fixture: {
                                byteIdentical: boolean;
                                cleanBuildsCompared: number;
                                variants: Record<string, { binSha256: string; cueSha256: string }>;
                            };
                            geometry: { pass: boolean };
                            media: { pass: boolean };
                            memoryCards: { pass: boolean };
                            nearMaximumDisc: { noFullDiscCopy: boolean; pass: boolean };
                            probeStatus: Record<string, string>;
                            realBiosBoot: { pass: boolean; realBiosLoaded: boolean };
                            sourceVerification: { pass: boolean };
                            stateAndDisc: { pass: boolean };
                            status: string;
                            workerfs: { correct: boolean };
                        };
                        const manifest = candidates as {
                            candidates: Array<{ commit: string; id: string; tree: string }>;
                        };
                        const selectedSource = productionSource as {
                            commit: string;
                            repository: string;
                            tree: string;
                        };
                        const toolchain = fixtureToolchain as {
                            archiveSha256: string;
                            compiler: string;
                            version: string;
                        };
                        const fixtureVariants = Object.values(result.fixture.variants);

                        return {
                            allFixtureVariantsPinned: fixtureVariants.length === 7
                                && fixtureVariants.every(({ binSha256, cueSha256 }) =>
                                    /^[a-f0-9]{64}$/u.test(binSha256)
                                    && /^[a-f0-9]{64}$/u.test(cueSha256)),
                            allProbesPass: Object.keys(result.probeStatus).length === 12
                                && Object.values(result.probeStatus).every((status) => status === "pass"),
                            biosPass: result.realBiosBoot.pass && result.realBiosBoot.realBiosLoaded,
                            buildsPass: result.builds.pass,
                            candidatePinsAgree: manifest.candidates.every(({ commit, id, tree }) =>
                                result.candidates[id]?.commit === commit
                                && result.candidates[id]?.tree === tree),
                            cardsPass: result.memoryCards.pass,
                            decisionFinal: result.decision.final,
                            enduranceCases: result.endurance.cases.length,
                            enduranceDeterministic: Object.values(result.endurance.deterministic)
                                .every(({ repeatableAcrossCadencesAndRuns }) => repeatableAcrossCadencesAndRuns),
                            enduranceNoDropsOrUnderruns: result.endurance.aggregate.missingVideoCallbacks === 0
                                && result.endurance.aggregate.nullVideoFrames === 0
                                && result.endurance.aggregate.simulatedAudioUnderrunFrames === 0
                                && result.endurance.aggregate.keptRealtime,
                            enduranceNonIsolated: !result.endurance.crossOriginIsolated,
                            endurancePass: result.endurance.pass,
                            fixtureBuildsCompared: result.fixture.cleanBuildsCompared,
                            fixtureByteIdentical: result.fixture.byteIdentical,
                            fixtureCompiler: toolchain.compiler,
                            fixtureSdkVersion: toolchain.version,
                            fixtureSourcePinned: /^[a-f0-9]{64}$/u.test(toolchain.archiveSha256),
                            geometryPass: result.geometry.pass,
                            mediaPass: result.media.pass,
                            nearMaximumDiscPass: result.nearMaximumDisc.pass
                                && result.nearMaximumDisc.noFullDiscCopy,
                            productionEmsdkPinned: emsdkVersion === "6.0.2",
                            productionSourcePinned: selectedSource.repository
                                === "https://github.com/notaz/pcsx_rearmed.git"
                                && selectedSource.commit === result.candidates["pcsx-rearmed"]?.commit
                                && selectedSource.tree === result.candidates["pcsx-rearmed"]?.tree,
                            remainingProbes: result.decision.remainingProbeIds.length,
                            sourceVerificationPass: result.sourceVerification.pass,
                            stateAndDiscPass: result.stateAndDisc.pass,
                            status: result.status,
                            winner: result.decision.winner,
                            workerfsCorrect: result.workerfs.correct,
                        };
                    },
                    P.equals<EvidenceSummary>({
                        allFixtureVariantsPinned: true,
                        allProbesPass: true,
                        biosPass: true,
                        buildsPass: true,
                        candidatePinsAgree: true,
                        cardsPass: true,
                        decisionFinal: true,
                        enduranceCases: 8,
                        enduranceDeterministic: true,
                        enduranceNoDropsOrUnderruns: true,
                        enduranceNonIsolated: true,
                        endurancePass: true,
                        fixtureBuildsCompared: 2,
                        fixtureByteIdentical: true,
                        fixtureCompiler: "mipsel-none-elf-gcc (GCC) 11.1.0",
                        fixtureSdkVersion: "0.19",
                        fixtureSourcePinned: true,
                        geometryPass: true,
                        mediaPass: true,
                        nearMaximumDiscPass: true,
                        productionEmsdkPinned: true,
                        productionSourcePinned: true,
                        remainingProbes: 0,
                        sourceVerificationPass: true,
                        stateAndDiscPass: true,
                        status: "complete",
                        winner: "pcsx-rearmed",
                        workerfsCorrect: true,
                    }),
                )
                .start(undefined),
        },
    ],
};

export default testFile;
