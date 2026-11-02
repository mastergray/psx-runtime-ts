/*
 * Minimal PSn00bSDK controller SPI driver interface.
 * Copyright (C) 2021 spicyjpeg
 * Derived from the PSn00bSDK v0.19 pads example under MPL-2.0.
 * SPDX-License-Identifier: MPL-2.0
 */

#ifndef PSX_RUNTIME_PAD_SPI_H
#define PSX_RUNTIME_PAD_SPI_H

#include <stddef.h>
#include <stdint.h>

#include <psxpad.h>

#define PAD_SPI_BUFFER_LENGTH 140

typedef void (*PadSpiCallback)(uint32_t port, const volatile uint8_t *buffer, size_t length);

typedef struct PadSpiRequest {
    union {
        uint8_t data[PAD_SPI_BUFFER_LENGTH];
        PadRequest pad;
    };
    uint32_t length;
    uint32_t port;
    PadSpiCallback callback;
    struct PadSpiRequest *next;
} PadSpiRequest;

PadSpiRequest *pad_spi_create_request(void);
void pad_spi_initialize(PadSpiCallback callback);

#endif
