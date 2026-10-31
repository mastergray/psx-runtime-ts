import {
    LibretroPsxAdapter,
    PsxConsole,
    PsxRuntimeError,
    PsxStorage,
} from "../src/index.js";

import type {
    BiosImage,
    PsxControllerType,
    PsxFileListLike,
    PsxPlayer,
} from "../src/index.js";

interface PreloadManifest {
    readonly available: boolean;
    readonly buildUrl?: string;
    readonly gameId?: string;
    readonly entry?: string;
    readonly bios?: { readonly name: string; readonly url: string; readonly region: "ntsc-u" | "ntsc-j" | "pal" };
    readonly files?: ReadonlyArray<{ readonly name: string; readonly path: string; readonly url: string }>;
}

const element = <T extends HTMLElement>(id: string): T => {
    const value = document.querySelector(`#${id}`);
    if (value === null) throw new Error(`Missing harness element: ${id}`);
    return value as T;
};

const logElement = element<HTMLPreElement>("log");
const statusElement = element<HTMLParagraphElement>("status");
const canvas = element<HTMLCanvasElement>("screen");
const container = element<HTMLDivElement>("screen-stage");
const buildUrlInput = element<HTMLInputElement>("build-url");
const biosInput = element<HTMLInputElement>("bios");
const filesInput = element<HTMLInputElement>("game-files");
let preloadFiles: File[] | null = null;
let preloadBios: File | null = null;
let preloadRegion: "ntsc-u" | "ntsc-j" | "pal" = "ntsc-u";
let droppedFiles: File[] | null = null;
let runtime: PsxConsole | null = null;
let player: PsxPlayer | null = null;
let activeBuildUrl = "";

const write = (message: string): void => {
    logElement.textContent = `${new Date().toISOString()} ${message}\n${logElement.textContent ?? ""}`.slice(0, 12_000);
};

const report = (error: unknown): void => {
    const label = PsxRuntimeError.is(error) ? error.label : "ERROR";
    const message = error instanceof Error ? error.message : String(error);
    write(`${label}: ${message}`);
};

const selectedFiles = (): PsxFileListLike => {
    if (filesInput.files !== null && filesInput.files.length > 0) return filesInput.files;
    if (droppedFiles !== null && droppedFiles.length > 0) return droppedFiles;
    if (preloadFiles !== null && preloadFiles.length > 0) return preloadFiles;
    throw new Error("Select disc files first.");
};

const selectedBios = (): BiosImage => {
    const file = biosInput.files?.[0] ?? preloadBios;
    if (file === null || file === undefined) throw new Error("Select firmware first.");
    const selectedRegion = element<HTMLSelectElement>("bios-region").value as "ntsc-u" | "ntsc-j" | "pal";
    return { name: file.name, region: selectedRegion, blob: file };
};

const ensureRuntime = async (): Promise<PsxConsole> => {
    const buildUrl = buildUrlInput.value.trim();
    if (runtime !== null && activeBuildUrl === buildUrl) return runtime;
    if (runtime !== null) await runtime.destroy();
    const adapter = await LibretroPsxAdapter.init({ buildUrl });
    const storage = PsxStorage.init();
    runtime = PsxConsole.init({
        adapter,
        canvas,
        container,
        gestureSource: document,
        storage,
        profileId: "harness",
        memoryCardIds: { 1: "card-1", 2: "card-2" },
        keyboard: { target: window },
        gamepad: {
            provider: { getGamepads: () => navigator.getGamepads() },
            scheduler: {
                request: requestAnimationFrame.bind(globalThis),
                cancel: cancelAnimationFrame.bind(globalThis),
            },
            target: document,
        },
    });
    player = runtime.player as PsxPlayer;
    player.on("status", (status) => { statusElement.textContent = status; });
    player.on("error", report);
    activeBuildUrl = buildUrl;
    return runtime;
};

const localConfig = () => ({
    gameId: element<HTMLInputElement>("game-id").value.trim(),
    ...(element<HTMLInputElement>("entry").value.trim().length === 0
        ? {}
        : { entry: element<HTMLInputElement>("entry").value.trim() }),
});

const run = (action: () => Promise<unknown> | unknown): void => {
    void Promise.resolve().then(action).catch(report);
};

element("audit").addEventListener("click", () => run(async () => {
    const console = await ensureRuntime();
    const result = await console.auditFiles(selectedFiles(), localConfig());
    write(result.ok ? `Audit passed: ${result.audit.discs.length} disc(s).` : `Audit failed: ${result.issues.length} issue(s).`);
}));

element("start").addEventListener("click", () => run(async () => {
    const console = await ensureRuntime();
    await console.startFiles(selectedFiles(), localConfig(), {
        bios: selectedBios(),
        controllers: {
            1: element<HTMLSelectElement>("controller-1").value as PsxControllerType,
            2: element<HTMLSelectElement>("controller-2").value as PsxControllerType,
        },
    });
    write("Session started.");
}));

element("stop").addEventListener("click", () => run(async () => { await runtime?.stop(); }));
element("pause").addEventListener("click", () => run(async () => { await player?.pause(); }));
element("resume").addEventListener("click", () => run(() => player?.resume()));
element("soft-reset").addEventListener("click", () => run(async () => { await player?.reset("soft"); }));
element("hard-reset").addEventListener("click", () => run(async () => { await player?.reset("hard"); }));
element("set-disc").addEventListener("click", () => run(async () => {
    await player?.setDisc(Number(element<HTMLInputElement>("disc-index").value));
}));
element("unlock").addEventListener("click", () => run(async () => {
    const audio = player?.audio as { unlock?: () => Promise<void> } | null;
    await audio?.unlock?.();
}));
element("fullscreen").addEventListener("click", () => run(async () => { await container.requestFullscreen(); }));

const stateName = (): string => element<HTMLInputElement>("state-name").value;
element("save-state").addEventListener("click", () => run(async () => { await player?.saveState(stateName()); }));
element("load-state").addEventListener("click", () => run(async () => { await player?.loadState(stateName()); }));
element("delete-state").addEventListener("click", () => run(async () => { await player?.deleteState(stateName()); }));

for (const port of [1, 2] as const) {
    element(`bind-${port}`).addEventListener("click", () => run(() => {
        runtime?.bindGamepad(Number(element<HTMLInputElement>(`pad-${port}`).value), port);
    }));
    element(`download-card-${port}`).addEventListener("click", () => run(async () => {
        const bytes = await player?.downloadMemoryCard(port);
        if (bytes === undefined) return;
        const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const url = URL.createObjectURL(new Blob([copy]));
        const link = document.createElement("a");
        link.href = url;
        link.download = `card-${port}.mcd`;
        link.click();
        URL.revokeObjectURL(url);
    }));
    element(`replace-card-${port}`).addEventListener("click", () => run(async () => {
        const replacement = element<HTMLInputElement>("replacement-card").files?.[0];
        if (replacement === undefined) throw new Error("Select a replacement card first.");
        await player?.replaceMemoryCard(port, new Uint8Array(await replacement.arrayBuffer()));
    }));
}

container.addEventListener("dragover", (event) => { event.preventDefault(); });
container.addEventListener("drop", (event) => {
    event.preventDefault();
    droppedFiles = event.dataTransfer === null ? null : [...event.dataTransfer.files];
    if (droppedFiles !== null) write(`Selected ${droppedFiles.length} dropped file(s).`);
});

const loadPreload = async (): Promise<void> => {
    const response = await fetch("/__preload");
    if (!response.ok) return;
    const manifest = await response.json() as PreloadManifest;
    if (!manifest.available) return;
    if (manifest.buildUrl !== undefined) buildUrlInput.value = manifest.buildUrl;
    if (manifest.gameId !== undefined) element<HTMLInputElement>("game-id").value = manifest.gameId;
    if (manifest.entry !== undefined) element<HTMLInputElement>("entry").value = manifest.entry;
    if (manifest.bios !== undefined) {
        const blob = await (await fetch(manifest.bios.url)).blob();
        preloadBios = new File([blob], manifest.bios.name);
        preloadRegion = manifest.bios.region;
        element<HTMLSelectElement>("bios-region").value = preloadRegion;
    }
    if (manifest.files !== undefined) preloadFiles = await Promise.all(manifest.files.map(async (item) => {
        const blob = await (await fetch(item.url)).blob();
        const loaded = new File([blob], item.name);
        Object.defineProperty(loaded, "webkitRelativePath", { value: item.path });
        return loaded;
    }));
    write("Private preload is ready.");
};

void loadPreload().catch(report);
