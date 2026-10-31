# Emulator core build boundary

This directory will contain the immutable source identity, Emscripten pin,
production patches and normalized build recipe selected by milestone M0 in
the implementation spec.

There is deliberately no production `SOURCE.json` or `EMSDK_VERSION` yet. The
baseline M0 comparison provisionally favors PCSX-ReARMed, but the remaining
media, card, state, controlled firmware-path and near-maximum-disc memory
probes must close before recording the production values. PAL/NTSC long-run
timing and determinism plus dynamic geometry are complete. Probe-only pins live
under `core/probes/`. Source checkouts and compiled output belong under ignored
caches and `dist/core/`, not here.
