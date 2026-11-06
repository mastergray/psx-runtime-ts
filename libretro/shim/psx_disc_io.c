#define _POSIX_C_SOURCE 200809L

#include "psx_disc_io.h"

static int sequential_read_reuse_enabled;
static unsigned long sequential_read_reuse_skips;

void psx_set_sequential_read_reuse(int enabled) {
    sequential_read_reuse_enabled = enabled != 0;
    sequential_read_reuse_skips = 0;
}

int psx_runtime_disc_seek(FILE *stream, off_t offset) {
    if (sequential_read_reuse_enabled) {
        off_t position = ftello(stream);
        if (position == offset) {
            sequential_read_reuse_skips++;
            return 0;
        }
    }
    return fseeko(stream, offset, SEEK_SET);
}

unsigned long psx_sequential_read_reuse_skips(void) {
    return sequential_read_reuse_skips;
}
