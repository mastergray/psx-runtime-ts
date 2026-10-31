import EmscriptenPsxCore from "./CoreBridge.js";
import WorkerEndpoint from "./WorkerEndpoint.js";
import WorkerRuntime from "./WorkerRuntime.js";

import type { EmscriptenPsxFactory } from "./CoreBridge.js";

const loadModule = async (url: string): Promise<EmscriptenPsxFactory> => {
    const loaded = await import(url) as { default?: unknown };
    if (typeof loaded.default !== "function") throw new Error("The core module has no default factory export.");
    return loaded.default as EmscriptenPsxFactory;
};

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
const endpoint = new WorkerEndpoint(
    new WorkerRuntime(new EmscriptenPsxCore(loadModule)),
    { postMessage: (message, transfer) => scope.postMessage(message, transfer) },
);

scope.addEventListener("message", (event: MessageEvent<unknown>) => {
    void endpoint.receive(event.data);
});
