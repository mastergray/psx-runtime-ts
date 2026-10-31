# Roadmap

The authoritative architecture, milestone definitions and acceptance criteria
are in [the implementation spec](psx-runtime-spec.md).

## Current status

- [x] Draft the implementation contract.
- [x] Create the TypeScript package and test scaffold.
- [ ] M0: compare and pin the emulator core and Emscripten toolchain.
  - [x] Pin and compile both candidates with Emscripten 6.0.2.
  - [x] Build a reproducible redistributable fixture.
  - [x] Prove large-Blob WORKERFS reads in a dedicated Worker.
  - [x] Boot both real cores with video, audio and input evidence.
  - [x] Close PAL/NTSC 60-second timing and determinism at 60/120 Hz host cadence.
  - [ ] Close geometry, XA/CD audio, card/state/disc and near-maximum-disc memory probes.
- [ ] M1: implement public contracts, errors and deterministic build metadata.
- [ ] M2–M9: bridge, Worker, content, adapter, browser surfaces and storage.
- [ ] M10: pass all `v1.0.0` release gates.

## Next work: M0

M0 is a hard feasibility gate. The baseline record is in
`docs/probes/core-selection.md`; PCSX-ReARMed is the provisional winner. Commit
`core/SOURCE.json` and `core/EMSDK_VERSION` only after every remaining P1–P12
acceptance item is measured.
