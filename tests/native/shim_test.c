#include "psx_frontend.h"
#include "psx_disc_io.h"
#include "libretro.h"

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int fake_observed_button(void);
int fake_observed_axis(void);
unsigned fake_unload_count(void);
unsigned fake_deinit_count(void);
unsigned fake_controller_count(void);
unsigned fake_controller_before_load_count(void);
unsigned fake_controller_device(unsigned port);
unsigned fake_initial_image_count(void);
const char *fake_initial_image_path(void);
const char *fake_disc_trace(void);

#define DISC_TEST_BYTES 20000u
#define DISC_TEST_READS 7u
#define DISC_TEST_MAX_READ 2352u

struct disc_test_read {
    off_t offset;
    size_t length;
};

static const struct disc_test_read disc_test_reads[DISC_TEST_READS] = {
    { 0, 2352 },
    { 2352, 2352 },
    { 4704, 2352 },
    { 128, 512 },
    { 640, 2352 },
    { 19900, 200 },
    { 20000, 32 },
};

static void run_disc_read_sequence(
    int enabled,
    unsigned char output[DISC_TEST_READS][DISC_TEST_MAX_READ],
    size_t returned[DISC_TEST_READS],
    unsigned long *skips
) {
    unsigned char content[DISC_TEST_BYTES];
    FILE *file = tmpfile();
    assert(file != NULL);
    for (size_t index = 0; index < sizeof(content); index++) {
        content[index] = (unsigned char) ((index * 31u) % 251u);
    }
    assert(fwrite(content, 1, sizeof(content), file) == sizeof(content));
    assert(fflush(file) == 0);
    psx_set_sequential_read_reuse(enabled);
    for (size_t index = 0; index < DISC_TEST_READS; index++) {
        assert(psx_runtime_disc_seek(file, disc_test_reads[index].offset) == 0);
        returned[index] = fread(output[index], 1, disc_test_reads[index].length, file);
    }
    *skips = psx_sequential_read_reuse_skips();
    assert(fclose(file) == 0);
}

static void test_sequential_read_reuse(void) {
    unsigned char baseline[DISC_TEST_READS][DISC_TEST_MAX_READ] = {{0}};
    unsigned char candidate[DISC_TEST_READS][DISC_TEST_MAX_READ] = {{0}};
    size_t baseline_returned[DISC_TEST_READS] = {0};
    size_t candidate_returned[DISC_TEST_READS] = {0};
    unsigned long baseline_skips = 0;
    unsigned long candidate_skips = 0;
    run_disc_read_sequence(0, baseline, baseline_returned, &baseline_skips);
    run_disc_read_sequence(1, candidate, candidate_returned, &candidate_skips);
    assert(baseline_skips == 0);
    assert(candidate_skips == 4);
    for (size_t index = 0; index < DISC_TEST_READS; index++) {
        assert(candidate_returned[index] == baseline_returned[index]);
        assert(memcmp(candidate[index], baseline[index], baseline_returned[index]) == 0);
    }
    assert(candidate_returned[5] == 100);
    assert(candidate_returned[6] == 0);
}

int main(void) {
    test_sequential_read_reuse();
    assert(psx_start(
        "/content/index/game.cue",
        "{\"controllers\":{\"1\":\"dualshock\",\"2\":\"digital\"},"
        "\"initialDiscIndex\":1,\"initialDiscPath\":\"/content/index/disc-001.cue\"}"
    ) == 1);
    assert(psx_start("/content/index/game.cue", "{}") == 0);
    assert(fake_controller_count() == 2);
    assert(fake_controller_before_load_count() == 0);
    assert(fake_controller_device(0) == (((1u + 1u) << 8) | RETRO_DEVICE_ANALOG));
    assert(fake_controller_device(1) == RETRO_DEVICE_JOYPAD);
    assert(fake_initial_image_count() == 1);
    assert(strcmp(fake_initial_image_path(), "/content/index/disc-001.cue") == 0);
    assert(psx_disc_index() == 1);
    assert(psx_frames_per_second() == 60.0);
    assert(psx_sample_rate() == 44100.0);
    assert(psx_aspect_ratio() == 2.0f);
    assert(psx_max_width() == 4 && psx_max_height() == 2);

    psx_set_button(0, 0, 1);
    psx_set_axis(0, 0, -1234);
    assert(psx_run_frame(1, 1, 0) == 1);
    assert(fake_observed_button() == 1);
    assert(fake_observed_axis() == -1234);
    assert(psx_video_width() == 2 && psx_video_height() == 1);
    assert(psx_video_pitch() == 6 && psx_video_size() == 6);
    assert(psx_video_format() == PSX_PIXEL_RGB565);
    assert(psx_video_data()[0] == 0x00 && psx_video_data()[1] == 0xf8);
    assert(psx_audio_frames() == 3);
    assert(psx_audio_data()[0] == -32768 && psx_audio_data()[1] == 32767);
    assert(psx_rumble(0, 0) == 65535 && psx_rumble(0, 1) == 32768);

    size_t state_size = psx_serialize_size();
    assert(state_size == sizeof(unsigned));
    uint8_t state[sizeof(unsigned)];
    assert(psx_serialize(state, sizeof(state)) == 1);
    assert(psx_run_frame(1, 1, 0) == 1);
    assert(psx_video_width() == 1 && psx_video_height() == 1);
    assert(psx_video_pitch() == 2 && psx_aspect_ratio() == 1.0f);
    assert(psx_unserialize(state, sizeof(state)) == 1);
    assert(psx_run_frame(1, 1, 0) == 1);
    assert(psx_video_width() == 1 && psx_video_duplicate() == 0);
    assert(psx_run_frame(1, 1, 0) == 1 && psx_video_duplicate() == 1);
    assert(psx_run_frame(0, 0, 3) == 1);
    assert(psx_audio_frames() == 0 && psx_video_size() == 0 && psx_video_duplicate() == 0);
    assert(psx_run_frame(1, 1, 0) == 1 && psx_audio_frames() == 3);

    assert(psx_memory_card_size(0) == 128u * 1024u);
    assert(psx_memory_card_size(1) == 128u * 1024u);
    uint8_t *card = (uint8_t *) malloc(128u * 1024u);
    assert(card != NULL);
    assert(psx_read_memory_card(1, card, 128u * 1024u) == 1 && card[0] == 0x22);
    memset(card, 0x5a, 128u * 1024u);
    assert(psx_write_memory_card(1, card, 128u * 1024u) == 1);
    memset(card, 0, 128u * 1024u);
    assert(psx_read_memory_card(1, card, 128u * 1024u) == 1 && card[0] == 0x5a);
    free(card);

    assert(psx_disc_count() == 2);
    assert(psx_set_disc(1) == 1);
    assert(psx_disc_index() == 1 && psx_tray_open() == 0);
    assert(strcmp(fake_disc_trace(), "O2C") == 0);
    assert(psx_set_disc(2) == 0);
    assert(psx_log_size() > 0 && strstr(psx_log_data(), "synthetic core initialized") != NULL);

    psx_stop();
    psx_stop();
    assert(fake_unload_count() == 1 && fake_deinit_count() == 1);
    assert(psx_run_frame(1, 1, 0) == 0);
    assert(psx_start("/content/index/game.cue", "{}") == 1);
    psx_stop();
    assert(fake_unload_count() == 2 && fake_deinit_count() == 2);

    puts("{\"ok\":true,\"lifecycleRuns\":2,\"dynamicGeometry\":true,\"cards\":2,\"discs\":2}");
    return 0;
}
