/**
 *
 * Type Declarations
 *
 */

// TYPE :: VOID -> VOID
// Idempotent cleanup callback returned by runtime event subscriptions.
export type Unsubscribe = () => void;

// TYPE :: <T> -> T -> VOID
// Observer invoked with one runtime event of the subscribed type.
export type Listener<T> = (event: T) => void;

// INTERFACE :: {request:((NUMBER -> VOID) -> NUMBER), cancel:(NUMBER -> VOID)}
// Injectable animation-frame scheduler used to drive emulation independently of browser globals.
export interface FrameScheduler {
    request(callback: (time: number) => void): number;    // Schedules a frame callback and returns its cancellation handle
    cancel(handle: number): void;                         // Cancels one previously scheduled callback
}

// INTERFACE :: {ok:BOOLEAN, status:NUMBER, arrayBuffer:(VOID -> PROMISE(arrayBuffer))}
// Minimal binary HTTP response boundary required when loading runtime artifacts.
export interface FetchResponseLike {
    readonly ok: boolean;                         // True when the request completed successfully
    readonly status: number;                      // HTTP-compatible response status
    arrayBuffer(): Promise<ArrayBuffer>;          // Reads the complete binary response body
}

// TYPE :: STRING -> PROMISE(fetchResponseLike)
// Injectable binary fetch operation used without coupling the runtime to a concrete global fetch.
export type FetchLike = (url: string) => Promise<FetchResponseLike>;

// TYPE :: "ntsc-u"|"ntsc-j"|"pal"
// PlayStation firmware and video region identifier.
export type PsxRegion = "ntsc-u" | "ntsc-j" | "pal";

// TYPE :: 1|2|5|7
// Emulation-time multiplier applied while a session is running.
export type PsxPlaybackRate = 1 | 2 | 5 | 7;

// TYPE :: STRING
// Normalized, relative, forward-slash path within one imported disc set.
export type DiscPath = string;

// INTERFACE :: {path:discPath, blob:blob}
// One immutable file belonging to a normalized game package.
export interface DiscFile {
    readonly path: DiscPath;    // Unique package-relative content path
    readonly blob: Blob;        // File bytes retained without filesystem authority
}

// INTERFACE :: {gameId:STRING, entry:discPath, files:[discFile]}
// Complete package needed to start one single- or multi-disc game.
export interface DiscSet {
    readonly gameId: string;                    // Caller-facing identity for saves, states, and library lookup
    readonly entry: DiscPath;                   // CUE or M3U descriptor opened by the core
    readonly files: ReadonlyArray<DiscFile>;    // Bounded package contents containing the entry and its dependencies
}

// INTERFACE :: {name:STRING, region:psxRegion, blob:blob, sha256:STRING?}
// User-supplied PlayStation firmware image and optional verified content digest.
export interface BiosImage {
    readonly name: string;        // Original firmware filename or display name
    readonly region: PsxRegion;   // Region the image must serve
    readonly blob: Blob;          // Firmware bytes supplied privately by the user
    readonly sha256?: string;     // Optional lowercase SHA-256 digest of those bytes
}

// INTERFACE :: {file:discPath, kind:"data"|"audio", bytes:NUMBER}
// Audited track dependency referenced by one CUE descriptor.
export interface AuditedTrack {
    readonly file: DiscPath;               // Package-relative track path
    readonly kind: "data" | "audio";      // Track role inferred from its CUE mode
    readonly bytes: number;                // Positive source byte length
}

// INTERFACE :: {cue:discPath, tracks:[auditedTrack], sbi:discPath?}
// One validated disc and its track and optional subchannel dependencies.
export interface AuditedDiscEntry {
    readonly cue: DiscPath;                         // CUE descriptor for this disc
    readonly tracks: ReadonlyArray<AuditedTrack>;   // Ordered tracks referenced by the descriptor
    readonly sbi?: DiscPath;                        // Optional matching SBI subchannel patch
}

// INTERFACE :: {entry:discPath, discs:[auditedDiscEntry], totalBytes:NUMBER, warnings:[STRING]}
// Normalized audit result for a valid CUE or M3U package.
export interface AuditedDisc {
    readonly entry: DiscPath;                          // Audited top-level CUE or M3U descriptor
    readonly discs: ReadonlyArray<AuditedDiscEntry>;   // Ordered discs available to the session
    readonly totalBytes: number;                       // Aggregate unique track content size
    readonly warnings: ReadonlyArray<string>;          // Non-fatal package observations
}

// TYPE :: 1|2
// Physical PlayStation controller and memory-card port number.
export type ControllerPort = 1 | 2;

// TYPE :: "none"|"digital"|"dualshock"
// Controller device exposed to the emulated machine on one port.
export type PsxControllerType = "none" | "digital" | "dualshock";

// TYPE :: directional|face|shoulder|system|stick button name
// Canonical logical PlayStation button independent of its keyboard or gamepad source.
export type PsxButton =
    | "up" | "down" | "left" | "right"
    | "triangle" | "circle" | "cross" | "square"
    | "l1" | "r1" | "l2" | "r2"
    | "start" | "select" | "l3" | "r3";

// TYPE :: "left-x"|"left-y"|"right-x"|"right-y"
// Canonical DualShock analog-stick axis.
export type PsxAxis = "left-x" | "left-y" | "right-x" | "right-y";

// INTERFACE :: {port:controllerPort, button:psxButton}
// Address of one logical button on one emulated controller.
export interface PsxButtonControl {
    readonly port: ControllerPort;    // Target emulated controller port
    readonly button: PsxButton;       // Target logical button
}

// INTERFACE :: {port:controllerPort, axis:psxAxis}
// Address of one analog axis on one emulated controller.
export interface PsxAxisControl {
    readonly port: ControllerPort;    // Target emulated controller port
    readonly axis: PsxAxis;           // Target logical stick axis
}

// INTERFACE :: {width:NUMBER, height:NUMBER, aspectRatio:NUMBER}
// Active video dimensions and display ratio reported by the core.
export interface PsxGeometry {
    readonly width: number;          // Active frame width in pixels
    readonly height: number;         // Active frame height in pixels
    readonly aspectRatio: number;    // Positive intended display width-to-height ratio
}

// INTERFACE :: immutable machine identity, timing, video, firmware, controller, and disc metadata
// Realized emulated-machine properties returned when a session starts.
export interface PsxMachineInfo {
    readonly core: string;                // Emulation core name
    readonly coreVersion: string;         // Emulation core release identity
    readonly buildId: string;             // SHA-256 identity of the packaged core build
    readonly gameId: string;              // Active game's persistence identity
    readonly region: PsxRegion;           // Realized machine region
    readonly framesPerSecond: number;     // Nominal emulation refresh rate
    readonly sampleRate: number;          // Native stereo audio rate in frames per second
    readonly geometry: PsxGeometry;       // Current active video geometry
    readonly maxWidth: number;            // Maximum frame width allocated by the adapter
    readonly maxHeight: number;           // Maximum frame height allocated by the adapter
    readonly firmware: "bios" | "hle";   // Firmware mode reported by the core
    readonly controllers: Readonly<Record<ControllerPort, PsxControllerType>>; // Realized device per port
    readonly discCount: number;           // Number of switchable discs in the package
}

// INTERFACE :: psxGeometry & {rgba:uint8ClampedArray}
// One complete video frame in tightly packed RGBA byte order.
export interface PsxFrameEvent extends PsxGeometry {
    readonly rgba: Uint8ClampedArray;    // Width by height pixels with four bytes per pixel
}

// INTERFACE :: {productionToPostMs:NUMBER, postToReceiptMs:NUMBER, productionToReceiptMs:NUMBER}
// Development-only PCM transport timing spanning the worker batch and main-thread receipt.
export interface PsxSoundTransportTiming {
    readonly productionToPostMs: number;       // Completed conversion until endpoint post
    readonly postToReceiptMs: number;          // Endpoint post until main-thread message receipt
    readonly productionToReceiptMs: number;    // Complete worker-to-main transport interval
}

// INTERFACE :: {samples:float32Array, frames:NUMBER, transport:psxSoundTransportTiming?}
// One interleaved stereo audio chunk emitted at the machine sample rate.
export interface PsxSoundEvent {
    readonly samples: Float32Array;    // Left-right interleaved normalized samples
    readonly frames: number;           // Stereo frame count represented by samples
    readonly transport?: PsxSoundTransportTiming; // Development-only timing when instrumentation is active
}

// INTERFACE :: {frames:NUMBER, batches:NUMBER, batchAverageFrames:NUMBER, batchMaximumFrames:NUMBER, batchAverageMs:NUMBER, batchMaximumMs:NUMBER, coreAverageMs:NUMBER, extractionAverageMs:NUMBER, videoAverageMs:NUMBER, audioAverageMs:NUMBER, workerAverageMs:NUMBER, workerMaximumMs:NUMBER, turnaroundSamples:NUMBER, turnaroundAverageMs:NUMBER, turnaroundMaximumMs:NUMBER, pcmHoldSamples:NUMBER, pcmHoldAverageMs:NUMBER, pcmHoldMaximumMs:NUMBER, discReadCalls:NUMBER, discReadRequestedBytes:NUMBER, discReadReturnedBytes:NUMBER, discReadMilliseconds:NUMBER, discSeekCalls:NUMBER, discSeekMilliseconds:NUMBER}
// Low-frequency worker-stage timing aggregated over a bounded frame window.
export interface PsxPerformanceTiming {
    readonly frames: number;                   // Emulated frames represented by this timing window
    readonly batches: number;                  // Productive worker ticks represented by the window
    readonly batchAverageFrames: number;       // Average emulated frames per productive tick
    readonly batchMaximumFrames: number;       // Largest productive tick in emulated frames
    readonly batchAverageMs: number;           // Average productive tick duration
    readonly batchMaximumMs: number;           // Slowest productive tick duration
    readonly coreAverageMs: number;            // Average native core execution time per frame
    readonly extractionAverageMs: number;      // Average native AV extraction time per frame
    readonly videoAverageMs: number;           // Average RGBA conversion time per frame
    readonly audioAverageMs: number;           // Average PCM conversion time per frame
    readonly workerAverageMs: number;          // Average complete worker processing time per frame
    readonly workerMaximumMs: number;          // Slowest complete worker frame in the window
    readonly turnaroundSamples: number;        // Immediate worker/main continuation roundtrips measured
    readonly turnaroundAverageMs: number;      // Average immediate continuation roundtrip
    readonly turnaroundMaximumMs: number;      // Slowest immediate continuation roundtrip
    readonly pcmHoldSamples: number;            // Completed PCM payloads measured before batch return
    readonly pcmHoldAverageMs: number;          // Average completed-PCM wait until batch return
    readonly pcmHoldMaximumMs: number;          // Longest completed-PCM wait until batch return
    readonly discReadCalls: number;             // Underlying mounted-Blob reads in the window
    readonly discReadRequestedBytes: number;    // Bytes requested from mounted Blobs in the window
    readonly discReadReturnedBytes: number;     // Bytes returned from mounted Blobs in the window
    readonly discReadMilliseconds: number;      // Synchronous WORKERFS read time in the window
    readonly discSeekCalls: number;             // WORKERFS logical seek operations in the window
    readonly discSeekMilliseconds: number;      // Synchronous WORKERFS seek time in the window
}

// INTERFACE :: {port:controllerPort, strong:NUMBER, weak:NUMBER}
// Normalized strong- and weak-motor rumble state for one controller.
export interface PsxRumbleEvent {
    readonly port: ControllerPort;    // Controller receiving the effect
    readonly strong: number;          // Large-motor magnitude in the inclusive zero-to-one range
    readonly weak: number;            // Small-motor magnitude in the inclusive zero-to-one range
}

// TYPE :: ARRAY<STRING, STRING|NUMBER|BOOLEAN>
// Core option values keyed by the option name understood by the adapter.
export type PsxOptions = Readonly<Record<string, string | number | boolean>>;

// INTERFACE :: {game:discSet, bios:biosImage, initialDiscIndex:NUMBER?, controllers:portMap?, memoryCards:portMap?, options:psxOptions?}
// Complete immutable input required to start one emulation session.
export interface PsxStartConfig {
    readonly game: DiscSet;              // Auditable package mounted for the session
    readonly bios: BiosImage;            // User-provided firmware image
    readonly initialDiscIndex?: number;  // Zero-based disc mounted at startup; defaults to the first
    readonly controllers?: Readonly<Partial<Record<ControllerPort, PsxControllerType>>>; // Device override per port
    readonly memoryCards?: Readonly<Partial<Record<ControllerPort, Uint8Array>>>;         // Initial 128 KiB card per slot
    readonly options?: PsxOptions;        // Adapter-specific core options
}

// INTERFACE :: active machine control, persistence, lifecycle, and event subscription surface
// Running adapter session owned by exactly one player until exit.
export interface PsxSession {
    readonly machine: PsxMachineInfo;      // Immutable realized machine description
    readonly discIndex: number;            // Currently mounted zero-based disc index
    readonly trayOpen: boolean;            // True while a disc swap transaction has the virtual tray open
    readonly playbackRate: PsxPlaybackRate; // Requested emulation-time multiplier
    readonly performance?: PsxPerformanceTiming | null; // Latest optional worker timing window
    setButton(control: PsxButtonControl, pressed: boolean): void;              // Changes one digital control state
    setAxis(control: PsxAxisControl, value: number): void;                     // Changes one normalized analog axis
    setPlaybackRate(rate: PsxPlaybackRate): void;                              // Changes the best-effort execution multiplier
    pause(): void;                                                              // Suspends frame execution
    resume(): void;                                                             // Resumes frame execution
    reset(kind: "soft" | "hard"): Promise<void>;                              // Resets the emulated machine
    setDisc(index: number): Promise<void>;                                      // Mounts one package disc through a tray cycle
    readMemoryCard(slot: ControllerPort): Promise<Uint8Array>;                  // Copies the current card bytes for one slot
    serializeState(): Promise<Uint8Array>;                                      // Captures a portable core state snapshot
    unserializeState(bytes: Uint8Array): Promise<void>;                         // Restores a compatible state snapshot
    exit(): Promise<void>;                                                      // Stops execution and releases adapter resources
    onTick(listener: Listener<void>): Unsubscribe;                              // Observes emulation ticks
    onFrame(listener: Listener<PsxFrameEvent>): Unsubscribe;                    // Observes completed video frames
    onSound(listener: Listener<PsxSoundEvent>): Unsubscribe;                    // Observes produced audio chunks
    onRumble(listener: Listener<PsxRumbleEvent>): Unsubscribe;                  // Observes controller motor changes
    onExit(listener: Listener<void>): Unsubscribe;                              // Observes terminal session exit
}

// INTERFACE :: {type:STRING, start:(psxStartConfig -> PROMISE(psxSession))}
// Replaceable emulation backend capable of starting one validated session.
export interface PsxAdapter {
    readonly type: string;                                     // Stable backend kind identifier
    start(config: PsxStartConfig): Promise<PsxSession>;        // Starts a session from validated content and firmware
}

// INTERFACE :: {id:STRING, notice:discPath}
// Third-party component license declaration shipped with a core build.
export interface PsxBuildLicense {
    readonly id: string;        // SPDX identifier or stable component license name
    readonly notice: string;    // Package-relative notice file path
}

// INTERFACE :: immutable core build provenance, capabilities, firmware contract, memory limits, and licenses
// Auditable manifest binding packaged artifacts to their toolchain and supported runtime contract.
export interface PsxBuildInfo {
    readonly formatVersion: 1;                 // Manifest schema version
    readonly adapter: "libretro-psx";         // Runtime adapter required by these artifacts
    readonly buildId: string;                  // Lowercase SHA-256 identity of the build
    readonly core: string;                     // Emulation core name
    readonly coreVersion: string;              // Upstream core release identity
    readonly coreCommit: string;               // Exact lowercase upstream Git commit
    readonly emsdkVersion: string;             // Emscripten toolchain version used to compile the core
    readonly artifacts: ReadonlyArray<string>; // Unique package-relative runtime artifacts
    readonly supportedContent: ReadonlyArray<"cue" | "m3u" | "sbi">; // Accepted descriptor and patch kinds
    readonly controllerTypes: ReadonlyArray<PsxControllerType>;         // Devices compiled into the adapter
    readonly firmware: {
        readonly required: true;                                // Confirms external firmware is mandatory
        readonly byteLengths: ReadonlyArray<number>;            // Accepted positive firmware image sizes
        readonly systemFilenames: Readonly<Record<PsxRegion, string>>; // Core-visible filename per region
    };                                                          // Firmware discovery contract
    readonly memory: { readonly initialPages: number; readonly maximumPages: number }; // WebAssembly page bounds
    readonly pthreads: false;                                   // Confirms the build is single-threaded
    readonly licenses: ReadonlyArray<PsxBuildLicense>;          // Notices covering bundled third-party work
}

/**
 *
 * Runtime Constants
 *
 */

const PSX_REGIONS: ReadonlyArray<PsxRegion> = ["ntsc-u", "ntsc-j", "pal"];
const PSX_PLAYBACK_RATES: ReadonlyArray<PsxPlaybackRate> = [1, 2, 5, 7];
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

/**
 *
 * Type Predicates
 *
 */

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a non-null object suitable for structural inspection.
const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a string containing at least one non-whitespace character.
const isNonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a finite JavaScript number.
const isFiniteNumber = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is an integer greater than zero.
const isPositiveInteger = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value > 0;

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is an integer of at least zero.
const isNonNegativeInteger = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0;

// PREDICATE :: UNKNOWN, (UNKNOWN -> BOOLEAN) -> BOOLEAN
// True when value is an array and every member satisfies predicate.
const isArrayOf = (value: unknown, predicate: (item: unknown) => boolean): boolean =>
    Array.isArray(value) && value.every(predicate);

// PREDICATE :: OBJECT, [STRING] -> BOOLEAN
// True when every own key is a string included in the allowed key set.
const hasOnlyKeys = (value: object, allowed: ReadonlyArray<string>): boolean =>
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.includes(key));

// PREDICATE :: [<T>] -> BOOLEAN
// True when an array contains no duplicate values under Set equality.
const isUnique = <T>(values: ReadonlyArray<T>): boolean => new Set(values).size === values.length;

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value exposes the complete Blob binary-data surface used by the runtime.
const isBlob = (value: unknown): value is Blob => isObject(value)
    && isNonNegativeInteger(value.size)
    && typeof value.type === "string"
    && typeof value.arrayBuffer === "function"
    && typeof value.slice === "function"
    && typeof value.stream === "function"
    && typeof value.text === "function";

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is an unsigned eight-bit typed array, including cross-realm instances.
const isUint8Array = (value: unknown): value is Uint8Array =>
    value instanceof Uint8Array || Object.prototype.toString.call(value) === "[object Uint8Array]";

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a clamped unsigned eight-bit typed array, including cross-realm instances.
const isUint8ClampedArray = (value: unknown): value is Uint8ClampedArray =>
    value instanceof Uint8ClampedArray
    || Object.prototype.toString.call(value) === "[object Uint8ClampedArray]";

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a 32-bit floating-point typed array, including cross-realm instances.
const isFloat32Array = (value: unknown): value is Float32Array =>
    value instanceof Float32Array || Object.prototype.toString.call(value) === "[object Float32Array]";

// PREDICATE :: UNKNOWN, (UNKNOWN -> BOOLEAN), BOOLEAN -> BOOLEAN
// True when value is a controller-port map whose present values satisfy predicate and whose completeness matches requireBoth.
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

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value supplies animation-frame request and cancellation operations.
export function isFrameScheduler(value: unknown): value is FrameScheduler {
    return isObject(value) && typeof value.request === "function" && typeof value.cancel === "function";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a coherent binary fetch response with an HTTP-compatible status.
export function isFetchResponseLike(value: unknown): value is FetchResponseLike {
    return isObject(value) && typeof value.ok === "boolean"
        && isNonNegativeInteger(value.status) && value.status <= 599
        && typeof value.arrayBuffer === "function";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is one of the runtime's supported PlayStation regions.
export function isPsxRegion(value: unknown): value is PsxRegion {
    return PSX_REGIONS.includes(value as PsxRegion);
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is one of the supported normal or fast-forward multipliers.
export function isPsxPlaybackRate(value: unknown): value is PsxPlaybackRate {
    return PSX_PLAYBACK_RATES.includes(value as PsxPlaybackRate);
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a normalized safe package-relative disc path.
export function isDiscPath(value: unknown): value is DiscPath {
    if (!isNonEmptyString(value) || value !== value.trim() || value.startsWith("/")
        || value.includes("\\") || CONTROL_CHARACTER_PATTERN.test(value)
        || URL_SCHEME_PATTERN.test(value) || DRIVE_LETTER_PATTERN.test(value)) return false;
    const segments = value.split("/");
    return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value binds a valid package-relative path to Blob content.
export function isDiscFile(value: unknown): value is DiscFile {
    return isObject(value) && isDiscPath(value.path) && isBlob(value.blob);
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a bounded disc package with unique paths and a contained entry descriptor.
export function isDiscSet(value: unknown): value is DiscSet {
    if (!isObject(value) || !isNonEmptyString(value.gameId) || !isDiscPath(value.entry)
        || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > 64
        || !value.files.every(isDiscFile)) return false;
    const paths = value.files.map(({ path }) => path);
    const foldedPaths = paths.map((path) => path.toLowerCase());
    return isUnique(foldedPaths) && paths.includes(value.entry);
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a named regional firmware Blob with an optional lowercase SHA-256 digest.
export function isBiosImage(value: unknown): value is BiosImage {
    return isObject(value) && isNonEmptyString(value.name) && isPsxRegion(value.region)
        && isBlob(value.blob)
        && (value.sha256 === undefined || (typeof value.sha256 === "string" && SHA256_PATTERN.test(value.sha256)));
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value describes one positive-length data or audio track dependency.
export function isAuditedTrack(value: unknown): value is AuditedTrack {
    return isObject(value) && isDiscPath(value.file)
        && (value.kind === "data" || value.kind === "audio")
        && isPositiveInteger(value.bytes);
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value describes one CUE with a bounded track list and optional SBI patch.
export function isAuditedDiscEntry(value: unknown): value is AuditedDiscEntry {
    return isObject(value) && isDiscPath(value.cue)
        && Array.isArray(value.tracks) && value.tracks.length > 0 && value.tracks.length <= 99
        && value.tracks.every(isAuditedTrack)
        && (value.sbi === undefined || isDiscPath(value.sbi));
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a coherent bounded audit result with unique discs and consistent aggregate bytes.
export function isAuditedDisc(value: unknown): value is AuditedDisc {
    if (!isObject(value) || !isDiscPath(value.entry)
        || !Array.isArray(value.discs) || value.discs.length === 0 || value.discs.length > 8
        || !value.discs.every(isAuditedDiscEntry)
        || !isNonNegativeInteger(value.totalBytes)
        || !isArrayOf(value.warnings, (warning) => typeof warning === "string")) return false;
    const cues = value.discs.map(({ cue }) => cue.toLowerCase());
    const uniqueTracks = new Map<string, number>();
    for (const track of value.discs.flatMap(({ tracks }) => tracks)) {
        const previous = uniqueTracks.get(track.file);
        if (previous !== undefined && previous !== track.bytes) return false;
        uniqueTracks.set(track.file, track.bytes);
    }
    const trackBytes = [...uniqueTracks.values()].reduce((total, bytes) => total + bytes, 0);
    return isUnique(cues) && Number.isSafeInteger(trackBytes) && value.totalBytes >= trackBytes;
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value names controller and memory-card port one or two.
export function isControllerPort(value: unknown): value is ControllerPort {
    return CONTROLLER_PORTS.includes(value as ControllerPort);
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a supported emulated controller device type.
export function isPsxControllerType(value: unknown): value is PsxControllerType {
    return CONTROLLER_TYPES.includes(value as PsxControllerType);
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a canonical PlayStation digital button name.
export function isPsxButton(value: unknown): value is PsxButton {
    return PSX_BUTTONS.includes(value as PsxButton);
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a canonical DualShock analog-axis name.
export function isPsxAxis(value: unknown): value is PsxAxis {
    return PSX_AXES.includes(value as PsxAxis);
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value addresses a valid logical button on a valid controller port.
export function isPsxButtonControl(value: unknown): value is PsxButtonControl {
    return isObject(value) && isControllerPort(value.port) && isPsxButton(value.button);
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value addresses a valid analog axis on a valid controller port.
export function isPsxAxisControl(value: unknown): value is PsxAxisControl {
    return isObject(value) && isControllerPort(value.port) && isPsxAxis(value.axis);
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value contains positive pixel dimensions and a positive finite aspect ratio.
export function isPsxGeometry(value: unknown): value is PsxGeometry {
    return isObject(value) && isPositiveInteger(value.width) && isPositiveInteger(value.height)
        && isFiniteNumber(value.aspectRatio) && value.aspectRatio > 0;
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a coherent realized-machine description within supported runtime bounds.
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

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value carries exact RGBA storage for its declared video geometry.
export function isPsxFrameEvent(value: unknown): value is PsxFrameEvent {
    return isObject(value) && isPsxGeometry(value) && isUint8ClampedArray(value.rgba)
        && value.rgba.length === value.width * value.height * 4;
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value carries exactly two floating-point samples per declared stereo frame.
export function isPsxSoundEvent(value: unknown): value is PsxSoundEvent {
    return isObject(value) && isNonNegativeInteger(value.frames) && isFloat32Array(value.samples)
        && value.samples.length === value.frames * 2
        && (value.transport === undefined || isPsxSoundTransportTiming(value.transport));
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value carries coherent non-negative PCM transport-stage durations.
export function isPsxSoundTransportTiming(value: unknown): value is PsxSoundTransportTiming {
    return isObject(value) && isFiniteNumber(value.productionToPostMs) && value.productionToPostMs >= 0
        && isFiniteNumber(value.postToReceiptMs) && value.postToReceiptMs >= 0
        && isFiniteNumber(value.productionToReceiptMs) && value.productionToReceiptMs >= 0
        && value.productionToReceiptMs >= value.productionToPostMs
        && value.productionToReceiptMs >= value.postToReceiptMs;
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value contains one coherent non-negative worker timing window.
export function isPsxPerformanceTiming(value: unknown): value is PsxPerformanceTiming {
    if (!isObject(value) || !isPositiveInteger(value.frames) || !isPositiveInteger(value.batches)
        || value.batches > value.frames || !isNonNegativeInteger(value.turnaroundSamples)
        || value.turnaroundSamples > value.batches || !isPositiveInteger(value.batchMaximumFrames)
        || !isNonNegativeInteger(value.pcmHoldSamples) || value.pcmHoldSamples > value.frames
        || !isNonNegativeInteger(value.discReadCalls)
        || !isNonNegativeInteger(value.discReadRequestedBytes)
        || !isNonNegativeInteger(value.discReadReturnedBytes)
        || value.discReadReturnedBytes > value.discReadRequestedBytes
        || !isNonNegativeInteger(value.discSeekCalls)) return false;
    const timings = [
        value.batchAverageFrames,
        value.batchAverageMs,
        value.batchMaximumMs,
        value.coreAverageMs,
        value.extractionAverageMs,
        value.videoAverageMs,
        value.audioAverageMs,
        value.workerAverageMs,
        value.workerMaximumMs,
        value.turnaroundAverageMs,
        value.turnaroundMaximumMs,
        value.pcmHoldAverageMs,
        value.pcmHoldMaximumMs,
        value.discReadMilliseconds,
        value.discSeekMilliseconds,
    ];
    return timings.every((timing) => isFiniteNumber(timing) && timing >= 0)
        && (value.batchAverageFrames as number) >= 1
        && (value.batchMaximumFrames as number) >= (value.batchAverageFrames as number)
        && (value.batchMaximumMs as number) >= (value.batchAverageMs as number)
        && (value.workerMaximumMs as number) >= (value.workerAverageMs as number)
        && (value.turnaroundMaximumMs as number) >= (value.turnaroundAverageMs as number)
        && (value.pcmHoldMaximumMs as number) >= (value.pcmHoldAverageMs as number)
        && (value.turnaroundSamples !== 0
            || (value.turnaroundAverageMs === 0 && value.turnaroundMaximumMs === 0))
        && (value.pcmHoldSamples !== 0
            || (value.pcmHoldAverageMs === 0 && value.pcmHoldMaximumMs === 0));
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value contains normalized strong and weak rumble magnitudes for a valid port.
export function isPsxRumbleEvent(value: unknown): value is PsxRumbleEvent {
    return isObject(value) && isControllerPort(value.port)
        && isFiniteNumber(value.strong) && value.strong >= 0 && value.strong <= 1
        && isFiniteNumber(value.weak) && value.weak >= 0 && value.weak <= 1;
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value maps non-empty option names to primitive adapter option values.
export function isPsxOptions(value: unknown): value is PsxOptions {
    return isObject(value) && Reflect.ownKeys(value).every((key) => typeof key === "string"
        && isNonEmptyString(key)
        && (typeof value[key] === "string" || typeof value[key] === "boolean" || isFiniteNumber(value[key])));
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value contains valid game, firmware, controller, card, and option startup inputs.
export function isPsxStartConfig(value: unknown): value is PsxStartConfig {
    return isObject(value) && isDiscSet(value.game) && isBiosImage(value.bios)
        && (value.initialDiscIndex === undefined || isNonNegativeInteger(value.initialDiscIndex))
        && (value.controllers === undefined || isPortRecord(value.controllers, isPsxControllerType, false))
        && (value.memoryCards === undefined || isPortRecord(
            value.memoryCards,
            (card) => isUint8Array(card) && card.byteLength === MEMORY_CARD_BYTES,
            false,
        ))
        && (value.options === undefined || isPsxOptions(value.options));
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value exposes coherent live-session state and every required operation.
export function isPsxSession(value: unknown): value is PsxSession {
    return isObject(value) && isPsxMachineInfo(value.machine)
        && isNonNegativeInteger(value.discIndex) && value.discIndex < value.machine.discCount
        && typeof value.trayOpen === "boolean"
        && isPsxPlaybackRate(value.playbackRate)
        && [
            "setButton", "setAxis", "setPlaybackRate", "pause", "resume", "reset", "setDisc", "readMemoryCard",
            "serializeState", "unserializeState", "exit", "onTick", "onFrame", "onSound",
            "onRumble", "onExit",
        ].every((method) => typeof value[method] === "function");
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value identifies an adapter and exposes its session startup operation.
export function isPsxAdapter(value: unknown): value is PsxAdapter {
    return isObject(value) && isNonEmptyString(value.type) && typeof value.start === "function";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value names a license and a safe package-relative notice path.
export function isPsxBuildLicense(value: unknown): value is PsxBuildLicense {
    return isObject(value) && isNonEmptyString(value.id) && isDiscPath(value.notice);
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a complete internally consistent manifest for a supported core build.
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
