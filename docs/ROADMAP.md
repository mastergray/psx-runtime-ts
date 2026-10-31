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
- [ ] M5–M9: input, browser surfaces and storage.
- [ ] M10: pass all `v1.0.0` release gates.

## Next work: M5

M0–M4 are complete. `LibretroPsxAdapter` now validates content and firmware,
starts a fresh module Worker, waits for the first real frame and exposes the
public session lifecycle. Soft and hard reset, two controllers, both cards,
state round trips, multi-disc changes, timeout cleanup and repeated start/stop
are covered through deterministic doubles and the selected core. M5 implements
the multi-channel input coordinator and keyboard/gamepad sources.
