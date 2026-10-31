export interface TransferBufferLease {
    readonly id: number;
    readonly buffer: ArrayBuffer;
}

interface BufferSlot {
    buffer: ArrayBuffer | null;
    expectedBytes: number;
    outstanding: boolean;
}

export default class TransferBufferPool {
    readonly capacity: number;
    dropped = 0;

    #closed = false;
    readonly #slots: BufferSlot[];

    constructor(capacity = 3) {
        if (!Number.isSafeInteger(capacity) || capacity <= 0) {
            throw new TypeError("capacity must be a positive integer");
        }
        this.capacity = capacity;
        this.#slots = Array.from({ length: capacity }, () => ({
            buffer: new ArrayBuffer(0),
            expectedBytes: 0,
            outstanding: false,
        }));
    }

    acquire(bytes: number): TransferBufferLease | null {
        if (this.#closed) throw new Error("buffer pool is closed");
        if (!Number.isSafeInteger(bytes) || bytes <= 0) {
            throw new TypeError("bytes must be a positive integer");
        }
        const id = this.#slots.findIndex(({ outstanding }) => !outstanding);
        if (id < 0) {
            this.dropped++;
            return null;
        }
        const slot = this.#slots[id]!;
        if (slot.buffer === null || slot.buffer.byteLength !== bytes) {
            slot.buffer = new ArrayBuffer(bytes);
        }
        const buffer = slot.buffer;
        slot.buffer = null;
        slot.expectedBytes = bytes;
        slot.outstanding = true;
        return { id, buffer };
    }

    release(id: number, buffer: ArrayBuffer): void {
        if (this.#closed) return;
        const slot = this.#slots[id];
        if (slot === undefined || !slot.outstanding) {
            throw new Error("video buffer is not outstanding");
        }
        if (buffer.byteLength !== slot.expectedBytes) {
            throw new Error("returned video buffer has the wrong size");
        }
        slot.buffer = buffer;
        slot.outstanding = false;
    }

    close(): void {
        this.#closed = true;
        for (const slot of this.#slots) {
            slot.buffer = null;
            slot.expectedBytes = 0;
            slot.outstanding = false;
        }
    }
}
