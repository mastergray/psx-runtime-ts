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
    m13: "/ui/index.html",
};

if (probe === undefined || !(probe in probes)) {
    console.error("Usage: node core/probes/run-browser-probe.mjs <workerfs|pcsx|beetle|endurance|geometry|media|cards|stateDisc|memory|bios|m4|m6|m7|m8|m9|m10|m11|m12|m13>");
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
    if (probe === "m13") {
        await page.waitForFunction(() => document.querySelector("#ui-app")?.getAttribute("data-stage")
            === "firmware-required");
        await page.click("[data-open-dialog='view']");
        const entry = await page.evaluate(() => ({
            label: document.querySelector("#enter-presentation")?.textContent,
            described: document.querySelector(".presentation-entry small")?.textContent,
            menuInitiallyHidden: document.querySelector("#presentation-menu")?.hasAttribute("hidden"),
        }));
        await page.click("#enter-presentation");
        await page.waitForFunction(() => document.querySelector("#ui-app")?.getAttribute("data-mode")
            === "presentation" && document.querySelector("#presentation-menu")?.hasAttribute("hidden") === false);
        const entered = await page.evaluate(() => {
            const app = document.querySelector("#ui-app");
            const menu = document.querySelector("#presentation-menu");
            const command = document.querySelector(".command-bar");
            const playStage = document.querySelector("#play-stage")?.getBoundingClientRect();
            const actions = [...document.querySelectorAll(".presentation-actions [data-presentation-focus]")];
            return {
                mode: app?.getAttribute("data-mode"),
                stored: localStorage.getItem("psx-runtime:ui:presentation-mode"),
                menuVisible: menu?.hasAttribute("hidden") === false,
                view: document.querySelector("#presentation-library-view")?.hasAttribute("hidden") === false,
                chromeHidden: command !== null && getComputedStyle(command).display === "none",
                fullViewport: playStage !== undefined && Math.abs(playStage.width - innerWidth) < 1
                    && Math.abs(playStage.height - innerHeight) < 1,
                columns: getComputedStyle(document.querySelector(".presentation-columns")).gridTemplateColumns,
                actions: actions.map((action) => action.textContent?.replace(/\s+/gu, " ").trim()),
                controllerFocus: document.activeElement?.id,
                feedback: document.querySelector("#presentation-feedback")?.textContent,
                feedbackHidden: document.querySelector("#presentation-feedback")?.hasAttribute("hidden"),
                legacyActionsAbsent: ["Save State", "Load State", "Mute", "Volume", "Controllers"]
                    .every((label) => !actions.some((action) => action.textContent?.includes(label))),
                libraryActionAbsent: document.querySelector("#presentation-library") === null,
                header: document.querySelector(".presentation-header-label")?.textContent,
                headerStatus: document.querySelector("#presentation-header-status")?.textContent,
                libraryHeading: document.querySelector("#presentation-library-view h3")?.textContent,
                libraryCount: document.querySelector("#presentation-library-count")?.textContent,
                storedGamesHeadingAbsent: ![...document.querySelectorAll("#presentation-library-view h3")]
                    .some((heading) => heading.textContent?.includes("Stored games")),
                resumeLabel: document.querySelector("#presentation-resume strong")?.textContent,
                idleScalingEnabled: !document.querySelector("#presentation-scaling")?.hasAttribute("disabled"),
                idleSwitchDiscDisabled: document.querySelector("#presentation-switch-disc")?.hasAttribute("disabled"),
            };
        });
        await page.keyboard.press("ArrowRight");
        const idleScaling = await page.evaluate(() => ({
            label: document.querySelector("#presentation-scaling-value")?.textContent,
            feedback: document.querySelector("#presentation-feedback")?.textContent,
            feedbackHidden: document.querySelector("#presentation-feedback")?.hasAttribute("hidden"),
        }));
        await page.keyboard.press("ArrowDown");
        const navigated = await page.evaluate(() => ({
            focused: document.activeElement?.id,
            padFocus: document.activeElement?.getAttribute("data-pad-focus"),
        }));
        await page.keyboard.press("Escape");
        const idleEscape = await page.evaluate(() => ({
            menuStillVisible: document.querySelector("#presentation-menu")?.hasAttribute("hidden") === false,
            mode: document.querySelector("#ui-app")?.getAttribute("data-mode"),
        }));
        await page.click("#presentation-play-mode");
        await page.waitForFunction(() => document.querySelector("#ui-app")?.getAttribute("data-mode") === "play");
        const left = await page.evaluate(() => ({
            mode: document.querySelector("#ui-app")?.getAttribute("data-mode"),
            stored: localStorage.getItem("psx-runtime:ui:presentation-mode"),
            menuHidden: document.querySelector("#presentation-menu")?.hasAttribute("hidden"),
            chromeVisible: getComputedStyle(document.querySelector(".command-bar")).display !== "none",
        }));
        await page.click("[data-open-dialog='view']");
        await page.click("#enter-presentation");
        await page.waitForFunction(() => localStorage.getItem("psx-runtime:ui:presentation-mode") === "presentation");
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => document.querySelector("#ui-app")?.getAttribute("data-stage") !== "loading");
        const restored = await page.evaluate(() => ({
            mode: document.querySelector("#ui-app")?.getAttribute("data-mode"),
            menuVisible: document.querySelector("#presentation-menu")?.hasAttribute("hidden") === false,
            libraryVisible: document.querySelector("#presentation-library-view")?.hasAttribute("hidden") === false,
            stored: localStorage.getItem("psx-runtime:ui:presentation-mode"),
        }));
        const libraryContract = await page.evaluate(async () => {
            localStorage.setItem("psx-runtime:ui:presentation-mode", "play");
            const { default: PresentationMode } = await import("/dist/ui-build/ui/PresentationMode/PresentationMode.js");
            let started = null;
            let session = null;
            let finishStart;
            const startGate = new Promise((resolve) => { finishStart = resolve; });
            const games = [
                { gameId: "single", title: "Single Disc", discCount: 1, totalBytes: 800_000_000 },
                { gameId: "multi", title: "Multi Disc", discCount: 2, totalBytes: 700_000_000 },
            ];
            const mode = new PresentationMode({
                document,
                storage: localStorage,
                getSnapshot: () => ({ firmwareReady: true, scaling: "fit", games, session }),
                pauseForMenu: async () => false,
                resumeFromMenu: () => undefined,
                enterFullscreen: async () => undefined,
                leaveFullscreen: async () => undefined,
                startGame: async (gameId, discIndex) => {
                    started = { gameId, discIndex };
                    await startGate;
                    session = {
                        gameId,
                        title: gameId === "multi" ? "Multi Disc" : "Single Disc",
                        discIndex,
                        discCount: gameId === "multi" ? 2 : 1,
                    };
                },
                changeDisc: async () => undefined,
                reset: async () => undefined,
                setScaling: () => undefined,
            });
            mode.initialize();
            await mode.enter();
            await new Promise((resolve) => requestAnimationFrame(() => resolve()));
            const multi = document.querySelector('[data-game-id="multi"]');
            const before = {
                rows: document.querySelectorAll(".presentation-game-row").length,
                dropdowns: document.querySelectorAll(".presentation-game-row select").length,
                playButtons: document.querySelectorAll(".presentation-game-play").length,
                pickerInitiallyHidden: document.querySelector("#presentation-disc-picker")?.hasAttribute("hidden"),
            };
            multi?.querySelector("button")?.click();
            const pickerOptions = [...document.querySelectorAll("#presentation-disc-options button")]
                .map((button) => button.textContent);
            document.querySelectorAll("#presentation-disc-options button")[1]?.click();
            while (started === null) await new Promise((resolve) => requestAnimationFrame(() => resolve()));
            const loading = {
                visible: document.querySelector("#presentation-loading")?.hasAttribute("hidden") === false,
                status: document.querySelector("#presentation-loading-status")?.textContent,
            };
            finishStart();
            while (document.querySelector("#presentation-menu")?.hasAttribute("hidden") === false) {
                await new Promise((resolve) => requestAnimationFrame(() => resolve()));
            }
            const result = {
                ...before,
                pickerOptions,
                started,
                loading,
                activeSelected: document.querySelector('.presentation-game-play[data-game-id="multi"]')
                    ?.getAttribute("aria-current"),
                headerStatus: document.querySelector("#presentation-header-status")?.textContent,
                libraryCount: document.querySelector("#presentation-library-count")?.textContent,
                switchDiscDisabled: document.querySelector("#presentation-switch-disc")?.hasAttribute("disabled"),
                switchDiscValue: document.querySelector("#presentation-switch-disc-value")?.textContent,
                menuClosed: document.querySelector("#presentation-menu")?.hasAttribute("hidden"),
            };
            mode.destroy();
            return result;
        });
        resolveResult({
            ok: entry.label === "Enter Presentation Mode"
                && entry.described?.includes("mirrored television") && entry.menuInitiallyHidden
                && entered.mode === "presentation" && entered.stored === "presentation"
                && entered.menuVisible && entered.view && entered.chromeHidden && entered.fullViewport
                && entered.columns !== "none" && entered.actions.some((label) => label?.startsWith("Play Mode"))
                && entered.controllerFocus === "presentation-scaling"
                && entered.feedback === "" && entered.feedbackHidden
                && entered.legacyActionsAbsent && entered.libraryActionAbsent
                && entered.header === "// Presentation Mode" && entered.headerStatus === "No game loaded"
                && entered.libraryHeading === "// Library" && entered.libraryCount === "0 Titles (0 MB)"
                && entered.storedGamesHeadingAbsent
                && entered.resumeLabel === "Resume" && entered.idleScalingEnabled && entered.idleSwitchDiscDisabled
                && entered.actions[1]?.startsWith("Reset")
                && entered.actions[2]?.startsWith("Switch Disc")
                && entered.actions[3]?.startsWith("Scaling")
                && idleScaling.label === "Integer" && idleScaling.feedback === "" && idleScaling.feedbackHidden
                && navigated.focused === "presentation-play-mode" && navigated.padFocus === "true"
                && idleEscape.menuStillVisible && idleEscape.mode === "presentation"
                && left.mode === "play" && left.stored === "play" && left.menuHidden && left.chromeVisible
                && restored.mode === "presentation" && restored.menuVisible
                && restored.libraryVisible && restored.stored === "presentation"
                && libraryContract.rows === 2 && libraryContract.dropdowns === 0
                && libraryContract.playButtons === 2 && libraryContract.pickerInitiallyHidden
                && libraryContract.pickerOptions.join(",") === "Disc 1,Disc 2"
                && libraryContract.started?.gameId === "multi" && libraryContract.started?.discIndex === 1
                && libraryContract.loading.visible && libraryContract.loading.status === "Starting “Multi Disc”…"
                && libraryContract.activeSelected === "true"
                && libraryContract.headerStatus === "Multi Disc · Disc 2 of 2"
                && libraryContract.libraryCount === "2 Titles (1.5 GB)"
                && !libraryContract.switchDiscDisabled && libraryContract.switchDiscValue === "Disc 2 of 2"
                && libraryContract.menuClosed
                && pageErrors.length === 0,
            entry,
            entered,
            idleScaling,
            navigated,
            idleEscape,
            left,
            restored,
            libraryContract,
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
        const system = await page.evaluate(() => {
            const input = document.querySelector("#firmware-file");
            const store = document.querySelector("#store-firmware");
            if (!(input instanceof HTMLInputElement) || !(store instanceof HTMLButtonElement)) {
                throw new Error("Missing firmware selection actions");
            }
            const storeHidden = store.hidden;
            const transfer = new DataTransfer();
            transfer.items.add(new File([new Uint8Array(512 * 1024)], "new-firmware.bin", {
                type: "application/octet-stream",
            }));
            input.files = transfer.files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            const newFirmware = {
                visible: !store.hidden,
                label: store.textContent,
                enabled: !store.disabled,
            };
            input.files = new DataTransfer().files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            return {
                open: document.querySelector("#system-dialog")?.hasAttribute("open"),
                slots: document.querySelectorAll(".firmware-slot").length,
                defaultRegion: document.querySelector("#firmware-region")?.value,
                forgetHidden: document.querySelector("#forget-firmware")?.hasAttribute("hidden"),
                systemStopHidden: document.querySelector("#system-stop-session")?.hasAttribute("hidden"),
                storeHidden,
                newFirmware,
                hiddenAfterClear: store.hidden,
            };
        });
        await page.click("#system-controls-tab");
        const controlsInitial = await page.evaluate(() => ({
            controlsSelected: document.querySelector("#system-controls-tab")?.getAttribute("aria-selected"),
            firmwareHidden: document.querySelector("#system-firmware-panel")?.hasAttribute("hidden"),
            controlsVisible: document.querySelector("#system-controls-panel")?.hasAttribute("hidden") === false,
            playerOneRows: document.querySelectorAll("#control-bindings-1 tr").length,
            playerTwoRows: document.querySelectorAll("#control-bindings-2 tr").length,
            playerOneCrossKey: document.querySelector("#control-keyboard-1-cross")?.textContent,
            playerTwoUpKey: document.querySelector("#control-keyboard-2-up")?.textContent,
            playerOnePad: document.querySelector("#assigned-gamepad-1")?.textContent,
            assignmentAction: document.querySelector("#assign-gamepad-1")?.textContent,
            playerReset: document.querySelector("#reset-player-mapping-1")?.textContent,
            allResetDestructive: document.querySelector("#reset-all-mappings")?.classList.contains("danger-action"),
        }));
        await page.click("#assign-gamepad-1");
        await page.evaluate(async () => {
            globalThis.__m12PadPressed = false;
            const buttons = Array.from({ length: 16 }, (_, index) => ({
                get pressed() { return index === 0 && globalThis.__m12PadPressed; },
                get value() { return this.pressed ? 1 : 0; },
            }));
            Object.defineProperty(navigator, "getGamepads", {
                configurable: true,
                value: () => [{
                    id: "M12 Production Pad",
                    index: 0,
                    connected: true,
                    mapping: "standard",
                    axes: [0, 0, 0, 0],
                    buttons,
                }],
            });
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            globalThis.__m12PadPressed = true;
        });
        await page.waitForFunction(() => document.querySelector("#assigned-gamepad-1")?.textContent
            === "M12 Production Pad");
        const controlsAssigned = await page.evaluate(() => {
            globalThis.__m12PadPressed = false;
            const source = localStorage.getItem("psx-runtime:ui:controls");
            const profile = source === null ? null : JSON.parse(source);
            return {
                label: document.querySelector("#assigned-gamepad-1")?.textContent,
                status: document.querySelector("#control-binding-status-1")?.getAttribute("data-state"),
                preferredPort: profile?.gamepadPorts?.["M12 Production Pad"],
                crossButton: document.querySelector("#control-gamepad-1-cross")?.textContent,
            };
        });
        await page.click("#change-control-1-cross");
        const controlsCapturing = await page.evaluate(() => ({
            state: document.querySelector("#control-binding-status-1")?.getAttribute("data-state"),
            action: document.querySelector("#change-control-1-cross")?.textContent,
            message: document.querySelector("#control-binding-status-1")?.textContent,
        }));
        await page.keyboard.press("c");
        await page.waitForFunction(() => document.querySelector("#control-keyboard-1-cross")?.textContent === "C");
        const controlsStored = await page.evaluate(() => {
            const source = localStorage.getItem("psx-runtime:ui:controls");
            const profile = source === null ? null : JSON.parse(source);
            return {
                key: document.querySelector("#control-keyboard-1-cross")?.textContent,
                status: document.querySelector("#control-binding-status-1")?.getAttribute("data-state"),
                version: profile?.version,
                storedControl: profile?.keyboard?.KeyC,
            };
        });
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => document.querySelector("#ui-app")?.getAttribute("data-stage") !== "loading");
        await page.click("[data-open-dialog='system']");
        await page.click("#system-controls-tab");
        const controlsReloaded = await page.evaluate(() => ({
            key: document.querySelector("#control-keyboard-1-cross")?.textContent,
            storageFeedback: document.querySelector("#control-storage-status")?.textContent,
            storageState: document.querySelector("#control-storage-status")?.getAttribute("data-state"),
        }));
        await page.click("#reset-player-mapping-1");
        const controlsPlayerReset = await page.evaluate(() => ({
            key: document.querySelector("#control-keyboard-1-cross")?.textContent,
            status: document.querySelector("#control-binding-status-1")?.textContent,
            stored: localStorage.getItem("psx-runtime:ui:controls") !== null,
        }));
        await page.click("#controls-player-tab-2");
        const controlsPlayerTwo = await page.evaluate(() => ({
            selected: document.querySelector("#controls-player-tab-2")?.getAttribute("aria-selected"),
            playerOneHidden: document.querySelector("#controls-player-panel-1")?.hasAttribute("hidden"),
            playerTwoVisible: document.querySelector("#controls-player-panel-2")?.hasAttribute("hidden") === false,
            upKey: document.querySelector("#control-keyboard-2-up")?.textContent,
        }));
        await page.click("#reset-all-mappings");
        const controlsResetAll = await page.evaluate(() => ({
            stored: localStorage.getItem("psx-runtime:ui:controls"),
            feedback: document.querySelector("#control-storage-status")?.textContent,
            state: document.querySelector("#control-storage-status")?.getAttribute("data-state"),
        }));
        await page.click("#system-firmware-tab");
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
        await page.click("[data-open-dialog='system']");
        const systemDelete = await page.evaluate(() => {
            const messages = [];
            globalThis.confirm = (message) => {
                messages.push(String(message));
                return false;
            };
            const remove = document.querySelector("#forget-firmware");
            const input = document.querySelector("#firmware-file");
            const store = document.querySelector("#store-firmware");
            const systemStop = document.querySelector("#system-stop-session");
            if (!(remove instanceof HTMLButtonElement) || !(input instanceof HTMLInputElement)
                || !(store instanceof HTMLButtonElement) || !(systemStop instanceof HTMLButtonElement)) {
                throw new Error("Missing System actions");
            }
            remove.click();
            const initialStoreHidden = store.hidden;
            const transfer = new DataTransfer();
            transfer.items.add(new File([new Uint8Array(512 * 1024)], "replacement.bin", {
                type: "application/octet-stream",
            }));
            input.files = transfer.files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            const replacement = {
                visible: !store.hidden,
                label: store.textContent,
                enabled: !store.disabled,
            };
            input.files = new DataTransfer().files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            systemStop.hidden = false;
            systemStop.disabled = false;
            systemStop.click();
            const systemStopResult = {
                label: systemStop.textContent,
                destructive: systemStop.classList.contains("danger-action"),
                confirmation: messages[1],
                leftOfDelete: systemStop.getBoundingClientRect().left < remove.getBoundingClientRect().left,
            };
            systemStop.hidden = true;
            systemStop.disabled = true;
            return {
                label: remove.textContent,
                visible: !remove.hidden,
                destructive: remove.classList.contains("danger-action"),
                color: getComputedStyle(remove).color,
                confirmation: messages[0],
                initialStoreHidden,
                replacement,
                hiddenAfterClear: store.hidden,
                systemStop: systemStopResult,
            };
        });
        await page.selectOption("#firmware-region", "pal");
        const emptyRegionGate = await page.evaluate(() => ({
            stage: document.querySelector("#ui-app")?.getAttribute("data-stage"),
            gameDisabled: document.querySelector("#game-nav")?.hasAttribute("disabled"),
            libraryDisabled: document.querySelector("#library-nav")?.hasAttribute("disabled"),
            deleteHidden: document.querySelector("#forget-firmware")?.hasAttribute("hidden"),
            storeHidden: document.querySelector("#store-firmware")?.hasAttribute("hidden"),
        }));
        await page.selectOption("#firmware-region", "ntsc-u");
        const storedRegionGate = await page.evaluate(() => ({
            stage: document.querySelector("#ui-app")?.getAttribute("data-stage"),
            gameEnabled: document.querySelector("#game-nav")?.hasAttribute("disabled") === false,
            libraryEnabled: document.querySelector("#library-nav")?.hasAttribute("disabled") === false,
            deleteVisible: document.querySelector("#forget-firmware")?.hasAttribute("hidden") === false,
            storeHidden: document.querySelector("#store-firmware")?.hasAttribute("hidden"),
        }));
        await page.click("#system-dialog button[value='cancel']");
        const volumeControl = await page.evaluate(() => {
            const trigger = document.querySelector("#volume-session");
            const dialog = document.querySelector("#volume-dialog");
            const range = document.querySelector("#volume-level");
            if (!(trigger instanceof HTMLButtonElement) || !(dialog instanceof HTMLDialogElement)
                || !(range instanceof HTMLInputElement)) throw new Error("Missing Volume controls");
            trigger.disabled = false;
            trigger.click();
            range.value = "42";
            range.dispatchEvent(new Event("input", { bubbles: true }));
            const result = {
                label: trigger.textContent,
                controls: trigger.getAttribute("aria-controls"),
                open: dialog.open,
                value: range.value,
                output: document.querySelector("#volume-value")?.textContent,
                ranges: dialog.querySelectorAll("input[type='range']").length,
                extraControls: dialog.querySelectorAll(".dialog-content button, .dialog-content select, .dialog-content input:not([type='range'])").length,
            };
            dialog.close();
            trigger.disabled = true;
            return {
                ...result,
                closed: !dialog.open,
            };
        });
        await page.click("[data-open-dialog='view']");
        await page.waitForFunction(() => document.querySelector("#view-dialog")?.hasAttribute("open"));
        const touchViewInitial = await page.evaluate(() => {
            const toggle = document.querySelector("#touch-controller-visible");
            const apply = document.querySelector("#apply-view")?.getBoundingClientRect();
            const cancel = document.querySelector("#cancel-view")?.getBoundingClientRect();
            return {
                checked: toggle instanceof HTMLInputElement ? toggle.checked : null,
                hidden: document.querySelector("#touch-controller")?.hasAttribute("hidden"),
                touchButtons: document.querySelectorAll("#touch-controller [data-touch-button]").length,
                touchSticks: document.querySelectorAll("#touch-controller [data-touch-stick]").length,
                dpad: document.querySelector("#touch-controller [data-touch-dpad]") !== null,
                modes: [...document.querySelectorAll("#scaling-mode option")].map((option) => ({
                    value: option.getAttribute("value"),
                    label: option.textContent,
                })),
                applyLeftOfCancel: (apply?.left ?? Infinity) < (cancel?.left ?? -Infinity),
                applyEnabled: document.querySelector("#apply-view")?.hasAttribute("disabled") === false,
            };
        });
        await page.selectOption("#scaling-mode", "fullscreen-fit");
        const fullscreenWhileIdle = await page.evaluate(() => ({
            applyDisabled: document.querySelector("#apply-view")?.hasAttribute("disabled"),
            feedback: document.querySelector("#view-feedback")?.textContent,
        }));
        await page.selectOption("#scaling-mode", "fit");
        await page.check("#touch-controller-visible");
        const touchViewPending = await page.evaluate(() => ({
            hidden: document.querySelector("#touch-controller")?.hasAttribute("hidden"),
            stored: localStorage.getItem("psx-runtime:ui:on-screen-controller"),
        }));
        await page.click("#cancel-view");
        await page.waitForFunction(() => document.querySelector("#view-dialog")?.hasAttribute("open") === false);
        const touchViewCanceled = await page.evaluate(() => ({
            hidden: document.querySelector("#touch-controller")?.hasAttribute("hidden"),
            stored: localStorage.getItem("psx-runtime:ui:on-screen-controller"),
        }));
        await page.click("[data-open-dialog='view']");
        await page.waitForFunction(() => document.querySelector("#view-dialog")?.hasAttribute("open"));
        await page.check("#touch-controller-visible");
        await page.click("#apply-view");
        await page.waitForFunction(() => document.querySelector("#view-dialog")?.hasAttribute("open") === false
            && document.querySelector("#touch-controller")?.hasAttribute("hidden") === false
            && document.querySelector("#play-stage")?.getAttribute("data-touch-visible") === "true");
        const touchViewShown = await page.evaluate(() => ({
            hidden: document.querySelector("#touch-controller")?.hasAttribute("hidden"),
            stageVisible: document.querySelector("#play-stage")?.getAttribute("data-touch-visible"),
            stored: localStorage.getItem("psx-runtime:ui:on-screen-controller"),
            notice: document.querySelector("#screen-notice")?.textContent,
            pageFits: document.documentElement.scrollHeight <= document.documentElement.clientHeight,
        }));
        await page.click("[data-open-dialog='view']");
        await page.waitForFunction(() => document.querySelector("#view-dialog")?.hasAttribute("open"));
        await page.uncheck("#touch-controller-visible");
        await page.click("#apply-view");
        await page.waitForFunction(() => document.querySelector("#view-dialog")?.hasAttribute("open") === false
            && document.querySelector("#touch-controller")?.hasAttribute("hidden")
            && document.querySelector("#play-stage")?.getAttribute("data-touch-visible") === "false");
        const touchViewHidden = await page.evaluate(() => ({
            hidden: document.querySelector("#touch-controller")?.hasAttribute("hidden"),
            stageVisible: document.querySelector("#play-stage")?.getAttribute("data-touch-visible"),
            stored: localStorage.getItem("psx-runtime:ui:on-screen-controller"),
            notice: document.querySelector("#screen-notice")?.textContent,
        }));
        await page.click("[data-open-dialog='memory']");
        await page.waitForFunction(() => document.querySelector("#memory-dialog")?.hasAttribute("open"));
        const memoryImportInitial = await page.evaluate(() => ({
            dialogOpen: document.querySelector("#memory-dialog")?.hasAttribute("open"),
            cardOneDisabled: document.querySelector("#import-card-1")?.hasAttribute("disabled"),
            cardTwoDisabled: document.querySelector("#import-card-2")?.hasAttribute("disabled"),
        }));
        const memoryCard = Buffer.alloc(128 * 1024);
        memoryCard[0] = 0x4d;
        memoryCard[1] = 0x43;
        for (let frame = 1; frame <= 15; frame++) {
            const directoryOffset = frame * 128;
            memoryCard[directoryOffset] = 0xa0;
            memoryCard[directoryOffset + 8] = 0xff;
            memoryCard[directoryOffset + 9] = 0xff;
        }
        const directoryOffset = 128;
        memoryCard[directoryOffset] = 0x51;
        memoryCard.writeUInt32LE(8 * 1024, directoryOffset + 4);
        Buffer.from("BASLUS-00000TEST").copy(memoryCard, directoryOffset + 0x0a);
        const dataOffset = 8 * 1024;
        memoryCard[dataOffset] = 0x53;
        memoryCard[dataOffset + 1] = 0x43;
        Buffer.from("Test Save").copy(memoryCard, dataOffset + 4);
        await page.setInputFiles("#memory-card-file", {
            name: "imported-card.mcd",
            mimeType: "application/octet-stream",
            buffer: memoryCard,
        });
        const memoryImportReady = await page.evaluate(() => {
            globalThis.__m12MemoryConfirmations = [];
            globalThis.confirm = (message) => {
                globalThis.__m12MemoryConfirmations.push(String(message));
                return true;
            };
            return {
                feedback: document.querySelector("#memory-feedback")?.textContent,
                cardOneEnabled: document.querySelector("#import-card-1")?.hasAttribute("disabled") === false,
                cardTwoEnabled: document.querySelector("#import-card-2")?.hasAttribute("disabled") === false,
            };
        });
        await page.click("#import-card-1");
        await page.waitForFunction(() => document.querySelector("#memory-feedback")?.getAttribute("data-state")
            === "success");
        const memoryImported = await page.evaluate(() => ({
            feedback: document.querySelector("#memory-feedback")?.textContent,
            cardStatus: document.querySelector("#card-status-1")?.textContent,
            downloadEnabled: document.querySelector("#download-card-1")?.hasAttribute("disabled") === false,
            cardOneEnabled: document.querySelector("#import-card-1")?.hasAttribute("disabled") === false,
            cardTwoEnabled: document.querySelector("#import-card-2")?.hasAttribute("disabled") === false,
            confirmation: globalThis.__m12MemoryConfirmations[0],
            savesVisible: document.querySelector("#card-saves-1")?.hasAttribute("hidden") === false,
            saveTitle: document.querySelector("#card-saves-1 strong")?.textContent,
            saveDetail: document.querySelector("#card-saves-1 span")?.textContent,
        }));
        await page.click("#memory-dialog button[value='cancel']");
        await page.waitForFunction(() => document.querySelector("#memory-dialog")?.hasAttribute("open") === false);
        await page.click("[data-open-dialog='memory']");
        await page.waitForFunction(() => document.querySelector("#memory-dialog")?.hasAttribute("open"));
        const memoryReset = await page.evaluate(() => {
            const input = document.querySelector("#memory-card-file");
            return {
                selectedFiles: input instanceof HTMLInputElement ? input.files?.length : null,
                feedback: document.querySelector("#memory-feedback")?.textContent,
                feedbackState: document.querySelector("#memory-feedback")?.getAttribute("data-state"),
                cardOneDisabled: document.querySelector("#import-card-1")?.hasAttribute("disabled"),
                cardTwoDisabled: document.querySelector("#import-card-2")?.hasAttribute("disabled"),
                summaryVisible: document.querySelector("#card-saves-1")?.hasAttribute("hidden") === false,
                saveTitle: document.querySelector("#card-saves-1 strong")?.textContent,
            };
        });
        await page.click("#memory-dialog button[value='cancel']");
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
            tabsHiddenWithoutSession: document.querySelector("#game-tabs")?.hasAttribute("hidden"),
            importVisibleWithoutSession: document.querySelector("#game-import-panel")?.hasAttribute("hidden") === false,
            sessionHiddenWithoutSession: document.querySelector("#game-session-panel")?.hasAttribute("hidden"),
            activeControls: document.querySelector("#active-game-disc") instanceof HTMLSelectElement
                && document.querySelector("#change-active-disc") instanceof HTMLButtonElement
                && document.querySelector("#restart-active-disc") instanceof HTMLButtonElement
                && document.querySelector("#active-controller-type-1") instanceof HTMLSelectElement
                && document.querySelector("#active-controller-type-2") instanceof HTMLSelectElement
                && document.querySelector("#apply-controller-types") instanceof HTMLButtonElement
                && document.querySelector("#new-state-name") instanceof HTMLInputElement
                && document.querySelector("#save-new-state") instanceof HTMLButtonElement
                && document.querySelector("#state-list") !== null,
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
        await page.click("[data-open-dialog='view']");
        await page.waitForFunction(() => document.querySelector("#view-dialog")?.hasAttribute("open"));
        await page.check("#touch-controller-visible");
        await page.click("#apply-view");
        await page.waitForFunction(() => document.querySelector("#view-dialog")?.hasAttribute("open") === false
            && document.querySelector("#touch-controller")?.hasAttribute("hidden") === false);
        const mobile = await page.evaluate(() => {
            const targets = [
                ...document.querySelectorAll("#touch-controller button"),
                document.querySelector(".touch-dpad"),
                ...document.querySelectorAll(".touch-stick"),
            ].filter((node) => node instanceof HTMLElement);
            const overlaps = targets.flatMap((node, index) => targets.slice(index + 1)
                .filter((candidate) => {
                    const first = node.getBoundingClientRect();
                    const second = candidate.getBoundingClientRect();
                    return first.left < second.right - 0.5 && first.right > second.left + 0.5
                        && first.top < second.bottom - 0.5 && first.bottom > second.top + 0.5;
                })
                .map((candidate) => `${node.getAttribute("data-touch-button") ?? node.className}:${candidate.getAttribute("data-touch-button") ?? candidate.className}`));
            return {
                pageFits: document.documentElement.scrollHeight <= document.documentElement.clientHeight,
                stageWidth: document.querySelector("#screen-stage")?.getBoundingClientRect().width,
                stageHeight: document.querySelector("#screen-stage")?.getBoundingClientRect().height,
                controllerWidth: document.querySelector("#touch-controller")?.getBoundingClientRect().width,
                controllerBelowScreen: (document.querySelector("#screen-stage")?.getBoundingClientRect().bottom ?? Infinity)
                    < (document.querySelector("#touch-controller")?.getBoundingClientRect().top ?? -Infinity),
                controllerDisplay: getComputedStyle(document.querySelector("#touch-controller")).display,
                touchTargetSizes: [...document.querySelectorAll("#touch-controller button")]
                    .map((button) => {
                        const rect = button.getBoundingClientRect();
                        return { width: rect.width, height: rect.height };
                    }),
                overlaps,
                targetSizes: [...document.querySelectorAll(".main-nav button, .session-actions button")]
                    .map((button) => {
                        const rect = button.getBoundingClientRect();
                        return { width: rect.width, height: rect.height };
                    }),
            };
        });
        await page.setViewportSize({ width: 360, height: 800 });
        const compactPortrait = await page.evaluate(() => {
            const targets = [
                ...document.querySelectorAll("#touch-controller button"),
                document.querySelector(".touch-dpad"),
                ...document.querySelectorAll(".touch-stick"),
            ].filter((node) => node instanceof HTMLElement);
            const overlaps = targets.flatMap((node, index) => targets.slice(index + 1)
                .filter((candidate) => {
                    const first = node.getBoundingClientRect();
                    const second = candidate.getBoundingClientRect();
                    return first.left < second.right - 0.5 && first.right > second.left + 0.5
                        && first.top < second.bottom - 0.5 && first.bottom > second.top + 0.5;
                })
                .map((candidate) => `${node.getAttribute("data-touch-button") ?? node.className}:${candidate.getAttribute("data-touch-button") ?? candidate.className}`));
            return {
                pageFits: document.documentElement.scrollHeight <= document.documentElement.clientHeight,
                controllerBelowScreen: (document.querySelector("#screen-stage")?.getBoundingClientRect().bottom ?? Infinity)
                    < (document.querySelector("#touch-controller")?.getBoundingClientRect().top ?? -Infinity),
                overlaps,
            };
        });
        await page.setViewportSize({ width: 360, height: 700 });
        await page.click("[data-open-dialog='memory']");
        await page.waitForFunction(() => document.querySelector("#memory-dialog")?.hasAttribute("open"));
        const portraitModal = await page.evaluate(() => {
            const dialog = document.querySelector("#memory-dialog");
            const content = dialog?.querySelector(".dialog-content");
            if (!(dialog instanceof HTMLDialogElement) || !(content instanceof HTMLElement)) {
                throw new Error("Missing portrait modal scroll surface");
            }
            const rect = dialog.getBoundingClientRect();
            const scrollable = content.scrollHeight > content.clientHeight;
            content.scrollTop = content.scrollHeight;
            return {
                fitsViewport: rect.top >= 0 && rect.bottom <= innerHeight,
                scrollable,
                scrolled: content.scrollTop > 0,
            };
        });
        await page.click("#memory-dialog button[value='cancel']");
        await page.setViewportSize({ width: 844, height: 390 });
        const landscape = await page.evaluate(() => {
            const stage = document.querySelector("#play-stage")?.getBoundingClientRect();
            const screen = document.querySelector("#screen-stage")?.getBoundingClientRect();
            const message = document.querySelector("#stage-message")?.getBoundingClientRect();
            const targets = [
                ...document.querySelectorAll("#touch-controller button"),
                document.querySelector(".touch-dpad"),
                ...document.querySelectorAll(".touch-stick"),
            ].filter((node) => node instanceof HTMLElement);
            const overlaps = targets.flatMap((node, index) => targets.slice(index + 1)
                .filter((candidate) => {
                    const first = node.getBoundingClientRect();
                    const second = candidate.getBoundingClientRect();
                    return first.left < second.right - 0.5 && first.right > second.left + 0.5
                        && first.top < second.bottom - 0.5 && first.bottom > second.top + 0.5;
                })
                .map((candidate) => `${node.getAttribute("data-touch-button") ?? node.className}:${candidate.getAttribute("data-touch-button") ?? candidate.className}`));
            const left = [
                document.querySelector(".touch-shoulders-left"),
                document.querySelector(".touch-stick-group-left"),
                document.querySelector('[data-touch-button="select"]'),
                document.querySelector(".touch-dpad"),
            ].map((node) => node?.getBoundingClientRect());
            const right = [
                document.querySelector(".touch-shoulders-right"),
                document.querySelector(".touch-stick-group-right"),
                document.querySelector('[data-touch-button="start"]'),
                document.querySelector(".touch-face"),
            ].map((node) => node?.getBoundingClientRect());
            return {
                pageFits: document.documentElement.scrollHeight <= document.documentElement.clientHeight,
                screenCentered: stage !== undefined && screen !== undefined
                    && Math.abs((stage.left + stage.width / 2) - (screen.left + screen.width / 2)) < 1,
                messageFits: screen !== undefined && message !== undefined
                    && message.top >= screen.top && message.bottom <= screen.bottom,
                telemetryHidden: getComputedStyle(document.querySelector(".stage-telemetry")).display === "none",
                splitSides: screen !== undefined
                    && left.every((rect) => rect !== undefined && rect.right <= screen.left + 1)
                    && right.every((rect) => rect !== undefined && rect.left >= screen.right - 1),
                selectLeftOfScreen: screen !== undefined
                    && (document.querySelector('[data-touch-button="select"]')?.getBoundingClientRect().right ?? Infinity) <= screen.left + 1,
                startRightOfScreen: screen !== undefined
                    && (document.querySelector('[data-touch-button="start"]')?.getBoundingClientRect().left ?? -Infinity) >= screen.right - 1,
                overlaps,
                touchTargetSizes: [...document.querySelectorAll("#touch-controller button")]
                    .map((button) => {
                        const rect = button.getBoundingClientRect();
                        return { width: rect.width, height: rect.height };
                    }),
            };
        });
        resolveResult({
            ok: desktop.stage === "firmware-required" && desktop.title === "[ FIRMWARE REQUIRED ]"
                && desktop.canvas && desktop.wordmarkAbsent && desktop.gameDisabled && desktop.libraryDisabled && desktop.pageFits
                && desktop.unsupportedSettingsAbsent && system.open && system.slots === 3
                && system.defaultRegion === "ntsc-u" && system.forgetHidden
                && system.systemStopHidden && system.storeHidden
                && system.newFirmware.visible && system.newFirmware.label === "Check And Store"
                && system.newFirmware.enabled && system.hiddenAfterClear
                && controlsInitial.controlsSelected === "true" && controlsInitial.firmwareHidden
                && controlsInitial.controlsVisible && controlsInitial.playerOneRows === 16
                && controlsInitial.playerTwoRows === 16 && controlsInitial.playerOneCrossKey === "Z"
                && controlsInitial.playerTwoUpKey === "I" && controlsInitial.playerOnePad === "No connected gamepad"
                && controlsInitial.assignmentAction === "Change"
                && controlsInitial.playerReset === "Reset Player 1 Mapping" && controlsInitial.allResetDestructive
                && controlsAssigned.label === "M12 Production Pad" && controlsAssigned.status === "success"
                && controlsAssigned.preferredPort === 1 && controlsAssigned.crossButton === "A"
                && controlsCapturing.state === "working" && controlsCapturing.action === "Cancel"
                && controlsCapturing.message?.includes("Press a keyboard key or gamepad button")
                && controlsStored.key === "C" && controlsStored.status === "success"
                && controlsStored.version === 1 && controlsStored.storedControl?.port === 1
                && controlsStored.storedControl?.button === "cross"
                && controlsReloaded.key === "C" && controlsReloaded.storageState === "success"
                && controlsReloaded.storageFeedback?.includes("Stored control mappings loaded")
                && controlsPlayerReset.key === "Z" && controlsPlayerReset.status?.includes("restored to defaults")
                && controlsPlayerReset.stored && controlsPlayerTwo.selected === "true"
                && controlsPlayerTwo.playerOneHidden && controlsPlayerTwo.playerTwoVisible
                && controlsPlayerTwo.upKey === "I" && controlsResetAll.stored === null
                && controlsResetAll.feedback?.includes("Default mappings restored")
                && controlsResetAll.state === "success"
                && firmwareDrop.accepted && firmwareDrop.highlighted === "true"
                && firmwareStored.gameEnabled && firmwareStored.libraryEnabled
                && firmwareStored.feedback === "success" && firmwareStored.dragging === "false"
                && systemDelete.label === "Delete Firmware" && systemDelete.visible
                && systemDelete.destructive && systemDelete.color === "rgb(255, 155, 174)"
                && systemDelete.confirmation?.startsWith("Delete the stored NTSC-U")
                && systemDelete.initialStoreHidden && systemDelete.replacement.visible
                && systemDelete.replacement.label === "Check And Replace"
                && systemDelete.replacement.enabled && systemDelete.hiddenAfterClear
                && systemDelete.systemStop.label === "Stop Session"
                && systemDelete.systemStop.destructive && systemDelete.systemStop.leftOfDelete
                && systemDelete.systemStop.confirmation?.startsWith("Stop the current session?")
                && emptyRegionGate.stage === "firmware-required" && emptyRegionGate.gameDisabled
                && emptyRegionGate.libraryDisabled && emptyRegionGate.deleteHidden && emptyRegionGate.storeHidden
                && storedRegionGate.stage === "ready" && storedRegionGate.gameEnabled
                && storedRegionGate.libraryEnabled && storedRegionGate.deleteVisible && storedRegionGate.storeHidden
                && volumeControl.label === "Volume" && volumeControl.controls === "volume-dialog"
                && volumeControl.open && volumeControl.closed && volumeControl.value === "42"
                && volumeControl.output === "42%" && volumeControl.ranges === 1
                && volumeControl.extraControls === 0
                && touchViewInitial.checked === false && touchViewInitial.hidden
                && touchViewInitial.touchButtons === 12 && touchViewInitial.touchSticks === 2
                && touchViewInitial.dpad && touchViewInitial.applyLeftOfCancel && touchViewInitial.applyEnabled
                && touchViewInitial.modes.some(({ value, label }) => value === "fullscreen-fit" && label === "Fullscreen · Fit")
                && touchViewInitial.modes.some(({ value, label }) => value === "fullscreen-stretch" && label === "Fullscreen · Stretch")
                && fullscreenWhileIdle.applyDisabled
                && fullscreenWhileIdle.feedback === "Start a game before applying a fullscreen presentation."
                && touchViewPending.hidden && touchViewPending.stored === null
                && touchViewCanceled.hidden && touchViewCanceled.stored === null
                && !touchViewShown.hidden
                && touchViewShown.stageVisible === "true" && touchViewShown.stored === "true"
                && touchViewShown.notice === "View applied: Fit." && touchViewShown.pageFits
                && touchViewHidden.hidden
                && touchViewHidden.stageVisible === "false" && touchViewHidden.stored === "false"
                && touchViewHidden.notice === "View applied: Fit."
                && memoryImportInitial.dialogOpen && memoryImportInitial.cardOneDisabled
                && memoryImportInitial.cardTwoDisabled
                && memoryImportReady.feedback?.includes("ready. Choose the card slot")
                && memoryImportReady.cardOneEnabled && memoryImportReady.cardTwoEnabled
                && memoryImported.feedback?.includes("Imported “imported-card.mcd” to Card 1")
                && memoryImported.cardStatus?.includes("1 save · 1/15 blocks used")
                && memoryImported.cardStatus?.includes("revision 1") && memoryImported.downloadEnabled
                && memoryImported.cardOneEnabled && memoryImported.cardTwoEnabled
                && memoryImported.confirmation === "Replace Card 1 with “imported-card.mcd”?"
                && memoryImported.savesVisible && memoryImported.saveTitle === "Test Save"
                && memoryImported.saveDetail === "BASLUS-00000TEST · 1 block"
                && memoryReset.selectedFiles === 0
                && memoryReset.feedback === "Select a 128 KiB card image to import, or download an existing card."
                && memoryReset.feedbackState === "idle" && memoryReset.cardOneDisabled
                && memoryReset.cardTwoDisabled && memoryReset.summaryVisible
                && memoryReset.saveTitle === "Test Save"
                && gameDrop.accepted && gameDrop.highlighted === "true" && gameSelected.dialogOpen
                && gameSelected.selection === "1 ZIP selected in disc order."
                && gameSelected.archive === "Dropped Game.zip" && gameSelected.dragging === "false"
                && gameSelected.tabsHiddenWithoutSession && gameSelected.importVisibleWithoutSession
                && gameSelected.sessionHiddenWithoutSession && gameSelected.activeControls
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
                && typeof mobile.stageHeight === "number" && mobile.stageHeight > 0
                && typeof mobile.controllerWidth === "number" && mobile.controllerWidth <= 390
                && mobile.controllerBelowScreen && mobile.controllerDisplay === "grid"
                && mobile.touchTargetSizes.every(({ width, height }) => width >= 44 && height >= 44)
                && mobile.overlaps.length === 0
                && mobile.targetSizes.every(({ width, height }) => width >= 36 && height >= 40)
                && compactPortrait.pageFits && compactPortrait.controllerBelowScreen
                && compactPortrait.overlaps.length === 0
                && portraitModal.fitsViewport && portraitModal.scrollable && portraitModal.scrolled
                && landscape.pageFits && landscape.screenCentered && landscape.messageFits
                && landscape.telemetryHidden && landscape.splitSides
                && landscape.selectLeftOfScreen && landscape.startRightOfScreen
                && landscape.overlaps.length === 0
                && landscape.touchTargetSizes.every(({ width, height }) => width >= 44 && height >= 44)
                && pageErrors.length === 0,
            desktop,
            system,
            controlsInitial,
            controlsAssigned,
            controlsCapturing,
            controlsStored,
            controlsReloaded,
            controlsPlayerReset,
            controlsPlayerTwo,
            controlsResetAll,
            firmwareDrop,
            firmwareStored,
            systemDelete,
            emptyRegionGate,
            storedRegionGate,
            volumeControl,
            touchViewInitial,
            fullscreenWhileIdle,
            touchViewPending,
            touchViewCanceled,
            touchViewShown,
            touchViewHidden,
            memoryImportInitial,
            memoryImportReady,
            memoryImported,
            memoryReset,
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
            compactPortrait,
            portraitModal,
            landscape,
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
