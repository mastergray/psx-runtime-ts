import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";
import { isAuditedDisc, isDiscSet } from "../shared.types.js";

import type { AuditedDisc, DiscFile, DiscSet } from "../shared.types.js";

const CONTENT_ROOT = "/content";
const BLOB_ROOT = `${CONTENT_ROOT}/blob`;
const INDEX_ROOT = `${CONTENT_ROOT}/index`;
const FILE_DIRECTIVE = /^(\s*)FILE\s+(?:"([^"\r\n]+)"|([^\s"]+))\s+([^\s]+)\s*$/iu;

export interface MountPlanTrack {
    readonly name: string;
    readonly blob: Blob;
}

export interface MountPlanDescriptor {
    readonly path: string;
    readonly bytes: Uint8Array;
}

export interface MountPlanSidecar {
    readonly path: string;
    readonly blob: Blob;
}

export interface MountPlan {
    readonly entryPath: string;
    readonly tracks: ReadonlyArray<MountPlanTrack>;
    readonly descriptors: ReadonlyArray<MountPlanDescriptor>;
    readonly sidecars: ReadonlyArray<MountPlanSidecar>;
}

export interface EmscriptenFsLike {
    mkdir(path: string): unknown;
    mount(
        type: unknown,
        options: { readonly blobs: ReadonlyArray<{ readonly name: string; readonly data: Blob }> },
        mountpoint: string,
    ): unknown;
    writeFile(path: string, bytes: Uint8Array): unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const isBlobLike = (value: unknown): value is Blob => isObject(value)
    && typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0
    && typeof value.arrayBuffer === "function" && typeof value.slice === "function"
    && typeof value.stream === "function" && typeof value.text === "function";

const isUint8Array = (value: unknown): value is Uint8Array => value instanceof Uint8Array
    || Object.prototype.toString.call(value) === "[object Uint8Array]";

const isGeneratedPath = (value: unknown, extension: ".cue" | ".m3u" | ".sbi"): value is string =>
    typeof value === "string" && value.startsWith(`${INDEX_ROOT}/`)
    && value.endsWith(extension) && !value.includes("\\") && !value.includes("..");

export function isMountPlan(value: unknown): value is MountPlan {
    if (!isObject(value) || typeof value.entryPath !== "string"
        || (!isGeneratedPath(value.entryPath, ".cue") && !isGeneratedPath(value.entryPath, ".m3u"))
        || !Array.isArray(value.tracks) || value.tracks.length === 0
        || !Array.isArray(value.descriptors) || value.descriptors.length === 0
        || !Array.isArray(value.sidecars)) return false;
    const trackNames = new Set<string>();
    for (const track of value.tracks) {
        if (!isObject(track) || typeof track.name !== "string"
            || !/^track-\d{3}\.bin$/u.test(track.name) || trackNames.has(track.name)
            || !isBlobLike(track.blob)) return false;
        trackNames.add(track.name);
    }
    const descriptorPaths = new Set<string>();
    for (const descriptor of value.descriptors) {
        if (!isObject(descriptor)
            || (!isGeneratedPath(descriptor.path, ".cue") && !isGeneratedPath(descriptor.path, ".m3u"))
            || descriptorPaths.has(descriptor.path) || !isUint8Array(descriptor.bytes)
            || descriptor.bytes.byteLength === 0) return false;
        descriptorPaths.add(descriptor.path);
    }
    const sidecarPaths = new Set<string>();
    for (const sidecar of value.sidecars) {
        if (!isObject(sidecar) || !isGeneratedPath(sidecar.path, ".sbi")
            || sidecarPaths.has(sidecar.path) || !isBlobLike(sidecar.blob)) return false;
        sidecarPaths.add(sidecar.path);
    }
    return descriptorPaths.has(value.entryPath);
}

const directoryOf = (path: string): string => {
    const slash = path.lastIndexOf("/");
    return slash < 0 ? "" : path.slice(0, slash);
};

const resolveRelativePath = (base: string, reference: string): string => {
    const directory = directoryOf(base);
    return directory.length === 0 ? reference : `${directory}/${reference}`;
};

const invariant = (message: string, data?: unknown): never => {
    throw new PsxRuntimeError({
        code: PsxRuntimeError.CODE.INTERNAL_ERROR,
        message,
        data: data ?? null,
    });
};

const readDescriptor = async (file: DiscFile): Promise<string> => {
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.blob.arrayBuffer());
        return text.startsWith("\ufeff") ? text.slice(1) : text;
    } catch (error) {
        throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.CONTENT_LOAD_FAILED,
            message: "An audited descriptor could not be read while constructing its mount plan.",
            data: error instanceof Error ? error.message : null,
        });
    }
};

const generatedTrackName = (index: number): string => `track-${index.toString().padStart(3, "0")}.bin`;
const generatedDiscName = (index: number): string => `disc-${index.toString().padStart(3, "0")}`;

const rewriteCue = async (
    cue: DiscFile,
    trackNames: ReadonlyMap<string, string>,
): Promise<Uint8Array> => {
    const text = await readDescriptor(cue);
    const output = text.split(/\r?\n/u).map((line) => {
        const match = FILE_DIRECTIVE.exec(line);
        if (match === null) return line.trimEnd();
        const sourcePath = resolveRelativePath(cue.path, match[2] ?? match[3]!);
        const generatedName = trackNames.get(sourcePath);
        if (generatedName === undefined) {
            return invariant("An audited CUE references a track absent from its mount plan.", sourcePath);
        }
        return `${match[1]}FILE "${BLOB_ROOT}/${generatedName}" ${match[4]!.toUpperCase()}`;
    });
    return new TextEncoder().encode(`${output.join("\n").replace(/\n+$/u, "")}\n`);
};

export async function createMountPlan(set: DiscSet, audit: AuditedDisc): Promise<MountPlan> {
    if (!isDiscSet(set) || !isAuditedDisc(audit) || set.entry !== audit.entry) {
        throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.INVALID_CONFIG,
            message: "Mount-plan input is not a matching audited disc set.",
            data: null,
        });
    }

    const files = new Map(set.files.map((file) => [file.path, file]));
    const trackNames = new Map<string, string>();
    const tracks: MountPlanTrack[] = [];

    for (const disc of audit.discs) {
        for (const track of disc.tracks) {
            const file = files.get(track.file);
            if (file === undefined || file.blob.size !== track.bytes) {
                return invariant("The audited track metadata no longer matches its disc set.", track.file);
            }
            if (trackNames.has(track.file)) continue;
            const name = generatedTrackName(tracks.length);
            trackNames.set(track.file, name);
            tracks.push({ name, blob: file.blob });
        }
    }

    const descriptors: MountPlanDescriptor[] = [];
    const sidecars: MountPlanSidecar[] = [];
    for (let index = 0; index < audit.discs.length; index++) {
        const disc = audit.discs[index]!;
        const cue = files.get(disc.cue);
        if (cue === undefined) return invariant("An audited CUE is absent from its disc set.", disc.cue);
        const basename = generatedDiscName(index);
        descriptors.push({
            path: `${INDEX_ROOT}/${basename}.cue`,
            bytes: await rewriteCue(cue, trackNames),
        });
        if (disc.sbi !== undefined) {
            const sidecar = files.get(disc.sbi);
            if (sidecar === undefined) return invariant("An audited SBI is absent from its disc set.", disc.sbi);
            sidecars.push({ path: `${INDEX_ROOT}/${basename}.sbi`, blob: sidecar.blob });
        }
    }

    const isPlaylist = audit.entry.toLowerCase().endsWith(".m3u");
    if (isPlaylist) {
        descriptors.push({
            path: `${INDEX_ROOT}/game.m3u`,
            bytes: new TextEncoder().encode(`${audit.discs.map((_, index) => `${generatedDiscName(index)}.cue`).join("\n")}\n`),
        });
    }

    return {
        entryPath: isPlaylist ? `${INDEX_ROOT}/game.m3u` : `${INDEX_ROOT}/${generatedDiscName(0)}.cue`,
        tracks,
        descriptors,
        sidecars,
    };
}

export async function applyMountPlan(
    fs: EmscriptenFsLike,
    workerFs: unknown,
    plan: MountPlan,
): Promise<void> {
    fs.mkdir(CONTENT_ROOT);
    fs.mkdir(BLOB_ROOT);
    fs.mkdir(INDEX_ROOT);
    fs.mount(workerFs, {
        blobs: plan.tracks.map(({ name, blob }) => ({ name, data: blob })),
    }, BLOB_ROOT);
    for (const descriptor of plan.descriptors) fs.writeFile(descriptor.path, descriptor.bytes);
    for (const sidecar of plan.sidecars) {
        let bytes: Uint8Array;
        try {
            bytes = new Uint8Array(await sidecar.blob.arrayBuffer());
        } catch (error) {
            throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.CONTENT_LOAD_FAILED,
                message: "An audited SBI sidecar could not be read while applying its mount plan.",
                data: error instanceof Error ? error.message : null,
            });
        }
        fs.writeFile(sidecar.path, bytes);
    }
}
