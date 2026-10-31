# psx-runtime-ts

A headless TypeScript runtime for playing user-supplied PlayStation games in
the browser. It follows the lifecycle and package boundaries established by
[`arcade-runtime-ts`](https://github.com/mastergray/arcade-runtime-ts), with a
PlayStation-specific libretro bridge, Worker-hosted WebAssembly core, disc
handling, controller ports, memory cards and save states.

The project is currently at the scaffold/M0 feasibility stage. The completed
baseline comparison provisionally favors PCSX-ReARMed with Emscripten 6.0.2,
but production source metadata remains intentionally uncommitted until the
remaining M0 media, persistence and lifecycle probes pass. Repeated 60-second
NTSC/PAL endurance runs already pass at both 60 and 120 Hz host cadence, and
the dynamic-geometry, pixel-format/pitch and null-frame probe is complete.

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
