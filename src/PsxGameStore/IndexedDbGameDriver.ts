import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";

import type { PsxGameStoreDriverLike } from "./types.js";

const STORE = "games";

const failed = (message: string, data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.STORAGE_FAILED,
    message,
    data,
});

export default class IndexedDbGameDriver implements PsxGameStoreDriverLike {
    static readonly VERSION = 1;
    readonly #factory: IDBFactory;
    readonly #name: string;

    constructor(factory: IDBFactory, name: string) {
        this.#factory = factory;
        this.#name = name;
    }

    read(gameId: string): Promise<unknown> {
        return this.#request("readonly", (store, complete) => {
            const request = store.get(gameId);
            request.onsuccess = () => complete(request.result);
        });
    }

    list(): Promise<ReadonlyArray<unknown>> {
        return this.#request("readonly", (store, complete) => {
            const request = store.getAll();
            request.onsuccess = () => complete(request.result);
        });
    }

    async write(gameId: string, value: unknown): Promise<void> {
        await this.#request("readwrite", (store, complete) => {
            const request = store.put(value, gameId);
            request.onsuccess = () => complete(undefined);
        });
    }

    async remove(gameId: string): Promise<void> {
        await this.#request("readwrite", (store, complete) => {
            const request = store.delete(gameId);
            request.onsuccess = () => complete(undefined);
        });
    }

    update<T>(gameId: string, updater: (current: unknown) => {
        readonly value: unknown;
        readonly result: T;
    }): Promise<T> {
        return this.#request("readwrite", (store, complete, fail) => {
            const read = store.get(gameId);
            read.onsuccess = () => {
                let mutation: { readonly value: unknown; readonly result: T };
                try {
                    mutation = updater(read.result);
                } catch (error) {
                    fail(error);
                    return;
                }
                const write = store.put(mutation.value, gameId);
                write.onsuccess = () => complete(mutation.result);
            };
        });
    }

    async #open(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            let settled = false;
            let request: IDBOpenDBRequest;
            const rejectOnce = (message: string, data: unknown): void => {
                if (settled) return;
                settled = true;
                reject(failed(message, data));
            };
            try {
                request = this.#factory.open(this.#name, IndexedDbGameDriver.VERSION);
            } catch (error) {
                rejectOnce("IndexedDB game-library open threw.", error);
                return;
            }
            request.onupgradeneeded = () => {
                try {
                    if (!request.result.objectStoreNames.contains(STORE)) {
                        request.result.createObjectStore(STORE);
                    }
                } catch (error) {
                    rejectOnce("IndexedDB game-library upgrade failed.", error);
                    try { request.transaction?.abort(); } catch { /* retain the upgrade error */ }
                }
            };
            request.onsuccess = () => {
                if (settled) {
                    request.result.close();
                    return;
                }
                settled = true;
                resolve(request.result);
            };
            request.onerror = () => rejectOnce("IndexedDB game-library open failed.", request.error);
            request.onblocked = () => rejectOnce("IndexedDB game-library open was blocked.", null);
        });
    }

    async #request<T>(mode: IDBTransactionMode, operation: (
        store: IDBObjectStore,
        complete: (result: T) => void,
        fail: (error: unknown) => void,
    ) => void): Promise<T> {
        const database = await this.#open();
        try {
            return await new Promise<T>((resolve, reject) => {
                let settled = false;
                let operationComplete = false;
                let result: T;
                let transaction: IDBTransaction | null = null;
                const fail = (error: unknown): void => {
                    if (settled) return;
                    settled = true;
                    try { transaction?.abort(); } catch { /* retain the first error */ }
                    reject(PsxRuntimeError.is(error) ? error
                        : failed("IndexedDB game-library operation failed.", error));
                };
                try {
                    transaction = database.transaction(STORE, mode);
                    operation(transaction.objectStore(STORE), (value) => {
                        operationComplete = true;
                        result = value;
                    }, fail);
                } catch (error) {
                    fail(error);
                    return;
                }
                const active = transaction;
                active.onerror = () => fail(active.error);
                active.onabort = () => fail(active.error);
                active.oncomplete = () => {
                    if (settled) return;
                    if (!operationComplete) {
                        fail(new Error("Transaction completed before its operation."));
                        return;
                    }
                    settled = true;
                    resolve(result!);
                };
            });
        } finally {
            database.close();
        }
    }
}
