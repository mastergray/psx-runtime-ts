const modulePath = "../../dist/probes/pcsx-boot.mjs";
const sampleRate = 44_100;
const framesPerSecond = 60;
const segmentFrames = 180;

const estimateFrequency = (samples) => {
    const start = Math.min(2048, Math.floor(samples.length / 4));
    let crossings = 0;
    let previousSign = Math.sign(samples[start] ?? 0);
    for (let index = start + 1; index < samples.length; index++) {
        const sign = Math.sign(samples[index]);
        if (sign !== 0 && previousSign !== 0 && sign !== previousSign) crossings++;
        if (sign !== 0) previousSign = sign;
    }
    return crossings * sampleRate / (2 * Math.max(1, samples.length - start - 1));
};

const captureSegment = (module) => {
    module._psx_probe_reset_audio_observation();
    const consumptionPerFrame = sampleRate / framesPerSecond;
    let previousAudioFrames = 0;
    let queueFrames = consumptionPerFrame * 2;
    let peakQueueFrames = queueFrames;
    let underrunFrames = 0;

    for (let frame = 0; frame < segmentFrames; frame++) {
        module._psx_probe_run(1, 0);
        const currentAudioFrames = module._psx_probe_audio_frames() >>> 0;
        queueFrames += currentAudioFrames - previousAudioFrames;
        previousAudioFrames = currentAudioFrames;
        peakQueueFrames = Math.max(peakQueueFrames, queueFrames);
        if (queueFrames < consumptionPerFrame) {
            underrunFrames += consumptionPerFrame - queueFrames;
            queueFrames = 0;
        } else {
            queueFrames -= consumptionPerFrame;
        }
    }

    const captureCount = module._psx_probe_audio_capture_count() >>> 0;
    const samples = Array.from(
        { length: captureCount },
        (_, index) => module._psx_probe_audio_sample_at(index),
    );
    return {
        frames: segmentFrames,
        audioFrames: module._psx_probe_audio_frames() >>> 0,
        audioHash: module._psx_probe_audio_hash() >>> 0,
        audioPeak: module._psx_probe_audio_peak() >>> 0,
        batchCalls: module._psx_probe_audio_batch_calls() >>> 0,
        minimumBatchFrames: module._psx_probe_audio_batch_min_frames() >>> 0,
        maximumBatchFrames: module._psx_probe_audio_batch_max_frames() >>> 0,
        captureCount,
        estimatedFrequencyHz: estimateFrequency(samples),
        primingQueueFrames: consumptionPerFrame * 2,
        peakQueueFrames,
        finalQueueFrames: queueFrames,
        underrunFrames,
    };
};

self.onmessage = async ({ data }) => {
    try {
        const createModule = (await import(modulePath)).default;
        const runs = [];

        for (let repeat = 1; repeat <= 2; repeat++) {
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
            const booted = module._psx_probe_boot() === 1;
            if (!booted) throw new Error("PCSX-ReARMed rejected the media fixture");

            module._psx_probe_run(60, 0);
            const xa = captureSegment(module);
            const xaStatus = module._psx_probe_system_ram_word(0xff000) >>> 0;
            module._psx_probe_run(240, 0);
            const cdda = captureSegment(module);
            const cddaStatus = module._psx_probe_system_ram_word(0xff000) >>> 0;
            const expectedAudioFrames = segmentFrames * sampleRate / framesPerSecond;
            const segmentIsValid = (segment, expectedFrequency) =>
                segment.audioFrames === expectedAudioFrames
                && segment.audioPeak > 0
                && segment.batchCalls === segmentFrames
                && segment.minimumBatchFrames > 0
                && segment.maximumBatchFrames <= 1024
                && Math.abs(segment.estimatedFrequencyHz - expectedFrequency) <= 12
                && segment.underrunFrames === 0
                && segment.peakQueueFrames <= sampleRate / 10;
            const result = {
                repeat,
                booted,
                xa,
                cdda,
                xaStatus,
                cddaStatus,
            };
            result.ok = segmentIsValid(xa, 440) && segmentIsValid(cdda, 880);
            runs.push(result);

            module._psx_probe_shutdown();
            module.FS.unmount("/content");
        }

        const deterministic = runs[0].xa.audioHash === runs[1].xa.audioHash
            && runs[0].cdda.audioHash === runs[1].cdda.audioHash;
        self.postMessage({
            ok: runs.every((run) => run.ok) && deterministic,
            sampleRate,
            deterministic,
            runs,
        });
    } catch (error) {
        self.postMessage({
            ok: false,
            message: error instanceof Error ? error.stack ?? error.message : String(error),
        });
    }
};
