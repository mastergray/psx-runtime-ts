#include <emscripten/emscripten.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "libretro.h"

#define ENVIRONMENT_TRACE_CAPACITY 4096
#define GEOMETRY_TRACE_CAPACITY 64
#define AUDIO_CAPTURE_CAPACITY 32768
#define MEMORY_CARD_BYTES (128 * 1024)
#define LOG_TRACE_CAPACITY 32768

struct geometry_trace_entry {
    unsigned callback_index;
    unsigned width;
    unsigned height;
    unsigned pitch;
    unsigned pixel_format;
};

struct environment_geometry_entry {
    unsigned command;
    unsigned base_width;
    unsigned base_height;
    unsigned max_width;
    unsigned max_height;
};

static unsigned environment_trace[ENVIRONMENT_TRACE_CAPACITY];
static unsigned environment_trace_size;
static struct geometry_trace_entry geometry_trace[GEOMETRY_TRACE_CAPACITY];
static unsigned geometry_trace_size;
static struct environment_geometry_entry environment_geometry_trace[GEOMETRY_TRACE_CAPACITY];
static unsigned environment_geometry_trace_size;
static char log_trace[LOG_TRACE_CAPACITY];
static unsigned log_trace_size;
static struct retro_disk_control_ext_callback disk_control_ext;
static bool disk_control_available;
static enum retro_pixel_format pixel_format = RETRO_PIXEL_FORMAT_0RGB1555;
static uint16_t input_buttons;
static uint32_t video_hash = 2166136261u;
static uint32_t audio_hash = 2166136261u;
static uint64_t audio_frames;
static uint32_t video_frames;
static uint32_t null_video_frames;
static uint32_t audio_peak;
static uint32_t last_pixel;
static int16_t audio_capture[AUDIO_CAPTURE_CAPACITY];
static unsigned audio_capture_size;
static unsigned audio_batch_calls;
static unsigned audio_batch_min_frames = UINT32_MAX;
static unsigned audio_batch_max_frames;
static unsigned last_width;
static unsigned last_height;
static size_t last_pitch;
static bool force_pal;
static bool force_rgb32;
static bool force_frameskip;
static bool force_real_bios;
static bool force_shared_cards;
static bool use_m3u;
static unsigned video_callback_count;
static struct retro_system_av_info av_info;
static uint8_t *state_buffer;
static size_t state_buffer_size;

#ifndef PSX_PROBE_NO_PCSX_INTERNALS
extern char Mcd1Data[MEMORY_CARD_BYTES];
extern char Mcd2Data[MEMORY_CARD_BYTES];
#endif

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
    va_list trace_arguments;
    va_copy(trace_arguments, arguments);
    if (log_trace_size < LOG_TRACE_CAPACITY - 1) {
        int written = vsnprintf(
            log_trace + log_trace_size,
            LOG_TRACE_CAPACITY - log_trace_size,
            format,
            trace_arguments
        );
        if (written > 0) {
            unsigned available = LOG_TRACE_CAPACITY - log_trace_size - 1;
            log_trace_size += (unsigned) written < available ? (unsigned) written : available;
        }
    }
    va_end(trace_arguments);
    vprintf(format, arguments);
    va_end(arguments);
}

static const char *variable_value(const char *key) {
    if (strcmp(key, "pcsx_rearmed_bios") == 0) return force_real_bios ? "auto" : "HLE";
    if (strcmp(key, "pcsx_rearmed_show_bios_bootlogo") == 0) return "disabled";
    if (strcmp(key, "pcsx_rearmed_memcard1") == 0) {
        return force_shared_cards ? "shared" : "libretro";
    }
    if (strcmp(key, "pcsx_rearmed_memcard2") == 0) {
        return force_shared_cards ? "shared" : "libretro";
    }
    if (strcmp(key, "pcsx_rearmed_region") == 0) return force_pal ? "PAL" : "NTSC";
    if (strcmp(key, "pcsx_rearmed_rgb32_output") == 0) return force_rgb32 ? "enabled" : "disabled";
    if (strcmp(key, "pcsx_rearmed_frameskip_type") == 0) {
        return force_frameskip ? "fixed_interval" : "disabled";
    }
    if (strcmp(key, "pcsx_rearmed_frameskip_interval") == 0) return "1";
    if (strcmp(key, "pcsx_rearmed_noxadecoding") == 0) return "enabled";
    if (strcmp(key, "pcsx_rearmed_nocdaudio") == 0) return "enabled";
    if (strcmp(key, "pcsx_rearmed_cd_readahead") == 0) return "0";
    if (strcmp(key, "pcsx_rearmed_drc") == 0) return "disabled";
    return NULL;
}

static void record_environment_geometry(unsigned command, const struct retro_game_geometry *geometry) {
    if (environment_geometry_trace_size >= GEOMETRY_TRACE_CAPACITY) return;
    struct environment_geometry_entry *entry =
        &environment_geometry_trace[environment_geometry_trace_size++];
    entry->command = command;
    entry->base_width = geometry->base_width;
    entry->base_height = geometry->base_height;
    entry->max_width = geometry->max_width;
    entry->max_height = geometry->max_height;
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
        case RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL:
            return true;
        case RETRO_ENVIRONMENT_SET_DISK_CONTROL_INTERFACE: {
            const struct retro_disk_control_callback *callback =
                (const struct retro_disk_control_callback *) data;
            memset(&disk_control_ext, 0, sizeof(disk_control_ext));
            disk_control_ext.set_eject_state = callback->set_eject_state;
            disk_control_ext.get_eject_state = callback->get_eject_state;
            disk_control_ext.get_image_index = callback->get_image_index;
            disk_control_ext.set_image_index = callback->set_image_index;
            disk_control_ext.get_num_images = callback->get_num_images;
            disk_control_ext.replace_image_index = callback->replace_image_index;
            disk_control_ext.add_image_index = callback->add_image_index;
            disk_control_available = true;
            return true;
        }
        case RETRO_ENVIRONMENT_SET_DISK_CONTROL_EXT_INTERFACE:
            disk_control_ext = *(const struct retro_disk_control_ext_callback *) data;
            disk_control_available = true;
            return true;
        case RETRO_ENVIRONMENT_SET_GEOMETRY:
            record_environment_geometry(command, (const struct retro_game_geometry *) data);
            return true;
        case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
            record_environment_geometry(
                command,
                &((const struct retro_system_av_info *) data)->geometry
            );
            return true;
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
    video_callback_count++;
    if (data == NULL) {
        null_video_frames++;
        return;
    }

    if (geometry_trace_size == 0
        || geometry_trace[geometry_trace_size - 1].width != width
        || geometry_trace[geometry_trace_size - 1].height != height
        || geometry_trace[geometry_trace_size - 1].pitch != pitch
        || geometry_trace[geometry_trace_size - 1].pixel_format != (unsigned) pixel_format) {
        if (geometry_trace_size < GEOMETRY_TRACE_CAPACITY) {
            struct geometry_trace_entry *entry = &geometry_trace[geometry_trace_size++];
            entry->callback_index = video_callback_count;
            entry->width = width;
            entry->height = height;
            entry->pitch = (unsigned) pitch;
            entry->pixel_format = (unsigned) pixel_format;
        }
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
    if (audio_capture_size < AUDIO_CAPTURE_CAPACITY) {
        audio_capture[audio_capture_size++] = left;
    }
    audio_frames++;
}

static size_t audio_batch_callback(const int16_t *data, size_t frames) {
    audio_batch_calls++;
    if (frames < audio_batch_min_frames) audio_batch_min_frames = (unsigned) frames;
    if (frames > audio_batch_max_frames) audio_batch_max_frames = (unsigned) frames;
    audio_hash = hash_bytes(audio_hash, (const uint8_t *) data, frames * 2 * sizeof(int16_t));
    for (size_t index = 0; index < frames * 2; index++) {
        int32_t sample = data[index];
        uint32_t magnitude = sample < 0 ? (uint32_t) -sample : (uint32_t) sample;
        if (magnitude > audio_peak) audio_peak = magnitude;
    }
    size_t capture_frames = frames;
    if (capture_frames > AUDIO_CAPTURE_CAPACITY - audio_capture_size) {
        capture_frames = AUDIO_CAPTURE_CAPACITY - audio_capture_size;
    }
    for (size_t index = 0; index < capture_frames; index++) {
        audio_capture[audio_capture_size++] = data[index * 2];
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

EMSCRIPTEN_KEEPALIVE void psx_probe_set_rgb32(unsigned enabled) {
    force_rgb32 = enabled != 0;
}

EMSCRIPTEN_KEEPALIVE void psx_probe_set_frameskip(unsigned enabled) {
    force_frameskip = enabled != 0;
}

EMSCRIPTEN_KEEPALIVE void psx_probe_set_real_bios(unsigned enabled) {
    force_real_bios = enabled != 0;
}

EMSCRIPTEN_KEEPALIVE void psx_probe_set_shared_cards(unsigned enabled) {
    force_shared_cards = enabled != 0;
}

EMSCRIPTEN_KEEPALIVE void psx_probe_set_m3u(unsigned enabled) {
    use_m3u = enabled != 0;
}

EMSCRIPTEN_KEEPALIVE int psx_probe_boot(void) {
    struct retro_game_info game = {
        .path = use_m3u ? "/content/m0-fixture.m3u" : "/content/m0-fixture.cue",
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
    free(state_buffer);
    state_buffer = NULL;
    state_buffer_size = 0;
}

EMSCRIPTEN_KEEPALIVE void psx_probe_reset_audio_observation(void) {
    audio_hash = 2166136261u;
    audio_frames = 0;
    audio_peak = 0;
    audio_capture_size = 0;
    audio_batch_calls = 0;
    audio_batch_min_frames = UINT32_MAX;
    audio_batch_max_frames = 0;
}

EMSCRIPTEN_KEEPALIVE void psx_probe_reset_video_observation(void) {
    video_hash = 2166136261u;
    video_frames = 0;
    null_video_frames = 0;
}

EMSCRIPTEN_KEEPALIVE unsigned psx_probe_save_state(void) {
    size_t required_size = retro_serialize_size();
    if (required_size == 0) return 0;
    if (state_buffer_size != required_size) {
        uint8_t *replacement = (uint8_t *) realloc(state_buffer, required_size);
        if (replacement == NULL) return 0;
        state_buffer = replacement;
        state_buffer_size = required_size;
    }
    return retro_serialize(state_buffer, state_buffer_size) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE unsigned psx_probe_restore_state(void) {
    if (state_buffer == NULL || state_buffer_size == 0) return 0;
    return retro_unserialize(state_buffer, state_buffer_size) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE unsigned psx_probe_state_size(void) {
    return (unsigned) retro_serialize_size();
}

EMSCRIPTEN_KEEPALIVE unsigned psx_probe_state_hash(void) {
    if (state_buffer == NULL) return 0;
    return hash_bytes(2166136261u, state_buffer, state_buffer_size);
}

EMSCRIPTEN_KEEPALIVE unsigned psx_probe_disk_available(void) {
    return disk_control_available ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE unsigned psx_probe_disk_count(void) {
    return disk_control_available && disk_control_ext.get_num_images != NULL
        ? disk_control_ext.get_num_images()
        : 0;
}

EMSCRIPTEN_KEEPALIVE unsigned psx_probe_disk_index(void) {
    return disk_control_available && disk_control_ext.get_image_index != NULL
        ? disk_control_ext.get_image_index()
        : UINT32_MAX;
}

EMSCRIPTEN_KEEPALIVE unsigned psx_probe_disk_ejected(void) {
    return disk_control_available && disk_control_ext.get_eject_state != NULL
        && disk_control_ext.get_eject_state()
        ? 1
        : 0;
}

EMSCRIPTEN_KEEPALIVE unsigned psx_probe_set_disk_ejected(unsigned ejected) {
    return disk_control_available && disk_control_ext.set_eject_state != NULL
        && disk_control_ext.set_eject_state(ejected != 0)
        ? 1
        : 0;
}

EMSCRIPTEN_KEEPALIVE unsigned psx_probe_set_disk_index(unsigned index) {
    return disk_control_available && disk_control_ext.set_image_index != NULL
        && disk_control_ext.set_image_index(index)
        ? 1
        : 0;
}

EMSCRIPTEN_KEEPALIVE unsigned psx_probe_disk_path_hash(unsigned index) {
    char path[1024];
    if (!disk_control_available || disk_control_ext.get_image_path == NULL
        || !disk_control_ext.get_image_path(index, path, sizeof(path))) {
        return 0;
    }
    return hash_bytes(2166136261u, (const uint8_t *) path, strlen(path));
}

EMSCRIPTEN_KEEPALIVE unsigned psx_probe_environment_count(void) { return environment_trace_size; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_log_count(void) { return log_trace_size; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_log_char_at(unsigned index) {
    return index < log_trace_size ? (unsigned) (uint8_t) log_trace[index] : 0;
}
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_environment_at(unsigned index) {
    return index < environment_trace_size ? environment_trace[index] : UINT32_MAX;
}
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_video_frames(void) { return video_frames; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_null_video_frames(void) { return null_video_frames; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_video_hash(void) { return video_hash; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_audio_hash(void) { return audio_hash; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_audio_frames(void) { return (unsigned) audio_frames; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_audio_peak(void) { return audio_peak; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_audio_capture_count(void) { return audio_capture_size; }
EMSCRIPTEN_KEEPALIVE int psx_probe_audio_sample_at(unsigned index) {
    return index < audio_capture_size ? audio_capture[index] : 0;
}
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_audio_batch_calls(void) { return audio_batch_calls; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_audio_batch_min_frames(void) {
    return audio_batch_calls > 0 ? audio_batch_min_frames : 0;
}
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_audio_batch_max_frames(void) {
    return audio_batch_max_frames;
}
#ifndef PSX_PROBE_NO_PCSX_INTERNALS
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_card_size(void) { return MEMORY_CARD_BYTES; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_card_hash(unsigned slot) {
    const uint8_t *data = slot == 0 ? (const uint8_t *) Mcd1Data : (const uint8_t *) Mcd2Data;
    return slot < 2 ? hash_bytes(2166136261u, data, MEMORY_CARD_BYTES) : 0;
}
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_card_byte(unsigned slot, unsigned offset) {
    if (slot >= 2 || offset >= MEMORY_CARD_BYTES) return UINT32_MAX;
    return (unsigned) (uint8_t) (slot == 0 ? Mcd1Data[offset] : Mcd2Data[offset]);
}
#endif
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_system_ram_word(unsigned offset) {
    const uint8_t *ram = (const uint8_t *) retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM);
    size_t ram_size = retro_get_memory_size(RETRO_MEMORY_SYSTEM_RAM);
    if (ram == NULL || ram_size < sizeof(uint32_t)
        || offset > ram_size - sizeof(uint32_t)) {
        return UINT32_MAX;
    }
    uint32_t value;
    memcpy(&value, ram + offset, sizeof(value));
    return value;
}
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
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_geometry_count(void) { return geometry_trace_size; }
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_geometry_callback_at(unsigned index) {
    return index < geometry_trace_size ? geometry_trace[index].callback_index : UINT32_MAX;
}
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_geometry_width_at(unsigned index) {
    return index < geometry_trace_size ? geometry_trace[index].width : 0;
}
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_geometry_height_at(unsigned index) {
    return index < geometry_trace_size ? geometry_trace[index].height : 0;
}
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_geometry_pitch_at(unsigned index) {
    return index < geometry_trace_size ? geometry_trace[index].pitch : 0;
}
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_geometry_format_at(unsigned index) {
    return index < geometry_trace_size ? geometry_trace[index].pixel_format : UINT32_MAX;
}
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_environment_geometry_count(void) {
    return environment_geometry_trace_size;
}
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_environment_geometry_command_at(unsigned index) {
    return index < environment_geometry_trace_size
        ? environment_geometry_trace[index].command
        : UINT32_MAX;
}
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_environment_geometry_base_width_at(unsigned index) {
    return index < environment_geometry_trace_size
        ? environment_geometry_trace[index].base_width
        : 0;
}
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_environment_geometry_base_height_at(unsigned index) {
    return index < environment_geometry_trace_size
        ? environment_geometry_trace[index].base_height
        : 0;
}
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_environment_geometry_max_width_at(unsigned index) {
    return index < environment_geometry_trace_size
        ? environment_geometry_trace[index].max_width
        : 0;
}
EMSCRIPTEN_KEEPALIVE unsigned psx_probe_environment_geometry_max_height_at(unsigned index) {
    return index < environment_geometry_trace_size
        ? environment_geometry_trace[index].max_height
        : 0;
}
