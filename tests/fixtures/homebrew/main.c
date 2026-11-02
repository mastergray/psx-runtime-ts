#include <stdint.h>
#include <stdio.h>

#include <hwregs_c.h>
#include <psxapi.h>
#if defined(PSX_FIXTURE_MEDIA) || defined(PSX_FIXTURE_MULTIDISC)
#include <psxcd.h>
#endif
#include <psxgpu.h>
#include <psxpad.h>
#include <psxspu.h>

#define SCREEN_WIDTH 320
#define SCREEN_HEIGHT 240
#define TONE_BLOCKS 32
#define TONE_BYTES (TONE_BLOCKS * 16)

#ifdef PSX_FIXTURE_PAL
#define FIXTURE_REGION "PAL"
#else
#define FIXTURE_REGION "NTSC"
#endif

static DISPENV display_environment[2];
static DRAWENV draw_environment[2];
static uint8_t pad_buffer[2][34];
static uint8_t tone[TONE_BYTES] __attribute__((aligned(4)));
static int active_buffer;

#ifdef PSX_FIXTURE_CARDS
#define CARD_MARKER_SECTOR 63
void InitCard(int pad_enable);
void StartCard(void);
static uint8_t card_sector[128] __attribute__((aligned(4)));

static void write_card_marker(int channel, uint8_t marker) {
    for (int index = 0; index < (int) sizeof(card_sector); index++) {
        card_sector[index] = (uint8_t) (marker + index);
    }
    _card_write(channel, CARD_MARKER_SECTOR, card_sector);
}
#endif

#ifdef PSX_FIXTURE_MEDIA
#define MEDIA_STATUS (*(volatile uint32_t *) 0x800ff000)
static CdlLOC cdda_toc[100];
static int media_phase;

static void start_xa(void) {
    CdlFILE file;
    CdlFILTER filter = { .file = 1, .chan = 0, .pad = 0 };
    uint8_t mode = CdlModeSpeed | CdlModeRT | CdlModeSF;

    if (!CdSearchFile(&file, "\\XATONE.XA")) {
        MEDIA_STATUS = 0x4d454101;
        return;
    }
    CdControl(CdlSetmode, &mode, 0);
    CdControl(CdlSetfilter, &filter, 0);
    CdControl(CdlReadS, &file.pos, 0);
    media_phase = 1;
    MEDIA_STATUS = 0x4d454111;
}

static void start_cdda(void) {
    uint8_t mode = CdlModeDA;
    uint8_t track = itob(2);
    CdControlB(CdlPause, 0, 0);
    if (CdGetToc(cdda_toc) < 2) {
        MEDIA_STATUS = 0x4d454102;
        return;
    }
    CdControlB(CdlSetmode, &mode, 0);
    CdControl(CdlPlay, &track, 0);
    media_phase = 2;
    MEDIA_STATUS = 0x4d454122;
}
#endif

#ifdef PSX_FIXTURE_MULTIDISC
#define MULTIDISC_STATUS (*(volatile uint32_t *) 0x800ff004)
static char volume_label[33];
static uint32_t volume_descriptor[512] __attribute__((aligned(4)));

static void update_volume_label(void) {
    CdlLOC location;
    CdIntToPos(16, &location);
    if (!CdControl(CdlSetloc, &location, 0)) {
        volume_label[0] = 0;
        return;
    }
    CdRead(1, volume_descriptor, CdlModeSpeed);
    if (CdReadSync(0, 0) != 0) {
        volume_label[0] = 0;
        return;
    }
    const char *source = (const char *) volume_descriptor + 40;
    int length = 0;
    while (length < 32 && source[length] != ' ') {
        volume_label[length] = source[length];
        length++;
    }
    volume_label[length] = 0;
    volume_label[32] = 0;
    MULTIDISC_STATUS = volume_label[12] == 'D' && volume_label[13] == '2'
        ? 0x4d304402
        : 0x4d304401;
}
#endif

#ifdef PSX_FIXTURE_DYNAMIC_GEOMETRY
static int screen_width = SCREEN_WIDTH;

static void configure_environments(int width) {
    SetDefDispEnv(&display_environment[0], 0, 0, width, SCREEN_HEIGHT);
    SetDefDispEnv(&display_environment[1], 0, SCREEN_HEIGHT, width, SCREEN_HEIGHT);
    SetDefDrawEnv(&draw_environment[0], 0, SCREEN_HEIGHT, width, SCREEN_HEIGHT);
    SetDefDrawEnv(&draw_environment[1], 0, 0, width, SCREEN_HEIGHT);

    for (int index = 0; index < 2; index++) {
        setRGB0(&draw_environment[index], 16, 32, 64);
        draw_environment[index].isbg = 1;
    }
    screen_width = width;
}
#endif

static void initialize_video(void) {
    ResetGraph(0);
#ifdef PSX_FIXTURE_PAL
    SetVideoMode(MODE_PAL);
#endif

#ifdef PSX_FIXTURE_DYNAMIC_GEOMETRY
    configure_environments(SCREEN_WIDTH);
#else
    SetDefDispEnv(&display_environment[0], 0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
    SetDefDispEnv(&display_environment[1], 0, SCREEN_HEIGHT, SCREEN_WIDTH, SCREEN_HEIGHT);
    SetDefDrawEnv(&draw_environment[0], 0, SCREEN_HEIGHT, SCREEN_WIDTH, SCREEN_HEIGHT);
    SetDefDrawEnv(&draw_environment[1], 0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);

    for (int index = 0; index < 2; index++) {
        setRGB0(&draw_environment[index], 16, 32, 64);
        draw_environment[index].isbg = 1;
    }
#endif

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
#ifdef PSX_FIXTURE_MEDIA
    MEDIA_STATUS = 0x4d454100;
    SpuInit();
    if (!CdInit()) return;
    start_xa();
#else
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
#endif
}

static void initialize_probe_features(void) {
#ifdef PSX_FIXTURE_CARDS
    InitCard(1);
    StartCard();
#endif
#ifdef PSX_FIXTURE_MULTIDISC
    CdInit();
    update_volume_label();
#endif
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
#ifdef PSX_FIXTURE_DYNAMIC_GEOMETRY
    int next_width = ((frame / 120) & 1) == 0 ? 320 : 256;
    if (next_width != screen_width) configure_environments(next_width);
#endif
#ifdef PSX_FIXTURE_MEDIA
    if (frame == 360) start_cdda();
#endif
#ifdef PSX_FIXTURE_CARDS
    if (frame == 60) write_card_marker(0x00, 0x31);
    if (frame == 120) write_card_marker(0x10, 0x72);
#endif
#ifdef PSX_FIXTURE_MULTIDISC
    if ((frame % 30) == 0) update_volume_label();
#endif
    uint8_t red = (uint8_t) (16 + ((frame >> 1) & 31));
    uint8_t green = (buttons & PAD_CROSS) ? 112 : 32;
    uint8_t blue = (buttons & PAD_CIRCLE) ? 16 : 64;

#ifdef PSX_FIXTURE_MULTIDISC
    green = volume_label[12] == 'D' ? 96 : 32;
    blue = volume_label[12] == 'D' ? 24 : 96;
#endif

    setRGB0(&draw_environment[0], red, green, blue);
    setRGB0(&draw_environment[1], red, green, blue);

    FntPrint(-1, "PSX RUNTIME M0 FIXTURE\n\n");
    FntPrint(-1, "FRAME %08u\n", frame);
    FntPrint(-1, "BUTTONS %04x\n", buttons);
#ifdef PSX_FIXTURE_DYNAMIC_GEOMETRY
    FntPrint(-1, "VIDEO %dX240 " FIXTURE_REGION "\n", screen_width);
#else
    FntPrint(-1, "VIDEO 320X240 " FIXTURE_REGION "\n");
#endif
#ifdef PSX_FIXTURE_MEDIA
    FntPrint(-1, "MEDIA %s\n", media_phase == 2 ? "CDDA" : "XA");
#endif
#ifdef PSX_FIXTURE_MULTIDISC
    FntPrint(-1, "DISC %.16s\n", volume_label);
#endif
#ifdef PSX_FIXTURE_MEDIA
    FntPrint(-1, "AUDIO XA/CDDA\n");
#else
    FntPrint(-1, "AUDIO 22050HZ LOOP\n");
#endif
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
    initialize_probe_features();

    for (uint32_t frame = 0;; frame++) {
        present_frame(frame, read_buttons());
    }

    return 0;
}
