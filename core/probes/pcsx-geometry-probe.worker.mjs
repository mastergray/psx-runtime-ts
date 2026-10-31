const modulePath = "../../dist/probes/pcsx-boot.mjs";
const framesRequested = 600;

const configurations = [
    { id: "rgb565", rgb32: false, frameskip: false, expectedPixelFormat: 2 },
    { id: "xrgb8888", rgb32: true, frameskip: false, expectedPixelFormat: 1 },
    { id: "rgb565-null-frames", rgb32: false, frameskip: true, expectedPixelFormat: 2 },
];
const expectedWidthSequence = [320, 256, 320, 256, 320];

const sequencesEqual = (left, right) => left.length === right.length
    && left.every((value, index) => value === right[index]);

const readFrameState = (module) => ({
    hash: module._psx_probe_video_hash() >>> 0,
    height: module._psx_probe_height() >>> 0,
    lastPixel: module._psx_probe_last_pixel() >>> 0,
    pitch: module._psx_probe_pitch() >>> 0,
    width: module._psx_probe_width() >>> 0,
});

const statesEqual = (left, right) => Object.keys(left)
    .every((key) => left[key] === right[key]);

self.onmessage = async ({ data }) => {
    try {
        const createModule = (await import(modulePath)).default;
        const cases = [];

        for (const configuration of configurations) {
            const module = await createModule();
            module.FS.mkdir("/content");
            module.FS.mkdir("/system");
            module.FS.mkdir("/save");
            module.FS.mount(module.WORKERFS, {
                blobs: [
                    { name: "m0-fixture.cue", data: data.cue },
                    { name: "m0-fixture.bin", data: data.bin },
                ],
            }, "/content");
            module._psx_probe_set_pal(0);
            module._psx_probe_set_rgb32(configuration.rgb32 ? 1 : 0);
            module._psx_probe_set_frameskip(configuration.frameskip ? 1 : 0);
            const booted = module._psx_probe_boot() === 1;
            let nullFrameStateStable = true;

            for (let frame = 0; frame < framesRequested; frame++) {
                const nullFramesBefore = module._psx_probe_null_video_frames() >>> 0;
                const stateBefore = readFrameState(module);
                module._psx_probe_run(1, 0);
                const nullFramesAfter = module._psx_probe_null_video_frames() >>> 0;
                if (nullFramesAfter > nullFramesBefore) {
                    nullFrameStateStable &&= statesEqual(stateBefore, readFrameState(module));
                }
            }

            const geometry = Array.from(
                { length: module._psx_probe_geometry_count() },
                (_, index) => ({
                    callback: module._psx_probe_geometry_callback_at(index) >>> 0,
                    width: module._psx_probe_geometry_width_at(index) >>> 0,
                    height: module._psx_probe_geometry_height_at(index) >>> 0,
                    pitch: module._psx_probe_geometry_pitch_at(index) >>> 0,
                    pixelFormat: module._psx_probe_geometry_format_at(index) >>> 0,
                }),
            );
            const environmentGeometry = Array.from(
                { length: module._psx_probe_environment_geometry_count() },
                (_, index) => ({
                    command: module._psx_probe_environment_geometry_command_at(index) >>> 0,
                    baseWidth: module._psx_probe_environment_geometry_base_width_at(index) >>> 0,
                    baseHeight: module._psx_probe_environment_geometry_base_height_at(index) >>> 0,
                    maxWidth: module._psx_probe_environment_geometry_max_width_at(index) >>> 0,
                    maxHeight: module._psx_probe_environment_geometry_max_height_at(index) >>> 0,
                }),
            );
            const pixelFormat = module._psx_probe_pixel_format() >>> 0;
            const bytesPerPixel = pixelFormat === 1 ? 4 : 2;
            const widths = [...new Set(geometry.map((entry) => entry.width))];
            const heights = [...new Set(geometry.map((entry) => entry.height))];
            const videoFrames = module._psx_probe_video_frames() >>> 0;
            const nullVideoFrames = module._psx_probe_null_video_frames() >>> 0;
            const pitchCorrect = geometry.every((entry) =>
                entry.pitch >= entry.width * bytesPerPixel
                && entry.pitch % bytesPerPixel === 0);
            const geometryChanged = sequencesEqual(
                geometry.map((entry) => entry.width),
                expectedWidthSequence,
            ) && heights.length === 1 && heights[0] === 240;
            const geometryFormatCorrect = geometry
                .every((entry) => entry.pixelFormat === configuration.expectedPixelFormat);
            const environmentReportedGeometry = sequencesEqual(
                environmentGeometry.map((entry) => entry.baseWidth),
                expectedWidthSequence,
            ) && environmentGeometry.every((entry) => entry.command === 37
                && entry.baseHeight === 240
                && entry.maxWidth === 1024
                && entry.maxHeight === 512);
            const nullBehaviorCorrect = configuration.frameskip
                ? videoFrames === framesRequested / 2
                    && nullVideoFrames === framesRequested / 2
                    && nullFrameStateStable
                : videoFrames === framesRequested && nullVideoFrames === 0;
            const result = {
                id: configuration.id,
                booted,
                framesRequested,
                callbacks: videoFrames + nullVideoFrames,
                videoFrames,
                nullVideoFrames,
                nullFrameStateStable,
                videoHash: module._psx_probe_video_hash() >>> 0,
                pixelFormat,
                expectedPixelFormat: configuration.expectedPixelFormat,
                widths,
                heights,
                pitchCorrect,
                geometryChanged,
                geometryFormatCorrect,
                environmentReportedGeometry,
                geometry,
                environmentGeometry,
            };
            result.ok = booted
                && result.callbacks === framesRequested
                && pixelFormat === configuration.expectedPixelFormat
                && pitchCorrect
                && geometryChanged
                && geometryFormatCorrect
                && environmentReportedGeometry
                && nullBehaviorCorrect;
            cases.push(result);

            module._psx_probe_shutdown();
            module.FS.unmount("/content");
        }

        self.postMessage({
            ok: cases.every((result) => result.ok),
            framesRequested,
            cases,
        });
    } catch (error) {
        self.postMessage({
            ok: false,
            message: error instanceof Error ? error.stack ?? error.message : String(error),
        });
    }
};
