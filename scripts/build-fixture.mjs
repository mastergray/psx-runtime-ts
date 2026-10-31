import { createHash } from "node:crypto";
import { copyFile, readFile, utimes } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const fixtureRoot = resolve(repositoryRoot, "fixtures/homebrew");
const generatedRoot = resolve(repositoryRoot, "fixtures/generated/m0");
const manifest = JSON.parse(await readFile(resolve(fixtureRoot, "TOOLCHAIN.json"), "utf8"));
const sdkRoot = process.env.PSN00BSDK_ROOT;

if (sdkRoot === undefined || sdkRoot.length === 0) {
    throw new Error("PSN00BSDK_ROOT must name the extracted SDK directory");
}

if (process.env.PSN00BSDK_ARCHIVE !== undefined) {
    const archive = await readFile(resolve(process.env.PSN00BSDK_ARCHIVE));
    const actualDigest = createHash("sha256").update(archive).digest("hex");
    if (actualDigest !== manifest.archiveSha256) {
        throw new Error(`PSn00bSDK archive digest mismatch: ${actualDigest}`);
    }
}

const sdk = resolve(sdkRoot);
const bin = resolve(sdk, "bin");
const compiler = resolve(bin, "mipsel-none-elf-gcc");
const imageBuilder = resolve(bin, "mkpsxiso");
const toolchain = resolve(sdk, "lib/libpsn00b/cmake/sdk.cmake");
const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
};

const run = (command, args, cwd = repositoryRoot) => {
    const result = spawnSync(command, args, {
        cwd,
        env: environment,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
        throw new Error(`${command} failed\n${result.stdout}${result.stderr}`);
    }
    return result.stdout.trim();
};

const compilerVersion = run(compiler, ["--version"]).split("\n", 1)[0];
if (compilerVersion !== manifest.compiler) {
    throw new Error(`Unexpected fixture compiler: ${compilerVersion}`);
}

const fixedTimestamp = new Date("2000-01-01T00:00:00.000Z");

const buildFixture = async ({ dynamicGeometry, outputRoot, pal, variant }) => {
    run("cmake", [
        "-S", fixtureRoot,
        "-B", outputRoot,
        "-G", "Unix Makefiles",
        "-DCMAKE_BUILD_TYPE=Release",
        `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`,
        `-DPSN00BSDK_TC=${sdk}`,
        `-DPSX_FIXTURE_PAL=${pal ? "ON" : "OFF"}`,
        `-DPSX_FIXTURE_DYNAMIC_GEOMETRY=${dynamicGeometry ? "ON" : "OFF"}`,
    ]);
    run("cmake", ["--build", outputRoot, "--parallel", "--clean-first"]);

    const stagedSystem = resolve(outputRoot, "system.cnf");
    const stagedLicense = resolve(outputRoot, "LICENSE");
    const stagedProject = resolve(outputRoot, "iso.xml");
    const executable = resolve(outputRoot, "m0-fixture.exe");
    await Promise.all([
        copyFile(resolve(fixtureRoot, "system.cnf"), stagedSystem),
        copyFile(resolve(fixtureRoot, "LICENSE"), stagedLicense),
        copyFile(resolve(fixtureRoot, "iso.xml"), stagedProject),
    ]);
    await Promise.all([
        utimes(stagedSystem, fixedTimestamp, fixedTimestamp),
        utimes(stagedLicense, fixedTimestamp, fixedTimestamp),
        utimes(stagedProject, fixedTimestamp, fixedTimestamp),
        utimes(executable, fixedTimestamp, fixedTimestamp),
    ]);
    run(imageBuilder, ["-y", stagedProject], outputRoot);

    const cuePath = resolve(outputRoot, "m0-fixture.cue");
    const binPath = resolve(outputRoot, "m0-fixture.bin");
    const [cue, image] = await Promise.all([readFile(cuePath), readFile(binPath)]);
    return {
        variant,
        cueSha256: createHash("sha256").update(cue).digest("hex"),
        binSha256: createHash("sha256").update(image).digest("hex"),
        binBytes: image.byteLength,
    };
};

const fixtures = [];
for (const configuration of [
    { dynamicGeometry: false, outputRoot: generatedRoot, pal: false, variant: "ntsc" },
    { dynamicGeometry: false, outputRoot: resolve(generatedRoot, "pal"), pal: true, variant: "pal" },
    {
        dynamicGeometry: true,
        outputRoot: resolve(generatedRoot, "geometry"),
        pal: false,
        variant: "dynamic-geometry",
    },
]) {
    fixtures.push(await buildFixture(configuration));
}

console.log(JSON.stringify({
    toolchain: manifest.version,
    compiler: compilerVersion,
    fixtures,
}));
