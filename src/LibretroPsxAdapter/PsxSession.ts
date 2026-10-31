import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";
import {
    isControllerPort,
    isPsxAxisControl,
    isPsxButtonControl,
} from "../shared.types.js";

import type {
    ControllerPort,
    Listener,
    PsxAxisControl,
    PsxButtonControl,
    PsxFrameEvent,
    PsxMachineInfo,
    PsxRumbleEvent,
    PsxSession as PsxSessionContract,
    PsxSoundEvent,
    Unsubscribe,
} from "../shared.types.js";
import type WorkerClient from "./WorkerClient.js";

export interface SessionWorker {
    readonly client: WorkerClient;
    readonly machine: PsxMachineInfo;
}

export type RestartSession = (
    cards: Readonly<Record<ControllerPort, Uint8Array>>,
) => Promise<SessionWorker>;

const invalid = (data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.INVALID_CONFIG,
    message: "The PlayStation session method received an invalid argument.",
    data,
});

export default class PsxSession implements PsxSessionContract {
    #machine: PsxMachineInfo;
    #client: WorkerClient;
    readonly #restart: RestartSession;
    readonly #tickListeners = new Set<Listener<void>>();
    readonly #frameListeners = new Set<Listener<PsxFrameEvent>>();
    readonly #soundListeners = new Set<Listener<PsxSoundEvent>>();
    readonly #rumbleListeners = new Set<Listener<PsxRumbleEvent>>();
    readonly #exitListeners = new Set<Listener<void>>();
    #clientUnsubscribes: Unsubscribe[] = [];
    #operationTail: Promise<void> = Promise.resolve();
    #exitPromise: Promise<void> | null = null;
    #destroyed = false;
    #paused = false;
    #discIndex = 0;
    #trayOpen = false;
    #exitEmitted = false;
    #finalCards: Readonly<Record<ControllerPort, Uint8Array>> | null = null;

    constructor(worker: SessionWorker, restart: RestartSession) {
        this.#machine = worker.machine;
        this.#client = worker.client;
        this.#restart = restart;
        this.#attachClient();
    }

    get machine(): PsxMachineInfo {
        return this.#machine;
    }

    get discIndex(): number {
        return this.#discIndex;
    }

    get trayOpen(): boolean {
        return this.#trayOpen;
    }

    get finalMemoryCards(): Readonly<Record<ControllerPort, Uint8Array>> | null {
        if (this.#finalCards === null) return null;
        return { 1: this.#finalCards[1].slice(), 2: this.#finalCards[2].slice() };
    }

    setButton(control: PsxButtonControl, pressed: boolean): void {
        this.#assertLive();
        if (!isPsxButtonControl(control) || typeof pressed !== "boolean") throw invalid({ control, pressed });
        this.#client.setButton(control.port, control.button, pressed);
    }

    setAxis(control: PsxAxisControl, value: number): void {
        this.#assertLive();
        if (!isPsxAxisControl(control) || !Number.isFinite(value)) throw invalid({ control, value });
        this.#client.setAxis(control.port, control.axis, Math.max(-1, Math.min(1, value)));
    }

    pause(): void {
        this.#assertLive();
        if (this.#paused) return;
        this.#paused = true;
        this.#client.pause();
    }

    resume(): void {
        this.#assertLive();
        if (!this.#paused) return;
        this.#paused = false;
        this.#client.resume();
    }

    reset(kind: "soft" | "hard"): Promise<void> {
        this.#assertLive();
        if (kind !== "soft" && kind !== "hard") return Promise.reject(invalid(kind));
        return this.#queue(async () => {
            if (kind === "soft") {
                await this.#client.reset();
                return;
            }
            const cards = await this.#readBothCards();
            const previous = this.#client;
            this.#detachClient();
            await previous.exit();
            try {
                const replacement = await this.#restart(cards);
                this.#client = replacement.client;
                this.#machine = replacement.machine;
                this.#discIndex = 0;
                this.#trayOpen = false;
                this.#paused = false;
                this.#attachClient();
            } catch (error) {
                this.#destroyed = true;
                this.#emitExit();
                throw error;
            }
        });
    }

    setDisc(index: number): Promise<void> {
        this.#assertLive();
        if (!Number.isSafeInteger(index) || index < 0 || index >= this.#machine.discCount) {
            return Promise.reject(invalid(index));
        }
        return this.#queue(async () => {
            const state = await this.#client.setDisc(index);
            this.#discIndex = state.discIndex;
            this.#trayOpen = state.trayOpen;
        });
    }

    readMemoryCard(slot: ControllerPort): Promise<Uint8Array> {
        this.#assertLive();
        if (!isControllerPort(slot)) return Promise.reject(invalid(slot));
        return this.#queue(() => this.#client.readMemoryCard(slot));
    }

    serializeState(): Promise<Uint8Array> {
        this.#assertLive();
        return this.#queue(() => this.#client.serializeState());
    }

    unserializeState(bytes: Uint8Array): Promise<void> {
        this.#assertLive();
        if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return Promise.reject(invalid(bytes));
        return this.#queue(() => this.#client.unserializeState(bytes));
    }

    exit(): Promise<void> {
        if (this.#exitPromise !== null) return this.#exitPromise;
        this.#assertLive();
        this.#exitPromise = this.#queue(async () => {
            let caught: unknown;
            try {
                this.#finalCards = await this.#readBothCards();
            } catch (error) {
                caught = error;
            }
            this.#detachClient();
            try {
                await this.#client.exit();
            } catch (error) {
                caught ??= error;
                this.#client.terminate();
            }
            this.#destroyed = true;
            this.#emitExit();
            if (caught !== undefined) throw caught;
        });
        return this.#exitPromise;
    }

    onTick(listener: Listener<void>): Unsubscribe {
        return this.#subscribe(this.#tickListeners, listener);
    }

    onFrame(listener: Listener<PsxFrameEvent>): Unsubscribe {
        return this.#subscribe(this.#frameListeners, listener);
    }

    onSound(listener: Listener<PsxSoundEvent>): Unsubscribe {
        return this.#subscribe(this.#soundListeners, listener);
    }

    onRumble(listener: Listener<PsxRumbleEvent>): Unsubscribe {
        return this.#subscribe(this.#rumbleListeners, listener);
    }

    onExit(listener: Listener<void>): Unsubscribe {
        return this.#subscribe(this.#exitListeners, listener);
    }

    #attachClient(): void {
        this.#clientUnsubscribes = [
            this.#client.on("tick", () => this.#emit(this.#tickListeners, undefined)),
            this.#client.on("frame", (frame) => {
                if (frame.width !== this.#machine.geometry.width
                    || frame.height !== this.#machine.geometry.height
                    || frame.aspectRatio !== this.#machine.geometry.aspectRatio) {
                    this.#machine = { ...this.#machine, geometry: {
                        width: frame.width,
                        height: frame.height,
                        aspectRatio: frame.aspectRatio,
                    } };
                }
                this.#emit(this.#frameListeners, frame);
            }),
            this.#client.on("geometry", (geometry) => {
                this.#machine = { ...this.#machine, geometry };
            }),
            this.#client.on("sound", (sound) => this.#emit(this.#soundListeners, sound)),
            this.#client.on("rumble", (rumble) => this.#emit(this.#rumbleListeners, rumble)),
            this.#client.on("failure", () => {
                this.#destroyed = true;
                this.#emitExit();
            }),
            this.#client.on("exit", () => {
                if (!this.#destroyed) {
                    this.#destroyed = true;
                    this.#emitExit();
                }
            }),
        ];
    }

    #detachClient(): void {
        this.#clientUnsubscribes.splice(0).forEach((unsubscribe) => unsubscribe());
    }

    async #readBothCards(): Promise<Readonly<Record<ControllerPort, Uint8Array>>> {
        const first = await this.#client.readMemoryCard(1);
        const second = await this.#client.readMemoryCard(2);
        return { 1: first, 2: second };
    }

    #queue<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.#operationTail.then(operation);
        this.#operationTail = next.then(() => undefined, () => undefined);
        return next;
    }

    #assertLive(): void {
        if (this.#destroyed) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "The PlayStation session has exited.",
        });
    }

    #subscribe<T>(listeners: Set<Listener<T>>, listener: Listener<T>): Unsubscribe {
        this.#assertLive();
        if (typeof listener !== "function") throw invalid(listener);
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    #emit<T>(listeners: Set<Listener<T>>, event: T): void {
        for (const listener of [...listeners]) {
            try {
                listener(event);
            } catch {
                // Event consumers do not own the emulation lifecycle.
            }
        }
    }

    #emitExit(): void {
        if (this.#exitEmitted) return;
        this.#exitEmitted = true;
        this.#emit(this.#exitListeners, undefined);
    }
}
