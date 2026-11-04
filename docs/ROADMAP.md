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
- [x] M9: implement local game storage, packaging and distribution gates.
- [x] M10: pass all `v1.0.0` release gates.
- [ ] M11: add plain TypeScript/HTML mobile layouts and touch controls.
- [ ] M12: build the framework-free production web-emulator interface.
  - [x] Separate production code under `ui/` from the diagnostic harness.
  - [x] Implement real System, Game, Library, Memory Cards and View workflows.
  - [x] Render firmware-required, ready and complete session lifecycle states.
  - [x] Prove the empty-storage desktop/mobile shell with `probe:ui`.
  - [x] Migrate supported controller mapping, named states and touch controls.
  - [ ] Complete physical-device and real-session visual acceptance.
- [ ] M13: add controller-first Presentation mode for mirrored televisions.
  - [x] Share the existing page, runtime, browser stores and active session.
  - [x] Add the TV skin, controller focus, menu gestures and pause ownership.
  - [x] Support direct Library launch, per-game disc selection, reset and scaling.
  - [x] Pass the M13 browser probe and existing production regression probe.
  - [ ] Complete physical mirrored-display and real-session acceptance.

## Next work: M11–M13

M0–M10 are complete and the release gate passes from a clean checkout. M11 adds
a framework-free on-screen PlayStation controller over the existing isolated
input-channel model. It covers rolling multi-touch D-pad input, face and
shoulder buttons, Start/Select, DualShock sticks, explicit L3/R3, active-port
selection, persisted visibility/swap preferences, responsive phone layouts and
a final physical-device acceptance run.

M12 is the production interface built from the same plain TypeScript/HTML
constraint. Its first slice is complete: browser-local firmware gates Game and
Library, ZIP imports use the existing audit/store path, multiple ZIPs retain
disc order and generate the stored M3U, Library starts or switches stored
content, session controls operate the real player, and View uses the runtime's
supported scaling/fullscreen modes. The diagnostic harness remains available
for feature-level verification while controller, state and touch-management
surfaces are migrated into the production design.

M13 adds the Presentation skin specified in
[presentation-mode-spec.md](presentation-mode-spec.md). It keeps one page and
one active runtime, hides local chrome while playing, and opens a paused,
controller-driven TV menu through L3 + R3, Escape or a two-finger tap. The
automated gate is complete; mirrored-display acceptance remains open.
