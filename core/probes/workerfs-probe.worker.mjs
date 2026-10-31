import createModule from "../../dist/probes/workerfs-module.mjs";

let modulePromise;

const moduleInstance = () => {
    modulePromise ??= createModule();
    return modulePromise;
};

self.onmessage = async ({ data }) => {
    try {
        const module = await moduleInstance();
        module.FS.mkdir("/content");
        module.FS.mount(module.WORKERFS, {
            blobs: [{ name: "track.bin", data: data.blob }],
        }, "/content");

        const started = performance.now();
        const size = module._psx_workerfs_size();
        const checksums = data.reads.map(({ offset, length }) =>
            module._psx_workerfs_checksum(offset, length) >>> 0);
        const elapsedMs = performance.now() - started;

        module.FS.unmount("/content");
        self.postMessage({ ok: true, size, checksums, elapsedMs });
    } catch (error) {
        self.postMessage({
            ok: false,
            message: error instanceof Error ? error.message : String(error),
        });
    }
};
