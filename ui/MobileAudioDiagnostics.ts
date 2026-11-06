// Type dependencies:
import type {
    PsxAudioBackend,        // Realized browser audio output implementation
    PsxAudioBufferMode,     // Production-facing buffering preference
    PsxDiagnosticVariant,   // Production execution path or explicit development comparison
    PsxMachineInfo,         // Active core, build, game, and AV identity
    PsxPerformanceTiming,   // Approximately one-second worker performance window
} from "../src/index.js";

/**
 *
 * Type Declarations
 *
 */

// INTERFACE :: {machine:psxMachineInfo, variant:psxDiagnosticVariant, bufferMode:psxAudioBufferMode, startedAtMs:NUMBER, href:STRING, userAgent:STRING, hardwareConcurrency:NUMBER?, deviceMemory:NUMBER?}
// Immutable identity and browser configuration captured before one diagnostic run.
export interface MobileAudioDiagnosticConfig {
    readonly machine: PsxMachineInfo;              // Core build and active content identity
    readonly variant: PsxDiagnosticVariant;        // Production path or one explicit development comparison
    readonly bufferMode: PsxAudioBufferMode;       // Independent production buffering selection
    readonly startedAtMs: number;                  // Main-realm monotonic start time
    readonly href: string;                         // Served application location
    readonly userAgent: string;                    // Browser and platform identity
    readonly hardwareConcurrency?: number;         // Browser-exposed logical processor count
    readonly deviceMemory?: number;                // Browser-exposed approximate GiB when available
}

// INTERFACE :: {capturedAtMs:NUMBER, performance:psxPerformanceTiming?, backend:psxAudioBackend, deviceSampleRate:NUMBER?, queuedMs:NUMBER, underrunCount:NUMBER, starvationMs:NUMBER?, longestStarvationMs:NUMBER?, droppedSamples:NUMBER, productionRate:NUMBER?, maximumSoundGapMs:NUMBER, transportSamples:NUMBER, productionToPostAverageMs:NUMBER?, postToReceiptAverageMs:NUMBER?, transportAverageMs:NUMBER?, transportMaximumMs:NUMBER?}
// One bounded observation captured without opening or mutating the running session.
export interface MobileAudioDiagnosticSnapshot {
    readonly capturedAtMs: number;                 // Main-realm monotonic sample time
    readonly performance: PsxPerformanceTiming | null; // Latest completed worker window
    readonly backend: PsxAudioBackend;             // Active Web Audio implementation
    readonly deviceSampleRate: number | null;      // Realized browser output rate
    readonly queuedMs: number;                     // Current queued output duration
    readonly underrunCount: number;                // Cumulative starvation episodes
    readonly starvationMs: number | null;          // Cumulative post-start silent output duration
    readonly longestStarvationMs: number | null;   // Longest contiguous starvation episode
    readonly droppedSamples: number;               // Cumulative interleaved samples discarded for latency
    readonly productionRate: number | null;        // Rolling source production divided by wall time
    readonly maximumSoundGapMs: number;             // Largest recent main-thread PCM arrival gap
    readonly transportSamples: number;             // Instrumented PCM payload timings received
    readonly productionToPostAverageMs: number | null; // Average completed-PCM hold before post
    readonly postToReceiptAverageMs: number | null; // Average endpoint-post to main receipt
    readonly transportAverageMs: number | null;    // Average completed-PCM to main receipt
    readonly transportMaximumMs: number | null;    // Longest completed-PCM to main receipt
}

// INTERFACE :: {filename:STRING, mimeType:STRING, text:STRING}
// One downloadable diagnostics artifact generated entirely in memory.
export interface MobileAudioDiagnosticFile {
    readonly filename: string;    // Suggested local download name
    readonly mimeType: string;    // Browser Blob media type
    readonly text: string;        // Complete serialized content
}

// INTERFACE :: {report:diagnosticReport, startedAtMs:NUMBER, lastPerformance:psxPerformanceTiming?, latestSnapshot:mobileAudioDiagnosticSnapshot?, queueMinimumMs:NUMBER, lastBackend:psxAudioBackend?, measuresDiscIo:BOOLEAN}
// Recorder-owned state accumulated in the background until explicit session teardown.
interface ActiveRun {
    readonly report: DiagnosticReport;                    // JSON report under construction
    readonly startedAtMs: number;                         // Main-realm monotonic start
    lastPerformance: PsxPerformanceTiming | null;         // Last worker window already recorded
    latestSnapshot: MobileAudioDiagnosticSnapshot | null; // Most recent audio observation
    queueMinimumMs: number;                               // Lowest polled queue in the current bucket
    lastBackend: PsxAudioBackend | null;                  // Backend used to detect lifecycle changes
    measuresDiscIo: boolean;                              // Whether disc and transport counters are available
}

// INTERFACE :: {schemaVersion:1, identity:ARRAY<STRING, UNKNOWN>, environment:ARRAY<STRING, UNKNOWN>, configuration:ARRAY<STRING, UNKNOWN>, measurementInterval:ARRAY<STRING, UNKNOWN>, summary:ARRAY<STRING, UNKNOWN>, buckets:[diagnosticBucket], events:[diagnosticEvent], listenerObservations:[UNKNOWN], limitations:[STRING]}
// Stable top-level diagnostic groups required by the private D0 specification.
interface DiagnosticReport {
    readonly schemaVersion: 1;
    readonly identity: Record<string, unknown>;
    readonly environment: Record<string, unknown>;
    readonly configuration: Record<string, unknown>;
    readonly measurementInterval: Record<string, unknown>;
    summary: Record<string, unknown>;
    readonly buckets: DiagnosticBucket[];
    readonly events: DiagnosticEvent[];
    readonly listenerObservations: unknown[];
    readonly limitations: string[];
}

// TYPE :: ARRAY<STRING, NUMBER|STRING|NULL>
// Compact row shared by the JSON report and CSV export.
type DiagnosticBucket = Record<string, number | string | null>;

// INTERFACE :: {elapsedMs:NUMBER, type:STRING, value:STRING}
// Low-volume lifecycle or backend transition marker.
interface DiagnosticEvent {
    readonly elapsedMs: number;    // Milliseconds since run start
    readonly type: string;         // Stable event family
    readonly value: string;        // Human-readable event value
}

/**
 *
 * Class
 *
 */

// Records bounded mobile-audio diagnostics without logging per frame or touching runtime lifecycle.
export default class MobileAudioDiagnostics {

    /* Instance Fields */
    private _active: ActiveRun | null = null;              // Run currently sampled in the background
    private _completed: DiagnosticReport | null = null;    // Most recently finalized report retained after stop

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> BOOLEAN
    // True while a session-owned report is accepting observations.
    get isActive(): boolean { return this._active !== null; }

    // GETTER :: VOID -> BOOLEAN
    // True when a finalized report can be downloaded after session stop.
    get hasCompleted(): boolean { return this._completed !== null; }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: mobileAudioDiagnosticConfig -> VOID
    // Starts one fresh report and replaces no completed artifact until finalization.
    start(config: MobileAudioDiagnosticConfig): void {
        if (this._active !== null) return;
        const report: DiagnosticReport = {
            schemaVersion: 1,
            identity: {
                runId: createRunId(config.startedAtMs),
                buildId: config.machine.buildId,
                core: config.machine.core,
                coreVersion: config.machine.coreVersion,
                gameId: config.machine.gameId,
                variant: config.variant,
            },
            environment: {
                href: config.href,
                userAgent: config.userAgent,
                hardwareConcurrency: config.hardwareConcurrency ?? null,
                deviceMemoryGiB: config.deviceMemory ?? null,
            },
            configuration: {
                audioBufferMode: config.bufferMode,
                framesPerSecond: config.machine.framesPerSecond,
                sourceSampleRate: config.machine.sampleRate,
                region: config.machine.region,
            },
            measurementInterval: {
                startedAtIso: new Date().toISOString(),
                startedAtMonotonicMs: config.startedAtMs,
                endedAtIso: null,
                durationMs: null,
            },
            summary: {},
            buckets: [],
            events: [{ elapsedMs: 0, type: "lifecycle", value: "running" }],
            listenerObservations: [],
            limitations: [
                "Worker percentiles and bounded detailed traces are deferred to extended D0.",
                "Cross-realm transport timing uses monotonic epoch clocks and records durations rather than raw timestamps.",
                "Queue occupancy is polled on the main thread and may miss render-quantum minima.",
            ],
        };
        this._active = {
            report,
            startedAtMs: config.startedAtMs,
            lastPerformance: null,
            latestSnapshot: null,
            queueMinimumMs: Number.POSITIVE_INFINITY,
            lastBackend: null,
            measuresDiscIo: config.variant === "instrumented" || config.variant === "sequential-read-reuse",
        };
    }

    // METHOD :: STRING, NUMBER -> VOID
    // Adds one low-volume lifecycle marker to the active report.
    event(value: string, capturedAtMs: number): void {
        const active = this._active;
        if (active === null) return;
        active.report.events.push({
            elapsedMs: Math.max(0, capturedAtMs - active.startedAtMs),
            type: "lifecycle",
            value,
        });
    }

    // METHOD :: mobileAudioDiagnosticSnapshot -> VOID
    // Polls queue state and records each newly completed approximately one-second worker window once.
    observe(snapshot: MobileAudioDiagnosticSnapshot): void {
        const active = this._active;
        if (active === null) return;
        active.latestSnapshot = snapshot;
        active.queueMinimumMs = Math.min(active.queueMinimumMs, snapshot.queuedMs);
        if (snapshot.backend !== active.lastBackend) {
            active.lastBackend = snapshot.backend;
            active.report.events.push({
                elapsedMs: Math.max(0, snapshot.capturedAtMs - active.startedAtMs),
                type: "audio-backend",
                value: snapshot.backend,
            });
        }
        const performance = snapshot.performance;
        if (performance === null || performance === active.lastPerformance) return;
        active.lastPerformance = performance;
        active.report.buckets.push(createBucket(
            active.report.buckets.length,
            Math.max(0, snapshot.capturedAtMs - active.startedAtMs),
            Number.isFinite(active.queueMinimumMs) ? active.queueMinimumMs : snapshot.queuedMs,
            performance,
            snapshot,
            active.measuresDiscIo,
        ));
        active.queueMinimumMs = snapshot.queuedMs;
    }

    // METHOD :: mobileAudioDiagnosticSnapshot?, STRING -> VOID
    // Finalizes and retains the active report so it remains downloadable after runtime teardown.
    finish(snapshot: MobileAudioDiagnosticSnapshot | null, reason: string): void {
        const active = this._active;
        if (active === null) return;
        if (snapshot !== null) this.observe(snapshot);
        const endedAtMs = snapshot?.capturedAtMs ?? performance.now();
        active.report.events.push({
            elapsedMs: Math.max(0, endedAtMs - active.startedAtMs),
            type: "lifecycle",
            value: reason,
        });
        active.report.measurementInterval.endedAtIso = new Date().toISOString();
        active.report.measurementInterval.durationMs = Math.max(0, endedAtMs - active.startedAtMs);
        active.report.summary = summarize(active.report.buckets, snapshot ?? active.latestSnapshot);
        if ((snapshot ?? active.latestSnapshot)?.starvationMs === null) {
            active.report.limitations.push("Starvation duration is unavailable when the scheduled-source fallback backend is active.");
        }
        this._completed = active.report;
        this._active = null;
    }

    // METHOD :: VOID -> [mobileAudioDiagnosticFile]
    // Serializes the retained completed report as JSON and compact bucket CSV.
    files(): ReadonlyArray<MobileAudioDiagnosticFile> {
        const report = this._completed;
        if (report === null) return [];
        const stem = `psx-mobile-audio-${String(report.identity.runId)}`;
        return [
            {
                filename: `${stem}.json`,
                mimeType: "application/json;charset=utf-8",
                text: `${JSON.stringify(report, null, 2)}\n`,
            },
            {
                filename: `${stem}.csv`,
                mimeType: "text/csv;charset=utf-8",
                text: bucketsToCsv(report.buckets),
            },
        ];
    }
}

/**
 *
 *  Helper Functions
 *
 */

const CSV_FIELDS = Object.freeze([
    "index", "elapsedMs", "frames", "batches", "coreAverageMs", "workerAverageMs",
    "workerMaximumMs", "batchAverageFrames", "batchAverageMs", "batchMaximumMs",
    "pcmHoldAverageMs", "pcmHoldMaximumMs", "discReadCalls", "discReadRequestedBytes",
    "discReadReturnedBytes", "discReadMilliseconds", "discSeekCalls", "discSeekMilliseconds",
    "productionRate", "queuedMs", "queueMinimumMs", "underrunCount", "starvationMs",
    "longestStarvationMs", "droppedSamples", "maximumSoundGapMs", "transportAverageMs",
    "transportMaximumMs", "backend",
] as const);

// HELPER :: NUMBER -> STRING
// Creates a collision-resistant local run identity without requiring network or storage access.
const createRunId = (startedAtMs: number): string => {
    try {
        if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
    } catch { /* Monotonic fallback remains available. */ }
    return `${Date.now().toString(36)}-${Math.round(startedAtMs * 1000).toString(36)}`;
};

// HELPER :: NUMBER, NUMBER, NUMBER, psxPerformanceTiming, mobileAudioDiagnosticSnapshot, BOOLEAN -> diagnosticBucket
// Flattens one worker window and its nearest output observation into a stable export row.
const createBucket = (
    index: number,
    elapsedMs: number,
    queueMinimumMs: number,
    worker: PsxPerformanceTiming,
    audio: MobileAudioDiagnosticSnapshot,
    measuresDiscIo: boolean,
): DiagnosticBucket => ({
    index,
    elapsedMs,
    frames: worker.frames,
    batches: worker.batches,
    coreAverageMs: worker.coreAverageMs,
    extractionAverageMs: worker.extractionAverageMs,
    videoAverageMs: worker.videoAverageMs,
    audioAverageMs: worker.audioAverageMs,
    workerAverageMs: worker.workerAverageMs,
    workerMaximumMs: worker.workerMaximumMs,
    batchAverageFrames: worker.batchAverageFrames,
    batchMaximumFrames: worker.batchMaximumFrames,
    batchAverageMs: worker.batchAverageMs,
    batchMaximumMs: worker.batchMaximumMs,
    turnaroundAverageMs: worker.turnaroundAverageMs,
    turnaroundMaximumMs: worker.turnaroundMaximumMs,
    pcmHoldAverageMs: worker.pcmHoldAverageMs,
    pcmHoldMaximumMs: worker.pcmHoldMaximumMs,
    discReadCalls: measuresDiscIo ? worker.discReadCalls : null,
    discReadRequestedBytes: measuresDiscIo ? worker.discReadRequestedBytes : null,
    discReadReturnedBytes: measuresDiscIo ? worker.discReadReturnedBytes : null,
    discReadMilliseconds: measuresDiscIo ? worker.discReadMilliseconds : null,
    discSeekCalls: measuresDiscIo ? worker.discSeekCalls : null,
    discSeekMilliseconds: measuresDiscIo ? worker.discSeekMilliseconds : null,
    backend: audio.backend,
    deviceSampleRate: audio.deviceSampleRate,
    productionRate: audio.productionRate,
    queuedMs: audio.queuedMs,
    queueMinimumMs,
    underrunCount: audio.underrunCount,
    starvationMs: audio.starvationMs,
    longestStarvationMs: audio.longestStarvationMs,
    droppedSamples: audio.droppedSamples,
    maximumSoundGapMs: audio.maximumSoundGapMs,
    transportSamples: audio.transportSamples,
    productionToPostAverageMs: audio.productionToPostAverageMs,
    postToReceiptAverageMs: audio.postToReceiptAverageMs,
    transportAverageMs: audio.transportAverageMs,
    transportMaximumMs: audio.transportMaximumMs,
});

// HELPER :: [diagnosticBucket], mobileAudioDiagnosticSnapshot? -> ARRAY<STRING, UNKNOWN>
// Produces full-run totals and maxima without hiding unavailable measurements behind zeroes.
const summarize = (
    buckets: ReadonlyArray<DiagnosticBucket>,
    latest: MobileAudioDiagnosticSnapshot | null,
): Record<string, unknown> => ({
    bucketCount: buckets.length,
    frames: sumField(buckets, "frames"),
    batches: sumField(buckets, "batches"),
    discReadCalls: sumField(buckets, "discReadCalls"),
    discReadRequestedBytes: sumField(buckets, "discReadRequestedBytes"),
    discReadReturnedBytes: sumField(buckets, "discReadReturnedBytes"),
    discReadMilliseconds: sumField(buckets, "discReadMilliseconds"),
    discSeekCalls: sumField(buckets, "discSeekCalls"),
    discSeekMilliseconds: sumField(buckets, "discSeekMilliseconds"),
    workerMaximumMs: maximumField(buckets, "workerMaximumMs"),
    batchMaximumMs: maximumField(buckets, "batchMaximumMs"),
    pcmHoldMaximumMs: maximumField(buckets, "pcmHoldMaximumMs"),
    queueMinimumMs: minimumField(buckets, "queueMinimumMs"),
    underrunCount: latest?.underrunCount ?? null,
    starvationMs: latest?.starvationMs ?? null,
    longestStarvationMs: latest?.longestStarvationMs ?? null,
    droppedSamples: latest?.droppedSamples ?? null,
    productionRate: latest?.productionRate ?? null,
    maximumSoundGapMs: latest?.maximumSoundGapMs ?? null,
    transportSamples: latest?.transportSamples ?? null,
    transportAverageMs: latest?.transportAverageMs ?? null,
    transportMaximumMs: latest?.transportMaximumMs ?? null,
});

// HELPER :: [diagnosticBucket], STRING -> NUMBER?
// Sums available numeric bucket values and preserves unavailable fields as null.
const sumField = (buckets: ReadonlyArray<DiagnosticBucket>, field: string): number | null => {
    const values = buckets.map((bucket) => bucket[field]).filter(isNumber);
    return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
};

// HELPER :: [diagnosticBucket], STRING -> NUMBER?
// Returns the largest available numeric bucket value.
const maximumField = (buckets: ReadonlyArray<DiagnosticBucket>, field: string): number | null => {
    const values = buckets.map((bucket) => bucket[field]).filter(isNumber);
    return values.length === 0 ? null : Math.max(...values);
};

// HELPER :: [diagnosticBucket], STRING -> NUMBER?
// Returns the smallest available numeric bucket value.
const minimumField = (buckets: ReadonlyArray<DiagnosticBucket>, field: string): number | null => {
    const values = buckets.map((bucket) => bucket[field]).filter(isNumber);
    return values.length === 0 ? null : Math.min(...values);
};

// HELPER :: UNKNOWN -> BOOLEAN
// True when value is a finite number suitable for aggregate arithmetic.
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

// HELPER :: [diagnosticBucket] -> STRING
// Serializes the stable compact bucket field set as RFC-4180-compatible CSV text.
const bucketsToCsv = (buckets: ReadonlyArray<DiagnosticBucket>): string => [
    CSV_FIELDS.join(","),
    ...buckets.map((bucket) => CSV_FIELDS.map((field) => csvValue(bucket[field])).join(",")),
].join("\r\n").concat("\r\n");

// HELPER :: STRING|NUMBER? -> STRING
// Escapes one compact CSV cell and leaves unavailable values empty.
const csvValue = (value: string | number | null | undefined): string => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
