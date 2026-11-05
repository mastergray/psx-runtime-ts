export type CorePixelFormat = "0rgb1555" | "rgb565" | "xrgb8888";

export interface CoreVideoFrame {
    readonly data: Uint8Array;
    readonly width: number;
    readonly height: number;
    readonly pitch: number;
    readonly aspectRatio: number;
    readonly format: CorePixelFormat;
}

const expandFive = (value: number): number => (value << 3) | (value >> 2);
const expandSix = (value: number): number => (value << 2) | (value >> 4);

export function convertVideoFrame(frame: CoreVideoFrame, destination: ArrayBuffer): Uint8ClampedArray {
    const bytesPerPixel = frame.format === "xrgb8888" ? 4 : 2;
    const outputBytes = frame.width * frame.height * 4;
    if (!Number.isSafeInteger(frame.width) || frame.width <= 0
        || !Number.isSafeInteger(frame.height) || frame.height <= 0
        || !Number.isSafeInteger(frame.pitch) || frame.pitch < frame.width * bytesPerPixel
        || !Number.isFinite(frame.aspectRatio) || frame.aspectRatio <= 0
        || frame.data.byteLength < frame.pitch * frame.height
        || destination.byteLength !== outputBytes) {
        throw new TypeError("invalid video frame geometry or buffer size");
    }
    const output = new Uint8ClampedArray(destination);
    const packed = new Uint32Array(destination);
    if (frame.format === "xrgb8888" && frame.data.byteOffset % 4 === 0
        && frame.data.byteLength % 4 === 0 && frame.pitch % 4 === 0) {
        const source = new Uint32Array(
            frame.data.buffer,
            frame.data.byteOffset,
            frame.data.byteLength / Uint32Array.BYTES_PER_ELEMENT,
        );
        const sourceStride = frame.pitch / Uint32Array.BYTES_PER_ELEMENT;
        let target = 0;
        for (let y = 0; y < frame.height; y++) {
            let sourceIndex = y * sourceStride;
            const sourceEnd = sourceIndex + frame.width;
            while (sourceIndex < sourceEnd) {
                const pixel = source[sourceIndex++]!;
                packed[target++] = (0xff000000
                    | (pixel & 0xff) << 16
                    | pixel & 0xff00
                    | (pixel >>> 16) & 0xff) >>> 0;
            }
        }
        return output;
    }
    if (frame.format !== "xrgb8888" && frame.data.byteOffset % 2 === 0
        && frame.data.byteLength % 2 === 0 && frame.pitch % 2 === 0) {
        const source = new Uint16Array(
            frame.data.buffer,
            frame.data.byteOffset,
            frame.data.byteLength / Uint16Array.BYTES_PER_ELEMENT,
        );
        const sourceStride = frame.pitch / Uint16Array.BYTES_PER_ELEMENT;
        let target = 0;
        for (let y = 0; y < frame.height; y++) {
            let sourceIndex = y * sourceStride;
            const sourceEnd = sourceIndex + frame.width;
            while (sourceIndex < sourceEnd) {
                const pixel = source[sourceIndex++]!;
                const red = frame.format === "rgb565"
                    ? expandFive((pixel >>> 11) & 0x1f)
                    : expandFive((pixel >>> 10) & 0x1f);
                const green = frame.format === "rgb565"
                    ? expandSix((pixel >>> 5) & 0x3f)
                    : expandFive((pixel >>> 5) & 0x1f);
                const blue = expandFive(pixel & 0x1f);
                packed[target++] = (0xff000000 | blue << 16 | green << 8 | red) >>> 0;
            }
        }
        return output;
    }
    const source = new DataView(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
    let target = 0;
    for (let y = 0; y < frame.height; y++) {
        let sourceOffset = y * frame.pitch;
        for (let x = 0; x < frame.width; x++) {
            const pixel = frame.format === "xrgb8888"
                ? source.getUint32(sourceOffset, true)
                : source.getUint16(sourceOffset, true);
            const red = frame.format === "xrgb8888"
                ? (pixel >>> 16) & 0xff
                : frame.format === "rgb565"
                    ? expandFive((pixel >>> 11) & 0x1f)
                    : expandFive((pixel >>> 10) & 0x1f);
            const green = frame.format === "xrgb8888"
                ? (pixel >>> 8) & 0xff
                : frame.format === "rgb565"
                    ? expandSix((pixel >>> 5) & 0x3f)
                    : expandFive((pixel >>> 5) & 0x1f);
            const blue = frame.format === "xrgb8888" ? pixel & 0xff : expandFive(pixel & 0x1f);
            packed[target++] = (0xff000000 | blue << 16 | green << 8 | red) >>> 0;
            sourceOffset += bytesPerPixel;
        }
    }
    return output;
}

export function convertAudioSamples(samples: Int16Array): Float32Array {
    const converted = new Float32Array(samples.length);
    for (let index = 0; index < samples.length; index++) {
        converted[index] = samples[index]! / 32768;
    }
    return converted;
}
