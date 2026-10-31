/*
 * Minimal libretro ABI surface used by psx-runtime-ts.
 * Derived from libretro-common/include/libretro.h at PCSX-ReARMed's pinned
 * recursive dependency commit f0173cc9c0d354c0a97ab4c4d075dc560ccc5988.
 * Upstream header SHA-256:
 * 5875414c47d8af4facf118c184b40b0e311285333a46bbfe8221a853efe5ba7a
 *
 * This is an ABI declaration subset, not a modified upstream distribution.
 */
#ifndef PSX_RUNTIME_LIBRETRO_H
#define PSX_RUNTIME_LIBRETRO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define RETRO_API_VERSION 1
#define RETRO_ENVIRONMENT_EXPERIMENTAL 0x10000

#define RETRO_DEVICE_NONE 0
#define RETRO_DEVICE_JOYPAD 1
#define RETRO_DEVICE_ANALOG 5
#define RETRO_DEVICE_ID_JOYPAD_MASK 256
#define RETRO_DEVICE_INDEX_ANALOG_LEFT 0
#define RETRO_DEVICE_INDEX_ANALOG_RIGHT 1
#define RETRO_DEVICE_ID_ANALOG_X 0
#define RETRO_DEVICE_ID_ANALOG_Y 1

#define RETRO_MEMORY_SAVE_RAM 0
#define RETRO_MEMORY_SYSTEM_RAM 2

#define RETRO_ENVIRONMENT_GET_CAN_DUPE 3
#define RETRO_ENVIRONMENT_SET_MESSAGE 6
#define RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL 8
#define RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY 9
#define RETRO_ENVIRONMENT_SET_PIXEL_FORMAT 10
#define RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS 11
#define RETRO_ENVIRONMENT_SET_DISK_CONTROL_INTERFACE 13
#define RETRO_ENVIRONMENT_GET_VARIABLE 15
#define RETRO_ENVIRONMENT_SET_VARIABLES 16
#define RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE 17
#define RETRO_ENVIRONMENT_GET_RUMBLE_INTERFACE 23
#define RETRO_ENVIRONMENT_GET_LOG_INTERFACE 27
#define RETRO_ENVIRONMENT_GET_CONTENT_DIRECTORY 30
#define RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY 31
#define RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO 32
#define RETRO_ENVIRONMENT_SET_CONTROLLER_INFO 35
#define RETRO_ENVIRONMENT_SET_GEOMETRY 37
#define RETRO_ENVIRONMENT_GET_INPUT_BITMASKS (51 | RETRO_ENVIRONMENT_EXPERIMENTAL)
#define RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION 52
#define RETRO_ENVIRONMENT_GET_DISK_CONTROL_INTERFACE_VERSION 57
#define RETRO_ENVIRONMENT_SET_DISK_CONTROL_EXT_INTERFACE 58
#define RETRO_ENVIRONMENT_GET_MESSAGE_INTERFACE_VERSION 59
#define RETRO_ENVIRONMENT_SET_MESSAGE_EXT 60
#define RETRO_ENVIRONMENT_SET_AUDIO_BUFFER_STATUS_CALLBACK 62
#define RETRO_ENVIRONMENT_SET_MINIMUM_AUDIO_LATENCY 63

enum retro_pixel_format {
    RETRO_PIXEL_FORMAT_0RGB1555 = 0,
    RETRO_PIXEL_FORMAT_XRGB8888 = 1,
    RETRO_PIXEL_FORMAT_RGB565 = 2
};

enum retro_log_level {
    RETRO_LOG_DEBUG = 0,
    RETRO_LOG_INFO,
    RETRO_LOG_WARN,
    RETRO_LOG_ERROR
};

enum retro_rumble_effect {
    RETRO_RUMBLE_STRONG = 0,
    RETRO_RUMBLE_WEAK = 1
};

struct retro_game_geometry {
    unsigned base_width;
    unsigned base_height;
    unsigned max_width;
    unsigned max_height;
    float aspect_ratio;
};

struct retro_system_timing {
    double fps;
    double sample_rate;
};

struct retro_system_av_info {
    struct retro_game_geometry geometry;
    struct retro_system_timing timing;
};

struct retro_system_info {
    const char *library_name;
    const char *library_version;
    const char *valid_extensions;
    bool need_fullpath;
    bool block_extract;
};

struct retro_game_info {
    const char *path;
    const void *data;
    size_t size;
    const char *meta;
};

struct retro_variable {
    const char *key;
    const char *value;
};

typedef void (*retro_log_printf_t)(enum retro_log_level level, const char *format, ...);
struct retro_log_callback { retro_log_printf_t log; };

typedef bool (*retro_set_eject_state_t)(bool ejected);
typedef bool (*retro_get_eject_state_t)(void);
typedef unsigned (*retro_get_image_index_t)(void);
typedef bool (*retro_set_image_index_t)(unsigned index);
typedef unsigned (*retro_get_num_images_t)(void);
typedef bool (*retro_replace_image_index_t)(unsigned index, const struct retro_game_info *info);
typedef bool (*retro_add_image_index_t)(void);
typedef bool (*retro_set_initial_image_t)(unsigned index, const char *path);
typedef bool (*retro_get_image_path_t)(unsigned index, char *path, size_t len);
typedef bool (*retro_get_image_label_t)(unsigned index, char *label, size_t len);

struct retro_disk_control_callback {
    retro_set_eject_state_t set_eject_state;
    retro_get_eject_state_t get_eject_state;
    retro_get_image_index_t get_image_index;
    retro_set_image_index_t set_image_index;
    retro_get_num_images_t get_num_images;
    retro_replace_image_index_t replace_image_index;
    retro_add_image_index_t add_image_index;
};

struct retro_disk_control_ext_callback {
    retro_set_eject_state_t set_eject_state;
    retro_get_eject_state_t get_eject_state;
    retro_get_image_index_t get_image_index;
    retro_set_image_index_t set_image_index;
    retro_get_num_images_t get_num_images;
    retro_replace_image_index_t replace_image_index;
    retro_add_image_index_t add_image_index;
    retro_set_initial_image_t set_initial_image;
    retro_get_image_path_t get_image_path;
    retro_get_image_label_t get_image_label;
};

typedef bool (*retro_set_rumble_state_t)(unsigned port, enum retro_rumble_effect effect, uint16_t strength);
struct retro_rumble_interface { retro_set_rumble_state_t set_rumble_state; };

typedef bool (*retro_environment_t)(unsigned command, void *data);
typedef void (*retro_video_refresh_t)(const void *data, unsigned width, unsigned height, size_t pitch);
typedef void (*retro_audio_sample_t)(int16_t left, int16_t right);
typedef size_t (*retro_audio_sample_batch_t)(const int16_t *data, size_t frames);
typedef void (*retro_input_poll_t)(void);
typedef int16_t (*retro_input_state_t)(unsigned port, unsigned device, unsigned index, unsigned id);

void retro_set_environment(retro_environment_t callback);
void retro_set_video_refresh(retro_video_refresh_t callback);
void retro_set_audio_sample(retro_audio_sample_t callback);
void retro_set_audio_sample_batch(retro_audio_sample_batch_t callback);
void retro_set_input_poll(retro_input_poll_t callback);
void retro_set_input_state(retro_input_state_t callback);
void retro_init(void);
void retro_deinit(void);
unsigned retro_api_version(void);
void retro_get_system_info(struct retro_system_info *info);
void retro_get_system_av_info(struct retro_system_av_info *info);
void retro_set_controller_port_device(unsigned port, unsigned device);
void retro_reset(void);
void retro_run(void);
size_t retro_serialize_size(void);
bool retro_serialize(void *data, size_t size);
bool retro_unserialize(const void *data, size_t size);
bool retro_load_game(const struct retro_game_info *game);
void retro_unload_game(void);
unsigned retro_get_region(void);
void *retro_get_memory_data(unsigned id);
size_t retro_get_memory_size(unsigned id);

#ifdef __cplusplus
}
#endif

#endif
