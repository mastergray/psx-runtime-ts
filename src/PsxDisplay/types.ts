// Dependencies:
import { isPsxSession } from "../shared.types.js";    // Validates sessions attached through the display config

// Type dependencies:
import type { PsxSession } from "../shared.types.js"; // Session source of video frames and geometry

/**
 *
 * Type Declarations
 *
 */

// TYPE :: "fit"|"integer"|"fill"|"stretch"
// Supported strategies for sizing corrected video inside a container.
export type PsxScalingMode = "fit" | "integer" | "fill" | "stretch";

// TYPE :: "pixelated"|"smooth"
// Canvas sampling preference applied to context and CSS presentation.
export type PsxImageRendering = "pixelated" | "smooth";

// INTERFACE :: {left:NUMBER, top:NUMBER, width:NUMBER, height:NUMBER}
// Measured position and non-negative dimensions of a display rectangle.
export interface PsxRect {
    readonly left: number;      // Horizontal origin in CSS pixels
    readonly top: number;       // Vertical origin in CSS pixels
    readonly width: number;     // Non-negative horizontal extent
    readonly height: number;    // Non-negative vertical extent
}

// INTERFACE :: psxRect & {scale:NUMBER}
// Computed presentation rectangle and native horizontal scale.
export interface PsxDisplayLayout extends PsxRect {
    readonly scale: number;    // Non-negative output width divided by native width
}

// INTERFACE :: {width:NUMBER, height:NUMBER, data:uint8ClampedArray}
// Writable Canvas image surface used to present one RGBA frame.
export interface PsxImageDataLike {
    readonly width: number;               // Horizontal backing pixels
    readonly height: number;              // Vertical backing pixels
    readonly data: Uint8ClampedArray;     // Mutable RGBA bytes
}

// INTERFACE :: minimal Canvas 2D drawing operations
// Rendering boundary used for image allocation, presentation, filtering, and clearing.
export interface PsxCanvasContextLike {
    imageSmoothingEnabled: boolean;                                             // Whether scaled output is filtered
    createImageData(width: number, height: number): PsxImageDataLike;           // Allocates one writable RGBA surface
    putImageData(image: PsxImageDataLike, x: number, y: number): void;          // Presents one surface at backing coordinates
    clearRect(x: number, y: number, width: number, height: number): void;       // Clears backing pixels
}

// INTERFACE :: {width:STRING, height:STRING, imageRendering:STRING, visibility:STRING}
// Mutable CSS properties controlled by the display.
export interface PsxCanvasStyleLike {
    width: string;             // Presented CSS width
    height: string;            // Presented CSS height
    imageRendering: string;    // Browser sampling hint
    visibility: string;        // Placeholder-controlled visibility
}

// INTERFACE :: {width:NUMBER, height:NUMBER, style:psxCanvasStyleLike, getContext:("2d" -> psxCanvasContextLike?)}
// Canvas backing store and presentation style boundary.
export interface PsxCanvasLike {
    width: number;                                        // Backing-store width
    height: number;                                       // Backing-store height
    readonly style: PsxCanvasStyleLike;                   // Mutable presentation styles
    getContext(type: "2d"): PsxCanvasContextLike | null; // Acquires the Canvas 2D boundary
}

// INTERFACE :: {getBoundingClientRect:(VOID -> psxRect)}
// Responsive layout boundary measured by the display.
export interface PsxContainerLike {
    getBoundingClientRect(): PsxRect;    // Returns current CSS bounds
}

// INTERFACE :: {hidden:BOOLEAN}
// Minimal pre-frame placeholder visibility surface.
export interface PsxPlaceholderLike {
    hidden: boolean;    // Whether the placeholder is suppressed
}

// INTERFACE :: {observe:(psxContainerLike -> VOID), disconnect:(VOID -> VOID)}
// Active container resize observation handle.
export interface PsxResizeObserverLike {
    observe(target: PsxContainerLike): void;    // Begins observing one container
    disconnect(): void;                         // Stops every observation
}

// INTERFACE :: CONSTRUCTOR((entries -> VOID) -> psxResizeObserverLike)
// Injectable ResizeObserver-compatible constructor.
export interface PsxResizeObserverConstructorLike {
    new (callback: (entries: ReadonlyArray<{ readonly contentRect: PsxRect }>) => void): PsxResizeObserverLike;
}

// INTERFACE :: {fullscreenElement:OBJECT?, addEventListener:("fullscreenchange", (VOID -> VOID) -> VOID), removeEventListener:("fullscreenchange", (VOID -> VOID) -> VOID)}
// Minimal document boundary used to observe fullscreen state.
export interface PsxDisplayDocumentLike {
    readonly fullscreenElement?: object | null;                                      // Element currently presented fullscreen
    addEventListener(type: "fullscreenchange", listener: () => void): void;          // Installs fullscreen observation
    removeEventListener(type: "fullscreenchange", listener: () => void): void;       // Removes fullscreen observation
}

// TYPE :: OBJECT -> PROMISE(VOID)
// Injectable operation requesting fullscreen for one presentation target.
export type PsxRequestFullscreen = (target: object) => Promise<void>;

// TYPE :: psxDisplayDocumentLike -> PROMISE(VOID)
// Injectable operation exiting document fullscreen.
export type PsxExitFullscreen = (document: PsxDisplayDocumentLike) => Promise<void>;

// INTERFACE :: display rendering, resizing, and fullscreen dependencies
// Complete construction input for one responsive display.
export interface PsxDisplayConfig {
    readonly canvas: PsxCanvasLike;                                  // Backing and presentation surface
    readonly container: PsxContainerLike;                            // Responsive layout boundary
    readonly context?: PsxCanvasContextLike;                         // Optional pre-acquired Canvas 2D context
    readonly scaling?: PsxScalingMode;                               // Initial scaling strategy
    readonly imageRendering?: PsxImageRendering;                     // Initial sampling preference
    readonly resizeObserver?: PsxResizeObserverConstructorLike;      // Optional responsive observation constructor
    readonly fullscreenTarget?: object;                              // Element requested for fullscreen
    readonly document?: PsxDisplayDocumentLike;                      // Fullscreen state boundary
    readonly requestFullscreen?: PsxRequestFullscreen;               // Fullscreen request operation
    readonly exitFullscreen?: PsxExitFullscreen;                     // Fullscreen exit operation
}

// INTERFACE :: {session:psxSession}
// Session attachment input used by display-boundary validation.
export interface PsxDisplayAttachConfig {
    readonly session: PsxSession;    // Live source of frame events and geometry
}

/**
 *
 * Type Predicates
 *
 */

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a non-null object suitable for structural inspection.
const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a finite number.
const isFiniteNumber = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is one supported display scaling strategy.
export function isPsxScalingMode(value: unknown): value is PsxScalingMode {
    return value === "fit" || value === "integer" || value === "fill" || value === "stretch";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a finite rectangle with non-negative dimensions.
export function isPsxRect(value: unknown): value is PsxRect {
    return isObject(value) && isFiniteNumber(value.left) && isFiniteNumber(value.top)
        && isFiniteNumber(value.width) && value.width >= 0
        && isFiniteNumber(value.height) && value.height >= 0;
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a valid rectangle with a non-negative native scale.
export function isPsxDisplayLayout(value: unknown): value is PsxDisplayLayout {
    return isPsxRect(value) && isFiniteNumber((value as PsxDisplayLayout).scale)
        && (value as PsxDisplayLayout).scale >= 0;
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value exposes every Canvas 2D operation required by the display.
export function isPsxCanvasContextLike(value: unknown): value is PsxCanvasContextLike {
    return isObject(value) && typeof value.imageSmoothingEnabled === "boolean"
        && typeof value.createImageData === "function" && typeof value.putImageData === "function"
        && typeof value.clearRect === "function";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value exposes backing dimensions, mutable style, and context acquisition.
export function isPsxCanvasLike(value: unknown): value is PsxCanvasLike {
    return isObject(value) && typeof value.width === "number" && typeof value.height === "number"
        && isObject(value.style) && typeof value.getContext === "function";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value supplies measurable container bounds.
export function isPsxContainerLike(value: unknown): value is PsxContainerLike {
    return isObject(value) && typeof value.getBoundingClientRect === "function";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value exposes fullscreen state and change observation.
export function isPsxDisplayDocumentLike(value: unknown): value is PsxDisplayDocumentLike {
    return isObject(value) && typeof value.addEventListener === "function"
        && typeof value.removeEventListener === "function"
        && (value.fullscreenElement === undefined || value.fullscreenElement === null
            || isObject(value.fullscreenElement));
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value coherently supplies rendering, resizing, and optional fullscreen boundaries.
export function isPsxDisplayConfig(value: unknown): value is PsxDisplayConfig {
    if (!isObject(value) || !isPsxCanvasLike(value.canvas) || !isPsxContainerLike(value.container)
        || (value.context !== undefined && !isPsxCanvasContextLike(value.context))
        || (value.scaling !== undefined && !isPsxScalingMode(value.scaling))
        || (value.imageRendering !== undefined
            && value.imageRendering !== "pixelated" && value.imageRendering !== "smooth")
        || (value.resizeObserver !== undefined && typeof value.resizeObserver !== "function")
        || (value.fullscreenTarget !== undefined && !isObject(value.fullscreenTarget))
        || (value.document !== undefined && !isPsxDisplayDocumentLike(value.document))
        || (value.requestFullscreen !== undefined && typeof value.requestFullscreen !== "function")
        || (value.exitFullscreen !== undefined && typeof value.exitFullscreen !== "function")) return false;
    return true;
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value contains a structurally valid PSX session.
export function isPsxDisplayAttachConfig(value: unknown): value is PsxDisplayAttachConfig {
    return isObject(value) && isPsxSession(value.session);
}
