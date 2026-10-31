// Public dependency boundaries and PlayStation runtime contracts.

export type Unsubscribe = () => void;

export type Listener<T> = (event: T) => void;

export interface FrameScheduler {
    request(callback: (time: number) => void): number;
    cancel(handle: number): void;
}

export interface FetchResponseLike {
    readonly ok: boolean;
    readonly status: number;
    arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (url: string) => Promise<FetchResponseLike>;

export type PsxRegion = "ntsc-u" | "ntsc-j" | "pal";

export type DiscPath = string;

export interface DiscFile {
    readonly path: DiscPath;
    readonly blob: Blob;
}

export interface DiscSet {
    readonly gameId: string;
    readonly entry: DiscPath;
    readonly files: ReadonlyArray<DiscFile>;
}

export interface BiosImage {
    readonly name: string;
    readonly region: PsxRegion;
    readonly blob: Blob;
    readonly sha256?: string;
}

export interface AuditedTrack {
    readonly file: DiscPath;
    readonly kind: "data" | "audio";
    readonly bytes: number;
}

export interface AuditedDiscEntry {
    readonly cue: DiscPath;
    readonly tracks: ReadonlyArray<AuditedTrack>;
    readonly sbi?: DiscPath;
}

export interface AuditedDisc {
    readonly entry: DiscPath;
    readonly discs: ReadonlyArray<AuditedDiscEntry>;
    readonly totalBytes: number;
    readonly warnings: ReadonlyArray<string>;
}

export type ControllerPort = 1 | 2;

export type PsxControllerType = "none" | "digital" | "dualshock";

export type PsxButton =
    | "up" | "down" | "left" | "right"
    | "triangle" | "circle" | "cross" | "square"
    | "l1" | "r1" | "l2" | "r2"
    | "start" | "select" | "l3" | "r3";

export type PsxAxis = "left-x" | "left-y" | "right-x" | "right-y";

export interface PsxButtonControl {
    readonly port: ControllerPort;
    readonly button: PsxButton;
}

export interface PsxAxisControl {
    readonly port: ControllerPort;
    readonly axis: PsxAxis;
}

export interface PsxGeometry {
    readonly width: number;
    readonly height: number;
    readonly aspectRatio: number;
}

export interface PsxMachineInfo {
    readonly core: string;
    readonly coreVersion: string;
    readonly buildId: string;
    readonly gameId: string;
    readonly region: PsxRegion;
    readonly framesPerSecond: number;
    readonly sampleRate: number;
    readonly geometry: PsxGeometry;
    readonly maxWidth: number;
    readonly maxHeight: number;
    readonly firmware: "bios" | "hle";
    readonly controllers: Readonly<Record<ControllerPort, PsxControllerType>>;
    readonly discCount: number;
}

export interface PsxFrameEvent extends PsxGeometry {
    readonly rgba: Uint8ClampedArray;
}

export interface PsxSoundEvent {
    readonly samples: Float32Array;
    readonly frames: number;
}

export interface PsxRumbleEvent {
    readonly port: ControllerPort;
    readonly strong: number;
    readonly weak: number;
}

export type PsxOptions = Readonly<Record<string, string | number | boolean>>;

export interface PsxStartConfig {
    readonly game: DiscSet;
    readonly bios: BiosImage;
    readonly controllers?: Readonly<Partial<Record<ControllerPort, PsxControllerType>>>;
    readonly memoryCards?: Readonly<Partial<Record<ControllerPort, Uint8Array>>>;
    readonly options?: PsxOptions;
}

export interface PsxSession {
    readonly machine: PsxMachineInfo;
    readonly discIndex: number;
    readonly trayOpen: boolean;
    setButton(control: PsxButtonControl, pressed: boolean): void;
    setAxis(control: PsxAxisControl, value: number): void;
    pause(): void;
    resume(): void;
    reset(kind: "soft" | "hard"): Promise<void>;
    setDisc(index: number): Promise<void>;
    readMemoryCard(slot: ControllerPort): Promise<Uint8Array>;
    serializeState(): Promise<Uint8Array>;
    unserializeState(bytes: Uint8Array): Promise<void>;
    exit(): Promise<void>;
    onTick(listener: Listener<void>): Unsubscribe;
    onFrame(listener: Listener<PsxFrameEvent>): Unsubscribe;
    onSound(listener: Listener<PsxSoundEvent>): Unsubscribe;
    onRumble(listener: Listener<PsxRumbleEvent>): Unsubscribe;
    onExit(listener: Listener<void>): Unsubscribe;
}

export interface PsxAdapter {
    readonly type: string;
    start(config: PsxStartConfig): Promise<PsxSession>;
}

export interface PsxBuildLicense {
    readonly id: string;
    readonly notice: string;
}

export interface PsxBuildInfo {
    readonly formatVersion: 1;
    readonly adapter: "libretro-psx";
    readonly buildId: string;
    readonly core: string;
    readonly coreVersion: string;
    readonly coreCommit: string;
    readonly emsdkVersion: string;
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
    readonly licenses: ReadonlyArray<PsxBuildLicense>;
}

const PSX_REGIONS: ReadonlyArray<PsxRegion> = ["ntsc-u", "ntsc-j", "pal"];
const CONTROLLER_PORTS: ReadonlyArray<ControllerPort> = [1, 2];
const CONTROLLER_TYPES: ReadonlyArray<PsxControllerType> = ["none", "digital", "dualshock"];
const PSX_BUTTONS: ReadonlyArray<PsxButton> = [
    "up", "down", "left", "right", "triangle", "circle", "cross", "square",
    "l1", "r1", "l2", "r2", "start", "select", "l3", "r3",
];
const PSX_AXES: ReadonlyArray<PsxAxis> = ["left-x", "left-y", "right-x", "right-y"];
const SUPPORTED_CONTENT = ["cue", "m3u", "sbi"] as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/iu;
const DRIVE_LETTER_PATTERN = /^[a-z]:/iu;
const MEMORY_CARD_BYTES = 128 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const isNonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);

const isPositiveInteger = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value > 0;

const isNonNegativeInteger = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0;

const isArrayOf = (value: unknown, predicate: (item: unknown) => boolean): boolean =>
    Array.isArray(value) && value.every(predicate);

const hasOnlyKeys = (value: object, allowed: ReadonlyArray<string>): boolean =>
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.includes(key));

const isUnique = <T>(values: ReadonlyArray<T>): boolean => new Set(values).size === values.length;

const isBlob = (value: unknown): value is Blob => isObject(value)
    && isNonNegativeInteger(value.size)
    && typeof value.type === "string"
    && typeof value.arrayBuffer === "function"
    && typeof value.slice === "function"
    && typeof value.stream === "function"
    && typeof value.text === "function";

const isUint8Array = (value: unknown): value is Uint8Array =>
    value instanceof Uint8Array || Object.prototype.toString.call(value) === "[object Uint8Array]";

const isUint8ClampedArray = (value: unknown): value is Uint8ClampedArray =>
    value instanceof Uint8ClampedArray
    || Object.prototype.toString.call(value) === "[object Uint8ClampedArray]";

const isFloat32Array = (value: unknown): value is Float32Array =>
    value instanceof Float32Array || Object.prototype.toString.call(value) === "[object Float32Array]";

const isPortRecord = (
    value: unknown,
    predicate: (item: unknown) => boolean,
    requireBoth: boolean,
): boolean => {
    if (!isObject(value) || !hasOnlyKeys(value, ["1", "2"])) return false;
    const keys = Object.keys(value);
    return (!requireBoth || keys.length === 2)
        && keys.every((key) => predicate(value[key]));
};

export function isFrameScheduler(value: unknown): value is FrameScheduler {
    return isObject(value) && typeof value.request === "function" && typeof value.cancel === "function";
}

export function isFetchResponseLike(value: unknown): value is FetchResponseLike {
    return isObject(value) && typeof value.ok === "boolean"
        && isNonNegativeInteger(value.status) && value.status <= 599
        && typeof value.arrayBuffer === "function";
}

export function isPsxRegion(value: unknown): value is PsxRegion {
    return PSX_REGIONS.includes(value as PsxRegion);
}

export function isDiscPath(value: unknown): value is DiscPath {
    if (!isNonEmptyString(value) || value !== value.trim() || value.startsWith("/")
        || value.includes("\\") || CONTROL_CHARACTER_PATTERN.test(value)
        || URL_SCHEME_PATTERN.test(value) || DRIVE_LETTER_PATTERN.test(value)) return false;
    const segments = value.split("/");
    return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function isDiscFile(value: unknown): value is DiscFile {
    return isObject(value) && isDiscPath(value.path) && isBlob(value.blob);
}

export function isDiscSet(value: unknown): value is DiscSet {
    if (!isObject(value) || !isNonEmptyString(value.gameId) || !isDiscPath(value.entry)
        || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > 64
        || !value.files.every(isDiscFile)) return false;
    const paths = value.files.map(({ path }) => path);
    const foldedPaths = paths.map((path) => path.toLowerCase());
    return isUnique(foldedPaths) && paths.includes(value.entry);
}

export function isBiosImage(value: unknown): value is BiosImage {
    return isObject(value) && isNonEmptyString(value.name) && isPsxRegion(value.region)
        && isBlob(value.blob)
        && (value.sha256 === undefined || (typeof value.sha256 === "string" && SHA256_PATTERN.test(value.sha256)));
}

export function isAuditedTrack(value: unknown): value is AuditedTrack {
    return isObject(value) && isDiscPath(value.file)
        && (value.kind === "data" || value.kind === "audio")
        && isPositiveInteger(value.bytes);
}

export function isAuditedDiscEntry(value: unknown): value is AuditedDiscEntry {
    return isObject(value) && isDiscPath(value.cue)
        && Array.isArray(value.tracks) && value.tracks.length > 0 && value.tracks.length <= 99
        && value.tracks.every(isAuditedTrack)
        && (value.sbi === undefined || isDiscPath(value.sbi));
}

export function isAuditedDisc(value: unknown): value is AuditedDisc {
    if (!isObject(value) || !isDiscPath(value.entry)
        || !Array.isArray(value.discs) || value.discs.length === 0 || value.discs.length > 8
        || !value.discs.every(isAuditedDiscEntry)
        || !isNonNegativeInteger(value.totalBytes)
        || !isArrayOf(value.warnings, (warning) => typeof warning === "string")) return false;
    const cues = value.discs.map(({ cue }) => cue.toLowerCase());
    const trackBytes = value.discs.flatMap(({ tracks }) => tracks)
        .reduce((total, track) => total + track.bytes, 0);
    return isUnique(cues) && value.totalBytes >= trackBytes;
}

export function isControllerPort(value: unknown): value is ControllerPort {
    return CONTROLLER_PORTS.includes(value as ControllerPort);
}

export function isPsxControllerType(value: unknown): value is PsxControllerType {
    return CONTROLLER_TYPES.includes(value as PsxControllerType);
}

export function isPsxButton(value: unknown): value is PsxButton {
    return PSX_BUTTONS.includes(value as PsxButton);
}

export function isPsxAxis(value: unknown): value is PsxAxis {
    return PSX_AXES.includes(value as PsxAxis);
}

export function isPsxButtonControl(value: unknown): value is PsxButtonControl {
    return isObject(value) && isControllerPort(value.port) && isPsxButton(value.button);
}

export function isPsxAxisControl(value: unknown): value is PsxAxisControl {
    return isObject(value) && isControllerPort(value.port) && isPsxAxis(value.axis);
}

export function isPsxGeometry(value: unknown): value is PsxGeometry {
    return isObject(value) && isPositiveInteger(value.width) && isPositiveInteger(value.height)
        && isFiniteNumber(value.aspectRatio) && value.aspectRatio > 0;
}

export function isPsxMachineInfo(value: unknown): value is PsxMachineInfo {
    return isObject(value) && isNonEmptyString(value.core) && isNonEmptyString(value.coreVersion)
        && typeof value.buildId === "string" && SHA256_PATTERN.test(value.buildId)
        && isNonEmptyString(value.gameId) && isPsxRegion(value.region)
        && isFiniteNumber(value.framesPerSecond) && value.framesPerSecond > 0
        && isFiniteNumber(value.sampleRate) && value.sampleRate > 0
        && isPsxGeometry(value.geometry) && isPositiveInteger(value.maxWidth)
        && isPositiveInteger(value.maxHeight)
        && value.maxWidth >= value.geometry.width && value.maxHeight >= value.geometry.height
        && (value.firmware === "bios" || value.firmware === "hle")
        && isPortRecord(value.controllers, isPsxControllerType, true)
        && isPositiveInteger(value.discCount) && value.discCount <= 8;
}

export function isPsxFrameEvent(value: unknown): value is PsxFrameEvent {
    return isObject(value) && isPsxGeometry(value) && isUint8ClampedArray(value.rgba)
        && value.rgba.length === value.width * value.height * 4;
}

export function isPsxSoundEvent(value: unknown): value is PsxSoundEvent {
    return isObject(value) && isNonNegativeInteger(value.frames) && isFloat32Array(value.samples)
        && value.samples.length === value.frames * 2;
}

export function isPsxRumbleEvent(value: unknown): value is PsxRumbleEvent {
    return isObject(value) && isControllerPort(value.port)
        && isFiniteNumber(value.strong) && value.strong >= 0 && value.strong <= 1
        && isFiniteNumber(value.weak) && value.weak >= 0 && value.weak <= 1;
}

export function isPsxOptions(value: unknown): value is PsxOptions {
    return isObject(value) && Reflect.ownKeys(value).every((key) => typeof key === "string"
        && isNonEmptyString(key)
        && (typeof value[key] === "string" || typeof value[key] === "boolean" || isFiniteNumber(value[key])));
}

export function isPsxStartConfig(value: unknown): value is PsxStartConfig {
    return isObject(value) && isDiscSet(value.game) && isBiosImage(value.bios)
        && (value.controllers === undefined || isPortRecord(value.controllers, isPsxControllerType, false))
        && (value.memoryCards === undefined || isPortRecord(
            value.memoryCards,
            (card) => isUint8Array(card) && card.byteLength === MEMORY_CARD_BYTES,
            false,
        ))
        && (value.options === undefined || isPsxOptions(value.options));
}

export function isPsxSession(value: unknown): value is PsxSession {
    return isObject(value) && isPsxMachineInfo(value.machine)
        && isNonNegativeInteger(value.discIndex) && value.discIndex < value.machine.discCount
        && typeof value.trayOpen === "boolean"
        && [
            "setButton", "setAxis", "pause", "resume", "reset", "setDisc", "readMemoryCard",
            "serializeState", "unserializeState", "exit", "onTick", "onFrame", "onSound",
            "onRumble", "onExit",
        ].every((method) => typeof value[method] === "function");
}

export function isPsxAdapter(value: unknown): value is PsxAdapter {
    return isObject(value) && isNonEmptyString(value.type) && typeof value.start === "function";
}

export function isPsxBuildLicense(value: unknown): value is PsxBuildLicense {
    return isObject(value) && isNonEmptyString(value.id) && isDiscPath(value.notice);
}

export function isPsxBuildInfo(value: unknown): value is PsxBuildInfo {
    if (!isObject(value) || value.formatVersion !== 1 || value.adapter !== "libretro-psx"
        || typeof value.buildId !== "string" || !SHA256_PATTERN.test(value.buildId)
        || !isNonEmptyString(value.core) || !isNonEmptyString(value.coreVersion)
        || typeof value.coreCommit !== "string" || !COMMIT_PATTERN.test(value.coreCommit)
        || !isNonEmptyString(value.emsdkVersion)
        || !Array.isArray(value.artifacts) || value.artifacts.length === 0
        || !value.artifacts.every(isDiscPath) || !isUnique(value.artifacts)
        || !Array.isArray(value.supportedContent) || value.supportedContent.length === 0
        || !value.supportedContent.every((item) => SUPPORTED_CONTENT.includes(item))
        || !isUnique(value.supportedContent)
        || !Array.isArray(value.controllerTypes) || value.controllerTypes.length === 0
        || !value.controllerTypes.every(isPsxControllerType) || !isUnique(value.controllerTypes)
        || !isObject(value.firmware) || value.firmware.required !== true
        || !Array.isArray(value.firmware.byteLengths) || value.firmware.byteLengths.length === 0
        || !value.firmware.byteLengths.every(isPositiveInteger) || !isUnique(value.firmware.byteLengths)
        || !isObject(value.firmware.systemFilenames)
        || !hasOnlyKeys(value.firmware.systemFilenames, PSX_REGIONS)
        || !PSX_REGIONS.every((region) => {
            const filename = (value.firmware as {
                systemFilenames: Record<PsxRegion, unknown>;
            }).systemFilenames[region];
            return isNonEmptyString(filename) && !filename.includes("/") && !filename.includes("\\");
        })
        || !isObject(value.memory) || !isPositiveInteger(value.memory.initialPages)
        || !isPositiveInteger(value.memory.maximumPages)
        || value.memory.initialPages > value.memory.maximumPages
        || value.pthreads !== false
        || !Array.isArray(value.licenses) || value.licenses.length === 0
        || !value.licenses.every(isPsxBuildLicense)) return false;
    return true;
}
