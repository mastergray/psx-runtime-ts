#include "psx_frontend_internal.h"

int psx_start(const char *content_path, const char *options_json) {
    return psx_frontend_start(content_path, options_json);
}

int psx_run_frame(void) { return psx_frontend_run_frame(); }

void psx_set_button(unsigned port, unsigned id, int pressed) {
    psx_frontend_set_button(port, id, pressed);
}

void psx_set_axis(unsigned port, unsigned id, int16_t value) {
    psx_frontend_set_axis(port, id, value);
}

int psx_reset(void) { return psx_frontend_reset(); }
size_t psx_serialize_size(void) { return psx_frontend_serialize_size(); }
int psx_serialize(void *out, size_t size) { return psx_frontend_serialize(out, size); }
int psx_unserialize(const void *data, size_t size) { return psx_frontend_unserialize(data, size); }
size_t psx_memory_card_size(unsigned slot) { return psx_frontend_memory_card_size(slot); }
int psx_read_memory_card(unsigned slot, void *out, size_t size) {
    return psx_frontend_read_memory_card(slot, out, size);
}
int psx_write_memory_card(unsigned slot, const void *data, size_t size) {
    return psx_frontend_write_memory_card(slot, data, size);
}
int psx_set_disc(unsigned index) { return psx_frontend_set_disc(index); }
int psx_disc_count(void) { return psx_frontend_disc_count(); }
void psx_stop(void) { psx_frontend_stop(); }
