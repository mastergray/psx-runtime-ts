// Dependencies:
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Normalizes IndexedDB failures into stable storage errors

// Type dependencies:
import type { PsxGameStoreDriverLike } from "./types.js";              // Storage-driver contract implemented for game records

const STORE = "games";

/**
 *
 * Class
 *
 */

// Persists complete game-library records in one dedicated IndexedDB store.
export default class IndexedDbGameDriver implements PsxGameStoreDriverLike {

    /* Static Fields */
    static readonly VERSION = 1;                    // Database schema version owned by this driver

    /* Instance Fields */
    private readonly _factory: IDBFactory;          // Browser factory used to open the configured database
    private readonly _name: string;                 // Database name isolating this game library

    // CONSTRUCTOR :: idbFactory, STRING -> indexedDbGameDriver
    // Creates a driver for one named IndexedDB database.
    constructor(factory: IDBFactory, name: string) {
        this._factory = factory;
        this._name = name;
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: STRING -> PROMISE(UNKNOWN)
    // Reads one stored game record by exact content identity.
    read(gameId: string): Promise<unknown> {
        return this._request("readonly", (store, complete) => {
            const request = store.get(gameId);
            request.onsuccess = () => complete(request.result);
        });
    }

    // METHOD :: VOID -> PROMISE([UNKNOWN])
    // Lists every stored game record.
    list(): Promise<ReadonlyArray<unknown>> {
        return this._request("readonly", (store, complete) => {
            const request = store.getAll();
            request.onsuccess = () => complete(request.result);
        });
    }

    // METHOD :: STRING, UNKNOWN -> PROMISE(VOID)
    // Replaces one stored game record atomically.
    async write(gameId: string, value: unknown): Promise<void> {
        await this._request("readwrite", (store, complete) => {
            const request = store.put(value, gameId);
            request.onsuccess = () => complete(undefined);
        });
    }

    // METHOD :: STRING -> PROMISE(VOID)
    // Removes one stored game record by exact identity.
    async remove(gameId: string): Promise<void> {
        await this._request("readwrite", (store, complete) => {
            const request = store.delete(gameId);
            request.onsuccess = () => complete(undefined);
        });
    }

    // METHOD :: STRING, (UNKNOWN -> {value:UNKNOWN, result:T}) -> PROMISE(T)
    // Atomically derives and stores a new record from the current value.
    // NOTE: <T> is the caller-defined mutation result returned after commit.
    update<T>(gameId: string, updater: (current: unknown) => {
        readonly value: unknown;
        readonly result: T;
    }): Promise<T> {
        return this._request("readwrite", (store, complete, fail) => {
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

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: VOID -> PROMISE(idbDatabase)
    // Opens the database and creates the game store during schema upgrade.
    private async _open(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            let settled = false;
            let request: IDBOpenDBRequest;
            const rejectOnce = (message: string, data: unknown): void => {
                if (settled) return;
                settled = true;
                reject(failed(message, data));
            };
            try {
                request = this._factory.open(this._name, IndexedDbGameDriver.VERSION);
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

    // METHOD :: idbTransactionMode, (idbObjectStore, (T -> VOID), (UNKNOWN -> VOID) -> VOID) -> PROMISE(T)
    // Runs one transaction and resolves only after both the operation and transaction complete.
    // NOTE: <T> is the committed operation result.
    private async _request<T>(mode: IDBTransactionMode, operation: (
        store: IDBObjectStore,
        complete: (result: T) => void,
        fail: (error: unknown) => void,
    ) => void): Promise<T> {
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

/**
 *
 *  Helper Functions
 *
 */

// IndexedDB object store containing complete game records

// HELPER :: STRING, UNKNOWN -> psxRuntimeError
// Creates a stable storage failure for an IndexedDB boundary error.
const failed = (message: string, data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.STORAGE_FAILED,
    message,
    data,
});
