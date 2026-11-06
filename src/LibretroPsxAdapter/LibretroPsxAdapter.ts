// Dependencies:
import DiscSetAudit from "../DiscSetAudit/DiscSetAudit.js";              // Validates content and supplies resolved disc metadata
import Sha256 from "../PsxGameStore/Sha256.js";                         // Hashes firmware when Web Crypto is unavailable on an insecure local origin
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Reports unsupported browser, content, firmware, and core failures
import {
    isPsxBuildInfo,      // Validates fetched immutable core-build metadata
    isPsxStartConfig,    // Validates complete public startup input
} from "../shared.types.js";
import { createMountPlan } from "../worker/MountPlan.js";    // Resolves audited content into worker mount instructions
import PsxSession from "./PsxSession.js";                    // Wraps a started worker with the public session contract
import WorkerClient from "./WorkerClient.js";                // Owns worker messaging, pacing, and response correlation
import {
    isLibretroPsxAdapterConfig,        // Validates direct adapter construction dependencies
    isLibretroPsxAdapterInitConfig,    // Validates high-level browser factory input
    isPsxDiagnosticVariant,            // Validates production and development execution variants
    isPsxWorker,                       // Validates workers returned by an injected factory
} from "./types.js";

// Type dependencies:
import type {
    ControllerPort,                    // Physical controller and memory-card slot
    FrameScheduler,                    // Animation-frame boundary used for worker ticks
    PsxAdapter,                        // Public adapter contract implemented by this class
    PsxControllerType,                 // Supported digital or DualShock port mode
    PsxSession as PsxSessionContract,  // Public session contract returned by start()
    PsxStartConfig,                    // Firmware, content, controller, card, and option input
} from "../shared.types.js";
import type { WorkerStartPayload } from "./protocol.js";    // Fully resolved startup request sent to the core worker
import type {
    LibretroPsxAdapterConfig,        // Validated build and injected browser dependencies
    LibretroPsxAdapterInitConfig,    // Build URL and optional browser overrides
    PsxClock,                        // Monotonic pacing clock
    PsxDiagnosticVariant,            // Production path or development measurement variant
    WorkerFactory,                   // Module-worker construction boundary
} from "./types.js";

const CARD_BYTES = 128 * 1024;    // Physical PlayStation memory-card byte length
const REQUIRED_ARTIFACTS = ["psx-core.js", "psx-core.wasm", "core.worker.js"] as const;

/**
 *
 * Class
 *
 */

// Validates browser startup input and launches libretro-backed PSX worker sessions.
export default class LibretroPsxAdapter implements PsxAdapter {

    /* Instance Fields */
    readonly type = "libretro-psx" as const;                              // Stable adapter discriminant exposed through the public contract
    private readonly _buildUrl: string;                                   // Root URL used to resolve worker and module artifacts
    private readonly _build: LibretroPsxAdapterConfig["build"];           // Validated immutable core capabilities and identity
    private readonly _createWorker: WorkerFactory;                         // Module-worker construction boundary
    private readonly _scheduler?: FrameScheduler;                          // Optional injected animation-frame boundary
    private readonly _clock?: PsxClock;                                    // Optional injected monotonic pacing clock
    private _diagnosticVariant: PsxDiagnosticVariant;                       // Variant captured by each newly started worker
    private _generation = 0;                                               // Monotonic worker generation used to reject stale events

    // CONSTRUCTOR :: libretroPsxAdapterConfig -> libretroPsxAdapter
    // Validates build artifacts and retains runtime browser dependencies.
    constructor(config: LibretroPsxAdapterConfig) {
        if (!isLibretroPsxAdapterConfig(config)) throw invalid(config);
        if (config.build.adapter !== "libretro-psx"
            || !REQUIRED_ARTIFACTS.every((artifact) => config.build.artifacts.includes(artifact))) {
            throw invalid(config.build, "build.json does not describe the required PlayStation artifacts.");
        }
        this._buildUrl = config.buildUrl;
        this._build = config.build;
        this._createWorker = config.createWorker;
        this._scheduler = config.scheduler;
        this._clock = config.clock;
        this._diagnosticVariant = config.diagnosticVariant ?? "production";
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> psxBuildInfo
    // Returns validated immutable core-build metadata.
    get build(): LibretroPsxAdapterConfig["build"] {
        return this._build;
    }

    // GETTER :: VOID -> psxDiagnosticVariant
    // Returns the execution variant that the next session will capture.
    get diagnosticVariant(): PsxDiagnosticVariant {
        return this._diagnosticVariant;
    }

    // SETTER :: psxDiagnosticVariant -> VOID
    // Selects the execution variant for future sessions without mutating a running worker.
    set diagnosticVariant(value: PsxDiagnosticVariant) {
        if (!isPsxDiagnosticVariant(value)) throw invalid(value, "The diagnostic variant is invalid.");
        this._diagnosticVariant = value;
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: psxStartConfig -> PROMISE(psxSession)
    // Audits content and firmware, starts a worker, and returns a restartable session.
    async start(config: PsxStartConfig): Promise<PsxSessionContract> {
        if (!isPsxStartConfig(config)) throw invalid(config, "PlayStation start configuration is invalid.");
        const audit = await DiscSetAudit.audit(config.game);
        if (!audit.ok) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DISC_SET_INVALID,
            message: "The PlayStation disc set failed validation.",
            data: audit,
        });
        const entryType = audit.audit.entry.toLowerCase().endsWith(".m3u") ? "m3u" : "cue";
        if (!this._build.supportedContent.includes(entryType)) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.UNSUPPORTED,
            message: "The selected core build does not support the disc-set entry type.",
            data: entryType,
        });
        if (!this._build.firmware.byteLengths.includes(config.bios.blob.size)) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.BIOS_INVALID,
            message: "The BIOS image has an unsupported byte length.",
            data: config.bios.blob.size,
        });
        const biosHash = await sha256(config.bios.blob);
        if (config.bios.sha256 !== undefined && biosHash !== config.bios.sha256) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.BIOS_INVALID,
            message: "The BIOS image does not match its declared SHA-256 digest.",
            data: null,
        });
        if (config.options !== undefined && Object.keys(config.options).length > 0) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.UNSUPPORTED,
            message: "This v1 core build exposes no caller-selectable core options.",
            data: Object.keys(config.options),
        });
        const initialDiscIndex = config.initialDiscIndex ?? 0;
        if (initialDiscIndex >= audit.audit.discs.length) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.INVALID_CONFIG,
            message: "The initial disc index is outside the audited disc set.",
            data: initialDiscIndex,
        });

        const controllers = normalizedControllers(config, this._build.controllerTypes);
        const initialCards = normalizedCards(config);
        const mountPlan = await createMountPlan(config.game, audit.audit);
        const scheduler = this._scheduler ?? browserScheduler();
        const clock = this._clock ?? browserClock();
        const workerUrl = resolveBuildUrl(this._buildUrl, "core.worker.js");
        const moduleUrl = resolveBuildUrl(this._buildUrl, "psx-core.js");
        const biosPath = `/system/${this._build.firmware.systemFilenames[config.bios.region]}`;
        const diagnosticVariant = this._diagnosticVariant;

        const startWorker = async (
            cards: Readonly<Record<ControllerPort, Uint8Array>>,
        ): Promise<{
            client: WorkerClient;
            machine: Awaited<ReturnType<WorkerClient["start"]>>;
            discIndex: number;
        }> => {
            const worker = this._createWorker(workerUrl);
            if (!isPsxWorker(worker)) throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.CORE_LOAD_FAILED,
                message: "The Worker factory returned an invalid Worker boundary.",
            });
            const client = new WorkerClient(worker, scheduler, clock, ++this._generation);
            const payload: WorkerStartPayload = {
                contentPath: mountPlan.entryPath,
                moduleUrl,
                build: this._build,
                mountPlan,
                bios: { path: biosPath, blob: config.bios.blob },
                memoryCards: { 1: cards[1].slice(), 2: cards[2].slice() },
                gameId: config.game.gameId,
                region: config.bios.region,
                initialDiscIndex,
                controllers,
                options: config.options ?? {},
                diagnosticVariant,
            };
            try {
                const machine = await client.start(payload);
                if (machine.buildId !== this._build.buildId || machine.gameId !== config.game.gameId
                    || machine.discCount !== audit.audit.discs.length || machine.firmware !== "bios") {
                    throw new PsxRuntimeError({
                        code: PsxRuntimeError.CODE.CORE_START_FAILED,
                        message: "The running core reported incompatible machine metadata.",
                    });
                }
                return { client, machine, discIndex: initialDiscIndex };
            } catch (error) {
                client.terminate();
                throw error;
            }
        };

        const worker = await startWorker(initialCards);
        return new PsxSession(worker, startWorker);
    }

    /**
     *
     * Static Methods
     *
     */

    // Static Factory Method :: libretroPsxAdapterInitConfig -> PROMISE(libretroPsxAdapter)
    // Fetches and validates build metadata before creating a browser adapter.
    static async init(config: LibretroPsxAdapterInitConfig): Promise<LibretroPsxAdapter> {
        if (!isLibretroPsxAdapterInitConfig(config)) throw invalid(config);
        const fetcher = config.fetch ?? browserFetch();
        const buildJsonUrl = resolveBuildUrl(config.buildUrl, "build.json");
        let response;
        try {
            response = await fetcher(buildJsonUrl);
        } catch (error) {
            throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.CORE_LOAD_FAILED,
                message: "The PlayStation build metadata request failed.",
                data: error instanceof Error ? error.message : null,
            });
        }
        if (!response.ok) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.CORE_LOAD_FAILED,
            message: "The PlayStation build metadata request was unsuccessful.",
            data: response.status,
        });
        let build: unknown;
        try {
            build = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await response.arrayBuffer()));
        } catch (error) {
            throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.CORE_LOAD_FAILED,
                message: "The PlayStation build metadata is not valid UTF-8 JSON.",
                data: error instanceof Error ? error.message : null,
            });
        }
        if (!isPsxBuildInfo(build)) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.CORE_LOAD_FAILED,
            message: "The PlayStation build metadata failed structural validation.",
            data: null,
        });
        return new LibretroPsxAdapter({
            buildUrl: config.buildUrl,
            build,
            createWorker: config.createWorker ?? browserWorkerFactory(),
            ...(config.scheduler === undefined ? {} : { scheduler: config.scheduler }),
            ...(config.clock === undefined ? {} : { clock: config.clock }),
            ...(config.diagnosticVariant === undefined ? {} : { diagnosticVariant: config.diagnosticVariant }),
        });
    }
}

/**
 *
 *  Helper Functions
 *
 */

// Build files required by this adapter

// HELPER :: UNKNOWN, STRING? -> psxRuntimeError
// Creates one invalid adapter, build, or startup configuration error.
const invalid = (data: unknown, message = "LibretroPsxAdapter configuration is invalid."): PsxRuntimeError =>
    new PsxRuntimeError({ code: PsxRuntimeError.CODE.INVALID_CONFIG, message, data });

// HELPER :: STRING, STRING -> STRING
// Resolves one build-relative artifact across URL and path-based deployments.
const resolveBuildUrl = (buildUrl: string, relative: string): string => {
    if (/^[a-z][a-z\d+.-]*:/iu.test(relative) || relative.startsWith("//") || relative.startsWith("/")) return relative;
    const root = buildUrl.endsWith("/") ? buildUrl : `${buildUrl}/`;
    if (/^[a-z][a-z\d+.-]*:/iu.test(root) || root.startsWith("//")) return new URL(relative, root).href;
    return `${root}${relative.replace(/^\.\//u, "")}`;
};

// HELPER :: VOID -> frameScheduler
// Returns validated browser animation-frame scheduling operations.
const browserScheduler = (): FrameScheduler => {
    if (typeof globalThis.requestAnimationFrame !== "function"
        || typeof globalThis.cancelAnimationFrame !== "function") {
        throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.UNSUPPORTED,
            message: "PlayStation pacing requires requestAnimationFrame.",
        });
    }
    return {
        request: globalThis.requestAnimationFrame.bind(globalThis),
        cancel: globalThis.cancelAnimationFrame.bind(globalThis),
    };
};

// HELPER :: VOID -> psxClock
// Returns the validated browser monotonic clock.
const browserClock = (): PsxClock => {
    if (typeof globalThis.performance?.now !== "function") throw new PsxRuntimeError({
        code: PsxRuntimeError.CODE.UNSUPPORTED,
        message: "PlayStation pacing requires performance.now().",
    });
    return globalThis.performance.now.bind(globalThis.performance);
};

// HELPER :: VOID -> workerFactory
// Returns a module-worker factory backed by the browser Worker API.
const browserWorkerFactory = (): WorkerFactory => (url) => {
    if (typeof globalThis.Worker !== "function") throw new PsxRuntimeError({
        code: PsxRuntimeError.CODE.UNSUPPORTED,
        message: "PlayStation emulation requires module Worker support.",
    });
    return new globalThis.Worker(url, { type: "module" });
};

// HELPER :: VOID -> (requestInfo, requestInit? -> PROMISE(response))
// Returns the browser fetch operation or reports missing platform support.
const browserFetch = (): typeof globalThis.fetch => {
    if (typeof globalThis.fetch !== "function") throw new PsxRuntimeError({
        code: PsxRuntimeError.CODE.UNSUPPORTED,
        message: "Adapter initialization requires fetch support.",
    });
    return globalThis.fetch.bind(globalThis);
};

// HELPER :: blob -> PROMISE(STRING)
// Reads and hashes one firmware blob with Web Crypto or the portable package implementation.
const sha256 = async (blob: Blob): Promise<string> => {
    let source: ArrayBuffer;
    try {
        source = await blob.arrayBuffer();
    } catch (error) {
        throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.CONTENT_LOAD_FAILED,
            message: "The BIOS image could not be read.",
            data: error instanceof Error ? error.message : null,
        });
    }
    if (typeof globalThis.crypto?.subtle?.digest === "function") {
        const digest = await globalThis.crypto.subtle.digest("SHA-256", source);
        return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    }
    const digest = new Sha256();
    digest.update(new Uint8Array(source));
    return digest.digestHex();
};

// HELPER :: VOID -> uint8Array
// Creates a freshly formatted blank PlayStation memory-card image.
const blankMemoryCard = (): Uint8Array => {
    const bytes = new Uint8Array(CARD_BYTES);
    bytes[0] = 0x4d;
    bytes[1] = 0x43;
    bytes[127] = 0x0e;
    for (let frame = 1; frame <= 15; frame++) {
        const offset = frame * 128;
        bytes[offset] = 0xa0;
        bytes[offset + 8] = 0xff;
        bytes[offset + 9] = 0xff;
        let checksum = 0;
        for (let index = 0; index < 127; index++) checksum ^= bytes[offset + index]!;
        bytes[offset + 127] = checksum;
    }
    return bytes;
};

// HELPER :: psxStartConfig, [psxControllerType] -> ARRAY<controllerPort, psxControllerType>
// Applies digital defaults and rejects controller modes unsupported by the build.
const normalizedControllers = (
    config: PsxStartConfig,
    supported: ReadonlyArray<PsxControllerType>,
): Readonly<Record<ControllerPort, PsxControllerType>> => {
    const controllers: Readonly<Record<ControllerPort, PsxControllerType>> = {
        1: config.controllers?.[1] ?? "digital",
        2: config.controllers?.[2] ?? "digital",
    };
    for (const type of Object.values(controllers)) {
        if (!supported.includes(type)) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.UNSUPPORTED,
            message: "The selected core build does not support a requested controller type.",
            data: type,
        });
    }
    return controllers;
};

// HELPER :: psxStartConfig -> ARRAY<controllerPort, uint8Array>
// Copies supplied card images or creates blank formatted cards for both slots.
const normalizedCards = (
    config: PsxStartConfig,
): Readonly<Record<ControllerPort, Uint8Array>> => ({
    1: config.memoryCards?.[1]?.slice() ?? blankMemoryCard(),
    2: config.memoryCards?.[2]?.slice() ?? blankMemoryCard(),
});
