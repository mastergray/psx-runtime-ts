// Type dependencies:
import type { DiscSet } from "../shared.types.js";    // Combined audited content produced from ordered disc archives

/**
 *
 * Type Declarations
 *
 */

// INTERFACE :: {archiveName:STRING, cuePath:STRING, manifestPath:STRING}
// One ordered single-disc archive and the generated M3U reference assigned to its CUE.
export interface PsxMultiZipDisc {
    readonly archiveName: string;    // User-selected ZIP filename
    readonly cuePath: string;        // Exact CUE path inside that archive
    readonly manifestPath: string;   // Namespaced CUE path written to the generated M3U
}

// INTERFACE :: {name:STRING, text:STRING, discs:[psxMultiZipDisc]}
// Generated M3U metadata available before the archives are expanded.
export interface PsxMultiZipManifest {
    readonly name: string;                         // Stable generated M3U basename
    readonly text: string;                         // Newline-terminated M3U contents
    readonly discs: ReadonlyArray<PsxMultiZipDisc>; // Ordered archive-to-disc mapping
}

// INTERFACE :: {game:discSet, manifest:psxMultiZipManifest}
// Combined content and the manifest that defines its public disc order.
export interface PsxMultiZipBuild {
    readonly game: DiscSet;                      // Fully expanded namespaced disc set
    readonly manifest: PsxMultiZipManifest;      // Generated portable M3U metadata
}

/**
 *
 * Type Predicates
 *
 */

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a complete generated multi-ZIP manifest with ordered immutable-looking disc metadata.
export function isPsxMultiZipManifest(value: unknown): value is PsxMultiZipManifest {
    if (typeof value !== "object" || value === null) return false;
    const manifest = value as PsxMultiZipManifest;
    return typeof manifest.name === "string" && manifest.name.endsWith(".m3u")
        && typeof manifest.text === "string" && manifest.text.endsWith("\n")
        && Array.isArray(manifest.discs) && manifest.discs.length >= 2 && manifest.discs.length <= 8
        && manifest.discs.every((disc) => typeof disc === "object" && disc !== null
            && typeof disc.archiveName === "string" && disc.archiveName.length > 0
            && typeof disc.cuePath === "string" && disc.cuePath.toLowerCase().endsWith(".cue")
            && typeof disc.manifestPath === "string" && disc.manifestPath.toLowerCase().endsWith(".cue"));
}
