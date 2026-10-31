// Shared dependency-boundary types used by the public runtime contracts.

export type Unsubscribe = () => void;

export type Listener<T> = (event: T) => void;

export interface FrameScheduler {
    request(callback: (time: number) => void): number;
    cancel(handle: number): void;
}

export interface FetchResponseLike {
    readonly ok: boolean;
    readonly status: number;
    arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (url: string) => Promise<FetchResponseLike>;
