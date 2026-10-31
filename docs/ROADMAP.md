# Roadmap

The authoritative architecture, milestone definitions and acceptance criteria
are in [the implementation spec](psx-runtime-spec.md).

## Current status

- [x] Draft the implementation contract.
- [x] Create the TypeScript package and test scaffold.
- [x] M0: compare and pin the emulator core and Emscripten toolchain.
  - [x] Pin and compile both candidates with Emscripten 6.0.2.
  - [x] Build a reproducible redistributable fixture.
  - [x] Prove large-Blob WORKERFS reads in a dedicated Worker.
  - [x] Boot both real cores with video, audio and input evidence.
  - [x] Close PAL/NTSC 60-second timing and determinism at 60/120 Hz host cadence.
  - [x] Close dynamic geometry, pixel-format/pitch and null-frame probes.
  - [x] Boot through a private user-supplied BIOS with sanitized evidence.
  - [x] Close XA/CD audio, card/state/disc and near-maximum-disc memory probes.
  - [x] Select PCSX-ReARMed and commit the production source/toolchain pins.
- [ ] M1: implement public contracts, errors and deterministic build metadata.
- [ ] M2–M9: bridge, Worker, content, adapter, browser surfaces and storage.
- [ ] M10: pass all `v1.0.0` release gates.

## Next work: M1

M0 is complete. PCSX-ReARMed and Emscripten 6.0.2 are pinned in `core/`, with
the full P1–P12 record in `docs/probes/`. M1 defines the public contracts,
stable error model and deterministic build identity consumed by every later
milestone.
