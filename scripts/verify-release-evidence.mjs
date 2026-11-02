import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const evidence = JSON.parse(await readFile(new URL("docs/probes/m0-results.json", root), "utf8"));
const automatedOnly = process.argv.includes("--automated");

const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};

assert(evidence.schemaVersion === 1 && evidence.status === "complete", "M0 evidence is incomplete");
assert(Object.values(evidence.probeStatus ?? {}).length === 12
    && Object.values(evidence.probeStatus).every((status) => status === "pass"),
"P1–P12 are not all passing");
assert(evidence.sourceVerification?.pass === true
    && evidence.sourceVerification?.trackedCandidateWorktreesClean === true
    && evidence.sourceVerification?.requiredLicenseFilesPresent === true,
"Source and licence verification is incomplete");
assert(evidence.fixture?.cleanBuildsCompared >= 2 && evidence.fixture?.byteIdentical === true,
"Fixture reproducibility evidence is incomplete");
assert(evidence.builds?.pass === true
    && ["dynarec", "native-assembly", "pthreads", "Asyncify", "hardware-rendering"]
        .every((feature) => evidence.builds.forbiddenRuntimeFeaturesAbsent.includes(feature)),
"Core build feature audit is incomplete");
assert(evidence.realBiosBoot?.pass === true && evidence.realBiosBoot?.realBiosLoaded === true,
"Controlled firmware boot evidence is incomplete");
assert(evidence.workerfs?.correct === true, "WORKERFS random-read evidence is incomplete");
assert(evidence.geometry?.pass === true
    && evidence.geometry.runtimeGeometry.baseWidthSequence.includes(320)
    && evidence.geometry.runtimeGeometry.baseWidthSequence.includes(256)
    && evidence.geometry.nullFrames.retainedFrameState === true,
"Dynamic geometry evidence is incomplete");
assert(evidence.endurance?.pass === true
    && evidence.endurance.durationSecondsPerCase === 60
    && evidence.endurance.repeats === 2
    && evidence.endurance.cases.length === 8
    && evidence.endurance.aggregate.missingVideoCallbacks === 0
    && evidence.endurance.aggregate.audioDriftFrames === 0
    && evidence.endurance.aggregate.simulatedAudioUnderrunFrames === 0,
"NTSC/PAL endurance evidence is incomplete");
assert(evidence.media?.pass === true && evidence.media.deterministic === true
    && evidence.media.xa.underrunFrames === 0 && evidence.media.cdda.underrunFrames === 0,
"XA/CD audio evidence is incomplete");
assert(evidence.memoryCards?.pass === true && evidence.memoryCards.slotBytes === 128 * 1024
    && evidence.memoryCards.persistedHashes.length === 2
    && evidence.memoryCards.restoredBeforeFirstFrame === true,
"Two-card persistence evidence is incomplete");
assert(evidence.stateAndDisc?.pass === true && evidence.stateAndDisc.diskCount === 2
    && evidence.stateAndDisc.deterministicReplay === true
    && evidence.stateAndDisc.restoredDiscTwo === true,
"State/disc evidence is incomplete");
assert(evidence.nearMaximumDisc?.pass === true && evidence.nearMaximumDisc.noFullDiscCopy === true
    && evidence.nearMaximumDisc.logicalDiscBytes >= 800_000_000,
"Near-maximum-disc memory evidence is incomplete");

let manual = null;
if (!automatedOnly) {
    try {
        manual = JSON.parse(await readFile(new URL("docs/probes/m10-manual.json", root), "utf8"));
    } catch {
        throw new Error("Manual M10 evidence is missing; complete docs/release-checklist.md");
    }
    assert(manual.schemaVersion === 1 && manual.physicalInput?.pass === true
        && manual.physicalInput?.concurrentPorts === true
        && manual.physicalInput?.keyboard === true
        && manual.physicalInput?.gamepad === true,
    "Physical input evidence is incomplete");
    assert(manual.audio?.pass === true && manual.audio?.gestureUnlock === true
        && manual.audio?.pcm === true && manual.audio?.xa === true && manual.audio?.cdda === true
        && manual.audio?.synchronized === true,
    "Manual audio evidence is incomplete");
}

console.log(JSON.stringify({
    ok: true,
    mode: automatedOnly ? "automated" : "full",
    probes: Object.keys(evidence.probeStatus).length,
    enduranceCases: evidence.endurance.cases.length,
    manualEvidence: manual !== null,
}));
