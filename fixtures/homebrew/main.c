#include <stdint.h>
#include <stdio.h>

#include <hwregs_c.h>
#include <psxapi.h>
#include <psxgpu.h>
#include <psxpad.h>
#include <psxspu.h>

#define SCREEN_WIDTH 320
#define SCREEN_HEIGHT 240
#define TONE_BLOCKS 32
#define TONE_BYTES (TONE_BLOCKS * 16)

static DISPENV display_environment[2];
static DRAWENV draw_environment[2];
static uint8_t pad_buffer[2][34];
static uint8_t tone[TONE_BYTES] __attribute__((aligned(4)));
static int active_buffer;

static void initialize_video(void) {
    ResetGraph(0);

    SetDefDispEnv(&display_environment[0], 0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
    SetDefDispEnv(&display_environment[1], 0, SCREEN_HEIGHT, SCREEN_WIDTH, SCREEN_HEIGHT);
    SetDefDrawEnv(&draw_environment[0], 0, SCREEN_HEIGHT, SCREEN_WIDTH, SCREEN_HEIGHT);
    SetDefDrawEnv(&draw_environment[1], 0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);

    for (int index = 0; index < 2; index++) {
        setRGB0(&draw_environment[index], 16, 32, 64);
        draw_environment[index].isbg = 1;
    }

    active_buffer = 0;
    PutDispEnv(&display_environment[active_buffer]);
    PutDrawEnv(&draw_environment[active_buffer]);
    FntLoad(960, 0);
    FntOpen(8, 16, 304, 208, 0, 256);
    SetDispMask(1);
}

static void initialize_input(void) {
    InitPAD((char *) pad_buffer[0], sizeof(pad_buffer[0]), (char *) pad_buffer[1], sizeof(pad_buffer[1]));
    StartPAD();
    ChangeClearPAD(0);
}

static void initialize_audio(void) {
    for (int block = 0; block < TONE_BLOCKS; block++) {
        uint8_t *data = &tone[block * 16];
        data[0] = 0x00;
        data[1] = block == 0 ? 0x04 : (block == TONE_BLOCKS - 1 ? 0x03 : 0x00);

        for (int index = 2; index < 16; index++) {
            data[index] = block & 1 ? 0x77 : 0x99;
        }
    }

    SpuInit();
    SpuSetTransferMode(SPU_TRANSFER_BY_DMA);
    SpuSetTransferStartAddr(0x1010);
    SpuWrite(tone, sizeof(tone));
    SpuWait();

    SPU_CH_FREQ(0) = 0x0800;
    SPU_CH_ADDR(0) = 0x0202;
    SPU_CH_VOL_L(0) = 0x2400;
    SPU_CH_VOL_R(0) = 0x1800;
    SPU_CH_ADSR(0) = 0x1fee80ff;
    SpuSetKey(1, 1);
}

static uint16_t read_buttons(void) {
    PADTYPE *pad = (PADTYPE *) pad_buffer[0];
    if (pad->stat != 0) return 0;
    if (pad->type != PAD_ID_DIGITAL && pad->type != PAD_ID_ANALOG_STICK && pad->type != PAD_ID_ANALOG) {
        return 0;
    }
    return (uint16_t) ~pad->btn;
}

static void present_frame(uint32_t frame, uint16_t buttons) {
    uint8_t red = (uint8_t) (16 + ((frame >> 1) & 31));
    uint8_t green = (buttons & PAD_CROSS) ? 112 : 32;
    uint8_t blue = (buttons & PAD_CIRCLE) ? 16 : 64;

    setRGB0(&draw_environment[0], red, green, blue);
    setRGB0(&draw_environment[1], red, green, blue);

    FntPrint(-1, "PSX RUNTIME M0 FIXTURE\n\n");
    FntPrint(-1, "FRAME %08u\n", frame);
    FntPrint(-1, "BUTTONS %04x\n", buttons);
    FntPrint(-1, "VIDEO 320X240 NTSC\n");
    FntPrint(-1, "AUDIO 22050HZ LOOP\n");
    FntFlush(-1);

    DrawSync(0);
    VSync(0);
    active_buffer ^= 1;
    PutDispEnv(&display_environment[active_buffer]);
    PutDrawEnv(&draw_environment[active_buffer]);
}

int main(void) {
    initialize_video();
    initialize_input();
    initialize_audio();

    for (uint32_t frame = 0;; frame++) {
        present_frame(frame, read_buttons());
    }

    return 0;
}
