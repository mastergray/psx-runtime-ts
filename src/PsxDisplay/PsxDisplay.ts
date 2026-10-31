import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";
import { isPsxFrameEvent, isPsxSession } from "../shared.types.js";
import {
    isPsxDisplayConfig,
    isPsxCanvasContextLike,
    isPsxRect,
    isPsxScalingMode,
} from "./types.js";

import type { Listener, PsxFrameEvent, PsxSession, Unsubscribe } from "../shared.types.js";
import type {
    PsxCanvasContextLike,
    PsxDisplayConfig,
    PsxDisplayLayout,
    PsxImageDataLike,
    PsxImageRendering,
    PsxPlaceholderLike,
    PsxRect,
    PsxScalingMode,
} from "./types.js";

interface FrameSize {
    readonly width: number;
    readonly height: number;
}

const invalid = (message: string, data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.INVALID_CONFIG,
    message,
    data,
});

export default class PsxDisplay {
    static readonly DEFAULT_ASPECT_RATIO = 4 / 3;
    static readonly DEFAULT_FRAME: FrameSize = Object.freeze({ width: 320, height: 240 });
    static readonly DEFAULT_SCALING: PsxScalingMode = "fit";

    readonly #canvas: PsxDisplayConfig["canvas"];
    readonly #container: PsxDisplayConfig["container"];
    readonly #context: PsxCanvasContextLike;
    readonly #observer: InstanceType<NonNullable<PsxDisplayConfig["resizeObserver"]>> | null;
    readonly #fullscreenTarget: object;
    readonly #document: NonNullable<PsxDisplayConfig["document"]> | null;
    readonly #requestFullscreen: NonNullable<PsxDisplayConfig["requestFullscreen"]> | null;
    readonly #exitFullscreen: NonNullable<PsxDisplayConfig["exitFullscreen"]> | null;
    readonly #layoutListeners = new Set<Listener<PsxDisplayLayout>>();
    #containerRect: PsxRect;
    #frameSize: FrameSize = { width: 0, height: 0 };
    #aspectRatio = PsxDisplay.DEFAULT_ASPECT_RATIO;
    #scaling: PsxScalingMode;
    #imageRendering: PsxImageRendering;
    #layout: PsxDisplayLayout;
    #image: PsxImageDataLike | null = null;
    #placeholder: PsxPlaceholderLike | null = null;
    #unsubscribeFrame: Unsubscribe | null = null;
    #destroyed = false;

    constructor(config: PsxDisplayConfig) {
        if (!isPsxDisplayConfig(config)) throw invalid("PsxDisplay config is invalid.", config);
        this.#canvas = config.canvas;
        this.#container = config.container;
        const context = config.context ?? config.canvas.getContext("2d");
        if (!isPsxCanvasContextLike(context)) throw invalid("A Canvas 2D context is required.", context);
        this.#context = context;
        this.#scaling = config.scaling ?? PsxDisplay.DEFAULT_SCALING;
        this.#imageRendering = config.imageRendering ?? "pixelated";
        this.#fullscreenTarget = config.fullscreenTarget ?? config.container;
        this.#document = config.document ?? null;
        this.#requestFullscreen = config.requestFullscreen ?? null;
        this.#exitFullscreen = config.exitFullscreen ?? null;
        this.#containerRect = PsxDisplay.rectOf(config.container);
        this.#applyFiltering();
        this.#layout = this.#applyLayout();
        this.#observer = config.resizeObserver === undefined ? null : new config.resizeObserver((entries) => {
            const entry = entries.at(-1);
            if (entry === undefined || this.#destroyed) return;
            const measured = PsxDisplay.rectOf(this.#container);
            this.resize({ ...measured, width: entry.contentRect.width, height: entry.contentRect.height });
        });
        this.#observer?.observe(this.#container);
        this.#document?.addEventListener("fullscreenchange", this.#fullscreenChanged);
    }

    get aspectRatio(): number { return this.#aspectRatio; }
    get scaling(): PsxScalingMode { return this.#scaling; }
    get imageRendering(): PsxImageRendering { return this.#imageRendering; }
    get layout(): PsxDisplayLayout { return this.#layout; }
    get isAttached(): boolean { return this.#unsubscribeFrame !== null; }
    get isFullscreen(): boolean {
        return this.#document !== null && this.#document.fullscreenElement === this.#fullscreenTarget;
    }

    set scaling(value: PsxScalingMode) {
        this.#assertLive();
        if (!isPsxScalingMode(value)) throw invalid("PsxDisplay scaling is invalid.", value);
        if (this.#scaling === value) return;
        this.#scaling = value;
        this.#updateLayout();
    }

    set imageRendering(value: PsxImageRendering) {
        this.#assertLive();
        if (value !== "pixelated" && value !== "smooth") {
            throw invalid("PsxDisplay image rendering is invalid.", value);
        }
        this.#imageRendering = value;
        this.#applyFiltering();
    }

    attach(session: PsxSession): Unsubscribe {
        this.#assertLive();
        if (!isPsxSession(session)) throw invalid("PsxDisplay requires a session.", session);
        if (this.#unsubscribeFrame !== null) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.ALREADY_STARTED,
            message: "PsxDisplay is already attached.",
        });
        this.#frameSize = {
            width: session.machine.geometry.width,
            height: session.machine.geometry.height,
        };
        this.#aspectRatio = session.machine.geometry.aspectRatio;
        this.#setBackingSize(this.#frameSize);
        this.#updateLayout();
        const unsubscribe = session.onFrame((frame) => this.draw(frame));
        this.#unsubscribeFrame = unsubscribe;
        return () => {
            if (this.#unsubscribeFrame === unsubscribe) this.detach();
        };
    }

    detach(): void {
        const unsubscribe = this.#unsubscribeFrame;
        if (unsubscribe === null) return;
        this.#unsubscribeFrame = null;
        unsubscribe();
    }

    draw(frame: PsxFrameEvent): void {
        this.#assertLive();
        if (!isPsxFrameEvent(frame)) throw invalid("PsxDisplay frame is invalid.", frame);
        const geometryChanged = frame.width !== this.#frameSize.width
            || frame.height !== this.#frameSize.height || frame.aspectRatio !== this.#aspectRatio;
        this.#frameSize = { width: frame.width, height: frame.height };
        this.#aspectRatio = frame.aspectRatio;
        this.#setBackingSize(frame);
        if (geometryChanged) this.#updateLayout();
        if (this.#image === null || this.#image.width !== frame.width || this.#image.height !== frame.height) {
            this.#image = this.#context.createImageData(frame.width, frame.height);
        }
        this.#image.data.set(frame.rgba);
        this.#context.putImageData(this.#image, 0, 0);
        if (this.#placeholder !== null) {
            this.#placeholder.hidden = true;
            this.#placeholder = null;
            this.#canvas.style.visibility = "";
        }
    }

    resize(width: number, height: number): PsxDisplayLayout;
    resize(rect: PsxRect): PsxDisplayLayout;
    resize(rectOrWidth: PsxRect | number, height?: number): PsxDisplayLayout {
        this.#assertLive();
        if (typeof rectOrWidth === "number") {
            if (!Number.isFinite(rectOrWidth) || rectOrWidth < 0
                || !Number.isFinite(height) || height! < 0) {
                throw invalid("PsxDisplay resize dimensions are invalid.", { width: rectOrWidth, height });
            }
            this.#containerRect = { ...this.#containerRect, width: rectOrWidth, height: height! };
        } else {
            if (!isPsxRect(rectOrWidth)) throw invalid("PsxDisplay resize rectangle is invalid.", rectOrWidth);
            this.#containerRect = { ...rectOrWidth };
        }
        this.#updateLayout();
        return this.#layout;
    }

    onLayout(listener: Listener<PsxDisplayLayout>): Unsubscribe {
        this.#assertLive();
        if (typeof listener !== "function") throw invalid("PsxDisplay layout listener is invalid.", listener);
        this.#layoutListeners.add(listener);
        return () => this.#layoutListeners.delete(listener);
    }

    showPlaceholder(placeholder: PsxPlaceholderLike | null): void {
        this.#assertLive();
        if (placeholder !== null && (typeof placeholder !== "object" || typeof placeholder.hidden !== "boolean")) {
            throw invalid("PsxDisplay placeholder is invalid.", placeholder);
        }
        if (this.#placeholder !== null && this.#placeholder !== placeholder) this.#placeholder.hidden = true;
        this.#placeholder = placeholder;
        this.#canvas.style.visibility = placeholder === null ? "" : "hidden";
        if (placeholder === null) {
            this.#context.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
        } else {
            placeholder.hidden = false;
        }
    }

    async fullscreen(): Promise<void> {
        this.#assertLive();
        if (this.#requestFullscreen === null) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.UNSUPPORTED,
            message: "Fullscreen is unavailable.",
        });
        try {
            await this.#requestFullscreen(this.#fullscreenTarget);
        } catch (error) {
            throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.FULLSCREEN_FAILED,
                message: "The fullscreen request failed.",
                data: error,
            });
        }
    }

    async exitFullscreen(): Promise<void> {
        this.#assertLive();
        if (this.#exitFullscreen === null || this.#document === null) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.UNSUPPORTED,
            message: "Fullscreen exit is unavailable.",
        });
        try {
            await this.#exitFullscreen(this.#document);
        } catch (error) {
            throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.FULLSCREEN_FAILED,
                message: "Exiting fullscreen failed.",
                data: error,
            });
        }
    }

    destroy(): void {
        if (this.#destroyed) return;
        this.detach();
        this.#observer?.disconnect();
        this.#document?.removeEventListener("fullscreenchange", this.#fullscreenChanged);
        this.#layoutListeners.clear();
        if (this.#placeholder !== null) this.#placeholder.hidden = true;
        this.#placeholder = null;
        this.#canvas.style.visibility = "";
        this.#context.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
        this.#destroyed = true;
    }

    static layoutFor(
        container: PsxRect,
        frame: FrameSize,
        aspectRatio: number,
        mode: PsxScalingMode,
    ): PsxDisplayLayout {
        const width = frame.width > 0 && frame.height > 0 ? frame.width : PsxDisplay.DEFAULT_FRAME.width;
        const correctedHeight = width / aspectRatio;
        const center = (layoutWidth: number, layoutHeight: number): PsxDisplayLayout => ({
            left: container.left + (container.width - layoutWidth) / 2,
            top: container.top + (container.height - layoutHeight) / 2,
            width: layoutWidth,
            height: layoutHeight,
            scale: width === 0 ? 0 : layoutWidth / width,
        });
        const fit = (): PsxDisplayLayout => {
            if (container.width <= container.height * aspectRatio) {
                return center(container.width, aspectRatio === 0 ? 0 : container.width / aspectRatio);
            }
            return center(container.height * aspectRatio, container.height);
        };
        if (mode === "fit") return fit();
        if (mode === "stretch") return center(container.width, container.height);
        if (mode === "fill") {
            if (container.width >= container.height * aspectRatio) {
                return center(container.width, container.width / aspectRatio);
            }
            return center(container.height * aspectRatio, container.height);
        }
        const multiple = Math.floor(Math.min(container.width / width, container.height / correctedHeight));
        return Number.isFinite(multiple) && multiple >= 1
            ? center(width * multiple, correctedHeight * multiple)
            : fit();
    }

    readonly #fullscreenChanged = (): void => {
        if (!this.#destroyed) this.resize(PsxDisplay.rectOf(this.#container));
    };

    #setBackingSize(size: FrameSize): void {
        if (this.#canvas.width === size.width && this.#canvas.height === size.height) return;
        this.#canvas.width = size.width;
        this.#canvas.height = size.height;
        this.#image = null;
        this.#applyFiltering();
    }

    #applyFiltering(): void {
        const smooth = this.#imageRendering === "smooth";
        this.#context.imageSmoothingEnabled = smooth;
        this.#canvas.style.imageRendering = smooth ? "auto" : "pixelated";
    }

    #applyLayout(): PsxDisplayLayout {
        const layout = PsxDisplay.layoutFor(
            this.#containerRect,
            this.#frameSize,
            this.#aspectRatio,
            this.#scaling,
        );
        this.#canvas.style.width = `${layout.width}px`;
        this.#canvas.style.height = `${layout.height}px`;
        return Object.freeze(layout);
    }

    #updateLayout(): void {
        const previous = this.#layout;
        this.#layout = this.#applyLayout();
        if (previous.left === this.#layout.left && previous.top === this.#layout.top
            && previous.width === this.#layout.width && previous.height === this.#layout.height
            && previous.scale === this.#layout.scale) return;
        this.#layoutListeners.forEach((listener) => listener(this.#layout));
    }

    #assertLive(): void {
        if (this.#destroyed) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "PsxDisplay has been destroyed.",
        });
    }

    static rectOf(container: PsxDisplayConfig["container"]): PsxRect {
        const rect = container.getBoundingClientRect();
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }

    static init(config: PsxDisplayConfig): PsxDisplay {
        if (!isPsxDisplayConfig(config)) return new PsxDisplay(config);
        const filled: { -readonly [K in keyof PsxDisplayConfig]: PsxDisplayConfig[K] } = { ...config };
        const target = config.fullscreenTarget ?? config.container;
        if (filled.resizeObserver === undefined && typeof globalThis.ResizeObserver === "function") {
            filled.resizeObserver = globalThis.ResizeObserver as unknown as NonNullable<PsxDisplayConfig["resizeObserver"]>;
        }
        if (filled.fullscreenTarget === undefined) filled.fullscreenTarget = target;
        const document = config.document ?? (typeof globalThis.document === "undefined" ? undefined : globalThis.document);
        if (filled.document === undefined && document !== undefined) {
            filled.document = document as unknown as NonNullable<PsxDisplayConfig["document"]>;
        }
        if (filled.requestFullscreen === undefined && "requestFullscreen" in target
            && typeof (target as { requestFullscreen?: unknown }).requestFullscreen === "function") {
            filled.requestFullscreen = async (element) => {
                await (element as Element).requestFullscreen();
            };
        }
        const browserDocument = document as (PsxDisplayConfig["document"] & {
            exitFullscreen?: () => Promise<void>;
        }) | undefined;
        if (filled.exitFullscreen === undefined && typeof browserDocument?.exitFullscreen === "function") {
            filled.exitFullscreen = async () => { await browserDocument.exitFullscreen!(); };
        }
        return new PsxDisplay(filled);
    }
}
