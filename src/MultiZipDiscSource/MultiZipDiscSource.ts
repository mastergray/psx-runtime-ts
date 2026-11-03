// Dependencies:
import DiscSetAudit from "../DiscSetAudit/DiscSetAudit.js";              // Verifies each source disc and the generated combined set
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Reports stable archive and disc-set failures
import ZipDiscSource from "../ZipDiscSource/ZipDiscSource.js";          // Inspects and expands each ordered ZIP archive
import {
    isPsxFileListLike,        // Validates the browser-compatible archive collection
    isPsxLocalFilesConfig,    // Validates the caller's provisional game identity
} from "../PsxConsole/types.js";

// Type dependencies:
import type { DiscFile, DiscSet } from "../shared.types.js";            // Expanded content and combined result contracts
import type {
    PsxFileListLike,         // Ordered browser-selected ZIP collection
    PsxLocalFileLike,        // One named archive Blob
    PsxLocalFilesConfig,     // Provisional display identity and unsupported explicit entry
} from "../PsxConsole/types.js";
import type {
    PsxMultiZipBuild,       // Combined game and generated manifest result
    PsxMultiZipDisc,        // One archive's ordered manifest mapping
    PsxMultiZipManifest,    // Generated M3U metadata available before extraction
} from "./types.js";

const GIBIBYTE = 1024 * 1024 * 1024;

/**
 *
 * Class
 *
 */

// Builds one ordered multi-disc set from separate single-disc ZIP archives.
export default class MultiZipDiscSource {

    /* Static Fields */
    static readonly MIN_ARCHIVES = 2;                      // Minimum archive count that requires a generated M3U
    static readonly MAX_ARCHIVES = 8;                      // Public M3U disc-cardinality limit
    static readonly MAX_EXPANDED_BYTES = 8 * GIBIBYTE;     // Combined expanded-content safety limit
    static readonly MANIFEST_NAME = "multi-disc.m3u";      // Stable generated entry basename

    // CONSTRUCTOR :: VOID -> multiZipDiscSource
    // Prevents instances because ordered archive operations are stateless.
    private constructor() {}

    /**
     *
     * Static Methods
     *
     */

    // METHOD :: psxFileListLike -> PROMISE(psxMultiZipManifest)
    // Inspects central metadata and generates ordered M3U text without expanding track content.
    static async inspect(archives: PsxFileListLike): Promise<PsxMultiZipManifest> {
        const selected = selectedArchives(archives);
        const discs: PsxMultiZipDisc[] = [];
        for (let index = 0; index < selected.length; index++) {
            const archive = selected[index]!;
            const descriptors = await ZipDiscSource.listDescriptors(archive);
            const playlists = descriptors.filter((path) => path.toLowerCase().endsWith(".m3u"));
            const cues = descriptors.filter((path) => path.toLowerCase().endsWith(".cue"));
            if (playlists.length > 0 || cues.length !== 1) {
                throw archiveInvalid(
                    "Each multi-disc input must be a single-disc ZIP containing exactly one CUE and no M3U.",
                    { archive: archive.name, cues, playlists },
                );
            }
            const cuePath = cues[0]!;
            discs.push(Object.freeze({
                archiveName: archive.name,
                cuePath,
                manifestPath: `disc-${index + 1}/${cuePath}`,
            }));
        }
        const frozenDiscs = Object.freeze(discs);
        return Object.freeze({
            name: MultiZipDiscSource.MANIFEST_NAME,
            text: `${frozenDiscs.map(({ manifestPath }) => manifestPath).join("\n")}\n`,
            discs: frozenDiscs,
        });
    }

    // METHOD :: psxFileListLike, psxLocalFilesConfig -> PROMISE(psxMultiZipBuild)
    // Expands, validates, namespaces, and combines ordered single-disc archives behind one generated M3U.
    static async build(
        archives: PsxFileListLike,
        config: PsxLocalFilesConfig,
    ): Promise<PsxMultiZipBuild> {
        if (!isPsxLocalFilesConfig(config) || config.entry !== undefined) {
            throw archiveInvalid("Multi-disc ZIP input does not accept an explicit entry override.", config);
        }
        const selected = selectedArchives(archives);
        const manifest = await MultiZipDiscSource.inspect(archives);
        const files: DiscFile[] = [Object.freeze({
            path: manifest.name,
            blob: new Blob([manifest.text], { type: "text/plain;charset=utf-8" }),
        })];
        let expandedBytes = files[0]!.blob.size;
        for (let index = 0; index < selected.length; index++) {
            const archive = selected[index]!;
            const disc = manifest.discs[index]!;
            const extracted = await ZipDiscSource.extract(archive);
            const source: DiscSet = Object.freeze({
                gameId: `${config.gameId} disc ${index + 1}`,
                entry: disc.cuePath,
                files: extracted,
            });
            const audit = await DiscSetAudit.audit(source);
            if (!audit.ok || audit.audit.discs.length !== 1) {
                throw discInvalid(archive.name, audit);
            }
            for (const file of extracted) {
                expandedBytes += file.blob.size;
                if (!Number.isSafeInteger(expandedBytes)
                    || expandedBytes > MultiZipDiscSource.MAX_EXPANDED_BYTES) {
                    throw archiveInvalid("The combined multi-disc content exceeds the 8 GiB expanded-size limit.");
                }
                files.push(Object.freeze({ path: `disc-${index + 1}/${file.path}`, blob: file.blob }));
            }
        }
        const game: DiscSet = Object.freeze({
            gameId: config.gameId,
            entry: manifest.name,
            files: Object.freeze(files),
        });
        const combinedAudit = await DiscSetAudit.audit(game);
        if (!combinedAudit.ok || combinedAudit.audit.discs.length !== selected.length) {
            throw discInvalid("generated multi-disc set", combinedAudit);
        }
        return Object.freeze({ game, manifest });
    }
}

/**
 *
 *  Helper Functions
 *
 */

// HELPER :: psxFileListLike -> [psxLocalFileLike]
// Validates the archive cardinality and returns its exact caller-defined order.
const selectedArchives = (archives: PsxFileListLike): ReadonlyArray<PsxLocalFileLike> => {
    if (!isPsxFileListLike(archives)
        || archives.length < MultiZipDiscSource.MIN_ARCHIVES
        || archives.length > MultiZipDiscSource.MAX_ARCHIVES) {
        throw archiveInvalid("Select between two and eight single-disc ZIP archives.", archives);
    }
    const selected = Array.from({ length: archives.length }, (_, index) =>
        typeof archives.item === "function" ? archives.item(index)! : archives[index]!);
    if (!selected.every(ZipDiscSource.isArchive)) {
        throw archiveInvalid("Multi-disc input accepts only ZIP archives.", selected.map(({ name }) => name));
    }
    return Object.freeze(selected);
};

// HELPER :: STRING, UNKNOWN? -> psxRuntimeError
// Creates a stable invalid-archive failure for malformed multi-ZIP input.
const archiveInvalid = (message: string, data: unknown = null): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.ARCHIVE_INVALID,
    message,
    data,
});

// HELPER :: STRING, discSetAuditResult -> psxRuntimeError
// Wraps one failed single-disc or combined audit with its archive context.
const discInvalid = (archive: string, audit: Awaited<ReturnType<typeof DiscSetAudit.audit>>): PsxRuntimeError =>
    new PsxRuntimeError({
        code: PsxRuntimeError.CODE.DISC_SET_INVALID,
        message: `The ${archive} content failed disc-set validation.`,
        data: audit,
    });
