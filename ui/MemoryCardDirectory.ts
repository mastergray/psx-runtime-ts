// Type dependencies:
import type {
    PsxMemoryCardSaveSummary,    // One save rendered from a first-block directory entry
    PsxMemoryCardSummary,        // Complete read-only directory summary returned to the UI
} from "./types.js";

const CARD_BYTES = 128 * 1024;
const BLOCK_BYTES = 8 * 1024;
const FRAME_BYTES = 128;
const DATA_BLOCKS = 15;
const ACTIVE_STATES = Object.freeze([0x51, 0x52, 0x53]);

/**
 *
 * Functions
 *
 */

// FUNCTION :: uint8Array -> psxMemoryCardSummary
// Reads active directory entries and display titles without modifying or retaining the card bytes.
export function summarizeMemoryCard(bytes: Uint8Array): PsxMemoryCardSummary {
    if (bytes.byteLength !== CARD_BYTES || bytes[0] !== 0x4d || bytes[1] !== 0x43) {
        return Object.freeze({ valid: false, usedBlocks: 0, freeBlocks: DATA_BLOCKS, saves: Object.freeze([]) });
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const saves: PsxMemoryCardSaveSummary[] = [];
    let usedBlocks = 0;
    for (let block = 1; block <= DATA_BLOCKS; block++) {
        const directoryOffset = block * FRAME_BYTES;
        const state = view.getUint32(directoryOffset, true);
        if (ACTIVE_STATES.includes(state)) usedBlocks++;
        if (state !== 0x51) continue;
        const filename = ascii(bytes.subarray(directoryOffset + 0x0a, directoryOffset + 0x1f));
        const declaredBytes = view.getUint32(directoryOffset + 4, true);
        const blocks = Math.max(1, Math.min(DATA_BLOCKS, Math.ceil(declaredBytes / BLOCK_BYTES)));
        const titleOffset = block * BLOCK_BYTES;
        const title = bytes[titleOffset] === 0x53 && bytes[titleOffset + 1] === 0x43
            ? cardTitle(bytes.subarray(titleOffset + 4, titleOffset + 68))
            : "";
        saves.push(Object.freeze({ title: title || filename || `Save ${saves.length + 1}`, filename, blocks }));
    }
    return Object.freeze({
        valid: true,
        usedBlocks,
        freeBlocks: DATA_BLOCKS - usedBlocks,
        saves: Object.freeze(saves),
    });
}

/**
 *
 *  Helper Functions
 *
 */

// HELPER :: uint8Array -> STRING
// Decodes one zero-terminated ASCII directory field and removes non-display controls.
const ascii = (bytes: Uint8Array): string => {
    const end = bytes.indexOf(0);
    return new TextDecoder("ascii").decode(end < 0 ? bytes : bytes.subarray(0, end))
        .replace(/[\u0000-\u001f\u007f]/gu, "")
        .trim();
};

// HELPER :: uint8Array -> STRING
// Decodes the title area accepted by the BIOS as Shift-JIS or plain ASCII.
const cardTitle = (bytes: Uint8Array): string => {
    const end = bytes.indexOf(0);
    const titleBytes = end < 0 ? bytes : bytes.subarray(0, end);
    try {
        return new TextDecoder("shift_jis").decode(titleBytes)
            .replace(/[\u0000-\u001f\u007f]/gu, "")
            .trim();
    } catch {
        return ascii(titleBytes);
    }
};
