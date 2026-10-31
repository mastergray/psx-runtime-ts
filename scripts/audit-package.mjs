import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const build = JSON.parse(await readFile(new URL("core/build.json", root), "utf8"));
const source = JSON.parse(await readFile(new URL("core/SOURCE.json", root), "utf8"));

const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
});
if (packed.status !== 0) throw new Error(packed.stderr || "npm pack --dry-run failed");
const report = JSON.parse(packed.stdout)[0];
if (report === undefined || !Array.isArray(report.files)) throw new Error("npm pack returned invalid JSON");
const paths = report.files.map(({ path }) => path);

const required = [
    "LICENSE",
    "README.md",
    "package.json",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/worker/core.worker.js",
    "dist/PsxGameStore/hash.worker.js",
];
for (const path of required) {
    if (!paths.includes(path)) throw new Error(`Package is missing required file: ${path}`);
}

const allowedRoot = /^(?:LICENSE|README\.md|package\.json|dist\/|src\/)/u;
const forbiddenPath = /(?:^|\/)(?:core|harness|fixtures|test-discs|\.cache|res)(?:\/|$)|preload\.local/iu;
const forbiddenExtension = /\.(?:7z|bin|chd|cue|ecm|img|iso|m3u|mcd|mcr|pbp|rar|sbi|srm|state|sub|wasm|zip)$/iu;
for (const path of paths) {
    if (!allowedRoot.test(path)) throw new Error(`Package path is outside the allowlist: ${path}`);
    if (forbiddenPath.test(path) || forbiddenExtension.test(path)) {
        throw new Error(`Package contains forbidden private or generated content: ${path}`);
    }
}

const exportKeys = Object.keys(packageJson.exports ?? {}).sort();
if (JSON.stringify(exportKeys) !== JSON.stringify([".", "./package.json"])) {
    throw new Error(`Unexpected package exports: ${exportKeys.join(", ")}`);
}
if (source.license !== "GPL-2.0-or-later") throw new Error("Selected core license pin is missing");
for (const license of build.licenses ?? []) {
    if (typeof license.notice !== "string" || license.notice.includes("..")) {
        throw new Error("Core build has an invalid notice path");
    }
    await access(new URL(license.notice, root));
}
await access(new URL("docs/core-distribution.md", root));

console.log(JSON.stringify({
    ok: true,
    files: paths.length,
    bytes: report.unpackedSize,
    exports: exportKeys,
    coreIncluded: paths.some((path) => path.startsWith("dist/core/")),
    notices: build.licenses.map(({ id }) => id),
}));
