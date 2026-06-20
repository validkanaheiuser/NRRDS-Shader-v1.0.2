/**
 * Audio Bridge — Shared Header
 * Version: 4.0
 */

#ifndef AUDIO_BRIDGE_H
#define AUDIO_BRIDGE_H

#include <stdint.h>
#include <atomic>

// ── Version ───────────────────────────────────────────────────────────────────
#define VERSION_MAJOR 4
#define VERSION_MINOR 0
#define VERSION_PATCH 0

// ── Audio Configuration ───────────────────────────────────────────────────────
static const int SAMPLE_RATE    = 48000;
static const int CHANNELS       = 1;
static const int FRAME_MS       = 20;
static const int FRAME_SAMPLES  = (SAMPLE_RATE * FRAME_MS / 1000);  // 960
static const int FRAME_BYTES    = FRAME_SAMPLES * (int)sizeof(int16_t);
static const int MAX_PKT        = 4000;

// ── Frame Types ───────────────────────────────────────────────────────────────
enum FrameType : uint8_t {
    T_SPEAKER       = 0x01,  // Phone speaker audio → Server (Opus)
    T_VIRTUAL_MIC   = 0x02,  // Server → Phone mic injection (Opus)
    T_CONTROL       = 0x03,  // Control commands (JSON)
    T_CALL_STATUS   = 0x04,  // Call state updates (JSON)
    T_SMS           = 0x05,  // SMS events (JSON)
    T_PING          = 0x06,  // Keepalive ping
    T_PONG          = 0x07,  // Keepalive pong
    T_DEVICE_INFO   = 0x08,  // Device info on TCP connect (JSON)
    T_DEVICE_STATUS = 0x09,  // Device status on PING (JSON)
    T_ERROR         = 0xFF   // Error response
};

// ── Call States ───────────────────────────────────────────────────────────────
enum CallState : int {
    CALL_IDLE    = 0,
    CALL_RINGING = 1,
    CALL_OFFHOOK = 2,
    CALL_DIALING = 3,
    CALL_HOLDING = 4
};

// ── Logging ───────────────────────────────────────────────────────────────────
#ifdef ANDROID
#include <android/log.h>
#define LOG_TAG "AudioBridge"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN,  LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)
#define LOGD(...) __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, __VA_ARGS__)
#endif

#endif // AUDIO_BRIDGE_H
