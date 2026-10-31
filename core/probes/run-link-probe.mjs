import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.argv[2];
if (modulePath === undefined) {
    console.error("Usage: node core/probes/run-link-probe.mjs <module.mjs>");
    process.exitCode = 2;
} else {
    const moduleUrl = pathToFileURL(resolve(modulePath));
    const createModule = (await import(moduleUrl.href)).default;
    const instance = await createModule({
        locateFile: (file) => new URL(file, moduleUrl).pathname,
    });

    const stringAt = (pointer) => pointer === 0 ? null : instance.UTF8ToString(pointer);
    const initialized = instance._psx_probe_init();
    const result = {
        initialized: initialized === 1,
        name: stringAt(instance._psx_probe_name()),
        version: stringAt(instance._psx_probe_version()),
        extensions: stringAt(instance._psx_probe_extensions()),
        needsFullpath: instance._psx_probe_needs_fullpath() === 1,
        environmentCalls: instance._psx_probe_environment_calls(),
    };
    instance._psx_probe_deinit();

    console.log(JSON.stringify(result));
    if (!result.initialized) process.exitCode = 1;
}
