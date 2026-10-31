const modulePath = "../../dist/probes/pcsx-boot.mjs";
const configuredMaximumWasmMemoryBytes = 512 * 1024 * 1024;
const readBytes = 4096;

const checksum = (bytes) => {
    let hash = 2166136261;
    for (const value of bytes) {
        hash ^= value;
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash;
};

const readAt = (module, stream, offset) => {
    const bytes = new Uint8Array(readBytes);
    module.FS.llseek(stream, offset, 0);
    const count = module.FS.read(stream, bytes, 0, bytes.length);
    return { offset, count, checksum: checksum(bytes.subarray(0, count)) };
};

self.onmessage = async ({ data }) => {
    try {
        const createModule = (await import(modulePath)).default;
        const module = await createModule();
        const wasmMemoryTrace = [{ stage: "module-created", bytes: module.HEAPU8.buffer.byteLength }];
        self.postMessage({ type: "stage", stage: "module-created" });

        module.FS.mkdir("/content");
        module.FS.mkdir("/system");
        module.FS.mkdir("/save");
        module.FS.mount(module.WORKERFS, {
            blobs: [
                { name: "m0-fixture.cue", data: data.cue },
                { name: "m0-fixture.bin", data: data.bin },
            ],
        }, "/content");
        const mountedBytes = module.FS.stat("/content/m0-fixture.bin").size;
        wasmMemoryTrace.push({ stage: "mounted", bytes: module.HEAPU8.buffer.byteLength });
        self.postMessage({ type: "stage", stage: "mounted" });

        const stream = module.FS.open("/content/m0-fixture.bin", "r");
        const reads = [
            readAt(module, stream, 0),
            readAt(module, stream, Math.floor(data.logicalDiscBytes / 2)),
            readAt(module, stream, data.logicalDiscBytes - readBytes),
        ];
        module.FS.close(stream);
        wasmMemoryTrace.push({ stage: "random-reads", bytes: module.HEAPU8.buffer.byteLength });
        self.postMessage({ type: "stage", stage: "random-reads" });

        const bootStarted = performance.now();
        const booted = module._psx_probe_boot() === 1;
        const bootMs = performance.now() - bootStarted;
        if (!booted) throw new Error("PCSX-ReARMed rejected the near-maximum disc fixture");
        module._psx_probe_run(120, 0);
        wasmMemoryTrace.push({ stage: "booted", bytes: module.HEAPU8.buffer.byteLength });
        self.postMessage({ type: "stage", stage: "booted" });

        const wasmMemoryBytes = wasmMemoryTrace.map((sample) => sample.bytes);
        const zeroChecksum = checksum(new Uint8Array(readBytes));
        const result = {
            logicalDiscBytes: data.logicalDiscBytes,
            sectorBytes: data.sectorBytes,
            sectorCount: data.sectorCount,
            mountedBytes,
            booted,
            bootMs,
            videoFrames: module._psx_probe_video_frames() >>> 0,
            audioFrames: module._psx_probe_audio_frames() >>> 0,
            reads,
            zeroChecksum,
            wasmMemory: {
                initialBytes: wasmMemoryBytes[0],
                peakBytes: Math.max(...wasmMemoryBytes),
                finalBytes: wasmMemoryBytes.at(-1),
                configuredMaximumBytes: configuredMaximumWasmMemoryBytes,
                trace: wasmMemoryTrace,
            },
        };
        result.ok = mountedBytes === data.logicalDiscBytes
            && booted
            && result.videoFrames >= 120
            && reads.every((read) => read.count === readBytes)
            && reads[1].checksum === zeroChecksum
            && reads[2].checksum === zeroChecksum
            && result.wasmMemory.peakBytes < data.logicalDiscBytes / 2
            && result.wasmMemory.peakBytes <= configuredMaximumWasmMemoryBytes;

        module._psx_probe_shutdown();
        module.FS.unmount("/content");
        self.postMessage({ type: "result", result });
    } catch (error) {
        self.postMessage({
            type: "error",
            message: error instanceof Error ? error.stack ?? error.message : String(error),
        });
    }
};
