const ROUND_CONSTANTS = new Uint32Array([    // Fixed SHA-256 round constants from FIPS 180-4
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 *
 * Class
 *
 */

// Computes one incremental SHA-256 digest without buffering the complete input.
export default class Sha256 {

    /* Instance Fields */
    private readonly _state = new Uint32Array([      // Current eight-word digest state
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    private readonly _buffer = new Uint8Array(64);    // Partial 512-bit block retained across updates
    private readonly _words = new Uint32Array(64);    // Expanded message schedule for one compression
    private _bufferLength = 0;                        // Occupied bytes in the partial block
    private _bytes = 0;                               // Total input bytes accepted before finalization
    private _finished = false;                        // Whether digestHex has finalized this instance

    // CONSTRUCTOR :: VOID -> sha256
    // Creates an empty incremental digest with the standard initial state.
    constructor() {}

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: uint8Array -> VOID
    // Adds one binary chunk to the pending digest.
    update(input: Uint8Array): void {
        if (this._finished) throw new Error("SHA-256 digest is already finalized.");
        this._bytes += input.byteLength;
        let offset = 0;
        while (offset < input.byteLength) {
            const take = Math.min(64 - this._bufferLength, input.byteLength - offset);
            this._buffer.set(input.subarray(offset, offset + take), this._bufferLength);
            this._bufferLength += take;
            offset += take;
            if (this._bufferLength === 64) {
                this._compress(this._buffer);
                this._bufferLength = 0;
            }
        }
    }

    // METHOD :: VOID -> STRING
    // Finalizes the digest once and returns lowercase hexadecimal output.
    digestHex(): string {
        if (this._finished) throw new Error("SHA-256 digest is already finalized.");
        this._finished = true;
        const bitLength = this._bytes * 8;
        this._buffer[this._bufferLength++] = 0x80;
        if (this._bufferLength > 56) {
            this._buffer.fill(0, this._bufferLength);
            this._compress(this._buffer);
            this._bufferLength = 0;
        }
        this._buffer.fill(0, this._bufferLength, 56);
        const high = Math.floor(bitLength / 0x1_0000_0000);
        const low = bitLength >>> 0;
        const view = new DataView(this._buffer.buffer);
        view.setUint32(56, high, false);
        view.setUint32(60, low, false);
        this._compress(this._buffer);
        return [...this._state].map((word) => word.toString(16).padStart(8, "0")).join("");
    }

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: uint8Array -> VOID
    // Compresses one complete 512-bit block into the current digest state.
    private _compress(block: Uint8Array): void {
        const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
        for (let index = 0; index < 16; index++) this._words[index] = view.getUint32(index * 4, false);
        for (let index = 16; index < 64; index++) {
            const left = this._words[index - 15]!;
            const right = this._words[index - 2]!;
            const s0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
            const s1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
            this._words[index] = (this._words[index - 16]! + s0
                + this._words[index - 7]! + s1) >>> 0;
        }
        let a = this._state[0]!;
        let b = this._state[1]!;
        let c = this._state[2]!;
        let d = this._state[3]!;
        let e = this._state[4]!;
        let f = this._state[5]!;
        let g = this._state[6]!;
        let h = this._state[7]!;
        for (let index = 0; index < 64; index++) {
            const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
            const choice = (e & f) ^ (~e & g);
            const t1 = (h + s1 + choice + ROUND_CONSTANTS[index]! + this._words[index]!) >>> 0;
            const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (s0 + majority) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + t1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) >>> 0;
        }
        this._state[0] = (this._state[0]! + a) >>> 0;
        this._state[1] = (this._state[1]! + b) >>> 0;
        this._state[2] = (this._state[2]! + c) >>> 0;
        this._state[3] = (this._state[3]! + d) >>> 0;
        this._state[4] = (this._state[4]! + e) >>> 0;
        this._state[5] = (this._state[5]! + f) >>> 0;
        this._state[6] = (this._state[6]! + g) >>> 0;
        this._state[7] = (this._state[7]! + h) >>> 0;
    }

}

/**
 *
 *  Helper Functions
 *
 */

// HELPER :: NUMBER, NUMBER -> NUMBER
// Rotates one unsigned 32-bit word right by the requested bit count.
const rotateRight = (value: number, bits: number): number =>
    (value >>> bits) | (value << (32 - bits));
