#include <emscripten/emscripten.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef bool (*retro_environment_t)(unsigned command, void *data);
typedef void (*retro_video_refresh_t)(const void *data, unsigned width, unsigned height, size_t pitch);
typedef void (*retro_audio_sample_t)(int16_t left, int16_t right);
typedef size_t (*retro_audio_sample_batch_t)(const int16_t *data, size_t frames);
typedef void (*retro_input_poll_t)(void);
typedef int16_t (*retro_input_state_t)(unsigned port, unsigned device, unsigned index, unsigned id);

struct retro_system_info {
    const char *library_name;
    const char *library_version;
    const char *valid_extensions;
    bool need_fullpath;
    bool block_extract;
};

extern void retro_set_environment(retro_environment_t callback);
extern void retro_set_video_refresh(retro_video_refresh_t callback);
extern void retro_set_audio_sample(retro_audio_sample_t callback);
extern void retro_set_audio_sample_batch(retro_audio_sample_batch_t callback);
extern void retro_set_input_poll(retro_input_poll_t callback);
extern void retro_set_input_state(retro_input_state_t callback);
extern void retro_get_system_info(struct retro_system_info *info);
extern void retro_init(void);
extern void retro_deinit(void);

static struct retro_system_info system_info;
static unsigned environment_calls;

static bool environment_callback(unsigned command, void *data) {
    (void) command;
    (void) data;
    environment_calls++;
    return false;
}

static void video_callback(const void *data, unsigned width, unsigned height, size_t pitch) {
    (void) data;
    (void) width;
    (void) height;
    (void) pitch;
}

static void audio_callback(int16_t left, int16_t right) {
    (void) left;
    (void) right;
}

static size_t audio_batch_callback(const int16_t *data, size_t frames) {
    (void) data;
    return frames;
}

static void input_poll_callback(void) {}

static int16_t input_state_callback(unsigned port, unsigned device, unsigned index, unsigned id) {
    (void) port;
    (void) device;
    (void) index;
    (void) id;
    return 0;
}

EMSCRIPTEN_KEEPALIVE int psx_probe_init(void) {
    retro_set_environment(environment_callback);
    retro_set_video_refresh(video_callback);
    retro_set_audio_sample(audio_callback);
    retro_set_audio_sample_batch(audio_batch_callback);
    retro_set_input_poll(input_poll_callback);
    retro_set_input_state(input_state_callback);
    retro_get_system_info(&system_info);
    retro_init();
    return system_info.library_name != NULL && system_info.library_version != NULL;
}

EMSCRIPTEN_KEEPALIVE const char *psx_probe_name(void) {
    return system_info.library_name;
}

EMSCRIPTEN_KEEPALIVE const char *psx_probe_version(void) {
    return system_info.library_version;
}

EMSCRIPTEN_KEEPALIVE const char *psx_probe_extensions(void) {
    return system_info.valid_extensions;
}

EMSCRIPTEN_KEEPALIVE int psx_probe_needs_fullpath(void) {
    return system_info.need_fullpath ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE unsigned psx_probe_environment_calls(void) {
    return environment_calls;
}

EMSCRIPTEN_KEEPALIVE void psx_probe_deinit(void) {
    retro_deinit();
}
