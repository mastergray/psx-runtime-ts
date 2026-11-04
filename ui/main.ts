// Dependencies:
import { PsxGameStore, PsxStorage } from "../src/index.js";    // Browser-local persistence factories
import UiApplication from "./UiApplication.js";               // Production web-emulator application

const application = new UiApplication({
    document,
    storage: PsxStorage.init(),
    gameStore: PsxGameStore.init(),
    buildUrl: "/dist/core",
});

void application.initialize().catch((error: unknown) => {
    globalThis.console.error("PlayStation web emulator initialization failed.", error);
});
