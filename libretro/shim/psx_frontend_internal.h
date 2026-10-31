#ifndef PSX_RUNTIME_FRONTEND_INTERNAL_H
#define PSX_RUNTIME_FRONTEND_INTERNAL_H

#include "psx_frontend.h"

int psx_frontend_start(const char *content_path, const char *options_json);
int psx_frontend_run_frame(void);
void psx_frontend_set_button(unsigned port, unsigned id, int pressed);
void psx_frontend_set_axis(unsigned port, unsigned id, int16_t value);
int psx_frontend_reset(void);
size_t psx_frontend_serialize_size(void);
int psx_frontend_serialize(void *out, size_t size);
int psx_frontend_unserialize(const void *data, size_t size);
size_t psx_frontend_memory_card_size(unsigned slot);
int psx_frontend_read_memory_card(unsigned slot, void *out, size_t size);
int psx_frontend_write_memory_card(unsigned slot, const void *data, size_t size);
int psx_frontend_set_disc(unsigned index);
int psx_frontend_disc_count(void);
void psx_frontend_stop(void);

#endif
