import DiscSetAudit from "../DiscSetAudit/DiscSetAudit.js";
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";
import {
    isPsxBuildInfo,
    isPsxStartConfig,
} from "../shared.types.js";
import { createMountPlan } from "../worker/MountPlan.js";
import PsxSession from "./PsxSession.js";
import WorkerClient from "./WorkerClient.js";
import {
    isLibretroPsxAdapterConfig,
    isLibretroPsxAdapterInitConfig,
    isPsxWorker,
} from "./types.js";

import type {
    ControllerPort,
    FrameScheduler,
    PsxAdapter,
    PsxControllerType,
    PsxSession as PsxSessionContract,
    PsxStartConfig,
} from "../shared.types.js";
import type { WorkerStartPayload } from "./protocol.js";
import type {
    LibretroPsxAdapterConfig,
    LibretroPsxAdapterInitConfig,
    PsxClock,
    WorkerFactory,
} from "./types.js";

const CARD_BYTES = 128 * 1024;
const REQUIRED_ARTIFACTS = ["psx-core.js", "psx-core.wasm", "core.worker.js"] as const;

const invalid = (data: unknown, message = "LibretroPsxAdapter configuration is invalid."): PsxRuntimeError =>
    new PsxRuntimeError({ code: PsxRuntimeError.CODE.INVALID_CONFIG, message, data });

const resolveBuildUrl = (buildUrl: string, relative: string): string => {
    if (/^[a-z][a-z\d+.-]*:/iu.test(relative) || relative.startsWith("//") || relative.startsWith("/")) return relative;
    const root = buildUrl.endsWith("/") ? buildUrl : `${buildUrl}/`;
    if (/^[a-z][a-z\d+.-]*:/iu.test(root) || root.startsWith("//")) return new URL(relative, root).href;
    return `${root}${relative.replace(/^\.\//u, "")}`;
};

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

const browserClock = (): PsxClock => {
    if (typeof globalThis.performance?.now !== "function") throw new PsxRuntimeError({
        code: PsxRuntimeError.CODE.UNSUPPORTED,
        message: "PlayStation pacing requires performance.now().",
    });
    return globalThis.performance.now.bind(globalThis.performance);
};

const browserWorkerFactory = (): WorkerFactory => (url) => {
    if (typeof globalThis.Worker !== "function") throw new PsxRuntimeError({
        code: PsxRuntimeError.CODE.UNSUPPORTED,
        message: "PlayStation emulation requires module Worker support.",
    });
    return new globalThis.Worker(url, { type: "module" });
};

const browserFetch = (): typeof globalThis.fetch => {
    if (typeof globalThis.fetch !== "function") throw new PsxRuntimeError({
        code: PsxRuntimeError.CODE.UNSUPPORTED,
        message: "Adapter initialization requires fetch support.",
    });
    return globalThis.fetch.bind(globalThis);
};

const sha256 = async (blob: Blob): Promise<string> => {
    if (typeof globalThis.crypto?.subtle?.digest !== "function") throw new PsxRuntimeError({
        code: PsxRuntimeError.CODE.UNSUPPORTED,
        message: "BIOS validation requires Web Crypto SHA-256 support.",
    });
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
    const digest = await globalThis.crypto.subtle.digest("SHA-256", source);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
};

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

const normalizedCards = (
    config: PsxStartConfig,
): Readonly<Record<ControllerPort, Uint8Array>> => ({
    1: config.memoryCards?.[1]?.slice() ?? blankMemoryCard(),
    2: config.memoryCards?.[2]?.slice() ?? blankMemoryCard(),
});

export default class LibretroPsxAdapter implements PsxAdapter {
    readonly type = "libretro-psx" as const;
    readonly #buildUrl: string;
    readonly #build: LibretroPsxAdapterConfig["build"];
    readonly #createWorker: WorkerFactory;
    readonly #scheduler?: FrameScheduler;
    readonly #clock?: PsxClock;
    #generation = 0;

    constructor(config: LibretroPsxAdapterConfig) {
        if (!isLibretroPsxAdapterConfig(config)) throw invalid(config);
        if (config.build.adapter !== "libretro-psx"
            || !REQUIRED_ARTIFACTS.every((artifact) => config.build.artifacts.includes(artifact))) {
            throw invalid(config.build, "build.json does not describe the required PlayStation artifacts.");
        }
        this.#buildUrl = config.buildUrl;
        this.#build = config.build;
        this.#createWorker = config.createWorker;
        this.#scheduler = config.scheduler;
        this.#clock = config.clock;
    }

    get build(): LibretroPsxAdapterConfig["build"] {
        return this.#build;
    }

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
        });
    }

    async start(config: PsxStartConfig): Promise<PsxSessionContract> {
        if (!isPsxStartConfig(config)) throw invalid(config, "PlayStation start configuration is invalid.");
        const audit = await DiscSetAudit.audit(config.game);
        if (!audit.ok) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DISC_SET_INVALID,
            message: "The PlayStation disc set failed validation.",
            data: audit,
        });
        const entryType = audit.audit.entry.toLowerCase().endsWith(".m3u") ? "m3u" : "cue";
        if (!this.#build.supportedContent.includes(entryType)) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.UNSUPPORTED,
            message: "The selected core build does not support the disc-set entry type.",
            data: entryType,
        });
        if (!this.#build.firmware.byteLengths.includes(config.bios.blob.size)) throw new PsxRuntimeError({
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

        const controllers = normalizedControllers(config, this.#build.controllerTypes);
        const initialCards = normalizedCards(config);
        const mountPlan = await createMountPlan(config.game, audit.audit);
        const scheduler = this.#scheduler ?? browserScheduler();
        const clock = this.#clock ?? browserClock();
        const workerUrl = resolveBuildUrl(this.#buildUrl, "core.worker.js");
        const moduleUrl = resolveBuildUrl(this.#buildUrl, "psx-core.js");
        const biosPath = `/system/${this.#build.firmware.systemFilenames[config.bios.region]}`;

        const startWorker = async (
            cards: Readonly<Record<ControllerPort, Uint8Array>>,
        ): Promise<{ client: WorkerClient; machine: Awaited<ReturnType<WorkerClient["start"]>> }> => {
            const worker = this.#createWorker(workerUrl);
            if (!isPsxWorker(worker)) throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.CORE_LOAD_FAILED,
                message: "The Worker factory returned an invalid Worker boundary.",
            });
            const client = new WorkerClient(worker, scheduler, clock, ++this.#generation);
            const payload: WorkerStartPayload = {
                contentPath: mountPlan.entryPath,
                moduleUrl,
                build: this.#build,
                mountPlan,
                bios: { path: biosPath, blob: config.bios.blob },
                memoryCards: { 1: cards[1].slice(), 2: cards[2].slice() },
                gameId: config.game.gameId,
                region: config.bios.region,
                controllers,
                options: config.options ?? {},
            };
            try {
                const machine = await client.start(payload);
                if (machine.buildId !== this.#build.buildId || machine.gameId !== config.game.gameId
                    || machine.discCount !== audit.audit.discs.length || machine.firmware !== "bios") {
                    throw new PsxRuntimeError({
                        code: PsxRuntimeError.CODE.CORE_START_FAILED,
                        message: "The running core reported incompatible machine metadata.",
                    });
                }
                return { client, machine };
            } catch (error) {
                client.terminate();
                throw error;
            }
        };

        const worker = await startWorker(initialCards);
        return new PsxSession(worker, startWorker);
    }
}
