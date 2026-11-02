#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

#include <hwregs_c.h>
#include <psxapi.h>
#include <psxcd.h>
#include <psxgpu.h>
#include <psxpad.h>
#include <psxspu.h>

#include "pad_spi.h"

#define SCREEN_WIDTH 320
#define SCREEN_HEIGHT 240
#define TONE_BLOCKS 32
#define TONE_BYTES (TONE_BLOCKS * 16)

typedef struct {
    uint8_t connected;
    uint8_t type;
    uint16_t buttons;
    uint8_t left_x;
    uint8_t left_y;
    uint8_t right_x;
    uint8_t right_y;
} PadState;

static DISPENV display_environment[2];
static DRAWENV draw_environment[2];
static volatile uint8_t pad_buffer[2][34];
static volatile size_t pad_buffer_length[2];
static volatile uint8_t pad_configuration_attempts[2];
static int active_buffer;

static uint8_t tone[TONE_BYTES] __attribute__((aligned(4)));
static uint32_t volume_descriptor[512] __attribute__((aligned(4)));
static uint16_t prior_buttons[2];
static int tone_mode;
static int diagnostic_audio;
static int audio_initialized;
static int last_port;
static const char *last_action = "NONE";

static void initialize_video(void) {
    ResetGraph(0);
    SetDefDispEnv(&display_environment[0], 0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
    SetDefDispEnv(&display_environment[1], 0, SCREEN_HEIGHT, SCREEN_WIDTH, SCREEN_HEIGHT);
    SetDefDrawEnv(&draw_environment[0], 0, SCREEN_HEIGHT, SCREEN_WIDTH, SCREEN_HEIGHT);
    SetDefDrawEnv(&draw_environment[1], 0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);

    for (int index = 0; index < 2; index++) {
        setRGB0(&draw_environment[index], 8, 18, 34);
        draw_environment[index].isbg = 1;
    }
    active_buffer = 0;
    PutDispEnv(&display_environment[active_buffer]);
    PutDrawEnv(&draw_environment[active_buffer]);
    FntLoad(960, 0);
    FntOpen(8, 8, 304, 224, 0, 512);
    SetDispMask(1);
}

static void send_pad_command(
    uint32_t port,
    PadCommand command,
    uint8_t first_argument,
    uint8_t second_argument,
    PadSpiCallback callback
) {
    PadSpiRequest *request = pad_spi_create_request();
    if (!request) return;
    request->length = 9;
    request->port = port;
    request->callback = callback;
    request->pad.addr = 0x01;
    request->pad.cmd = command;
    request->pad.tap_mode = 0x00;
    request->pad.motor_r = first_argument;
    request->pad.motor_l = second_argument;
    memset(
        request->pad.dummy,
        command == PAD_CMD_REQUEST_CONFIG ? 0xff : 0x00,
        sizeof(request->pad.dummy)
    );
}

static void finish_analog_configuration(
    uint32_t port,
    const volatile uint8_t *buffer,
    size_t length
) {
    const volatile PadResponse *pad = (const volatile PadResponse *) buffer;
    if (length < 2 || pad->prefix != 0x5a || pad->type != PAD_ID_CONFIG_MODE) {
        pad_configuration_attempts[port]++;
        return;
    }
    send_pad_command(port, PAD_CMD_CONFIG_MODE, 0x01, 0x00, 0);
    send_pad_command(port, PAD_CMD_SET_ANALOG, 0x01, 0x02, 0);
    send_pad_command(port, PAD_CMD_INIT_PRESSURE, 0x00, 0x00, 0);
    send_pad_command(port, PAD_CMD_REQUEST_CONFIG, 0x00, 0x01, 0);
    send_pad_command(port, PAD_CMD_RESPONSE_CONFIG, 0xff, 0xff, 0);
    send_pad_command(port, PAD_CMD_CONFIG_MODE, 0x00, 0x00, 0);
}

static void receive_pad(uint32_t port, const volatile uint8_t *buffer, size_t length) {
    if (port >= 2) return;
    size_t copy_length = length < sizeof(pad_buffer[port]) ? length : sizeof(pad_buffer[port]);
    if (copy_length)
        memcpy((void *) pad_buffer[port], (const void *) buffer, copy_length);
    pad_buffer_length[port] = copy_length;

    const volatile PadResponse *pad = (const volatile PadResponse *) buffer;
    if (
        length >= 2 &&
        (pad->prefix == 0x5a || pad->prefix == 0x00) &&
        pad->type == PAD_ID_DIGITAL
    ) {
        if (pad_configuration_attempts[port] < 3) {
            send_pad_command(port, PAD_CMD_CONFIG_MODE, 0x01, 0x00, 0);
            send_pad_command(port, PAD_CMD_READ, 0x00, 0x00, &finish_analog_configuration);
        }
    } else {
        pad_configuration_attempts[port] = 0;
    }
}

static void initialize_input(void) {
    pad_spi_initialize(&receive_pad);
}

static PadState read_pad(int port) {
    PadResponse pad_snapshot;
    memset(&pad_snapshot, 0, sizeof(pad_snapshot));
    size_t length = pad_buffer_length[port];
    if (length > sizeof(pad_snapshot)) length = sizeof(pad_snapshot);
    if (length)
        memcpy(&pad_snapshot, (const void *) pad_buffer[port], length);
    PadResponse *pad = &pad_snapshot;
    PadState state = {
        .connected = 0,
        .type = PAD_ID_NONE,
        .buttons = 0,
        .left_x = 128,
        .left_y = 128,
        .right_x = 128,
        .right_y = 128,
    };
    if (length < 4 || pad->prefix != 0x5a) return state;
    if (pad->type != PAD_ID_DIGITAL && pad->type != PAD_ID_ANALOG_STICK && pad->type != PAD_ID_ANALOG) return state;
    state.connected = 1;
    state.type = pad->type;
    state.buttons = (uint16_t) ~pad->btn;
    if (pad->type == PAD_ID_ANALOG_STICK || pad->type == PAD_ID_ANALOG) {
        state.left_x = pad->ls_x;
        state.left_y = pad->ls_y;
        state.right_x = pad->rs_x;
        state.right_y = pad->rs_y;
    }
    return state;
}

static const char *pad_type(const PadState *pad) {
    if (!pad->connected) return "NONE";
    if (pad->type == PAD_ID_DIGITAL) return "DIGITAL";
    if (pad->type == PAD_ID_ANALOG_STICK) return "ANALOG";
    return "DUALSHOCK";
}

static char mark(uint16_t buttons, uint16_t mask) {
    return (buttons & mask) ? 'X' : '-';
}

static void print_pad(int port, const PadState *pad) {
    uint16_t b = pad->buttons;
    FntPrint(-1, "P%d %-9s RAW %04X\n", port + 1, pad_type(pad), b);
    FntPrint(-1, " DPAD U%c D%c L%c R%c\n",
        mark(b, PAD_UP), mark(b, PAD_DOWN), mark(b, PAD_LEFT), mark(b, PAD_RIGHT));
    FntPrint(-1, " FACE T%c O%c X%c S%c\n",
        mark(b, PAD_TRIANGLE), mark(b, PAD_CIRCLE), mark(b, PAD_CROSS), mark(b, PAD_SQUARE));
    FntPrint(-1, " EDGE L1%c L2%c R1%c R2%c\n",
        mark(b, PAD_L1), mark(b, PAD_L2), mark(b, PAD_R1), mark(b, PAD_R2));
    FntPrint(-1, " META ST%c SE%c L3%c R3%c\n",
        mark(b, PAD_START), mark(b, PAD_SELECT), mark(b, PAD_L3), mark(b, PAD_R3));
    FntPrint(-1, " STICKS L %03u,%03u R %03u,%03u\n",
        pad->left_x, pad->left_y, pad->right_x, pad->right_y);
}

static const char *tone_name(void) {
    if (tone_mode == 1) return "STEREO";
    if (tone_mode == 2) return "LEFT";
    if (tone_mode == 3) return "RIGHT";
    return "STOPPED";
}

static void set_tone(int mode, int port, const char *action) {
    tone_mode = mode;
    last_port = port;
    last_action = action;
    if (mode == 0) {
        SpuSetKey(0, 1);
        return;
    }
    SPU_CH_VOL_L(0) = mode == 3 ? 0 : 0x1000;
    SPU_CH_VOL_R(0) = mode == 2 ? 0 : 0x1000;
    SpuSetKey(1, 1);
}

static void initialize_audio(void) {
    if (audio_initialized) return;
    for (int block = 0; block < TONE_BLOCKS; block++) {
        uint8_t *data = &tone[block * 16];
        data[0] = 0x00;
        data[1] = block == 0 ? 0x04 : (block == TONE_BLOCKS - 1 ? 0x03 : 0x00);
        for (int index = 2; index < 16; index++) data[index] = block & 1 ? 0x77 : 0x99;
    }
    SpuInit();
    SpuSetTransferMode(SPU_TRANSFER_BY_DMA);
    SpuSetTransferStartAddr(0x1010);
    SpuWrite(tone, sizeof(tone));
    SpuWait();
    SPU_CH_FREQ(0) = 0x0800;
    SPU_CH_ADDR(0) = 0x0202;
    SPU_CH_ADSR(0) = 0x1fee80ff;
    audio_initialized = 1;
    set_tone(0, 0, "BOOT");
}

static void update_diagnostic_mode(void) {
    CdlLOC location;
    CdIntToPos(16, &location);
    if (!CdControl(CdlSetloc, &location, 0)) return;
    CdRead(1, volume_descriptor, CdlModeSpeed);
    if (CdReadSync(0, 0) != 0) return;
    const char *volume = (const char *) volume_descriptor + 40;
    const int next_audio = volume[12] == 'A';
    if (next_audio == diagnostic_audio) return;
    if (next_audio) {
        diagnostic_audio = 1;
        initialize_audio();
        last_port = 0;
        last_action = "DISC CHANGE";
    } else {
        if (audio_initialized) set_tone(0, 0, "DISC CHANGE");
        diagnostic_audio = 0;
    }
}

static void audio_controls(int port, const PadState *pad) {
    uint16_t pressed = pad->buttons & (uint16_t) ~prior_buttons[port];
    prior_buttons[port] = pad->buttons;
    if (pressed & PAD_SELECT) set_tone(0, port + 1, "STOP");
    else if (pressed & PAD_START) set_tone(1, port + 1, "START");
    else if (pressed & PAD_CROSS) set_tone(tone_mode == 0 ? 1 : 0, port + 1, "TOGGLE");
    else if (pressed & PAD_SQUARE) set_tone(2, port + 1, "LEFT");
    else if (pressed & PAD_CIRCLE) set_tone(3, port + 1, "RIGHT");
    else if (pressed & PAD_TRIANGLE) set_tone(1, port + 1, "STEREO");
}

static void present_frame(uint32_t frame, const PadState *one, const PadState *two) {
    setRGB0(&draw_environment[0], 8 + ((frame >> 2) & 7), 18, 34);
    setRGB0(&draw_environment[1], 8 + ((frame >> 2) & 7), 18, 34);
    if (diagnostic_audio) {
        FntPrint(-1, "PSX RUNTIME AUDIO TEST\n");
        FntPrint(-1, "STARTS SILENT - BOTH PORTS CONTROL\n\n");
        FntPrint(-1, "P1 %-9s %04X  P2 %-9s %04X\n",
            pad_type(one), one->buttons, pad_type(two), two->buttons);
        FntPrint(-1, "TONE %-7s LAST P%d %s\n\n", tone_name(), last_port, last_action);
        FntPrint(-1, "START       START STEREO\n");
        FntPrint(-1, "SELECT      STOP\n");
        FntPrint(-1, "CROSS       TOGGLE\n");
        FntPrint(-1, "SQUARE      LEFT ONLY\n");
        FntPrint(-1, "CIRCLE      RIGHT ONLY\n");
        FntPrint(-1, "TRIANGLE    STEREO\n\n");
        FntPrint(-1, "Use either keyboard map or gamepad.\n");
        FntPrint(-1, "FRAME %08u\n", frame);
    } else {
        FntPrint(-1, "PSX RUNTIME CONTROLLER TEST\n");
        FntPrint(-1, "X = PRESSED, AXES CENTER AT 128\n\n");
        print_pad(0, one);
        FntPrint(-1, "\n");
        print_pad(1, two);
        FntPrint(-1, "\nFRAME %08u\n", frame);
    }
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
    CdInit();
    update_diagnostic_mode();
    for (uint32_t frame = 0;; frame++) {
        PadState one = read_pad(0);
        PadState two = read_pad(1);
        if ((frame % 30) == 0) update_diagnostic_mode();
        if (diagnostic_audio) {
            audio_controls(0, &one);
            audio_controls(1, &two);
        }
        present_frame(frame, &one, &two);
    }
    return 0;
}
