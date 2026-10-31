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
- [x] M1: implement public contracts, errors and deterministic build metadata.
- [x] M2: implement the libretro shim and deterministic Worker protocol.
- [x] M3: implement disc-set auditing and zero-copy WORKERFS mount plans.
- [ ] M4–M9: adapter, browser surfaces and storage.
- [ ] M10: pass all `v1.0.0` release gates.

## Next work: M4

M0–M3 are complete. `DiscSetAudit` now produces complete ordered issue lists
for bounded CUE/M3U inputs, associates SBI sidecars and rejects unsafe or
incomplete media graphs before Worker creation. The private mount planner
regenerates deterministic descriptors and passes large track blobs directly
to WORKERFS without reading or copying them. M4 implements
`LibretroPsxAdapter`, its Worker client and the public session lifecycle on top
of the M2 bridge and M3 content pipeline.
