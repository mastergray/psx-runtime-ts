import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";
import { applyMountPlan } from "./MountPlan.js";

import type { WorkerStartPayload } from "../LibretroPsxAdapter/protocol.js";
import type {
    ControllerPort,
    PsxAxis,
    PsxButton,
    PsxMachineInfo,
    PsxRumbleEvent,
} from "../shared.types.js";
import type { CoreRunOutput, WorkerCore } from "./WorkerRuntime.js";

interface CoreFileSystem {
    mkdir(path: string): unknown;
    mount(type: unknown, options: { readonly blobs: ReadonlyArray<{ readonly name: string; readonly data: Blob }> }, mountpoint: string): unknown;
    writeFile(path: string, bytes: Uint8Array): unknown;
}

export interface EmscriptenPsxModule {
    readonly FS: CoreFileSystem;
    readonly WORKERFS: unknown;
    readonly HEAPU8: Uint8Array;
    readonly HEAP16: Int16Array;
    _malloc(bytes: number): number;
    _free(pointer: number): void;
    stringToUTF8(value: string, pointer: number, capacity: number): void;
    lengthBytesUTF8(value: string): number;
    _psx_start(contentPath: number, optionsJson: number): number;
    _psx_run_frame(): number;
    _psx_set_button(port: number, id: number, pressed: number): void;
    _psx_set_axis(port: number, id: number, value: number): void;
    _psx_reset(): number;
    _psx_serialize_size(): number;
    _psx_serialize(out: number, size: number): number;
    _psx_unserialize(data: number, size: number): number;
    _psx_memory_card_size(slot: number): number;
    _psx_read_memory_card(slot: number, out: number, size: number): number;
    _psx_write_memory_card(slot: number, data: number, size: number): number;
    _psx_set_disc(index: number): number;
    _psx_disc_count(): number;
    _psx_stop(): void;
    _psx_video_width(): number;
    _psx_video_height(): number;
    _psx_base_width(): number;
    _psx_base_height(): number;
    _psx_video_pitch(): number;
    _psx_video_format(): number;
    _psx_video_data(): number;
    _psx_video_size(): number;
    _psx_video_duplicate(): number;
    _psx_audio_data(): number;
    _psx_audio_frames(): number;
    _psx_frames_per_second(): number;
    _psx_sample_rate(): number;
    _psx_is_pal(): number;
    _psx_aspect_ratio(): number;
    _psx_max_width(): number;
    _psx_max_height(): number;
    _psx_disc_index(): number;
    _psx_tray_open(): number;
    _psx_rumble(port: number, effect: number): number;
    _psx_log_size(): number;
    _psx_log_data(): number;
}

export type EmscriptenPsxFactory = (
    options?: Readonly<Record<string, unknown>>,
) => EmscriptenPsxModule | Promise<EmscriptenPsxModule>;

export type CoreModuleLoader = (url: string) => Promise<EmscriptenPsxFactory>;

const BUTTON_IDS: Readonly<Record<PsxButton, number>> = {
    circle: 0,
    square: 1,
    select: 2,
    start: 3,
    up: 4,
    down: 5,
    left: 6,
    right: 7,
    cross: 8,
    triangle: 9,
    l1: 10,
    r1: 11,
    l2: 12,
    r2: 13,
    l3: 14,
    r3: 15,
};

const AXIS_IDS: Readonly<Record<PsxAxis, number>> = {
    "left-x": 0,
    "left-y": 1,
    "right-x": 2,
    "right-y": 3,
};

const moduleFailure = (message: string, data: unknown = null): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.CORE_LOAD_FAILED,
    message,
    data,
});

const isModule = (value: unknown): value is EmscriptenPsxModule => {
    if (typeof value !== "object" || value === null) return false;
    const module = value as Partial<EmscriptenPsxModule>;
    return typeof module.FS === "object" && module.FS !== null
        && typeof module.FS.mkdir === "function" && typeof module.FS.mount === "function"
        && typeof module.FS.writeFile === "function" && module.HEAPU8 instanceof Uint8Array
        && module.HEAP16 instanceof Int16Array && typeof module._malloc === "function"
        && typeof module._free === "function" && typeof module.stringToUTF8 === "function"
        && typeof module.lengthBytesUTF8 === "function" && typeof module._psx_start === "function"
        && typeof module._psx_run_frame === "function" && typeof module._psx_stop === "function";
};

const relativeTo = (url: string, path: string): string => {
    try {
        return new URL(path, url).href;
    } catch {
        const slash = url.lastIndexOf("/");
        return `${slash < 0 ? "" : url.slice(0, slash + 1)}${path}`;
    }
};

export default class EmscriptenPsxCore implements WorkerCore {
    readonly #loadModule: CoreModuleLoader;
    #module: EmscriptenPsxModule | null = null;
    #payload: WorkerStartPayload | null = null;
    #stopped = false;
    #rumble = [[0, 0], [0, 0]];

    constructor(loadModule: CoreModuleLoader) {
        this.#loadModule = loadModule;
    }

    async start(payload: WorkerStartPayload): Promise<PsxMachineInfo> {
        if (this.#module !== null || this.#stopped) throw moduleFailure("The core bridge cannot be started twice.");
        let factory: EmscriptenPsxFactory;
        let module: EmscriptenPsxModule;
        try {
            factory = await this.#loadModule(payload.moduleUrl);
            module = await factory({ locateFile: (path: string) => relativeTo(payload.moduleUrl, path) });
        } catch (error) {
            throw moduleFailure("The Emscripten PlayStation module could not be instantiated.", error instanceof Error ? error.message : null);
        }
        if (!isModule(module)) throw moduleFailure("The Emscripten module exposes an invalid core surface.");
        this.#module = module;
        this.#payload = payload;
        try {
            await applyMountPlan(module.FS, module.WORKERFS, payload.mountPlan);
            module.FS.mkdir("/system");
            module.FS.mkdir("/save");
            module.FS.writeFile(payload.bios.path, new Uint8Array(await payload.bios.blob.arrayBuffer()));
            const optionsJson = JSON.stringify({ controllers: payload.controllers, options: payload.options });
            const started = this.#withStrings(payload.contentPath, optionsJson, (content, options) =>
                module._psx_start(content, options));
            if (started !== 1) throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.CORE_START_FAILED,
                message: "The PlayStation core rejected the generated content mount.",
                data: this.#sanitizedLog(),
            });
            this.#writeCard(1, payload.memoryCards[1]);
            this.#writeCard(2, payload.memoryCards[2]);
            const width = module._psx_base_width();
            const height = module._psx_base_height();
            const aspectRatio = module._psx_aspect_ratio();
            const framesPerSecond = module._psx_frames_per_second();
            const sampleRate = module._psx_sample_rate();
            const maximumWidth = module._psx_max_width();
            const maximumHeight = module._psx_max_height();
            if (![width, height, aspectRatio, framesPerSecond, sampleRate, maximumWidth, maximumHeight]
                .every((value) => Number.isFinite(value) && value > 0)) throw new Error("Core returned invalid AV information");
            const cueCount = payload.mountPlan.descriptors.filter(({ path }) => path.endsWith(".cue")).length;
            const log = this.#sanitizedLog();
            const firmware = /\bHLE\b|BIOS[^\n]*(?:not found|missing)/iu.test(log) ? "hle" : "bios";
            return {
                core: payload.build.core,
                coreVersion: payload.build.coreVersion,
                buildId: payload.build.buildId,
                gameId: payload.gameId,
                region: module._psx_is_pal() !== 0
                    ? "pal"
                    : payload.region === "ntsc-j" ? "ntsc-j" : "ntsc-u",
                framesPerSecond,
                sampleRate,
                geometry: { width, height, aspectRatio },
                maxWidth: maximumWidth,
                maxHeight: maximumHeight,
                firmware,
                controllers: payload.controllers,
                discCount: Math.max(module._psx_disc_count(), cueCount),
            };
        } catch (error) {
            await this.stop().catch(() => undefined);
            if (PsxRuntimeError.is(error)) throw error;
            throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.CORE_START_FAILED,
                message: error instanceof Error ? error.message : "The PlayStation core failed during startup.",
                data: null,
            });
        }
    }

    runFrame(): CoreRunOutput {
        const module = this.#liveModule();
        if (module._psx_run_frame() !== 1) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.WORKER_FAILED,
            message: "The PlayStation core failed while running a frame.",
            data: this.#sanitizedLog(),
        });
        const width = module._psx_video_width();
        const height = module._psx_video_height();
        const videoPointer = module._psx_video_data();
        const videoBytes = module._psx_video_size();
        const video = module._psx_video_duplicate() !== 0 || videoPointer === 0 || videoBytes === 0
            ? null
            : {
                data: module.HEAPU8.slice(videoPointer, videoPointer + videoBytes),
                width,
                height,
                pitch: module._psx_video_pitch(),
                aspectRatio: module._psx_aspect_ratio(),
                format: this.#pixelFormat(module._psx_video_format()),
            } as const;
        const audioFrames = module._psx_audio_frames();
        const audioPointer = module._psx_audio_data();
        const audio = audioFrames === 0 || audioPointer === 0
            ? undefined
            : module.HEAP16.slice(audioPointer / Int16Array.BYTES_PER_ELEMENT, audioPointer / Int16Array.BYTES_PER_ELEMENT + audioFrames * 2);
        const rumble: PsxRumbleEvent[] = [];
        for (let port = 0; port < 2; port++) {
            const strong = module._psx_rumble(port, 0);
            const weak = module._psx_rumble(port, 1);
            if (strong !== this.#rumble[port]![0] || weak !== this.#rumble[port]![1]) {
                this.#rumble[port] = [strong, weak];
                rumble.push({ port: (port + 1) as ControllerPort, strong: strong / 0xffff, weak: weak / 0xffff });
            }
        }
        return { video, ...(audio === undefined ? {} : { audio }), ...(rumble.length === 0 ? {} : { rumble }) };
    }

    setButton(port: ControllerPort, button: PsxButton, pressed: boolean): void {
        this.#liveModule()._psx_set_button(port - 1, BUTTON_IDS[button], pressed ? 1 : 0);
    }

    setAxis(port: ControllerPort, axis: PsxAxis, value: number): void {
        const scaled = value <= -1 ? -32768 : Math.round(Math.max(-1, Math.min(1, value)) * 32767);
        this.#liveModule()._psx_set_axis(port - 1, AXIS_IDS[axis], scaled);
    }

    reset(kind: "soft" | "hard"): void {
        if (kind === "hard") throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.UNSUPPORTED,
            message: "Hard reset is owned by the main-thread session lifecycle.",
        });
        if (this.#liveModule()._psx_reset() !== 1) throw new Error("Core rejected reset");
    }

    setDisc(index: number): { readonly discIndex: number; readonly trayOpen: boolean } {
        const module = this.#liveModule();
        if (module._psx_set_disc(index) !== 1) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DISC_CHANGE_FAILED,
            message: "The PlayStation core rejected the disc change.",
            data: index,
        });
        return { discIndex: module._psx_disc_index(), trayOpen: module._psx_tray_open() !== 0 };
    }

    readMemoryCard(slot: ControllerPort): Uint8Array {
        const module = this.#liveModule();
        const nativeSlot = slot - 1;
        const size = module._psx_memory_card_size(nativeSlot);
        if (size !== 128 * 1024) throw new Error("Core exposed an invalid memory-card size");
        return this.#withBytes(size, (pointer) => {
            if (module._psx_read_memory_card(nativeSlot, pointer, size) !== 1) throw new Error("Core card read failed");
            return module.HEAPU8.slice(pointer, pointer + size);
        });
    }

    serializeState(): Uint8Array {
        const module = this.#liveModule();
        const size = module._psx_serialize_size();
        if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Core exposed an invalid state size");
        return this.#withBytes(size, (pointer) => {
            if (module._psx_serialize(pointer, size) !== 1) throw new Error("Core state serialization failed");
            return module.HEAPU8.slice(pointer, pointer + size);
        });
    }

    unserializeState(bytes: Uint8Array): void {
        const module = this.#liveModule();
        this.#withBytes(bytes.byteLength, (pointer) => {
            module.HEAPU8.set(bytes, pointer);
            if (module._psx_unserialize(pointer, bytes.byteLength) !== 1) throw new Error("Core state restoration failed");
        });
    }

    async stop(): Promise<void> {
        if (this.#stopped) return;
        this.#stopped = true;
        const module = this.#module;
        this.#module = null;
        this.#payload = null;
        if (module !== null) module._psx_stop();
    }

    #writeCard(slot: ControllerPort, bytes: Uint8Array): void {
        const module = this.#liveModule();
        const nativeSlot = slot - 1;
        if (module._psx_memory_card_size(nativeSlot) !== bytes.byteLength) throw new Error("Core rejected memory-card size");
        this.#withBytes(bytes.byteLength, (pointer) => {
            module.HEAPU8.set(bytes, pointer);
            if (module._psx_write_memory_card(nativeSlot, pointer, bytes.byteLength) !== 1) throw new Error("Core card restore failed");
        });
    }

    #withStrings<T>(first: string, second: string, action: (firstPointer: number, secondPointer: number) => T): T {
        const module = this.#liveModule();
        const firstBytes = module.lengthBytesUTF8(first) + 1;
        const secondBytes = module.lengthBytesUTF8(second) + 1;
        const firstPointer = module._malloc(firstBytes);
        const secondPointer = module._malloc(secondBytes);
        if (firstPointer === 0 || secondPointer === 0) {
            if (firstPointer !== 0) module._free(firstPointer);
            if (secondPointer !== 0) module._free(secondPointer);
            throw new PsxRuntimeError({ code: PsxRuntimeError.CODE.MEMORY_EXCEEDED, message: "Core string allocation failed." });
        }
        try {
            module.stringToUTF8(first, firstPointer, firstBytes);
            module.stringToUTF8(second, secondPointer, secondBytes);
            return action(firstPointer, secondPointer);
        } finally {
            module._free(secondPointer);
            module._free(firstPointer);
        }
    }

    #withBytes<T>(size: number, action: (pointer: number) => T): T {
        const module = this.#liveModule();
        const pointer = module._malloc(size);
        if (pointer === 0) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.MEMORY_EXCEEDED,
            message: "Core byte-buffer allocation failed.",
            data: size,
        });
        try {
            return action(pointer);
        } finally {
            module._free(pointer);
        }
    }

    #sanitizedLog(): string {
        const module = this.#module;
        if (module === null) return "";
        const size = Math.min(module._psx_log_size(), 32 * 1024);
        const pointer = module._psx_log_data();
        if (size <= 0 || pointer === 0) return "";
        return new TextDecoder("utf-8", { fatal: false })
            .decode(module.HEAPU8.slice(pointer, pointer + size))
            .replace(/\/[\w .-]+(?:\/[\w .-]+)+/gu, "[path]");
    }

    #pixelFormat(value: number): "0rgb1555" | "xrgb8888" | "rgb565" {
        if (value === 0) return "0rgb1555";
        if (value === 1) return "xrgb8888";
        if (value === 2) return "rgb565";
        throw new Error("Core selected an unsupported pixel format");
    }

    #liveModule(): EmscriptenPsxModule {
        if (this.#module === null || this.#stopped) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "The Emscripten core bridge is not running.",
        });
        return this.#module;
    }
}
