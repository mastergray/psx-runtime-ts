// Dependencies:
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Reports module, startup, memory, drive, and lifecycle failures
import { applyMountPlan } from "./MountPlan.js";                       // Materializes audited content in the Emscripten filesystem

// Type dependencies:
import type { WorkerStartPayload } from "../LibretroPsxAdapter/protocol.js";    // Fully resolved firmware, content, cards, and build input
import type {
    ControllerPort,    // Physical controller and memory-card slot
    PsxAxis,           // Closed set of analog controls
    PsxButton,         // Closed set of digital controls
    PsxMachineInfo,    // Validated core identity and AV capabilities
    PsxRumbleEvent,    // Normalized controller motor output
} from "../shared.types.js";
import type {
    CoreRunOptions,   // Selects large frame payloads that must cross the bridge
    CoreRunOutput,    // Video, audio, and rumble produced by one frame
    WorkerCore,       // Backend contract implemented by this bridge
} from "./WorkerRuntime.js";

/**
 *
 * Type Declarations
 *
 */

// TYPE :: Emscripten filesystem operations needed during startup
// Minimal filesystem surface exposed by the generated module.
interface CoreFileSystem {
    mkdir(path: string): unknown;    // Creates one runtime directory
    mount(type: unknown, options: { readonly blobs: ReadonlyArray<{ readonly name: string; readonly data: Blob }> }, mountpoint: string): unknown; // Mounts worker-backed blobs
    writeFile(path: string, bytes: Uint8Array): unknown;    // Writes one copied byte file
}

// TYPE :: UNKNOWN, int8Array|uint8Array, NUMBER, NUMBER, NUMBER -> NUMBER
// WORKERFS read operation invoked by Emscripten for a mounted disc Blob.
type WorkerFsRead = (
    stream: unknown,
    buffer: Int8Array | Uint8Array,
    offset: number,
    length: number,
    position: number,
) => number;

// TYPE :: UNKNOWN, NUMBER, NUMBER -> NUMBER
// WORKERFS seek operation invoked by Emscripten for a mounted disc Blob.
type WorkerFsSeek = (stream: unknown, offset: number, whence: number) => number;

// INTERFACE :: {stream_ops:{read:workerFsRead, llseek:workerFsSeek}}
// Mutable generated WORKERFS surface wrapped by variants that export disc-I/O diagnostics.
interface WorkerFsLike {
    readonly stream_ops: {
        read: WorkerFsRead;      // Synchronous Blob read and copy operation
        llseek: WorkerFsSeek;    // Logical stream-position operation
    };
}

// INTERFACE :: {readCalls:NUMBER, readRequestedBytes:NUMBER, readReturnedBytes:NUMBER, readMilliseconds:NUMBER, seekCalls:NUMBER, seekMilliseconds:NUMBER}
// Accumulates synchronous disc operations across the active worker session.
interface DiscIoTotals {
    readCalls: number;             // Underlying WORKERFS read operations
    readRequestedBytes: number;    // Bytes requested from mounted Blobs
    readReturnedBytes: number;     // Bytes actually returned to Emscripten
    readMilliseconds: number;      // Time inside WORKERFS reads
    seekCalls: number;             // WORKERFS logical seek operations
    seekMilliseconds: number;      // Time inside WORKERFS seeks
}

// TYPE :: Generated Emscripten heap, filesystem, and PSX C ABI
// Runtime module boundary validated before any core operation.
export interface EmscriptenPsxModule {
    readonly FS: CoreFileSystem;           // Mounted-content and writable-file operations
    readonly WORKERFS: unknown;            // Emscripten worker-backed filesystem type
    readonly HEAPU8: Uint8Array;           // Unsigned byte view of linear memory
    readonly HEAP16: Int16Array;           // Signed sample view of linear memory
    _malloc(bytes: number): number;         // Allocates linear-memory bytes and returns a pointer
    _free(pointer: number): void;           // Releases one linear-memory allocation
    stringToUTF8(value: string, pointer: number, capacity: number): void; // Copies a terminated UTF-8 string into memory
    lengthBytesUTF8(value: string): number; // Measures UTF-8 bytes excluding the terminator
    _psx_start(contentPath: number, optionsJson: number): number;         // Starts the shim from string pointers
    _psx_run_frame(captureVideo: number, captureAudio: number, frameskipInterval: number): number; // Executes one configured emulation frame
    _psx_set_sequential_read_reuse(enabled: number): void;               // Enables the D1 exact-position native seek bypass
    _psx_set_button(port: number, id: number, pressed: number): void; // Sets one native digital input
    _psx_set_axis(port: number, id: number, value: number): void;     // Sets one native analog input
    _psx_reset(): number;                                            // Performs a soft core reset
    _psx_serialize_size(): number;                                   // Reports required save-state bytes
    _psx_serialize(out: number, size: number): number;                // Writes a save state into linear memory
    _psx_unserialize(data: number, size: number): number;             // Restores a save state from linear memory
    _psx_memory_card_size(slot: number): number;                      // Reports one native card byte length
    _psx_read_memory_card(slot: number, out: number, size: number): number; // Writes one card into linear memory
    _psx_write_memory_card(slot: number, data: number, size: number): number; // Restores one card from linear memory
    _psx_set_disc(index: number): number;                             // Changes the active zero-based disc
    _psx_disc_count(): number;                                       // Reports mounted disc count
    _psx_stop(): void;                                                // Stops the shim and core
    _psx_video_width(): number;                                      // Reports current output width
    _psx_video_height(): number;                                     // Reports current output height
    _psx_base_width(): number;                                       // Reports initial geometry width
    _psx_base_height(): number;                                      // Reports initial geometry height
    _psx_video_pitch(): number;                                      // Reports source bytes per row
    _psx_video_format(): number;                                     // Reports native pixel-format identifier
    _psx_video_data(): number;                                       // Reports current video pointer
    _psx_video_size(): number;                                       // Reports current video byte length
    _psx_video_duplicate(): number;                                  // Reports whether the prior frame repeats
    _psx_audio_data(): number;                                       // Reports current stereo sample pointer
    _psx_audio_frames(): number;                                     // Reports current stereo frame count
    _psx_frames_per_second(): number;                                // Reports nominal frame rate
    _psx_sample_rate(): number;                                      // Reports nominal audio sample rate
    _psx_is_pal(): number;                                           // Reports PAL timing selection
    _psx_aspect_ratio(): number;                                     // Reports display-corrected aspect ratio
    _psx_max_width(): number;                                        // Reports maximum output width
    _psx_max_height(): number;                                       // Reports maximum output height
    _psx_disc_index(): number;                                       // Reports active zero-based disc
    _psx_tray_open(): number;                                        // Reports virtual tray state
    _psx_rumble(port: number, effect: number): number;                // Reports one native rumble motor level
    _psx_log_size(): number;                                         // Reports diagnostic log byte length
    _psx_log_data(): number;                                         // Reports diagnostic log pointer
}

// TYPE :: ARRAY<STRING, UNKNOWN>? -> emscriptenPsxModule|PROMISE(emscriptenPsxModule)
// Generated module factory loaded from the build artifact.
export type EmscriptenPsxFactory = (
    options?: Readonly<Record<string, unknown>>,
) => EmscriptenPsxModule | Promise<EmscriptenPsxModule>;

// TYPE :: STRING -> PROMISE(emscriptenPsxFactory)
// Injectable dynamic-import boundary for generated module code.
export type CoreModuleLoader = (url: string) => Promise<EmscriptenPsxFactory>;

export const LIBRETRO_BUTTON_IDS: Readonly<Record<PsxButton, number>> = { // Public button names to libretro joypad identifiers
    cross: 0,
    square: 1,
    select: 2,
    start: 3,
    up: 4,
    down: 5,
    left: 6,
    right: 7,
    circle: 8,
    triangle: 9,
    l1: 10,
    r1: 11,
    l2: 12,
    r2: 13,
    l3: 14,
    r3: 15,
};

const AXIS_IDS: Readonly<Record<PsxAxis, number>> = {        // Public axis names to shim analog identifiers
    "left-x": 0,
    "left-y": 1,
    "right-x": 2,
    "right-y": 3,
};

/**
 *
 * Class
 *
 */

// Adapts the generated Emscripten PSX shim to the worker core contract.
export default class EmscriptenPsxCore implements WorkerCore {

    /* Instance Fields */
    private readonly _loadModule: CoreModuleLoader;                  // Dynamic generated-module import boundary
    private readonly _clock: () => number;                           // Monotonic stage-timing clock
    private _module: EmscriptenPsxModule | null = null;             // Live validated module after startup
    private _payload: WorkerStartPayload | null = null;             // Startup input retained for bridge lifetime
    private _stopped = false;                                       // Whether module ownership has ended
    private _rumble = [[0, 0], [0, 0]];                             // Previous native strong and weak motor values by port
    private readonly _discIo = createDiscIoTotals();                // Instrumented WORKERFS counters or zero-valued baseline

    // CONSTRUCTOR :: coreModuleLoader, (VOID -> NUMBER)? -> emscriptenPsxCore
    // Retains the generated-module loader for deferred worker startup.
    constructor(loadModule: CoreModuleLoader, clock: () => number = monotonicClock) {
        this._loadModule = loadModule;
        this._clock = clock;
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: workerStartPayload -> PROMISE(psxMachineInfo)
    // Loads the module, mounts content and firmware, starts the core, and reports capabilities.
    async start(payload: WorkerStartPayload): Promise<PsxMachineInfo> {
        if (this._module !== null || this._stopped) throw moduleFailure("The core bridge cannot be started twice.");
        let factory: EmscriptenPsxFactory;
        let module: EmscriptenPsxModule;
        try {
            factory = await this._loadModule(payload.moduleUrl);
            module = await factory({ locateFile: (path: string) => relativeTo(payload.moduleUrl, path) });
        } catch (error) {
            throw moduleFailure("The Emscripten PlayStation module could not be instantiated.", error instanceof Error ? error.message : null);
        }
        if (!isModule(module)) throw moduleFailure("The Emscripten module exposes an invalid core surface.");
        if (payload.diagnosticVariant === "instrumented" || payload.diagnosticVariant === "sequential-read-reuse") {
            instrumentWorkerFs(module.WORKERFS, this._discIo, this._clock);
        }
        module._psx_set_sequential_read_reuse(
            payload.diagnosticVariant === "production" || payload.diagnosticVariant === "sequential-read-reuse" ? 1 : 0,
        );
        this._module = module;
        this._payload = payload;
        try {
            await applyMountPlan(module.FS, module.WORKERFS, payload.mountPlan);
            module.FS.mkdir("/system");
            module.FS.mkdir("/save");
            module.FS.writeFile(payload.bios.path, new Uint8Array(await payload.bios.blob.arrayBuffer()));
            const discPaths = payload.mountPlan.descriptors
                .filter(({ path }) => path.endsWith(".cue"))
                .map(({ path }) => path);
            const optionsJson = JSON.stringify({
                controllers: payload.controllers,
                options: payload.options,
                ...(payload.initialDiscIndex === 0 ? {} : {
                    initialDiscIndex: payload.initialDiscIndex,
                    initialDiscPath: discPaths[payload.initialDiscIndex],
                }),
            });
            const started = this._withStrings(payload.contentPath, optionsJson, (content, options) =>
                module._psx_start(content, options));
            if (started !== 1) throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.CORE_START_FAILED,
                message: "The PlayStation core rejected the generated content mount.",
                data: this._sanitizedLog(),
            });
            this._writeCard(1, payload.memoryCards[1]);
            this._writeCard(2, payload.memoryCards[2]);
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
            const log = this._sanitizedLog();
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

    // METHOD :: coreRunOptions -> coreRunOutput
    // Executes one frame and copies only requested AV payloads plus changed rumble output.
    runFrame(options: CoreRunOptions): CoreRunOutput {
        const module = this._liveModule();
        const discIoBefore = copyDiscIoTotals(this._discIo);
        const startedAt = this._clock();
        if (module._psx_run_frame(
            options.video ? 1 : 0,
            options.audio ? 1 : 0,
            options.frameskipInterval,
        ) !== 1) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.WORKER_FAILED,
            message: "The PlayStation core failed while running a frame.",
            data: this._sanitizedLog(),
        });
        const executedAt = this._clock();
        const videoPointer = options.video ? module._psx_video_data() : 0;
        const videoBytes = options.video ? module._psx_video_size() : 0;
        const video = !options.video
            ? undefined
            : module._psx_video_duplicate() !== 0 || videoPointer === 0 || videoBytes === 0
                ? null
                : {
                    data: module.HEAPU8.subarray(videoPointer, videoPointer + videoBytes),
                    width: module._psx_video_width(),
                    height: module._psx_video_height(),
                    pitch: module._psx_video_pitch(),
                    aspectRatio: module._psx_aspect_ratio(),
                    format: this._pixelFormat(module._psx_video_format()),
                } as const;
        const audioFrames = options.audio ? module._psx_audio_frames() : 0;
        const audioPointer = options.audio ? module._psx_audio_data() : 0;
        const audio = !options.audio || audioFrames === 0 || audioPointer === 0
            ? undefined
            : module.HEAP16.subarray(
                audioPointer / Int16Array.BYTES_PER_ELEMENT,
                audioPointer / Int16Array.BYTES_PER_ELEMENT + audioFrames * 2,
            );
        const rumble: PsxRumbleEvent[] = [];
        for (let port = 0; port < 2; port++) {
            const strong = module._psx_rumble(port, 0);
            const weak = module._psx_rumble(port, 1);
            if (strong !== this._rumble[port]![0] || weak !== this._rumble[port]![1]) {
                this._rumble[port] = [strong, weak];
                rumble.push({ port: (port + 1) as ControllerPort, strong: strong / 0xffff, weak: weak / 0xffff });
            }
        }
        const extractedAt = this._clock();
        const discIo = subtractDiscIoTotals(this._discIo, discIoBefore);
        return {
            ...(video === undefined ? {} : { video }),
            ...(audio === undefined ? {} : { audio }),
            ...(rumble.length === 0 ? {} : { rumble }),
            timing: {
                coreMilliseconds: Math.max(0, executedAt - startedAt),
                extractionMilliseconds: Math.max(0, extractedAt - executedAt),
                discReadCalls: discIo.readCalls,
                discReadRequestedBytes: discIo.readRequestedBytes,
                discReadReturnedBytes: discIo.readReturnedBytes,
                discReadMilliseconds: discIo.readMilliseconds,
                discSeekCalls: discIo.seekCalls,
                discSeekMilliseconds: discIo.seekMilliseconds,
            },
        };
    }

    // METHOD :: controllerPort, psxButton, BOOLEAN -> VOID
    // Converts and forwards one digital controller state.
    setButton(port: ControllerPort, button: PsxButton, pressed: boolean): void {
        this._liveModule()._psx_set_button(port - 1, LIBRETRO_BUTTON_IDS[button], pressed ? 1 : 0);
    }

    // METHOD :: controllerPort, psxAxis, NUMBER -> VOID
    // Clamps, scales, and forwards one analog controller state.
    setAxis(port: ControllerPort, axis: PsxAxis, value: number): void {
        const scaled = value <= -1 ? -32768 : Math.round(Math.max(-1, Math.min(1, value)) * 32767);
        this._liveModule()._psx_set_axis(port - 1, AXIS_IDS[axis], scaled);
    }

    // METHOD :: "soft"|"hard" -> VOID
    // Performs a soft reset and leaves hard-reset worker replacement to the session.
    reset(kind: "soft" | "hard"): void {
        if (kind === "hard") throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.UNSUPPORTED,
            message: "Hard reset is owned by the main-thread session lifecycle.",
        });
        if (this._liveModule()._psx_reset() !== 1) throw new Error("Core rejected reset");
    }

    // METHOD :: NUMBER -> {discIndex:NUMBER, trayOpen:BOOLEAN}
    // Changes the active disc and returns core-reported drive state.
    setDisc(index: number): { readonly discIndex: number; readonly trayOpen: boolean } {
        const module = this._liveModule();
        if (module._psx_set_disc(index) !== 1) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DISC_CHANGE_FAILED,
            message: "The PlayStation core rejected the disc change.",
            data: index,
        });
        return { discIndex: module._psx_disc_index(), trayOpen: module._psx_tray_open() !== 0 };
    }

    // METHOD :: controllerPort -> uint8Array
    // Copies one validated memory-card image out of linear memory.
    readMemoryCard(slot: ControllerPort): Uint8Array {
        const module = this._liveModule();
        const nativeSlot = slot - 1;
        const size = module._psx_memory_card_size(nativeSlot);
        if (size !== 128 * 1024) throw new Error("Core exposed an invalid memory-card size");
        return this._withBytes(size, (pointer) => {
            if (module._psx_read_memory_card(nativeSlot, pointer, size) !== 1) throw new Error("Core card read failed");
            return module.HEAPU8.slice(pointer, pointer + size);
        });
    }

    // METHOD :: VOID -> uint8Array
    // Captures one core save-state payload from linear memory.
    serializeState(): Uint8Array {
        const module = this._liveModule();
        const size = module._psx_serialize_size();
        if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Core exposed an invalid state size");
        return this._withBytes(size, (pointer) => {
            if (module._psx_serialize(pointer, size) !== 1) throw new Error("Core state serialization failed");
            return module.HEAPU8.slice(pointer, pointer + size);
        });
    }

    // METHOD :: uint8Array -> VOID
    // Copies and restores one core save-state payload through linear memory.
    unserializeState(bytes: Uint8Array): void {
        const module = this._liveModule();
        this._withBytes(bytes.byteLength, (pointer) => {
            module.HEAPU8.set(bytes, pointer);
            if (module._psx_unserialize(pointer, bytes.byteLength) !== 1) throw new Error("Core state restoration failed");
        });
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Stops the module at most once and clears bridge references.
    async stop(): Promise<void> {
        if (this._stopped) return;
        this._stopped = true;
        const module = this._module;
        this._module = null;
        this._payload = null;
        if (module !== null) module._psx_stop();
    }

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: controllerPort, uint8Array -> VOID
    // Copies one exact-size memory-card image into the core.
    private _writeCard(slot: ControllerPort, bytes: Uint8Array): void {
        const module = this._liveModule();
        const nativeSlot = slot - 1;
        if (module._psx_memory_card_size(nativeSlot) !== bytes.byteLength) throw new Error("Core rejected memory-card size");
        this._withBytes(bytes.byteLength, (pointer) => {
            module.HEAPU8.set(bytes, pointer);
            if (module._psx_write_memory_card(nativeSlot, pointer, bytes.byteLength) !== 1) throw new Error("Core card restore failed");
        });
    }

    // METHOD :: STRING, STRING, (NUMBER, NUMBER -> T) -> T
    // Allocates two temporary UTF-8 strings and always releases their memory.
    private _withStrings<T>(first: string, second: string, action: (firstPointer: number, secondPointer: number) => T): T {
        const module = this._liveModule();
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

    // METHOD :: NUMBER, (NUMBER -> T) -> T
    // Allocates one temporary byte region and always releases its memory.
    private _withBytes<T>(size: number, action: (pointer: number) => T): T {
        const module = this._liveModule();
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

    // METHOD :: VOID -> STRING
    // Returns a bounded diagnostic log with filesystem paths redacted.
    private _sanitizedLog(): string {
        const module = this._module;
        if (module === null) return "";
        const size = Math.min(module._psx_log_size(), 32 * 1024);
        const pointer = module._psx_log_data();
        if (size <= 0 || pointer === 0) return "";
        return new TextDecoder("utf-8", { fatal: false })
            .decode(module.HEAPU8.slice(pointer, pointer + size))
            .replace(/\/[\w .-]+(?:\/[\w .-]+)+/gu, "[path]");
    }

    // METHOD :: NUMBER -> "0rgb1555"|"xrgb8888"|"rgb565"
    // Converts one native pixel-format identifier to the runtime union.
    private _pixelFormat(value: number): "0rgb1555" | "xrgb8888" | "rgb565" {
        if (value === 0) return "0rgb1555";
        if (value === 1) return "xrgb8888";
        if (value === 2) return "rgb565";
        throw new Error("Core selected an unsupported pixel format");
    }

    // METHOD :: VOID -> emscriptenPsxModule
    // Returns the live module or rejects operations outside its lifecycle.
    private _liveModule(): EmscriptenPsxModule {
        if (this._module === null || this._stopped) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "The Emscripten core bridge is not running.",
        });
        return this._module;
    }
}

/**
 *
 *  Helper Functions
 *
 */

// HELPER :: STRING, UNKNOWN? -> psxRuntimeError
// Creates one generated-module loading or shape failure.
const moduleFailure = (message: string, data: unknown = null): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.CORE_LOAD_FAILED,
    message,
    data,
});

// HELPER :: VOID -> NUMBER
// Reads the realm's monotonic high-resolution clock for worker-stage timing.
const monotonicClock = (): number => performance.now();

// HELPER :: VOID -> discIoTotals
// Creates zero-valued aggregate WORKERFS counters.
const createDiscIoTotals = (): DiscIoTotals => ({
    readCalls: 0,
    readRequestedBytes: 0,
    readReturnedBytes: 0,
    readMilliseconds: 0,
    seekCalls: 0,
    seekMilliseconds: 0,
});

// HELPER :: discIoTotals -> discIoTotals
// Copies aggregate WORKERFS counters at a frame boundary.
const copyDiscIoTotals = (totals: DiscIoTotals): DiscIoTotals => ({ ...totals });

// HELPER :: discIoTotals, discIoTotals -> discIoTotals
// Calculates the non-negative WORKERFS activity performed during one frame.
const subtractDiscIoTotals = (after: DiscIoTotals, before: DiscIoTotals): DiscIoTotals => ({
    readCalls: Math.max(0, after.readCalls - before.readCalls),
    readRequestedBytes: Math.max(0, after.readRequestedBytes - before.readRequestedBytes),
    readReturnedBytes: Math.max(0, after.readReturnedBytes - before.readReturnedBytes),
    readMilliseconds: Math.max(0, after.readMilliseconds - before.readMilliseconds),
    seekCalls: Math.max(0, after.seekCalls - before.seekCalls),
    seekMilliseconds: Math.max(0, after.seekMilliseconds - before.seekMilliseconds),
});

// HELPER :: UNKNOWN, discIoTotals, (VOID -> NUMBER) -> VOID
// Wraps the repository-consumed WORKERFS boundary with bounded aggregate timing and byte counters.
const instrumentWorkerFs = (value: unknown, totals: DiscIoTotals, clock: () => number): void => {
    if (!isWorkerFs(value)) throw moduleFailure("The Emscripten module exposes an invalid WORKERFS surface.");
    const originalRead = value.stream_ops.read;
    const originalSeek = value.stream_ops.llseek;
    value.stream_ops.read = function instrumentedRead(
        stream: unknown,
        buffer: Int8Array | Uint8Array,
        offset: number,
        length: number,
        position: number,
    ): number {
        const startedAt = clock();
        totals.readCalls++;
        totals.readRequestedBytes += Math.max(0, length);
        try {
            const returned = Reflect.apply(originalRead, this, [stream, buffer, offset, length, position]) as number;
            totals.readReturnedBytes += Math.max(0, returned);
            return returned;
        } finally {
            totals.readMilliseconds += Math.max(0, clock() - startedAt);
        }
    };
    value.stream_ops.llseek = function instrumentedSeek(
        stream: unknown,
        offset: number,
        whence: number,
    ): number {
        const startedAt = clock();
        totals.seekCalls++;
        try {
            return Reflect.apply(originalSeek, this, [stream, offset, whence]) as number;
        } finally {
            totals.seekMilliseconds += Math.max(0, clock() - startedAt);
        }
    };
};

// HELPER :: UNKNOWN -> BOOLEAN
// Narrows a generated WORKERFS object to the operations wrapped by D0 diagnostics.
const isWorkerFs = (value: unknown): value is WorkerFsLike => {
    if (typeof value !== "object" || value === null || !("stream_ops" in value)) return false;
    const operations = (value as { readonly stream_ops?: unknown }).stream_ops;
    return typeof operations === "object" && operations !== null
        && "read" in operations && typeof operations.read === "function"
        && "llseek" in operations && typeof operations.llseek === "function";
};

// HELPER :: UNKNOWN -> BOOLEAN
// Narrows an instantiated value to the required Emscripten module surface.
const isModule = (value: unknown): value is EmscriptenPsxModule => {
    if (typeof value !== "object" || value === null) return false;
    const module = value as Partial<EmscriptenPsxModule>;
    return typeof module.FS === "object" && module.FS !== null
        && typeof module.FS.mkdir === "function" && typeof module.FS.mount === "function"
        && typeof module.FS.writeFile === "function" && module.HEAPU8 instanceof Uint8Array
        && module.HEAP16 instanceof Int16Array && typeof module._malloc === "function"
        && typeof module._free === "function" && typeof module.stringToUTF8 === "function"
        && typeof module.lengthBytesUTF8 === "function" && typeof module._psx_start === "function"
        && typeof module._psx_set_sequential_read_reuse === "function"
        && typeof module._psx_run_frame === "function" && typeof module._psx_stop === "function";
};

// HELPER :: STRING, STRING -> STRING
// Resolves a module-relative artifact with a path fallback for non-URL deployments.
const relativeTo = (url: string, path: string): string => {
    try {
        return new URL(path, url).href;
    } catch {
        const slash = url.lastIndexOf("/");
        return `${slash < 0 ? "" : url.slice(0, slash + 1)}${path}`;
    }
};
