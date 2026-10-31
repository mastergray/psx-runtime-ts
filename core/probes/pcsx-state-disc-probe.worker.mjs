const modulePath = "../../dist/probes/pcsx-boot.mjs";
const discStatusOffset = 0xff004;

const hashText = (text) => {
    let hash = 2166136261;
    for (const value of new TextEncoder().encode(text)) {
        hash ^= value;
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash;
};

const discOnePathHash = hashText("/content/disc1.cue");
const discTwoPathHash = hashText("/content/disc2.cue");
const waitForTrayClose = () => new Promise((resolve) => setTimeout(resolve, 2100));
const discSettleFrames = 900;

const replayFrames = (module, count) => {
    const pixels = [];
    module._psx_probe_reset_video_observation();
    for (let frame = 0; frame < count; frame++) {
        module._psx_probe_run(1, 0);
        pixels.push(module._psx_probe_last_pixel() >>> 0);
    }
    return {
        pixels,
        videoHash: module._psx_probe_video_hash() >>> 0,
        videoFrames: module._psx_probe_video_frames() >>> 0,
    };
};

const mountContent = (module, data) => {
    module.FS.mkdir("/content");
    module.FS.mkdir("/system");
    module.FS.mkdir("/save");
    module.FS.mount(module.WORKERFS, {
        blobs: [
            { name: "disc1.cue", data: data.disc1Cue },
            { name: "disc1.bin", data: data.disc1Bin },
            { name: "disc2.cue", data: data.disc2Cue },
            { name: "disc2.bin", data: data.disc2Bin },
            { name: "m0-fixture.m3u", data: data.m3u },
        ],
    }, "/content");
};

self.onmessage = async ({ data }) => {
    try {
        const createModule = (await import(modulePath)).default;
        const module = await createModule();
        mountContent(module, data);
        module._psx_probe_set_m3u(1);
        const booted = module._psx_probe_boot() === 1;
        if (!booted) throw new Error("PCSX-ReARMed rejected the multi-disc fixture");

        module._psx_probe_run(120, 0);
        const initial = {
            available: module._psx_probe_disk_available() === 1,
            count: module._psx_probe_disk_count() >>> 0,
            index: module._psx_probe_disk_index() >>> 0,
            ejected: module._psx_probe_disk_ejected() === 1,
            fixtureStatus: module._psx_probe_system_ram_word(discStatusOffset) >>> 0,
            pathHash: module._psx_probe_disk_path_hash(0) >>> 0,
        };

        const firstStateSaved = module._psx_probe_save_state() === 1;
        const firstStateHash = module._psx_probe_state_hash() >>> 0;
        const stateSize = module._psx_probe_state_size() >>> 0;
        const firstPass = replayFrames(module, 90);
        const firstStateRestored = module._psx_probe_restore_state() === 1;
        const secondPass = replayFrames(module, 90);
        const deterministicReplay = firstPass.videoHash === secondPass.videoHash
            && firstPass.videoFrames === secondPass.videoFrames
            && firstPass.pixels.every((pixel, index) => pixel === secondPass.pixels[index]);

        const trace = [];
        trace.push({ operation: "open", result: module._psx_probe_set_disk_ejected(1) === 1 });
        module._psx_probe_run(30, 0);
        trace.push({
            operation: "change",
            result: module._psx_probe_set_disk_index(1) === 1,
            index: module._psx_probe_disk_index() >>> 0,
        });
        trace.push({ operation: "close", result: module._psx_probe_set_disk_ejected(0) === 1 });
        await waitForTrayClose();
        module._psx_probe_run(discSettleFrames, 0);
        const discTwo = {
            index: module._psx_probe_disk_index() >>> 0,
            ejected: module._psx_probe_disk_ejected() === 1,
            fixtureStatus: module._psx_probe_system_ram_word(discStatusOffset) >>> 0,
            pathHash: module._psx_probe_disk_path_hash(1) >>> 0,
        };

        const secondStateSaved = module._psx_probe_save_state() === 1;
        const secondStateHash = module._psx_probe_state_hash() >>> 0;
        trace.push({ operation: "open", result: module._psx_probe_set_disk_ejected(1) === 1 });
        module._psx_probe_run(30, 0);
        trace.push({
            operation: "change",
            result: module._psx_probe_set_disk_index(0) === 1,
            index: module._psx_probe_disk_index() >>> 0,
        });
        trace.push({ operation: "close", result: module._psx_probe_set_disk_ejected(0) === 1 });
        await waitForTrayClose();
        module._psx_probe_run(discSettleFrames, 0);
        const backOnDiscOne = {
            index: module._psx_probe_disk_index() >>> 0,
            fixtureStatus: module._psx_probe_system_ram_word(discStatusOffset) >>> 0,
            pathHash: module._psx_probe_disk_path_hash(0) >>> 0,
        };
        const secondStateRestored = module._psx_probe_restore_state() === 1;
        await waitForTrayClose();
        module._psx_probe_run(discSettleFrames, 0);
        const restoredDiscTwo = {
            index: module._psx_probe_disk_index() >>> 0,
            ejected: module._psx_probe_disk_ejected() === 1,
            fixtureStatus: module._psx_probe_system_ram_word(discStatusOffset) >>> 0,
            pathHash: module._psx_probe_disk_path_hash(1) >>> 0,
        };

        const result = {
            booted,
            initial,
            stateSize,
            firstStateSaved,
            firstStateHash,
            firstStateRestored,
            deterministicReplay,
            replayVideoHash: firstPass.videoHash,
            trace,
            discTwo,
            secondStateSaved,
            secondStateHash,
            backOnDiscOne,
            secondStateRestored,
            restoredDiscTwo,
        };
        result.ok = booted
            && initial.available
            && initial.count === 2
            && initial.index === 0
            && !initial.ejected
            && initial.fixtureStatus === 0x4d304401
            && initial.pathHash === discOnePathHash
            && stateSize > 0
            && firstStateSaved
            && firstStateRestored
            && deterministicReplay
            && trace.every((entry) => entry.result)
            && discTwo.index === 1
            && !discTwo.ejected
            && discTwo.pathHash === discTwoPathHash
            && discTwo.fixtureStatus === 0x4d304402
            && secondStateSaved
            && secondStateHash !== firstStateHash
            && backOnDiscOne.index === 0
            && backOnDiscOne.pathHash === discOnePathHash
            && backOnDiscOne.fixtureStatus === 0x4d304401
            && secondStateRestored
            && restoredDiscTwo.index === 1
            && !restoredDiscTwo.ejected
            && restoredDiscTwo.pathHash === discTwoPathHash
            && restoredDiscTwo.fixtureStatus === 0x4d304402;

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
