import { createHash } from "node:crypto";

import {
    isPsxBuildInfo,
    type PsxBuildInfo,
    type PsxBuildLicense,
    type PsxControllerType,
    type PsxRegion,
} from "../../src/shared.types.js";

export interface PsxSourceIdentity {
    readonly repository: string;
    readonly commit: string;
    readonly tree: string;
    readonly submodules: Readonly<Record<string, string>>;
}

export interface PsxToolchainIdentity {
    readonly version: string;
    readonly emsdkCommit: string;
    readonly emscriptenReleaseCommit: string;
    readonly emccCommit: string;
}

export interface PsxBuildRecipe {
    readonly schemaVersion: 1;
    readonly core: string;
    readonly coreVersion: string;
    readonly artifacts: ReadonlyArray<string>;
    readonly supportedContent: ReadonlyArray<"cue" | "m3u" | "sbi">;
    readonly controllerTypes: ReadonlyArray<PsxControllerType>;
    readonly firmware: {
        readonly required: true;
        readonly byteLengths: ReadonlyArray<number>;
        readonly systemFilenames: Readonly<Record<PsxRegion, string>>;
    };
    readonly memory: { readonly initialPages: number; readonly maximumPages: number };
    readonly pthreads: false;
    readonly makeArguments: ReadonlyArray<string>;
    readonly compileFlags: ReadonlyArray<string>;
    readonly linkFlags: ReadonlyArray<string>;
    readonly licenses: ReadonlyArray<PsxBuildLicense>;
}

export interface PsxBuildIdentity {
    readonly source: PsxSourceIdentity;
    readonly patches: ReadonlyArray<{ readonly name: string; readonly sha256: string }>;
    readonly shimSha256: string;
    readonly toolchain: PsxToolchainIdentity;
    readonly makeArguments: ReadonlyArray<string>;
    readonly compileFlags: ReadonlyArray<string>;
    readonly linkFlags: ReadonlyArray<string>;
    readonly memory: { readonly initialPages: number; readonly maximumPages: number };
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const REPOSITORY_PATTERN = /^https:\/\/[^\s]+\.git$/u;

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const isNonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;

const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every(isNonEmptyString);

const isCommit = (value: unknown): value is string =>
    typeof value === "string" && COMMIT_PATTERN.test(value);

const normalizedStringRecord = (record: Readonly<Record<string, string>>): Record<string, string> =>
    Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));

export const sha256 = (input: Uint8Array | string): string =>
    createHash("sha256").update(input).digest("hex");

export const sourceTreeHash = (
    files: ReadonlyArray<{ readonly path: string; readonly contents: Uint8Array | string }>,
): string => {
    if (files.length === 0 || files.some(({ path }) => !isNonEmptyString(path)
        || path.startsWith("/") || path.includes("\\") || path.split("/").includes(".."))) {
        throw new TypeError("Source tree files must use normalized relative paths");
    }
    const normalized = files
        .map(({ path, contents }) => ({ path, sha256: sha256(contents) }))
        .sort((left, right) => left.path.localeCompare(right.path));
    if (new Set(normalized.map(({ path }) => path)).size !== normalized.length) {
        throw new TypeError("Source tree file paths must be unique");
    }
    return sha256(JSON.stringify(normalized));
};

export function isPsxSourceIdentity(value: unknown): value is PsxSourceIdentity {
    if (!isObject(value) || typeof value.repository !== "string"
        || !REPOSITORY_PATTERN.test(value.repository) || !isCommit(value.commit)
        || !isCommit(value.tree) || !isObject(value.submodules)) return false;
    return Object.entries(value.submodules).every(([path, commit]) =>
        path.length > 0 && !path.startsWith("/") && !path.includes("..") && isCommit(commit));
}

export function isPsxToolchainIdentity(value: unknown): value is PsxToolchainIdentity {
    return isObject(value) && isNonEmptyString(value.version)
        && isCommit(value.emsdkCommit) && isCommit(value.emscriptenReleaseCommit)
        && isCommit(value.emccCommit);
}

export function isPsxBuildRecipe(value: unknown): value is PsxBuildRecipe {
    if (!isObject(value) || !isStringArray(value.makeArguments)
        || !isStringArray(value.compileFlags) || !isStringArray(value.linkFlags)) return false;
    const publicShape = {
        ...value,
        formatVersion: value.schemaVersion,
        adapter: "libretro-psx",
        buildId: "0".repeat(64),
        coreCommit: "0".repeat(40),
        emsdkVersion: "validation",
    };
    return isPsxBuildInfo(publicShape);
}

export function isPsxBuildIdentity(value: unknown): value is PsxBuildIdentity {
    return isObject(value) && isPsxSourceIdentity(value.source)
        && Array.isArray(value.patches) && value.patches.every((patch) => isObject(patch)
            && isNonEmptyString(patch.name) && typeof patch.sha256 === "string"
            && SHA256_PATTERN.test(patch.sha256))
        && typeof value.shimSha256 === "string" && SHA256_PATTERN.test(value.shimSha256)
        && isPsxToolchainIdentity(value.toolchain)
        && isStringArray(value.makeArguments) && isStringArray(value.compileFlags)
        && isStringArray(value.linkFlags) && isObject(value.memory)
        && Number.isInteger(value.memory.initialPages) && (value.memory.initialPages as number) > 0
        && Number.isInteger(value.memory.maximumPages)
        && (value.memory.maximumPages as number) >= (value.memory.initialPages as number);
}

export const buildIdentityFor = (
    recipe: PsxBuildRecipe,
    source: PsxSourceIdentity,
    toolchain: PsxToolchainIdentity,
    patches: PsxBuildIdentity["patches"],
    shimSha256: string,
): PsxBuildIdentity => ({
    source,
    patches,
    shimSha256,
    toolchain,
    makeArguments: recipe.makeArguments,
    compileFlags: recipe.compileFlags,
    linkFlags: recipe.linkFlags,
    memory: recipe.memory,
});

export const buildIdFor = (identity: PsxBuildIdentity): string => {
    if (!isPsxBuildIdentity(identity)) throw new TypeError("Invalid PSX build identity");
    const normalized = {
        source: {
            repository: identity.source.repository,
            commit: identity.source.commit,
            tree: identity.source.tree,
            submodules: normalizedStringRecord(identity.source.submodules),
        },
        patches: identity.patches.map(({ name, sha256: hash }) => ({ name, sha256: hash })),
        shimSha256: identity.shimSha256,
        toolchain: {
            version: identity.toolchain.version,
            emsdkCommit: identity.toolchain.emsdkCommit,
            emscriptenReleaseCommit: identity.toolchain.emscriptenReleaseCommit,
            emccCommit: identity.toolchain.emccCommit,
        },
        makeArguments: [...identity.makeArguments],
        compileFlags: [...identity.compileFlags],
        linkFlags: [...identity.linkFlags],
        memory: {
            initialPages: identity.memory.initialPages,
            maximumPages: identity.memory.maximumPages,
        },
    };
    return sha256(JSON.stringify(normalized));
};

export const buildInfoFor = (
    recipe: PsxBuildRecipe,
    source: PsxSourceIdentity,
    emsdkVersion: string,
    buildId: string,
): PsxBuildInfo => {
    const info: PsxBuildInfo = {
        formatVersion: 1,
        adapter: "libretro-psx",
        buildId,
        core: recipe.core,
        coreVersion: recipe.coreVersion,
        coreCommit: source.commit,
        emsdkVersion,
        artifacts: [...recipe.artifacts],
        supportedContent: [...recipe.supportedContent],
        controllerTypes: [...recipe.controllerTypes],
        firmware: {
            required: true,
            byteLengths: [...recipe.firmware.byteLengths],
            systemFilenames: { ...recipe.firmware.systemFilenames },
        },
        memory: { ...recipe.memory },
        pthreads: false,
        licenses: recipe.licenses.map((license) => ({ ...license })),
    };
    if (!isPsxBuildInfo(info)) throw new TypeError("Generated invalid PSX build metadata");
    return info;
};
