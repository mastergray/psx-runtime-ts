import { readFile } from "node:fs/promises";

import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";
import {
    buildIdFor,
    buildIdentityFor,
    buildInfoFor,
    isPsxBuildIdentity,
    isPsxBuildRecipe,
    isPsxSourceIdentity,
    isPsxToolchainIdentity,
} from "../../scripts/core-build/buildInfo.ts";
import { isPsxBuildInfo } from "../../src/index.ts";

import type {
    PsxBuildRecipe,
    PsxSourceIdentity,
    PsxToolchainIdentity,
} from "../../scripts/core-build/buildInfo.ts";
import type { TestFile } from "../run.ts";

const readJson = async (path: string): Promise<unknown> =>
    JSON.parse(await readFile(new URL(`../../${path}`, import.meta.url), "utf8")) as unknown;

const recipeValue = await readJson("core/build.json");
const sourceValue = await readJson("core/SOURCE.json");
const toolchainValue = await readJson("core/probes/toolchain.json");
const evidenceValue = await readJson("docs/probes/m0-results.json");
const emsdkVersion = (await readFile(new URL("../../core/EMSDK_VERSION", import.meta.url), "utf8")).trim();

if (!isPsxBuildRecipe(recipeValue)) throw new TypeError("Invalid committed core/build.json");
if (!isPsxSourceIdentity(sourceValue)) throw new TypeError("Invalid committed core/SOURCE.json");

const recipe: PsxBuildRecipe = recipeValue;
const source: PsxSourceIdentity = sourceValue;
const toolchain: PsxToolchainIdentity = {
    version: emsdkVersion,
    emsdkCommit: (toolchainValue as { emsdkCommit: string }).emsdkCommit,
    emscriptenReleaseCommit: (toolchainValue as { emscriptenReleaseCommit: string }).emscriptenReleaseCommit,
    emccCommit: (toolchainValue as { emccCommit: string }).emccCommit,
};
const shimHash = "a".repeat(64);
const identity = buildIdentityFor(recipe, source, toolchain, [], shimHash);

const testFile: TestFile = {
    label: "M1 deterministic build metadata",
    cases: [
        {
            label: "the committed recipe and selected source/toolchain identities validate",
            run: () => CTGTest.init("committed inputs")
                .assert("all inputs are pinned", () => ({
                    recipe: isPsxBuildRecipe(recipe),
                    source: isPsxSourceIdentity(source),
                    toolchain: isPsxToolchainIdentity(toolchain),
                    identity: isPsxBuildIdentity(identity),
                    commitAgrees: source.commit === "9f8b028cd66200bb9a18a878a5e73925a629b0a7",
                    emsdkAgrees: toolchain.version === "6.0.2",
                    memory: recipe.memory,
                    noThreads: recipe.pthreads === false,
                }), P.equals<unknown>({
                    recipe: true,
                    source: true,
                    toolchain: true,
                    identity: true,
                    commitAgrees: true,
                    emsdkAgrees: true,
                    memory: { initialPages: 1024, maximumPages: 8192 },
                    noThreads: true,
                }))
                .start(undefined),
        },
        {
            label: "build IDs are stable across object order and sensitive to every material input class",
            run: () => CTGTest.init("build ID")
                .assert("stable SHA-256 identity", () => {
                    const reversedSource: PsxSourceIdentity = {
                        ...source,
                        submodules: Object.fromEntries(Object.entries(source.submodules).reverse()),
                    };
                    const base = buildIdFor(identity);
                    const ids = {
                        reordered: buildIdFor(buildIdentityFor(recipe, reversedSource, toolchain, [], shimHash)),
                        source: buildIdFor({ ...identity, source: { ...source, tree: "b".repeat(40) } }),
                        patch: buildIdFor({ ...identity, patches: [{ name: "0001.patch", sha256: "c".repeat(64) }] }),
                        shim: buildIdFor({ ...identity, shimSha256: "d".repeat(64) }),
                        toolchain: buildIdFor({ ...identity, toolchain: { ...toolchain, emccCommit: "e".repeat(40) } }),
                        make: buildIdFor({ ...identity, makeArguments: [...identity.makeArguments, "DEBUG=0"] }),
                        compile: buildIdFor({ ...identity, compileFlags: [...identity.compileFlags, "-g0"] }),
                        link: buildIdFor({ ...identity, linkFlags: [...identity.linkFlags, "-flto"] }),
                        memory: buildIdFor({ ...identity, memory: { ...identity.memory, maximumPages: 8191 } }),
                    };
                    return {
                        hex: /^[a-f0-9]{64}$/u.test(base),
                        stable: ids.reordered === base,
                        allMaterialChangesDiffer: Object.entries(ids)
                            .filter(([name]) => name !== "reordered")
                            .every(([, id]) => id !== base),
                        excludesLocalPath: !JSON.stringify(identity).includes("/home/"),
                        excludesTimestamp: !Object.keys(identity).some((key) => /time|date/iu.test(key)),
                    };
                }, P.equals<unknown>({
                    hex: true,
                    stable: true,
                    allMaterialChangesDiffer: true,
                    excludesLocalPath: true,
                    excludesTimestamp: true,
                }))
                .start(undefined),
        },
        {
            label: "assembled build.json metadata satisfies the public predicate and owns independent arrays",
            run: () => CTGTest.init("build info")
                .assert("generated public metadata", () => {
                    const id = buildIdFor(identity);
                    const info = buildInfoFor(recipe, source, emsdkVersion, id);
                    return {
                        valid: isPsxBuildInfo(info),
                        id: info.buildId === id,
                        adapter: info.adapter,
                        coreCommit: info.coreCommit,
                        artifacts: [...info.artifacts],
                        memory: info.memory,
                        arraysAreCopies: info.artifacts !== recipe.artifacts
                            && info.licenses !== recipe.licenses
                            && info.firmware.byteLengths !== recipe.firmware.byteLengths,
                    };
                }, P.equals<unknown>({
                    valid: true,
                    id: true,
                    adapter: "libretro-psx",
                    coreCommit: "9f8b028cd66200bb9a18a878a5e73925a629b0a7",
                    artifacts: ["psx-core.js", "psx-core.wasm", "core.worker.js"],
                    memory: { initialPages: 1024, maximumPages: 8192 },
                    arraysAreCopies: true,
                }))
                .start(undefined),
        },
        {
            label: "M0 supplies the clean-build reproducibility evidence M1 consumes",
            run: () => CTGTest.init("reproducibility evidence")
                .assert("fixture and selected-core build evidence", () => {
                    const evidence = evidenceValue as {
                        builds: { pass: boolean; "pcsx-rearmed": { probeWasmSha256: string } };
                        fixture: { byteIdentical: boolean; cleanBuildsCompared: number };
                    };
                    return {
                        fixtureBuilds: evidence.fixture.cleanBuildsCompared,
                        fixtureByteIdentical: evidence.fixture.byteIdentical,
                        selectedCoreBuildPass: evidence.builds.pass,
                        selectedCoreArtifactPinned: /^[a-f0-9]{64}$/u.test(evidence.builds["pcsx-rearmed"].probeWasmSha256),
                    };
                }, P.equals<unknown>({
                    fixtureBuilds: 2,
                    fixtureByteIdentical: true,
                    selectedCoreBuildPass: true,
                    selectedCoreArtifactPinned: true,
                }))
                .start(undefined),
        },
    ],
};

export default testFile;
