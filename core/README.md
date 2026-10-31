# Emulator core build boundary

This directory will contain the immutable source identity, Emscripten pin,
production patches and normalized build recipe selected by milestone M0 in
the implementation spec.

There is deliberately no `SOURCE.json` or `EMSDK_VERSION` yet. M0 must build
and measure the candidates before recording those values. Source checkouts and
compiled output belong under ignored caches and `dist/core/`, not here.
