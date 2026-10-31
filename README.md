# psx-runtime-ts

A TypeScript runtime for playing user-supplied PlayStation games in
the browser. It follows the lifecycle and package boundaries established by
[`arcade-runtime-ts`](https://github.com/mastergray/arcade-runtime-ts), with a
PlayStation-specific libretro bridge, Worker-hosted WebAssembly core, disc
handling, controller ports, memory cards and save states.

M0 feasibility, the M1 public-contract foundation, the M2 bridge/Worker
foundation, the M3 content pipeline and the M4 adapter/session are complete.
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
input, reset, disc, state and terminal-cleanup lifecycle.

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
```

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
