import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { chromium } from "playwright";

const probe = process.argv[2];
const enduranceSeconds = process.env.PROBE_SECONDS ?? "60";
const enduranceRepeats = process.env.PROBE_REPEATS ?? "2";
if (!/^[1-9]\d*$/u.test(enduranceSeconds) || !/^[1-9]\d*$/u.test(enduranceRepeats)) {
    throw new Error("PROBE_SECONDS and PROBE_REPEATS must be positive integers");
}
const probes = {
    workerfs: "/core/probes/workerfs-probe.html",
    pcsx: "/core/probes/pcsx-boot-probe.html?core=pcsx",
    beetle: "/core/probes/pcsx-boot-probe.html?core=beetle",
    endurance: `/core/probes/pcsx-endurance-probe.html?seconds=${enduranceSeconds}&repeats=${enduranceRepeats}`,
};

if (probe === undefined || !(probe in probes)) {
    console.error("Usage: node core/probes/run-browser-probe.mjs <workerfs|pcsx|beetle|endurance>");
    process.exit(2);
}

const root = resolve(import.meta.dirname, "../..");

const readProcessTreeRss = async (rootPid) => {
    const visited = new Set();
    const walk = async (pid) => {
        if (visited.has(pid)) return 0;
        visited.add(pid);
        try {
            const [status, children] = await Promise.all([
                readFile(`/proc/${pid}/status`, "utf8"),
                readFile(`/proc/${pid}/task/${pid}/children`, "utf8"),
            ]);
            const residentKiB = Number(/^VmRSS:\s+(\d+)\s+kB$/mu.exec(status)?.[1] ?? 0);
            const childPids = children.trim().length === 0
                ? []
                : children.trim().split(/\s+/u).map(Number);
            const childBytes = await Promise.all(childPids.map(walk));
            return residentKiB * 1024 + childBytes.reduce((sum, bytes) => sum + bytes, 0);
        } catch {
            return 0;
        }
    };
    const bytes = await walk(rootPid);
    return { bytes, processCount: visited.size };
};

const routes = new Map([
    ["/core/probes/workerfs-probe.html", ["core/probes/workerfs-probe.html", "text/html; charset=utf-8"]],
    ["/core/probes/workerfs-probe.worker.mjs", ["core/probes/workerfs-probe.worker.mjs", "text/javascript; charset=utf-8"]],
    ["/core/probes/pcsx-boot-probe.html", ["core/probes/pcsx-boot-probe.html", "text/html; charset=utf-8"]],
    ["/core/probes/pcsx-boot-probe.worker.mjs", ["core/probes/pcsx-boot-probe.worker.mjs", "text/javascript; charset=utf-8"]],
    ["/core/probes/pcsx-endurance-probe.html", ["core/probes/pcsx-endurance-probe.html", "text/html; charset=utf-8"]],
    ["/core/probes/pcsx-endurance-probe.worker.mjs", ["core/probes/pcsx-endurance-probe.worker.mjs", "text/javascript; charset=utf-8"]],
    ["/dist/probes/workerfs-module.mjs", ["dist/probes/workerfs-module.mjs", "text/javascript; charset=utf-8"]],
    ["/dist/probes/workerfs-module.wasm", ["dist/probes/workerfs-module.wasm", "application/wasm"]],
    ["/dist/probes/pcsx-boot.mjs", ["dist/probes/pcsx-boot.mjs", "text/javascript; charset=utf-8"]],
    ["/dist/probes/pcsx-boot.wasm", ["dist/probes/pcsx-boot.wasm", "application/wasm"]],
    ["/dist/probes/beetle-boot.mjs", ["dist/probes/beetle-boot.mjs", "text/javascript; charset=utf-8"]],
    ["/dist/probes/beetle-boot.wasm", ["dist/probes/beetle-boot.wasm", "application/wasm"]],
    ["/fixtures/generated/m0/m0-fixture.cue", ["fixtures/generated/m0/m0-fixture.cue", "application/octet-stream"]],
    ["/fixtures/generated/m0/m0-fixture.bin", ["fixtures/generated/m0/m0-fixture.bin", "application/octet-stream"]],
    ["/fixtures/generated/m0/pal/m0-fixture.cue", ["fixtures/generated/m0/pal/m0-fixture.cue", "application/octet-stream"]],
    ["/fixtures/generated/m0/pal/m0-fixture.bin", ["fixtures/generated/m0/pal/m0-fixture.bin", "application/octet-stream"]],
]);

let resolveResult;
let rejectResult;
const resultPromise = new Promise((resolvePromise, rejectPromise) => {
    resolveResult = resolvePromise;
    rejectResult = rejectPromise;
});

const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/wait") {
        response.writeHead(204);
        response.end();
        return;
    }
    if (url.pathname === "/result" && request.method === "POST") {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
            try {
                resolveResult(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                response.writeHead(204);
                response.end();
            } catch (error) {
                rejectResult(error);
                response.writeHead(400);
                response.end();
            }
        });
        return;
    }
    if (url.pathname === "/progress" && request.method === "POST") {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
            console.error(`progress ${Buffer.concat(chunks).toString("utf8")}`);
            response.writeHead(204);
            response.end();
        });
        return;
    }

    const route = routes.get(url.pathname);
    if (route === undefined) {
        response.writeHead(404);
        response.end();
        return;
    }
    response.writeHead(200, { "content-type": route[1], "cache-control": "no-store" });
    createReadStream(resolve(root, route[0])).pipe(response);
});

await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
});

const address = server.address();
if (address === null || typeof address === "string") throw new Error("Probe server has no TCP address");

const browserServer = await chromium.launchServer({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--enable-precise-memory-info"],
});
const browser = await chromium.connect(browserServer.wsEndpoint());
const browserPid = browserServer.process().pid;
const memoryStarted = performance.now();
const browserProcessMemoryTrace = [];
let memorySampling = Promise.resolve();
const sampleBrowserProcessMemory = () => {
    memorySampling = memorySampling.then(async () => {
        const sample = await readProcessTreeRss(browserPid);
        browserProcessMemoryTrace.push({
            elapsedMs: performance.now() - memoryStarted,
            ...sample,
        });
    });
    return memorySampling;
};
await sampleBrowserProcessMemory();
const memoryTimer = probe === "endurance"
    ? setInterval(() => void sampleBrowserProcessMemory(), 1000)
    : undefined;
let resultTimeout;

try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}${probes[probe]}`, {
        waitUntil: "domcontentloaded",
    });
    const timeoutPromise = new Promise((_, rejectPromise) => {
        resultTimeout = setTimeout(
            () => rejectPromise(new Error(`Timed out waiting for ${probe} probe`)),
            probe === "endurance" ? 15 * 60_000 : 120_000,
        );
    });
    const result = await Promise.race([resultPromise, timeoutPromise]);
    clearTimeout(resultTimeout);
    await sampleBrowserProcessMemory();
    const browserMemoryBytes = browserProcessMemoryTrace.map((sample) => sample.bytes);
    const output = probe === "endurance"
        ? {
            ...result,
            browserProcessMemory: {
                method: "linux-process-tree-vmrss",
                initialBytes: browserMemoryBytes[0],
                peakBytes: Math.max(...browserMemoryBytes),
                finalBytes: browserMemoryBytes.at(-1),
                trace: browserProcessMemoryTrace,
            },
        }
        : result;
    console.log(JSON.stringify(output));
    if (result.ok !== true) process.exitCode = 1;
} finally {
    clearTimeout(resultTimeout);
    clearInterval(memoryTimer);
    await browser.close();
    await browserServer.close();
    server.closeAllConnections();
    await new Promise((resolvePromise) => server.close(resolvePromise));
}
