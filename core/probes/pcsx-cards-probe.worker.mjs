const modulePath = "../../dist/probes/pcsx-boot.mjs";
const cardBytes = 128 * 1024;
const markerOffset = 63 * 128;

const hashBytes = (bytes) => {
    let hash = 2166136261;
    for (const value of bytes) {
        hash ^= value;
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash;
};

const readCards = (module) => [1, 2].map((slot) =>
    Uint8Array.from(module.FS.readFile(`/save/pcsx-card${slot}.mcd`)));

const internalHashes = (module) => [0, 1]
    .map((slot) => module._psx_probe_card_hash(slot) >>> 0);

const markersMatch = (cards) => cards.every((card, slot) => {
    const base = slot === 0 ? 0x31 : 0x72;
    return Array.from({ length: 128 }, (_, index) => card[markerOffset + index])
        .every((value, index) => value === (base + index) % 256);
});

const createModuleWithCards = async (createModule, blobs, restoredCards) => {
    const module = await createModule();
    module.FS.mkdir("/content");
    module.FS.mkdir("/system");
    module.FS.mkdir("/save");
    if (restoredCards !== undefined) {
        restoredCards.forEach((card, index) => {
            module.FS.writeFile(`/save/pcsx-card${index + 1}.mcd`, card);
        });
    }
    module.FS.mount(module.WORKERFS, {
        blobs: [
            { name: "m0-fixture.cue", data: blobs.cue },
            { name: "m0-fixture.bin", data: blobs.bin },
        ],
    }, "/content");
    module._psx_probe_set_shared_cards(1);
    const booted = module._psx_probe_boot() === 1;
    return { module, booted };
};

self.onmessage = async ({ data }) => {
    try {
        const createModule = (await import(modulePath)).default;
        const first = await createModuleWithCards(createModule, data);
        if (!first.booted) throw new Error("PCSX-ReARMed rejected the card fixture");
        const initialCards = readCards(first.module);
        const initialFileHashes = initialCards.map(hashBytes);
        const initialInternalHashes = internalHashes(first.module);

        const changeCallbacks = [null, null];
        let previousHashes = initialInternalHashes;
        for (let callback = 1; callback <= 180; callback++) {
            first.module._psx_probe_run(1, 0);
            const hashes = internalHashes(first.module);
            hashes.forEach((hash, slot) => {
                if (changeCallbacks[slot] === null && hash !== previousHashes[slot]) {
                    changeCallbacks[slot] = callback;
                }
            });
            previousHashes = hashes;
            if (changeCallbacks.every((value) => value !== null)) break;
        }
        const persistedCards = readCards(first.module);
        const persistedFileHashes = persistedCards.map(hashBytes);
        const persistedInternalHashes = internalHashes(first.module);
        first.module._psx_probe_shutdown();
        first.module.FS.unmount("/content");

        const second = await createModuleWithCards(createModule, data, persistedCards);
        if (!second.booted) throw new Error("PCSX-ReARMed rejected restored card files");
        const restoredInternalHashes = internalHashes(second.module);
        const restoredCards = readCards(second.module);
        const restoredFileHashes = restoredCards.map(hashBytes);
        const restoredBeforeFirstRun = restoredInternalHashes.every(
            (hash, index) => hash === persistedInternalHashes[index],
        );

        const result = {
            booted: first.booted && second.booted,
            cardBytes,
            markerOffset,
            initialFileHashes,
            initialInternalHashes,
            changeCallbacks,
            persistedFileHashes,
            persistedInternalHashes,
            restoredFileHashes,
            restoredInternalHashes,
            cardsChangedInOrder: changeCallbacks.every((value) => value !== null)
                && changeCallbacks[0] < changeCallbacks[1],
            filesMatchInternal: persistedFileHashes.every(
                (hash, index) => hash === persistedInternalHashes[index],
            ),
            markersMatch: markersMatch(persistedCards) && markersMatch(restoredCards),
            restoredBeforeFirstRun,
            restoredFilesExact: restoredFileHashes.every(
                (hash, index) => hash === persistedFileHashes[index],
            ),
        };
        result.ok = result.booted
            && initialCards.every((card) => card.byteLength === cardBytes)
            && result.cardsChangedInOrder
            && result.filesMatchInternal
            && result.markersMatch
            && result.restoredBeforeFirstRun
            && result.restoredFilesExact;

        second.module._psx_probe_shutdown();
        second.module.FS.unmount("/content");
        self.postMessage(result);
    } catch (error) {
        self.postMessage({
            ok: false,
            message: error instanceof Error ? error.stack ?? error.message : String(error),
        });
    }
};
