cmake_minimum_required(VERSION 3.20)

project(
    psx-runtime-m0-fixture
    LANGUAGES C CXX ASM
    VERSION 1.0.0
    DESCRIPTION "Redistributable PSX runtime acceptance fixture"
)

psn00bsdk_add_executable(m0-fixture STATIC main.c)
