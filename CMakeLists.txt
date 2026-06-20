cmake_minimum_required(VERSION 3.18)
project(AudioBridge VERSION 4.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(ANDROID)
    set(CMAKE_ANDROID_API 28)
    set(CMAKE_ANDROID_STL c++_static)
endif()

find_library(OPUS_LIB opus PATHS ${CMAKE_SOURCE_DIR}/libs/${ANDROID_ABI})
find_path(OPUS_INCLUDE opus/opus.h PATHS ${CMAKE_SOURCE_DIR}/libs/${ANDROID_ABI}/include)
find_library(TINYALSA_LIB tinyalsa PATHS ${CMAKE_SOURCE_DIR}/libs/${ANDROID_ABI})
find_path(TINYALSA_INCLUDE tinyalsa/asoundlib.h PATHS ${CMAKE_SOURCE_DIR}/libs/${ANDROID_ABI}/include)

add_executable(audio-bridge
    jni/audio_bridge.cpp
)

target_include_directories(audio-bridge PRIVATE
    ${CMAKE_SOURCE_DIR}/jni
    ${OPUS_INCLUDE}
    ${TINYALSA_INCLUDE}
)

target_link_libraries(audio-bridge
    ${OPUS_LIB}
    ${TINYALSA_LIB}
    log
    pthread
)

target_compile_options(audio-bridge PRIVATE
    -O2 -fPIE -fstack-protector-strong -D_FORTIFY_SOURCE=2
)
set_target_properties(audio-bridge PROPERTIES
    LINK_FLAGS "-pie -Wl,-z,relro,-z,now -Wl,--gc-sections -Wl,--strip-all -Wl,-z,max-page-size=16384"
)
