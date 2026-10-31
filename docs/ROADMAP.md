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
- [ ] M7–M9: persistence, composition and packaging.
- [ ] M10: pass all `v1.0.0` release gates.

## Next work: M7

M0–M6 are complete. `PsxDisplay` tracks dynamic native geometry while laying
out the core-reported aspect through four scaling modes. `PsxAudio` lazily
unlocks Web Audio, preserves the core sample rate and trims overloads from 120
ms to 60 ms. Deterministic tests cover 60 seconds of queue progress and a real
Chromium probe covers Canvas 2D plus gesture-unlocked Web Audio. M7 implements
card/state envelopes, revision-safe persistence and auto-save.
