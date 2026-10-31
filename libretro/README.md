# Libretro frontend boundary

This directory is the production-facing C boundary selected for M2. The
header under `include/` is the minimal ABI subset derived from the exact
libretro-common submodule pinned in `core/SOURCE.json`; its upstream file hash
is recorded in the header.

The shim owns frontend callbacks, copied video/audio observations, input,
rumble, state, memory-card access and the complete eject/change/close disc
transaction. TypeScript calls only the narrow functions declared in
`shim/psx_frontend.h`; raw `retro_*` functions remain on the C side.

`npm run test:shim` compiles the shim against the native synthetic core under
`tests/native/`. That test exercises repeatable start/stop, live geometry,
pitch-aware video, audio batching, digital and analog input, state replay,
both card slots, rumble and disc control before the production core is linked.
