# Homebrew acceptance fixture

This directory contains the source for the redistributable PlayStation test
disc used by the M0 probes. The legacy probe fixture renders deterministic
animation and supports the pinned PAL, dynamic-width, XA/CD-DA, two-card and
two-disc evidence variants.

The build also creates a two-disc diagnostic package. Disc 1 displays live
digital and analog state for controller ports 1 and 2 without producing a
tone. Disc 2 starts silent and lets either port start, stop, pan or toggle a
low-volume SPU tone. A generated M3U references both discs, and the complete
set is packaged as one deterministic ZIP for archive-import testing. A live
disc change selects the corresponding diagnostic screen after the emulated
drive settles.

Generated CUE/BIN images are written to `tests/fixtures/generated/` and are ignored.
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
configuring the fixture and performs a clean build of all seven evidence
variants plus the controller/audio diagnostic bundle. Generated outputs remain
under `tests/fixtures/generated/m0/` and are ignored.

The fixture source is MIT licensed except for `pad_spi.c` and `pad_spi.h`,
which are derived from PSn00bSDK's MPL-2.0 controller example. PSn00bSDK's
libraries are MPL-2.0 and its image builder is GPL-2.0-or-later; see the
upstream license linked from the toolchain manifest.
