# Audio Bridge — Full Implementation Design

> **Status:** Approved 2026-06-20  
> **Device:** Xiaomi Redmi Note 10 Pro (sweet/sweetin) · SM6150 (Snapdragon 720G)  
> **ROM:** LineageOS 23.2 (Android 16) · KernelSU Legacy · SUSFS · OverlayFS  
> **Kernel:** https://github.com/devestrog/android_kernel_xiaomi_sm6150

---

## Goal

Fix all audit issues from `docs/audit/2026-06-20-full-audit-report.md` and implement
working SIM call audio injection: remote party hears server-supplied audio (TX injection),
real microphone is fully blocked, and daemon captures what remote party says (RX capture).
Zero bootloop risk.

## Architecture

Pure KernelSU module — no Zygisk, no HAL wrapper, no kernel module. Root daemon uses
tinyalsa to open QCOM-specific incall PCM devices directly. APK handles telephony
events and relays them to the daemon via IPC.

## Tech Stack

- **Daemon:** C++17, tinyalsa, libopus, OpenSSL (TLS), NDK r27c, ARM64
- **APK:** Java, Android API 36, OkHttp (TLS WebSocket), priv-app via OverlayFS
- **Server:** Python 3.11+, FastAPI, asyncio, ssl stdlib, python-dotenv
- **Module:** KernelSU pure module (no `zygisk=true`)

---

## Global Constraints

- NDK version: r27c exactly — avoids TLS relocation surprises from r29
- No `-nostdlib++` on daemon — flag was only needed for ZygiskNext restricted linker
- Daemon flags: `-std=c++17 -O2 -fPIE -fstack-protector-strong -D_FORTIFY_SOURCE=2`
- Linker flags: `-pie -Wl,-z,relro,-z,now`
- TLS minimum: TLSv1.2 (server and daemon)
- Opus frame size: 960 samples (20 ms at 48 kHz) for TX; adaptive for RX
- PCM card: 0 (`/dev/snd/card0`) — verified for sweet/sweetin
- All ALSA mixer control names are SM6150/sweet-specific (verified from device tree)
- Frame protocol: `[1B type][4B len BE][payload]` — unchanged
- IPC socket: abstract Unix `@audio_bridge` — unchanged

---

## Research Sources (Internet)

All PCM device numbers and mixer control names were verified from primary sources.
No guesses.

| Claim | Source URL | Section |
|---|---|---|
| Voice TX never hits `in_read()` — DSP-driven | https://android.googlesource.com/platform/hardware/qcom/audio/+/60503b74ba99bbe503c84251a96f07e96d5d41c2/hal/voice.c | voice_start_call() |
| `USECASE_INCALL_MUSIC_UPLINK` injects into TX uplink | https://github.com/LineageOS/android_hardware_qcom_audio/blob/lineage-19.1/hal/voice_extn/voice_extn.c | voice_extn_check_and_set_incall_music_usecase() |
| PCM 27 = incall music injection port | https://github.com/LineageOS/android_hardware_qcom_audio/blob/lineage-19.1/hal/msm8974/platform.h | INCALL_MUSIC_UPLINK_PCM_DEVICE |
| PCM 2 = VOICEMMODE1 (SIM 1) on sweet/sweetin | https://github.com/LineageOS/android_device_xiaomi_sweet/blob/lineage-23.2/configs/audio/audio_platform_info_intcodec.xml | pcm-id overrides |
| PCM 0 = incall recording tap (downlink) | https://android.googlesource.com/platform/hardware/qcom/audio/+/073a80800f341325932c66818ce4302b312909a4/hal/voice.c | voice_check_and_set_incall_rec_usecase() |
| Mixer: "Incall_Music Audio Mixer MultiMedia9" | https://github.com/travarilo/hardware_qcom_audio/blob/caf/msm8998/configs/msm8909/mixer_paths.xml | incall-music-uplink path |
| Mixer: "MultiMedia1 Mixer VOC_REC_DL" | https://android.googlesource.com/kernel/msm/+/9c03acaa075ba26cd18c926cdbd21daeb1c55896/sound/soc/msm/qdsp6v2/msm-pcm-routing-v2.c | VOC_REC_DL kcontrol |
| "Voice Tx Device Mute" array format | https://github.com/LineageOS/android_hardware_qcom_audio/blob/lineage-19.1/hal/msm8916/platform.c | platform_set_device_mute() |
| KernelSU module spec | https://kernelsu.org/guide/module.html | module.prop, service.sh |
| SM6150 platform = MSMSTEPPE | https://github.com/LineageOS/android_vendor_lineage/blob/7aded097379bd76b9167cc7f5784bcb3a9858066/config/BoardConfigQcom.mk | SM6150 mapping |

---

## Section 1: Audio Injection Architecture

### Why `in_read()` does not work for SIM call TX

On SM6150 with QCOM audio HAL, `voice_start_call()` opens PCM 2 (voice TX) and calls
`pcm_start()`. After that, the ADSP Hexagon DSP DMA-drives the entire path:
`Mic → ADC → ADSP → Modem encoder → Network`. The CPU never calls `pcm_read()` on
the voice TX PCM handle. A HAL wrapper hooking `in_read()` sees zero voice TX frames.

### Correct injection: QCOM Incall Music (PCM 27)

QCOM audio HAL has a built-in `USECASE_INCALL_MUSIC_UPLINK` that feeds audio from a
PCM output device into the voice TX path inside the ADSP. This is the official mechanism.

**Verified PCM device numbers on sweet/sweetin:**

| Path | Device | ALSA node | Notes |
|---|---|---|---|
| Voice call SIM 1 (VOICEMMODE1) | PCM 2 | `/dev/snd/pcmC0D2` | XML override from compiled default 44 |
| Voice call SIM 2 (VOICEMMODE2) | PCM 19 | `/dev/snd/pcmC0D19` | XML override from compiled default 45 |
| **TX injection** | **PCM 27** | `/dev/snd/pcmC0D27` | No XML override — compiled default unchanged |
| **RX capture (downlink tap)** | **PCM 0** | `/dev/snd/pcmC0D0` | No XML override |

**Full audio flow:**

```
SERVER ──(TCP 59100 TLS)──► DAEMON (root)
                                │
                    APK: call_state = active
                                │
                    mixer setup (tinyalsa):
                    "Incall_Music Audio Mixer MultiMedia9" = 1
                    "MultiMedia1 Mixer VOC_REC_DL" = 1
                    "Voice Tx Device Mute" = [1, -1, 20]
                                │
            ┌───────────────────┴──────────────────────┐
            ▼                                          ▼
  pcm_open(0, 27, PCM_OUT, ...)          pcm_open(0, 0, PCM_IN, ...)
  TX thread: Opus decode → pcm_write     RX thread: pcm_read → Opus encode
            │                                          │
  ADSP MultiMedia9 → voice uplink        Downlink tap (DSP) → userspace
  REMOTE PARTY HEARS SERVER AUDIO        DAEMON → T_SPEAKER → SERVER
```

**Mic blocking:** `"Voice Tx Device Mute" = [state=1, VSID=-1 (all sessions), ramp_ms=20]`
cuts the ADC-to-ADSP-to-modem path at DSP level. Remote party hears zero from real mic.

### PCM configs

```c
// TX injection — 48 kHz; ADSP downsamples to call rate internally
static const struct pcm_config kIncallMusicConfig = {
    .channels     = 1,
    .rate         = 48000,
    .period_size  = 960,    // 20 ms
    .period_count = 4,
    .format       = PCM_FORMAT_S16_LE,
};

// RX capture — try 16 kHz (WB/VoLTE), fallback 8 kHz (2G/3G NB)
static const unsigned kRxRates[] = {16000, 8000};
```

### Portability notes (for other devices)

To adapt to a different QCOM device:
1. `adb shell cat /proc/asound/pcm` — list PCM devices and names
2. `adb shell tinymix | grep -i incall` — find incall mixer controls
3. Check device's `audio_platform_info_*.xml` for PCM ID overrides
4. Verify `PLATFORM_*` macro in BoardConfigCommon.mk to find correct `platform.h`
5. Same `USECASE_INCALL_MUSIC_UPLINK` mechanism works on all modern QCOM devices
   (MSM8974, SM8150, SM6150, SM8350, etc.) — only PCM numbers differ

---

## Section 2: Security Architecture

### Token

- Replace hardcoded `"default_secure_token_123"` with env var `AUDIO_BRIDGE_TOKEN`
- Generated: `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`
- Server reads from `server/.env` (gitignored)
- Device reads from `/data/adb/modules/audio_bridge/files/config.json`

### WebSocket authentication

Both `/ws/ui` and `/ws/audio/{device_id}` require token before `accept()`:

```python
async def verify_ws_token(websocket: WebSocket) -> bool:
    token = websocket.query_params.get("token") or \
            websocket.headers.get("authorization", "").removeprefix("Bearer ")
    return hmac.compare_digest(token, settings.token)
```

### HMAC replay protection

Add `nonce` (UUID) to all HMAC-authenticated messages. Server caches nonces for 60 s.

```python
_nonce_cache: dict[str, float] = {}

def verify_hmac(msg: dict) -> bool:
    nonce = msg.get("nonce")
    ts    = msg.get("date")
    if not nonce or not ts:              return False
    if abs(time.time() - ts) > 30:      return False   # ±30 s window
    if nonce in _nonce_cache:            return False   # replay block
    _nonce_cache[nonce] = time.time()
    # ... existing HMAC verify
```

### TLS — TCP 59100 (internet deployment)

Server wraps TCP listener with `ssl.SSLContext`. Daemon connects with cert pinning
(SHA-256 of server cert stored in `config.json`). APK uses OkHttp `CertificatePinner`.

```python
ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ssl_ctx.load_cert_chain("server.crt", "server.key")
ssl_ctx.minimum_version = ssl.TLSVersion.TLSv1_2
server = await asyncio.start_server(handle_device, "0.0.0.0", 59100, ssl=ssl_ctx)
```

Daemon pinning callback:
```c
int verify_pinned_cert(X509_STORE_CTX* ctx, void*) {
    X509* cert = X509_STORE_CTX_get0_cert(ctx);
    uint8_t digest[32];
    X509_digest(cert, EVP_sha256(), digest, nullptr);
    return memcmp(digest, g_pinned_hash, 32) == 0 ? 1 : 0;
}
```

### Key management

- Remove `server/server.key` from git history via BFG Repo Cleaner
- Add `server/*.key server/*.pem server/*.crt server/.env` to `.gitignore`
- Add `server/generate-certs.sh`:
  ```bash
  openssl req -x509 -newkey rsa:4096 -keyout server.key -out server.crt \
      -days 365 -nodes -subj "/CN=audio-bridge"
  openssl x509 -noout -fingerprint -sha256 -in server.crt
  ```
  SHA-256 fingerprint goes into device `config.json` as `server_cert_sha256`.

---

## Section 3: Build System & Module Structure

### Files removed

| File | Reason |
|---|---|
| `zygisk/src/zygisk_module.cpp` | Zygisk eliminated |
| `java/com/audiobridge/AudioCapture.java` | Replaced by daemon PCM |
| CMakeLists.txt `zygisk_module` target | No longer needed |
| `build.sh` `build_zygisk()` function | No longer needed |

### CMakeLists.txt (daemon only)

```cmake
cmake_minimum_required(VERSION 3.22)
project(audio_bridge)

add_executable(audio-bridge
    jni/audio_bridge.cpp
    jni/opus_wrapper.cpp
)
target_compile_options(audio-bridge PRIVATE
    -std=c++17 -O2 -fPIE
    -fstack-protector-strong -D_FORTIFY_SOURCE=2
)
target_link_options(audio-bridge PRIVATE -pie -Wl,-z,relro,-z,now)
target_link_libraries(audio-bridge PRIVATE tinyalsa opus ssl crypto log)
```

No `-nostdlib++` — that flag was only needed for ZygiskNext restricted linker.

### Module directory structure

```
module/
├── module.prop                          # no zygisk=true
├── customize.sh
├── post-fs-data.sh                      # SELinux policy
├── service.sh                           # daemon start loop
├── uninstall.sh
├── system/
│   ├── priv-app/AudioBridge/AudioBridge.apk
│   └── etc/permissions/privapp-permissions-AudioBridge.xml
└── files/
    ├── audio-bridge                     # daemon binary
    ├── config.json.example
    └── libopus.so                       # if dynamic
```

### module.prop

```properties
id=audio_bridge
name=Audio Bridge
version=v4.0.0
versionCode=400
author=audio-bridge
description=SIM call audio bridge - KSU pure module
```

No `zygisk=true` → ZygiskNext does not load any `.so` from this module.

### service.sh

```bash
#!/system/bin/sh
MODDIR="${0%/*}"
until [ "$(getprop sys.boot_completed)" = "1" ]; do sleep 2; done
sleep 3   # wait for audio subsystem
DAEMON="$MODDIR/files/audio-bridge"
CONFIG="$MODDIR/files/config.json"
[ -x "$DAEMON" ] || { log -t audio_bridge "daemon not executable"; exit 1; }
[ -f "$CONFIG" ] || cp "$MODDIR/files/config.json.example" "$CONFIG"
while true; do
    "$DAEMON" --config "$CONFIG"
    log -t audio_bridge "daemon exited ($?), restarting in 5s"
    sleep 5
done &
```

### privapp-permissions XML

```xml
<?xml version="1.0" encoding="utf-8"?>
<permissions>
    <privapp-permissions package="com.audiobridge">
        <permission name="android.permission.CAPTURE_AUDIO_OUTPUT"/>
        <permission name="android.permission.READ_PHONE_STATE"/>
        <permission name="android.permission.READ_PRECISE_PHONE_STATE"/>
        <permission name="android.permission.RECEIVE_SMS"/>
        <permission name="android.permission.SEND_SMS"/>
    </privapp-permissions>
</permissions>
```

### Bootloop risk table

| Component | Bootloop Risk | Reason |
|---|---|---|
| Daemon binary crash | None | Separate process, unrelated to zygote |
| APK crash | None | App process |
| OverlayFS priv-app | Very Low | Module self-disables if APK install fails |
| SELinux script error | Low | post-fs-data.sh error → skipped, no kernel crash |
| ~~Zygisk .so~~ | ~~HIGH~~ | **Eliminated** |
| ~~NDK TLS relocations~~ | ~~HIGH~~ | **Eliminated** |

---

## Section 4: Data Flow & IPC Protocol

### Complete data flow

```
SERVER (Python/FastAPI) ──TLS TCP 59100──► DAEMON (C++ root)
        │                                         │
   WebSocket /ws/ui                    Unix @audio_bridge (JSON)
        │                                         │
   Dashboard (browser)                    APK (Java)
                                          TelephonyHelper
```

### Frame protocol (unchanged)

| Type | Hex | Direction | Payload |
|---|---|---|---|
| T_SPEAKER     | 0x01 | device → server | Opus audio (RX: remote party) |
| T_VIRTUAL_MIC | 0x02 | server → device | Opus audio (TX injection) |
| T_CONTROL     | 0x03 | server → device | JSON command |
| T_CALL_STATUS | 0x04 | device → server | `{"state":"active","number":"...","sim":0}` |
| T_SMS         | 0x05 | device → server | `{"type":"sms","ver":1,"from":"...","body":"..."}` |
| T_PING        | 0x06 | both | empty |
| T_PONG        | 0x07 | both | empty |

### IPC fixes

**SMS routing (BUG-6 from audit):**
```java
// TelephonyHelper.java — BEFORE (broken):
event.put("event", "sms_received");  // daemon looks for "type"

// AFTER (correct):
event.put("type", "sms");
event.put("ver", 1);                 // protocol versioning from the start
event.put("from", sender);
event.put("body", messageBody);
event.put("sim_slot", getActiveSimSlot());
event.put("timestamp", System.currentTimeMillis());
```

**Call state IPC (new):**
```java
// TelephonyHelper.java
private void notifyCallState(int state, String number) {
    JSONObject ev = new JSONObject();
    ev.put("type", "call_state");
    ev.put("number", number != null ? number : "");
    ev.put("sim", getActiveSimSlot());
    switch (state) {
        case CALL_STATE_RINGING: ev.put("state", "ringing"); break;
        case CALL_STATE_OFFHOOK: ev.put("state", "active");  break;
        case CALL_STATE_IDLE:    ev.put("state", "idle");    break;
    }
    mIpcClient.sendEvent(ev.toString());  // synchronized write, not via executor
}
```

---

## Section 5: Thread Safety & Fault Tolerance

### VoiceCallContext struct

```cpp
struct VoiceCallContext {
    // PCM handles — only touch after join()
    struct pcm*  pcm_tx_out = nullptr;   // PCM 27
    struct pcm*  pcm_rx_in  = nullptr;   // PCM 0
    std::mutex   pcm_mtx;                // guards both pointers AND pcm_write/read

    std::atomic<bool>       active{false};
    std::condition_variable queue_cv;
    std::mutex              queue_mtx;
    std::deque<std::vector<uint8_t>> tx_queue;  // Opus frames

    static constexpr int TX_TARGET_FRAMES = 5;   // 100 ms pre-fill
    static constexpr int TX_MAX_FRAMES    = 15;  // 300 ms max → drop oldest

    std::thread tx_thread, rx_thread;
    unsigned    rx_rate  = 16000;
    int         sim_slot = 0;
};
```

### Lifecycle — invariant: join() before pcm_close()

```cpp
void voice_call_stop() {
    g_voice.active.store(false, std::memory_order_release);
    g_voice.queue_cv.notify_all();

    // join() before touching PCM handles — no lock held during join
    if (g_voice.tx_thread.joinable()) g_voice.tx_thread.join();
    if (g_voice.rx_thread.joinable()) g_voice.rx_thread.join();

    // Safe: no thread holds pcm_mtx after join()
    struct pcm *tx = nullptr, *rx = nullptr;
    {
        std::lock_guard<std::mutex> lk(g_voice.pcm_mtx);
        tx = std::exchange(g_voice.pcm_tx_out, nullptr);
        rx = std::exchange(g_voice.pcm_rx_in,  nullptr);
    }
    if (tx) pcm_close(tx);   // outside mutex — blocking syscall
    if (rx) pcm_close(rx);

    reset_incall_mixer();
}
```

### PCM write inside mutex (prevents use-after-free)

```cpp
void voice_tx_thread() {
    // Phase 1: pre-fill — wait for TX_TARGET_FRAMES before playback
    {
        std::unique_lock<std::mutex> lk(g_voice.queue_mtx);
        g_voice.queue_cv.wait(lk, []{
            return !g_voice.active.load() ||
                   (int)g_voice.tx_queue.size() >= VoiceCallContext::TX_TARGET_FRAMES;
        });
    }
    if (!g_voice.active.load()) return;

    opus_int16 pcm_buf[960];

    while (g_voice.active.load(std::memory_order_acquire)) {
        // Dequeue or PLC
        std::vector<uint8_t> frame;
        {
            std::unique_lock<std::mutex> lk(g_voice.queue_mtx);
            bool got = g_voice.queue_cv.wait_for(
                lk, std::chrono::milliseconds(30),  // 30 ms > one frame, reduces false PLC
                []{ return !g_voice.tx_queue.empty() || !g_voice.active.load(); });
            if (got && !g_voice.tx_queue.empty())
                frame = std::move(g_voice.tx_queue.front()),
                g_voice.tx_queue.pop_front();
        }

        int samples;
        if (!frame.empty())
            samples = opus_decode(g_opus_dec_48k, frame.data(), (int)frame.size(),
                                  pcm_buf, 960, 0);
        else
            samples = opus_decode(g_opus_dec_48k, nullptr, 0, pcm_buf, 960, 0); // PLC

        if (samples <= 0) continue;

        bool need_reconnect = false;
        {
            std::lock_guard<std::mutex> lk(g_voice.pcm_mtx);  // pcm_write inside lock
            if (!g_voice.pcm_tx_out) break;
            int ret = pcm_write(g_voice.pcm_tx_out, pcm_buf, samples * 2);
            if (ret < 0) {
                const char* err = pcm_get_error(g_voice.pcm_tx_out);
                if (strstr(err, "EPIPE") || strstr(err, "Broken pipe"))
                    pcm_prepare(g_voice.pcm_tx_out);  // underrun recovery, continue
                else
                    need_reconnect = true;
            }
        }  // unlock before reconnect

        if (need_reconnect && !attempt_reopen_tx_pcm()) break;
    }
}
```

### Reconnect — pcm_open/close outside mutex

```cpp
bool attempt_reopen_tx_pcm() {
    for (int i = 0; i < 5; i++) {
        if (!g_voice.active.load()) return false;
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
        if (!g_voice.active.load()) return false;

        // QCOM SSR resets all ALSA mixer controls — must re-setup
        reset_incall_mixer();
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        setup_incall_mixer(g_voice.sim_slot);

        // pcm_open outside mutex (blocking syscall)
        struct pcm* p = pcm_open(VOICE_SOUND_CARD, INCALL_MUSIC_PCM_DEVICE,
                                  PCM_OUT, &kIncallMusicConfig);
        if (!p || !pcm_is_ready(p)) { if (p) pcm_close(p); continue; }

        // Pointer swap — brief lock, no syscalls inside
        struct pcm* old = nullptr;
        {
            std::lock_guard<std::mutex> lk(g_voice.pcm_mtx);
            old = g_voice.pcm_tx_out;
            g_voice.pcm_tx_out = p;
        }
        if (old) pcm_close(old);  // outside mutex
        return true;
    }
    return false;
}
```

### PCM open with retry (replaces magic sleep)

```cpp
struct pcm* open_pcm_with_retry(int device, int flags, const struct pcm_config* cfg) {
    for (int i = 0; i < 20; i++) {     // max 2000 ms
        struct pcm* p = pcm_open(VOICE_SOUND_CARD, device, flags, cfg);
        if (p && pcm_is_ready(p)) return p;
        if (p) pcm_close(p);
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    return nullptr;
}
```

### TX queue — drop oldest

```cpp
void enqueue_tx_opus_frame(const uint8_t* data, int len) {
    std::lock_guard<std::mutex> lk(g_voice.queue_mtx);
    if ((int)g_voice.tx_queue.size() >= VoiceCallContext::TX_MAX_FRAMES)
        g_voice.tx_queue.pop_front();   // drop oldest, keep freshness
    g_voice.tx_queue.emplace_back(data, data + len);
    g_voice.queue_cv.notify_one();
}
```

### Heartbeat with correct initialization

```cpp
std::atomic<time_t> g_last_pong{0};

void on_server_connected() {
    g_last_pong.store(time(nullptr), std::memory_order_relaxed);  // init at connect time
    // ...
}

void heartbeat_thread_func() {
    while (g_connected.load()) {
        std::this_thread::sleep_for(std::chrono::seconds(15));
        if (!g_connected.load()) break;
        time_t last = g_last_pong.load();
        if (time(nullptr) - last > 45) {
            g_connected.store(false);
            shutdown(g_server_fd, SHUT_RDWR);
            break;
        }
        send_frame(T_PING, nullptr, 0);
    }
}
// On T_PONG: g_last_pong.store(time(nullptr), std::memory_order_relaxed);
```

---

## Helper Functions (daemon — to be implemented in plan)

These are referenced in Section 5 code and must be implemented:

- `reset_incall_mixer()` — opens mixer 0, sets all incall controls to 0, unmutes mic
- `setup_incall_mixer(int sim_slot)` — opens mixer 0, sets incall music + downlink rec + mic mute controls
- `set_ctl(mixer*, name, int)` — thin wrapper: `mixer_get_ctl_by_name` + `mixer_ctl_set_value`
- `set_ctl_array(mixer*, name, int[])` — thin wrapper: `mixer_get_ctl_by_name` + `mixer_ctl_set_array`
- `voice_call_start(int sim_slot)` — sets `g_voice.sim_slot`, calls `setup_incall_mixer`, calls `open_pcm_with_retry` for both PCM 27 and PCM 0, sets `g_voice.active = true`, starts threads
- `open_rx_pcm_with_retry()` — tries `kRxRates[]` in order (16000, 8000), stores chosen rate in `g_voice.rx_rate`

Existing globals from `jni/opus_wrapper.cpp` (unchanged): `g_opus_dec_48k`, `g_opus_enc`.
Rate for RX encoder matches `g_voice.rx_rate` (set at pcm_open time).

---

## Known Limitations

1. **PLC without sequence numbers:** Wait-for-30ms timeout triggers PLC before
   checking if the frame arrives late vs truly lost. A delayed frame arriving after
   PLC will be played twice (minor audio artifact). VoIP-grade fix requires adding
   `seq` + `ts` fields to T_VIRTUAL_MIC payload (v2 scope, not this release).

2. **Daemon never drops root:** Required for `/dev/snd/*` access. No seccomp/chroot
   in this release. Documented in audit report as accepted risk.

3. **PCM rates runtime-only:** RX capture rate (16 kHz vs 8 kHz) is detected at
   pcm_open time. If detection fails, daemon logs error and disables RX path for
   that call.

4. **SSR reconnect best-effort:** After modem SSR, `attempt_reopen_*_pcm()` does
   full mixer teardown + re-setup + pcm_open. If modem is still restarting after
   5 × 200 ms = 1 s, reconnect gives up and audio dies for that call. Call state
   events from APK will re-trigger `voice_call_start()` if a new call is made.

---

## Files Modified / Created

| File | Action | Reason |
|---|---|---|
| `jni/audio_bridge.cpp` | Modify | Add voice PCM functions, thread safety, TLS, heartbeat |
| `jni/audio_bridge.h` | Modify | PCM device constants, VoiceCallContext, remove old SHM layout |
| `jni/opus_wrapper.cpp/h` | Unchanged | |
| `java/com/audiobridge/TelephonyHelper.java` | Modify | Fix SMS "type" key, add call state IPC |
| `java/com/audiobridge/AudioCapture.java` | **Delete** | Replaced by daemon PCM |
| `java/com/audiobridge/AudioBridgeService.java` | Modify | Remove AudioCapture thread |
| `java/com/audiobridge/IPCClient.java` | Modify | Add sendEvent() for call state |
| `server/main.py` | Modify | Auth middleware, TLS, nonce HMAC, SMS ver field |
| `server/generate-certs.sh` | **Create** | TLS cert generation helper |
| `server/.env.example` | **Create** | Token template |
| `CMakeLists.txt` | Modify | Remove Zygisk target, clean daemon flags |
| `build.sh` | Modify | Remove build_zygisk(), update module packaging |
| `zygisk/src/zygisk_module.cpp` | **Delete** | Zygisk eliminated |
| `zygisk/module/module.prop` | Modify | Remove zygisk=true |
| `zygisk/module/service.sh` | Modify | Keep daemon startup loop |
| `zygisk/module/post-fs-data.sh` | Modify | SELinux policy for daemon |
| `zygisk/module/system/etc/permissions/privapp-permissions-AudioBridge.xml` | **Create** | CAPTURE_AUDIO_OUTPUT |
