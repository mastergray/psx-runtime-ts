// Dependencies:
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Normalizes IndexedDB failures into stable storage errors

// Type dependencies:
import type {
    PsxIndexedDbFactoryLike,       // Injectable browser factory used to open the database
    PsxStorageDriverLike,          // Storage-driver contract implemented by this class
    PsxStorageMutation,            // Atomic update decision returned by callers
    PsxStorageStore,               // Closed set of object stores managed by the schema
} from "./types.js";

const STORES: ReadonlyArray<PsxStorageStore> = ["cards", "states", "firmware"];    // Stores created for the current schema

// METHOD :: STRING, UNKNOWN -> psxRuntimeError
// Creates a stable storage failure for an IndexedDB boundary error.
const storageFailed = (message: string, data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.STORAGE_FAILED,
    message,
    data,
});

/**
 *
 * Class
 *
 */

// Persists firmware, memory cards, and save states in versioned IndexedDB stores.
export default class IndexedDbDriver implements PsxStorageDriverLike {

    /* Static Fields */
    static readonly VERSION = 2;                               // Database schema version owned by this driver

    /* Instance Fields */
    private readonly _factory: PsxIndexedDbFactoryLike;        // Browser factory used to open the configured database
    private readonly _name: string;                            // Database name isolating this runtime profile

    // CONSTRUCTOR :: psxIndexedDbFactoryLike, STRING -> indexedDbDriver
    // Creates a driver for one named IndexedDB database.
    constructor(factory: PsxIndexedDbFactoryLike, name: string) {
        this._factory = factory;
        this._name = name;
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: psxStorageStore, STRING -> PROMISE(UNKNOWN)
    // Reads one value from an exact store and key.
    async read(store: PsxStorageStore, key: string): Promise<unknown> {
        return this._request(store, "readonly", (objectStore, complete) => {
            const request = objectStore.get(key);
            request.onsuccess = () => complete(request.result);
        });
    }

    // METHOD :: psxStorageStore, STRING, UNKNOWN -> PROMISE(VOID)
    // Replaces one value atomically.
    async write(store: PsxStorageStore, key: string, value: unknown): Promise<void> {
        await this._request(store, "readwrite", (objectStore, complete) => {
            const request = objectStore.put(value, key);
            request.onsuccess = () => complete(undefined);
        });
    }

    // METHOD :: psxStorageStore, STRING -> PROMISE(VOID)
    // Removes one value from an exact store and key.
    async remove(store: PsxStorageStore, key: string): Promise<void> {
        await this._request(store, "readwrite", (objectStore, complete) => {
            const request = objectStore.delete(key);
            request.onsuccess = () => complete(undefined);
        });
    }

    // METHOD :: psxStorageStore -> PROMISE([UNKNOWN])
    // Lists every value in one store.
    async list(store: PsxStorageStore): Promise<ReadonlyArray<unknown>> {
        return this._request(store, "readonly", (objectStore, complete) => {
            const request = objectStore.getAll();
            request.onsuccess = () => complete(request.result);
        });
    }

    // METHOD :: psxStorageStore, STRING, (UNKNOWN -> psxStorageMutation<UNKNOWN,T>) -> PROMISE(T)
    // Atomically applies a caller-defined update or deletion.
    // NOTE: <T> is the caller-defined mutation result returned after commit.
    async update<T>(
        store: PsxStorageStore,
        key: string,
        updater: (current: unknown) => PsxStorageMutation<unknown, T>,
    ): Promise<T> {
        return this._request(store, "readwrite", (objectStore, complete, fail) => {
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

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: VOID -> PROMISE(idbDatabase)
    // Opens the database and creates all missing stores during schema upgrade.
    private async _open(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            let settled = false;
            let request: IDBOpenDBRequest;
            const fail = (message: string, data: unknown): void => {
                if (settled) return;
                settled = true;
                reject(storageFailed(message, data));
            };
            try {
                request = this._factory.open(this._name, IndexedDbDriver.VERSION);
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

    // METHOD :: psxStorageStore, idbTransactionMode, (idbObjectStore, (T -> VOID), (UNKNOWN -> VOID) -> VOID) -> PROMISE(T)
    // Runs one transaction and resolves only after both the operation and transaction complete.
    // NOTE: <T> is the committed operation result.
    private async _request<T>(
        store: PsxStorageStore,
        mode: IDBTransactionMode,
        operation: (
            objectStore: IDBObjectStore,
            complete: (result: T) => void,
            fail: (error: unknown) => void,
        ) => void,
    ): Promise<T> {
        const database = await this._open();
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
