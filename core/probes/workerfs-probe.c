#include <emscripten/emscripten.h>
#include <stdint.h>
#include <stdio.h>

static const char *PROBE_PATH = "/content/track.bin";

EMSCRIPTEN_KEEPALIVE double psx_workerfs_size(void) {
    FILE *file = fopen(PROBE_PATH, "rb");
    if (file == NULL) return -1;
    if (fseek(file, 0, SEEK_END) != 0) {
        fclose(file);
        return -1;
    }
    const long size = ftell(file);
    fclose(file);
    return (double) size;
}

EMSCRIPTEN_KEEPALIVE uint32_t psx_workerfs_checksum(uint32_t offset, uint32_t length) {
    FILE *file = fopen(PROBE_PATH, "rb");
    if (file == NULL || fseek(file, (long) offset, SEEK_SET) != 0) {
        if (file != NULL) fclose(file);
        return 0;
    }

    uint8_t bytes[4096];
    uint32_t remaining = length;
    uint32_t hash = 2166136261u;
    while (remaining > 0) {
        const size_t wanted = remaining < sizeof(bytes) ? remaining : sizeof(bytes);
        const size_t read = fread(bytes, 1, wanted, file);
        if (read == 0) {
            fclose(file);
            return 0;
        }
        for (size_t index = 0; index < read; index++) {
            hash ^= bytes[index];
            hash *= 16777619u;
        }
        remaining -= (uint32_t) read;
    }

    fclose(file);
    return hash;
}
