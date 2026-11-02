# v1 release checklist

Run the automated gate from a clean checkout with the pinned external
toolchains and controlled firmware input available:

```sh
PSN00BSDK_ROOT=/path/to/PSn00bSDK-0.19-Linux \
PSX_CORE_SOURCE=/path/to/pcsx_rearmed \
EMSDK_ROOT=/path/to/emsdk \
EMSDK_PYTHON=/path/to/python3 \
PSX_BIOS_PATH=/path/to/firmware \
npm run gate:v1:automated
```

The command rebuilds the fixture and production core twice, checks all hashes,
runs the Node and native suites, exercises selected and stored content through
the real public Console path in Chromium, audits the npm tarball, and validates
the committed P1–P12 evidence.

The ignored harness preload supplies the tester's private BIOS; it is never
part of the package or repository. Select the generated diagnostic ZIP from
`tests/fixtures/generated/m0/psx-runtime-diagnostics.zip` and audit it as a
two-disc M3U set.

Two gates require a person and real audio/input hardware:

1. Start diagnostic disc 1. Exercise both displayed ports with their two
   keyboard maps, then use each player's per-control **Change** actions with
   physical standard-mapping gamepads. Hold controls on both ports at once,
   test analog axes, and confirm held controls release correctly and disconnect
   releases each gamepad channel. Reload once and confirm the captured keyboard
   and device-specific gamepad mappings remain selected.
2. In Game, select diagnostic disc 2 before Start. Confirm the audio test is
   the first program shown and Session reports audio as **enabled, audible**,
   then use Start/Select and the face
   buttons from both ports to start, stop, pan and restore the stereo tone.
   Confirm silence while stopped and no increasing playback delay. The
   existing media fixture separately retains the automated XA/CD-DA gate.

Record a successful run as `docs/probes/m10-manual.json`:

```json
{
  "schemaVersion": 1,
  "recordedAt": "YYYY-MM-DD",
  "physicalInput": {
    "keyboard": true,
    "gamepad": true,
    "concurrentPorts": true,
    "disconnectRelease": true,
    "pass": true
  },
  "audio": {
    "gestureUnlock": true,
    "pcm": true,
    "xa": true,
    "cdda": true,
    "synchronized": true,
    "pass": true
  }
}
```

Do not record local paths, device serial numbers, firmware identifiers or
content filenames. After this evidence exists, `npm run gate:v1` performs the
full evidence check.
