# Emulator core build boundary

This directory will contain the immutable source identity, Emscripten pin,
production patches and normalized build recipe selected by milestone M0 in
the implementation spec.

There is deliberately no production `SOURCE.json` or `EMSDK_VERSION` yet. The
baseline M0 comparison provisionally favors PCSX-ReARMed, but the remaining
long-run, PAL, media, card, state and memory probes must close before recording
the production values. Probe-only pins live under `core/probes/`. Source
checkouts and compiled output belong under ignored caches and `dist/core/`, not
here.
