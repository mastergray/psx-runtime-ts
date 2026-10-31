const modulePath = "../../dist/probes/pcsx-boot.mjs";

const readCoreLog = (module) => Array.from(
    { length: module._psx_probe_log_count() >>> 0 },
    (_, index) => String.fromCharCode(module._psx_probe_log_char_at(index) >>> 0),
).join("");

const sanitizeBootLog = (log) => {
    const entries = [];
    const region = /found (US|JP|EU) BIOS file/u.exec(log)?.[1];
    if (region !== undefined) entries.push(`recognized ${region} BIOS`);
    if (log.includes("Loaded BIOS \"")) entries.push("real BIOS loaded");
    if (log.includes("Using HLE BIOS.")) entries.push("HLE BIOS selected");
    if (log.includes("No BIOS files found.")) entries.push("BIOS unavailable");
    return entries;
};

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
        module.FS.mount(module.WORKERFS, {
            blobs: [{ name: "scph5501.bin", data: data.bios }],
        }, "/system");

        module._psx_probe_set_real_bios(1);
        const started = performance.now();
        const booted = module._psx_probe_boot() === 1;
        const loadGameMs = performance.now() - started;
        let framesToFirstVideo = 0;
        while (module._psx_probe_video_frames() === 0 && framesToFirstVideo < 600) {
            module._psx_probe_run(1, 0);
            framesToFirstVideo++;
        }
        const firstVideoMs = performance.now() - started;
        const firstFrameHash = module._psx_probe_video_hash() >>> 0;
        if (framesToFirstVideo < 360) module._psx_probe_run(360 - framesToFirstVideo, 0);

        const coreLog = readCoreLog(module);
        const sanitizedBootLog = sanitizeBootLog(coreLog);
        const realBiosLoaded = sanitizedBootLog.includes("real BIOS loaded")
            && !sanitizedBootLog.includes("HLE BIOS selected")
            && !sanitizedBootLog.includes("BIOS unavailable");
        const result = {
            booted,
            realBiosLoaded,
            loadGameMs,
            firstVideoMs,
            framesToFirstVideo,
            firstFrameHash,
            videoFrames: module._psx_probe_video_frames() >>> 0,
            audioFrames: module._psx_probe_audio_frames() >>> 0,
            sanitizedBootLog,
        };
        result.ok = booted
            && realBiosLoaded
            && framesToFirstVideo < 600
            && firstFrameHash !== 0
            && result.videoFrames > 0
            && result.audioFrames > 0;

        module._psx_probe_shutdown();
        module.FS.unmount("/system");
        module.FS.unmount("/content");
        self.postMessage(result);
    } catch (error) {
        self.postMessage({
            ok: false,
            message: error instanceof Error ? error.stack ?? error.message : String(error),
        });
    }
};
