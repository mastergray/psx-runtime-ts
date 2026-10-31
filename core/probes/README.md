# Core probes

M0 probe sources live here. Committed evidence belongs under `docs/probes/`;
generated source trees and binaries are ignored.

`candidates.json` and `toolchain.json` are probe pins, not production pins.
Build both candidates at those exact commits with the commands recorded in the
candidate manifest. Link the probe shim with the flags in the toolchain
manifest. The comparison used a 64 MiB initial heap for PCSX-ReARMed and a
128 MiB initial heap for Beetle PSX. P11 validated the selected core with a
512 MiB configured maximum and no growth beyond its 64 MiB initial heap.

Beetle's static archive also needs the libretro-common sources used by its
dynamic target, including filesystem, string, compatibility, encoding,
rthreads and eventcount objects. The upstream static Emscripten recipe does
not currently include those frontend objects.

After the ignored modules and generated fixture exist, run:

```sh
npm run probe:workerfs
npm run probe:pcsx
npm run probe:beetle
npm run probe:endurance
npm run probe:geometry
npm run probe:media
npm run probe:cards
npm run probe:state-disc
npm run probe:memory
npm run probe:bios
npm run probe:m6
npm run probe:m7
```

The browser runner serves only the explicit probe files and generated fixture,
launches Chrome, and prints one JSON result.

`probe:endurance` runs two 60-second PCSX-ReARMed measurements for every
NTSC/PAL and 60/120 Hz host-cadence combination. Use `PROBE_SECONDS` and
`PROBE_REPEATS` only for local smoke runs; committed acceptance evidence uses
the 60-second/two-repeat defaults. The runner records one-second Wasm heap and
dedicated Chrome process-tree RSS samples. It deliberately sends no COOP/COEP
headers so the endurance result also proves the non-isolated deployment mode.

`probe:geometry` runs RGB565, XRGB8888 and fixed-interval frameskip cases
against the dynamic-width fixture. It verifies callback and environment
geometry, byte pitch, deterministic frame hashes, explicit null callbacks and
retention of the prior frame state.

The BIOS probe requires `PSX_BIOS_PATH` to name a private user-supplied input.
It records only a recognized region, a first-frame hash, timings and a
sanitized boot log. The remaining focused probes cover XA/CD-DA transport, two
memory-card slots, state/disc restoration and bounded near-maximum-disc memory.

`probe:m6` needs no emulator content. It loads the compiled public display and
audio classes in Chromium and verifies dynamic Canvas 2D geometry, a rendered
pixel, gesture unlock and the bounded Web Audio queue.

`probe:m7` uses a disposable IndexedDB database to verify card and state
recovery through a fresh storage instance, optimistic write conflicts,
recoverable card revisions and incompatible-state rejection.
