import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const port = Number(process.env.PORT ?? 4175);
const host = process.env.PSX_UI_HOST ?? "127.0.0.1";
const mime = new Map([
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".wasm", "application/wasm"],
    [".css", "text/css; charset=utf-8"],
    [".svg", "image/svg+xml; charset=utf-8"],
]);

const server = createServer((request, response) => {
    void (async () => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const relative = url.pathname === "/"
            ? "ui/index.html"
            : url.pathname.startsWith("/ui-build/")
                ? `dist${url.pathname}`
                : url.pathname.slice(1);
        if (relative.includes("..")) throw new Error("Unsafe path");
        const path = resolve(root, relative);
        if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Unsafe path");
        const details = await stat(path);
        if (!details.isFile()) throw new Error("Not a file");
        response.writeHead(200, {
            "content-type": mime.get(extname(path)) ?? "application/octet-stream",
            "content-length": details.size,
            "cache-control": "no-store",
        });
        createReadStream(path).pipe(response);
    })().catch(() => {
        if (!response.headersSent) response.writeHead(404);
        response.end();
    });
});

server.listen(port, host, () => {
    console.log(`Web emulator: http://${host}:${port}`);
});
