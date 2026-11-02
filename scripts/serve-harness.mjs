import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, extname, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const preloadPath = resolve(root, "harness/preload.local.json");
const port = Number(process.env.PORT ?? 4173);
const mime = new Map([
    [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
    [".json", "application/json; charset=utf-8"], [".wasm", "application/wasm"],
    [".css", "text/css; charset=utf-8"],
]);

let preload = null;
try {
    const parsed = JSON.parse(await readFile(preloadPath, "utf8"));
    const fileEntries = Array.isArray(parsed.files) ? parsed.files.map((item, index) => {
        const source = resolve(typeof item === "string" ? item : item.source);
        const path = typeof item === "string" ? basename(source) : item.path;
        return { source, path, name: basename(path), url: `/__preload/file/${index}` };
    }) : [];
    const biosSource = typeof parsed.bios === "string" ? resolve(parsed.bios) : null;
    preload = {
        manifest: {
            available: true,
            ...(typeof parsed.buildUrl === "string" ? { buildUrl: parsed.buildUrl } : {}),
            ...(typeof parsed.gameId === "string" ? { gameId: parsed.gameId } : {}),
            ...(typeof parsed.entry === "string" ? { entry: parsed.entry } : {}),
            ...(biosSource === null ? {} : {
                bios: {
                    name: basename(biosSource),
                    url: "/__preload/bios",
                    region: typeof parsed.region === "string" ? parsed.region : "ntsc-u",
                },
            }),
            files: fileEntries.map(({ path, name, url }) => ({ path, name, url })),
        },
        biosSource,
        fileEntries,
    };
} catch {
    preload = null;
}

const stream = async (response, path, contentType = "application/octet-stream") => {
    const details = await stat(path);
    if (!details.isFile()) throw new Error("Not a file");
    response.writeHead(200, { "content-type": contentType, "content-length": details.size, "cache-control": "no-store" });
    createReadStream(path).pipe(response);
};

const server = createServer((request, response) => {
    void (async () => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/__preload") {
            response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            response.end(JSON.stringify(preload?.manifest ?? { available: false }));
            return;
        }
        if (url.pathname === "/__preload/bios" && preload?.biosSource !== null && preload?.biosSource !== undefined) {
            await stream(response, preload.biosSource);
            return;
        }
        const fileMatch = /^\/__preload\/file\/(\d+)$/u.exec(url.pathname);
        if (fileMatch !== null && preload !== null) {
            const entry = preload.fileEntries[Number(fileMatch[1])];
            if (entry !== undefined) { await stream(response, entry.source); return; }
        }
        const relative = url.pathname === "/"
            ? "harness/index.html"
            : url.pathname.startsWith("/harness-build/")
                ? `dist${url.pathname}`
                : url.pathname.slice(1);
        if (relative.includes("..")) throw new Error("Unsafe path");
        const path = resolve(root, relative);
        if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Unsafe path");
        await stream(response, path, mime.get(extname(path)) ?? "application/octet-stream");
    })().catch(() => {
        if (!response.headersSent) response.writeHead(404);
        response.end();
    });
});

server.listen(port, "127.0.0.1", () => {
    console.log(`Harness: http://127.0.0.1:${port}`);
});
