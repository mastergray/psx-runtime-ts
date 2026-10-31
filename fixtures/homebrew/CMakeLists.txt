cmake_minimum_required(VERSION 3.20)

project(
    psx-runtime-m0-fixture
    LANGUAGES C CXX ASM
    VERSION 1.0.0
    DESCRIPTION "Redistributable PSX runtime acceptance fixture"
)

option(PSX_FIXTURE_PAL "Build the 50 Hz PAL fixture variant" OFF)

psn00bsdk_add_executable(m0-fixture STATIC main.c)

if(PSX_FIXTURE_PAL)
    target_compile_definitions(m0-fixture PRIVATE PSX_FIXTURE_PAL=1)
endif()
