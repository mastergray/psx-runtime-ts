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
- [x] M4: implement the libretro adapter and public session lifecycle.
- [x] M5: implement multi-channel input plus keyboard and gamepad sources.
- [x] M6: implement dynamic Canvas display and bounded Web Audio playback.
- [x] M7: implement revisioned cards, compatible states and card auto-save.
- [x] M8: compose the player, console and developer harness.
- [ ] M9: implement local game storage, packaging and distribution gates.
- [ ] M10: pass all `v1.0.0` release gates.

## Next work: M9

M0–M8 are complete. `PsxPlayer` owns the reusable session lifecycle and
coordinates display, audio, input, cards, states, disc changes and cleanup.
`PsxConsole` provides one browser composition path for selected and stored
content, while the developer harness exposes the complete lifecycle for real
browser testing. M9 adds audited, deduplicated Blob storage, quota-aware
imports, package auditing and distribution documentation.
