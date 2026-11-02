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

Build the production core with the pinned source and toolchain checkouts:

```sh
PSX_CORE_SOURCE=/path/to/pcsx_rearmed \
EMSDK_ROOT=/path/to/emsdk \
EMSDK_PYTHON=/path/to/python3 \
npm run build:core
```

The source checkout must be at the exact commit and recursive submodule pins in
`SOURCE.json`; the emsdk checkout and `emcc` must match the recorded commits.
The command performs a clean core build, links the production shim and writes
the runtime artifacts, metadata, notices and distribution record to
`dist/core/`. `core/build.json` also pins `SOURCE_DATE_EPOCH` so upstream uses
a stable value for compile-time date and time macros.
