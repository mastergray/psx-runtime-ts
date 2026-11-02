/*
 * Minimal asynchronous controller SPI driver.
 * Copyright (C) 2021 spicyjpeg
 * Derived from the PSn00bSDK v0.19 pads example under MPL-2.0.
 * SPDX-License-Identifier: MPL-2.0
 */

#include "pad_spi.h"

#include <stdlib.h>
#include <string.h>

#include <hwregs_c.h>
#include <psxapi.h>
#include <psxetc.h>

typedef struct {
    uint8_t transmit[PAD_SPI_BUFFER_LENGTH];
    uint8_t receive[PAD_SPI_BUFFER_LENGTH];
    uint32_t transmit_length;
    uint32_t receive_length;
    uint32_t port;
    PadSpiCallback callback;
} PadSpiContext;

static volatile PadSpiContext context;
static volatile PadSpiRequest *volatile current_request;
static volatile PadSpiCallback default_callback;

static void create_poll_request(void) {
    PadRequest *request = (PadRequest *) context.transmit;
    request->addr = 0x01;
    request->cmd = PAD_CMD_READ;
    request->tap_mode = 0x00;
    request->motor_l = 0x00;
    request->motor_r = 0x00;
    context.transmit_length = 4;
    context.receive_length = 0;
    context.port ^= 1;
    context.callback = default_callback;
}

static void prepare_next_request(void) {
    memcpy(
        (void *) context.transmit,
        (const void *) current_request->data,
        current_request->length
    );
    context.transmit_length = current_request->length;
    context.receive_length = 0;
    context.port = current_request->port;
    context.callback = current_request->callback;

    PadSpiRequest *next = current_request->next;
    free((void *) current_request);
    current_request = next;
}

static void poll_interrupt(void) {
    if ((JOY_STAT & 0x0002) && context.receive_length)
        context.receive[context.receive_length - 1] = (uint8_t) JOY_TXRX;

    if (context.callback)
        context.callback(context.port, context.receive, context.receive_length);

    if (current_request)
        prepare_next_request();
    else
        create_poll_request();

    JOY_CTRL = 0x0010;
    for (uint32_t index = 0; index < 1000; index++)
        __asm__ volatile("");

    JOY_CTRL = 0x1003 | (context.port << 13);
    for (uint32_t index = 0; index < 2000; index++)
        __asm__ volatile("");

    JOY_TXRX = context.transmit[0];
}

static void acknowledge_interrupt(void) {
    while (JOY_STAT & 0x0080)
        __asm__ volatile("");

    JOY_CTRL = 0x1013 | (context.port << 13);
    if (!context.receive_length) {
        JOY_TXRX;
    } else if (context.receive_length <= PAD_SPI_BUFFER_LENGTH) {
        context.receive[context.receive_length - 1] = (uint8_t) JOY_TXRX;
    }

    context.receive_length++;
    if (context.receive_length < context.transmit_length)
        JOY_TXRX = context.transmit[context.receive_length];
    else
        JOY_TXRX = 0x00;
}

PadSpiRequest *pad_spi_create_request(void) {
    PadSpiRequest *request = malloc(sizeof(PadSpiRequest));
    if (!request) return 0;
    request->length = 0;
    request->port = 0;
    request->callback = 0;
    request->next = 0;

    if (!current_request) {
        current_request = request;
    } else {
        volatile PadSpiRequest *volatile last = current_request;
        while (last->next)
            last = last->next;
        last->next = request;
    }
    return request;
}

void pad_spi_initialize(PadSpiCallback callback) {
    EnterCriticalSection();
    ChangeClearRCnt(2, 0);
    InterruptCallback(6, &poll_interrupt);
    InterruptCallback(7, &acknowledge_interrupt);
    ExitCriticalSection();

    JOY_CTRL = 0x0040;
    JOY_MODE = 0x000d;
    JOY_BAUD = 0x0088;
    TIMER_CTRL(2) = 0x0258;
    TIMER_RELOAD(2) = (F_CPU / 8) / 250;
    current_request = 0;
    default_callback = callback;
}
