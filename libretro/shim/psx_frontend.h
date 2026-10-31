#ifndef PSX_RUNTIME_FRONTEND_H
#define PSX_RUNTIME_FRONTEND_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum psx_pixel_format {
    PSX_PIXEL_0RGB1555 = 0,
    PSX_PIXEL_XRGB8888 = 1,
    PSX_PIXEL_RGB565 = 2
};

int psx_start(const char *content_path, const char *options_json);
int psx_run_frame(void);
void psx_set_button(unsigned port, unsigned id, int pressed);
void psx_set_axis(unsigned port, unsigned id, int16_t value);
int psx_reset(void);
size_t psx_serialize_size(void);
int psx_serialize(void *out, size_t size);
int psx_unserialize(const void *data, size_t size);
size_t psx_memory_card_size(unsigned slot);
int psx_read_memory_card(unsigned slot, void *out, size_t size);
int psx_write_memory_card(unsigned slot, const void *data, size_t size);
int psx_set_disc(unsigned index);
int psx_disc_count(void);
void psx_stop(void);

unsigned psx_video_width(void);
unsigned psx_video_height(void);
unsigned psx_base_width(void);
unsigned psx_base_height(void);
unsigned psx_video_pitch(void);
unsigned psx_video_format(void);
const uint8_t *psx_video_data(void);
size_t psx_video_size(void);
int psx_video_duplicate(void);
const int16_t *psx_audio_data(void);
size_t psx_audio_frames(void);
double psx_frames_per_second(void);
double psx_sample_rate(void);
int psx_is_pal(void);
float psx_aspect_ratio(void);
unsigned psx_max_width(void);
unsigned psx_max_height(void);
unsigned psx_disc_index(void);
int psx_tray_open(void);
uint16_t psx_rumble(unsigned port, unsigned effect);
size_t psx_log_size(void);
const char *psx_log_data(void);

#ifdef __cplusplus
}
#endif

#endif
