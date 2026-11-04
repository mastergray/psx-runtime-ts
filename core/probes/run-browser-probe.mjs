import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
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
    geometry: "/core/probes/pcsx-geometry-probe.html",
    media: "/core/probes/pcsx-media-probe.html",
    cards: "/core/probes/pcsx-cards-probe.html",
    stateDisc: "/core/probes/pcsx-state-disc-probe.html",
    memory: "/core/probes/pcsx-memory-probe.html",
    bios: "/core/probes/pcsx-bios-probe.html",
    m4: "/core/probes/m4-adapter-probe.html",
    m6: "/core/probes/m6-browser-probe.html",
    m7: "/core/probes/m7-storage-probe.html",
    m8: "/harness/index.html",
    m9: "/core/probes/m9-game-store-probe.html",
    m10: "/core/probes/m10-release-probe.html",
    m11: "/core/probes/m11-touch-probe.html",
    m12: "/ui/index.html",
};

if (probe === undefined || !(probe in probes)) {
    console.error("Usage: node core/probes/run-browser-probe.mjs <workerfs|pcsx|beetle|endurance|geometry|media|cards|stateDisc|memory|bios|m4|m6|m7|m8|m9|m10|m11|m12>");
    process.exit(2);
}

const root = resolve(import.meta.dirname, "../..");
let privateBiosPath;
if (probe === "bios" || probe === "m4" || probe === "m10") {
    if (process.env.PSX_BIOS_PATH === undefined || process.env.PSX_BIOS_PATH.length === 0) {
        console.error("P3 requires PSX_BIOS_PATH to identify the private BIOS input");
        process.exit(3);
    }
    privateBiosPath = resolve(process.env.PSX_BIOS_PATH);
    let biosStat;
    try {
        biosStat = await stat(privateBiosPath);
    } catch {
        console.error("PSX_BIOS_PATH does not identify a readable file");
        process.exit(3);
    }
    if (!biosStat.isFile()) {
        console.error("PSX_BIOS_PATH does not identify a readable file");
        process.exit(3);
    }
}

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
    ["/core/probes/pcsx-geometry-probe.html", ["core/probes/pcsx-geometry-probe.html", "text/html; charset=utf-8"]],
    ["/core/probes/pcsx-geometry-probe.worker.mjs", ["core/probes/pcsx-geometry-probe.worker.mjs", "text/javascript; charset=utf-8"]],
    ["/core/probes/pcsx-media-probe.html", ["core/probes/pcsx-media-probe.html", "text/html; charset=utf-8"]],
    ["/core/probes/pcsx-media-probe.worker.mjs", ["core/probes/pcsx-media-probe.worker.mjs", "text/javascript; charset=utf-8"]],
    ["/core/probes/pcsx-cards-probe.html", ["core/probes/pcsx-cards-probe.html", "text/html; charset=utf-8"]],
    ["/core/probes/pcsx-cards-probe.worker.mjs", ["core/probes/pcsx-cards-probe.worker.mjs", "text/javascript; charset=utf-8"]],
    ["/core/probes/pcsx-state-disc-probe.html", ["core/probes/pcsx-state-disc-probe.html", "text/html; charset=utf-8"]],
    ["/core/probes/pcsx-state-disc-probe.worker.mjs", ["core/probes/pcsx-state-disc-probe.worker.mjs", "text/javascript; charset=utf-8"]],
    ["/core/probes/pcsx-memory-probe.html", ["core/probes/pcsx-memory-probe.html", "text/html; charset=utf-8"]],
    ["/core/probes/pcsx-memory-probe.worker.mjs", ["core/probes/pcsx-memory-probe.worker.mjs", "text/javascript; charset=utf-8"]],
    ["/core/probes/pcsx-bios-probe.html", ["core/probes/pcsx-bios-probe.html", "text/html; charset=utf-8"]],
    ["/core/probes/pcsx-bios-probe.worker.mjs", ["core/probes/pcsx-bios-probe.worker.mjs", "text/javascript; charset=utf-8"]],
    ["/core/probes/m4-adapter-probe.html", ["core/probes/m4-adapter-probe.html", "text/html; charset=utf-8"]],
    ["/core/probes/m6-browser-probe.html", ["core/probes/m6-browser-probe.html", "text/html; charset=utf-8"]],
    ["/core/probes/m7-storage-probe.html", ["core/probes/m7-storage-probe.html", "text/html; charset=utf-8"]],
    ["/core/probes/m9-game-store-probe.html", ["core/probes/m9-game-store-probe.html", "text/html; charset=utf-8"]],
    ["/core/probes/m10-release-probe.html", ["core/probes/m10-release-probe.html", "text/html; charset=utf-8"]],
    ["/core/probes/m11-touch-probe.html", ["core/probes/m11-touch-probe.html", "text/html; charset=utf-8"]],
    ["/ui/index.html", ["ui/index.html", "text/html; charset=utf-8"]],
    ["/ui/styles.css", ["ui/styles.css", "text/css; charset=utf-8"]],
    ["/vendor/fflate.js", ["node_modules/fflate/esm/browser.js", "text/javascript; charset=utf-8"]],
    ["/node_modules/fflate/esm/browser.js", ["node_modules/fflate/esm/browser.js", "text/javascript; charset=utf-8"]],
    ["/harness/index.html", ["harness/index.html", "text/html; charset=utf-8"]],
    ["/dist/probes/workerfs-module.mjs", ["dist/probes/workerfs-module.mjs", "text/javascript; charset=utf-8"]],
    ["/dist/probes/workerfs-module.wasm", ["dist/probes/workerfs-module.wasm", "application/wasm"]],
    ["/dist/probes/pcsx-boot.mjs", ["dist/probes/pcsx-boot.mjs", "text/javascript; charset=utf-8"]],
    ["/dist/probes/pcsx-boot.wasm", ["dist/probes/pcsx-boot.wasm", "application/wasm"]],
    ["/dist/probes/beetle-boot.mjs", ["dist/probes/beetle-boot.mjs", "text/javascript; charset=utf-8"]],
    ["/dist/probes/beetle-boot.wasm", ["dist/probes/beetle-boot.wasm", "application/wasm"]],
    ["/tests/fixtures/generated/m0/m0-fixture.cue", ["tests/fixtures/generated/m0/m0-fixture.cue", "application/octet-stream"]],
    ["/tests/fixtures/generated/m0/m0-fixture.bin", ["tests/fixtures/generated/m0/m0-fixture.bin", "application/octet-stream"]],
    ["/tests/fixtures/generated/m0/pal/m0-fixture.cue", ["tests/fixtures/generated/m0/pal/m0-fixture.cue", "application/octet-stream"]],
    ["/tests/fixtures/generated/m0/pal/m0-fixture.bin", ["tests/fixtures/generated/m0/pal/m0-fixture.bin", "application/octet-stream"]],
    ["/tests/fixtures/generated/m0/geometry/m0-fixture.cue", ["tests/fixtures/generated/m0/geometry/m0-fixture.cue", "application/octet-stream"]],
    ["/tests/fixtures/generated/m0/geometry/m0-fixture.bin", ["tests/fixtures/generated/m0/geometry/m0-fixture.bin", "application/octet-stream"]],
    ["/tests/fixtures/generated/m0/media/m0-fixture.cue", ["tests/fixtures/generated/m0/media/m0-fixture.cue", "application/octet-stream"]],
    ["/tests/fixtures/generated/m0/media/m0-fixture.bin", ["tests/fixtures/generated/m0/media/m0-fixture.bin", "application/octet-stream"]],
    ["/tests/fixtures/generated/m0/cards/m0-fixture.cue", ["tests/fixtures/generated/m0/cards/m0-fixture.cue", "application/octet-stream"]],
    ["/tests/fixtures/generated/m0/cards/m0-fixture.bin", ["tests/fixtures/generated/m0/cards/m0-fixture.bin", "application/octet-stream"]],
    ["/tests/fixtures/generated/m0/multidisc/disc1/m0-fixture.cue", ["tests/fixtures/generated/m0/multidisc/disc1/m0-fixture.cue", "application/octet-stream"]],
    ["/tests/fixtures/generated/m0/multidisc/disc1/m0-fixture.bin", ["tests/fixtures/generated/m0/multidisc/disc1/m0-fixture.bin", "application/octet-stream"]],
    ["/tests/fixtures/generated/m0/multidisc/disc2/m0-fixture.cue", ["tests/fixtures/generated/m0/multidisc/disc2/m0-fixture.cue", "application/octet-stream"]],
    ["/tests/fixtures/generated/m0/multidisc/disc2/m0-fixture.bin", ["tests/fixtures/generated/m0/multidisc/disc2/m0-fixture.bin", "application/octet-stream"]],
    ["/tests/fixtures/generated/m0/psx-runtime-diagnostics.zip", ["tests/fixtures/generated/m0/psx-runtime-diagnostics.zip", "application/zip"]],
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
    if (url.pathname === "/private/bios"
        && (probe === "bios" || probe === "m4" || probe === "m10")
        && privateBiosPath !== undefined) {
        response.writeHead(200, {
            "content-type": "application/octet-stream",
            "cache-control": "no-store",
        });
        const stream = createReadStream(privateBiosPath);
        stream.on("error", () => {
            if (!response.headersSent) response.writeHead(500);
            response.end();
        });
        stream.pipe(response);
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
        request.on("end", async () => {
            console.error(`progress ${Buffer.concat(chunks).toString("utf8")}`);
            if (probe === "memory") await sampleBrowserProcessMemory();
            response.writeHead(204);
            response.end();
        });
        return;
    }

    let route = routes.get(url.pathname);
    if (route === undefined && url.pathname.startsWith("/dist/") && !url.pathname.includes("..")) {
        const type = url.pathname.endsWith(".wasm")
            ? "application/wasm"
            : "text/javascript; charset=utf-8";
        route = [url.pathname.slice(1), type];
    }
    if (route === undefined && url.pathname.startsWith("/harness-build/") && !url.pathname.includes("..")) {
        route = [`dist${url.pathname}`, "text/javascript; charset=utf-8"];
    }
    if (route === undefined && url.pathname.startsWith("/ui-build/") && !url.pathname.includes("..")) {
        route = [`dist${url.pathname}`, "text/javascript; charset=utf-8"];
    }
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
const memoryTimer = probe === "endurance" || probe === "memory"
    ? setInterval(() => void sampleBrowserProcessMemory(), 1000)
    : undefined;
let resultTimeout;

try {
    const page = await browser.newPage(probe === "m11"
        ? { viewport: { width: 900, height: 900 }, hasTouch: true, isMobile: true }
        : undefined);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    if (probe === "m8") {
        await page.addInitScript(() => {
            const state = { pressed: false };
            const button = {
                get pressed() { return state.pressed; },
                get touched() { return state.pressed; },
                get value() { return state.pressed ? 1 : 0; },
            };
            const pad = {
                index: 3,
                id: "M8 Test Gamepad",
                connected: true,
                mapping: "standard",
                timestamp: 1,
                buttons: [button],
                axes: [0, 0, 0, 0],
            };
            Object.defineProperty(navigator, "getGamepads", {
                configurable: true,
                value: () => [null, null, null, pad],
            });
            globalThis.__m8GamepadState = state;
        });
    }
    await page.goto(`http://127.0.0.1:${address.port}${probes[probe]}`, {
        waitUntil: "domcontentloaded",
    });
    if (probe === "m6") await page.click("#unlock");
    if (probe === "m8") {
        await page.waitForFunction(() => document.querySelector("#screen") !== null
            && document.querySelectorAll("button").length >= 10);
        const gameDrop = await page.evaluate(async () => {
            const zone = document.querySelector("#game-drop-zone");
            if (!(zone instanceof HTMLElement)) throw new Error("Missing game ZIP drop zone");
            const { strToU8, zipSync } = await import("fflate");
            const transfer = new DataTransfer();
            transfer.items.add(new File([zipSync({
                "game.cue": strToU8("FILE \"game.bin\" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:00:00\n"),
                "game.bin": new Uint8Array(2352),
            })], "Dragged Game.zip", {
                type: "application/zip",
            }));
            const dragover = new DragEvent("dragover", {
                bubbles: true,
                cancelable: true,
                dataTransfer: transfer,
            });
            const accepted = !zone.dispatchEvent(dragover) && dragover.defaultPrevented;
            const highlighted = zone.dataset.dragging;
            zone.dispatchEvent(new DragEvent("drop", {
                bubbles: true,
                cancelable: true,
                dataTransfer: transfer,
            }));
            while (document.querySelector("#game-feedback")?.textContent !== "Game ZIP selected. Ready to check and store.") {
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
            return {
                accepted,
                highlighted,
                dialog: zone.closest("dialog")?.id,
                state: zone.dataset.state,
                dragging: zone.dataset.dragging,
                selection: document.querySelector("#game-selection")?.textContent,
                feedback: document.querySelector("#game-feedback")?.textContent,
                titleRemoved: document.querySelector("#game-id") === null,
                overrideRemoved: document.querySelector("#entry") === null,
                conditionalEntryHidden: document.querySelector("#entry-choice")?.hasAttribute("hidden"),
            };
        });
        await page.evaluate(() => document.querySelector("#clear-game-selection")?.click());
        await page.waitForFunction(() => document.querySelector("#game-selection")?.textContent === "No game ZIPs selected.");
        const ambiguousEntry = await page.evaluate(async () => {
            const zone = document.querySelector("#game-drop-zone");
            if (!(zone instanceof HTMLElement)) throw new Error("Missing game ZIP drop zone");
            const { strToU8, zipSync } = await import("fflate");
            const cue = (track) => strToU8(`FILE "${track}" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:00:00\n`);
            const transfer = new DataTransfer();
            transfer.items.add(new File([zipSync({
                "disc-a.cue": cue("disc-a.bin"),
                "disc-a.bin": new Uint8Array(2352),
                "disc-b.cue": cue("disc-b.bin"),
                "disc-b.bin": new Uint8Array(2352),
            })], "Ambiguous.zip", { type: "application/zip" }));
            zone.dispatchEvent(new DragEvent("drop", {
                bubbles: true,
                cancelable: true,
                dataTransfer: transfer,
            }));
            while (document.querySelector("#game-feedback")?.textContent
                !== "This ZIP has multiple possible entries. Choose one, then run Check And Store.") {
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
            return {
                visible: document.querySelector("#entry-choice")?.hasAttribute("hidden") === false,
                entries: [...document.querySelectorAll("#entry-select option")].map((option) => option.textContent),
                feedback: document.querySelector("#game-feedback")?.textContent,
            };
        });
        await page.evaluate(() => document.querySelector("#clear-game-selection")?.click());
        await page.waitForFunction(() => document.querySelector("#game-selection")?.textContent === "No game ZIPs selected.");
        const multiZip = await page.evaluate(async () => {
            const zone = document.querySelector("#game-drop-zone");
            if (!(zone instanceof HTMLElement)) throw new Error("Missing game ZIP drop zone");
            const { strToU8, zipSync } = await import("fflate");
            const cue = (track) => strToU8(`FILE "${track}" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:00:00\n`);
            const transfer = new DataTransfer();
            transfer.items.add(new File([zipSync({
                "first.cue": cue("first.bin"), "first.bin": new Uint8Array(2352),
            })], "First.zip", { type: "application/zip" }));
            transfer.items.add(new File([zipSync({
                "second.cue": cue("second.bin"), "second.bin": new Uint8Array(2352),
            })], "Second.zip", { type: "application/zip" }));
            zone.dispatchEvent(new DragEvent("drop", {
                bubbles: true,
                cancelable: true,
                dataTransfer: transfer,
            }));
            while (document.querySelector("#game-feedback")?.textContent
                !== "2 single-disc ZIPs are ordered and ready to check and store.") {
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
            const before = {
                selection: document.querySelector("#game-selection")?.textContent,
                rows: [...document.querySelectorAll("#game-archive-list .archive-name")]
                    .map((row) => row.textContent),
                manifest: document.querySelector("#m3u-preview")?.textContent,
                description: document.querySelector("#m3u-description")?.textContent,
                manifestVisible: document.querySelector("#m3u-panel")?.hasAttribute("hidden") === false,
            };
            document.querySelector("#game-archive-list .archive-row:first-child .archive-actions button:nth-child(2)")?.click();
            while (!document.querySelector("#m3u-preview")?.textContent?.startsWith("disc-1/second.cue")) {
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
            return {
                before,
                after: {
                    rows: [...document.querySelectorAll("#game-archive-list .archive-name")]
                        .map((row) => row.textContent),
                    manifest: document.querySelector("#m3u-preview")?.textContent,
                },
            };
        });
        await page.click("[data-open-dialog='controllers-dialog']");
        await page.waitForFunction(() => document.querySelector("#pad-label-1")?.textContent === "M8 Test Gamepad"
            && document.querySelector("#pad-label-2")?.textContent === "not connected");
        const automaticallyAssigned = await page.evaluate(() => ({
            playerOnePad: document.querySelector("#pad-label-1")?.textContent,
            playerTwoPad: document.querySelector("#pad-label-2")?.textContent,
        }));
        await page.click("#player-tab-2");
        const tabSelected = await page.getAttribute("#player-tab-2", "aria-selected");
        const playerOneHidden = await page.getAttribute("#player-panel-1", "hidden");
        const playerTwoHidden = await page.getAttribute("#player-panel-2", "hidden");
        await page.click("#left-stick-dpad-2");
        await page.click("#change-2-up");
        const keyboardListening = await page.textContent("#change-2-up");
        await page.keyboard.press("KeyG");
        await page.waitForFunction(() => document.querySelector("#keyboard-2-up")?.textContent === "G");
        await page.click("#change-2-circle");
        const gamepadListening = await page.textContent("#change-2-circle");
        await page.evaluate(() => { globalThis.__m8GamepadState.pressed = true; });
        await page.waitForFunction(() => document.querySelector("#pad-label-2")?.textContent === "M8 Test Gamepad"
            && document.querySelector("#pad-label-1")?.textContent === "not connected"
            && document.querySelector("#gamepad-2-circle")?.textContent === "A"
            && document.querySelector("#gamepad-2-cross")?.textContent === "unbound");
        const captured = await page.evaluate(() => ({
            playerOnePad: document.querySelector("#pad-label-1")?.textContent,
            playerTwoPad: document.querySelector("#pad-label-2")?.textContent,
            playerTwoUpKey: document.querySelector("#keyboard-2-up")?.textContent,
            playerTwoCircleButton: document.querySelector("#gamepad-2-circle")?.textContent,
            playerTwoCrossButton: document.querySelector("#gamepad-2-cross")?.textContent,
            playerTwoStickDpad: document.querySelector("#left-stick-dpad-2")?.checked,
            stored: localStorage.getItem("psx-runtime:ui:controls") !== null,
        }));
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => document.querySelector("#keyboard-2-up")?.textContent === "G"
            && document.querySelector("#pad-label-2")?.textContent === "M8 Test Gamepad"
            && document.querySelector("#pad-label-1")?.textContent === "not connected"
            && document.querySelector("#gamepad-2-circle")?.textContent === "A"
            && document.querySelector("#gamepad-2-cross")?.textContent === "unbound"
            && document.querySelector("#left-stick-dpad-2")?.checked === true);
        await page.click("[data-open-dialog='controllers-dialog']");
        const persisted = await page.evaluate(() => ({
            playerOnePad: document.querySelector("#pad-label-1")?.textContent,
            playerTwoPad: document.querySelector("#pad-label-2")?.textContent,
            playerTwoUpKey: document.querySelector("#keyboard-2-up")?.textContent,
            playerTwoCircleButton: document.querySelector("#gamepad-2-circle")?.textContent,
            playerTwoCrossButton: document.querySelector("#gamepad-2-cross")?.textContent,
            playerTwoStickDpad: document.querySelector("#left-stick-dpad-2")?.checked,
            storageStatus: document.querySelector("#control-storage-status")?.textContent,
        }));
        await page.click("#restore-controls");
        await page.waitForFunction(() => document.querySelector("#keyboard-2-up")?.textContent === "I"
            && document.querySelector("#gamepad-1-cross")?.textContent === "A"
            && document.querySelector("#gamepad-1-circle")?.textContent === "B"
            && document.querySelector("#left-stick-dpad-2")?.checked === false
            && localStorage.getItem("psx-runtime:ui:controls") === null);
        const restored = await page.evaluate(() => ({
            playerTwoUpKey: document.querySelector("#keyboard-2-up")?.textContent,
            playerOneCrossButton: document.querySelector("#gamepad-1-cross")?.textContent,
            playerOneCircleButton: document.querySelector("#gamepad-1-circle")?.textContent,
            playerTwoStickDpad: document.querySelector("#left-stick-dpad-2")?.checked,
            stored: localStorage.getItem("psx-runtime:ui:controls") !== null,
        }));
        await page.evaluate(() => localStorage.setItem("psx-runtime:ui:controls", JSON.stringify({
            version: 1,
            keyboard: { "": { port: 1, button: "cross" } },
            gamepads: {},
        })));
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => document.querySelector("#control-storage-status")?.textContent
            === "The stored control profile is invalid and was ignored; default bindings are active.");
        const invalidIgnored = await page.evaluate(() => ({
            playerTwoUpKey: document.querySelector("#keyboard-2-up")?.textContent,
            storageStatus: document.querySelector("#control-storage-status")?.textContent,
        }));
        await page.click("[data-open-dialog='view-dialog']");
        await page.selectOption("#touch-controller-view", "show");
        await page.selectOption("#touch-controller-port", "2");
        await page.click("#touch-controller-swap");
        await page.waitForFunction(() => document.querySelector("#touch-controller")?.hasAttribute("hidden") === false
            && document.querySelector("#touch-controller")?.getAttribute("data-port") === "2"
            && document.querySelector("#touch-controller")?.getAttribute("data-swapped") === "true");
        const touchPreferences = await page.evaluate(() => ({
            stored: JSON.parse(localStorage.getItem("psx-runtime:ui:touch-controller") ?? "null"),
            visible: document.querySelector("#touch-controller")?.hasAttribute("hidden") === false,
            port: document.querySelector("#touch-controller")?.getAttribute("data-port"),
            swapped: document.querySelector("#touch-controller")?.getAttribute("data-swapped"),
            targetSizes: [...document.querySelectorAll("#touch-controller button")].map((button) => {
                const rect = button.getBoundingClientRect();
                return { width: rect.width, height: rect.height };
            }),
        }));
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => document.querySelector("#touch-controller")?.hasAttribute("hidden") === false
            && document.querySelector("#touch-controller-port")?.value === "2"
            && document.querySelector("#touch-controller-swap")?.checked === true);
        const persistedTouchPreferences = await page.evaluate(() => ({
            view: document.querySelector("#touch-controller-view")?.value,
            port: document.querySelector("#touch-controller-port")?.value,
            swap: document.querySelector("#touch-controller-swap")?.checked,
            rootPort: document.querySelector("#touch-controller")?.getAttribute("data-port"),
            rootSwapped: document.querySelector("#touch-controller")?.getAttribute("data-swapped"),
        }));
        const touchToggleBefore = await page.evaluate(() => ({
            label: document.querySelector("#touch-controller-toggle")?.textContent,
            pressed: document.querySelector("#touch-controller-toggle")?.getAttribute("aria-pressed"),
            topLevel: document.querySelector("#touch-controller-toggle")?.closest(".menu-actions") !== null,
        }));
        await page.click("#touch-controller-toggle");
        await page.waitForFunction(() => document.querySelector("#touch-controller")?.hasAttribute("hidden") === true
            && document.querySelector("#touch-controller-view")?.value === "hide");
        const touchToggleHidden = await page.evaluate(() => ({
            label: document.querySelector("#touch-controller-toggle")?.textContent,
            pressed: document.querySelector("#touch-controller-toggle")?.getAttribute("aria-pressed"),
            storedView: JSON.parse(localStorage.getItem("psx-runtime:ui:touch-controller") ?? "null")?.view,
        }));
        await page.click("#touch-controller-toggle");
        await page.waitForFunction(() => document.querySelector("#touch-controller")?.hasAttribute("hidden") === false
            && document.querySelector("#touch-controller-view")?.value === "show");
        const touchToggleShown = await page.evaluate(() => ({
            label: document.querySelector("#touch-controller-toggle")?.textContent,
            pressed: document.querySelector("#touch-controller-toggle")?.getAttribute("aria-pressed"),
            storedView: JSON.parse(localStorage.getItem("psx-runtime:ui:touch-controller") ?? "null")?.view,
        }));
        const harness = await page.evaluate(() => ({
            title: document.title,
            buttons: document.querySelectorAll("button").length,
            status: document.querySelector("#status")?.textContent,
            canvas: document.querySelector("#screen") instanceof HTMLCanvasElement,
            topLevelSessionControls: ["pause", "soft-reset", "mute-audio"].every((id) =>
                document.querySelector(`#${id}`)?.closest(".menu-actions") !== null),
            viewControls: document.querySelector("#view-menu")?.getAttribute("aria-controls") === "view-dialog"
                && document.querySelector("#fullscreen-fit")?.textContent === "Fullscreen (Fit)"
                && document.querySelector("#fullscreen-stretch")?.textContent === "Fullscreen (Stretch)"
                && document.querySelector("#touch-controller-view") !== null
                && document.querySelector("#touch-controller-port") !== null
                && document.querySelector("#touch-controller-swap") !== null,
            touchController: document.querySelector("#play-stage > #screen-stage") !== null
                && document.querySelector("#play-stage > #touch-controller") !== null
                && document.querySelectorAll("#touch-controller [data-touch-button]").length === 12
                && document.querySelectorAll("#touch-controller [data-touch-stick]").length === 2
                && document.querySelector("#touch-controller [data-touch-dpad]") !== null,
            deleteConfirmation: document.querySelector("#delete-stored") !== null
                && document.querySelector("#delete-game-dialog #confirm-delete-stored")?.textContent === "Remove game",
            stateManager: document.querySelector("#states-menu")?.getAttribute("aria-controls") === "states-dialog"
                && document.querySelector("#state-list") !== null
                && document.querySelector("#save-new-state")?.textContent === "Save new state"
                && document.querySelector("#states-dialog")?.textContent?.includes("Quick slots") === true
                && document.querySelector("#states-dialog")?.textContent?.includes("Controller save overwrites the assigned state") === true
                && document.querySelector("#state-confirm-dialog #confirm-state-action") !== null
                && document.querySelector("#notice-toast")?.getAttribute("popover") === "manual",
            pauseOverlay: document.querySelector("#pause-overlay")?.textContent === "Paused"
                && document.querySelector("#pause-overlay")?.hasAttribute("hidden") === true,
            runtimeShortcuts: document.querySelector("#speed-indicator")?.hasAttribute("hidden") === true
                && document.querySelector("#fast-forward-selection")?.textContent === "×2"
                && document.querySelector("#controllers-dialog")?.textContent?.includes("L3 + R2 (press)") === true
                && document.querySelector("#controllers-dialog")?.textContent?.includes("Quick State 2") === true,
            libraryStorage: document.querySelector("#library-summary")?.textContent === "No games stored."
                && document.querySelector("#stored-game-details") !== null
                && document.querySelector("#download-stored-m3u")?.hasAttribute("hidden") === true,
            activeDiscActions: document.querySelector("#start")?.textContent === "Start"
                && document.querySelector("#restart-disc")?.textContent === "Restart from disc"
                && document.querySelector("#restart-disc")?.hasAttribute("hidden") === true,
            memoryCardFeedback: document.querySelector("#memory-card-feedback")?.textContent
                === "Select a card image, then choose the slot to replace."
                && document.querySelector("#memory-card-feedback")?.getAttribute("aria-live") === "polite",
            idleCardDownloads: ["download-card-1", "download-card-2"].every((id) =>
                document.querySelector(`#${id}`)?.hasAttribute("disabled") === false)
                && document.querySelector("#memory-card-status")?.textContent
                    === "Download stored cards or select a replacement while no game is running.",
        }));
        const memoryCardSelection = await page.evaluate(() => {
            const input = document.querySelector("#replacement-card");
            if (!(input instanceof HTMLInputElement)) throw new Error("Missing replacement-card input");
            const transfer = new DataTransfer();
            transfer.items.add(new File([new Uint8Array(128 * 1024)], "test-card.mcr"));
            input.files = transfer.files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            const feedback = document.querySelector("#memory-card-feedback");
            return {
                text: feedback?.textContent,
                state: feedback instanceof HTMLElement ? feedback.dataset.state : undefined,
            };
        });
        const gameImportLock = await page.evaluate(async () => {
            const zone = document.querySelector("#game-drop-zone");
            const dialog = document.querySelector("#game-dialog");
            const close = document.querySelector("#game-dialog-close");
            const audit = document.querySelector("#audit");
            if (!(zone instanceof HTMLElement) || !(dialog instanceof HTMLDialogElement)
                || !(close instanceof HTMLButtonElement) || !(audit instanceof HTMLButtonElement)) {
                throw new Error("Missing game import controls");
            }
            const { strToU8, zipSync } = await import("fflate");
            const transfer = new DataTransfer();
            transfer.items.add(new File([zipSync({
                "one.cue": strToU8("FILE \"one.bin\" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:00:00\n"),
                "one.bin": new Uint8Array(2352),
            })], "Lock Test One.zip", { type: "application/zip" }));
            transfer.items.add(new File([zipSync({
                "two.cue": strToU8("FILE \"two.bin\" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:00:00\n"),
                "two.bin": new Uint8Array(2352),
            })], "Lock Test Two.zip", { type: "application/zip" }));
            zone.dispatchEvent(new DragEvent("drop", {
                bubbles: true,
                cancelable: true,
                dataTransfer: transfer,
            }));
            while (document.querySelector("#game-feedback")?.textContent
                !== "2 single-disc ZIPs are ordered and ready to check and store.") {
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
            dialog.showModal();
            audit.click();
            const cancel = new Event("cancel", { cancelable: true });
            dialog.dispatchEvent(cancel);
            dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            close.click();
            const locked = {
                busy: dialog.getAttribute("aria-busy"),
                controlsDisabled: document.querySelector("#game-controls")?.hasAttribute("disabled"),
                closeDisabled: close.disabled,
                cancelPrevented: cancel.defaultPrevented,
                remainedOpen: dialog.open,
            };
            while (dialog.hasAttribute("aria-busy")) {
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
            const importFeedback = document.querySelector("#game-feedback")?.textContent ?? "";
            if (!importFeedback.startsWith("Game check passed:")) {
                throw new Error(`Game import did not finish successfully: ${importFeedback}`);
            }
            const storedDisc = document.querySelector("#stored-disc-index");
            if (!(storedDisc instanceof HTMLSelectElement)) throw new Error("Missing stored-game disc selector");
            while (storedDisc.options.length !== 2
                || document.querySelector("#download-stored-m3u")?.hasAttribute("hidden") === true) {
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
            const options = [...storedDisc.options].map((option) => option.textContent);
            storedDisc.value = "1";
            storedDisc.dispatchEvent(new Event("change", { bubbles: true }));
            const selected = storedDisc.value;
            const feedback = document.querySelector("#stored-disc-feedback")?.textContent;
            dialog.close();
            return {
                ...locked,
                options,
                selected,
                feedback,
            };
        });
        resolveResult({
            ok: harness.canvas && harness.buttons >= 10 && harness.status === "idle"
                && harness.topLevelSessionControls && harness.viewControls && harness.deleteConfirmation
                && harness.touchController && harness.stateManager && harness.pauseOverlay && harness.runtimeShortcuts
                && harness.libraryStorage && harness.activeDiscActions
                && harness.memoryCardFeedback && harness.idleCardDownloads
                && memoryCardSelection.text === "Selected “test-card.mcr” (128 KiB). Choose card 1 or card 2."
                && memoryCardSelection.state === "idle"
                && gameImportLock.busy === "" && gameImportLock.controlsDisabled
                && gameImportLock.closeDisabled && gameImportLock.cancelPrevented && gameImportLock.remainedOpen
                && gameImportLock.options.join(",") === "Disc 1,Disc 2"
                && gameImportLock.selected === "1"
                && gameImportLock.feedback === "Disc 2 of 2 will be used when Start stored is chosen."
                && gameDrop.accepted && gameDrop.highlighted === "true"
                && gameDrop.dialog === "game-dialog" && gameDrop.state === "selected"
                && gameDrop.dragging === "false" && gameDrop.selection === "Selected: Dragged Game.zip"
                && gameDrop.feedback === "Game ZIP selected. Ready to check and store."
                && gameDrop.titleRemoved && gameDrop.overrideRemoved && gameDrop.conditionalEntryHidden
                && ambiguousEntry.visible && ambiguousEntry.entries.join(",") === "disc-a.cue,disc-b.cue"
                && ambiguousEntry.feedback === "This ZIP has multiple possible entries. Choose one, then run Check And Store."
                && multiZip.before.selection === "2 ZIPs selected for a 2-disc game."
                && multiZip.before.rows.join(",") === "Disc 1 · First.zip,Disc 2 · Second.zip"
                && multiZip.before.manifest === "disc-1/first.cue\ndisc-2/second.cue\n"
                && multiZip.before.description === "A new M3U will be generated and stored with this multi-disc game during Check And Store."
                && multiZip.before.manifestVisible
                && multiZip.after.rows.join(",") === "Disc 1 · Second.zip,Disc 2 · First.zip"
                && multiZip.after.manifest === "disc-1/second.cue\ndisc-2/first.cue\n"
                && tabSelected === "true" && playerOneHidden === "" && playerTwoHidden === null
                && keyboardListening === "Press a key or button…"
                && gamepadListening === "Press a key or button…"
                && automaticallyAssigned.playerOnePad === "M8 Test Gamepad"
                && automaticallyAssigned.playerTwoPad === "not connected"
                && captured.playerOnePad === "not connected" && captured.playerTwoPad === "M8 Test Gamepad"
                && captured.playerTwoUpKey === "G" && captured.playerTwoCircleButton === "A"
                && captured.playerTwoCrossButton === "unbound" && captured.playerTwoStickDpad && captured.stored
                && persisted.playerOnePad === "not connected" && persisted.playerTwoPad === "M8 Test Gamepad"
                && persisted.playerTwoUpKey === "G"
                && persisted.playerTwoCircleButton === "A" && persisted.playerTwoCrossButton === "unbound"
                && persisted.playerTwoStickDpad
                && persisted.storageStatus === "Stored control bindings loaded from this browser."
                && restored.playerTwoUpKey === "I" && restored.playerOneCrossButton === "A"
                && restored.playerOneCircleButton === "B" && !restored.playerTwoStickDpad && !restored.stored
                && invalidIgnored.playerTwoUpKey === "I"
                && invalidIgnored.storageStatus === "The stored control profile is invalid and was ignored; default bindings are active."
                && touchPreferences.stored?.version === 1 && touchPreferences.stored?.view === "show"
                && touchPreferences.stored?.port === 2 && touchPreferences.stored?.swap === true
                && touchPreferences.visible && touchPreferences.port === "2" && touchPreferences.swapped === "true"
                && touchPreferences.targetSizes.every(({ width, height }) => width >= 44 && height >= 44)
                && persistedTouchPreferences.view === "show" && persistedTouchPreferences.port === "2"
                && persistedTouchPreferences.swap === true && persistedTouchPreferences.rootPort === "2"
                && persistedTouchPreferences.rootSwapped === "true"
                && touchToggleBefore.label === "Hide Controls" && touchToggleBefore.pressed === "true"
                && touchToggleBefore.topLevel
                && touchToggleHidden.label === "Show Controls" && touchToggleHidden.pressed === "false"
                && touchToggleHidden.storedView === "hide"
                && touchToggleShown.label === "Hide Controls" && touchToggleShown.pressed === "true"
                && touchToggleShown.storedView === "show"
                && pageErrors.length === 0,
            ...harness,
            gameDrop,
            ambiguousEntry,
            multiZip,
            automaticallyAssigned,
            captured,
            persisted,
            restored,
            invalidIgnored,
            touchPreferences,
            persistedTouchPreferences,
            touchToggleBefore,
            touchToggleHidden,
            touchToggleShown,
            memoryCardSelection,
            gameImportLock,
            tabSelected,
            playerOneHidden: playerOneHidden === "",
            playerTwoHidden: playerTwoHidden !== null,
            keyboardListening,
            gamepadListening,
            pageErrors,
        });
    }
    if (probe === "m12") {
        await page.waitForFunction(() => document.querySelector("#ui-app")?.getAttribute("data-stage")
            === "firmware-required");
        const desktop = await page.evaluate(() => ({
            stage: document.querySelector("#ui-app")?.getAttribute("data-stage"),
            title: document.querySelector("#stage-title")?.textContent,
            canvas: document.querySelector("#screen") instanceof HTMLCanvasElement,
            wordmarkAbsent: document.querySelector(".wordmark") === null,
            gameDisabled: document.querySelector("#game-nav")?.hasAttribute("disabled"),
            libraryDisabled: document.querySelector("#library-nav")?.hasAttribute("disabled"),
            pageFits: document.documentElement.scrollHeight <= document.documentElement.clientHeight,
            unsupportedSettingsAbsent: ["rewind", "reverb", "internal-resolution", "fast-boot"]
                .every((id) => document.querySelector(`#${id}`) === null),
        }));
        await page.click("[data-open-dialog='system']");
        const system = await page.evaluate(() => ({
            open: document.querySelector("#system-dialog")?.hasAttribute("open"),
            slots: document.querySelectorAll(".firmware-slot").length,
            defaultRegion: document.querySelector("#firmware-region")?.value,
            forgetHidden: document.querySelector("#forget-firmware")?.hasAttribute("hidden"),
        }));
        await page.click("#system-dialog button[value='cancel']");
        const firmwareDrop = await page.evaluate(() => {
            const stage = document.querySelector("#screen-stage");
            if (!(stage instanceof HTMLElement)) throw new Error("Missing production stage");
            const transfer = new DataTransfer();
            transfer.items.add(new File([new Uint8Array(512 * 1024)], "drop-test.bin", {
                type: "application/octet-stream",
            }));
            const dragover = new DragEvent("dragover", {
                bubbles: true,
                cancelable: true,
                dataTransfer: transfer,
            });
            const accepted = !stage.dispatchEvent(dragover) && dragover.defaultPrevented;
            const highlighted = stage.dataset.dragging;
            stage.dispatchEvent(new DragEvent("drop", {
                bubbles: true,
                cancelable: true,
                dataTransfer: transfer,
            }));
            return { accepted, highlighted };
        });
        await page.waitForFunction(() => document.querySelector("#ui-app")?.getAttribute("data-stage") === "ready");
        const firmwareStored = await page.evaluate(() => ({
            gameEnabled: document.querySelector("#game-nav")?.hasAttribute("disabled") === false,
            libraryEnabled: document.querySelector("#library-nav")?.hasAttribute("disabled") === false,
            feedback: document.querySelector("#firmware-feedback")?.getAttribute("data-state"),
            dragging: document.querySelector("#screen-stage")?.getAttribute("data-dragging"),
        }));
        const gameDrop = await page.evaluate(async () => {
            const stage = document.querySelector("#screen-stage");
            if (!(stage instanceof HTMLElement)) throw new Error("Missing production stage");
            const { strToU8, zipSync } = await import("fflate");
            const transfer = new DataTransfer();
            transfer.items.add(new File([zipSync({
                "game.cue": strToU8("FILE \"game.bin\" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:00:00\n"),
                "game.bin": new Uint8Array(2352),
            })], "Dropped Game.zip", { type: "application/zip" }));
            const dragover = new DragEvent("dragover", {
                bubbles: true,
                cancelable: true,
                dataTransfer: transfer,
            });
            const accepted = !stage.dispatchEvent(dragover) && dragover.defaultPrevented;
            const highlighted = stage.dataset.dragging;
            stage.dispatchEvent(new DragEvent("drop", {
                bubbles: true,
                cancelable: true,
                dataTransfer: transfer,
            }));
            return { accepted, highlighted };
        });
        await page.waitForFunction(() => document.querySelector("#game-dialog")?.hasAttribute("open")
            && document.querySelectorAll("#game-archives li").length === 1);
        const gameSelected = await page.evaluate(() => ({
            dialogOpen: document.querySelector("#game-dialog")?.hasAttribute("open"),
            selection: document.querySelector("#game-selection")?.textContent,
            archive: document.querySelector("#game-archives li span")?.textContent,
            dragging: document.querySelector("#screen-stage")?.getAttribute("data-dragging"),
        }));
        const modalGameDrop = await page.evaluate(async () => {
            const dialog = document.querySelector("#game-dialog");
            if (!(dialog instanceof HTMLDialogElement)) throw new Error("Missing production Game dialog");
            const { strToU8, zipSync } = await import("fflate");
            const transfer = new DataTransfer();
            transfer.items.add(new File([zipSync({
                "second.cue": strToU8("FILE \"second.bin\" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:00:00\n"),
                "second.bin": new Uint8Array(2352),
            })], "Second Disc.zip", { type: "application/zip" }));
            const dragover = new DragEvent("dragover", {
                bubbles: true,
                cancelable: true,
                dataTransfer: transfer,
            });
            const accepted = !dialog.dispatchEvent(dragover) && dragover.defaultPrevented;
            const highlighted = dialog.dataset.dragging;
            dialog.dispatchEvent(new DragEvent("drop", {
                bubbles: true,
                cancelable: true,
                dataTransfer: transfer,
            }));
            return { accepted, highlighted };
        });
        await page.waitForFunction(() => document.querySelectorAll("#game-archives li").length === 2);
        await page.click("#game-archives li:nth-child(2) [data-archive-action='up']");
        await page.waitForFunction(() => document.querySelector("#game-archives li:first-child span")?.textContent
            === "Second Disc.zip");
        const reorderedArchives = await page.evaluate(() => ({
            archives: [...document.querySelectorAll("#game-archives li span")].map((node) => node.textContent),
            controls: document.querySelectorAll("#game-archives [data-archive-action]").length,
        }));
        await page.click("#game-archives li:first-child [data-archive-action='down']");
        await page.waitForFunction(() => document.querySelector("#game-archives li:first-child span")?.textContent
            === "Dropped Game.zip");
        await page.evaluate(async () => {
            const dialog = document.querySelector("#game-dialog");
            if (!(dialog instanceof HTMLDialogElement)) throw new Error("Missing production Game dialog");
            const { strToU8, zipSync } = await import("fflate");
            const transfer = new DataTransfer();
            transfer.items.add(new File([zipSync({
                "temporary.cue": strToU8("FILE \"temporary.bin\" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:00:00\n"),
                "temporary.bin": new Uint8Array(2352),
            })], "Temporary Disc.zip", { type: "application/zip" }));
            dialog.dispatchEvent(new DragEvent("drop", {
                bubbles: true,
                cancelable: true,
                dataTransfer: transfer,
            }));
        });
        await page.waitForFunction(() => document.querySelectorAll("#game-archives li").length === 3);
        await page.click("#game-archives li:nth-child(3) [data-archive-action='remove']");
        await page.waitForFunction(() => document.querySelectorAll("#game-archives li").length === 2);
        const modalGameSelected = await page.evaluate(() => ({
            selection: document.querySelector("#game-selection")?.textContent,
            archives: [...document.querySelectorAll("#game-archives li span")].map((node) => node.textContent),
            dialogDragging: document.querySelector("#game-dialog")?.getAttribute("data-dragging"),
            zoneDragging: document.querySelector("#game-drop-zone")?.getAttribute("data-dragging"),
            multiDiscMessage: document.querySelector("#game-feedback")?.textContent,
            startHidden: document.querySelector("#start-imported-game")?.hasAttribute("hidden"),
            actions: (() => {
                const store = document.querySelector("#store-game")?.getBoundingClientRect();
                const clear = document.querySelector("#clear-game")?.getBoundingClientRect();
                return { storeLeft: store?.left, clearLeft: clear?.left };
            })(),
        }));
        const workingGameStatus = await page.evaluate(() => {
            document.querySelector("#store-game")?.click();
            const feedback = document.querySelector("#game-feedback");
            return {
                state: feedback?.getAttribute("data-state"),
                color: feedback === null ? null : getComputedStyle(feedback).color,
                storeDisabled: document.querySelector("#store-game")?.hasAttribute("disabled"),
                clearDisabled: document.querySelector("#clear-game")?.hasAttribute("disabled"),
            };
        });
        await page.waitForFunction(() => document.querySelector("#game-feedback")?.getAttribute("data-state")
            === "success");
        const storedGameActions = await page.evaluate(() => ({
            feedback: document.querySelector("#game-feedback")?.textContent,
            storeLabel: document.querySelector("#store-game")?.textContent,
            storeDisabled: document.querySelector("#store-game")?.hasAttribute("disabled"),
            startVisible: document.querySelector("#start-imported-game")?.hasAttribute("hidden") === false,
            startEnabled: document.querySelector("#start-imported-game")?.hasAttribute("disabled") === false,
            libraryCount: document.querySelector("#library-count")?.textContent,
            discCount: document.querySelector(".game-metrics div:first-child strong")?.textContent,
            archiveControls: {
                firstUpDisabled: document.querySelector("#game-archives li:first-child [data-archive-action='up']")
                    ?.hasAttribute("disabled"),
                firstRemoveEnabled: document.querySelector("#game-archives li:first-child [data-archive-action='remove']")
                    ?.hasAttribute("disabled") === false,
                lastDownDisabled: document.querySelector("#game-archives li:last-child [data-archive-action='down']")
                    ?.hasAttribute("disabled"),
            },
        }));
        await page.click("#game-dialog button[value='cancel']");
        const windowedCanvas = await page.evaluate(() => {
            const stage = document.querySelector("#screen-stage");
            const canvas = document.querySelector("#screen");
            if (!(stage instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) {
                throw new Error("Missing production display elements");
            }
            canvas.style.width = "640px";
            canvas.style.height = "480px";
            const stageRect = stage.getBoundingClientRect();
            const canvasRect = canvas.getBoundingClientRect();
            const result = {
                horizontalDelta: Math.abs((stageRect.left + stageRect.width / 2)
                    - (canvasRect.left + canvasRect.width / 2)),
                verticalDelta: Math.abs((stageRect.top + stageRect.height / 2)
                    - (canvasRect.top + canvasRect.height / 2)),
            };
            canvas.style.width = "";
            canvas.style.height = "";
            return result;
        });
        const fullscreenDecoration = await page.evaluate(() => [...document.styleSheets]
            .flatMap((sheet) => {
                try { return [...sheet.cssRules]; } catch { return []; }
            })
            .some((rule) => rule instanceof CSSStyleRule
                && rule.selectorText.includes("#play-stage:fullscreen .screen-stage::before")
                && rule.selectorText.includes("#play-stage:fullscreen .screen-stage::after")
                && rule.style.display === "none"));
        const activeScreenChrome = await page.evaluate(() => {
            const app = document.querySelector("#ui-app");
            const telemetry = document.querySelector(".stage-telemetry");
            const signal = document.querySelector(".signal-bars");
            if (!(app instanceof HTMLElement) || !(telemetry instanceof HTMLElement)
                || !(signal instanceof HTMLElement)) throw new Error("Missing production screen chrome");
            const displayFor = (state) => {
                app.dataset.stage = state;
                return {
                    telemetry: getComputedStyle(telemetry).display,
                    signal: getComputedStyle(signal).display,
                };
            };
            const running = displayFor("running");
            const paused = displayFor("paused");
            app.dataset.stage = "ready";
            return { running, paused };
        });
        const centeredNotice = await page.evaluate(() => {
            const stage = document.querySelector("#screen-stage");
            const notice = document.querySelector("#screen-notice");
            if (!(stage instanceof HTMLElement) || !(notice instanceof HTMLElement)) {
                throw new Error("Missing production notice elements");
            }
            notice.textContent = "Session started.";
            notice.hidden = false;
            const stageRect = stage.getBoundingClientRect();
            const noticeRect = notice.getBoundingClientRect();
            const result = {
                horizontalDelta: Math.abs((stageRect.left + stageRect.width / 2)
                    - (noticeRect.left + noticeRect.width / 2)),
                verticalDelta: Math.abs((stageRect.top + stageRect.height / 2)
                    - (noticeRect.top + noticeRect.height / 2)),
            };
            notice.hidden = true;
            return result;
        });
        await page.setViewportSize({ width: 390, height: 844 });
        const mobile = await page.evaluate(() => ({
            pageFits: document.documentElement.scrollHeight <= document.documentElement.clientHeight,
            stageWidth: document.querySelector("#screen-stage")?.getBoundingClientRect().width,
            targetSizes: [...document.querySelectorAll(".main-nav button, .session-actions button")]
                .map((button) => {
                    const rect = button.getBoundingClientRect();
                    return { width: rect.width, height: rect.height };
                }),
        }));
        resolveResult({
            ok: desktop.stage === "firmware-required" && desktop.title === "[ FIRMWARE REQUIRED ]"
                && desktop.canvas && desktop.wordmarkAbsent && desktop.gameDisabled && desktop.libraryDisabled && desktop.pageFits
                && desktop.unsupportedSettingsAbsent && system.open && system.slots === 3
                && system.defaultRegion === "ntsc-u" && system.forgetHidden
                && firmwareDrop.accepted && firmwareDrop.highlighted === "true"
                && firmwareStored.gameEnabled && firmwareStored.libraryEnabled
                && firmwareStored.feedback === "success" && firmwareStored.dragging === "false"
                && gameDrop.accepted && gameDrop.highlighted === "true" && gameSelected.dialogOpen
                && gameSelected.selection === "1 ZIP selected in disc order."
                && gameSelected.archive === "Dropped Game.zip" && gameSelected.dragging === "false"
                && modalGameDrop.accepted && modalGameDrop.highlighted === "true"
                && reorderedArchives.archives.join(",") === "Second Disc.zip,Dropped Game.zip"
                && reorderedArchives.controls === 6
                && modalGameSelected.selection === "2 ZIPs selected in disc order."
                && modalGameSelected.archives.join(",") === "Dropped Game.zip,Second Disc.zip"
                && modalGameSelected.dialogDragging === "false" && modalGameSelected.zoneDragging === "false"
                && modalGameSelected.multiDiscMessage?.includes("stored together as one 2-disc Library game")
                && modalGameSelected.startHidden
                && modalGameSelected.actions.storeLeft < modalGameSelected.actions.clearLeft
                && workingGameStatus.state === "working" && workingGameStatus.color === "rgb(255, 210, 122)"
                && workingGameStatus.storeDisabled && workingGameStatus.clearDisabled
                && storedGameActions.feedback?.includes("All 2 ZIPs passed validation")
                && storedGameActions.storeLabel === "Checked And Stored" && storedGameActions.storeDisabled
                && storedGameActions.startVisible && storedGameActions.startEnabled
                && storedGameActions.libraryCount === "01 TITLES" && storedGameActions.discCount === "2"
                && storedGameActions.archiveControls.firstUpDisabled
                && storedGameActions.archiveControls.firstRemoveEnabled
                && storedGameActions.archiveControls.lastDownDisabled
                && windowedCanvas.horizontalDelta < 1 && windowedCanvas.verticalDelta < 1
                && fullscreenDecoration
                && activeScreenChrome.running.telemetry === "none"
                && activeScreenChrome.running.signal === "none"
                && activeScreenChrome.paused.telemetry === "none"
                && activeScreenChrome.paused.signal === "none"
                && centeredNotice.horizontalDelta < 1 && centeredNotice.verticalDelta < 1
                && mobile.pageFits
                && typeof mobile.stageWidth === "number" && mobile.stageWidth <= 390
                && mobile.targetSizes.every(({ width, height }) => width >= 36 && height >= 40)
                && pageErrors.length === 0,
            desktop,
            system,
            firmwareDrop,
            firmwareStored,
            gameDrop,
            gameSelected,
            modalGameDrop,
            reorderedArchives,
            modalGameSelected,
            workingGameStatus,
            storedGameActions,
            windowedCanvas,
            fullscreenDecoration,
            activeScreenChrome,
            centeredNotice,
            mobile,
            pageErrors,
        });
    }
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
    const includeBrowserMemory = probe === "endurance" || probe === "memory";
    const browserProcessMemory = {
        method: "linux-process-tree-vmrss",
        initialBytes: browserMemoryBytes[0],
        peakBytes: Math.max(...browserMemoryBytes),
        finalBytes: browserMemoryBytes.at(-1),
        baselineToPeakBytes: Math.max(...browserMemoryBytes) - browserMemoryBytes[0],
        trace: browserProcessMemoryTrace,
    };
    const browserMemoryPass = probe !== "memory"
        || browserProcessMemory.baselineToPeakBytes < result.logicalDiscBytes / 2;
    const output = includeBrowserMemory
        ? {
            ...result,
            ok: result.ok === true && browserMemoryPass,
            browserProcessMemory: {
                ...browserProcessMemory,
                maximumBaselineToPeakBytes: probe === "memory" ? result.logicalDiscBytes / 2 : undefined,
                pass: browserMemoryPass,
            },
        }
        : result;
    console.log(JSON.stringify(output));
    if (output.ok !== true) process.exitCode = 1;
} finally {
    clearTimeout(resultTimeout);
    clearInterval(memoryTimer);
    await browser.close();
    await browserServer.close();
    server.closeAllConnections();
    await new Promise((resolvePromise) => server.close(resolvePromise));
}
