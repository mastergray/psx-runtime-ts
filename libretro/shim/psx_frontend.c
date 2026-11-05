#include "psx_frontend_internal.h"

#include "libretro.h"

#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PSX_PORTS 2
#define PSX_BUTTONS 16
#define PSX_AXES 4
#define PSX_CARD_BYTES (128u * 1024u)
#define PSX_LOG_BYTES (32u * 1024u)
#define PSX_DISC_EJECT_FRAMES 30u
#define PSX_DEVICE_DUALSHOCK (((1u + 1u) << 8) | RETRO_DEVICE_ANALOG)

struct psx_frontend_state {
    bool initialized;
    bool loaded;
    bool started;
    bool failed;
    bool video_duplicate;
    bool capture_video;
    bool capture_audio;
    bool variables_updated;
    unsigned frameskip_interval;
    enum retro_pixel_format pixel_format;
    struct retro_system_av_info av_info;
    struct retro_disk_control_ext_callback disk;
    bool disk_available;
    uint16_t buttons[PSX_PORTS];
    int16_t axes[PSX_PORTS][PSX_AXES];
    uint16_t rumble[PSX_PORTS][2];
    uint8_t *video;
    size_t video_capacity;
    size_t video_size;
    unsigned video_width;
    unsigned video_height;
    size_t video_pitch;
    int16_t *audio;
    size_t audio_capacity_samples;
    size_t audio_frame_count;
    char log[PSX_LOG_BYTES];
    size_t log_size;
};

static struct psx_frontend_state frontend;
static char failed_start_log[PSX_LOG_BYTES];
static size_t failed_start_log_size;

#ifdef PSX_RUNTIME_PCSX_REARMED
extern char Mcd1Data[PSX_CARD_BYTES];
extern char Mcd2Data[PSX_CARD_BYTES];
#endif

static bool reserve_video(size_t bytes) {
    if (bytes <= frontend.video_capacity) return true;
    uint8_t *replacement = (uint8_t *) realloc(frontend.video, bytes);
    if (replacement == NULL) return false;
    frontend.video = replacement;
    frontend.video_capacity = bytes;
    return true;
}

static bool reserve_audio(size_t samples) {
    if (samples <= frontend.audio_capacity_samples) return true;
    int16_t *replacement = (int16_t *) realloc(frontend.audio, samples * sizeof(int16_t));
    if (replacement == NULL) return false;
    frontend.audio = replacement;
    frontend.audio_capacity_samples = samples;
    return true;
}

static void log_callback(enum retro_log_level level, const char *format, ...) {
    (void) level;
    if (frontend.log_size >= PSX_LOG_BYTES - 1) return;
    va_list arguments;
    va_start(arguments, format);
    int written = vsnprintf(
        frontend.log + frontend.log_size,
        PSX_LOG_BYTES - frontend.log_size,
        format,
        arguments
    );
    va_end(arguments);
    if (written <= 0) return;
    size_t available = PSX_LOG_BYTES - frontend.log_size - 1;
    frontend.log_size += (size_t) written < available ? (size_t) written : available;
}

static const char *option_value(const char *key) {
    if (strcmp(key, "pcsx_rearmed_bios") == 0) return "auto";
    if (strcmp(key, "pcsx_rearmed_show_bios_bootlogo") == 0) return "disabled";
    if (strcmp(key, "pcsx_rearmed_memcard1") == 0) return "shared";
    if (strcmp(key, "pcsx_rearmed_memcard2") == 0) return "shared";
    if (strcmp(key, "pcsx_rearmed_region") == 0) return "auto";
    if (strcmp(key, "pcsx_rearmed_rgb32_output") == 0) return "disabled";
    if (strcmp(key, "pcsx_rearmed_dithering") == 0) return "disabled";
    if (strcmp(key, "pcsx_rearmed_frameskip_type") == 0) {
        return frontend.frameskip_interval == 0 ? "disabled" : "fixed_interval";
    }
    if (strcmp(key, "pcsx_rearmed_frameskip_interval") == 0) {
        switch (frontend.frameskip_interval) {
            case 1: return "1";
            case 2: return "2";
            case 3: return "3";
            case 4: return "4";
            case 5: return "5";
            case 6: return "6";
            case 7: return "7";
            case 8: return "8";
            case 9: return "9";
            default: return "10";
        }
    }
    if (strcmp(key, "pcsx_rearmed_cd_readahead") == 0) return "0";
    if (strcmp(key, "pcsx_rearmed_drc") == 0) return "disabled";
    return NULL;
}

static bool rumble_callback(unsigned port, enum retro_rumble_effect effect, uint16_t strength) {
    if (port >= PSX_PORTS || (unsigned) effect >= 2) return false;
    frontend.rumble[port][effect] = strength;
    return true;
}

static bool environment_callback(unsigned command, void *data) {
    switch (command) {
        case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
            if (data == NULL) return false;
            ((struct retro_log_callback *) data)->log = log_callback;
            return true;
        case RETRO_ENVIRONMENT_GET_VARIABLE: {
            if (data == NULL) return false;
            struct retro_variable *variable = (struct retro_variable *) data;
            variable->value = variable->key == NULL ? NULL : option_value(variable->key);
            return variable->value != NULL;
        }
        case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
            if (data == NULL) return false;
            *(bool *) data = frontend.variables_updated;
            frontend.variables_updated = false;
            return true;
        case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
            if (data == NULL) return false;
            *(const char **) data = "/system";
            return true;
        case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
            if (data == NULL) return false;
            *(const char **) data = "/save";
            return true;
        case RETRO_ENVIRONMENT_GET_CONTENT_DIRECTORY:
            if (data == NULL) return false;
            *(const char **) data = "/content";
            return true;
        case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: {
            if (data == NULL) return false;
            enum retro_pixel_format format = *(const enum retro_pixel_format *) data;
            if (format != RETRO_PIXEL_FORMAT_0RGB1555
                && format != RETRO_PIXEL_FORMAT_RGB565
                && format != RETRO_PIXEL_FORMAT_XRGB8888) return false;
            frontend.pixel_format = format;
            return true;
        }
        case RETRO_ENVIRONMENT_GET_CAN_DUPE:
            if (data == NULL) return false;
            *(bool *) data = true;
            return true;
        case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
            return true;
        case RETRO_ENVIRONMENT_GET_DISK_CONTROL_INTERFACE_VERSION:
            if (data == NULL) return false;
            *(unsigned *) data = 1;
            return true;
        case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION:
        case RETRO_ENVIRONMENT_GET_MESSAGE_INTERFACE_VERSION:
            if (data == NULL) return false;
            *(unsigned *) data = 0;
            return true;
        case RETRO_ENVIRONMENT_GET_RUMBLE_INTERFACE:
            if (data == NULL) return false;
            ((struct retro_rumble_interface *) data)->set_rumble_state = rumble_callback;
            return true;
        case RETRO_ENVIRONMENT_SET_DISK_CONTROL_INTERFACE: {
            if (data == NULL) return false;
            const struct retro_disk_control_callback *disk =
                (const struct retro_disk_control_callback *) data;
            memset(&frontend.disk, 0, sizeof(frontend.disk));
            frontend.disk.set_eject_state = disk->set_eject_state;
            frontend.disk.get_eject_state = disk->get_eject_state;
            frontend.disk.get_image_index = disk->get_image_index;
            frontend.disk.set_image_index = disk->set_image_index;
            frontend.disk.get_num_images = disk->get_num_images;
            frontend.disk.replace_image_index = disk->replace_image_index;
            frontend.disk.add_image_index = disk->add_image_index;
            frontend.disk_available = true;
            return true;
        }
        case RETRO_ENVIRONMENT_SET_DISK_CONTROL_EXT_INTERFACE:
            if (data == NULL) return false;
            frontend.disk = *(const struct retro_disk_control_ext_callback *) data;
            frontend.disk_available = true;
            return true;
        case RETRO_ENVIRONMENT_SET_GEOMETRY:
            if (data == NULL) return false;
            frontend.av_info.geometry = *(const struct retro_game_geometry *) data;
            return true;
        case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
            if (data == NULL) return false;
            frontend.av_info = *(const struct retro_system_av_info *) data;
            return true;
        case RETRO_ENVIRONMENT_SET_VARIABLES:
        case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
        case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
        case RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL:
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
    if (!frontend.capture_video) return;
    if (data == NULL) {
        frontend.video_duplicate = true;
        return;
    }
    if (height != 0 && pitch > SIZE_MAX / height) {
        frontend.failed = true;
        return;
    }
    size_t bytes = pitch * height;
    if (!reserve_video(bytes)) {
        frontend.failed = true;
        return;
    }
    memcpy(frontend.video, data, bytes);
    frontend.video_size = bytes;
    frontend.video_width = width;
    frontend.video_height = height;
    frontend.video_pitch = pitch;
    frontend.video_duplicate = false;
}

static void audio_sample_callback(int16_t left, int16_t right) {
    if (!frontend.capture_audio) return;
    if (frontend.audio_frame_count > SIZE_MAX / (2 * sizeof(int16_t)) - 1) {
        frontend.failed = true;
        return;
    }
    size_t sample_offset = frontend.audio_frame_count * 2;
    if (!reserve_audio(sample_offset + 2)) {
        frontend.failed = true;
        return;
    }
    frontend.audio[sample_offset] = left;
    frontend.audio[sample_offset + 1] = right;
    frontend.audio_frame_count++;
}

static size_t audio_batch_callback(const int16_t *data, size_t frames) {
    if (!frontend.capture_audio) return frames;
    if (frames > SIZE_MAX / (2 * sizeof(int16_t)) - frontend.audio_frame_count) {
        frontend.failed = true;
        return 0;
    }
    size_t old_samples = frontend.audio_frame_count * 2;
    size_t new_samples = frames * 2;
    if (!reserve_audio(old_samples + new_samples)) {
        frontend.failed = true;
        return 0;
    }
    memcpy(frontend.audio + old_samples, data, new_samples * sizeof(int16_t));
    frontend.audio_frame_count += frames;
    return frames;
}

static void input_poll_callback(void) {}

static int16_t input_state_callback(unsigned port, unsigned device, unsigned index, unsigned id) {
    if (port >= PSX_PORTS) return 0;
    if (device == RETRO_DEVICE_JOYPAD) {
        if (id == RETRO_DEVICE_ID_JOYPAD_MASK) return (int16_t) frontend.buttons[port];
        return id < PSX_BUTTONS && (frontend.buttons[port] & (1u << id)) != 0 ? 1 : 0;
    }
    if (device == RETRO_DEVICE_ANALOG && index < 2 && id < 2) {
        return frontend.axes[port][index * 2 + id];
    }
    return 0;
}

static unsigned controller_device(const char *options_json, unsigned port) {
    if (options_json == NULL) return RETRO_DEVICE_JOYPAD;
    const char *key = port == 0 ? "\"1\":\"" : "\"2\":\"";
    const char *value = strstr(options_json, key);
    if (value == NULL) return RETRO_DEVICE_JOYPAD;
    value += strlen(key);
    if (strncmp(value, "none\"", 5) == 0) return RETRO_DEVICE_NONE;
    if (strncmp(value, "dualshock\"", 10) == 0) return PSX_DEVICE_DUALSHOCK;
    return RETRO_DEVICE_JOYPAD;
}

static int initial_disc(
    const char *options_json,
    unsigned *index,
    char *path,
    size_t path_capacity
) {
    if (options_json == NULL) return 0;
    const char *index_key = "\"initialDiscIndex\":";
    const char *index_value = strstr(options_json, index_key);
    if (index_value == NULL) return 0;
    index_value += strlen(index_key);
    char *index_end = NULL;
    unsigned long parsed = strtoul(index_value, &index_end, 10);
    if (index_end == index_value || parsed > 7) return -1;

    const char *path_key = "\"initialDiscPath\":\"";
    const char *path_value = strstr(index_end, path_key);
    if (path_value == NULL) return -1;
    path_value += strlen(path_key);
    const char *path_end = strchr(path_value, '"');
    if (path_end == NULL) return -1;
    size_t length = (size_t) (path_end - path_value);
    if (length == 0 || length >= path_capacity || memchr(path_value, '\\', length) != NULL) return -1;
    if (strncmp(path_value, "/content/index/", 15) != 0
        || length < 4 || strncmp(path_end - 4, ".cue", 4) != 0) return -1;
    memcpy(path, path_value, length);
    path[length] = '\0';
    *index = (unsigned) parsed;
    return 1;
}

static int reject_start(const char *message) {
    if (message != NULL) log_callback(RETRO_LOG_ERROR, "%s\n", message);
    failed_start_log_size = frontend.log_size;
    memcpy(failed_start_log, frontend.log, failed_start_log_size + 1);
    psx_frontend_stop();
    return 0;
}

int psx_frontend_start(const char *content_path, const char *options_json) {
    if (frontend.started || content_path == NULL || content_path[0] == '\0') return 0;
    frontend.pixel_format = RETRO_PIXEL_FORMAT_0RGB1555;
    frontend.failed = false;
    frontend.log_size = 0;
    frontend.log[0] = '\0';
    failed_start_log_size = 0;
    failed_start_log[0] = '\0';
    retro_set_environment(environment_callback);
    retro_set_video_refresh(video_callback);
    retro_set_audio_sample(audio_sample_callback);
    retro_set_audio_sample_batch(audio_batch_callback);
    retro_set_input_poll(input_poll_callback);
    retro_set_input_state(input_state_callback);
    if (retro_api_version() != RETRO_API_VERSION) return 0;
    retro_init();
    frontend.initialized = true;
    unsigned initial_disc_index = 0;
    char initial_disc_path[1024];
    int initial_disc_result = initial_disc(
        options_json,
        &initial_disc_index,
        initial_disc_path,
        sizeof(initial_disc_path)
    );
    if (initial_disc_result < 0) return reject_start("Initial disc selection is malformed.");
    if (initial_disc_result > 0 && (
        !frontend.disk_available
        || frontend.disk.set_initial_image == NULL
        || !frontend.disk.set_initial_image(initial_disc_index, initial_disc_path)
    )) return reject_start("The core rejected the initial disc selection.");
    const struct retro_game_info game = {
        .path = content_path,
        .data = NULL,
        .size = 0,
        .meta = NULL,
    };
    if (!retro_load_game(&game)) return reject_start(NULL);
    frontend.loaded = true;
    retro_set_controller_port_device(0, controller_device(options_json, 0));
    retro_set_controller_port_device(1, controller_device(options_json, 1));
    retro_get_system_av_info(&frontend.av_info);
    frontend.started = true;
    return 1;
}

int psx_frontend_run_frame(int capture_video, int capture_audio, unsigned frameskip_interval) {
    if (!frontend.started) return 0;
    unsigned next_frameskip = frameskip_interval > 10 ? 10 : frameskip_interval;
    if (frontend.frameskip_interval != next_frameskip) {
        frontend.frameskip_interval = next_frameskip;
        frontend.variables_updated = true;
    }
    frontend.capture_video = capture_video != 0;
    frontend.capture_audio = capture_audio != 0;
    frontend.audio_frame_count = 0;
    frontend.video_size = 0;
    frontend.video_duplicate = false;
    frontend.failed = false;
    retro_run();
    return frontend.failed ? 0 : 1;
}

void psx_frontend_set_button(unsigned port, unsigned id, int pressed) {
    if (port >= PSX_PORTS || id >= PSX_BUTTONS) return;
    uint16_t mask = (uint16_t) (1u << id);
    if (pressed != 0) frontend.buttons[port] |= mask;
    else frontend.buttons[port] &= (uint16_t) ~mask;
}

void psx_frontend_set_axis(unsigned port, unsigned id, int16_t value) {
    if (port >= PSX_PORTS || id >= PSX_AXES) return;
    frontend.axes[port][id] = value;
}

int psx_frontend_reset(void) {
    if (!frontend.started) return 0;
    retro_reset();
    return 1;
}

size_t psx_frontend_serialize_size(void) {
    return frontend.started ? retro_serialize_size() : 0;
}

int psx_frontend_serialize(void *out, size_t size) {
    return frontend.started && out != NULL && retro_serialize(out, size) ? 1 : 0;
}

int psx_frontend_unserialize(const void *data, size_t size) {
    return frontend.started && data != NULL && retro_unserialize(data, size) ? 1 : 0;
}

size_t psx_frontend_memory_card_size(unsigned slot) {
    if (!frontend.started || slot >= PSX_PORTS) return 0;
#ifdef PSX_RUNTIME_PCSX_REARMED
    return PSX_CARD_BYTES;
#else
    size_t bytes = retro_get_memory_size(RETRO_MEMORY_SAVE_RAM);
    return bytes >= (slot + 1u) * PSX_CARD_BYTES ? PSX_CARD_BYTES : 0;
#endif
}

int psx_frontend_read_memory_card(unsigned slot, void *out, size_t size) {
#ifdef PSX_RUNTIME_PCSX_REARMED
    const uint8_t *cards = (const uint8_t *) (slot == 0 ? Mcd1Data : Mcd2Data);
    if (out == NULL || size != psx_frontend_memory_card_size(slot)) return 0;
    memcpy(out, cards, PSX_CARD_BYTES);
#else
    uint8_t *cards = (uint8_t *) retro_get_memory_data(RETRO_MEMORY_SAVE_RAM);
    if (out == NULL || cards == NULL || size != psx_frontend_memory_card_size(slot)) return 0;
    memcpy(out, cards + slot * PSX_CARD_BYTES, PSX_CARD_BYTES);
#endif
    return 1;
}

int psx_frontend_write_memory_card(unsigned slot, const void *data, size_t size) {
#ifdef PSX_RUNTIME_PCSX_REARMED
    uint8_t *cards = (uint8_t *) (slot == 0 ? Mcd1Data : Mcd2Data);
    if (data == NULL || size != psx_frontend_memory_card_size(slot)) return 0;
    memcpy(cards, data, PSX_CARD_BYTES);
#else
    uint8_t *cards = (uint8_t *) retro_get_memory_data(RETRO_MEMORY_SAVE_RAM);
    if (data == NULL || cards == NULL || size != psx_frontend_memory_card_size(slot)) return 0;
    memcpy(cards + slot * PSX_CARD_BYTES, data, PSX_CARD_BYTES);
#endif
    return 1;
}

int psx_frontend_set_disc(unsigned index) {
    if (!frontend.started || !frontend.disk_available
        || frontend.disk.get_num_images == NULL
        || frontend.disk.set_eject_state == NULL
        || frontend.disk.set_image_index == NULL
        || index >= frontend.disk.get_num_images()) return 0;
    if (!frontend.disk.set_eject_state(true)) return 0;
    /* PCSX-ReARMed samples the lid state during retro_run; keep it observable before replacing media. */
    for (unsigned frame = 0; frame < PSX_DISC_EJECT_FRAMES; frame++) {
        if (!psx_frontend_run_frame(0, 0, 0)) {
            (void) frontend.disk.set_eject_state(false);
            return 0;
        }
    }
    if (!frontend.disk.set_image_index(index)) {
        (void) frontend.disk.set_eject_state(false);
        return 0;
    }
    if (!frontend.disk.set_eject_state(false)) return 0;
    return (frontend.disk.get_image_index == NULL || frontend.disk.get_image_index() == index)
        && (frontend.disk.get_eject_state == NULL || !frontend.disk.get_eject_state())
        ? 1
        : 0;
}

int psx_frontend_disc_count(void) {
    return frontend.started && frontend.disk_available && frontend.disk.get_num_images != NULL
        ? (int) frontend.disk.get_num_images()
        : 0;
}

void psx_frontend_stop(void) {
    if (frontend.loaded) retro_unload_game();
    if (frontend.initialized) retro_deinit();
    free(frontend.video);
    free(frontend.audio);
    memset(&frontend, 0, sizeof(frontend));
}

unsigned psx_video_width(void) { return frontend.video_width; }
unsigned psx_video_height(void) { return frontend.video_height; }
unsigned psx_base_width(void) { return frontend.av_info.geometry.base_width; }
unsigned psx_base_height(void) { return frontend.av_info.geometry.base_height; }
unsigned psx_video_pitch(void) { return (unsigned) frontend.video_pitch; }
unsigned psx_video_format(void) { return (unsigned) frontend.pixel_format; }
const uint8_t *psx_video_data(void) { return frontend.video; }
size_t psx_video_size(void) { return frontend.video_size; }
int psx_video_duplicate(void) { return frontend.video_duplicate ? 1 : 0; }
const int16_t *psx_audio_data(void) { return frontend.audio; }
size_t psx_audio_frames(void) { return frontend.audio_frame_count; }
double psx_frames_per_second(void) { return frontend.av_info.timing.fps; }
double psx_sample_rate(void) { return frontend.av_info.timing.sample_rate; }
int psx_is_pal(void) { return frontend.started && retro_get_region() == 1 ? 1 : 0; }
float psx_aspect_ratio(void) {
    float aspect = frontend.av_info.geometry.aspect_ratio;
    return aspect > 0.0f || frontend.av_info.geometry.base_height == 0
        ? aspect
        : (float) frontend.av_info.geometry.base_width / (float) frontend.av_info.geometry.base_height;
}
unsigned psx_max_width(void) { return frontend.av_info.geometry.max_width; }
unsigned psx_max_height(void) { return frontend.av_info.geometry.max_height; }
unsigned psx_disc_index(void) {
    return frontend.disk_available && frontend.disk.get_image_index != NULL
        ? frontend.disk.get_image_index()
        : 0;
}
int psx_tray_open(void) {
    return frontend.disk_available && frontend.disk.get_eject_state != NULL
        && frontend.disk.get_eject_state()
        ? 1
        : 0;
}
uint16_t psx_rumble(unsigned port, unsigned effect) {
    return port < PSX_PORTS && effect < 2 ? frontend.rumble[port][effect] : 0;
}
size_t psx_log_size(void) {
    return frontend.log_size != 0 ? frontend.log_size : failed_start_log_size;
}
const char *psx_log_data(void) {
    return frontend.log_size != 0 ? frontend.log : failed_start_log;
}
