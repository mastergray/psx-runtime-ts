# Core distribution

The npm package contains the TypeScript runtime and compiled JavaScript only.
It does not contain an emulator source tree, WebAssembly core, firmware, disc
content or generated fixture media.

The selected PCSX-ReARMed source identity and submodule pins are recorded in
`core/SOURCE.json`. PCSX-ReARMed is licensed under GPL-2.0-or-later; its
verbatim licence is retained at `notices/PCSX-ReARMed-COPYING.txt`. The pinned
Emscripten toolchain licence is retained at
`notices/Emscripten-LICENSE.txt`.

Anyone distributing a compiled emulator core must review the selected source
and every linked dependency, ship the notices referenced by `core/build.json`,
and provide the complete corresponding source in the manner required by the
applicable licences. This repository does not treat the npm package or an
upstream repository link as a substitute for those obligations. A hosted core
must be audited as a separate distribution artifact before release.
