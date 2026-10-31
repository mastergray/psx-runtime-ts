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
    const source = new DataView(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
    const output = new Uint8ClampedArray(destination);
    let target = 0;
    for (let y = 0; y < frame.height; y++) {
        let sourceOffset = y * frame.pitch;
        for (let x = 0; x < frame.width; x++) {
            if (frame.format === "xrgb8888") {
                const pixel = source.getUint32(sourceOffset, true);
                output[target] = (pixel >>> 16) & 0xff;
                output[target + 1] = (pixel >>> 8) & 0xff;
                output[target + 2] = pixel & 0xff;
                sourceOffset += 4;
            } else {
                const pixel = source.getUint16(sourceOffset, true);
                if (frame.format === "rgb565") {
                    output[target] = expandFive((pixel >>> 11) & 0x1f);
                    output[target + 1] = expandSix((pixel >>> 5) & 0x3f);
                } else {
                    output[target] = expandFive((pixel >>> 10) & 0x1f);
                    output[target + 1] = expandFive((pixel >>> 5) & 0x1f);
                }
                output[target + 2] = expandFive(pixel & 0x1f);
                sourceOffset += 2;
            }
            output[target + 3] = 0xff;
            target += 4;
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
