import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const evidence = JSON.parse(await (await import("node:fs/promises")).readFile(
    resolve(root, "docs/probes/m0-results.json"),
    "utf8",
));
const work = await mkdtemp(resolve(tmpdir(), "psx-release-repro-"));

const runJson = (script, environment = {}) => {
    const result = spawnSync("npm", ["run", script], {
        cwd: root,
        env: { ...process.env, ...environment },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) throw new Error(`${script} failed\n${result.stdout}${result.stderr}`);
    const line = result.stdout.trim().split("\n").reverse().find((candidate) => candidate.startsWith("{"));
    if (line === undefined) throw new Error(`${script} did not produce a JSON result`);
    return JSON.parse(line);
};

const expectedFixture = Object.fromEntries(Object.entries(evidence.fixture.variants).map(([name, value]) => [
    ({
        dynamicGeometry: "dynamic-geometry",
        memoryCards: "memory-cards",
        multidiscOne: "multidisc-one",
        multidiscTwo: "multidisc-two",
        xaCdda: "xa-cdda",
    })[name] ?? name,
    value,
]));

try {
    if (!process.env.PSN00BSDK_ROOT) throw new Error("PSN00BSDK_ROOT is required for reproducibility verification");
    const fixtureOne = runJson("build:fixture");
    const fixtureTwo = runJson("build:fixture");
    if (JSON.stringify(fixtureOne) !== JSON.stringify(fixtureTwo)) {
        throw new Error("Fixture builds are not byte reproducible");
    }
    for (const fixture of fixtureOne.fixtures) {
        const expected = expectedFixture[fixture.variant];
        if (expected === undefined || fixture.cueSha256 !== expected.cueSha256
            || fixture.binSha256 !== expected.binSha256 || fixture.binBytes !== expected.binBytes) {
            throw new Error(`Fixture does not match committed evidence: ${fixture.variant}`);
        }
    }
    if (fixtureOne.diagnostics?.discs !== 2
        || fixtureOne.diagnostics.entry !== "psx-runtime-diagnostics.m3u"
        || !Number.isSafeInteger(fixtureOne.diagnostics.archiveBytes)
        || fixtureOne.diagnostics.archiveBytes <= 0
        || !/^[a-f0-9]{64}$/u.test(fixtureOne.diagnostics.archiveSha256)) {
        throw new Error("Diagnostic ZIP build result is invalid");
    }

    const coreOne = runJson("compile:core", { PSX_CORE_OUTPUT: resolve(work, "core-one") });
    const coreTwo = runJson("compile:core", { PSX_CORE_OUTPUT: resolve(work, "core-two") });
    if (coreOne.buildId !== coreTwo.buildId
        || JSON.stringify(coreOne.artifacts) !== JSON.stringify(coreTwo.artifacts)) {
        throw new Error("Production core builds are not byte reproducible");
    }
    console.log(JSON.stringify({
        ok: true,
        fixtureBuilds: 2,
        fixtureVariants: fixtureOne.fixtures.length,
        diagnostics: fixtureOne.diagnostics,
        coreBuilds: 2,
        buildId: coreOne.buildId,
        artifacts: coreOne.artifacts,
    }));
} finally {
    await rm(work, { recursive: true, force: true });
}
