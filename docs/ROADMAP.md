# Roadmap

The authoritative architecture, milestone definitions and acceptance criteria
are in [the implementation spec](psx-runtime-spec.md).

## Current status

- [x] Draft the implementation contract.
- [x] Create the TypeScript package and test scaffold.
- [ ] M0: compare and pin the emulator core and Emscripten toolchain.
- [ ] M1: implement public contracts, errors and deterministic build metadata.
- [ ] M2–M9: bridge, Worker, content, adapter, browser surfaces and storage.
- [ ] M10: pass all `v1.0.0` release gates.

## Next work: M0

M0 is a hard feasibility gate. It must answer probe questions P1–P12 in the
spec and commit `docs/probes/core-selection.md`, `core/SOURCE.json` and
`core/EMSDK_VERSION` only after a candidate has been built and measured.
