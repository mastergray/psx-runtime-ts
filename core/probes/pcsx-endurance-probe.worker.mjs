const modulePath = "../../dist/probes/pcsx-boot.mjs";
const configuredMaximumWasmMemoryBytes = 512 * 1024 * 1024;

const delay = (milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, milliseconds));
});

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

        module._psx_probe_set_pal(data.region === "pal" ? 1 : 0);
        const booted = module._psx_probe_boot() === 1;
        if (!booted) throw new Error("PCSX-ReARMed rejected the endurance fixture");

        const framesPerSecond = module._psx_probe_fps_milli() / 1000;
        const sampleRate = module._psx_probe_sample_rate() >>> 0;
        const warmupFrames = Math.round(framesPerSecond * 2);
        const warmupStarted = performance.now();
        module._psx_probe_run(warmupFrames, 0);
        const warmupMs = performance.now() - warmupStarted;
        const totalTicks = Math.round(data.hostCadenceHz * data.durationSeconds);
        const targetFrames = Math.round(framesPerSecond * data.durationSeconds);
        const targetAudioFrames = Math.round(sampleRate * data.durationSeconds);
        const tickIntervalMs = 1000 / data.hostCadenceHz;
        const initialVideoFrames = module._psx_probe_video_frames() >>> 0;
        const initialNullVideoFrames = module._psx_probe_null_video_frames() >>> 0;
        const initialAudioFrames = module._psx_probe_audio_frames() >>> 0;
        const initialWasmMemoryBytes = module.HEAPU8.buffer.byteLength;
        const wasmMemoryTrace = [{ elapsedMs: 0, bytes: initialWasmMemoryBytes }];
        let peakWasmMemoryBytes = initialWasmMemoryBytes;
        let emulatedFrames = 0;
        let consumedAudioFrames = 0;
        let simulatedAudioQueueFrames = Math.ceil((sampleRate / framesPerSecond) * 2);
        const audioPrimingFrames = simulatedAudioQueueFrames;
        let simulatedAudioUnderrunFrames = 0;
        let previousAudioFrames = initialAudioFrames;
        let hostTickOverruns = 0;
        let emulationBacklogEvents = 0;
        let lateTicks = 0;
        let maxTickLatenessMs = 0;
        let maxCoreRunMs = 0;
        let totalCoreRunMs = 0;
        let nextMemorySampleMs = 1000;
        const started = performance.now();

        for (let tick = 1; tick <= totalTicks; tick++) {
            const scheduledAt = started + tick * tickIntervalMs;
            const waitMs = scheduledAt - performance.now();
            if (waitMs > 0) await delay(waitMs);
            const tickStarted = performance.now();
            const tickLatenessMs = Math.max(0, tickStarted - scheduledAt);
            if (tickLatenessMs > 1) lateTicks++;
            maxTickLatenessMs = Math.max(maxTickLatenessMs, tickLatenessMs);

            const targetFrameAtTick = Math.ceil((tick * targetFrames) / totalTicks);
            const framesDue = targetFrameAtTick - emulatedFrames;
            const coreStarted = performance.now();
            if (framesDue > 0) module._psx_probe_run(framesDue, 0);
            const coreRunMs = performance.now() - coreStarted;
            maxCoreRunMs = Math.max(maxCoreRunMs, coreRunMs);
            totalCoreRunMs += coreRunMs;
            emulatedFrames += framesDue;

            const currentAudioFrames = module._psx_probe_audio_frames() >>> 0;
            simulatedAudioQueueFrames += currentAudioFrames - previousAudioFrames;
            previousAudioFrames = currentAudioFrames;
            const targetConsumedAtTick = Math.floor((tick * targetAudioFrames) / totalTicks);
            const audioFramesDue = targetConsumedAtTick - consumedAudioFrames;
            if (simulatedAudioQueueFrames < audioFramesDue) {
                simulatedAudioUnderrunFrames += audioFramesDue - simulatedAudioQueueFrames;
                simulatedAudioQueueFrames = 0;
            } else {
                simulatedAudioQueueFrames -= audioFramesDue;
            }
            consumedAudioFrames += audioFramesDue;

            const tickFinished = performance.now();
            if (tickFinished > scheduledAt + tickIntervalMs) hostTickOverruns++;
            const nextEmulatedFrameDeadline = started
                + ((emulatedFrames + 1) * data.durationSeconds * 1000) / targetFrames;
            if (framesDue > 0 && tickFinished > nextEmulatedFrameDeadline) {
                emulationBacklogEvents++;
            }
            const elapsedMs = tickFinished - started;
            if (elapsedMs >= nextMemorySampleMs || tick === totalTicks) {
                const bytes = module.HEAPU8.buffer.byteLength;
                wasmMemoryTrace.push({ elapsedMs, bytes });
                peakWasmMemoryBytes = Math.max(peakWasmMemoryBytes, bytes);
                while (nextMemorySampleMs <= elapsedMs) nextMemorySampleMs += 1000;
            }

            const progressIntervalTicks = Math.max(1, Math.round(data.hostCadenceHz * 10));
            if (tick % progressIntervalTicks === 0 || tick === totalTicks) {
                self.postMessage({
                    type: "progress",
                    elapsedSeconds: Math.round(elapsedMs / 1000),
                    region: data.region,
                    hostCadenceHz: data.hostCadenceHz,
                    repeat: data.repeat,
                });
            }
        }

        const elapsedMs = performance.now() - started;
        const videoFrames = (module._psx_probe_video_frames() >>> 0) - initialVideoFrames;
        const nullVideoFrames = (module._psx_probe_null_video_frames() >>> 0) - initialNullVideoFrames;
        const audioFrames = (module._psx_probe_audio_frames() >>> 0) - initialAudioFrames;
        const missingVideoCallbacks = Math.max(0, emulatedFrames - videoFrames - nullVideoFrames);
        const finalWasmMemoryBytes = module.HEAPU8.buffer.byteLength;
        const keptRealtime = elapsedMs <= data.durationSeconds * 1000 + 1000
            && totalCoreRunMs <= data.durationSeconds * 1000;
        const result = {
            booted,
            region: data.region,
            hostCadenceHz: data.hostCadenceHz,
            repeat: data.repeat,
            durationSeconds: data.durationSeconds,
            warmupFrames,
            warmupMs,
            elapsedMs,
            keptRealtime,
            timerTicks: totalTicks,
            framesPerSecond,
            targetFrames,
            emulatedFrames,
            videoFrames,
            nullVideoFrames,
            missingVideoCallbacks,
            videoHash: module._psx_probe_video_hash() >>> 0,
            sampleRate,
            targetAudioFrames,
            audioFrames,
            audioDriftFrames: audioFrames - targetAudioFrames,
            audioHash: module._psx_probe_audio_hash() >>> 0,
            audioPeak: module._psx_probe_audio_peak() >>> 0,
            audioPrimingFrames,
            simulatedAudioUnderrunFrames,
            finalSimulatedAudioQueueFrames: simulatedAudioQueueFrames,
            lateTicks,
            hostTickOverruns,
            emulationBacklogEvents,
            maxTickLatenessMs,
            maxCoreRunMs,
            totalCoreRunMs,
            coreUtilization: totalCoreRunMs / (data.durationSeconds * 1000),
            wasmMemory: {
                initialBytes: initialWasmMemoryBytes,
                peakBytes: peakWasmMemoryBytes,
                finalBytes: finalWasmMemoryBytes,
                configuredMaximumBytes: configuredMaximumWasmMemoryBytes,
                trace: wasmMemoryTrace,
            },
        };
        result.ok = booted
            && videoFrames === targetFrames
            && nullVideoFrames === 0
            && missingVideoCallbacks === 0
            && audioFrames > 0
            && result.audioPeak > 0
            && simulatedAudioUnderrunFrames === 0
            && keptRealtime
            && finalWasmMemoryBytes <= configuredMaximumWasmMemoryBytes;

        self.postMessage({ type: "result", result });
        self.onmessage = ({ data: shutdownMessage }) => {
            if (shutdownMessage?.type !== "shutdown") return;
            module._psx_probe_shutdown();
            module.FS.unmount("/content");
            self.postMessage({ type: "shutdown-complete" });
        };
    } catch (error) {
        self.postMessage({
            type: "error",
            message: error instanceof Error ? error.stack ?? error.message : String(error),
        });
    }
};
