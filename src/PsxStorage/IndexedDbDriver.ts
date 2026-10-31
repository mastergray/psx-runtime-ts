import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";

import type {
    PsxIndexedDbFactoryLike,
    PsxStorageDriverLike,
    PsxStorageMutation,
    PsxStorageStore,
} from "./types.js";

const STORES: ReadonlyArray<PsxStorageStore> = ["cards", "states"];

const storageFailed = (message: string, data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.STORAGE_FAILED,
    message,
    data,
});

export default class IndexedDbDriver implements PsxStorageDriverLike {
    static readonly VERSION = 1;
    readonly #factory: PsxIndexedDbFactoryLike;
    readonly #name: string;

    constructor(factory: PsxIndexedDbFactoryLike, name: string) {
        this.#factory = factory;
        this.#name = name;
    }

    async read(store: PsxStorageStore, key: string): Promise<unknown> {
        return this.#request(store, "readonly", (objectStore, complete) => {
            const request = objectStore.get(key);
            request.onsuccess = () => complete(request.result);
        });
    }

    async write(store: PsxStorageStore, key: string, value: unknown): Promise<void> {
        await this.#request(store, "readwrite", (objectStore, complete) => {
            const request = objectStore.put(value, key);
            request.onsuccess = () => complete(undefined);
        });
    }

    async remove(store: PsxStorageStore, key: string): Promise<void> {
        await this.#request(store, "readwrite", (objectStore, complete) => {
            const request = objectStore.delete(key);
            request.onsuccess = () => complete(undefined);
        });
    }

    async list(store: PsxStorageStore): Promise<ReadonlyArray<unknown>> {
        return this.#request(store, "readonly", (objectStore, complete) => {
            const request = objectStore.getAll();
            request.onsuccess = () => complete(request.result);
        });
    }

    async update<T>(
        store: PsxStorageStore,
        key: string,
        updater: (current: unknown) => PsxStorageMutation<unknown, T>,
    ): Promise<T> {
        return this.#request(store, "readwrite", (objectStore, complete, fail) => {
            const get = objectStore.get(key);
            get.onsuccess = () => {
                let mutation: PsxStorageMutation<unknown, T>;
                try {
                    mutation = updater(get.result);
                } catch (error) {
                    fail(error);
                    return;
                }
                const request = mutation.delete === true
                    ? objectStore.delete(key)
                    : objectStore.put(mutation.value, key);
                request.onsuccess = () => complete(mutation.result);
            };
        });
    }

    async #open(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            let settled = false;
            let request: IDBOpenDBRequest;
            const fail = (message: string, data: unknown): void => {
                if (settled) return;
                settled = true;
                reject(storageFailed(message, data));
            };
            try {
                request = this.#factory.open(this.#name, IndexedDbDriver.VERSION);
            } catch (error) {
                fail("IndexedDB open threw.", error);
                return;
            }
            request.onupgradeneeded = () => {
                try {
                    for (const store of STORES) {
                        if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
                    }
                } catch (error) {
                    fail("IndexedDB upgrade failed.", error);
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
            request.onerror = () => fail("IndexedDB open failed.", request.error);
            request.onblocked = () => fail("IndexedDB open was blocked.", null);
        });
    }

    async #request<T>(
        store: PsxStorageStore,
        mode: IDBTransactionMode,
        operation: (
            objectStore: IDBObjectStore,
            complete: (result: T) => void,
            fail: (error: unknown) => void,
        ) => void,
    ): Promise<T> {
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
                    try { transaction?.abort(); } catch { /* retain the original error */ }
                    reject(PsxRuntimeError.is(error) ? error : storageFailed("IndexedDB operation failed.", error));
                };
                try {
                    transaction = database.transaction(store, mode);
                    operation(transaction.objectStore(store), (value) => {
                        operationComplete = true;
                        result = value;
                    }, fail);
                } catch (error) {
                    fail(storageFailed("IndexedDB transaction failed.", error));
                    return;
                }
                const activeTransaction = transaction;
                activeTransaction.onerror = () => fail(activeTransaction.error);
                activeTransaction.onabort = () => {
                    if (!settled) fail(activeTransaction.error);
                };
                activeTransaction.oncomplete = () => {
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
