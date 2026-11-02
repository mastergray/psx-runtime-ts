#include "libretro.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define CARD_BYTES (128u * 1024u)

static retro_environment_t environment;
static retro_video_refresh_t video;
static retro_audio_sample_t audio_sample;
static retro_audio_sample_batch_t audio_batch;
static retro_input_poll_t input_poll;
static retro_input_state_t input_state;
static struct retro_rumble_interface rumble;
static uint8_t cards[CARD_BYTES * 2];
static unsigned frame_count;
static unsigned disc_index;
static bool tray_open;
static int observed_button;
static int16_t observed_axis;
static unsigned unload_count;
static unsigned deinit_count;
static unsigned controller_count;
static unsigned controller_before_load_count;
static unsigned controller_devices[2];
static bool game_loaded;
static unsigned initial_image_count;
static char initial_image_path[128];
static char disc_trace[32];
static size_t disc_trace_size;

static void trace_disc(char operation) {
    if (disc_trace_size + 1 >= sizeof(disc_trace)) return;
    disc_trace[disc_trace_size++] = operation;
    disc_trace[disc_trace_size] = '\0';
}

static bool set_eject_state(bool ejected) {
    tray_open = ejected;
    trace_disc(ejected ? 'O' : 'C');
    return true;
}

static bool get_eject_state(void) { return tray_open; }
static unsigned get_image_index(void) { return disc_index; }
static bool set_image_index(unsigned index) {
    if (!tray_open || index >= 2) return false;
    disc_index = index;
    trace_disc('1' + (char) index);
    return true;
}
static unsigned get_num_images(void) { return 2; }
static bool replace_image_index(unsigned index, const struct retro_game_info *info) {
    (void) index;
    (void) info;
    return false;
}
static bool add_image_index(void) { return false; }
static bool set_initial_image(unsigned index, const char *path) {
    initial_image_count++;
    snprintf(initial_image_path, sizeof(initial_image_path), "%s", path == NULL ? "" : path);
    disc_index = index;
    return index < 2;
}
static bool get_image_path(unsigned index, char *path, size_t len) {
    const char *value = index == 0 ? "/content/index/disc1.cue" : "/content/index/disc2.cue";
    return index < 2 && snprintf(path, len, "%s", value) > 0;
}
static bool get_image_label(unsigned index, char *label, size_t len) {
    return index < 2 && snprintf(label, len, "Disc %u", index + 1) > 0;
}

void retro_set_environment(retro_environment_t callback) { environment = callback; }
void retro_set_video_refresh(retro_video_refresh_t callback) { video = callback; }
void retro_set_audio_sample(retro_audio_sample_t callback) { audio_sample = callback; }
void retro_set_audio_sample_batch(retro_audio_sample_batch_t callback) { audio_batch = callback; }
void retro_set_input_poll(retro_input_poll_t callback) { input_poll = callback; }
void retro_set_input_state(retro_input_state_t callback) { input_state = callback; }

void retro_init(void) {
    frame_count = 0;
    disc_index = 0;
    tray_open = false;
    observed_button = 0;
    observed_axis = 0;
    controller_count = 0;
    controller_before_load_count = 0;
    controller_devices[0] = 0;
    controller_devices[1] = 0;
    game_loaded = false;
    initial_image_count = 0;
    initial_image_path[0] = '\0';
    disc_trace_size = 0;
    disc_trace[0] = '\0';
    memset(cards, 0x11, CARD_BYTES);
    memset(cards + CARD_BYTES, 0x22, CARD_BYTES);
    struct retro_log_callback log = {0};
    if (environment(RETRO_ENVIRONMENT_GET_LOG_INTERFACE, &log) && log.log != NULL) {
        log.log(RETRO_LOG_INFO, "synthetic core initialized\n");
    }
    enum retro_pixel_format format = RETRO_PIXEL_FORMAT_RGB565;
    (void) environment(RETRO_ENVIRONMENT_SET_PIXEL_FORMAT, &format);
    struct retro_disk_control_ext_callback disk = {
        .set_eject_state = set_eject_state,
        .get_eject_state = get_eject_state,
        .get_image_index = get_image_index,
        .set_image_index = set_image_index,
        .get_num_images = get_num_images,
        .replace_image_index = replace_image_index,
        .add_image_index = add_image_index,
        .set_initial_image = set_initial_image,
        .get_image_path = get_image_path,
        .get_image_label = get_image_label,
    };
    (void) environment(RETRO_ENVIRONMENT_SET_DISK_CONTROL_EXT_INTERFACE, &disk);
    memset(&rumble, 0, sizeof(rumble));
    (void) environment(RETRO_ENVIRONMENT_GET_RUMBLE_INTERFACE, &rumble);
}

void retro_deinit(void) { deinit_count++; }
unsigned retro_api_version(void) { return RETRO_API_VERSION; }
void retro_get_system_info(struct retro_system_info *info) {
    info->library_name = "Synthetic PSX";
    info->library_version = "1";
    info->valid_extensions = "cue|m3u";
    info->need_fullpath = true;
    info->block_extract = false;
}
void retro_get_system_av_info(struct retro_system_av_info *info) {
    *info = (struct retro_system_av_info) {
        .geometry = {
            .base_width = 2,
            .base_height = 1,
            .max_width = 4,
            .max_height = 2,
            .aspect_ratio = 2.0f,
        },
        .timing = { .fps = 60.0, .sample_rate = 44100.0 },
    };
}
void retro_set_controller_port_device(unsigned port, unsigned device) {
    if (port >= 2) return;
    controller_count++;
    controller_devices[port] = device;
    if (!game_loaded) controller_before_load_count++;
}
void retro_reset(void) { frame_count = 0; }

void retro_run(void) {
    input_poll();
    observed_button = input_state(0, RETRO_DEVICE_JOYPAD, 0, 0);
    observed_axis = input_state(0, RETRO_DEVICE_ANALOG, RETRO_DEVICE_INDEX_ANALOG_LEFT, RETRO_DEVICE_ID_ANALOG_X);
    frame_count++;
    if (frame_count == 1) {
        const uint8_t pixels[] = { 0x00, 0xf8, 0x1f, 0x00, 0xaa, 0xaa };
        video(pixels, 2, 1, 6);
    } else if (frame_count == 2) {
        const struct retro_game_geometry geometry = {
            .base_width = 1,
            .base_height = 1,
            .max_width = 4,
            .max_height = 2,
            .aspect_ratio = 1.0f,
        };
        (void) environment(RETRO_ENVIRONMENT_SET_GEOMETRY, (void *) &geometry);
        const uint8_t pixel[] = { 0xe0, 0x07 };
        video(pixel, 1, 1, 2);
    } else {
        video(NULL, 1, 1, 2);
    }
    const int16_t samples[] = { -32768, 32767, -1000, 1000 };
    (void) audio_batch(samples, 2);
    if (audio_sample != NULL) audio_sample(0, 0);
    if (frame_count == 1 && rumble.set_rumble_state != NULL) {
        (void) rumble.set_rumble_state(0, RETRO_RUMBLE_STRONG, 65535);
        (void) rumble.set_rumble_state(0, RETRO_RUMBLE_WEAK, 32768);
    }
}

size_t retro_serialize_size(void) { return sizeof(frame_count); }
bool retro_serialize(void *data, size_t size) {
    if (size != sizeof(frame_count)) return false;
    memcpy(data, &frame_count, sizeof(frame_count));
    return true;
}
bool retro_unserialize(const void *data, size_t size) {
    if (size != sizeof(frame_count)) return false;
    memcpy(&frame_count, data, sizeof(frame_count));
    return true;
}
bool retro_load_game(const struct retro_game_info *game) {
    game_loaded = game != NULL && game->path != NULL
        && strcmp(game->path, "/content/index/game.cue") == 0
        && game->data == NULL && game->size == 0;
    return game_loaded;
}
void retro_unload_game(void) { unload_count++; }
unsigned retro_get_region(void) { return 0; }
void *retro_get_memory_data(unsigned id) { return id == RETRO_MEMORY_SAVE_RAM ? cards : NULL; }
size_t retro_get_memory_size(unsigned id) { return id == RETRO_MEMORY_SAVE_RAM ? sizeof(cards) : 0; }

int fake_observed_button(void) { return observed_button; }
int fake_observed_axis(void) { return observed_axis; }
unsigned fake_unload_count(void) { return unload_count; }
unsigned fake_deinit_count(void) { return deinit_count; }
unsigned fake_controller_count(void) { return controller_count; }
unsigned fake_controller_before_load_count(void) { return controller_before_load_count; }
unsigned fake_controller_device(unsigned port) { return port < 2 ? controller_devices[port] : 0; }
unsigned fake_initial_image_count(void) { return initial_image_count; }
const char *fake_initial_image_path(void) { return initial_image_path; }
const char *fake_disc_trace(void) { return disc_trace; }
