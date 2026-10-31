import { isPsxSession } from "../shared.types.js";

import type { PsxSession } from "../shared.types.js";

export type PsxScalingMode = "fit" | "integer" | "fill" | "stretch";
export type PsxImageRendering = "pixelated" | "smooth";

export interface PsxRect {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

export interface PsxDisplayLayout extends PsxRect {
    readonly scale: number;
}

export interface PsxImageDataLike {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
}

export interface PsxCanvasContextLike {
    imageSmoothingEnabled: boolean;
    createImageData(width: number, height: number): PsxImageDataLike;
    putImageData(image: PsxImageDataLike, x: number, y: number): void;
    clearRect(x: number, y: number, width: number, height: number): void;
}

export interface PsxCanvasStyleLike {
    width: string;
    height: string;
    imageRendering: string;
    visibility: string;
}

export interface PsxCanvasLike {
    width: number;
    height: number;
    readonly style: PsxCanvasStyleLike;
    getContext(type: "2d"): PsxCanvasContextLike | null;
}

export interface PsxContainerLike {
    getBoundingClientRect(): PsxRect;
}

export interface PsxPlaceholderLike {
    hidden: boolean;
}

export interface PsxResizeObserverLike {
    observe(target: PsxContainerLike): void;
    disconnect(): void;
}

export interface PsxResizeObserverConstructorLike {
    new (callback: (entries: ReadonlyArray<{ readonly contentRect: PsxRect }>) => void): PsxResizeObserverLike;
}

export interface PsxDisplayDocumentLike {
    readonly fullscreenElement?: object | null;
    addEventListener(type: "fullscreenchange", listener: () => void): void;
    removeEventListener(type: "fullscreenchange", listener: () => void): void;
}

export type PsxRequestFullscreen = (target: object) => Promise<void>;
export type PsxExitFullscreen = (document: PsxDisplayDocumentLike) => Promise<void>;

export interface PsxDisplayConfig {
    readonly canvas: PsxCanvasLike;
    readonly container: PsxContainerLike;
    readonly context?: PsxCanvasContextLike;
    readonly scaling?: PsxScalingMode;
    readonly imageRendering?: PsxImageRendering;
    readonly resizeObserver?: PsxResizeObserverConstructorLike;
    readonly fullscreenTarget?: object;
    readonly document?: PsxDisplayDocumentLike;
    readonly requestFullscreen?: PsxRequestFullscreen;
    readonly exitFullscreen?: PsxExitFullscreen;
}

export interface PsxDisplayAttachConfig {
    readonly session: PsxSession;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);

export function isPsxScalingMode(value: unknown): value is PsxScalingMode {
    return value === "fit" || value === "integer" || value === "fill" || value === "stretch";
}

export function isPsxRect(value: unknown): value is PsxRect {
    return isObject(value) && isFiniteNumber(value.left) && isFiniteNumber(value.top)
        && isFiniteNumber(value.width) && value.width >= 0
        && isFiniteNumber(value.height) && value.height >= 0;
}

export function isPsxDisplayLayout(value: unknown): value is PsxDisplayLayout {
    return isPsxRect(value) && isFiniteNumber((value as PsxDisplayLayout).scale)
        && (value as PsxDisplayLayout).scale >= 0;
}

export function isPsxCanvasContextLike(value: unknown): value is PsxCanvasContextLike {
    return isObject(value) && typeof value.imageSmoothingEnabled === "boolean"
        && typeof value.createImageData === "function" && typeof value.putImageData === "function"
        && typeof value.clearRect === "function";
}

export function isPsxCanvasLike(value: unknown): value is PsxCanvasLike {
    return isObject(value) && typeof value.width === "number" && typeof value.height === "number"
        && isObject(value.style) && typeof value.getContext === "function";
}

export function isPsxContainerLike(value: unknown): value is PsxContainerLike {
    return isObject(value) && typeof value.getBoundingClientRect === "function";
}

export function isPsxDisplayDocumentLike(value: unknown): value is PsxDisplayDocumentLike {
    return isObject(value) && typeof value.addEventListener === "function"
        && typeof value.removeEventListener === "function"
        && (value.fullscreenElement === undefined || value.fullscreenElement === null
            || isObject(value.fullscreenElement));
}

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

export function isPsxDisplayAttachConfig(value: unknown): value is PsxDisplayAttachConfig {
    return isObject(value) && isPsxSession(value.session);
}
