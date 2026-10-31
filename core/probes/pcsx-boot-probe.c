#include <emscripten/emscripten.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "libretro.h"

#define ENVIRONMENT_TRACE_CAPACITY 4096

static unsigned environment_trace[ENVIRONMENT_TRACE_CAPACITY];
static unsigned environment_trace_size;
static enum retro_pixel_format pixel_format = RETRO_PIXEL_FORMAT_0RGB1555;
static uint16_t input_buttons;
static uint32_t video_hash = 2166136261u;
static uint32_t audio_hash = 2166136261u;
static uint64_t audio_frames;
static uint32_t video_frames;
static uint32_t null_video_frames;
static uint32_t audio_peak;
static uint32_t last_pixel;
static unsigned last_width;
static unsigned last_height;
static size_t last_pitch;
static bool force_pal;
static struct retro_system_av_info av_info;

static uint32_t hash_bytes(uint32_t hash, const uint8_t *data, size_t size) {
    for (size_t index = 0; index < size; index++) {
        hash ^= data[index];
        hash *= 16777619u;
    }
    return hash;
}

static void log_callback(enum retro_log_level level, const char *format, ...) {
    (void) level;
    va_list arguments;
    va_start(arguments, format);
    vprintf(format, arguments);
    va_end(arguments);
}

static const char *variable_value(const char *key) {
    if (strcmp(key, "pcsx_rearmed_bios") == 0) return "HLE";
    if (strcmp(key, "pcsx_rearmed_memcard1") == 0) return "libretro";
    if (strcmp(key, "pcsx_rearmed_memcard2") == 0) return "libretro";
    if (strcmp(key, "pcsx_rearmed_region") == 0) return force_pal ? "PAL" : "NTSC";
    if (strcmp(key, "pcsx_rearmed_rgb32_output") == 0) return "disabled";
    if (strcmp(key, "pcsx_rearmed_frameskip_type") == 0) return "disabled";
    if (strcmp(key, "pcsx_rearmed_drc") == 0) return "disabled";
    return NULL;
}

static bool environment_callback(unsigned command, void *data) {
    if (environment_trace_size < ENVIRONMENT_TRACE_CAPACITY) {
        environment_trace[environment_trace_size++] = command;
    }

    switch (command) {
        case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
            ((struct retro_log_callback *) data)->log = log_callback;
            return true;
        case RETRO_ENVIRONMENT_GET_VARIABLE: {
            struct retro_variable *variable = (struct retro_variable *) data;
            variable->value = variable_value(variable->key);
            return variable->value != NULL;
        }
        case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
            *(bool *) data = false;
            return true;
        case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
            *(const char **) data = "/system";
            return true;
        case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
            *(const char **) data = "/save";
            return true;
        case RETRO_ENVIRONMENT_GET_CONTENT_DIRECTORY:
            *(const char **) data = "/content";
            return true;
        case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
            pixel_format = *(const enum retro_pixel_format *) data;
            return pixel_format == RETRO_PIXEL_FORMAT_RGB565
                || pixel_format == RETRO_PIXEL_FORMAT_XRGB8888;
        case RETRO_ENVIRONMENT_GET_CAN_DUPE:
            *(bool *) data = true;
            return true;
        case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
            return true;
        case RETRO_ENVIRONMENT_GET_DISK_CONTROL_INTERFACE_VERSION:
            *(unsigned *) data = 1;
            return true;
        case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION:
            *(unsigned *) data = 0;
            return true;
        case RETRO_ENVIRONMENT_GET_MESSAGE_INTERFACE_VERSION:
            *(unsigned *) data = 0;
            return true;
        case RETRO_ENVIRONMENT_SET_VARIABLES:
        case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
        case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
        case RETRO_ENVIRONMENT_SET_DISK_CONTROL_INTERFACE:
        case RETRO_ENVIRONMENT_SET_DISK_CONTROL_EXT_INTERFACE:
        case RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL:
        case RETRO_ENVIRONMENT_SET_GEOMETRY:
        case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
        case RETRO_ENVIRONMENT_SET_MESSAGE:
        case RETRO_ENVIRONMENT_SET_MESSAGE_EXT:
        case RETRO_ENVIRONMENT_SET_MINIMUM_AUDIO_LATENCY:
        case RETRO_ENVIRONMENT_SET_AUDIO_BUFFER_STATUS_CALLBACK:
            return true;
        default:
            return false;
    }
}

static void video_callback(const void *data, unsigned width, unsigned height, size_t pitch) {
    if (data == NULL) {
        null_video_frames++;
        return;
    }

    video_frames++;
    last_width = width;
    last_height = height;
    last_pitch = pitch;
    const uint8_t *center_row = (const uint8_t *) data + (height / 2) * pitch;
    last_pixel = pixel_format == RETRO_PIXEL_FORMAT_XRGB8888
        ? ((const uint32_t *) center_row)[width / 2]
        : ((const uint16_t *) center_row)[width / 2];
    video_hash = hash_bytes(video_hash, (const uint8_t *) data, pitch * height);
}

static void audio_sample_callback(int16_t left, int16_t right) {
    const int16_t samples[2] = { left, right };
    audio_hash = hash_bytes(audio_hash, (const uint8_t *) samples, sizeof(samples));
    uint32_t left_magnitude = left < 0 ? (uint32_t) -(int32_t) left : (uint32_t) left;
    uint32_t right_magnitude = right < 0 ? (uint32_t) -(int32_t) right : (uint32_t) right;
    if (left_magnitude > audio_peak) audio_peak = left_magnitude;
    if (right_magnitude > audio_peak) audio_peak = right_magnitude;
    audio_frames++;
}

static size_t audio_batch_callback(const int16_t *data, size_t frames) {
    audio_hash = hash_bytes(audio_hash, (const uint8_t *) data, frames * 2 * sizeof(int16_t));
    for (size_t index = 0; index < frames * 2; index++) {
        int32_t sample = data[index];
        uint32_t magnitude = sample < 0 ? (uint32_t) -sample : (uint32_t) sample;
        if (magnitude > audio_peak) audio_peak = magnitude;
    }
    audio_frames += frames;
    return frames;
}

static void input_poll_callback(void) {}

static int16_t input_state_callback(unsigned port, unsigned device, unsigned index, unsigned id) {
    if (port != 0 || device != RETRO_DEVICE_JOYPAD || index != 0) return 0;
    if (id == RETRO_DEVICE_ID_JOYPAD_MASK) return (int16_t) input_buttons;
    return (input_buttons & (1u << id)) != 0 ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE void psx_probe_set_pal(unsigned enabled) {
    force_pal = enabled != 0;
}

EMSCRIPTEN_KEEPALIVE int psx_probe_boot(void) {
    struct retro_game_info game = {
        .path = "/content/m0-fixture.cue",
        .data = NULL,
        .size = 0,
        .meta = NULL,
    };

    retro_set_environment(environment_callback);
    retro_set_video_refresh(video_callback);
    retro_set_audio_sample(audio_sample_callback);
    retro_set_audio_sample_batch(audio_batch_callback);
    retro_set_input_poll(input_poll_callback);
    retro_set_input_state(input_state_callback);
    retro_init();
    retro_set_controller_port_device(0, RETRO_DEVICE_JOYPAD);

    if (!retro_load_game(&game)) return 0;
    retro_get_system_av_info(&av_info);
    return 1;
}

EMSCRIPTEN_KEEPALIVE void psx_probe_run(unsigned frames, unsigned buttons) {
    input_buttons = (uint16_t) buttons;
    for (unsigned index = 0; index < frames; index++) retro_run();
}

EMSCRIPTEN_KEEPALIVE void psx_probe_shutdown(void) {
    retro_unload_game();
    retro_deinit();
}

EMSCRIPTEN_KEEPALIVE unsigned psx_probe_environment_count(void) { return environment_trace_size; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_environment_at(unsigned index) {
    return index < environment_trace_size ? environment_trace[index] : UINT32_MAX;
}
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_video_frames(void) { return video_frames; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_null_video_frames(void) { return null_video_frames; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_video_hash(void) { return video_hash; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_audio_hash(void) { return audio_hash; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_audio_frames(void) { return (unsigned) audio_frames; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_audio_peak(void) { return audio_peak; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_last_pixel(void) { return last_pixel; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_width(void) { return last_width; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_height(void) { return last_height; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_pitch(void) { return (unsigned) last_pitch; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_pixel_format(void) { return (unsigned) pixel_format; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_fps_milli(void) {
    return (unsigned) (av_info.timing.fps * 1000.0 + 0.5);
}
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_sample_rate(void) {
    return (unsigned) (av_info.timing.sample_rate + 0.5);
}
