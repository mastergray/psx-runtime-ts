# Core probes

M0 probe sources live here. Committed evidence belongs under `docs/probes/`;
generated source trees and binaries are ignored.

`candidates.json` and `toolchain.json` are probe pins, not production pins.
Build both candidates at those exact commits with the commands recorded in the
candidate manifest. Link the probe shim with the flags in the toolchain
manifest. The core-specific initial heaps used by the current comparison are
64 MiB for PCSX-ReARMed and 128 MiB for Beetle PSX; both have a provisional
512 MiB maximum pending P11.

Beetle's static archive also needs the libretro-common sources used by its
dynamic target, including filesystem, string, compatibility, encoding,
rthreads and eventcount objects. The upstream static Emscripten recipe does
not currently include those frontend objects.

After the ignored modules and generated fixture exist, run:

```sh
npm run probe:workerfs
npm run probe:pcsx
npm run probe:beetle
```

The browser runner serves only the explicit probe files and generated fixture,
launches Chrome, and prints one JSON result.
