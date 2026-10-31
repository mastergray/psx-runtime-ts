const core = new URL(self.location.href).searchParams.get("core") ?? "pcsx";
const modulePath = core === "beetle"
    ? "../../dist/probes/beetle-boot.mjs"
    : "../../dist/probes/pcsx-boot.mjs";

self.onmessage = async ({ data }) => {
    try {
        const createModule = (await import(modulePath)).default;
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

        const started = performance.now();
        const booted = module._psx_probe_boot() === 1;
        const loadGameMs = performance.now() - started;
        const startupEnvironmentCount = module._psx_probe_environment_count();
        let framesToFirstVideo = 0;
        while (module._psx_probe_video_frames() === 0 && framesToFirstVideo < 600) {
            module._psx_probe_run(1, 0);
            framesToFirstVideo++;
        }
        const firstVideoMs = performance.now() - started;
        if (framesToFirstVideo < 360) module._psx_probe_run(360 - framesToFirstVideo, 0);
        const neutralPixel = module._psx_probe_last_pixel() >>> 0;
        module._psx_probe_run(64, 1);
        const pressedPixel = module._psx_probe_last_pixel() >>> 0;
        const elapsedMs = performance.now() - started;

        const allEnvironmentCommands = Array.from(
            { length: module._psx_probe_environment_count() },
            (_, index) => module._psx_probe_environment_at(index) >>> 0,
        );
        const startupEnvironmentCommands = allEnvironmentCommands.slice(0, startupEnvironmentCount);
        const runtimeEnvironmentCommandCounts = Object.fromEntries(
            [...new Set(allEnvironmentCommands.slice(startupEnvironmentCount))]
                .map((command) => [
                    command,
                    allEnvironmentCommands.slice(startupEnvironmentCount)
                        .filter((value) => value === command).length,
                ]),
        );
        const result = {
            core,
            ok: booted && module._psx_probe_video_frames() > 0 && module._psx_probe_audio_frames() > 0,
            booted,
            loadGameMs,
            firstVideoMs,
            framesToFirstVideo,
            elapsedMs,
            videoFrames: module._psx_probe_video_frames() >>> 0,
            nullVideoFrames: module._psx_probe_null_video_frames() >>> 0,
            videoHash: module._psx_probe_video_hash() >>> 0,
            audioFrames: module._psx_probe_audio_frames() >>> 0,
            audioHash: module._psx_probe_audio_hash() >>> 0,
            audioPeak: module._psx_probe_audio_peak() >>> 0,
            neutralPixel,
            pressedPixel,
            inputChangedPixel: neutralPixel !== pressedPixel,
            width: module._psx_probe_width() >>> 0,
            height: module._psx_probe_height() >>> 0,
            pitch: module._psx_probe_pitch() >>> 0,
            pixelFormat: module._psx_probe_pixel_format() >>> 0,
            fps: module._psx_probe_fps_milli() / 1000,
            sampleRate: module._psx_probe_sample_rate() >>> 0,
            wasmMemoryBytes: module.HEAPU8.buffer.byteLength,
            startupEnvironmentCommands,
            runtimeEnvironmentCommandCounts,
        };

        module._psx_probe_shutdown();
        module.FS.unmount("/content");
        self.postMessage(result);
    } catch (error) {
        self.postMessage({
            ok: false,
            message: error instanceof Error ? error.stack ?? error.message : String(error),
        });
    }
};
