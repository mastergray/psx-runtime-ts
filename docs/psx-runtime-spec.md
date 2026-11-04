# Browser PlayStation Runtime — Implementation Spec

**Status:** implementation contract for `psx-runtime-ts`; M0–M2 complete

**Target:** the first usable desktop-browser release (`v1.0.0`)

**Reference implementation:** `/home/mastergray/dev/arcade-runtime-ts`

This project follows the same boundary as `arcade-runtime-ts`: the runtime
owns emulator construction, timing, video, audio, input, persistence and
failure cleanup; the consuming page owns HTML, layout, game discovery and
the lawful acquisition of game and firmware files. It reuses the arcade
runtime's lifecycle and testing conventions, but replaces the MAME-specific
parts with PlayStation concepts.

The primary implementation is a pinned, source-built libretro PlayStation
core driven by a small in-repository C shim. RetroArch is not embedded. The
shim implements only the libretro frontend services required by the pinned
core and exports a narrow API to a dedicated Web Worker. The worker is a
product requirement, not an optimization: it permits synchronous, random
access to user-supplied `Blob`s through Emscripten `WORKERFS` without copying
an entire CD image into the Wasm heap or blocking the page's main thread.

Milestone M0 selected PCSX-ReARMed and Emscripten 6.0.2 after completing the
P1–P12 comparison. Their exact production identities are committed in
`core/SOURCE.json` and `core/EMSDK_VERSION`; the full measurements remain in
`docs/probes/m0-results.json`. No production work may silently track upstream.

---

## 0. Product contract

The product is a TypeScript library for evergreen browsers. It succeeds when
a page author can compose the exported classes with their own UI and:

1. boot a lawfully obtained NTSC or PAL PlayStation disc with a user-supplied
   BIOS;
2. play with keyboard or standard gamepads using digital or DualShock-style
   controls;
3. receive correctly paced, dynamically sized video and synchronized stereo
   audio;
4. change discs in a multi-disc game without restarting the session;
5. preserve both memory cards and named save states across page reloads; and
6. recover cleanly from invalid media, unsupported browsers and failures at
   every asynchronous startup boundary.

Emulator implementation details stop at `PsxAdapter`/`PsxSession`. Display,
audio, input, storage and page composition must not import an Emscripten
module, libretro constant or worker protocol type.

### 0.1 Mapping from `arcade-runtime-ts`

| Arcade runtime | PSX runtime | Important difference |
| --- | --- | --- |
| MAME family build | one pinned PSX core build | PS1 is one console; there is no board-family matrix |
| MAME web OSD bridge | libretro frontend shim | the shim calls `retro_*` directly; RetroArch is not used |
| `MameEmulatorAdapter` | `LibretroPsxAdapter` | the PSX adapter always hosts its module in a Worker |
| `ArcadePlayer` | `PsxPlayer` | adds disc-change and memory-card operations |
| `ArcadeInput` | `PsxInput` | uses PS1 pad buttons and signed analog axes |
| `ArcadeDisplay` | `PsxDisplay` | frame geometry may change while a game is running |
| `ArcadeAudio` | `PsxAudio` | consumes the core-reported rate, normally 44.1 kHz |
| `RomSetAudit` | `DiscSetAudit` | validates CUE/M3U references and track files, not parent/BIOS ROM sets |
| `ArcadeStorage` | `PsxStorage` | stores firmware and raw memory-card images separately from build-locked save states |
| `ArcadeRomStore` | `PsxGameStore` | stores potentially very large `Blob`s and a normalized disc manifest |
| `ArcadeCabinet` | `PsxConsole` | console-oriented composition root; no DIP/coin/service concepts |

The shared behavior remains: deterministic constructors, browser defaults in
async `init` factories, validated structural types, one typed error class,
fresh emulator state per start, explicit pause/resume/reset/exit, idempotent
input channels, cumulative persistence, dependency injection and separate
Node/browser test suites.

### 0.2 Definition of `v1.0.0`

The first release includes:

- one pinned, single-threaded software-rendered core that passes M0;
- required CUE/BIN support, including multi-track data/audio discs;
- required M3U support for multi-disc games;
- optional same-basename SBI sidecars when the selected core supports them;
- a required real retail BIOS supplied by the user;
- ports 1 and 2 with digital pad and DualShock input;
- keyboard and Gamepad API sources;
- best-effort `×2`, `×5` and `×7` fast-forward controls;
- two persistent 128 KiB memory-card images;
- named save states with strict core-build and game identity checks;
- raw-file, directory and ZIP loading, optional IndexedDB firmware and game
  storage, and a developer harness; and
- Chromium release gates for NTSC, PAL, multi-track and multi-disc fixtures.

CHD, PBP, ECM, CCD/IMG/SUB, MDF/MDS, non-ZIP archives, light guns,
mouse-based controllers, NegCon, multitap, cheats, rewind, run-ahead, netplay,
achievements, shaders and enhanced internal resolution are not v1 features.
They require explicit later milestones rather than pass-through core options.

### 0.3 Game and firmware policy

The repository, npm package, hosted docs, CI artifacts and default harness
contain no commercial disc image or Sony BIOS, do not link to either, and do
not provide default download URLs.

- The runtime accepts files the page or its user supplies at run time.
- A page may explicitly store user-supplied BIOS bytes in browser-local
  IndexedDB. Firmware is keyed by region, removable independently, and never
  leaves the user's browser.
- Automated real-core tests use a reproducible, redistributable homebrew test
  disc built from committed source. Its toolchain and asset licenses are
  recorded beside the fixture.
- `npm pack` excludes local test inputs, emulator source caches and compiled
  core artifacts.

The TypeScript package may use a permissive project license, but a distributed
emulator binary must independently satisfy the pinned core and dependency
licenses. M0 records the complete license set. If the selected core is GPLv2,
any distributed corresponding binary/source arrangement must comply with that
license; keeping Wasm out of the npm tarball does not remove obligations from
someone who hosts it.

## 1. Package and architecture

### 1.1 Identity

| Field | Value |
| --- | --- |
| Package | `psx-runtime-ts` |
| Runtime | evergreen browsers with WebAssembly, Workers, `Blob`, File API, Web Audio, Canvas 2D, Gamepad API and IndexedDB |
| Test runtime | Node >= 22.13 for `spec`; Chromium for `browser` |
| Emulator | M0-pinned PCSX-ReARMed unless the recorded candidate comparison selects Beetle PSX |
| Frontend | in-repository `libretro/shim`, never RetroArch |
| Threading | one ordinary dedicated Worker; no Wasm pthreads in v1 |
| Rendering | core software framebuffer normalized to RGBA8888 |
| Disc I/O | read-only `Blob`s mounted through `WORKERFS`; generated descriptors in `MEMFS` |
| Persistence | main-thread IndexedDB through `PsxStorage`; no direct IDBFS ownership in the core |

The v1 path must not require `SharedArrayBuffer`, COOP/COEP headers, Asyncify,
WebGL or a service worker. Those requirements make ordinary static hosting
unnecessarily fragile. Transferable buffers and a small pool are sufficient
for v1 video/audio transport.

### 1.2 Repository layout

```text
psx-runtime-ts/
    core/
        SOURCE.json                 # written by M0: repository, commit, tree hash, license
        EMSDK_VERSION               # exact tested emsdk release
        patches/                    # ordered production patches only
        probes/                     # throwaway probe scripts and diagnostic patches
        build.json                  # source-controlled build recipe, not generated output
    libretro/
        include/libretro.h          # pinned with provenance or copied from the core tree
        shim/
            psx_frontend.c          # environment, video, audio, input, state and disk callbacks
            psx_frontend.h
            psx_exports.c           # narrow exported ABI
    src/
        index.ts
        shared.types.ts
        PsxRuntimeError/
        DiscSetAudit/
        LibretroPsxAdapter/
            LibretroPsxAdapter.ts
            PsxSession.ts
            WorkerClient.ts
            protocol.ts             # private discriminated worker messages
        worker/
            core.worker.ts          # the only Emscripten loader outside build tooling
            MountPlan.ts
        PsxInput/
        PsxDisplay/
        PsxAudio/
        PsxPlayer/
        KeyboardSource/
        GamepadSource/
        PsxStorage/
        PsxGameStore/
        PsxConsole/
        ZipDiscSource/
        ZipFirmwareSource/
    scripts/
        build-core.ts
        build-fixture.ts
        serve-harness.ts
        inspect-core-build.ts
    harness/
        index.html
        main.ts
    tests/
        fixtures/
            homebrew/                # source and deterministic build recipe; generated media ignored
        run.ts
        support/
        spec/
        browser/
    docs/
        psx-runtime-spec.md
        probes/
    package.json
    tsconfig.json
    tsconfig.package.json
    tsconfig.tests.json
```

Production patches and diagnostic probe patches are never mixed. Generated
core output goes to `dist/core/` and is excluded from the npm package unless a
future release makes a separately reviewed binary-distribution decision.

### 1.3 Runtime data flow

```text
page UI
  -> PsxConsole / PsxPlayer
      -> PsxInput -------------> LibretroPsxAdapter
      -> PsxDisplay <---frames---       |
      -> PsxAudio   <---audio----       | validated private messages
      -> PsxStorage <---cards/state     v
                                  dedicated Worker
                                  -> Emscripten module
                                  -> libretro shim
                                  -> pinned PSX core
                                  -> WORKERFS disc Blobs
```

The Worker is created per session. Exiting terminates it after the final
memory-card flush. A crashed or unresponsive Worker cannot poison the next
start because the next session gets a new Worker and module.

### 1.4 Public package surface

The root exports:

- `PsxRuntimeError`;
- `LibretroPsxAdapter`;
- `DiscSetAudit`;
- `PsxInput`, `PsxDisplay`, `PsxAudio`, `PsxPlayer`;
- `KeyboardSource`, `GamepadSource` and `DEFAULT_KEYBOARD_MAP`;
- `PsxStorage`, `PsxGameStore`, `PsxConsole`, `ZipDiscSource` and
  `ZipFirmwareSource`; and
- every public config/event type plus its structural predicate.

Worker message types, libretro constants, raw Emscripten module types, mount
plans, state envelope codecs and IndexedDB helpers are private. A grep for the
generated module factory name under `src/` must find only `core.worker.ts`.

## 2. Shared runtime contracts

The declarations below define the required shape. Implementations may split
them into feature-local `types.ts` files and re-export them from the root.

### 2.1 Content and firmware

```ts
type PsxRegion = "ntsc-u" | "ntsc-j" | "pal";
type DiscPath = string; // normalized non-empty relative POSIX path

interface DiscFile {
    readonly path: DiscPath;
    readonly blob: Blob;
}

interface DiscSet {
    readonly gameId: string;             // stable library/user identity, not a display title
    readonly entry: DiscPath;            // .cue for one disc or .m3u for a set
    readonly files: ReadonlyArray<DiscFile>;
}

interface BiosImage {
    readonly name: string;               // display/audit name only; never used as a path
    readonly region: PsxRegion;
    readonly blob: Blob;
    readonly sha256?: string;             // verified when supplied
}

interface AuditedDisc {
    readonly entry: DiscPath;
    readonly discs: ReadonlyArray<{
        readonly cue: DiscPath;
        readonly tracks: ReadonlyArray<{
            readonly file: DiscPath;
            readonly kind: "data" | "audio";
            readonly bytes: number;
        }>;
        readonly sbi?: DiscPath;
    }>;
    readonly totalBytes: number;
    readonly warnings: ReadonlyArray<string>;
}
```

Paths reject NUL, backslash, absolute paths, drive letters, URLs, empty
segments, `.`/`..`, control characters and case-folded duplicates. Limits are
64 files, 8 discs, 99 tracks per disc, 1 KiB per CUE line, 256 KiB per CUE and
256 KiB for the M3U. These are validation limits, not a claim about the
hardware.

`gameId` scopes cards and states. `PsxGameStore` generates it from a versioned
content fingerprint during import; direct API users may supply their own
stable ID. Display titles and filenames never serve as persistence identity.

### 2.2 Input

```ts
type ControllerPort = 1 | 2;
type PsxControllerType = "none" | "digital" | "dualshock";

type PsxButton =
    | "up" | "down" | "left" | "right"
    | "triangle" | "circle" | "cross" | "square"
    | "l1" | "r1" | "l2" | "r2"
    | "start" | "select" | "l3" | "r3";

type PsxAxis = "left-x" | "left-y" | "right-x" | "right-y";

interface PsxButtonControl {
    readonly port: ControllerPort;
    readonly button: PsxButton;
}

interface PsxAxisControl {
    readonly port: ControllerPort;
    readonly axis: PsxAxis;
}
```

Digital input is boolean. Analog values are finite numbers clamped to
`[-1, 1]`, with zero as center. Sources apply dead zones and response curves;
the session only converts normalized values to libretro's signed 16-bit range.
Opposing d-pad directions use last-input-wins, matching the arcade runtime.

### 2.3 Session and adapter

```ts
interface PsxGeometry {
    readonly width: number;
    readonly height: number;
    readonly aspectRatio: number;
}

interface PsxMachineInfo {
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

interface PsxFrameEvent extends PsxGeometry {
    readonly rgba: Uint8ClampedArray;    // valid until the next frame callback
}

interface PsxSoundEvent {
    readonly samples: Float32Array;      // interleaved stereo; valid until next callback
    readonly frames: number;
}

interface PsxRumbleEvent {
    readonly port: ControllerPort;
    readonly strong: number;             // normalized [0, 1]
    readonly weak: number;
}

interface PsxStartConfig {
    readonly game: DiscSet;
    readonly bios: BiosImage;
    readonly initialDiscIndex?: number;
    readonly controllers?: Readonly<Partial<Record<ControllerPort, PsxControllerType>>>;
    readonly memoryCards?: Readonly<Partial<Record<ControllerPort, Uint8Array>>>;
    readonly options?: Readonly<Record<string, string | number | boolean>>;
}

type PsxPlaybackRate = 1 | 2 | 5 | 7;

interface PsxSession {
    readonly machine: PsxMachineInfo;
    readonly discIndex: number;
    readonly trayOpen: boolean;
    readonly playbackRate: PsxPlaybackRate;
    setButton(control: PsxButtonControl, pressed: boolean): void;
    setAxis(control: PsxAxisControl, value: number): void;
    setPlaybackRate(rate: PsxPlaybackRate): void;
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

interface PsxAdapter {
    readonly type: string;
    start(config: PsxStartConfig): Promise<PsxSession>;
}
```

`setDisc(index)` performs the complete disk-control transaction: eject,
advance the core through an observable open-tray interval, set the index and
close. It rejects an invalid index and serializes against reset, state and exit
commands. A consumer never manipulates the core's disk callback table directly.

`serializeState` returns core bytes only. The player/storage layer adds the
versioned compatibility envelope in section 9. Memory-card reads always
return independent 131,072-byte copies.

### 2.4 Build metadata

```ts
interface PsxBuildInfo {
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
    readonly licenses: ReadonlyArray<{ readonly id: string; readonly notice: string }>;
}
```

`buildId` is SHA-256 over normalized source identity, patch hashes, shim hash,
toolchain identity and material compiler/linker flags. It contains no path or
timestamp. `build.json` is validated before any module JavaScript is loaded.

Every public interface has a structural predicate. Tests provide a passing
example followed by one case per rejected property and boundary.

## 3. `PsxRuntimeError`

One immutable error class follows `ArcadeRuntimeError`: numeric `code`, stable
`name`, human-readable `message`, immutable `data`, a frozen `CODE` registry,
a validating constructor and `PsxRuntimeError.is()`.

| Code | Name | Raised when |
| ---: | --- | --- |
| -1 | `INVALID_CODE` | constructor sentinel |
| 1 | `INVALID_CONFIG` | public input or config fails validation |
| 2 | `INVALID_MESSAGE` | constructor sentinel |
| 3 | `INTERNAL_ERROR` | an invariant or worker protocol is violated |
| 4 | `CORE_LOAD_FAILED` | build metadata, Worker, JS or Wasm fails to load/instantiate |
| 5 | `CONTENT_LOAD_FAILED` | a selected `Blob`, URL or stored game cannot be read |
| 6 | `DISC_SET_INVALID` | CUE/M3U/media validation fails; `data` is the audit report |
| 7 | `BIOS_INVALID` | BIOS size, region or supplied hash is invalid |
| 8 | `CORE_START_FAILED` | `retro_init` or `retro_load_game` fails |
| 9 | `NOT_STARTED` | a session operation occurs before start resolves |
| 10 | `ALREADY_STARTED` | start occurs while starting/running |
| 11 | `DESTROYED` | an operation occurs after terminal cleanup |
| 12 | `FULLSCREEN_FAILED` | fullscreen request rejects |
| 13 | `AUDIO_FAILED` | audio context/unlock/node creation fails |
| 14 | `STORAGE_FAILED` | IndexedDB, quota or blob persistence fails |
| 15 | `STATE_FAILED` | serialize/unserialize fails |
| 16 | `STATE_INCOMPATIBLE` | state envelope belongs to another build/game/format |
| 17 | `DISC_CHANGE_FAILED` | the core rejects a disk-control operation |
| 18 | `UNSUPPORTED` | browser or requested controller/content/option is unsupported |
| 19 | `WORKER_FAILED` | Worker crashes, sends malformed output or misses a terminal timeout |
| 20 | `MEMORY_EXCEEDED` | Wasm reaches its configured maximum memory |
| 21 | `ARCHIVE_INVALID` | a ZIP is malformed, unsafe, encrypted, ambiguous or exceeds extraction limits |

Core logs are attached as bounded ordered records. They never include original
local paths; the mount plan exposes generated `/content/...` names to the core.

## 4. Core selection, build and bridge

### 4.1 M0 selection rule

M0 builds the same shim and fixture against:

1. **PCSX-ReARMed** with all native dynarecs, architecture assembly and
   background compilation disabled; and
2. **Beetle PSX** in its software-rendered configuration.

Both are pinned to immutable commits before measurement. The production core
is the smallest candidate that passes every required probe and sustains its
reported NTSC and PAL rates on the release reference desktop. Accuracy wins
over a modest size difference; a candidate with known memory-card corruption,
incorrect CD audio or unstable state restore cannot win on speed.

The decision record under `docs/probes/core-selection.md` contains source and
submodule identities, licenses, build size, startup time, 60-second frame/audio
statistics, peak Wasm memory, browser memory, failures and the final decision.
Changing the pin or toolchain reopens these probes.

### 4.2 Build pipeline (`scripts/build-core.ts`)

The build script:

1. reads `SOURCE.json` and `EMSDK_VERSION`;
2. obtains or verifies the exact core checkout and recursive submodules in an
   ignored cache;
3. applies `core/patches/*.patch` in lexical order and fails on drift;
4. compiles the core as a static libretro library with native dynarecs,
   assembly, pthreads and hardware rendering disabled;
5. links the static core and `libretro/shim` with the pinned Emscripten;
6. uses optimized, modular, ES-module Worker output, filesystem support,
   `WORKERFS`, memory growth with a measured maximum, and explicit exports;
7. does **not** enable Asyncify, pthreads, proxy-to-pthread or preload files;
8. emits `psx-core.js`, `psx-core.wasm`, `core.worker.js`, `build.json`, source
   offer/notices and a build report under `dist/core/`; and
9. runs `inspect-core-build.ts`, which rejects unpinned paths, unexpected
   imports/exports, pthread/Asyncify features, missing licenses or a metadata
   fingerprint mismatch.

Recommended flags are recorded in `core/build.json`; the checked-in recipe is
the authority. Memory starts at the smallest measured safe value and may grow
only to the measured ceiling. A fixed arbitrary 1 GiB heap is not acceptable.

Two clean builds from the same checkout must produce byte-identical Wasm,
worker code and normalized metadata. If the Emscripten wrapper embeds
non-deterministic text, the script normalizes or removes it before hashing.

### 4.3 Required libretro frontend behavior

The shim implements and tests only the environment services needed by the
pinned core:

- core logging and bounded messages;
- system/save/content directory queries;
- pixel-format negotiation for 0RGB1555, RGB565 and XRGB8888;
- geometry and full AV-info updates;
- core option discovery and reads through an explicit TypeScript allowlist;
- controller descriptions and `retro_set_controller_port_device`;
- input poll/state for joypad and analog devices;
- audio sample and audio batch callbacks;
- software video refresh, including duplicate/null frames;
- rumble interface;
- standard and extended disk-control interfaces; and
- serialization and save-RAM memory queries.

Hardware rendering requests return false in v1. Unknown environment commands
are logged once and otherwise fail according to libretro semantics. The shim
must not claim support it does not implement.

The core call order is fixed:

```text
retro_set_environment / video / audio / input callbacks
retro_init
retro_set_controller_port_device (ports 0 and 1)
restore memory-card bytes
retro_load_game(path-only retro_game_info)
retro_get_system_av_info
retro_run ...
retro_unload_game
retro_deinit
```

If the selected core requires card restoration after `retro_load_game`, M0
records and tests that deviation explicitly; it must not be hidden in ad hoc
TypeScript timing.

### 4.4 Narrow exported ABI

The generated module exports C functions equivalent to:

```c
int psx_start(const char *content_path, const char *options_json);
int psx_run_frame(int capture_video, int capture_audio, unsigned frameskip_interval);
void psx_set_button(unsigned port, unsigned id, int pressed);
void psx_set_axis(unsigned port, unsigned id, int16_t value);
int psx_reset(void);
size_t psx_serialize_size(void);
int psx_serialize(void *out, size_t size);
int psx_unserialize(const void *data, size_t size);
size_t psx_memory_card_size(unsigned slot);
int psx_read_memory_card(unsigned slot, void *out, size_t size);
int psx_write_memory_card(unsigned slot, const void *data, size_t size);
int psx_set_disc(unsigned index);
int psx_disc_count(void);
void psx_stop(void);
```

Names may differ, but the surface must remain this narrow. Raw `retro_*`
symbols are not invoked from TypeScript. Callback registration is established
once during module construction; no unbounded function-table entries are
created per frame or session.

### 4.5 Worker protocol and pacing

Every command and response has a monotonically increasing request ID and a
session generation. Commands that mutate the core execute FIFO. `start`,
`setDisc`, `reset`, state operations and `exit` receive explicit success or
typed failure responses. High-frequency input messages may be coalesced by
control key, but their final value and ordering relative to lifecycle commands
must be preserved.

The main thread sends animation timestamps. The worker maintains an elapsed
time accumulator using the core-reported FPS and calls `psx_run_frame()` once
per complete emulated period, up to four frames per normal-speed browser tick.
Only one pacing tick may be in flight. Fast-forward scales elapsed emulation
time by `×2`, `×5` or `×7` and raises the bounded per-tick work cap for
that batch. It discards excess backlog after the applicable cap and reports a
dropped-time counter, so accelerated rates remain best effort instead of
building an unbounded Worker queue. PAL therefore runs at its reported ~50 Hz
and NTSC at the core's reported rate on 60, 90, 120 and 144 Hz displays.
Timing never assumes exactly 60 Hz.

`onTick` fires for each completed `retro_run`, even when video is duplicate or
dropped. Pause stops `retro_run`, releases effective input and trims queued
audio. Resume resets the time accumulator so paused wall time is not replayed.
Accelerated batches discard core audio, and the player clears its queued Web
Audio at every playback-rate boundary so stale sound cannot continue after
returning to normal speed. Accelerated frames suppress native and JavaScript
audio copies and select the core's bounded fixed-interval frameskip to reduce
rendering work. Each frame still accepts a video callback so rendered frames are
not lost when the core's internal skip phase differs from a worker batch boundary.
Normal speed disables core frameskip and captures every AV batch.

The worker converts the negotiated pixel format and pitch to tightly packed
RGBA8888. It transfers buffers from a pool of three; the main thread returns a
buffer after drawing. If all video buffers are outstanding, that video frame
is dropped while emulation and audio continue. Audio batches are converted
from signed 16-bit stereo to `Float32`, aggregated into bounded 10–30 ms
chunks and transferred separately.

Worker output is structurally validated before use. After an error or exit,
late messages with the old generation are ignored.

### 4.6 Large-disc mount plan

The original user paths never become Emscripten paths. `DiscSetAudit` produces
an internal mount plan:

1. each large track `Blob` receives a generated flat name and is mounted
   read-only under `/content/blob/` with `WORKERFS`;
2. normalized CUE and M3U files are regenerated under `/content/index/` in
   `MEMFS`, referencing only generated names;
3. an SBI sidecar, when present, receives the generated basename expected by
   the selected core;
4. the small BIOS is copied to `/system/` and card/state scratch data to
   `/save/`; and
5. `retro_load_game` receives the generated CUE or M3U path with `data = NULL`.

This plan prevents path traversal and avoids a disc-sized Wasm allocation.
The worker may read small descriptor and BIOS blobs in full; it must never call
`arrayBuffer()` or `FS.writeFile()` on a track image. Browser tests instrument
those calls and assert the rule for a sparse synthetic large `Blob`.

## 5. Content and firmware audit

### 5.1 `DiscSetAudit`

`DiscSetAudit.audit(set)` runs before a Worker or core is created and returns a
discriminated result with a complete ordered issue list.

For CUE files it:

- decodes UTF-8 (allowing an optional BOM) and rejects binary/control data;
- parses quoted and unquoted `FILE` directives without accepting shell or URL
  semantics;
- supports `BINARY` track files and the data/audio track modes required by the
  fixture and candidate core;
- resolves references relative to the CUE's logical directory;
- reports missing, ambiguous case, duplicate and unreferenced files;
- validates track numbers, index ordering and non-empty referenced blobs; and
- associates a same-basename `.sbi` while otherwise treating its bytes as an
  opaque core input.

For M3U files it ignores blank/comment lines, requires one to eight unique CUE
references, rejects nested M3U/URLs/absolute paths and audits every referenced
CUE. Ordering in the M3U is the public disc index.

The audit does not claim to authenticate a game dump or replace a preservation
database. It proves only that the supplied set is safe to mount and internally
complete. Core load failure remains `CORE_START_FAILED` with sanitized logs.

### 5.2 ZIP disc sources

`PsxConsole.resolveFiles`, and therefore `auditFiles`, `importFiles` and
`startFiles`, accepts the existing raw selection, one ZIP, or an ordered set of
two to eight ZIPs. A single ZIP may already contain a CUE or M3U set. Each ZIP
in an ordered multi-archive selection must contain exactly one CUE and no M3U;
`MultiZipDiscSource` namespaces each archive under `disc-N/`, generates one
M3U in caller order, audits every source disc, and audits the combined set.
ZIPs are transport containers: their CUE, BIN, M3U and SBI files enter the
same `DiscSetAudit` and mount-plan path as raw files. The core never receives
or interprets an archive.

Extraction resolves exact entry ranges from the classic or ZIP64 central
directory, then streams each stored/deflate payload. Data descriptors are
supported without scanning compressed bytes for ambiguous signatures. The
source can list validated CUE/M3U paths from central metadata without
expanding track content, allowing a page to request an entry only when
inference is ambiguous. The
reader rejects malformed or encrypted ZIPs, other compression methods, unsafe
or case-ambiguous paths, more than 64 files, an entry larger than 1 GiB, or
more than 8 GiB total compressed or expanded data. A ZIP may contain one
CUE/BIN disc or one M3U whose relative entries reach all included discs.
The combined multi-archive expansion also has an 8 GiB limit. Mixing ZIPs with
separately selected files is an explicit `ARCHIVE_INVALID` error.

The library stores only the normalized extracted `Blob`s and descriptors; it
does not retain a redundant copy of the ZIP. Directory selection and explicit
multi-file selection remain supported for already-extracted content.

### 5.3 BIOS validation

BIOS validation is separate from disc auditing. It checks the `Blob` size
against `build.firmware.byteLengths`, computes SHA-256, verifies the caller's
hash when present and copies the bytes to the region-specific generated name
in `build.firmware.systemFilenames`. A hash table may label recognized retail
revisions and warn about a declared-region mismatch, but v1 does not reject an
otherwise supported retail image merely because its hash is absent from that
table.

`ZipFirmwareSource` accepts a small user-supplied ZIP and extracts only an
image whose byte length is supported by the active build. A single candidate
is accepted directly. If several candidates exist, exactly one filename must
identify the selected NTSC-U, NTSC-J or PAL region; ambiguous archives fail
with `BIOS_INVALID`. Compressed, entry and total expanded-size limits are much
smaller than disc ZIP limits so a firmware archive cannot act as a ZIP bomb.

The v1 build disables silent HLE fallback. The shim must report whether the
core opened the supplied BIOS; if upstream has no stable frontend signal, the
production patch set adds a narrow firmware-status export. Startup rejects
with `BIOS_INVALID` if the core falls back to HLE. This prevents a typo or
unsupported revision from looking like a successful but less-compatible boot.

## 6. `LibretroPsxAdapter`

```ts
interface LibretroPsxAdapterConfig {
    readonly buildUrl: string;
    readonly build: PsxBuildInfo;
    readonly createWorker: WorkerFactory;
    readonly scheduler?: FrameScheduler;
    readonly clock?: () => number;
}

class LibretroPsxAdapter implements PsxAdapter {
    readonly type: "libretro-psx";
    constructor(config: LibretroPsxAdapterConfig);
    static init(config: {
        buildUrl: string;
        fetch?: FetchLike;
        createWorker?: WorkerFactory;
        scheduler?: FrameScheduler;
        clock?: () => number;
    }): Promise<LibretroPsxAdapter>;
    start(config: PsxStartConfig): Promise<PsxSession>;
}
```

The constructor validates injected values and reads no globals. `init` supplies
browser defaults, fetches `build.json`, resolves same-origin artifact URLs and
constructs the adapter. Cross-origin artifacts require normal CORS; no hidden
fallback to a public CDN exists.

`start`:

1. validates and audits the disc set, initial disc index and BIOS before starting a Worker;
2. verifies requested content/controller/options against `build.json` and the
   public allowlist;
3. copies incoming card arrays, validates the exact raw-card size and fills a
   missing slot with a deterministic formatted blank card;
4. creates a fresh Worker and clones the audited `Blob`s plus the
   generated mount plan;
5. selects the requested initial M3U image through libretro's disk-control
   interface before core load, then waits for AV info and the
   first valid frame; and
6. resolves a session or terminates the Worker and rejects with one typed
   error. Partial startup never leaves listeners, scheduler handles or Workers.

Session behavior:

- button holds are idempotent at the input layer; the session accepts repeats;
- axis values are clamped and converted without allocating per poll;
- geometry updates change `machine.geometry` and precede the first frame that
  uses the new dimensions;
- soft reset calls `retro_reset`; hard reset flushes cards, destroys the Worker
  and repeats startup with the same immutable normalized inputs;
- state and disc operations are one-at-a-time at frame boundaries;
- card reads occur at a frame boundary after the core's save RAM is flushed;
- exit reads final cards, unloads/deinitializes the core, acknowledges terminal
  cleanup and terminates the Worker; a timeout force-terminates and reports
  `WORKER_FAILED`; and
- every method throws `DESTROYED` after exit.

The adapter exposes the final card images to `PsxPlayer` during orderly exit.
`beforeunload` is not trusted for asynchronous persistence; the player performs
periodic dirty checks and writes cards during play.

## 7. Input and sources

### 7.1 `PsxInput`

`PsxInput` follows `ArcadeInput`'s multi-channel model:

- every keyboard, gamepad or touch source owns a channel;
- the first channel press sends a button down and the final release sends it
  up;
- destroying a channel releases all of its buttons and centers its axes;
- axes use last-writer-wins per channel with ownership returning to the most
  recently updated surviving channel;
- d-pad opposite directions use last-input-wins;
- blur, visibility loss, pause, reset, controller disconnect and destroy call
  `releaseAll`; and
- snapshots are immutable and canonically ordered.

There is no coin/start tap timer. PS1 buttons remain held for exactly as long
as the effective input source holds them.

### 7.2 `KeyboardSource`

The default port-1 map is arrows for d-pad, `Z/X/A/S` for
cross/circle/square/triangle, `Q/W` for L1/R1, `1/2` for L2/R2, Enter for
Start and Right Shift for Select. All bindings use `KeyboardEvent.code`, are
configurable and prevent default only while attached and mapped.

Keyboard analog emulation is opt-in. It ramps each configured axis at a
frame-based rate, recenters on release and remains deterministic under fake
`onTick` events.

### 7.3 `GamepadSource`

One browser gamepad maps to one controller port. Standard mapping uses the
usual face, shoulder, d-pad, start/select, stick and stick-click indices.
Config includes dead zone, trigger threshold, axis inversion and an explicit
browser-index-to-port assignment. Optional per-device button maps are keyed by
the browser gamepad ID; each digital PlayStation button can override its
standard index or use `null` to remain unbound. Analog axes retain the standard
four-axis layout.

Polling uses an injected provider and frame scheduler. Disconnect releases the
channel. `PsxRumbleEvent` calls `GamepadHapticActuator.playEffect` only when
available and enabled; absence or rejection is non-fatal. Rumble is stopped on
pause, disconnect and destroy.

## 8. Display, audio, player and console

### 8.1 `PsxDisplay`

`PsxDisplay` attaches to a session and draws RGBA frames to a Canvas 2D
context. It supports `fit`, `integer`, `fill` and `stretch`; `fit` is default.
The default aspect is the core-reported display aspect, not `width / height`,
because PS1 pixel aspect and horizontal resolutions vary.

The canvas backing size changes when frame geometry changes. CSS layout uses
the latest reported aspect without destroying the canvas or fullscreen state.
The class supports pixelated/smooth filtering, resize observation, fullscreen,
a starting placeholder and an injectable canvas/context boundary for tests.

### 8.2 `PsxAudio`

`PsxAudio` follows the corrected `ArcadeAudio` queue design:

- one lazily created `AudioContext`, unlocked by a user gesture;
- de-interleaved stereo buffers tagged with the session's reported rate;
- separate mute and normalized volume gains;
- queue duration derived from sample counts, not callback cadence;
- a 120 ms hard cap trimming to 60 ms; and
- queue reset on pause, reset, state load, disc change and large timing gaps.

The browser may choose a different device rate; Web Audio performs conversion.
The core is never configured to the browser rate after boot unless the selected
core explicitly supports a tested runtime AV update.

### 8.3 `PsxPlayer`

`PsxPlayer` owns one adapter session, input, display, audio and optional
storage. Its states are `idle`, `starting`, `running`, `paused`, `stopping`,
`failed` and `destroyed`.

`start` resolves only after the first valid frame is drawn. Startup failure
unwinds in reverse order and returns to reusable `idle`. `stop` periodically
flushes cards, performs a final flush, exits the session and returns to idle.
`destroy` is terminal. Concurrent lifecycle calls reject predictably rather
than racing.

The player exposes its composed display so a browser shell can select
presentation scaling and enter or leave fullscreen without taking ownership
of display attachment or teardown.

The player provides `setPlaybackRate`, `setDisc`, `saveState(name)`, `loadState(name)`,
`deleteState(name)`, `downloadMemoryCard(slot)` and
`replaceMemoryCard(slot, bytes)`. Replacing a card requires a stopped player;
ordinary writes come from the running session. Card downloads read current
core bytes while a session is active and the latest persisted revision while
the player is stopped.

`setPlaybackRate` accepts only `1`, `2`, `5` or `7`, resets queued
audio when the value changes and exposes the active value through
`playbackRate`. `1` is normal speed. Higher values are best-effort because the
actual multiplier depends on the core workload and host hardware.

Card auto-save runs after a configurable dirty-check interval (default 5 s)
and on pause, reset, state save and stop. Overlapping saves collapse into one
pending follow-up. A failed auto-save emits an error event and keeps the last
known good record.

### 8.4 `PsxConsole`

`PsxConsole` is the convenience composition root analogous to
`ArcadeCabinet`. It creates the player, input sources, storage and optional
game store while accepting page-owned canvas/container/gesture elements.

It does not create a page, modal, file picker or game list. It exposes methods
to normalize a `FileList`, audit/import it, start a stored game, bind a browser
gamepad to a port, replace the live keyboard map, replace a device-specific
gamepad button map and dispose the complete graph. Live mapping changes rebuild
only the browser input sources; they do not restart the emulated session.
Starting a stored game while another session is active first resolves the
requested content, then stops and flushes the current session before starting
its replacement.

## 9. Persistence and local game storage

### 9.1 Memory cards

Memory cards are raw 131,072-byte images stored independently by
`{profileId, cardId}`. A profile selects which two `cardId`s are inserted for
a session. Cards are not locked to one game or core build, matching physical
cards and allowing a page to share them deliberately.

Writes use IndexedDB transactions and optimistic revisions. Two live tabs
attempting to write the same card cannot silently overwrite each other: a
revision mismatch raises `STORAGE_FAILED` with conflict data. The UI may reload
or save as a new card.

Save-state loading can modify emulated card contents. After successful
`unserializeState`, the player immediately reads and persists both cards before
resuming. Documentation warns that an old state can roll back card data; the
storage layer retains the previous revision so the page can offer recovery.

### 9.2 Save-state envelope

Named states are stored by `{profileId, gameId, name}` in a versioned envelope:

```json
{
  "format": "psx-runtime-state",
  "version": 1,
  "adapter": "libretro-psx",
  "buildId": "<build fingerprint>",
  "core": "<core id>",
  "coreVersion": "<reported version>",
  "gameId": "<stable game id>",
  "discIndex": 0,
  "createdAt": "<ISO timestamp>"
}
```

The binary payload is stored beside the metadata, not base64-encoded. Loading
requires exact format, adapter, build and game identity. The player selects the
recorded disc before unserializing. Migrations must be explicit; changing a
core pin never attempts optimistic state compatibility.

Names are trimmed Unicode strings of 1–80 code points. Storage rejects control
characters and normalizes to NFC for equality.

### 9.3 Firmware storage

`PsxStorage` can save, load, list and delete user-supplied firmware. Records
are keyed by `ntsc-u`, `ntsc-j` or `pal`, so storing one region replaces only
that region. Each record is a versioned `psx-runtime-firmware` envelope with
the original `Blob` and an ISO storage timestamp. Reads return a fresh `Blob`
view, malformed records fail with `STORAGE_FAILED`, and firmware storage is
never automatic at the library boundary.

The default IndexedDB schema stores firmware beside cards and states in a
separate object store. Upgrading an existing version-1 database adds that
store without rewriting or deleting existing saves.

The harness resolves a raw image or regional firmware ZIP before calling
`saveFirmware`, so a ZIP container or wrong-sized image is never persisted as
firmware. Existing malformed records remain removable and produce an
actionable replacement message rather than being silently deleted.

### 9.4 `PsxGameStore`

The optional library stores a normalized manifest and the original track
`Blob`s in IndexedDB without converting them to byte arrays. Import audits
first, computes SHA-256 incrementally in a Worker, derives a versioned
`gameId`, checks quota, then commits metadata and blobs in one logical
transaction. Failed or cancelled import removes staged records.

The fingerprint includes normalized descriptor bytes plus each referenced
file's length and full hash in disc/track order. It excludes display filename,
timestamps and local paths. Identical content imported with different names
deduplicates.

APIs include list, get, import, rename-display-title and delete. Deleting game
content never deletes cards or states without a separate explicit call. Quota
errors include estimated required/available bytes when the browser reports
them.

## 10. Developer harness

The harness is a consumer of the package, not a second runtime. It provides:

- a ZIP game picker plus accumulating drag/drop for the release-test workflow;
  one ZIP follows its embedded CUE/M3U, while multiple single-disc ZIPs expose
  ordered move/remove controls and a preview explicitly identifying the M3U
  that Check And Store will generate and persist; the initial Library title is
  derived from the first ZIP filename, while a single archive with ambiguous
  descriptors reveals a contextual CUE/M3U chooser instead of a permanent
  entry-override field;
- an audit panel showing every missing/invalid reference;
- separate browser-local **Check And Store** actions for firmware and games,
  with independent removal and explicit confirmation before a stored game is
  deleted; the Game surface cannot be dismissed or edited while its check and
  atomic browser-storage import is in progress;
- a **System** surface before **Game**; Game and Library remain disabled until
  stored firmware for the selected region matches the active core's supported
  byte lengths;
- canvas, audio state and per-player binding tables that capture the next
  keyboard key or gamepad button for each digital control;
- an optional per-port left-stick-to-D-pad compatibility mapping for games
  that predate native analog-controller support;
- a validated browser-wide control profile in `localStorage`; keyboard maps
  device-ID-keyed gamepad button maps, player preferences and left-stick
  compatibility choices survive reload, while transient browser gamepad
  indices are resolved again whenever devices connect, and the user can
  restore defaults;
- controller type selection before start;
- top-level pause/resume, soft reset and mute/unmute controls, with remaining
  session operations grouped in the Session surface; pausing retains the last
  game frame beneath a translucent full-canvas overlay until the session
  resumes;
- modal-owned pause semantics: opening the first modal pauses a running game,
  nested modals retain that pause, and closing the last modal resumes only when
  the UI initiated the pause;
- a View surface with aspect-preserving and stretched fullscreen choices;
  Escape or a same-player L3 + R3 chord exits fullscreen;
- same-player runtime shortcuts: hold L3 + R1 for the selected fast-forward
  rate, press L3 + R2 to cycle `×2`, `×5` and `×7`, hold L3 + L1 for direct
  `×2`, or hold L3 + L2 for direct `×7`; releasing the hold returns to
  `×1`, and an on-canvas indicator shows the active accelerated rate;
- per-game controller quick-state assignments: the States surface provides Q1
  and Q2 radio controls for compatible named states, R3 + L1/L2 overwrites the
  assigned state, and R3 + R1/R2 loads it, with edge triggering and visible
  success or failure notices; an unassigned save creates **Quick State 1** or
  **Quick State 2** and assigns it automatically; assigning the state held by
  one quick slot to the other swaps their assignments so one state cannot own
  both slots; assignments persist in browser storage per game across reloads;
- Library starts expose the selected game's starting disc and replace an active
  session after its persistent state has been flushed; the initiating dialog
  closes before replacement so its modal pause cannot cover the new session;
- a checked Game start that likewise replaces an active session when the
  checked content differs from the running game; for an active multi-disc
  game, **Change disc** performs a state-preserving virtual tray cycle for an
  in-game insert-disc prompt, while **Restart from disc** directly boots the
  selected disc as a new session;
- automatic Library refresh whenever its surface opens, with each game's
  content payload size and an aggregate stored-game total; mutable display
  titles remain a Library-only concern, and a selected multi-disc game exposes
  a download of the normalized M3U actually stored with it;
- hard reset and disc selection;
- two card selectors, import/export and auto-save status; selecting a
  replacement identifies its filename and size, while a completed replacement
  reports the affected slot both inside the modal and through a transient
  notice;
- a per-game save-state manager that lists every named state with its capture
  time, disc and active-build compatibility, and provides explicit create,
  load, confirmed overwrite and confirmed delete actions; successful save,
  load, overwrite and deletion operations produce visible transient notices;
- sanitized core logs and timing/audio/video counters; and
- optional private BIOS/content preload config for local browser tests.

The preload config is git-ignored, contains local paths only, and is read by
`serve-harness.ts`; it never enters browser bundles or package output. The
server sets `.wasm` MIME correctly and may send cache headers, but v1 must run
without cross-origin-isolation headers.

## 11. Milestones and dependency order

| Milestone | Deliverable | Acceptance |
| --- | --- | --- |
| M0 | core/toolchain/license/WORKERFS feasibility and candidate decision | committed probe record answers P1–P12; one homebrew CUE boots in Chromium with video, audio and input |
| M1 | scaffold, public types, predicates, errors, deterministic build metadata | `check` and spec suite pass; two clean fixture/core builds are reproducible |
| M2 | libretro shim and Worker protocol | synthetic core double proves lifecycle, AV updates, buffer pooling, pacing and terminal cleanup |
| M3 | `DiscSetAudit` and mount-plan generation | multi-track CUE and multi-disc M3U mount without copying a track into Wasm memory |
| M4 | `LibretroPsxAdapter` and session | real core starts/stops repeatedly; reset, two pads, state, cards and disc change work |
| M5 | `PsxInput`, keyboard and gamepad | two players operate independently; blur/disconnect releases all; analog/dead-zone tests pass |
| M6 | display and audio | dynamic geometry is correct; 60-second audio queue stays bounded and synchronized |
| M7 | `PsxStorage`, state envelope and auto-save | cards survive reload; incompatible states reject; simulated write conflict preserves both revisions |
| M8 | player, console, harness and preload | local files and stored games run through the same public composition path |
| M9 | `PsxGameStore`, packaging, licenses and release gates | large Blob import/dedup/quota behavior passes; package contains no game, BIOS or core cache |
| M10 | v1 release | ZIP/M3U diagnostics and every gate in section 13 pass from a clean checkout |
| M11 | mobile and touch controls | plain TypeScript/HTML touch controller passes multi-touch, cancellation, orientation and source-isolation probes; a physical phone sustains play for 60 seconds |
| M12+ | optional CHD, additional controllers, alternate core, enhanced graphics | each is independently probed and does not widen the established contracts accidentally |

M0 is a hard gate. M1 types may be drafted in parallel, but no production
adapter or core-specific option table is finalized until M0 records the core's
actual behavior.

Recommended implementation slices after M0:

1. contracts/errors/build identity;
2. shim with a native fake core and deterministic worker double;
3. Worker protocol, pacing and transferable-buffer pool;
4. disc audit and WORKERFS mount plan;
5. real adapter/session;
6. input/display/audio;
7. cards/states/storage;
8. player/console/harness;
9. game store, packaging and release evidence.

### 11.1 M11 mobile and touch acceptance

M11 extends the developer harness without introducing a UI framework. Semantic
HTML and responsive CSS provide the visible controller; one plain TypeScript
`TouchController` owns an isolated `PsxInput` channel for the active session.
Keyboard and gamepad sources remain attached concurrently, and releasing touch
input cannot release a control still held by another source.

The touch surface provides D-pad directions, Triangle, Circle, Cross, Square,
L1, L2, R1, R2, Start, Select, explicit L3 and R3 buttons, and two analog
sticks when the selected port emulates a DualShock. One active-port selector
routes the complete surface to port 1 or port 2. Changing ports, pausing,
opening a modal, hiding the controller, losing focus, changing sessions or
destroying the surface releases every touch-owned button and centers both
sticks.

The interaction requirements are:

1. simultaneous pointers can hold a direction and two buttons independently;
2. one captured D-pad pointer may roll through cardinal and diagonal regions
   without lifting, and leaving its bounds releases all directions;
3. each analog stick clamps displacement to the unit circle, reports both axes
   continuously and returns both axes to zero on release;
4. pointer up, pointer cancel, lost capture and page visibility loss cannot
   leave a button or axis active;
5. `auto`, `show` and `hide` visibility plus active port and swapped-side
   preferences persist locally; `auto` shows on a touch-capable device without
   a connected standard gamepad;
6. portrait places controls below the unobscured canvas and resizes the display
   so both remain inside the viewport without document scrolling; compact
   landscape splits translucent controls across its sides, honors safe-area
   insets and supports swapping sides;
7. fullscreen contains both the canvas and enabled touch controls while the
   display continues measuring only its screen container; and
8. every target is at least 44 CSS pixels, suppresses browser panning, zooming,
   selection and callouts, and has an accessible name.

The automated M11 probe uses Chromium mobile/touch emulation and raw concurrent
pointer sequences to prove rolling diagonals, button concurrency, analog
clamping, port switching, cancellation, preference restoration and responsive
layout selection. Final acceptance additionally requires 60 seconds of audible,
responsive play on a physical phone in portrait and landscape with no stuck
input after rotation, modal use or backgrounding.

### 11.2 M12 production web interface

M12 adds a framework-free production interface under `ui/`; the developer
harness remains a separate diagnostic surface. The interface consumes only
public runtime and storage operations already proven by earlier milestones.
Design-only controls without a matching capability are omitted rather than
simulated.

The first production slice must:

1. derive firmware-required, ready, starting, running, paused, stopping and
   failed presentation from browser storage and `PsxPlayer` status;
2. gate Game and Library until at least one valid regional firmware record is
   stored, with NTSC-U selected by default;
3. append dropped or selected ZIPs in disc order, identify generated M3U
   behavior for multi-ZIP input, and use `PsxConsole.importFiles()` for the
   actual check/store path;
4. list content-addressed games with title, disc count, file count and stored
   bytes, and support start, active-game disc insertion, restart, rename and
   confirmed removal;
5. expose supported pause/resume, reset, mute, stop, scaling, fullscreen and
   memory-card download operations;
6. pause a running session while a modal is open and prevent dismissal of a
   dialog while its storage mutation is active; and
7. fit the central stage inside desktop and mobile viewports without document
   scrolling or copying private design assets into tracked source.

`probe:ui` builds the production interface and selected core metadata, then
checks the empty-storage firmware gate, System modal, default region,
unsupported-setting absence, responsive viewport fit and command target sizes.
Later M12 slices migrate the already-supported controller mapping, named-state
management and touch surface from the harness before physical-device and
real-session visual acceptance closes the milestone.

## 12. M0 probe plan

| ID | Question | Required evidence |
| --- | --- | --- |
| P1 | What exact source commits, recursive submodules and licenses are involved? | immutable identities, license copies and binary-distribution obligations |
| P2 | Can each candidate compile with the pinned emsdk without dynarec, assembly, pthreads, Asyncify or hardware rendering? | clean build command, patches and output sizes |
| P3 | Can the shim boot the redistributable CUE/BIN fixture with a real user-supplied BIOS? | first-frame hash, sanitized boot log and startup time |
| P4 | Does `WORKERFS` provide correct synchronous seek/read on large `Blob`s from the dedicated Worker? | random-read correctness, no full-file allocation and throughput trace |
| P5 | Which libretro environment commands does the candidate actually request? | ordered trace; every required command implemented or explicitly rejected |
| P6 | Are pixel formats, pitch, null frames and runtime geometry updates correct? | hashes for every negotiated format and a resolution-switching fixture |
| P7 | What rates and timing changes are reported for NTSC and PAL? | AV info, 60-second tick counts and backlog/drop statistics at 60/120 Hz host cadence |
| P8 | Are CD audio and XA audio correct and bounded through the worker transport? | tone/frequency evidence, callback cadence and queue-depth trace |
| P9 | How are both memory-card slots exposed and when may bytes be restored/read? | exact call ordering, sizes, dirty behavior and reload proof |
| P10 | Are serialize/unserialize and disk-control callbacks stable at frame boundaries? | state round trip, open/change/close trace and multi-disc fixture proof |
| P11 | What are steady/peak Wasm and browser memory, including a near-maximum disc? | measured initial/maximum pages and browser memory trace |
| P12 | Does the candidate sustain full speed and deterministic output on reference desktop Chromium? | 60-second NTSC/PAL runs, frame/audio counters, underruns and repeatable hashes |

The homebrew fixture should deliberately exercise: several video resolutions,
PAL and NTSC builds, controller buttons and axes, deterministic animation,
stereo tones, data reads from the beginning/middle/end of a track, a CD-audio
track, memory-card writes, reset and a two-disc prompt. Separate images may be
used when one fixture cannot express all cases cleanly.

## 13. Tests and release gates

### 13.1 Suites

**`spec` (Node):** every type predicate; error construction; CUE/M3U parser,
hostile ZIPs and paths; mount-plan rewriting; build metadata and fingerprinting;
worker protocol reducer; frame accumulator at 50/59.94/60 Hz; pixel conversion
and pitch; buffer pool; input channels/SOCD/analog ownership; display layout;
audio queue arithmetic; card validation/revision conflicts; state envelope;
game fingerprinting; lifecycle cleanup against fakes.

**`browser`:** Worker/module load failures; real `Blob`/`WORKERFS` random
reads; first frame/audio/input with the real core and homebrew fixture; dynamic
geometry; NTSC/PAL pacing; multi-track CD audio; two controllers; rumble when
available; two memory cards; state round trip; multi-disc change; Canvas/Web
Audio; IndexedDB card/state/game storage; repeated start/stop and forced Worker
crash cleanup.

The homebrew disc is public test data, but the required retail BIOS remains an
ignored private input. Real-core browser tests skip with an explicit reason
when it is absent; the controlled release machine must supply it and run every
gate. Test output may record a recognized BIOS revision label but not a local
path or BIOS bytes.

**`build/package`:** pin verification; patches apply without fuzz;
deterministic core and fixture build; import/export allowlist; no pthread,
Asyncify or hardware renderer; valid notices/source offer; valid `build.json`;
`npm pack` excludes core output, emulator cache, private preload, BIOS, disc and
generated fixture images.

### 13.2 `v1.0.0` release gates

From a clean checkout and documented toolchains:

1. build the homebrew fixture and pinned core twice with identical hashes;
2. load the same game from a `FileList` and `PsxGameStore`, producing the same
   `gameId`, machine info and deterministic frame checkpoints;
3. reject traversal, a missing BIN, a duplicate case-folded file and a malformed
   M3U before creating a Worker;
4. prove no track-sized allocation/copy occurs while mounting or starting a
   near-maximum-size synthetic disc;
5. sustain the core-reported NTSC and PAL speed for 60 seconds on reference
   desktop Chromium, with no growing audio queue and recorded drop/underrun
   limits;
6. switch between at least two video geometries without incorrect aspect,
   stale pixels or canvas destruction;
7. operate ports 1 and 2 concurrently from physical gamepads and keyboard;
8. hear synchronized generated PCM, XA and CD audio after one user gesture;
9. write both cards, reload the page and recover the exact bytes; then load an
   older state and retain a recoverable prior card revision;
10. change to disc 2 through the public player API and continue without
    restarting the core;
11. save/load a named state, and reject the same envelope after altering
    `buildId` or `gameId`;
12. fail each startup phase in turn and finish with no Worker, animation handle,
    event listener, audio node or partial IndexedDB write; and
13. inspect the npm tarball and hosted core folder for required notices and the
    absence of game/BIOS/private files.

Performance thresholds beyond emulated full speed are recorded by M0 for the
actual selected core and reference hardware; this spec does not fabricate a
millisecond budget before the probe exists.

## 14. Out of scope and extension rules

The following are intentionally outside v1:

- shipping, finding, downloading or decrypting games or firmware;
- a hosted game deployment format, manifest-driven shell or public ROM CDN;
- RetroArch UI/config/database behavior;
- installable PWA or service-worker caching;
- non-ZIP archive extraction and patch formats;
- CHD/PBP and non-CUE descriptor families;
- multitap (players 3–8), light gun, mouse, NegCon and specialty controllers;
- enhanced internal resolution, texture replacement, shaders and WebGL;
- rewind, run-ahead, cheats, achievements and netplay;
- BIOS boot/menu without content; and
- guaranteed save-state compatibility across core builds.

Extensions obey three rules:

1. prove the feature with a focused probe before changing public contracts;
2. add an explicit capability to `build.json` and reject unsupported requests
   before creating a Worker; and
3. preserve the adapter boundary so input, display, audio, player and storage do
   not learn which PSX core is active.

## 15. Upstream references (informative)

- [Libretro PCSX-ReARMed documentation](https://docs.libretro.com/library/pcsx_rearmed/)
  describes BIOS fallback, supported content, timing, memory cards and disk
  control for the primary candidate.
- [The libretro API header](https://github.com/libretro/libretro-common/blob/master/include/libretro.h)
  is the authority for callbacks, environment commands, controllers, disk
  control and serialization.
- [Emscripten's filesystem API](https://emscripten.org/docs/api_reference/Filesystem-API.html)
  documents `WORKERFS` mounting of `File`/`Blob` objects and synchronous
  filesystem semantics.
- [PCSX-ReARMed upstream](https://github.com/notaz/pcsx_rearmed) and
  [Beetle PSX libretro upstream](https://github.com/libretro/beetle-psx-libretro)
  are candidate sources only until M0 records immutable commits.

These links explain the starting assumptions. The pinned files and committed
probe evidence, not a moving upstream page, are authoritative for a release.
