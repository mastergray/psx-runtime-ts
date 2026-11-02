// Dependencies:
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Reports invalid display state, lifecycle, and fullscreen failures
import {
    isPsxFrameEvent,    // Validates video frames before drawing
    isPsxSession,       // Validates sessions before attachment
} from "../shared.types.js";
import {
    isPsxDisplayConfig,        // Validates direct and factory construction dependencies
    isPsxCanvasContextLike,    // Validates the acquired Canvas 2D boundary
    isPsxRect,                 // Validates explicit container measurements
    isPsxScalingMode,          // Validates runtime scaling changes
} from "./types.js";

// Type dependencies:
import type {
    Listener,         // Observer accepted by layout updates
    PsxFrameEvent,    // RGBA frame and corrected geometry from the core
    PsxSession,       // Session source for video events
    Unsubscribe,      // Cleanup returned by frame and layout subscriptions
} from "../shared.types.js";
import type {
    PsxCanvasContextLike,    // Minimal Canvas 2D operations used for presentation
    PsxDisplayConfig,        // Canvas, container, observer, and fullscreen dependencies
    PsxDisplayLayout,        // Computed position, dimensions, and native scale
    PsxImageDataLike,        // Writable RGBA image surface
    PsxImageRendering,       // Pixelated or smooth sampling preference
    PsxPlaceholderLike,      // Visibility boundary displayed before a first frame
    PsxRect,                 // Container position and dimensions
    PsxScalingMode,          // Fit, fill, stretch, or integer layout strategy
} from "./types.js";

/**
 *
 * Type Declarations
 *
 */

// TYPE :: {width:NUMBER, height:NUMBER}
// Native pixel dimensions used by layout and backing-store updates.
interface FrameSize {
    readonly width: number;     // Horizontal native pixels
    readonly height: number;    // Vertical native pixels
}

// METHOD :: STRING, UNKNOWN -> psxRuntimeError
// Creates one invalid display configuration or operation error.
const invalid = (message: string, data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.INVALID_CONFIG,
    message,
    data,
});

/**
 *
 * Class
 *
 */

// Presents session frames on a responsive Canvas 2D surface with fullscreen support.
export default class PsxDisplay {

    /* Static Fields */
    static readonly DEFAULT_ASPECT_RATIO = 4 / 3;                                          // Corrected ratio used before session geometry arrives
    static readonly DEFAULT_FRAME: FrameSize = Object.freeze({ width: 320, height: 240 }); // Native size used before session geometry arrives
    static readonly DEFAULT_SCALING: PsxScalingMode = "fit";                              // Layout strategy used when callers omit one

    /* Instance Fields */
    private readonly _canvas: PsxDisplayConfig["canvas"];                             // Pixel backing store and styled presentation surface
    private readonly _container: PsxDisplayConfig["container"];                       // Element whose bounds constrain layout
    private readonly _context: PsxCanvasContextLike;                                   // Canvas 2D boundary receiving RGBA frames
    private readonly _observer: InstanceType<NonNullable<PsxDisplayConfig["resizeObserver"]>> | null; // Optional responsive-size observer
    private readonly _fullscreenTarget: object;                                        // Element requested for fullscreen presentation
    private readonly _document: NonNullable<PsxDisplayConfig["document"]> | null;      // Optional fullscreen state and event boundary
    private readonly _requestFullscreen: NonNullable<PsxDisplayConfig["requestFullscreen"]> | null; // Injected fullscreen request operation
    private readonly _exitFullscreen: NonNullable<PsxDisplayConfig["exitFullscreen"]> | null;       // Injected fullscreen exit operation
    private readonly _layoutListeners = new Set<Listener<PsxDisplayLayout>>();          // Observers notified after material layout changes
    private _containerRect: PsxRect;                                                    // Most recent measured container bounds
    private _frameSize: FrameSize = { width: 0, height: 0 };                            // Most recent native frame dimensions
    private _aspectRatio = PsxDisplay.DEFAULT_ASPECT_RATIO;                             // Most recent display-corrected frame ratio
    private _scaling: PsxScalingMode;                                                   // Active layout strategy
    private _imageRendering: PsxImageRendering;                                         // Active sampling preference
    private _layout: PsxDisplayLayout;                                                  // Current immutable presentation layout
    private _image: PsxImageDataLike | null = null;                                     // Reusable RGBA surface matching native geometry
    private _placeholder: PsxPlaceholderLike | null = null;                             // Optional pre-frame visual owned by the display
    private _unsubscribeFrame: Unsubscribe | null = null;                               // Active session frame-listener cleanup
    private _hasFrame = false;                                                          // Whether at least one valid frame has been drawn
    private _destroyed = false;                                                         // Whether display ownership has ended

    // CONSTRUCTOR :: psxDisplayConfig -> psxDisplay
    // Validates rendering boundaries and initializes responsive layout observation.
    constructor(config: PsxDisplayConfig) {
        if (!isPsxDisplayConfig(config)) throw invalid("PsxDisplay config is invalid.", config);
        this._canvas = config.canvas;
        this._container = config.container;
        const context = config.context ?? config.canvas.getContext("2d");
        if (!isPsxCanvasContextLike(context)) throw invalid("A Canvas 2D context is required.", context);
        this._context = context;
        this._scaling = config.scaling ?? PsxDisplay.DEFAULT_SCALING;
        this._imageRendering = config.imageRendering ?? "pixelated";
        this._fullscreenTarget = config.fullscreenTarget ?? config.container;
        this._document = config.document ?? null;
        this._requestFullscreen = config.requestFullscreen ?? null;
        this._exitFullscreen = config.exitFullscreen ?? null;
        this._containerRect = PsxDisplay.rectOf(config.container);
        this._applyFiltering();
        this._layout = this._applyLayout();
        this._observer = config.resizeObserver === undefined ? null : new config.resizeObserver((entries) => {
            const entry = entries.at(-1);
            if (entry === undefined || this._destroyed) return;
            const measured = PsxDisplay.rectOf(this._container);
            this.resize({ ...measured, width: entry.contentRect.width, height: entry.contentRect.height });
        });
        this._observer?.observe(this._container);
        this._document?.addEventListener("fullscreenchange", this._fullscreenChanged);
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> NUMBER
    // Returns the current display-corrected frame ratio.
    get aspectRatio(): number { return this._aspectRatio; }

    // GETTER :: VOID -> psxScalingMode
    // Returns the active layout strategy.
    get scaling(): PsxScalingMode { return this._scaling; }

    // GETTER :: VOID -> psxImageRendering
    // Returns the active sampling preference.
    get imageRendering(): PsxImageRendering { return this._imageRendering; }

    // GETTER :: VOID -> psxDisplayLayout
    // Returns the current immutable presentation layout.
    get layout(): PsxDisplayLayout { return this._layout; }

    // GETTER :: VOID -> BOOLEAN
    // Reports whether a session frame listener is active.
    get isAttached(): boolean { return this._unsubscribeFrame !== null; }

    // GETTER :: VOID -> BOOLEAN
    // Reports whether the display has drawn at least one frame.
    get hasFrame(): boolean { return this._hasFrame; }

    // GETTER :: VOID -> BOOLEAN
    // Reports whether the configured target owns document fullscreen.
    get isFullscreen(): boolean {
        return this._document !== null && this._document.fullscreenElement === this._fullscreenTarget;
    }

    // SETTER :: psxScalingMode -> VOID
    // Validates a scaling mode and recalculates presentation layout.
    set scaling(value: PsxScalingMode) {
        this._assertLive();
        if (!isPsxScalingMode(value)) throw invalid("PsxDisplay scaling is invalid.", value);
        if (this._scaling === value) return;
        this._scaling = value;
        this._updateLayout();
    }

    // SETTER :: psxImageRendering -> VOID
    // Sets pixelated or smooth sampling on both context and canvas.
    set imageRendering(value: PsxImageRendering) {
        this._assertLive();
        if (value !== "pixelated" && value !== "smooth") {
            throw invalid("PsxDisplay image rendering is invalid.", value);
        }
        this._imageRendering = value;
        this._applyFiltering();
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: psxSession -> unsubscribe
    // Attaches to one session and initializes geometry before its first frame.
    attach(session: PsxSession): Unsubscribe {
        this._assertLive();
        if (!isPsxSession(session)) throw invalid("PsxDisplay requires a session.", session);
        if (this._unsubscribeFrame !== null) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.ALREADY_STARTED,
            message: "PsxDisplay is already attached.",
        });
        this._frameSize = {
            width: session.machine.geometry.width,
            height: session.machine.geometry.height,
        };
        this._aspectRatio = session.machine.geometry.aspectRatio;
        this._setBackingSize(this._frameSize);
        this._updateLayout();
        this._hasFrame = false;
        const unsubscribe = session.onFrame((frame) => this.draw(frame));
        this._unsubscribeFrame = unsubscribe;
        return () => {
            if (this._unsubscribeFrame === unsubscribe) this.detach();
        };
    }

    // METHOD :: VOID -> VOID
    // Removes the active session frame subscription.
    detach(): void {
        const unsubscribe = this._unsubscribeFrame;
        if (unsubscribe === null) return;
        this._unsubscribeFrame = null;
        unsubscribe();
    }

    // METHOD :: psxFrameEvent -> VOID
    // Validates and draws one RGBA frame, updating geometry when necessary.
    draw(frame: PsxFrameEvent): void {
        this._assertLive();
        if (!isPsxFrameEvent(frame)) throw invalid("PsxDisplay frame is invalid.", frame);
        const geometryChanged = frame.width !== this._frameSize.width
            || frame.height !== this._frameSize.height || frame.aspectRatio !== this._aspectRatio;
        this._frameSize = { width: frame.width, height: frame.height };
        this._aspectRatio = frame.aspectRatio;
        this._setBackingSize(frame);
        if (geometryChanged) this._updateLayout();
        if (this._image === null || this._image.width !== frame.width || this._image.height !== frame.height) {
            this._image = this._context.createImageData(frame.width, frame.height);
        }
        this._image.data.set(frame.rgba);
        this._context.putImageData(this._image, 0, 0);
        this._hasFrame = true;
        if (this._placeholder !== null) {
            this._placeholder.hidden = true;
            this._placeholder = null;
            this._canvas.style.visibility = "";
        }
    }

    // METHOD :: NUMBER, NUMBER|psxRect -> psxDisplayLayout
    // Updates measured container bounds and returns the recalculated layout.
    resize(width: number, height: number): PsxDisplayLayout;
    resize(rect: PsxRect): PsxDisplayLayout;
    resize(rectOrWidth: PsxRect | number, height?: number): PsxDisplayLayout {
        this._assertLive();
        if (typeof rectOrWidth === "number") {
            if (!Number.isFinite(rectOrWidth) || rectOrWidth < 0
                || !Number.isFinite(height) || height! < 0) {
                throw invalid("PsxDisplay resize dimensions are invalid.", { width: rectOrWidth, height });
            }
            this._containerRect = { ...this._containerRect, width: rectOrWidth, height: height! };
        } else {
            if (!isPsxRect(rectOrWidth)) throw invalid("PsxDisplay resize rectangle is invalid.", rectOrWidth);
            this._containerRect = { ...rectOrWidth };
        }
        this._updateLayout();
        return this._layout;
    }

    // METHOD :: listener -> unsubscribe
    // Subscribes to material layout changes.
    onLayout(listener: Listener<PsxDisplayLayout>): Unsubscribe {
        this._assertLive();
        if (typeof listener !== "function") throw invalid("PsxDisplay layout listener is invalid.", listener);
        this._layoutListeners.add(listener);
        return () => this._layoutListeners.delete(listener);
    }

    // METHOD :: psxPlaceholderLike? -> VOID
    // Shows a placeholder instead of the canvas or restores the canvas surface.
    showPlaceholder(placeholder: PsxPlaceholderLike | null): void {
        this._assertLive();
        if (placeholder !== null && (typeof placeholder !== "object" || typeof placeholder.hidden !== "boolean")) {
            throw invalid("PsxDisplay placeholder is invalid.", placeholder);
        }
        if (this._placeholder !== null && this._placeholder !== placeholder) this._placeholder.hidden = true;
        this._placeholder = placeholder;
        this._canvas.style.visibility = placeholder === null ? "" : "hidden";
        if (placeholder === null) {
            this._context.clearRect(0, 0, this._canvas.width, this._canvas.height);
        } else {
            placeholder.hidden = false;
        }
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Requests fullscreen for the configured presentation target.
    async fullscreen(): Promise<void> {
        this._assertLive();
        if (this._requestFullscreen === null) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.UNSUPPORTED,
            message: "Fullscreen is unavailable.",
        });
        try {
            await this._requestFullscreen(this._fullscreenTarget);
        } catch (error) {
            throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.FULLSCREEN_FAILED,
                message: "The fullscreen request failed.",
                data: error,
            });
        }
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Exits document fullscreen through the configured boundary.
    async exitFullscreen(): Promise<void> {
        this._assertLive();
        if (this._exitFullscreen === null || this._document === null) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.UNSUPPORTED,
            message: "Fullscreen exit is unavailable.",
        });
        try {
            await this._exitFullscreen(this._document);
        } catch (error) {
            throw new PsxRuntimeError({
                code: PsxRuntimeError.CODE.FULLSCREEN_FAILED,
                message: "Exiting fullscreen failed.",
                data: error,
            });
        }
    }

    // METHOD :: VOID -> VOID
    // Detaches, disconnects observers, clears pixels, and ends ownership.
    destroy(): void {
        if (this._destroyed) return;
        this.detach();
        this._observer?.disconnect();
        this._document?.removeEventListener("fullscreenchange", this._fullscreenChanged);
        this._layoutListeners.clear();
        if (this._placeholder !== null) this._placeholder.hidden = true;
        this._placeholder = null;
        this._canvas.style.visibility = "";
        this._context.clearRect(0, 0, this._canvas.width, this._canvas.height);
        this._destroyed = true;
    }

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: VOID -> VOID
    // Re-measures layout after a browser fullscreen transition.
    private readonly _fullscreenChanged = (): void => {
        if (!this._destroyed) this.resize(PsxDisplay.rectOf(this._container));
    };

    // METHOD :: frameSize -> VOID
    // Resizes the canvas backing store and invalidates reusable image data.
    private _setBackingSize(size: FrameSize): void {
        if (this._canvas.width === size.width && this._canvas.height === size.height) return;
        this._canvas.width = size.width;
        this._canvas.height = size.height;
        this._image = null;
        this._applyFiltering();
    }

    // METHOD :: VOID -> VOID
    // Applies the active image-sampling preference to context and canvas.
    private _applyFiltering(): void {
        const smooth = this._imageRendering === "smooth";
        this._context.imageSmoothingEnabled = smooth;
        this._canvas.style.imageRendering = smooth ? "auto" : "pixelated";
    }

    // METHOD :: VOID -> psxDisplayLayout
    // Computes, styles, freezes, and returns the current layout.
    private _applyLayout(): PsxDisplayLayout {
        const layout = PsxDisplay.layoutFor(
            this._containerRect,
            this._frameSize,
            this._aspectRatio,
            this._scaling,
        );
        this._canvas.style.width = `${layout.width}px`;
        this._canvas.style.height = `${layout.height}px`;
        return Object.freeze(layout);
    }

    // METHOD :: VOID -> VOID
    // Applies a new layout and notifies observers only after material change.
    private _updateLayout(): void {
        const previous = this._layout;
        this._layout = this._applyLayout();
        if (previous.left === this._layout.left && previous.top === this._layout.top
            && previous.width === this._layout.width && previous.height === this._layout.height
            && previous.scale === this._layout.scale) return;
        this._layoutListeners.forEach((listener) => listener(this._layout));
    }

    // METHOD :: VOID -> VOID
    // Rejects display operations after destruction.
    private _assertLive(): void {
        if (this._destroyed) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "PsxDisplay has been destroyed.",
        });
    }

    /**
     *
     * Static Methods
     *
     */

    // METHOD :: psxRect, frameSize, NUMBER, psxScalingMode -> psxDisplayLayout
    // Computes centered presentation geometry for one scaling strategy.
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

    // METHOD :: psxContainerLike -> psxRect
    // Copies one live bounding rectangle into the runtime's stable shape.
    static rectOf(container: PsxDisplayConfig["container"]): PsxRect {
        const rect = container.getBoundingClientRect();
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }

    // Static Factory Method :: psxDisplayConfig -> psxDisplay
    // Fills available browser observer and fullscreen boundaries before construction.
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
