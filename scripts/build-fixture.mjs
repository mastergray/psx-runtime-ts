import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { strToU8, zipSync } from "fflate";

const repositoryRoot = resolve(import.meta.dirname, "..");
const fixtureRoot = resolve(repositoryRoot, "tests/fixtures/homebrew");
const generatedRoot = resolve(repositoryRoot, "tests/fixtures/generated/m0");
const manifest = JSON.parse(await readFile(resolve(fixtureRoot, "TOOLCHAIN.json"), "utf8"));
const sdkRoot = process.env.PSN00BSDK_ROOT;

if (sdkRoot === undefined || sdkRoot.length === 0) {
    throw new Error("PSN00BSDK_ROOT must name the extracted SDK directory");
}

if (process.env.PSN00BSDK_ARCHIVE !== undefined) {
    const archive = await readFile(resolve(process.env.PSN00BSDK_ARCHIVE));
    const actualDigest = createHash("sha256").update(archive).digest("hex");
    if (actualDigest !== manifest.archiveSha256) {
        throw new Error(`PSn00bSDK archive digest mismatch: ${actualDigest}`);
    }
}

const sdk = resolve(sdkRoot);
const bin = resolve(sdk, "bin");
const compiler = resolve(bin, "mipsel-none-elf-gcc");
const imageBuilder = resolve(bin, "mkpsxiso");
const toolchain = resolve(sdk, "lib/libpsn00b/cmake/sdk.cmake");
const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
};

const run = (command, args, cwd = repositoryRoot) => {
    const result = spawnSync(command, args, {
        cwd,
        env: environment,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
        throw new Error(`${command} failed\n${result.stdout}${result.stderr}`);
    }
    return result.stdout.trim();
};

const compilerVersion = run(compiler, ["--version"]).split("\n", 1)[0];
if (compilerVersion !== manifest.compiler) {
    throw new Error(`Unexpected fixture compiler: ${compilerVersion}`);
}

const fixedTimestamp = new Date("2000-01-01T00:00:00.000Z");

const createCddaTone = () => {
    const sampleRate = 44_100;
    const channels = 2;
    const durationSeconds = 6;
    const frames = sampleRate * durationSeconds;
    const dataBytes = frames * channels * 2;
    const wave = Buffer.alloc(44 + dataBytes);
    wave.write("RIFF", 0, "ascii");
    wave.writeUInt32LE(36 + dataBytes, 4);
    wave.write("WAVEfmt ", 8, "ascii");
    wave.writeUInt32LE(16, 16);
    wave.writeUInt16LE(1, 20);
    wave.writeUInt16LE(channels, 22);
    wave.writeUInt32LE(sampleRate, 24);
    wave.writeUInt32LE(sampleRate * channels * 2, 28);
    wave.writeUInt16LE(channels * 2, 32);
    wave.writeUInt16LE(16, 34);
    wave.write("data", 36, "ascii");
    wave.writeUInt32LE(dataBytes, 40);

    for (let frame = 0; frame < frames; frame++) {
        const sample = (frame * 880) % sampleRate < sampleRate / 2 ? 12_000 : -12_000;
        wave.writeInt16LE(sample, 44 + frame * 4);
        wave.writeInt16LE(sample, 46 + frame * 4);
    }
    return wave;
};

const createXaTone = () => {
    const sectorBytes = 2336;
    const sectorCount = 900;
    const sampleRate = 37_800;
    const xa = Buffer.alloc(sectorBytes * sectorCount);

    for (let sector = 0; sector < sectorCount; sector++) {
        const sectorOffset = sector * sectorBytes;
        const channel = sector % 8;
        const submode = sector === sectorCount - 1 ? 0xe5 : 0x64;
        for (const offset of [0, 4]) {
            xa[sectorOffset + offset] = 1;
            xa[sectorOffset + offset + 1] = channel;
            xa[sectorOffset + offset + 2] = submode;
            xa[sectorOffset + offset + 3] = 1;
        }

        if (channel !== 0) continue;
        const channelSector = Math.floor(sector / 8);
        for (let group = 0; group < 18; group++) {
            const groupOffset = sectorOffset + 8 + group * 128;
            for (let unit = 0; unit < 4; unit++) {
                for (let sample = 0; sample < 28; sample++) {
                    const sampleIndex = channelSector * 2016 + group * 112 + unit * 28 + sample;
                    const nibble = (sampleIndex * 440) % sampleRate < sampleRate / 2 ? 5 : 11;
                    const word = Math.floor(sample / 4);
                    const position = sample % 4;
                    const dataOffset = groupOffset + 16 + unit + word * 16 + position * 4;
                    xa[dataOffset] = nibble | (nibble << 4);
                }
            }
        }
    }
    return xa;
};

const buildFixture = async ({
    cards = false,
    dynamicGeometry = false,
    media = false,
    multiDisc = false,
    outputRoot,
    pal = false,
    projectFile = "iso.xml",
    variant,
}) => {
    await rm(outputRoot, { recursive: true, force: true });
    run("cmake", [
        "-S", fixtureRoot,
        "-B", outputRoot,
        "-G", "Unix Makefiles",
        "-DCMAKE_BUILD_TYPE=Release",
        `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`,
        `-DPSN00BSDK_TC=${sdk}`,
        `-DPSX_FIXTURE_PAL=${pal ? "ON" : "OFF"}`,
        `-DPSX_FIXTURE_DYNAMIC_GEOMETRY=${dynamicGeometry ? "ON" : "OFF"}`,
        `-DPSX_FIXTURE_MEDIA=${media ? "ON" : "OFF"}`,
        `-DPSX_FIXTURE_CARDS=${cards ? "ON" : "OFF"}`,
        `-DPSX_FIXTURE_MULTIDISC=${multiDisc ? "ON" : "OFF"}`,
    ]);
    run("cmake", ["--build", outputRoot, "--parallel", "--clean-first"]);

    const stagedSystem = resolve(outputRoot, "system.cnf");
    const stagedLicense = resolve(outputRoot, "LICENSE");
    const stagedProject = resolve(outputRoot, "iso.xml");
    const executable = resolve(outputRoot, "m0-fixture.exe");
    await Promise.all([
        copyFile(resolve(fixtureRoot, "system.cnf"), stagedSystem),
        copyFile(resolve(fixtureRoot, "LICENSE"), stagedLicense),
        copyFile(resolve(fixtureRoot, projectFile), stagedProject),
    ]);
    const generatedMedia = media
        ? [
            writeFile(resolve(outputRoot, "cdda-tone.wav"), createCddaTone()),
            writeFile(resolve(outputRoot, "xa-tone.xa"), createXaTone()),
        ]
        : [];
    await Promise.all(generatedMedia);
    await Promise.all([
        utimes(stagedSystem, fixedTimestamp, fixedTimestamp),
        utimes(stagedLicense, fixedTimestamp, fixedTimestamp),
        utimes(stagedProject, fixedTimestamp, fixedTimestamp),
        utimes(executable, fixedTimestamp, fixedTimestamp),
        ...(media
            ? [
                utimes(resolve(outputRoot, "cdda-tone.wav"), fixedTimestamp, fixedTimestamp),
                utimes(resolve(outputRoot, "xa-tone.xa"), fixedTimestamp, fixedTimestamp),
            ]
            : []),
    ]);
    run(imageBuilder, ["-y", stagedProject], outputRoot);

    const cuePath = resolve(outputRoot, "m0-fixture.cue");
    const binPath = resolve(outputRoot, "m0-fixture.bin");
    const [cue, image] = await Promise.all([readFile(cuePath), readFile(binPath)]);
    return {
        variant,
        cueSha256: createHash("sha256").update(cue).digest("hex"),
        binSha256: createHash("sha256").update(image).digest("hex"),
        binBytes: image.byteLength,
    };
};

const fixtures = [];
for (const configuration of [
    { dynamicGeometry: false, outputRoot: generatedRoot, pal: false, variant: "ntsc" },
    { dynamicGeometry: false, outputRoot: resolve(generatedRoot, "pal"), pal: true, variant: "pal" },
    {
        dynamicGeometry: true,
        outputRoot: resolve(generatedRoot, "geometry"),
        pal: false,
        variant: "dynamic-geometry",
    },
    {
        media: true,
        outputRoot: resolve(generatedRoot, "media"),
        projectFile: "iso-media.xml",
        variant: "xa-cdda",
    },
    {
        cards: true,
        outputRoot: resolve(generatedRoot, "cards"),
        variant: "memory-cards",
    },
    {
        multiDisc: true,
        outputRoot: resolve(generatedRoot, "multidisc/disc1"),
        projectFile: "iso-multidisc-one.xml",
        variant: "multidisc-one",
    },
    {
        multiDisc: true,
        outputRoot: resolve(generatedRoot, "multidisc/disc2"),
        projectFile: "iso-multidisc-two.xml",
        variant: "multidisc-two",
    },
]) {
    fixtures.push(await buildFixture(configuration));
}

const buildDiagnosticDisc = async ({ directory, executable, project }) => {
    await mkdir(directory, { recursive: true });
    const stagedExecutable = resolve(directory, executable);
    const stagedSystem = resolve(directory, "diagnostic-system.cnf");
    const stagedLicense = resolve(directory, "LICENSE");
    const stagedProject = resolve(directory, "iso.xml");
    await Promise.all([
        copyFile(resolve(generatedRoot, executable), stagedExecutable),
        copyFile(resolve(fixtureRoot, "diagnostic-system.cnf"), stagedSystem),
        copyFile(resolve(fixtureRoot, "LICENSE"), stagedLicense),
        copyFile(resolve(fixtureRoot, project), stagedProject),
    ]);
    await Promise.all([stagedExecutable, stagedSystem, stagedLicense, stagedProject]
        .map((path) => utimes(path, fixedTimestamp, fixedTimestamp)));
    run(imageBuilder, ["-y", stagedProject], directory);
};

const diagnosticsRoot = resolve(generatedRoot, "diagnostics");
const controllerRoot = resolve(diagnosticsRoot, "controller");
const audioRoot = resolve(diagnosticsRoot, "audio");
await Promise.all([
    buildDiagnosticDisc({
        directory: controllerRoot,
        executable: "controller-test.exe",
        project: "iso-controller.xml",
    }),
    buildDiagnosticDisc({
        directory: audioRoot,
        executable: "audio-test.exe",
        project: "iso-audio.xml",
    }),
]);

const playlist = "controller/controller-test.cue\naudio/audio-test.cue\n";
const playlistPath = resolve(diagnosticsRoot, "psx-runtime-diagnostics.m3u");
await writeFile(playlistPath, playlist);
await utimes(playlistPath, fixedTimestamp, fixedTimestamp);
const [controllerCue, controllerBin, audioCue, audioBin] = await Promise.all([
    readFile(resolve(controllerRoot, "controller-test.cue")),
    readFile(resolve(controllerRoot, "controller-test.bin")),
    readFile(resolve(audioRoot, "audio-test.cue")),
    readFile(resolve(audioRoot, "audio-test.bin")),
]);
const zipOptions = { level: 6, mtime: fixedTimestamp };
const archive = zipSync({
    "psx-runtime-diagnostics.m3u": [strToU8(playlist), zipOptions],
    "controller/controller-test.cue": [controllerCue, zipOptions],
    "controller/controller-test.bin": [controllerBin, zipOptions],
    "audio/audio-test.cue": [audioCue, zipOptions],
    "audio/audio-test.bin": [audioBin, zipOptions],
});
const archivePath = resolve(generatedRoot, "psx-runtime-diagnostics.zip");
await writeFile(archivePath, archive);
await utimes(archivePath, fixedTimestamp, fixedTimestamp);

console.log(JSON.stringify({
    toolchain: manifest.version,
    compiler: compilerVersion,
    fixtures,
    diagnostics: {
        discs: 2,
        entry: "psx-runtime-diagnostics.m3u",
        archiveBytes: archive.byteLength,
        archiveSha256: createHash("sha256").update(archive).digest("hex"),
    },
}));
