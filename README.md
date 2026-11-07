# psx-runtime-ts

A TypeScript runtime for playing user-supplied PlayStation games in
the browser. It follows the lifecycle and package boundaries established by
[`arcade-runtime-ts`](https://github.com/mastergray/arcade-runtime-ts), with a
PlayStation-specific libretro bridge, Worker-hosted WebAssembly core, disc
handling, controller ports, memory cards and save states.
The developer harness also provides bounded best-effort fast-forward, two
controller-accessible quick-state slots and a framework-free on-screen
controller for phones and tablets.

M0 feasibility, the M1 public-contract foundation, the M2 bridge/Worker
foundation, the M3 content pipeline and the M4 adapter/session are complete.
The M5 input layer, M6 browser surfaces, M7 persistence, M8 composition and M9
local library are also complete.
Together they add independent input channels, keyboard/gamepad sources,
dynamic Canvas 2D layout, bounded gesture-unlocked Web Audio playback,
revisioned memory cards and build-compatible named states.
PCSX-ReARMed at the commit recorded in
`core/SOURCE.json` is the selected core, and Emscripten 6.0.2 is the pinned
toolchain. The P1–P12 evidence covers real-BIOS boot, dedicated-Worker disc
access, video geometry and formats, NTSC/PAL timing, XA/CD audio, both memory
cards, state and disc changes, near-maximum-disc memory and repeated 60-second
endurance runs at 60 and 120 Hz host cadence.

The root package exports validated content, firmware, controller, session and
build-metadata contracts together with `PsxRuntimeError`. The normalized core
recipe in `core/build.json` feeds a deterministic SHA-256 build identity with
no local path or timestamp input.

M2 adds the narrow native libretro frontend, validated private Worker
messages, PAL/NTSC pacing, pixel/audio conversion and a three-buffer
transferable video pool. Both the TypeScript worker double and a compiled
synthetic libretro core cover lifecycle and terminal cleanup.

M3 adds ordered CUE/M3U auditing, same-basename SBI association and a
generated content mount plan. Large track blobs remain in WORKERFS while only
small normalized descriptors and sidecars are written to MEMFS.

M4 adds the public libretro adapter and restartable session, validated Worker
client, production Emscripten bridge, firmware/card installation and complete
input, reset, disc, state and terminal-cleanup lifecycle. The accepted mobile
disc-I/O path reuses sequential raw-track stdio input when the requested byte
position already matches the stream, avoiding redundant WORKERFS read-ahead
without changing random, backward, mixed-subchannel or compressed-image reads.

M5 adds the multi-source input coordinator plus keyboard and standard-gamepad
sources. It reference-counts shared controls, resolves opposing directions,
restores analog ownership and releases held controls on focus or device loss.

M6 adds aspect-correct `fit`, `integer`, `fill` and `stretch` display modes,
dynamic canvas backing geometry, fullscreen and filtering controls, plus lazy
stereo Web Audio playback with independent mute/volume and a bounded queue.
Its browser-wide Adaptive, Low Latency and Stable Playback modes let mobile
devices trade a small scheduling cushion for smoother cut-scene audio.
Secure contexts use a persistent AudioWorklet stereo ring; unsupported origins
and browsers retain bounded AudioBufferSource scheduling as a fallback.

M7 adds IndexedDB-backed memory cards with optimistic revisions and a
recoverable prior version, normalized named-state envelopes with exact
build/game compatibility, browser-local firmware storage keyed by region, and
coalescing periodic card auto-save support.

M8 adds the reusable player lifecycle, the browser-facing console composition
and a developer harness. Local selections and stored content share the same
adapter path, input sources follow session status, and shutdown flushes cards
before releasing the core.

M9 adds content-addressed IndexedDB storage with normalized descriptors,
original track Blobs, incremental Worker hashing, filename-independent
deduplication and quota-aware atomic imports. Its package gate allowlists the
npm tarball and verifies the selected core/toolchain notices.

M10 completes the automated release gate. M11 adds an isolated touch-input
channel with a rolling multi-touch D-pad, face and shoulder buttons,
Start/Select, DualShock sticks and explicit L3/R3 controls. Portrait keeps the
controller below a display that resizes to keep both inside the viewport,
compact landscape overlays translucent left and right control groups, and
fullscreen contains both the display and controls. Start and Select remain
centered in the compact main row between the D-pad, stick groups and face
buttons.

The browser-facing console accepts one user-supplied ZIP containing a single
CUE/BIN disc or an M3U with all referenced discs. It also accepts two to eight
ordered single-disc ZIPs, namespaces their content, and generates the M3U that
defines public disc order. Archives are expanded locally with bounded path and
size validation, then sent through the same audit, storage and Worker mount
path as raw or directory selections. ZIP bytes and firmware are never uploaded
by the runtime.
Games and firmware are persisted only through explicit browser-local actions
and can be removed independently.

The framework-free production interface lives under `ui/`, separately from
the diagnostic harness. Its first production slice implements the supported
System, Game, Library, Memory Cards and View workflows against the real
runtime and browser stores. The central stage reflects firmware-required,
ready, starting, running, paused, stopping and failed states; no mock-only
formats or settings are exposed.
The top-level Audio modal controls output gain and persists Adaptive, Low
Latency or Stable Playback buffering. An inline help tip explains the delay and
stability tradeoff for each choice without keeping diagnostic text on screen.
System contains only Firmware and Controls. Production sessions always use
sequential-read reuse without measurement overhead. Explicit development
compositions retain instrumented variants and downloadable diagnostics outside
the production interface.

Presentation Mode provides a controller-first, television-scale view of the
same running session. The D-pad or left stick moves focus, Cross activates,
Circle goes back, and L3+R3 opens or closes the presentation menu. That menu
shows **Select Game** instead of **Resume** while idle; activating it or moving
right focuses the first stored title. The menu keeps the stored Library
visible, highlights the active title, reports its
aggregate browser storage and launches single-disc games directly. Multi-disc
titles open a controller-focused disc picker, and startup remains covered by a
status overlay until it completes. Reset, in-session disc switching and
scaling remain available without duplicating the full Play Mode controls. The
menu can also be opened with Escape or a two-finger tap, and returning to Play
Mode keeps a menu-paused game paused.

The harness exposes separate **Check And Store** actions for firmware and game
content, so either can be validated or replaced without rewriting the other.
Firmware setup lives under **System**. **Game** and **Library** remain disabled
until the selected region has firmware stored and validated for the active
core build. When multiple single-disc ZIPs are selected, Game previews and
clearly identifies the M3U that Check And Store will add. After import, Library
can download the normalized M3U actually stored with a multi-disc game. During
an active multi-disc session, **Change disc** preserves the running game for
its insert-disc prompt, while **Restart from disc** directly boots the selected
disc as a new session.

Runtime controller shortcuts use L3 with the shoulder buttons for fast-forward:
R1 holds the selected speed, R2 cycles `×2`, `×5` and `×7`, L1 holds direct
`×2`, and L2 holds direct `×7`. R3 with L1/L2 saves Quick State 1/2;
R3 with R1/R2 loads Quick State 1/2. The States surface assigns any compatible
named state to Q1 or Q2 per game; controller save overwrites that assignment
and controller load restores it. Assigning one slot's state to the other slot
swaps the two assignments. Assignments are stored locally per game and survive
page reloads. Accelerated execution skips audio and returns to normal speed
when the hold chord is released. Fast-forward changes and quick-state results
use the same on-screen notice surface, placed in the lower-right corner during
Presentation Mode.

The **View** surface configures the on-screen controller. Automatic visibility
shows it on touch-capable devices when no standard gamepad is connected; Show
and Hide override detection. The selected player port and swapped left/right
layout persist in browser storage. Touch, keyboard and gamepad input remain
independent, so suspending or hiding the touch surface releases only the
controls it owns. The top-level **Show Controls** or **Hide Controls** button
applies and stores an explicit visibility override without opening View.

Firmware may be supplied as a raw image or as a small ZIP. When a ZIP contains
multiple supported images, the runtime requires exactly one filename that can
be identified with the selected NTSC-U, NTSC-J or PAL region.

See the [implementation spec](docs/psx-runtime-spec.md) for the architecture,
public contracts, probe plan, milestones and release gates. Current progress
is tracked in the [roadmap](docs/ROADMAP.md).

## Development

Requirements: Node.js 22.13 or newer and npm.

```sh
npm install
npm run check
npm test
npm run build
npm run build:web
npm run probe:m11
npm run probe:m13
```

Run the production web emulator at `http://127.0.0.1:4175` with:

```sh
npm run serve:ui
```

To test that interface from another device on the same local network, use
`PSX_UI_HOST=0.0.0.0 npm run serve:ui`. The production UI and harness servers
both default to loopback-only binding.

For physical-device harness testing on the same local network, explicitly bind
the development server to the network interface with
`PSX_HARNESS_HOST=0.0.0.0 npm run serve:harness`. The default remains
loopback-only.

The ordinary typecheck and spec suite require no game or firmware files. Real
core browser tests will use a redistributable homebrew disc and a private,
user-supplied retail BIOS. Tests that need the private BIOS must skip with an
explicit reason when it is absent.

## Repository policy

The repository, npm package, CI artifacts and documentation contain no Sony
firmware or commercial game data, do not link to either, and provide no
default download locations. Local BIOS, disc images, memory cards, save
states, emulator source caches and compiled core artifacts stay ignored.

The TypeScript runtime uses the [MIT licence](LICENSE). Emulator cores and
their generated artifacts retain their own licences and distribution
requirements. A core build is not part of the npm package unless a later
release explicitly documents and satisfies those requirements.
See [core distribution](docs/core-distribution.md) for the separate artifact
and corresponding-source policy.
