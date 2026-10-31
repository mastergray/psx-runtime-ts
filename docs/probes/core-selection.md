# M0 core selection record

Status: **complete; PCSX-ReARMed selected.**

All P1–P12 feasibility probes pass. The production identities are now recorded
in [`core/SOURCE.json`](../../core/SOURCE.json) and
[`core/EMSDK_VERSION`](../../core/EMSDK_VERSION). Machine-readable measurements
are in [m0-results.json](m0-results.json); the comparison inputs remain in
[`candidates.json`](../../core/probes/candidates.json) and
[`toolchain.json`](../../core/probes/toolchain.json).

## Final decision

PCSX-ReARMed is selected at commit
`9f8b028cd66200bb9a18a878a5e73925a629b0a7` with Emscripten 6.0.2. Both
candidates pass the same Worker-hosted boot, video, audio, input and environment
probe. PCSX-ReARMed is the smaller module, starts faster in the final comparison
run and uses half the initial Wasm memory. It also passes every selected-core
media, persistence, state, disc, timing and memory probe.

| Measurement | PCSX-ReARMed | Beetle PSX |
| --- | ---: | ---: |
| Static core archive | 5,977,552 B | 23,456,710 B |
| Linked probe Wasm | 726,849 B | 3,818,603 B |
| Initial Wasm memory | 64 MiB | 128 MiB |
| `retro_load_game` | 30.8 ms | 46.9 ms |
| First video callback | 45.8 ms | 71.3 ms |
| 424-frame scripted run | 2,739.6 ms | 3,513.0 ms |
| Reported rate | 60.00 fps | 59.94 fps |
| Output | 320×240 RGB565 | 700×480 XRGB8888 |

These measurements compare the pinned candidates on the reference machine;
they are not user-facing latency promises.

## Source and build findings

Both commits, top-level trees, licenses and all recursive PCSX-ReARMed
submodule identities were verified against clean tracked worktrees. Both
candidates compile as single-threaded, software-rendered Wasm without dynarec,
native assembly, pthreads or Asyncify.

PCSX-ReARMed's Emscripten target is self-contained when CHD is disabled. Its
archive uses a `.bc` suffix even though it is an `ar` archive, so the probe
copies it to `.a` before final linking.

Beetle's static target needs two documented link-recipe repairs: the
libretro-common frontend objects omitted from the static target, and the
rthreads/eventcount support referenced by `mc_async.c`. Those sources are
supplied at final link without modifying the pinned candidate tree. Beetle's
embedded PCSX-Redux OpenBIOS remains MIT licensed.

Emscripten 6.0.2 requires `-sGROWABLE_ARRAYBUFFERS=0` for these builds because
Chrome 150 rejects `TextDecoder` input backed by the resizable buffer otherwise
selected by generated filesystem glue.

## Selected-core evidence

The controlled firmware-path probe loaded a private user-supplied BIOS, reached
video on the first emulated frame and produced first-frame hash `3135512005`.
The committed record retains only the recognized region, timings, frame hash
and sanitized boot events.

The geometry fixture switches between 320×240 and 256×240. RGB565 uses pitches
of 640 and 512 bytes; XRGB8888 uses 1,280 and 1,024 bytes. Fixed-interval
frameskip yields 300 video frames and 300 explicit null callbacks while
retaining prior frame state.

XA and CD-DA probes measure 440.01 Hz and 880.02 Hz respectively. Each
180-frame segment produces exactly 132,300 audio frames, bounded 734–736-frame
callbacks, a 2,205-frame maximum queue and zero underruns. Both independent
runs produce identical hashes.

Both 128 KiB memory-card slots write in the expected order. Persisted bytes
match core memory exactly and restore before the first frame of a fresh module.
State replay is frame-exact; the complete open/change/close disc trace reaches
the second-disc fixture, returns to the first and restores the second disc from
the saved state.

The 846,720,000-byte synthetic disc mounts and boots through WORKERFS. Beginning,
middle and end reads are correct, the Wasm heap remains at 64 MiB, and dedicated
browser-process growth remains below half the logical disc size. This rules out
a full track-sized copy during mount or startup.

## Timing and endurance

PCSX-ReARMed completed two independent 60-second runs for NTSC and PAL at both
60 Hz and 120 Hz host cadence after a two-second warmup. Every run ended with
the exact expected video and audio counts, zero missing or null callbacks, zero
audio drift, zero simulated underruns and identical region-specific hashes.

| Region | Host cadence | Frames/run | Audio frames/run | Max backlog events | Max host-tick overruns |
| --- | ---: | ---: | ---: | ---: | ---: |
| NTSC | 60 Hz | 3,600 | 2,646,000 | 6 | 6 |
| NTSC | 120 Hz | 3,600 | 2,646,000 | 0 | 554 |
| PAL | 60 Hz | 3,000 | 2,646,000 | 0 | 2 |
| PAL | 120 Hz | 3,000 | 2,646,000 | 0 | 413 |

A host-tick overrun is completion after one host interval, not a dropped
emulated frame. The maximum core utilization was 52.61%; every transient
backlog recovered. The matrix ran without COOP/COEP headers and kept the Wasm
heap fixed at 64 MiB.

## Probe status

| Probe | Status | Evidence |
| --- | --- | --- |
| P1 source and licenses | Pass | Commits, trees, recursive submodules and required license files verified. |
| P2 Wasm builds | Pass | Both candidates rebuilt and linked with the pinned toolchain and forbidden runtime features absent. |
| P3 real boot | Pass | Real BIOS load, sanitized boot trace, first-frame timing and hash recorded. |
| P4 WORKERFS | Pass | Beginning/middle/end reads across a logical 256 MiB Blob match expected hashes. |
| P5 environment API | Pass | Both candidates return bounded startup and runtime command traces. |
| P6 video formats | Pass | RGB565, XRGB8888, runtime geometry and explicit null callbacks verified. |
| P7 timing | Pass | NTSC/PAL rates and both host cadences complete with exact counters. |
| P8 audio | Pass | Deterministic XA/CD-DA frequency, callback and bounded-queue evidence recorded. |
| P9 memory cards | Pass | Both slots persist exact bytes and restore before first frame. |
| P10 state/disc control | Pass | Frame-exact state replay and game-observed two-disc restoration verified. |
| P11 memory | Pass | Near-maximum disc boots without a track-sized Wasm or browser allocation. |
| P12 long-run determinism | Pass | Eight full-duration cases complete with repeatable hashes and zero underruns. |

## Licensing consequence

The selected linked core makes the core/shim Wasm distribution
GPL-2.0-or-later. A release must provide the exact corresponding core and shim
source, applied patches, reproducible build instructions, copyright notices and
GPL text. The separately communicating TypeScript package remains MIT in this
design, but release packaging should be reviewed before publication; this is an
engineering inventory, not legal advice.
