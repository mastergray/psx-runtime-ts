#ifndef PSX_RUNTIME_DISC_IO_H
#define PSX_RUNTIME_DISC_IO_H

#include <stdio.h>
#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

void psx_set_sequential_read_reuse(int enabled);
int psx_runtime_disc_seek(FILE *stream, off_t offset);
unsigned long psx_sequential_read_reuse_skips(void);

#ifdef __cplusplus
}
#endif

#endif
