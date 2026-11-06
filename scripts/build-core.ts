import { spawnSync } from "node:child_process";
import {
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";

import {
    buildIdFor,
    buildIdentityFor,
    buildInfoFor,
    sha256,
    sourceTreeHash,
    type PsxBuildRecipe,
    type PsxSourceIdentity,
    type PsxToolchainIdentity,
} from "./core-build/buildInfo.js";

const root = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(process.env.PSX_CORE_SOURCE ?? resolve(root, "core/.cache/pcsx_rearmed"));
const emsdkRoot = resolve(process.env.EMSDK_ROOT ?? resolve(root, "core/.cache/emsdk"));
const outputRoot = resolve(process.env.PSX_CORE_OUTPUT ?? resolve(root, "dist/core"));
const python = resolve(process.env.EMSDK_PYTHON ?? "/usr/bin/python3.11");
const recipe = JSON.parse(await readFile(resolve(root, "core/build.json"), "utf8")) as PsxBuildRecipe;
const source = JSON.parse(await readFile(resolve(root, "core/SOURCE.json"), "utf8")) as PsxSourceIdentity & {
    readonly license: string;
};
const toolchainManifest = JSON.parse(await readFile(
    resolve(root, "core/probes/toolchain.json"),
    "utf8",
)) as PsxToolchainIdentity & {
    readonly emsdkVersion: string;
};
const toolchain: PsxToolchainIdentity = {
    version: toolchainManifest.emsdkVersion,
    emsdkCommit: toolchainManifest.emsdkCommit,
    emscriptenReleaseCommit: toolchainManifest.emscriptenReleaseCommit,
    emccCommit: toolchainManifest.emccCommit,
};
const patchNames = (await readdir(resolve(root, "core/patches")))
    .filter((name) => name.endsWith(".patch"))
    .sort((left, right) => left.localeCompare(right));
const patchPaths = patchNames.map((name) => resolve(root, "core/patches", name));
const appliedPatchPaths: string[] = [];

const pythonShim = await mkdtemp(resolve(tmpdir(), "psx-runtime-python-"));
await symlink(python, resolve(pythonShim, "python3"));
const emscriptenBin = resolve(emsdkRoot, "upstream/emscripten");
const llvmBin = resolve(emsdkRoot, "upstream/bin");
const environment = {
    ...process.env,
    PATH: `${pythonShim}:${emscriptenBin}:${llvmBin}:${process.env.PATH ?? ""}`,
    SOURCE_DATE_EPOCH: String(recipe.sourceDateEpoch),
};

const run = (command: string, args: ReadonlyArray<string>, cwd = root): string => {
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

try {
    const actualSourceCommit = run("git", ["rev-parse", "HEAD^{commit}"], sourceRoot);
    const actualSourceTree = run("git", ["rev-parse", "HEAD^{tree}"], sourceRoot);
    if (actualSourceCommit !== source.commit || actualSourceTree !== source.tree) {
        throw new Error("Selected core source identity does not match core/SOURCE.json");
    }
    const trackedChanges = run("git", ["status", "--porcelain", "--untracked-files=no"], sourceRoot);
    if (trackedChanges.length > 0) throw new Error("Selected core source checkout has tracked changes");
    const submoduleStatus = run("git", ["submodule", "status", "--recursive"], sourceRoot)
        .split("\n").filter(Boolean);
    const actualSubmodules = Object.fromEntries(submoduleStatus.map((line) => {
        const match = /^ ?([a-f0-9]{40}) ([^ ]+)/u.exec(line);
        if (match === null) throw new Error(`Uninitialized or modified submodule: ${line}`);
        return [match[2]!, match[1]!];
    }));
    if (JSON.stringify(actualSubmodules) !== JSON.stringify(source.submodules)) {
        throw new Error("Selected core submodule identities do not match core/SOURCE.json");
    }
    const emsdkCommit = run("git", ["rev-parse", "HEAD^{commit}"], emsdkRoot);
    if (emsdkCommit !== toolchain.emsdkCommit) throw new Error("emsdk checkout does not match the pin");
    const emccVersion = run(resolve(emscriptenBin, "emcc"), ["--version"]);
    if (!emccVersion.includes(` ${toolchain.version} (${toolchain.emccCommit})`)) {
        throw new Error("emcc does not match the pinned version and commit");
    }

    for (const patchPath of patchPaths) {
        run("git", ["apply", "--check", patchPath], sourceRoot);
        run("git", ["apply", patchPath], sourceRoot);
        appliedPatchPaths.push(patchPath);
    }

    run(resolve(emscriptenBin, "emmake"), ["make", ...recipe.makeArguments, "clean"], sourceRoot);
    run(resolve(emscriptenBin, "emmake"), ["make", ...recipe.makeArguments, "-j8"], sourceRoot);
    const archiveSource = resolve(sourceRoot, "pcsx_rearmed_libretro_emscripten.bc");
    const archive = resolve(sourceRoot, "pcsx_rearmed_libretro_emscripten.a");
    await copyFile(archiveSource, archive);

    await rm(outputRoot, { recursive: true, force: true });
    await mkdir(resolve(outputRoot, "notices"), { recursive: true });
    const emcc = resolve(emscriptenBin, "emcc");
    run(emcc, [
        resolve(root, "libretro/shim/psx_disc_io.c"),
        resolve(root, "libretro/shim/psx_frontend.c"),
        resolve(root, "libretro/shim/psx_exports.c"),
        archive,
        `-I${resolve(root, "libretro/include")}`,
        `-I${resolve(root, "libretro/shim")}`,
        ...recipe.compileFlags,
        ...recipe.linkFlags,
        "-o", resolve(outputRoot, "psx-core.js"),
    ]);

    run(resolve(root, "node_modules/.bin/esbuild"), [
        resolve(root, "dist/worker/core.worker.js"),
        "--bundle",
        "--format=esm",
        "--platform=browser",
        "--target=es2022",
        `--outfile=${resolve(outputRoot, "core.worker.js")}`,
    ]);
    for (const license of recipe.licenses) {
        await copyFile(resolve(root, license.notice), resolve(outputRoot, license.notice));
    }
    await copyFile(resolve(root, "core/SOURCE.json"), resolve(outputRoot, "SOURCE.json"));
    await copyFile(resolve(root, "core/build.json"), resolve(outputRoot, "BUILD-RECIPE.json"));
    await copyFile(resolve(root, "docs/core-distribution.md"), resolve(outputRoot, "SOURCE-OFFER.md"));

    const patches = await Promise.all(patchNames.map(async (name) => ({
        name,
        sha256: sha256(await readFile(resolve(root, "core/patches", name))),
    })));
    const shimPaths = [
        "libretro/include/libretro.h",
        ...(await readdir(resolve(root, "libretro/shim")))
            .filter((name) => name.endsWith(".c") || name.endsWith(".h"))
            .map((name) => `libretro/shim/${name}`),
    ].sort((left, right) => left.localeCompare(right));
    const shimFiles = await Promise.all(shimPaths.map(async (path) => ({
        path,
        contents: await readFile(resolve(root, path)),
    })));
    const identity = buildIdentityFor(recipe, source, toolchain, patches, sourceTreeHash(shimFiles));
    const buildId = buildIdFor(identity);
    const buildInfo = buildInfoFor(recipe, source, toolchain.version, buildId);
    await writeFile(resolve(outputRoot, "build.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);

    const artifacts = await Promise.all(recipe.artifacts.map(async (name) => ({
        name,
        bytes: (await readFile(resolve(outputRoot, name))).byteLength,
        sha256: sha256(await readFile(resolve(outputRoot, name))),
    })));
    console.log(JSON.stringify({
        ok: true,
        core: recipe.core,
        coreCommit: source.commit,
        emsdkVersion: toolchain.version,
        buildId,
        output: basename(outputRoot),
        artifacts,
    }));
} finally {
    try {
        for (const patchPath of appliedPatchPaths.reverse()) {
            run("git", ["apply", "--reverse", patchPath], sourceRoot);
        }
    } finally {
        await rm(pythonShim, { recursive: true, force: true });
    }
}
