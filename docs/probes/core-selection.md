# M0 core selection record

Status: **in progress; PCSX-ReARMed is the provisional winner.**

This record deliberately does not create `core/SOURCE.json` or
`core/EMSDK_VERSION`. The baseline comparison is complete, but the M0 hard gate
also requires PAL, long-run timing, XA/CD audio, memory-card, state, disc-change
and peak-memory evidence. The production pin becomes final only after those
checks pass.

Machine-readable measurements are in [m0-results.json](m0-results.json). Exact
candidate identities are in
[candidates.json](../../core/probes/candidates.json), and the probe toolchain is
in [toolchain.json](../../core/probes/toolchain.json).

## Baseline outcome

Both pinned candidates compile as single-threaded software-rendered Wasm and
boot the same reproducible MIT-licensed CUE/BIN fixture in a dedicated Chromium
Worker. Both produce video and non-silent audio, and both reflect a controller
button in the center pixel while sampled at the same animation phase.

| Measurement | PCSX-ReARMed | Beetle PSX |
| --- | ---: | ---: |
| Static core archive | 5,977,552 B | 23,456,710 B |
| Linked probe Wasm | 711,115 B | 3,771,994 B |
| Initial Wasm memory | 64 MiB | 128 MiB |
| `retro_load_game` | 22.8 ms | 30.9 ms |
| First video callback | 35.5 ms | 48.6 ms |
| 424-frame scripted run | 2,064.8 ms | 2,460.6 ms |
| Reported rate | 60.00 fps | 59.94 fps |
| Output | 320×240 RGB565 | 700×480 XRGB8888 |

These are probe comparisons, not user-facing latency promises. Browser timing
was recorded on Chrome 150 on an Intel i7-1165G7.

PCSX-ReARMed is provisionally selected because the spec says the smallest
candidate that passes the required probes wins unless accuracy evidence
overrides size. No contrary accuracy evidence exists yet, and PCSX also leads
this baseline on startup, scripted throughput and initial memory.

## Build findings

PCSX-ReARMed's Emscripten target is self-contained when CHD is disabled. Its
target disables dynarec, asynchronous CD/GPU/SPU work, native assembly,
physical CD access, pthread linkage and libretro VFS use. The output is an `ar`
archive named with a `.bc` suffix; Emscripten 6.0.2 requires copying it to an
`.a` name before final linking.

Beetle's Emscripten static target needs two recipe repairs before it links:

- the static target omits libretro-common filesystem/string/platform objects
  expected from a frontend; and
- `mc_async.c` remains in the source list after `NEED_THREADING=0`, while the
  rthreads/eventcount implementations it references are omitted.

With the missing frontend objects supplied, Beetle boots using its embedded
MIT-licensed PCSX-Redux OpenBIOS. CHD, Lightrec, pthreads and hardware rendering
remain disabled.

Emscripten 6.0.2 also requires `-sGROWABLE_ARRAYBUFFERS=0` for this build.
Without it, Chrome 150 rejects `TextDecoder.decode()` on the resizable backing
buffer selected by generated filesystem glue.

## Probe status

| Probe | Status | Evidence / remaining work |
| --- | --- | --- |
| P1 source and licenses | Baseline complete | Immutable commits, trees, recursive PCSX submodule identities, GPL-2.0-or-later core licenses and permissive embedded-firmware license recorded. Final distribution must ship notices, corresponding source and build/patch material for the linked GPL core. |
| P2 Wasm builds | Pass | Both archives and Worker modules built without dynarec, native assembly, pthreads, Asyncify or hardware rendering. Beetle recipe gaps are recorded above. |
| P3 real boot | Partial pass | Both boot the public fixture with open firmware and produce a first frame. The controlled retail-BIOS run remains. |
| P4 WORKERFS | Pass | Three synchronous reads across a logical 256 MiB Blob matched expected FNV checksums; the read window completed in 4.4 ms without copying the full Blob into Wasm memory. |
| P5 environment API | Baseline complete | Startup first-occurrence order and runtime counts are recorded in JSON. Supported commands are bounded by the probe callback; VFS, rumble, memory maps, software-framebuffer access and optional performance/LED surfaces are explicitly rejected when not implemented. |
| P6 video formats | Partial pass | RGB565 and XRGB8888, nontrivial pitch and zero null frames are proven. Runtime geometry switches and explicit null-frame tests remain. |
| P7 timing | Partial | NTSC-like rates are recorded. PAL and paced 60-second 60/120 Hz host-cadence runs remain. |
| P8 audio | Partial pass | Non-silent looping SPU tone, callback counts and hashes are proven. XA and CD-DA remain. |
| P9 memory cards | Pending | Both slots, restore order, dirty detection and reload proof remain. |
| P10 state/disc control | Pending | State round trip and multi-disc open/change/close remain. |
| P11 memory | Partial | Initial heaps and large-Blob access are recorded. Browser and Wasm steady/peak traces remain. |
| P12 long-run determinism | Partial | Both complete the short deterministic run faster than real time. Repeated 60-second NTSC/PAL hashes and underrun/drop counts remain. |

## Environment commands observed

The startup traces include logging, controller metadata, core-option version
and variables, system/save directories, disk-control version and interface,
input bitmasks, performance level, input descriptions, pixel format and memory
maps. PCSX additionally requests message, geometry, audio-buffer-status,
minimum-latency and current-software-framebuffer services. Beetle additionally
probes VFS, LED, performance and shared-hardware-context services. Numeric
order and runtime counts are retained in the JSON record so repeated option
queries are not hidden.

## Licensing consequence

Either linked core makes the core/shim Wasm distribution GPL-2.0-or-later. A
release must provide the exact corresponding core and shim source, applied
patches, reproducible build instructions, copyright notices and GPL text. The
separately communicating TypeScript package remains MIT in this design, but
release packaging should be reviewed before publication; this record is an
engineering inventory, not legal advice.
