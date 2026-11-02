/**
 *
 * Type Declarations
 *
 */

// TYPE :: {id:NUMBER, buffer:arrayBuffer}
// Exclusive ownership lease returned for one transferable video buffer.
export interface TransferBufferLease {
    readonly id: number;              // Stable slot identifier required when returning the buffer
    readonly buffer: ArrayBuffer;      // Exclusively leased transferable storage
}

// TYPE :: {buffer:arrayBuffer?, expectedBytes:NUMBER, outstanding:BOOLEAN}
// Mutable ownership state for one internal pool slot.
interface BufferSlot {
    buffer: ArrayBuffer | null;        // Available storage, or NULL while transferred away
    expectedBytes: number;             // Byte length required when an outstanding lease returns
    outstanding: boolean;              // Whether ownership currently belongs to the consumer
}

/**
 *
 * Class
 *
 */

// Owns a bounded set of transferable frame buffers and enforces return ownership.
export default class TransferBufferPool {

    /* Instance Fields */
    private readonly _capacity: number;        // Fixed number of simultaneously leasable buffers
    private readonly _slots: BufferSlot[];     // Ownership and storage state for every slot
    private _dropped = 0;                      // Acquisitions rejected because every slot was leased
    private _closed = false;                   // Whether the pool has released all retained storage

    // CONSTRUCTOR :: NUMBER? -> transferBufferPool
    // Creates a bounded pool with empty reusable buffers.
    constructor(capacity = 3) {
        if (!Number.isSafeInteger(capacity) || capacity <= 0) {
            throw new TypeError("capacity must be a positive integer");
        }
        this._capacity = capacity;
        this._slots = Array.from({ length: capacity }, () => ({
            buffer: new ArrayBuffer(0),
            expectedBytes: 0,
            outstanding: false,
        }));
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> NUMBER
    // Returns the fixed slot capacity.
    get capacity(): number { return this._capacity; }

    // GETTER :: VOID -> NUMBER
    // Returns the number of acquisitions dropped under backpressure.
    get dropped(): number { return this._dropped; }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: NUMBER -> transferBufferLease?
    // Acquires exclusive ownership of a correctly sized buffer when one is available.
    acquire(bytes: number): TransferBufferLease | null {
        if (this._closed) throw new Error("buffer pool is closed");
        if (!Number.isSafeInteger(bytes) || bytes <= 0) {
            throw new TypeError("bytes must be a positive integer");
        }
        const id = this._slots.findIndex(({ outstanding }) => !outstanding);
        if (id < 0) {
            this._dropped++;
            return null;
        }
        const slot = this._slots[id]!;
        if (slot.buffer === null || slot.buffer.byteLength !== bytes) {
            slot.buffer = new ArrayBuffer(bytes);
        }
        const buffer = slot.buffer;
        slot.buffer = null;
        slot.expectedBytes = bytes;
        slot.outstanding = true;
        return { id, buffer };
    }

    // METHOD :: NUMBER, arrayBuffer -> VOID
    // Returns a transferred buffer to its exact outstanding slot.
    release(id: number, buffer: ArrayBuffer): void {
        if (this._closed) return;
        const slot = this._slots[id];
        if (slot === undefined || !slot.outstanding) {
            throw new Error("video buffer is not outstanding");
        }
        if (buffer.byteLength !== slot.expectedBytes) {
            throw new Error("returned video buffer has the wrong size");
        }
        slot.buffer = buffer;
        slot.outstanding = false;
    }

    // METHOD :: VOID -> VOID
    // Permanently closes the pool and releases all retained buffers.
    close(): void {
        this._closed = true;
        for (const slot of this._slots) {
            slot.buffer = null;
            slot.expectedBytes = 0;
            slot.outstanding = false;
        }
    }
}
