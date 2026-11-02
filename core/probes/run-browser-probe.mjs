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
};

if (probe === undefined || !(probe in probes)) {
    console.error("Usage: node core/probes/run-browser-probe.mjs <workerfs|pcsx|beetle|endurance|geometry|media|cards|stateDisc|memory|bios|m4|m6|m7|m8|m9|m10>");
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
    const page = await browser.newPage();
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
            while (document.querySelector("#game-feedback")?.textContent === "Inspecting game ZIP…") {
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
            while (document.querySelector("#game-feedback")?.textContent === "Inspecting game ZIP…") {
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
            return {
                visible: document.querySelector("#entry-choice")?.hasAttribute("hidden") === false,
                entries: [...document.querySelectorAll("#entry-select option")].map((option) => option.textContent),
                feedback: document.querySelector("#game-feedback")?.textContent,
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
        const harness = await page.evaluate(() => ({
            title: document.title,
            buttons: document.querySelectorAll("button").length,
            status: document.querySelector("#status")?.textContent,
            canvas: document.querySelector("#screen") instanceof HTMLCanvasElement,
            topLevelSessionControls: ["pause", "soft-reset", "mute-audio"].every((id) =>
                document.querySelector(`#${id}`)?.closest(".menu-actions") !== null),
            viewControls: document.querySelector("#view-menu")?.getAttribute("aria-controls") === "view-dialog"
                && document.querySelector("#fullscreen-fit")?.textContent === "Fullscreen (Fit)"
                && document.querySelector("#fullscreen-stretch")?.textContent === "Fullscreen (Stretch)",
            deleteConfirmation: document.querySelector("#delete-stored") !== null
                && document.querySelector("#delete-game-dialog #confirm-delete-stored")?.textContent === "Remove game",
            stateManager: document.querySelector("#states-menu")?.getAttribute("aria-controls") === "states-dialog"
                && document.querySelector("#state-list") !== null
                && document.querySelector("#save-new-state")?.textContent === "Save new state"
                && document.querySelector("#state-confirm-dialog #confirm-state-action") !== null
                && document.querySelector("#notice-toast")?.getAttribute("popover") === "manual",
            pauseOverlay: document.querySelector("#pause-overlay")?.textContent === "Paused"
                && document.querySelector("#pause-overlay")?.hasAttribute("hidden") === true,
            libraryStorage: document.querySelector("#library-summary")?.textContent === "No games stored."
                && document.querySelector("#stored-game-details") !== null,
        }));
        resolveResult({
            ok: harness.canvas && harness.buttons >= 10 && harness.status === "idle"
                && harness.topLevelSessionControls && harness.viewControls && harness.deleteConfirmation
                && harness.stateManager && harness.pauseOverlay && harness.libraryStorage
                && gameDrop.accepted && gameDrop.highlighted === "true"
                && gameDrop.dialog === "game-dialog" && gameDrop.state === "selected"
                && gameDrop.dragging === "false" && gameDrop.selection === "Selected: Dragged Game.zip"
                && gameDrop.feedback === "Game ZIP selected. Ready to check and store."
                && gameDrop.titleRemoved && gameDrop.overrideRemoved && gameDrop.conditionalEntryHidden
                && ambiguousEntry.visible && ambiguousEntry.entries.join(",") === "disc-a.cue,disc-b.cue"
                && ambiguousEntry.feedback === "This ZIP has multiple possible entries. Choose one, then run Check And Store."
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
                && pageErrors.length === 0,
            ...harness,
            gameDrop,
            ambiguousEntry,
            automaticallyAssigned,
            captured,
            persisted,
            restored,
            invalidIgnored,
            tabSelected,
            playerOneHidden: playerOneHidden === "",
            playerTwoHidden: playerTwoHidden !== null,
            keyboardListening,
            gamepadListening,
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
