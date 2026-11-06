import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const outputDirectory = new URL("../core/.cache/m2/", import.meta.url);
mkdirSync(outputDirectory, { recursive: true });
const executable = new URL("shim-test", outputDirectory);
const compiler = process.env.CC ?? "cc";
const root = new URL("../", import.meta.url);
const compile = spawnSync(compiler, [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-pedantic",
    "-I", new URL("libretro/include/", root).pathname,
    "-I", new URL("libretro/shim/", root).pathname,
    new URL("libretro/shim/psx_disc_io.c", root).pathname,
    new URL("libretro/shim/psx_frontend.c", root).pathname,
    new URL("libretro/shim/psx_exports.c", root).pathname,
    new URL("tests/native/fake_libretro_core.c", root).pathname,
    new URL("tests/native/shim_test.c", root).pathname,
    "-o", executable.pathname,
], { encoding: "utf8" });

if (compile.status !== 0) {
    process.stderr.write(compile.stdout);
    process.stderr.write(compile.stderr);
    process.exit(compile.status ?? 1);
}

const run = spawnSync(executable.pathname, [], { encoding: "utf8" });
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
process.exit(run.status ?? 1);
