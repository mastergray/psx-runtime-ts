# Emulator core build boundary

This directory contains the immutable source identity, Emscripten pin,
production patches and normalized build recipe selected by milestones M0 and
M1 in the implementation spec.

`SOURCE.json` and `EMSDK_VERSION` pin PCSX-ReARMed and Emscripten after the
complete M0 comparison. `build.json` is the source-controlled M1 recipe whose
material flags, memory limits and runtime metadata feed the deterministic
build identity. Probe-only inputs remain under `core/probes/`. Source
checkouts and compiled output belong under ignored caches and `dist/core/`,
not here.
