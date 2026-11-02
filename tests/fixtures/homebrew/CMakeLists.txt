cmake_minimum_required(VERSION 3.20)

project(
    psx-runtime-m0-fixture
    LANGUAGES C CXX ASM
    VERSION 1.0.0
    DESCRIPTION "Redistributable PSX runtime acceptance fixture"
)

option(PSX_FIXTURE_PAL "Build the 50 Hz PAL fixture variant" OFF)
option(PSX_FIXTURE_DYNAMIC_GEOMETRY "Alternate display widths while running" OFF)
option(PSX_FIXTURE_MEDIA "Exercise XA and CD-DA playback" OFF)
option(PSX_FIXTURE_CARDS "Write deterministic markers to both memory cards" OFF)
option(PSX_FIXTURE_MULTIDISC "Poll and display the mounted disc label" OFF)

psn00bsdk_add_executable(m0-fixture STATIC main.c)
psn00bsdk_add_executable(controller-test STATIC diagnostic.c)
psn00bsdk_add_executable(audio-test STATIC diagnostic.c)
target_sources(controller-test PRIVATE pad_spi.c)
target_sources(audio-test PRIVATE pad_spi.c)

if(PSX_FIXTURE_PAL)
    target_compile_definitions(m0-fixture PRIVATE PSX_FIXTURE_PAL=1)
endif()

if(PSX_FIXTURE_DYNAMIC_GEOMETRY)
    target_compile_definitions(m0-fixture PRIVATE PSX_FIXTURE_DYNAMIC_GEOMETRY=1)
endif()

if(PSX_FIXTURE_MEDIA)
    target_compile_definitions(m0-fixture PRIVATE PSX_FIXTURE_MEDIA=1)
endif()

if(PSX_FIXTURE_CARDS)
    target_compile_definitions(m0-fixture PRIVATE PSX_FIXTURE_CARDS=1)
endif()

if(PSX_FIXTURE_MULTIDISC)
    target_compile_definitions(m0-fixture PRIVATE PSX_FIXTURE_MULTIDISC=1)
endif()
