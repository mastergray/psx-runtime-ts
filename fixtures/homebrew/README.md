# Homebrew acceptance fixture

This directory contains the source for the redistributable PlayStation test
disc used by the M0 probes. It renders deterministic animation, exposes
controller state through the frame output, and emits a looping SPU tone.

Generated CUE/BIN images are written to `fixtures/generated/` and are ignored.
No Sony SDK material, firmware, license sectors, or commercial content is
required or included.

## Toolchain

The checked-in recipe uses the Linux PSn00bSDK v0.19 release described in
`TOOLCHAIN.json`. Download that archive, verify its SHA-256 digest, extract it,
and point `PSN00BSDK_ROOT` at the extracted `PSn00bSDK-0.19-Linux` directory.
Then run:

```sh
npm run build:fixture
```

The build script checks the archive identity recorded in `TOOLCHAIN.json` when
`PSN00BSDK_ARCHIVE` is set. It always checks the compiler version before
configuring the fixture.

The fixture source is MIT licensed. PSn00bSDK's libraries are MPL-2.0 and its
image builder is GPL-2.0-or-later; see the upstream license linked from the
toolchain manifest.
