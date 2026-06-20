# Audio Bridge v4.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all security audit issues, eliminate Zygisk, implement QCOM SM6150 SIM call audio injection via root daemon + tinyalsa PCM, add SIM routing filter, and expose device info/battery/signal on the dashboard.

**Architecture:** Root daemon opens PCM devices directly via tinyalsa (no Zygisk/HAL wrapper). APK handles telephony events (call state, SMS, SIM filter, device info) and relays JSON over abstract Unix socket `@audio_bridge`. Daemon connects to server over TCP/TLS port 59100. Dashboard shows device info, battery, signal, and controls SIM filter.

**Tech Stack:** C++17 + tinyalsa + libopus + mbedtls (daemon), Java API 36 (APK), Python 3.11 FastAPI (server), single-file HTML/JS/CSS (dashboard), NDK r27c, KernelSU pure module (no Zygisk).

## Global Constraints

- NDK version: r27c exactly — `ANDROID_NDK_HOME` default in `build.sh` must use `27.2.12479018`
- No `-static-libstdc++` on daemon — NDK r27c statically links libc++ correctly without it
- Daemon CFLAGS: `-std=c++17 -O2 -fPIE -fstack-protector-strong -D_FORTIFY_SOURCE=2 -DANDROID`
- Daemon LDFLAGS: `-pie -Wl,-z,relro,-z,now -Wl,--gc-sections -Wl,--strip-all -Wl,-z,max-page-size=16384`
- Frame protocol: `[1B type][4B len BE][payload]` — types 1–7 unchanged; 8=T_DEVICE_INFO, 9=T_DEVICE_STATUS
- IPC socket: abstract Unix `@audio_bridge`, newline-delimited JSON — path unchanged
- PCM defaults (sweet/sweetin SM6150): TX injection=card 0 dev 27, RX capture=card 0 dev 0 — overridable via `config.json`
- Mixer controls: `"Incall_Music Audio Mixer MultiMedia9"` → 1 for TX, `"MultiMedia1 Mixer VOC_REC_DL"` → 1 for RX, `"Voice Tx Device Mute"` → [1, -1, 20] for mic mute
- Voice thread lifecycle invariant: `active=false` → `queue_cv.notify_all()` → `join(tx_thread)` → `join(rx_thread)` → `lock(pcm_mtx)` → `pcm_close()` — join always BEFORE pcm_close
- `pcm_write()` always inside `pcm_mtx` (prevents use-after-free during reconnect)
- `pcm_open()`/`pcm_close()` always OUTSIDE `pcm_mtx` (blocking syscalls must not hold mutex)
- Token: mandatory `AUDIO_BRIDGE_TOKEN` env var on server (no fallback default); read from `config.json` on device
- WebSocket auth: both `/ws/ui` and `/ws/audio/{device_id}` must verify token via `?token=` query param or `Authorization: Bearer` header before `accept()`
- HMAC nonce: handshake JSON includes `"nonce"` UUID hex; server rejects seen nonces for 60s (replay protection)
- TLS on TCP port 59100: opt-in — server wraps asyncio listener when `SSL_CERT_FILE`+`SSL_KEY_FILE` env vars set; daemon enables mbedtls TLS when `"use_tls": true` in `config.json`
- No `zygisk=true` in `module.prop` — pure KernelSU module; ZygiskNext must not load anything from this module
- Call audio flow: APK sends `{"type":"call_state","state":"active","sim":N}` via IPC → daemon starts voice_call_start(N) → opens PCM 27 (TX injection) + PCM 0 (RX capture)
- Heartbeat: 15s ping interval, 90s pong timeout — `g_last_pong` initialized to `time(nullptr)` at connect time (NOT 0)

---

## File Structure

**Delete:**
- `zygisk/src/zygisk_module.cpp` — Zygisk eliminated
- `java/com/audiobridge/AudioCapture.java` — replaced by daemon tinyalsa PCM capture

**Create:**
- `server/generate-certs.sh` — TLS cert generator helper
- `server/.env.example` — server environment template
- `zygisk/module/system/etc/permissions/privapp-permissions-AudioBridge.xml` — privapp permission allowlist
- `zygisk/module/files/config.json.example` — daemon config template
- `server/dashboard.html` — complete single-file dashboard UI

**Modify:**
- `build.sh` — NDK r27c, remove Zygisk build steps, fix compiler flags
- `CMakeLists.txt` — remove dead JNI + Zygisk targets, fix compile flags
- `jni/audio_bridge.h` — add T_DEVICE_INFO/STATUS, remove SHM structs, version 4.0
- `jni/audio_bridge.cpp` — voice PCM, VoiceCallContext, config.json loading, heartbeat fix, nonce HMAC, TLS
- `java/com/audiobridge/TelephonyHelper.java` — SMS fix, SIM filter, device info/status, remove AudioCapture
- `java/com/audiobridge/IPCClient.java` — OnConnectedListener, set_sim_filter/get_device_status commands
- `java/com/audiobridge/AudioBridgeService.java` — remove AudioCapture, send device info on IPC connect
- `server/main.py` — WS auth, nonce, SMS routing fix, T_DEVICE_INFO/STATUS, SIM filter control, TLS

---

## Task 1: Build System Cleanup

**Files:**
- Modify: `build.sh`
- Modify: `CMakeLists.txt`
- Delete: `zygisk/src/zygisk_module.cpp`

**Interfaces:**
- Produces: `build.sh` `build_native()` that compiles `audio_bridge.cpp` with NDK r27c and correct flags; `main()` that no longer calls `build_zygisk()` or `build_shadowhook()`

- [ ] **Step 1: Update NDK default to r27c and fix compiler flags**

In `build.sh` line 16, change the NDK path:
```bash
# Before:
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$HOME/Android/Sdk/ndk/29.0.14206865}"

# After:
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$HOME/Android/Sdk/ndk/27.2.12479018}"
```

In `build.sh` `build_native()` (around line 154), replace the `$CXX` invocation:
```bash
# Before (lines 154-173):
    $CXX \
        -std=c++17 \
        -O3 \
        -fPIE \
        -DANDROID \
        ...
        -static-libstdc++ \
        -pthread \
        -pie \
        -Wl,--gc-sections \
        -Wl,--strip-all \
        -Wl,-z,max-page-size=16384 \
        -llog

# After:
    $CXX \
        -std=c++17 \
        -O2 \
        -fPIE \
        -fstack-protector-strong \
        -D_FORTIFY_SOURCE=2 \
        -DANDROID \
        -I"$LIBS_DIR/$ABI/include" \
        -I"$PROJECT_DIR/jni" \
        audio_bridge.cpp \
        -o "$BUILD_DIR/audio-bridge-$ABI" \
        -L"$LIBS_DIR/$ABI" \
        -lopus \
        -ltinyalsa \
        -lmbedtls -lmbedx509 -lmbedcrypto \
        -pthread \
        -pie \
        -Wl,-z,relro,-z,now \
        -Wl,--gc-sections \
        -Wl,--strip-all \
        -Wl,-z,max-page-size=16384 \
        -llog
```

Note: `-lmbedcrypto` not `-lmbedcrypto` is already present — just ensure the library name matches what `build_mbedtls()` outputs (`libmbedcrypto.a`). NDK r27c ships its own libc++_static.a without TLS relocations so `-static-libstdc++` is no longer needed.

- [ ] **Step 2: Remove Zygisk + shadowhook from main()**

In `build.sh` `main()` (around line 857), remove the two calls:
```bash
# Remove these two lines:
    build_zygisk
```
and
```bash
# (build_shadowhook is only called inside build_zygisk now, so removing
# the call to build_zygisk removes it too — but search and confirm
# build_shadowhook is not called anywhere else)
```

Also in `main()`, update the module.prop generation section inside `build_zygisk()` if it's still being referenced — but since we removed the call, the function just becomes dead code. Leave the function in place (do not delete it) to preserve history, but do NOT call it.

- [ ] **Step 3: Update APK build to not copy AudioCapture.java**

In `build.sh` `build_apk()` (around line 196), remove the AudioCapture copy:
```bash
# Remove this line:
    cp java/com/audiobridge/AudioCapture.java app/src/main/java/com/audiobridge/
```

- [ ] **Step 4: Update module.prop generation (inside build_zygisk, kept as dead code)**

The module.prop is generated inside `build_zygisk()`. Since we no longer call `build_zygisk()`, we need to generate module.prop separately. Add a new function `build_module_metadata()` to `main()` that creates module.prop and customize.sh:

After the `build_native` call in `main()`, add:
```bash
    # Generate module metadata
    local VER_CODE
    VER_CODE=$(git -C "$PROJECT_DIR" rev-list --count HEAD 2>/dev/null || echo "1")
    local VER_NAME="v4.0.${VER_CODE}"

    cat > "$PROJECT_DIR/zygisk/module/module.prop" << EOF
id=audio_bridge
name=Audio Bridge
version=${VER_NAME}
versionCode=${VER_CODE}
author=AudioBridge
description=Remote audio streaming, call control and SMS. Android 16 + KernelSU compatible.
minKernelSU=11631
updateJson=https://raw.githubusercontent.com/validkanaheiuser/audio-bridge-concept/main/update.json
EOF

    cat > "$PROJECT_DIR/zygisk/module/customize.sh" << 'CUSTOMEOF'
ui_print "- Installing Audio Bridge v4.0"
ui_print "  Removing stale priv-app and system overlays..."
rm -rf "$MODPATH/system/priv-app" 2>/dev/null
rm -rf "$MODPATH/system/bin" 2>/dev/null
CUSTOMEOF
```

Note: Put this inline in `main()` before the APK copy step.

- [ ] **Step 5: Clean up CMakeLists.txt**

Replace the entire `CMakeLists.txt` with:
```cmake
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
```

Note: CMakeLists.txt does not link mbedtls because the actual build goes through `build.sh` on CI — CMakeLists.txt is for IDE integration only. The `jni/jni_bridge.cpp` and `zygisk/src/zygisk_module.cpp` targets are removed.

- [ ] **Step 6: Delete zygisk_module.cpp**

```bash
git rm zygisk/src/zygisk_module.cpp
```

- [ ] **Step 7: Commit**

```bash
git add build.sh CMakeLists.txt
git commit -m "build: switch to NDK r27c, remove Zygisk and AudioCapture, add hardening flags"
```

---

## Task 2: Module Structure Files

**Files:**
- Modify: `zygisk/module/service.sh`
- Modify: `zygisk/module/post-fs-data.sh`
- Create: `zygisk/module/system/etc/permissions/privapp-permissions-AudioBridge.xml`
- Create: `zygisk/module/files/config.json.example`

**Interfaces:**
- Produces: `config.json.example` consumed by `service.sh`; `privapp-permissions-AudioBridge.xml` grants CAPTURE_AUDIO_OUTPUT as privapp permission

- [ ] **Step 1: Rewrite service.sh**

Replace the entire `zygisk/module/service.sh` with:
```bash
#!/system/bin/sh
MODDIR="${0%/*}"
LOG=/data/local/tmp/audio_bridge_service.log

echo "$(date) service.sh started" >> "$LOG"

# ── Auto-grant runtime permissions ──────────────────────────────────────────
pm grant com.audiobridge android.permission.CALL_PHONE 2>/dev/null
pm grant com.audiobridge android.permission.ANSWER_PHONE_CALLS 2>/dev/null
pm grant com.audiobridge android.permission.READ_PHONE_STATE 2>/dev/null
pm grant com.audiobridge android.permission.READ_PRECISE_PHONE_STATE 2>/dev/null
pm grant com.audiobridge android.permission.SEND_SMS 2>/dev/null
pm grant com.audiobridge android.permission.RECEIVE_SMS 2>/dev/null
pm grant com.audiobridge android.permission.READ_SMS 2>/dev/null
pm grant com.audiobridge android.permission.POST_NOTIFICATIONS 2>/dev/null
pm grant com.audiobridge android.permission.RECORD_AUDIO 2>/dev/null
appops set com.audiobridge RECORD_AUDIO allow 2>/dev/null

# ── SELinux rules ────────────────────────────────────────────────────────────
apply_rule() {
    if command -v magiskpolicy >/dev/null 2>&1; then
        magiskpolicy --live "$1" 2>/dev/null
    elif [ -f /data/adb/ksud ]; then
        /data/adb/ksud apply-sepolicy "$1" 2>/dev/null
    fi
}
for APP in priv_app system_app platform_app radio; do
    for D in ksu magisk su init; do
        apply_rule "allow $APP $D unix_stream_socket { connectto read write getattr }"
    done
done
apply_rule "allow priv_app shell_data_file { read write create open append getattr setattr }"
# Allow root daemon to access ALSA PCM devices
apply_rule "allow su audio_device chr_file { open read write ioctl }"
apply_rule "allow ksu audio_device chr_file { open read write ioctl }"
echo "$(date) SELinux rules applied" >> "$LOG"

# ── Start daemon ─────────────────────────────────────────────────────────────
DAEMON="$MODDIR/files/audio-bridge"
CONFIG="$MODDIR/files/config.json"

if [ ! -x "$DAEMON" ]; then
    echo "$(date) ERROR: $DAEMON not executable" >> "$LOG"
    exit 1
fi

# Bootstrap config from example if missing
if [ ! -f "$CONFIG" ] && [ -f "$MODDIR/files/config.json.example" ]; then
    cp "$MODDIR/files/config.json.example" "$CONFIG"
    echo "$(date) Created config.json from example" >> "$LOG"
fi

(
    while true; do
        "$DAEMON" --config "$CONFIG" >> "$LOG" 2>&1
        echo "$(date) Daemon exited ($?), restarting in 5s" >> "$LOG"
        sleep 5
    done
) &

# ── Wait for boot and start APK ──────────────────────────────────────────────
(
    for i in $(seq 1 60); do
        [ "$(getprop sys.boot_completed)" = "1" ] && break
        sleep 2
    done
    sleep 3

    APK_STATE=$(pm path com.audiobridge 2>/dev/null)
    if [ -z "$APK_STATE" ]; then
        [ -f "$MODDIR/AudioBridge.apk" ] && pm install -r -g "$MODDIR/AudioBridge.apk" >> "$LOG" 2>&1
        sleep 2
    elif echo "$APK_STATE" | grep -q "/system/priv-app/"; then
        [ -f "$MODDIR/AudioBridge.apk" ] && pm install -r -g "$MODDIR/AudioBridge.apk" >> "$LOG" 2>&1
        sleep 2
    fi

    FGS_OUT=$(am start-foreground-service --user 0 com.audiobridge/.AudioBridgeService 2>&1)
    echo "$(date) FGS: $FGS_OUT" >> "$LOG"
    sleep 4
    if ! pidof com.audiobridge >/dev/null 2>&1; then
        OUT=$(am start --user 0 -n com.audiobridge/.LauncherActivity 2>&1)
        echo "$(date) LauncherActivity fallback: $OUT" >> "$LOG"
    fi
) &
```

- [ ] **Step 2: Update post-fs-data.sh with SELinux allowance for ALSA**

Replace `zygisk/module/post-fs-data.sh` with:
```bash
#!/system/bin/sh
# post-fs-data.sh — runs before Android framework, must be FAST and non-blocking.
# Only inject sepolicy rules that must be present before the framework starts.
MODDIR="${0%/*}"

apply_rule() {
    if command -v magiskpolicy >/dev/null 2>&1; then
        magiskpolicy --live "$1" 2>/dev/null
    elif [ -f /data/adb/ksud ]; then
        /data/adb/ksud apply-sepolicy "$1" 2>/dev/null
    fi
}

# Allow root daemon (ksu/magisk/su/init domain) to access /dev/snd/* (ALSA)
for D in ksu magisk su init; do
    apply_rule "allow $D audio_device chr_file { open read write ioctl getattr }"
    apply_rule "allow $D self capability { sys_nice }"
done
```

- [ ] **Step 3: Create privapp-permissions XML**

Create `zygisk/module/system/etc/permissions/privapp-permissions-AudioBridge.xml`:
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

Also create the parent directory path: `zygisk/module/system/etc/permissions/`

- [ ] **Step 4: Create config.json.example**

Ensure the directory exists: `zygisk/module/files/`

Create `zygisk/module/files/config.json.example`:
```json
{
  "host": "",
  "port": 59100,
  "token": "",
  "use_tls": false,
  "server_cert_sha256": "",
  "pcm_card": 0,
  "pcm_tx_injection_device": 27,
  "pcm_rx_capture_device": 0,
  "pcm_rx_capture_rate": 16000
}
```

- [ ] **Step 5: Verify sepolicy.rule still present**

Check that `zygisk/module/sepolicy.rule` exists and contains the Unix socket rules. If it was generated only by `build_zygisk()`, add it as a static committed file:
```
allow priv_app   ksu     unix_stream_socket { connectto read write getattr }
allow priv_app   magisk  unix_stream_socket { connectto read write getattr }
allow priv_app   su      unix_stream_socket { connectto read write getattr }
allow priv_app   init    unix_stream_socket { connectto read write getattr }
allow system_app ksu     unix_stream_socket { connectto read write getattr }
allow system_app magisk  unix_stream_socket { connectto read write getattr }
allow system_app su      unix_stream_socket { connectto read write getattr }
allow platform_app ksu   unix_stream_socket { connectto read write getattr }
allow platform_app magisk unix_stream_socket { connectto read write getattr }
allow radio      ksu     unix_stream_socket { connectto read write getattr }
allow radio      magisk  unix_stream_socket { connectto read write getattr }
allow priv_app   shell_data_file { read write create open append getattr setattr }
allow su         audio_device chr_file { open read write ioctl }
allow ksu        audio_device chr_file { open read write ioctl }
```

- [ ] **Step 6: Commit**

```bash
git add zygisk/module/service.sh zygisk/module/post-fs-data.sh
git add zygisk/module/system/etc/permissions/privapp-permissions-AudioBridge.xml
git add zygisk/module/files/config.json.example
git add zygisk/module/sepolicy.rule
git commit -m "module: simplify service.sh, add config.json.example, privapp-permissions, ALSA sepolicy"
```

---

## Task 3: APK Java Changes

**Files:**
- Delete: `java/com/audiobridge/AudioCapture.java`
- Modify: `java/com/audiobridge/TelephonyHelper.java`
- Modify: `java/com/audiobridge/IPCClient.java`
- Modify: `java/com/audiobridge/AudioBridgeService.java`

**Interfaces:**
- Consumes: IPC command `"set_sim_filter"` with `{"allowed_sims":[0,1]}` from daemon; command `"get_device_status"` from daemon
- Produces: IPC JSON events `{"type":"call_state","state":"active","number":"...","sim":N}`, `{"type":"sms","ver":1,"from":"...","body":"...","sim_slot":N,"sim_carrier":"...","timestamp":N}`, `{"type":"device_info",...}`, `{"type":"device_status",...}`

- [ ] **Step 1: Delete AudioCapture.java**

```bash
git rm java/com/audiobridge/AudioCapture.java
```

- [ ] **Step 2: Fix TelephonyHelper.java — SMS format and remove AudioCapture**

In `TelephonyHelper.java`, find `SMSBroadcastReceiver.onReceive()`. Replace the SMS event construction. The current code sends `"event":"sms_received"`, `"sender":sender`, `"message":messageBody`. Replace with:

```java
// In SMSBroadcastReceiver.onReceive(), replace the event building block:
int simSlot = 0;
String simCarrier = "";
SubscriptionManager sm = (SubscriptionManager)
    context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE);
if (sm != null) {
    int subId = intent.getIntExtra("android.telephony.extra.SUBSCRIPTION_INDEX",
                    SubscriptionManager.INVALID_SUBSCRIPTION_ID);
    if (subId == SubscriptionManager.INVALID_SUBSCRIPTION_ID) {
        // Fallback: check all subs and find first active one
        List<SubscriptionInfo> subs = sm.getActiveSubscriptionInfoList();
        if (subs != null && !subs.isEmpty()) {
            SubscriptionInfo sub = subs.get(0);
            simSlot = sub.getSimSlotIndex();
            CharSequence cn = sub.getCarrierName();
            if (cn != null) simCarrier = cn.toString();
        }
    } else {
        SubscriptionInfo sub = sm.getActiveSubscriptionInfo(subId);
        if (sub != null) {
            simSlot = sub.getSimSlotIndex();
            CharSequence cn = sub.getCarrierName();
            if (cn != null) simCarrier = cn.toString();
        }
    }
}

JSONObject event = new JSONObject();
event.put("type", "sms");
event.put("ver", 1);
event.put("from", sender);
event.put("body", messageBody);
event.put("sim_slot", simSlot);
event.put("sim_carrier", simCarrier);
event.put("timestamp", System.currentTimeMillis());
IPCClient.getInstance().sendEvent(event);
```

Also in `handleCallStateChange()` (or wherever `AudioCapture.getInstance().start()` appears), remove those calls entirely. Search for `AudioCapture` in `TelephonyHelper.java` and delete all references.

- [ ] **Step 3: Add call_state IPC with SIM slot to TelephonyHelper**

In `TelephonyHelper.java`, replace the existing `emitCallState()` method (or wherever `{"type":"call","state":...}` is sent) so it includes the SIM slot:

```java
private void emitCallState(String state, String number, int simSlot) {
    try {
        JSONObject ev = new JSONObject();
        ev.put("type", "call_state");
        ev.put("state", state);
        ev.put("number", number != null ? number : "");
        ev.put("sim", simSlot);
        ev.put("timestamp", System.currentTimeMillis());
        IPCClient.getInstance().sendEvent(ev);
    } catch (JSONException e) {
        Log.e(TAG, "emitCallState: " + e.getMessage());
    }
}
```

Call this from `handleCallStateChange()` for RINGING, OFFHOOK, IDLE states, passing the detected SIM slot.

Note: the existing `emitCallState()` may send `{"type":"call","state":"ACTIVE",...}` — keep those also (for backward compat with server's T_CALL_STATUS handler). The new `{"type":"call_state","state":"active","sim":N}` events are intercepted by the daemon for voice PCM control; the server sees `{"type":"call"}` events for dashboard state updates. So emit both.

- [ ] **Step 4: Add SIM filter to TelephonyHelper**

Add these fields and methods to `TelephonyHelper`:

```java
private final Set<Integer> mSimFilter = new HashSet<>(Arrays.asList(0, 1));

private void loadSimFilter() {
    SharedPreferences prefs = mContext.getSharedPreferences("AudioBridge", Context.MODE_PRIVATE);
    String json = prefs.getString("sim_filter", "[0,1]");
    mSimFilter.clear();
    try {
        JSONArray arr = new JSONArray(json);
        for (int i = 0; i < arr.length(); i++) mSimFilter.add(arr.getInt(i));
    } catch (JSONException e) {
        mSimFilter.add(0); mSimFilter.add(1);
    }
}

public void setSimFilter(List<Integer> slots) {
    mSimFilter.clear();
    mSimFilter.addAll(slots);
    SharedPreferences prefs = mContext.getSharedPreferences("AudioBridge", Context.MODE_PRIVATE);
    JSONArray arr = new JSONArray(slots);
    prefs.edit().putString("sim_filter", arr.toString()).apply();
}

private int getIncomingCallSimSlot() {
    SubscriptionManager sm = mContext.getSystemService(SubscriptionManager.class);
    if (sm == null) return 0;
    List<SubscriptionInfo> subs = sm.getActiveSubscriptionInfoList();
    if (subs == null) return 0;
    for (SubscriptionInfo sub : subs) {
        TelephonyManager tm = mTelephonyManager.createForSubscriptionId(sub.getSubscriptionId());
        if (tm.getCallState() == TelephonyManager.CALL_STATE_RINGING) {
            return sub.getSimSlotIndex();
        }
    }
    return 0;
}

private void rejectCall() {
    try {
        TelecomManager tc = (TelecomManager) mContext.getSystemService(Context.TELECOM_SERVICE);
        if (tc != null) {
            // API 28+: endCall() requires MODIFY_PHONE_STATE or ANSWER_PHONE_CALLS
            Method m = TelecomManager.class.getMethod("endCall");
            m.invoke(tc);
        }
    } catch (Exception e) {
        Log.e(TAG, "rejectCall: " + e.getMessage());
    }
}
```

In `handleCallStateChange()` for CALL_STATE_RINGING, add the SIM filter check before the normal ringing flow:
```java
case TelephonyManager.CALL_STATE_RINGING:
    int simSlot = getIncomingCallSimSlot();
    if (!mSimFilter.contains(simSlot)) {
        Log.i(TAG, "Rejecting call on SIM " + simSlot + " (not in filter)");
        rejectCall();
        emitCallState("rejected_filter", incomingNumber, simSlot);
        return;
    }
    // ... existing ringing handling ...
```

Call `loadSimFilter()` in the constructor.

- [ ] **Step 5: Add buildDeviceInfo() and buildDeviceStatus() to TelephonyHelper**

```java
public JSONObject buildDeviceInfo() {
    try {
        JSONObject info = new JSONObject();
        info.put("type", "device_info");
        info.put("model", Build.MODEL);
        info.put("manufacturer", Build.MANUFACTURER);
        info.put("android_version", Build.VERSION.RELEASE);
        info.put("sdk_int", Build.VERSION.SDK_INT);
        info.put("rom", Build.DISPLAY);

        JSONArray simsArr = new JSONArray();
        SubscriptionManager sm = mContext.getSystemService(SubscriptionManager.class);
        if (sm != null) {
            List<SubscriptionInfo> subs = sm.getActiveSubscriptionInfoList();
            if (subs != null) {
                for (SubscriptionInfo sub : subs) {
                    JSONObject s = new JSONObject();
                    s.put("slot", sub.getSimSlotIndex());
                    CharSequence cn = sub.getCarrierName();
                    s.put("carrier", cn != null ? cn.toString() : "");
                    CharSequence dn = sub.getDisplayName();
                    s.put("display_name", dn != null ? dn.toString() : "");
                    s.put("number", sub.getNumber() != null ? sub.getNumber() : "");
                    s.put("country_iso", sub.getCountryIso() != null ? sub.getCountryIso() : "");
                    simsArr.put(s);
                }
            }
        }
        info.put("sims", simsArr);

        JSONArray filterArr = new JSONArray(new ArrayList<>(mSimFilter));
        info.put("sim_filter", filterArr);
        return info;
    } catch (JSONException e) {
        Log.e(TAG, "buildDeviceInfo: " + e.getMessage());
        return new JSONObject();
    }
}

public JSONObject buildDeviceStatus() {
    try {
        JSONObject status = new JSONObject();
        status.put("type", "device_status");

        Intent battery = mContext.registerReceiver(null,
            new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (battery != null) {
            int level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            status.put("battery_pct", scale > 0 ? (int)(level * 100f / scale) : -1);
            int bstatus = battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            status.put("battery_charging",
                bstatus == BatteryManager.BATTERY_STATUS_CHARGING ||
                bstatus == BatteryManager.BATTERY_STATUS_FULL);
        }

        JSONArray simsArr = new JSONArray();
        SubscriptionManager sm = mContext.getSystemService(SubscriptionManager.class);
        if (sm != null) {
            List<SubscriptionInfo> subs = sm.getActiveSubscriptionInfoList();
            if (subs != null) {
                for (SubscriptionInfo sub : subs) {
                    JSONObject s = new JSONObject();
                    s.put("slot", sub.getSimSlotIndex());
                    CharSequence cn = sub.getCarrierName();
                    s.put("carrier", cn != null ? cn.toString() : "");
                    TelephonyManager tm = mTelephonyManager
                        .createForSubscriptionId(sub.getSubscriptionId());
                    SignalStrength ss = tm.getSignalStrength();
                    int bars = 0, dbm = -120;
                    if (ss != null && !ss.getCellSignalStrengths().isEmpty()) {
                        CellSignalStrength css = ss.getCellSignalStrengths().get(0);
                        bars = css.getLevel();
                        dbm = css.getDbm();
                    }
                    s.put("signal_bars", bars);
                    s.put("signal_dbm", dbm);
                    s.put("network_type", networkTypeName(tm.getDataNetworkType()));
                    simsArr.put(s);
                }
            }
        }
        status.put("sims", simsArr);
        return status;
    } catch (JSONException e) {
        Log.e(TAG, "buildDeviceStatus: " + e.getMessage());
        return new JSONObject();
    }
}

private String networkTypeName(int type) {
    switch (type) {
        case TelephonyManager.NETWORK_TYPE_LTE: return "LTE";
        case TelephonyManager.NETWORK_TYPE_NR: return "5G";
        case TelephonyManager.NETWORK_TYPE_UMTS:
        case TelephonyManager.NETWORK_TYPE_HSDPA:
        case TelephonyManager.NETWORK_TYPE_HSUPA:
        case TelephonyManager.NETWORK_TYPE_HSPA:
        case TelephonyManager.NETWORK_TYPE_HSPAP: return "3G";
        case TelephonyManager.NETWORK_TYPE_GPRS:
        case TelephonyManager.NETWORK_TYPE_EDGE: return "2G";
        default: return "Unknown";
    }
}
```

Add required imports: `android.telephony.SignalStrength`, `android.telephony.CellSignalStrength`, `android.os.BatteryManager`, `android.content.IntentFilter`, `java.lang.reflect.Method`, `java.util.ArrayList`.

- [ ] **Step 6: Add OnConnectedListener to IPCClient and handle daemon commands**

In `IPCClient.java`, add:

```java
public interface OnConnectedListener {
    void onConnected();
}

private OnConnectedListener mOnConnectedListener;

public void setOnConnectedListener(OnConnectedListener l) {
    mOnConnectedListener = l;
}
```

In `connectAndListen()` (after sending HELO_JAVA and receiving OK, or equivalent connect success point), call:
```java
if (mOnConnectedListener != null) {
    mOnConnectedListener.onConnected();
}
```

In `handleCommand(JSONObject json)`, add after existing command handling:
```java
} else if ("set_sim_filter".equals(cmd)) {
    JSONArray slots = json.optJSONArray("allowed_sims");
    if (slots != null) {
        List<Integer> slotList = new ArrayList<>();
        for (int i = 0; i < slots.length(); i++) {
            try { slotList.add(slots.getInt(i)); } catch (JSONException ignore) {}
        }
        TelephonyHelper th = TelephonyHelper.getInstance();
        if (th != null) th.setSimFilter(slotList);
    }
} else if ("get_device_status".equals(cmd)) {
    TelephonyHelper th = TelephonyHelper.getInstance();
    if (th != null) {
        try {
            sendEvent(th.buildDeviceStatus());
        } catch (Exception e) {
            Log.e(TAG, "get_device_status: " + e.getMessage());
        }
    }
} else if ("get_device_info".equals(cmd)) {
    TelephonyHelper th = TelephonyHelper.getInstance();
    if (th != null) {
        try {
            sendEvent(th.buildDeviceInfo());
        } catch (Exception e) {
            Log.e(TAG, "get_device_info: " + e.getMessage());
        }
    }
}
```

Also remove `connectAudioStream()` method entirely (the binary audio socket to daemon — no longer used since AudioCapture is deleted).

- [ ] **Step 7: Update AudioBridgeService to send device info on IPC connect**

In `AudioBridgeService.java`, in `onCreate()`, after `IPCClient.getInstance()` is initialized but before it connects:

```java
IPCClient.getInstance().setOnConnectedListener(() -> {
    TelephonyHelper th = TelephonyHelper.getInstance();
    if (th != null) {
        try {
            IPCClient.getInstance().sendEvent(th.buildDeviceInfo());
        } catch (Exception e) {
            Log.e(TAG, "sendDeviceInfo on connect: " + e.getMessage());
        }
    }
});
```

Remove any reference to `AudioCapture` in `AudioBridgeService.java`.

- [ ] **Step 8: Commit**

```bash
git rm java/com/audiobridge/AudioCapture.java
git add java/com/audiobridge/TelephonyHelper.java
git add java/com/audiobridge/IPCClient.java
git add java/com/audiobridge/AudioBridgeService.java
git commit -m "apk: fix SMS format, add SIM filter, device info/status, remove AudioCapture"
```

---

## Task 4: Daemon Header (audio_bridge.h)

**Files:**
- Modify: `jni/audio_bridge.h`

**Interfaces:**
- Produces: `T_DEVICE_INFO = 0x08`, `T_DEVICE_STATUS = 0x09` constants used by `audio_bridge.cpp` and `server/main.py`

- [ ] **Step 1: Rewrite audio_bridge.h**

Replace the entire file content with:
```cpp
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
```

- [ ] **Step 2: Commit**

```bash
git add jni/audio_bridge.h
git commit -m "header: add T_DEVICE_INFO/STATUS, remove SHM structs, bump to v4.0"
```

---

## Task 5: Daemon Voice Audio (audio_bridge.cpp)

This is the largest task. It involves removing dead SHM/Zygisk code and adding the entire voice call PCM subsystem. Changes are organized by section; apply all to `jni/audio_bridge.cpp`.

**Files:**
- Modify: `jni/audio_bridge.cpp`

**Interfaces:**
- Consumes: `{"type":"call_state","state":"active","sim":N}` from IPC → `voice_call_start(N)` / `voice_call_stop()`; `{"type":"device_info",...}` / `{"type":"device_status",...}` from IPC → forwarded as T_DEVICE_INFO/STATUS frames
- Produces: T_SPEAKER Opus frames (RX capture), accepts T_VIRTUAL_MIC Opus frames → enqueued to voice TX jitter buffer; T_DEVICE_INFO (0x08) and T_DEVICE_STATUS (0x09) frames to server; requests `{"command":"get_device_status"}` from APK on every T_PING from server

- [ ] **Step 1: Remove deprecated includes and globals**

Remove from the top of `audio_bridge.cpp`:
- `#include <jni.h>` — no JNI used
- `#include <dlfcn.h>` — no dlopen used
- `#include <sys/mman.h>` — no mmap/SHM used
- `#include <sys/syscall.h>` — no memfd_create needed
- `#include <sys/resource.h>` — keep (used for setpriority)

Remove these global variables:
```cpp
// Remove:
static int         g_shm_fd       = -1;
static void*       g_shm_ptr      = nullptr;
static JavaVM*     g_jvm          = nullptr;
static jclass      g_helper_class = nullptr;
static jobject     g_helper_obj   = nullptr;

// Remove:
struct JavaPcmChunk { std::vector<int16_t> samples; };
static std::mutex              g_java_pcm_mutex;
static std::condition_variable g_java_pcm_cv;
static std::queue<JavaPcmChunk> g_java_pcm_queue;
static std::atomic<bool>       g_java_pcm_pending{false};

// Remove:
static std::mutex g_mic_consumer_mutex;  // (if exists)
```

Remove the `SHM_RING_SIZE` and `SHM_SIZE` constants (no longer in header, no longer needed).

- [ ] **Step 2: Add DaemonConfig struct and config.json loader**

Add after the constants section (before global state):

```cpp
// ── Daemon Configuration ──────────────────────────────────────────────────────
struct DaemonConfig {
    char host[256]              = {};
    int  port                   = 59100;
    char token[256]             = {};
    bool use_tls                = false;
    char server_cert_sha256[65] = {};  // hex SHA-256 of server cert
    int  pcm_card               = 0;
    int  pcm_tx_device          = 27;  // Incall Music uplink (PCM 27 on SM6150)
    int  pcm_rx_device          = 0;   // Incall record downlink (PCM 0 on SM6150)
    int  pcm_rx_rate            = 16000;
};
static DaemonConfig g_cfg;

static const char* json_get_str_field(const char* json, const char* key,
                                      char* out, size_t out_sz) {
    char needle[128];
    snprintf(needle, sizeof(needle), "\"%s\"", key);
    const char* p = strstr(json, needle);
    if (!p) return nullptr;
    p += strlen(needle);
    while (*p == ' ' || *p == ':' || *p == '\t') p++;
    if (*p != '"') return nullptr;
    p++;
    const char* q = strchr(p, '"');
    if (!q) return nullptr;
    size_t len = (size_t)(q - p);
    if (len >= out_sz) len = out_sz - 1;
    memcpy(out, p, len);
    out[len] = '\0';
    return out;
}

static int json_get_int_field(const char* json, const char* key, int def) {
    char needle[128];
    snprintf(needle, sizeof(needle), "\"%s\"", key);
    const char* p = strstr(json, needle);
    if (!p) return def;
    p += strlen(needle);
    while (*p == ' ' || *p == ':' || *p == '\t') p++;
    if (*p == '-' || isdigit((unsigned char)*p))
        return (int)strtol(p, nullptr, 10);
    return def;
}

static bool json_get_bool_field(const char* json, const char* key, bool def) {
    char needle[128];
    snprintf(needle, sizeof(needle), "\"%s\"", key);
    const char* p = strstr(json, needle);
    if (!p) return def;
    p += strlen(needle);
    while (*p == ' ' || *p == ':' || *p == '\t') p++;
    if (strncmp(p, "true", 4) == 0) return true;
    if (strncmp(p, "false", 5) == 0) return false;
    return def;
}

static void load_config_json(const char* path) {
    FILE* f = fopen(path, "r");
    if (!f) { LOGW("config.json not found at %s", path); return; }
    char buf[2048] = {};
    size_t n = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    if (n == 0) return;
    buf[n] = '\0';

    json_get_str_field(buf, "host", g_cfg.host, sizeof(g_cfg.host));
    g_cfg.port = json_get_int_field(buf, "port", 59100);
    json_get_str_field(buf, "token", g_cfg.token, sizeof(g_cfg.token));
    g_cfg.use_tls = json_get_bool_field(buf, "use_tls", false);
    json_get_str_field(buf, "server_cert_sha256", g_cfg.server_cert_sha256,
                       sizeof(g_cfg.server_cert_sha256));
    g_cfg.pcm_card      = json_get_int_field(buf, "pcm_card", 0);
    g_cfg.pcm_tx_device = json_get_int_field(buf, "pcm_tx_injection_device", 27);
    g_cfg.pcm_rx_device = json_get_int_field(buf, "pcm_rx_capture_device", 0);
    g_cfg.pcm_rx_rate   = json_get_int_field(buf, "pcm_rx_capture_rate", 16000);

    LOGI("config.json: host=%s port=%d tls=%d tx_dev=%d rx_dev=%d",
         g_cfg.host, g_cfg.port, g_cfg.use_tls, g_cfg.pcm_tx_device, g_cfg.pcm_rx_device);
}
```

- [ ] **Step 3: Add VoiceCallContext struct and global**

Add after DaemonConfig section:

```cpp
// ── Voice Call PCM Context ────────────────────────────────────────────────────
static constexpr int TX_TARGET_FRAMES = 5;   // pre-fill before starting PCM write (100ms)
static constexpr int TX_MAX_FRAMES    = 15;  // drop oldest beyond this (300ms)

struct VoiceCallContext {
    std::atomic<bool> active{false};
    std::atomic<bool> reconnecting{false};

    // TX: server Opus packets → phone mic via PCM 27
    struct pcm*             tx_pcm = nullptr;
    std::mutex              pcm_mtx;
    std::deque<std::vector<uint8_t>> tx_queue;
    std::mutex              queue_mtx;
    std::condition_variable queue_cv;

    // RX: phone speaker via PCM 0 → Opus → server
    struct pcm*             rx_pcm = nullptr;

    std::thread             tx_thread;
    std::thread             rx_thread;

    int sim_slot = -1;
};

static VoiceCallContext g_voice;
```

- [ ] **Step 4: Add heartbeat pong tracker**

Add to global state section (after `g_connected`):

```cpp
static std::atomic<time_t> g_last_pong{0};
```

- [ ] **Step 5: Add ALSA mixer helpers**

Add before the voice PCM functions:

```cpp
// ── ALSA Mixer Helpers ────────────────────────────────────────────────────────
static bool set_ctl(struct mixer* mix, const char* name, int val) {
    struct mixer_ctl* ctl = mixer_get_ctl_by_name(mix, name);
    if (!ctl) { LOGW("mixer: ctl not found: %s", name); return false; }
    int r = mixer_ctl_set_value(ctl, 0, val);
    if (r != 0) { LOGW("mixer: set %s = %d failed: %d", name, val, r); return false; }
    return true;
}

static bool set_ctl_array(struct mixer* mix, const char* name,
                           const int* vals, int n) {
    struct mixer_ctl* ctl = mixer_get_ctl_by_name(mix, name);
    if (!ctl) { LOGW("mixer: ctl not found: %s", name); return false; }
    for (int i = 0; i < n; i++) {
        if (mixer_ctl_set_value(ctl, i, vals[i]) != 0) {
            LOGW("mixer: set %s[%d] = %d failed", name, i, vals[i]);
        }
    }
    return true;
}

static bool setup_incall_mixer(int sim_slot) {
    struct mixer* mix = mixer_open(g_cfg.pcm_card);
    if (!mix) { LOGE("mixer_open(card=%d) failed", g_cfg.pcm_card); return false; }

    // Route PCM 27 (MultiMedia9) into voice uplink
    set_ctl(mix, "Incall_Music Audio Mixer MultiMedia9", 1);

    // Enable downlink recording tap for RX capture
    set_ctl(mix, "MultiMedia1 Mixer VOC_REC_DL", 1);

    // Mute the real microphone so remote party hears only our injection
    const int mute_vals[] = {1, -1, 20};
    set_ctl_array(mix, "Voice Tx Device Mute", mute_vals, 3);

    // Route VOICEMMODE1 (SIM 0) or VOICEMMODE2 (SIM 1)
    if (sim_slot == 1) {
        set_ctl(mix, "VOICEMMODE2_Tx Mixer TX_CDC_DMA_TX_3_MMode2", 1);
    } else {
        set_ctl(mix, "VOICEMMODE1_Tx Mixer TX_CDC_DMA_TX_3_MMode1", 1);
    }

    mixer_close(mix);
    LOGI("incall mixer setup OK (sim_slot=%d)", sim_slot);
    return true;
}

static void reset_incall_mixer() {
    struct mixer* mix = mixer_open(g_cfg.pcm_card);
    if (!mix) return;
    set_ctl(mix, "Incall_Music Audio Mixer MultiMedia9", 0);
    set_ctl(mix, "MultiMedia1 Mixer VOC_REC_DL", 0);
    const int unmute_vals[] = {0, -1, 0};
    set_ctl_array(mix, "Voice Tx Device Mute", unmute_vals, 3);
    set_ctl(mix, "VOICEMMODE1_Tx Mixer TX_CDC_DMA_TX_3_MMode1", 0);
    set_ctl(mix, "VOICEMMODE2_Tx Mixer TX_CDC_DMA_TX_3_MMode2", 0);
    mixer_close(mix);
    LOGI("incall mixer reset");
}
```

Note: `#include <tinyalsa/mixer.h>` must be added if not already included. The existing include is `<tinyalsa/asoundlib.h>` which includes mixer.h.

- [ ] **Step 6: Add PCM open helpers**

```cpp
// ── PCM Open Helpers ──────────────────────────────────────────────────────────
static struct pcm* open_pcm_with_retry(int card, int dev, int flags,
                                        const struct pcm_config* cfg,
                                        int retries = 20, int delay_ms = 100) {
    for (int i = 0; i < retries; i++) {
        struct pcm* p = pcm_open(card, dev, flags, cfg);
        if (p && pcm_is_ready(p)) return p;
        if (p) pcm_close(p);
        LOGW("pcm_open(card=%d dev=%d flags=%d) attempt %d/%d failed",
             card, dev, flags, i + 1, retries);
        usleep(delay_ms * 1000);
    }
    return nullptr;
}

// Try multiple sample rates for RX capture (PCM 0 may only support 8kHz/16kHz)
static struct pcm* open_rx_pcm_with_retry() {
    static const int kRxRates[] = {8000, 16000, 48000};
    struct pcm_config cfg = {};
    cfg.channels    = 1;
    cfg.period_size = 160;
    cfg.period_count = 4;
    cfg.format      = PCM_FORMAT_S16_LE;

    for (int rate : kRxRates) {
        cfg.rate = (unsigned)rate;
        struct pcm* p = pcm_open(g_cfg.pcm_card, g_cfg.pcm_rx_device, PCM_IN, &cfg);
        if (p && pcm_is_ready(p)) {
            LOGI("rx pcm open OK: card=%d dev=%d rate=%d",
                 g_cfg.pcm_card, g_cfg.pcm_rx_device, rate);
            return p;
        }
        if (p) pcm_close(p);
        LOGW("rx pcm_open rate=%d failed", rate);
    }
    return nullptr;
}
```

- [ ] **Step 7: Add enqueue_tx_opus_frame()**

```cpp
static void enqueue_tx_opus_frame(const uint8_t* data, int len) {
    std::vector<uint8_t> pkt(data, data + len);
    {
        std::unique_lock<std::mutex> lk(g_voice.queue_mtx);
        while ((int)g_voice.tx_queue.size() >= TX_MAX_FRAMES) {
            g_voice.tx_queue.pop_front();  // drop oldest
            LOGW("tx queue full, dropping oldest frame");
        }
        g_voice.tx_queue.push_back(std::move(pkt));
    }
    g_voice.queue_cv.notify_one();
}
```

- [ ] **Step 8: Add attempt_reopen_tx_pcm() for modem SSR**

```cpp
static bool attempt_reopen_tx_pcm() {
    // Called from voice_tx_thread on write failure — modem SSR or underrun.
    // pcm_close/open must be OUTSIDE pcm_mtx (blocking syscalls).
    struct pcm* old_pcm;
    {
        std::lock_guard<std::mutex> lk(g_voice.pcm_mtx);
        old_pcm = g_voice.tx_pcm;
        g_voice.tx_pcm = nullptr;
    }
    if (old_pcm) pcm_close(old_pcm);

    g_voice.reconnecting.store(true);
    LOGW("tx pcm: attempting reopen (SSR/underrun recovery)");

    for (int i = 0; i < 5 && g_voice.active.load(); i++) {
        usleep(200 * 1000);
        if (!setup_incall_mixer(g_voice.sim_slot)) continue;

        struct pcm_config cfg = {};
        cfg.channels    = 1;
        cfg.rate        = SAMPLE_RATE;
        cfg.period_size = FRAME_SAMPLES;
        cfg.period_count = 4;
        cfg.format      = PCM_FORMAT_S16_LE;

        struct pcm* p = open_pcm_with_retry(g_cfg.pcm_card, g_cfg.pcm_tx_device,
                                             PCM_OUT, &cfg, 3, 100);
        if (p) {
            std::lock_guard<std::mutex> lk(g_voice.pcm_mtx);
            g_voice.tx_pcm = p;
            g_voice.reconnecting.store(false);
            LOGI("tx pcm reopen OK (attempt %d)", i + 1);
            return true;
        }
    }
    g_voice.reconnecting.store(false);
    LOGE("tx pcm reopen failed after 5 attempts");
    return false;
}
```

- [ ] **Step 9: Add voice_tx_thread()**

```cpp
static void voice_tx_thread() {
    prctl(PR_SET_NAME, "ab-voice-tx", 0, 0, 0);
    struct sched_param sp{}; sp.sched_priority = 3;
    if (pthread_setschedparam(pthread_self(), SCHED_RR, &sp) != 0)
        setpriority(PRIO_PROCESS, 0, -15);

    int err;
    OpusDecoder* dec = opus_decoder_create(SAMPLE_RATE, CHANNELS, &err);
    if (!dec) { LOGE("voice_tx: opus_decoder_create failed: %d", err); return; }

    std::vector<int16_t> pcm_buf(FRAME_SAMPLES);

    // Pre-fill jitter buffer before writing to PCM
    {
        std::unique_lock<std::mutex> lk(g_voice.queue_mtx);
        g_voice.queue_cv.wait_for(lk, std::chrono::milliseconds(500),
            [&]{ return !g_voice.active.load() ||
                 (int)g_voice.tx_queue.size() >= TX_TARGET_FRAMES; });
    }
    LOGI("voice_tx: jitter buffer pre-fill done, starting PCM write");

    while (g_voice.active.load()) {
        if (g_voice.reconnecting.load()) { usleep(10000); continue; }

        std::vector<uint8_t> pkt;
        bool got_pkt = false;
        {
            std::unique_lock<std::mutex> lk(g_voice.queue_mtx);
            if (g_voice.queue_cv.wait_for(lk, std::chrono::milliseconds(30),
                    [&]{ return !g_voice.active.load() || !g_voice.tx_queue.empty(); })) {
                if (!g_voice.tx_queue.empty()) {
                    pkt = std::move(g_voice.tx_queue.front());
                    g_voice.tx_queue.pop_front();
                    got_pkt = true;
                }
            }
        }

        // Decode: real packet or PLC (null → comfort noise)
        int n;
        if (got_pkt) {
            n = opus_decode(dec, pkt.data(), (opus_int32)pkt.size(),
                            pcm_buf.data(), FRAME_SAMPLES, 0);
        } else {
            // 30ms timeout with no packet — use PLC
            n = opus_decode(dec, nullptr, 0, pcm_buf.data(), FRAME_SAMPLES, 0);
        }
        if (n < 0) {
            LOGW("voice_tx: opus_decode error %d", n);
            memset(pcm_buf.data(), 0, FRAME_SAMPLES * 2);
        }

        // Write to PCM inside pcm_mtx
        {
            std::lock_guard<std::mutex> lk(g_voice.pcm_mtx);
            if (!g_voice.tx_pcm) continue;
            int r = pcm_write(g_voice.tx_pcm, pcm_buf.data(), FRAME_SAMPLES * 2);
            if (r != 0) {
                const char* errmsg = pcm_get_error(g_voice.tx_pcm);
                if (errmsg && strstr(errmsg, "Broken pipe")) {
                    // EPIPE: underrun — prepare and continue
                    pcm_prepare(g_voice.tx_pcm);
                } else {
                    LOGW("voice_tx: pcm_write failed: %s", errmsg ? errmsg : "?");
                    // Schedule reopen outside the lock
                    std::thread([]{
                        if (!attempt_reopen_tx_pcm()) {
                            g_voice.active.store(false);
                            g_voice.queue_cv.notify_all();
                        }
                    }).detach();
                }
            }
        }
    }

    opus_decoder_destroy(dec);
    LOGI("voice_tx_thread exited");
}
```

- [ ] **Step 10: Add voice_rx_thread()**

```cpp
static void voice_rx_thread(mbedtls_net_context* net) {
    prctl(PR_SET_NAME, "ab-voice-rx", 0, 0, 0);
    struct sched_param sp{}; sp.sched_priority = 2;
    if (pthread_setschedparam(pthread_self(), SCHED_RR, &sp) != 0)
        setpriority(PRIO_PROCESS, 0, -10);

    int err;
    OpusEncoder* enc = opus_encoder_create(SAMPLE_RATE, CHANNELS,
                                            OPUS_APPLICATION_VOIP, &err);
    if (!enc) { LOGE("voice_rx: opus_encoder_create failed: %d", err); return; }
    opus_encoder_ctl(enc, OPUS_SET_BITRATE(64000));
    opus_encoder_ctl(enc, OPUS_SET_INBAND_FEC(1));
    opus_encoder_ctl(enc, OPUS_SET_PACKET_LOSS_PERC(10));
    opus_encoder_ctl(enc, OPUS_SET_COMPLEXITY(5));

    // Open RX capture PCM (outside pcm_mtx — it's a blocking call)
    struct pcm* rx_pcm = open_rx_pcm_with_retry();
    if (!rx_pcm) {
        LOGE("voice_rx: failed to open rx pcm");
        opus_encoder_destroy(enc);
        return;
    }
    {
        std::lock_guard<std::mutex> lk(g_voice.pcm_mtx);
        g_voice.rx_pcm = rx_pcm;
    }

    std::vector<int16_t> pcm_buf(FRAME_SAMPLES);
    std::vector<uint8_t> opus_buf(MAX_PKT);

    while (g_voice.active.load()) {
        // pcm_read blocks for one period (~20ms). Read outside pcm_mtx.
        int r;
        {
            std::lock_guard<std::mutex> lk(g_voice.pcm_mtx);
            if (!g_voice.rx_pcm) break;
            r = pcm_read(g_voice.rx_pcm, pcm_buf.data(), FRAME_SAMPLES * 2);
        }
        if (r != 0) {
            LOGW("voice_rx: pcm_read error");
            usleep(20000);
            continue;
        }

        opus_int32 len = opus_encode(enc, pcm_buf.data(), FRAME_SAMPLES,
                                     opus_buf.data(), MAX_PKT);
        if (len > 0) {
            if (!send_frame(net, T_SPEAKER, opus_buf.data(), (uint32_t)len)) break;
        }
    }

    {
        std::lock_guard<std::mutex> lk(g_voice.pcm_mtx);
        g_voice.rx_pcm = nullptr;
    }
    pcm_close(rx_pcm);
    opus_encoder_destroy(enc);
    LOGI("voice_rx_thread exited");
}
```

Note: `send_frame` takes `(mbedtls_net_context*, type, data, len)` — pass `net` which is `&g_net`.

- [ ] **Step 11: Add voice_call_start() and voice_call_stop()**

```cpp
static void voice_call_start(int sim_slot) {
    bool expected = false;
    if (!g_voice.active.compare_exchange_strong(expected, true)) {
        LOGW("voice_call_start: already active (sim=%d)", g_voice.sim_slot);
        return;
    }
    g_voice.sim_slot = sim_slot;
    LOGI("voice_call_start: sim=%d", sim_slot);

    if (!setup_incall_mixer(sim_slot)) {
        LOGE("voice_call_start: mixer setup failed");
        g_voice.active.store(false);
        return;
    }

    // Open TX PCM outside pcm_mtx (blocking)
    struct pcm_config tx_cfg = {};
    tx_cfg.channels    = 1;
    tx_cfg.rate        = SAMPLE_RATE;
    tx_cfg.period_size = FRAME_SAMPLES;
    tx_cfg.period_count = 4;
    tx_cfg.format      = PCM_FORMAT_S16_LE;

    struct pcm* tx_pcm = open_pcm_with_retry(g_cfg.pcm_card, g_cfg.pcm_tx_device,
                                              PCM_OUT, &tx_cfg);
    if (!tx_pcm) {
        LOGE("voice_call_start: failed to open tx pcm (card=%d dev=%d)",
             g_cfg.pcm_card, g_cfg.pcm_tx_device);
        reset_incall_mixer();
        g_voice.active.store(false);
        return;
    }
    {
        std::lock_guard<std::mutex> lk(g_voice.pcm_mtx);
        g_voice.tx_pcm = tx_pcm;
    }

    g_voice.tx_thread = std::thread(voice_tx_thread);
    g_voice.rx_thread = std::thread(voice_rx_thread, &g_net);
    LOGI("voice call threads started");
}

static void voice_call_stop() {
    if (!g_voice.active.exchange(false)) return;
    LOGI("voice_call_stop");

    g_voice.queue_cv.notify_all();

    // Join threads BEFORE closing PCM
    if (g_voice.tx_thread.joinable()) g_voice.tx_thread.join();
    if (g_voice.rx_thread.joinable())  g_voice.rx_thread.join();

    // Now safe to close PCM (threads have exited)
    struct pcm* tx_pcm;
    struct pcm* rx_pcm;
    {
        std::lock_guard<std::mutex> lk(g_voice.pcm_mtx);
        tx_pcm = g_voice.tx_pcm;
        rx_pcm = g_voice.rx_pcm;
        g_voice.tx_pcm = nullptr;
        g_voice.rx_pcm = nullptr;
    }
    if (tx_pcm) pcm_close(tx_pcm);
    if (rx_pcm) pcm_close(rx_pcm);

    reset_incall_mixer();
    g_voice.tx_queue.clear();
    LOGI("voice_call_stop complete");
}
```

- [ ] **Step 12: Add handle_java_ipc_message()**

This function is called from `read_java_client()` before (or instead of) queueing to `g_status_queue`. It intercepts events that should trigger local state changes without going to the server, OR tags events for specific server frame types.

```cpp
static void handle_java_ipc_message(const char* json_str, size_t len) {
    // call_state events trigger voice PCM start/stop AND go to server as T_CALL_STATUS
    if (strstr(json_str, "\"type\":\"call_state\"")) {
        const char* state_tag = strstr(json_str, "\"state\"");
        if (state_tag) {
            if (strstr(state_tag, "\"active\"")) {
                int sim = 0;
                const char* sim_tag = strstr(json_str, "\"sim\"");
                if (sim_tag) {
                    const char* colon = strchr(sim_tag, ':');
                    if (colon) sim = (int)strtol(colon + 1, nullptr, 10);
                }
                voice_call_start(sim);
            } else if (strstr(state_tag, "\"idle\"") ||
                       strstr(state_tag, "\"rejected\"")) {
                voice_call_stop();
            }
        }
        // Fall through: still forward to server as T_CALL_STATUS
        std::lock_guard<std::mutex> lk(g_status_mutex);
        g_status_queue.push(std::string(json_str, len));
        g_status_pending = true;
        g_status_cv.notify_one();
        return;
    }

    // device_info and device_status → forward to server (status_sender_thread routes to correct frame type)
    if (strstr(json_str, "\"type\":\"device_info\"") ||
        strstr(json_str, "\"type\":\"device_status\"")) {
        std::lock_guard<std::mutex> lk(g_status_mutex);
        g_status_queue.push(std::string(json_str, len));
        g_status_pending = true;
        g_status_cv.notify_one();
        return;
    }

    // Everything else: queue normally for T_SMS or T_CALL_STATUS routing
    {
        std::lock_guard<std::mutex> lk(g_status_mutex);
        g_status_queue.push(std::string(json_str, len));
        g_status_pending = true;
    }
    g_status_cv.notify_one();
}
```

- [ ] **Step 13: Update read_java_client() to call handle_java_ipc_message()**

In `read_java_client()`, replace the direct queue push block:
```cpp
// Before:
        {
            std::lock_guard<std::mutex> lk(g_status_mutex);
            g_status_queue.push(std::string(line, len));
            g_status_pending = true;
        }
        g_status_cv.notify_one();

// After:
        handle_java_ipc_message(line, len);
```

- [ ] **Step 14: Update status_sender_thread() to route T_DEVICE_INFO/STATUS**

In `status_sender_thread()`, replace the frame type routing:
```cpp
// Before:
            uint8_t frame_type = T_CALL_STATUS;
            if (json_str.find("\"type\":\"sms") != std::string::npos) {
                frame_type = T_SMS;
            }

// After:
            uint8_t frame_type = T_CALL_STATUS;
            if (json_str.find("\"type\":\"sms") != std::string::npos) {
                frame_type = T_SMS;
            } else if (json_str.find("\"type\":\"device_info\"") != std::string::npos) {
                frame_type = T_DEVICE_INFO;
            } else if (json_str.find("\"type\":\"device_status\"") != std::string::npos) {
                frame_type = T_DEVICE_STATUS;
            }
```

- [ ] **Step 15: Update receive_virtual_mic_thread() — remove SHM, add enqueue_tx_opus_frame, request device_status on PING**

In `receive_virtual_mic_thread()`:

1. Remove the `auto* layout = (SharedMemoryLayout*)g_shm_ptr;` line
2. Replace the T_VIRTUAL_MIC SHM write block with:
```cpp
        // Handle Audio (Virtual Mic) — enqueue to voice TX jitter buffer
        if (type == T_VIRTUAL_MIC) {
            if (len > 0 && g_voice.active.load()) {
                enqueue_tx_opus_frame(pkt.data(), (int)len);
            }
            continue;
        }
```

3. After `if(type == T_PONG) continue;`, add device_status request on PING:
```cpp
        if (type == T_PING) {
            // Update heartbeat timestamp
            g_last_pong.store(time(nullptr));
            // Send T_PONG
            send_frame(net, T_PONG, nullptr, 0);
            // Request fresh device status from APK
            send_to_java("{\"command\":\"get_device_status\"}");
            continue;
        }
```

Wait — the current code has the server sending T_PING and daemon responding with T_PONG. But looking at the code again: the daemon's watchdog sends T_PING to server, and server sends T_PONG back. T_PONG is received in `receive_virtual_mic_thread`.

But looking at `server/main.py` line 473-474:
```python
elif t == T_PING:
    await device.send_frame(T_PONG, b"")
```

So server receives daemon's T_PING and sends T_PONG. The daemon sends T_PING (in the watchdog) and receives T_PONG (in `receive_virtual_mic_thread`). 

But the device_status should be requested when the server sends T_PING. Wait — looking at the spec again: T_DEVICE_STATUS should be sent "on T_PING receipt". But the server currently sends T_PONG in response to T_PING (which the daemon initiates). 

Actually, the spec says: "piggybacked on T_PING". The intended flow is:
1. Daemon sends T_PING to server every 15s
2. Server responds with T_PONG
3. When daemon receives T_PONG, it requests device_status from APK
4. APK sends device_status back via IPC
5. Daemon forwards it as T_DEVICE_STATUS to server

Actually even simpler: when daemon sends T_PING, it ALSO requests device_status from APK. Then APK responds, daemon gets it, sends T_DEVICE_STATUS. No need to wait for T_PONG.

Change approach: in the watchdog loop (main()), when sending T_PING, also send `get_device_status` to APK. Update the watchdog:

In `main()` watchdog loop, after `send_frame(&g_net, T_PING, nullptr, 0)`:
```cpp
            // Request device status from APK to send alongside ping
            send_to_java("{\"command\":\"get_device_status\"}");
```

And for T_PONG in `receive_virtual_mic_thread`: just update `g_last_pong`.

4. In `receive_virtual_mic_thread` T_CONTROL handling, add `set_sim_filter` and `get_device_info` forwarding:
```cpp
            if(cmd == "set_sim_filter") {
                // Forward to Java APK via IPC
                send_to_java(json_str.c_str());
                LOGI("Forwarded set_sim_filter to APK");
            } else if(cmd == "get_device_info") {
                send_to_java("{\"command\":\"get_device_info\"}");
            } else if (existing cmd == "dial") {
                // ... existing handling
```

Note: `send_to_java()` takes a `SimpleJson` currently — we need either a string overload or to use SimpleJson to construct the forwarded command. The cleanest approach: add `send_to_java_raw(const char* json_str)` that writes directly to the Java IPC fd:

```cpp
static std::atomic<int> g_java_fd{-1};

static void send_to_java_raw(const char* json_str) {
    int fd = g_java_fd.load();
    if (fd < 0) return;
    size_t len = strlen(json_str);
    // Write json + newline atomically
    std::string msg = std::string(json_str) + "\n";
    ssize_t r = write(fd, msg.c_str(), msg.size());
    (void)r;
}
```

Use `send_to_java_raw` for forwarding `set_sim_filter` and `get_device_status`.

- [ ] **Step 16: Add TLS support to daemon (optional, when use_tls = true)**

Add TLS globals after mbedtls includes:
```cpp
static mbedtls_ssl_context  g_ssl;
static mbedtls_ssl_config   g_ssl_cfg;
static mbedtls_entropy_context g_entropy;
static mbedtls_ctr_drbg_context g_ctr_drbg;
static bool                 g_tls_active = false;
```

Add `tls_setup()` and `tls_do_handshake()` functions:
```cpp
static bool tls_setup() {
    mbedtls_ssl_init(&g_ssl);
    mbedtls_ssl_config_init(&g_ssl_cfg);
    mbedtls_entropy_init(&g_entropy);
    mbedtls_ctr_drbg_init(&g_ctr_drbg);
    const char* seed = "audio-bridge-4.0";
    int r = mbedtls_ctr_drbg_seed(&g_ctr_drbg, mbedtls_entropy_func, &g_entropy,
                                    (const uint8_t*)seed, strlen(seed));
    if (r) { LOGE("TLS: ctr_drbg_seed: -0x%04x", -r); return false; }
    r = mbedtls_ssl_config_defaults(&g_ssl_cfg, MBEDTLS_SSL_IS_CLIENT,
                                     MBEDTLS_SSL_TRANSPORT_STREAM,
                                     MBEDTLS_SSL_PRESET_DEFAULT);
    if (r) { LOGE("TLS: config_defaults: -0x%04x", -r); return false; }
    mbedtls_ssl_conf_authmode(&g_ssl_cfg, MBEDTLS_SSL_VERIFY_NONE);
    mbedtls_ssl_conf_rng(&g_ssl_cfg, mbedtls_ctr_drbg_random, &g_ctr_drbg);
    r = mbedtls_ssl_setup(&g_ssl, &g_ssl_cfg);
    if (r) { LOGE("TLS: ssl_setup: -0x%04x", -r); return false; }
    mbedtls_ssl_set_bio(&g_ssl, &g_net, mbedtls_net_send, mbedtls_net_recv, nullptr);
    return true;
}

static bool tls_do_handshake() {
    int r;
    while ((r = mbedtls_ssl_handshake(&g_ssl)) != 0) {
        if (r != MBEDTLS_ERR_SSL_WANT_READ && r != MBEDTLS_ERR_SSL_WANT_WRITE) {
            LOGE("TLS: handshake failed: -0x%04x", -r);
            return false;
        }
    }
    LOGI("TLS: handshake OK (%s)", mbedtls_ssl_get_ciphersuite(&g_ssl));
    return true;
}
```

In `tcp_connect()`, after `mbedtls_net_connect()` succeeds, if `g_cfg.use_tls`:
```cpp
    if (g_cfg.use_tls) {
        if (!tls_setup() || !tls_do_handshake()) {
            tcp_cleanup(); return false;
        }
        g_tls_active = true;
        LOGI("TLS active");
    }
```

In `send_all()`, make the write conditional:
```cpp
        int n;
        if (g_tls_active)
            n = mbedtls_ssl_write(&g_ssl, p, len);
        else
            n = mbedtls_net_send(&g_net, p, len);
```

In `recv_all()`, similarly:
```cpp
        int n;
        if (g_tls_active)
            n = mbedtls_ssl_read(&g_ssl, p, len);
        else
            n = mbedtls_net_recv(&g_net, p, len);
```

In `tcp_cleanup()`, add TLS cleanup:
```cpp
    if (g_tls_active) {
        mbedtls_ssl_close_notify(&g_ssl);
        mbedtls_ssl_free(&g_ssl);
        mbedtls_ssl_config_free(&g_ssl_cfg);
        mbedtls_ctr_drbg_free(&g_ctr_drbg);
        mbedtls_entropy_free(&g_entropy);
        g_tls_active = false;
    }
```

- [ ] **Step 17: Add nonce to handshake() HMAC**

In `handshake()`, find where `reg.object_value["hmac"]` is set. Add a nonce field:
```cpp
    // Generate a random nonce (16 bytes → 32 hex chars)
    char nonce_hex[33] = {};
    for (int i = 0; i < 16; i++) {
        // Use mbedtls_ctr_drbg if available, otherwise simple rand()
        snprintf(nonce_hex + i*2, 3, "%02x", (unsigned)(rand() & 0xFF));
    }
    reg.object_value["nonce"] = SimpleJson(nonce_hex);

    // HMAC message: "dev_id-date-nonce"
    std::string hmac_msg = dev_id + "-" + date_str + "-" + nonce_hex;
    // ... compute HMAC over hmac_msg (not just dev_id + "-" + date_str) ...
```

Find the existing HMAC computation and update the message string. The existing code probably does:
```cpp
std::string msg = dev_id + "-" + date_str;
```
Change to:
```cpp
std::string msg = dev_id + "-" + date_str + "-" + nonce_hex;
```

- [ ] **Step 18: Update main() — config loading, remove SHM, fix watchdog**

In `main()`:

1. Replace `/data/local/tmp/audio_bridge.conf` reading with `config.json` loading:
```cpp
    // Replace the old conf-file reading block with:
    static char config_path[512] = "/data/adb/modules/audio_bridge/files/config.json";
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--config") && i + 1 < argc) {
            strncpy(config_path, argv[++i], sizeof(config_path) - 1);
        }
        // ... other arg parsing ...
    }
    load_config_json(config_path);
    if (g_cfg.host[0]) g_host = g_cfg.host;
    if (g_cfg.port) g_port = g_cfg.port;
    if (g_cfg.token[0]) g_token = g_cfg.token;
```

2. Remove `setup_shared_memory()` call and the `layout->module_active` log line

3. Remove `tinyalsa_thread` (the `std::thread tinyalsa_thread(tinyalsa_mic_inject_thread)` line)

4. Fix the heartbeat watchdog: replace 10s ping with 15s + 90s pong timeout:
```cpp
        // Initialize g_last_pong at connect time (NOT 0 which would fire immediately)
        g_last_pong.store(time(nullptr));

        // Worker threads
        std::thread status_thread(status_sender_thread, &g_net);
        std::thread mic_thread(receive_virtual_mic_thread, &g_net);
        // Note: speaker capture is now done by voice_rx_thread (started on call)

        // Heartbeat watchdog
        while (g_running && g_connected) {
            sleep(15);
            if (!g_connected) break;

            // Check pong timeout (90s)
            time_t now = time(nullptr);
            if (now - g_last_pong.load() > 90) {
                LOGW("Heartbeat timeout (90s without pong), disconnecting");
                g_connected = false;
                g_status_cv.notify_all();
                break;
            }

            if (!send_frame(&g_net, T_PING, nullptr, 0)) {
                LOGW("Ping send failed, disconnecting");
                g_connected = false;
                g_status_cv.notify_all();
                break;
            }
            // Request device status from APK alongside every ping
            send_to_java_raw("{\"command\":\"get_device_status\"}");
        }

        voice_call_stop();  // ensure voice threads are stopped before joining
        status_thread.join();
        mic_thread.join();
```

5. Replace the config re-read loop (which reads `audio_bridge.conf`) with `config.json` re-read:
```cpp
        if (!g_cfg.host[0]) {
            load_config_json(config_path);
            if (!g_cfg.host[0]) {
                sleep(5);
                continue;
            }
            g_host = g_cfg.host;
            g_port = g_cfg.port;
            if (g_cfg.token[0]) g_token = g_cfg.token;
            LOGI("Config loaded: host=%s port=%d", g_host, g_port);
        }
```

6. Also: remove the token initialization `g_token = "default_secure_token_123"` at line 69. The token must come from config.json or fail:
```cpp
// Replace:
static const char* g_token = "default_secure_token_123";

// With:
static const char* g_token = nullptr;  // required: set from config.json
```

And add a startup check: if `g_cfg.token[0] == '\0'`, log an error and use empty token (handshake will fail on server if server also requires token).

- [ ] **Step 19: Delete functions that no longer exist**

Delete these entire function bodies:
- `setup_shared_memory()` — SHM no longer used
- `capture_speaker_thread()` — replaced by `voice_rx_thread()`
- `read_java_audio_stream()` — binary audio socket no longer used
- `tinyalsa_mic_inject_thread()` and `find_voice_pcm_dev()` — replaced by structured `voice_tx_thread()`
- All `jni_*` functions (`jni_place_call`, `jni_end_call`, etc.) that call `jni_helper()` via JNI — the daemon no longer does JNI; it uses `send_to_java_raw()` for APK control
- `Java_com_audiobridge_*` JNI callbacks — APK now uses IPC JSON exclusively

Also remove the `unix_socket_server_thread()`'s HELO_AUDIO handling:
- Find the `HELO_AUDIO` branch in `unix_socket_server_thread()` and remove it
- Keep only the `HELO_JAVA` branch (the IPC JSON channel)

- [ ] **Step 20: Verify compilation with build.sh**

After all changes, push to trigger CI build and verify there are no compilation errors. The build will use NDK r27c and the updated flags.

**Expected:** CI passes with no errors. Watch for:
- Missing includes (`tinyalsa/mixer.h` should be covered by `asoundlib.h`)
- Undefined references (check that all deleted functions are not called anywhere)
- Type errors in VoiceCallContext usage

- [ ] **Step 21: Commit**

```bash
git add jni/audio_bridge.cpp
git commit -m "daemon: add voice PCM injection (PCM 27 TX, PCM 0 RX), VoiceCallContext, nonce HMAC, TLS, config.json, heartbeat 90s timeout"
```

---

## Task 6: Server Updates (main.py + certs)

**Files:**
- Modify: `server/main.py`
- Create: `server/.env.example`
- Create: `server/generate-certs.sh`

**Interfaces:**
- Consumes: T_DEVICE_INFO (0x08) / T_DEVICE_STATUS (0x09) frames from daemon; WS command `{"command":"set_sim_filter","device_id":"...","allowed_sims":[0]}` from dashboard
- Produces: T_CONTROL `{"command":"set_sim_filter","allowed_sims":[0]}` to daemon; broadcasts `{"type":"event","kind":"device_info",...}` and `{"type":"event","kind":"device_status",...}` to UI WebSocket clients

- [ ] **Step 1: Write failing tests for server security**

Create/append to `server/test_server.py`:
```python
import hmac
import hashlib
import json
import os
import pytest

os.environ["AUDIO_BRIDGE_TOKEN"] = "test_token_abc"

from server.main import do_handshake_sync, verify_ws_token, AUTH_TOKEN

# These are stub tests — actual server requires running process for WS tests.
# These test the pure functions.

def make_hmac(dev_id, date, nonce, token="test_token_abc"):
    msg = f"{dev_id}-{date}-{nonce}".encode()
    return hmac.new(token.encode(), msg, hashlib.sha256).hexdigest()

def test_hmac_valid():
    h = make_hmac("dev1", "20-06-26", "abc123nonce")
    # Server verify_handshake_hmac should return True
    from server.main import verify_handshake_hmac
    assert verify_handshake_hmac("dev1", "20-06-26", h, "abc123nonce")

def test_hmac_invalid_nonce():
    h = make_hmac("dev1", "20-06-26", "abc123nonce")
    from server.main import verify_handshake_hmac
    assert not verify_handshake_hmac("dev1", "20-06-26", h, "wrong_nonce")

def test_nonce_replay():
    from server.main import verify_handshake_hmac, _nonce_cache
    _nonce_cache.clear()
    nonce = "unique_nonce_1"
    h = make_hmac("dev1", "20-06-26", nonce)
    assert verify_handshake_hmac("dev1", "20-06-26", h, nonce)
    # Second call with same nonce should fail
    h2 = make_hmac("dev1", "20-06-26", nonce)
    assert not verify_handshake_hmac("dev1", "20-06-26", h2, nonce)

def test_ws_token_valid():
    from server.main import verify_ws_token
    assert verify_ws_token("test_token_abc")

def test_ws_token_invalid():
    from server.main import verify_ws_token
    assert not verify_ws_token("wrong_token")

def test_token_missing_env(monkeypatch):
    monkeypatch.delenv("AUDIO_BRIDGE_TOKEN", raising=False)
    import importlib, server.main as m
    # Should raise on import or have a None/empty token
    # Exact behavior depends on implementation
```

Run: `cd server && python -m pytest test_server.py -v`
Expected: FAIL (functions don't exist yet)

- [ ] **Step 2: Remove hardcoded token default and add startup validation**

In `server/main.py`, replace line 99:
```python
# Before:
AUTH_TOKEN = os.environ.get("AUDIO_BRIDGE_TOKEN", "default_secure_token_123")

# After:
AUTH_TOKEN = os.environ.get("AUDIO_BRIDGE_TOKEN", "")
if not AUTH_TOKEN:
    raise RuntimeError(
        "AUDIO_BRIDGE_TOKEN environment variable is required. "
        "Generate one with: python3 -c \"import secrets; print(secrets.token_urlsafe(32))\""
    )
```

- [ ] **Step 3: Add T_DEVICE_INFO and T_DEVICE_STATUS constants**

In `server/main.py`, replace line 97:
```python
# Before:
T_SPEAKER, T_VIRTUAL_MIC, T_CONTROL, T_CALL_STATUS, T_SMS, T_PING, T_PONG = range(1, 8)

# After:
T_SPEAKER, T_VIRTUAL_MIC, T_CONTROL, T_CALL_STATUS, T_SMS, T_PING, T_PONG = range(1, 8)
T_DEVICE_INFO   = 8
T_DEVICE_STATUS = 9
```

- [ ] **Step 4: Add nonce replay protection and verify_handshake_hmac()**

In `server/main.py`, add after AUTH_TOKEN:
```python
import time as _time

_nonce_cache: dict = {}   # nonce_hex → expiry float

def _purge_nonces() -> None:
    now = _time.time()
    expired = [k for k, v in _nonce_cache.items() if v < now]
    for k in expired:
        del _nonce_cache[k]

def verify_handshake_hmac(dev_id: str, date: str, recv_hmac: str, nonce: str) -> bool:
    """Verify HMAC and reject replayed nonces."""
    if not nonce:
        return False
    _purge_nonces()
    if nonce in _nonce_cache:
        log.warning("HMAC replay detected: nonce=%s", nonce)
        return False
    _nonce_cache[nonce] = _time.time() + 60.0
    msg = f"{dev_id}-{date}-{nonce}".encode()
    expected = hmac.new(AUTH_TOKEN.encode(), msg, hashlib.sha256).hexdigest()
    return hmac.compare_digest(recv_hmac, expected)

def verify_ws_token(token: str) -> bool:
    """Verify bearer token for WebSocket connections."""
    if not token or not AUTH_TOKEN:
        return False
    return hmac.compare_digest(token, AUTH_TOKEN)
```

Update `do_handshake()` to use the new function:
```python
async def do_handshake(reader: asyncio.StreamReader) -> Optional[dict]:
    line = await asyncio.wait_for(reader.readuntil(b"\n"), timeout=10.0)
    info = json.loads(line.decode())
    dev_id = info.get("id", "")
    date   = info.get("date", "")
    nonce  = info.get("nonce", "")
    recv_hmac = info.get("hmac", "")
    if not verify_handshake_hmac(dev_id, date, recv_hmac, nonce):
        log.warning("Handshake HMAC failed for device %s (nonce=%s)", dev_id, nonce)
        return None
    return info
```

- [ ] **Step 5: Add WebSocket auth to /ws/ui**

In `server/main.py`, update `ws_ui()`:
```python
@app.websocket("/ws/ui")
async def ws_ui(ws: WebSocket) -> None:
    token = ws.query_params.get("token", "") or \
            ws.headers.get("authorization", "").removeprefix("Bearer ")
    if not verify_ws_token(token):
        await ws.close(code=4401, reason="Unauthorized")
        return
    await mgr.connect_ui(ws)
    try:
        while True:
            data = await ws.receive_json()
            # ... existing command handling ...
```

- [ ] **Step 6: Add WebSocket auth to /ws/audio/{device_id} (if endpoint exists)**

Search `server/main.py` for `/ws/audio`. If the endpoint exists, add the same auth check before `await ws.accept()`.

- [ ] **Step 7: Fix SMS routing**

In `handle_device()`, find the T_SMS block (around line 461-470):
```python
# Before:
            elif t == T_SMS:
                try:
                    sms = json.loads(data.decode())
                    kind = sms.get("event", "sms_event")   # ← BUG: uses "event" key
                    await mgr.broadcast_event({
                        "type": "event",
                        "kind": kind,
                        ...
                    })

# After:
            elif t == T_SMS:
                try:
                    sms = json.loads(data.decode())
                    # APK v4 sends {"type":"sms","ver":1,"from":"...","body":"...","sim_slot":N,...}
                    kind = sms.get("type", sms.get("event", "sms_event"))
                    await mgr.broadcast_event({
                        "type": "event",
                        "kind": "sms",
                        "device_id": device.id,
                        "data": sms,
                    })
                except Exception as e:
                    log.debug("sms parse: %s", e)
```

- [ ] **Step 8: Add device_info field to Device class and handle T_DEVICE_INFO/STATUS**

In the `Device` class, add:
```python
        self.device_info: dict = {}   # latest T_DEVICE_INFO payload
        self.device_status: dict = {} # latest T_DEVICE_STATUS payload
```

In `_state()`, include device_info/status:
```python
                {
                    "id": d.id,
                    "name": d.name,
                    "brand": d.brand,
                    "android": d.android,
                    "call": {...},
                    "device_info": d.device_info,
                    "device_status": d.device_status,
                }
```

In `handle_device()`, add T_DEVICE_INFO and T_DEVICE_STATUS handling in the main frame loop (after T_PONG handling):
```python
            elif t == T_DEVICE_INFO:
                try:
                    info = json.loads(data.decode())
                    device.device_info = info
                    await mgr.broadcast_event({
                        "type": "event",
                        "kind": "device_info",
                        "device_id": device.id,
                        "data": info,
                    })
                    log.info("Device info from %s: model=%s android=%s",
                             device.id, info.get("model"), info.get("android_version"))
                except Exception as e:
                    log.debug("device_info parse: %s", e)
            elif t == T_DEVICE_STATUS:
                try:
                    status = json.loads(data.decode())
                    device.device_status = status
                    await mgr.broadcast_event({
                        "type": "event",
                        "kind": "device_status",
                        "device_id": device.id,
                        "data": status,
                    })
                except Exception as e:
                    log.debug("device_status parse: %s", e)
```

Also add T_PING handling that responds with T_PONG:
```python
            elif t == T_PING:
                await device.send_frame(T_PONG, b"")
```

(This already exists as `elif t == T_PING` — verify it's there.)

- [ ] **Step 9: Add set_sim_filter command in ws_ui**

In `ws_ui()` command handler, add:
```python
                elif cmd == "set_sim_filter":
                    allowed = data.get("allowed_sims", [0, 1])
                    await d.send_control("set_sim_filter", allowed_sims=allowed)
                elif cmd == "get_device_info":
                    await d.send_control("get_device_info")
```

- [ ] **Step 10: Add TLS support to TCP listener**

In `start_tcp()`:
```python
async def start_tcp() -> None:
    ssl_ctx = None
    cert_file = os.environ.get("SSL_CERT_FILE")
    key_file  = os.environ.get("SSL_KEY_FILE")
    if cert_file and key_file:
        import ssl as _ssl
        ssl_ctx = _ssl.SSLContext(_ssl.PROTOCOL_TLS_SERVER)
        ssl_ctx.load_cert_chain(cert_file, key_file)
        log.info("TLS enabled on TCP port %d (cert=%s)", TCP_PORT, cert_file)

    srv = await asyncio.start_server(handle_device, "0.0.0.0", TCP_PORT, ssl=ssl_ctx)
    log.info("TCP on :%d (HMAC auth + nonce, Opus@48k)", TCP_PORT)
    async with srv:
        await srv.serve_forever()
```

- [ ] **Step 11: Run tests**

```bash
cd server
AUDIO_BRIDGE_TOKEN=test_token_abc python -m pytest test_server.py -v
```

Expected: all tests pass

- [ ] **Step 12: Create server/.env.example**

Create `server/.env.example`:
```
# Generate a secure token:
# python3 -c "import secrets; print(secrets.token_urlsafe(32))"
AUDIO_BRIDGE_TOKEN=<replace_with_generated_token>

AUDIO_BRIDGE_TCP_PORT=59100
AUDIO_BRIDGE_HTTP_PORT=8000

# Optional TLS (run server/generate-certs.sh first):
# SSL_CERT_FILE=server.crt
# SSL_KEY_FILE=server.key
```

- [ ] **Step 13: Create server/generate-certs.sh**

Create `server/generate-certs.sh`:
```bash
#!/bin/bash
set -e
cd "$(dirname "$0")"

openssl req -x509 -newkey rsa:4096 -keyout server.key -out server.crt \
    -days 365 -nodes -subj "/CN=audio-bridge"

echo ""
echo "Certificate fingerprint (add to config.json as server_cert_sha256):"
openssl x509 -noout -fingerprint -sha256 -in server.crt | \
    sed 's/SHA256 Fingerprint=//' | tr -d ':' | tr '[:upper:]' '[:lower:]'
echo ""
echo "Add to .env:"
echo "  SSL_CERT_FILE=$(pwd)/server.crt"
echo "  SSL_KEY_FILE=$(pwd)/server.key"
```

Make it executable:
```bash
chmod +x server/generate-certs.sh
```

Add `server/server.crt` and `server/server.key` to `.gitignore` if not already there.

- [ ] **Step 14: Commit**

```bash
git add server/main.py server/.env.example server/generate-certs.sh
git commit -m "server: WS auth, HMAC nonce replay protection, SMS fix, T_DEVICE_INFO/STATUS, SIM filter, TLS"
```

---

## Task 7: Dashboard (server/dashboard.html)

**Files:**
- Create: `server/dashboard.html`

**Interfaces:**
- Consumes: WS events `{"type":"state_update","devices":[...]}`, `{"type":"event","kind":"device_info","data":{...}}`, `{"type":"event","kind":"device_status","data":{...}}`, `{"type":"event","kind":"sms","data":{"from":"...","body":"...","sim_slot":0,"sim_carrier":"Viettel",...}}`
- Produces: WS commands `{"command":"set_sim_filter","device_id":"...","allowed_sims":[0,1]}`, `{"command":"dial","device_id":"...","number":"..."}`, etc.

- [ ] **Step 1: Create dashboard.html**

Create `server/dashboard.html` as a complete single-file HTML dashboard. The file must:

1. Connect to `/ws/ui?token=<TOKEN_FROM_URL_HASH>` — token is in the URL hash (`#token=XXX`) to avoid logging in server access logs
2. Show a **Device Panel** with: model, manufacturer, Android version, ROM (Build.DISPLAY), SIM list (slot, carrier, number), module version
3. Show **Battery & Signal** row: `🔋 87% (charging)` — `📶 SIM1 Viettel LTE ████░` — `📶 SIM2 Unregistered 0 bars`
4. Show **SIM Filter** dropdown: `Accept all` / `SIM 1 only` / `SIM 2 only` / `Reject all` — sends `set_sim_filter` on change
5. Show **Call Controls**: dial input + Dial/Hangup/Answer buttons
6. Show **SMS Feed**: list of SMS events with `[SIM 1 · Viettel]` badge + sender + body + timestamp
7. Show **Connection status**: Connected / Disconnected badge with WebSocket state

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Audio Bridge</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
  .header { background: #1e293b; padding: 12px 20px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #334155; }
  .header h1 { font-size: 1.1rem; font-weight: 600; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
  .badge-green { background: #166534; color: #86efac; }
  .badge-red { background: #7f1d1d; color: #fca5a5; }
  .badge-gray { background: #374151; color: #9ca3af; }
  .badge-blue { background: #1e3a5f; color: #93c5fd; }
  .badge-sim { background: #1e3a5f; color: #93c5fd; font-size: 0.7rem; padding: 1px 6px; }
  .container { max-width: 900px; margin: 0 auto; padding: 20px; display: grid; gap: 16px; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px; }
  .card-title { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; margin-bottom: 10px; font-weight: 600; }
  .info-row { display: flex; gap: 16px; flex-wrap: wrap; }
  .info-item { flex: 1; min-width: 120px; }
  .info-label { font-size: 0.7rem; color: #64748b; margin-bottom: 2px; }
  .info-value { font-size: 0.85rem; color: #e2e8f0; }
  .sim-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
  .sim-card { background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 8px 12px; flex: 1; min-width: 140px; }
  .sim-name { font-size: 0.75rem; font-weight: 600; color: #93c5fd; }
  .sim-detail { font-size: 0.7rem; color: #64748b; margin-top: 2px; }
  .signal-bars { display: inline-flex; gap: 2px; align-items: flex-end; margin-left: 4px; }
  .bar { width: 4px; border-radius: 1px; background: #334155; }
  .bar.lit { background: #22c55e; }
  .battery-row { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; }
  .controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  input[type=text], select { background: #0f172a; border: 1px solid #334155; color: #e2e8f0; border-radius: 6px; padding: 6px 10px; font-size: 0.85rem; }
  input[type=text] { flex: 1; min-width: 160px; }
  button { padding: 6px 14px; border-radius: 6px; border: none; font-size: 0.85rem; font-weight: 600; cursor: pointer; }
  .btn-green { background: #166534; color: #86efac; }
  .btn-red { background: #7f1d1d; color: #fca5a5; }
  .btn-blue { background: #1e3a5f; color: #93c5fd; }
  .btn-gray { background: #374151; color: #e2e8f0; }
  .sms-list { display: flex; flex-direction: column; gap: 8px; max-height: 320px; overflow-y: auto; }
  .sms-item { background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 10px; }
  .sms-meta { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; flex-wrap: wrap; }
  .sms-sender { font-size: 0.8rem; font-weight: 600; color: #93c5fd; }
  .sms-time { font-size: 0.7rem; color: #64748b; margin-left: auto; }
  .sms-body { font-size: 0.82rem; color: #cbd5e1; word-break: break-word; }
  .token-prompt { display: flex; gap: 8px; align-items: center; }
  .device-selector { font-size: 0.82rem; color: #94a3b8; }
  .filter-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .dot-green { background: #22c55e; }
  .dot-red { background: #ef4444; }
  .dot-yellow { background: #eab308; }
</style>
</head>
<body>

<div class="header">
  <h1>🔊 Audio Bridge</h1>
  <span id="conn-badge" class="badge badge-gray">Disconnected</span>
  <span id="call-badge" class="badge badge-gray" style="margin-left:4px">IDLE</span>
  <span style="flex:1"></span>
  <select id="device-select" class="device-selector" style="background:#0f172a;border:1px solid #334155;color:#94a3b8;border-radius:4px;padding:4px 8px;font-size:0.8rem;">
    <option value="">No device</option>
  </select>
</div>

<div class="container">

  <!-- Token prompt (shown when no token in URL hash) -->
  <div id="token-prompt-card" class="card" style="display:none">
    <div class="card-title">Authentication</div>
    <div class="token-prompt">
      <input type="text" id="token-input" placeholder="Paste AUDIO_BRIDGE_TOKEN here">
      <button class="btn-blue" onclick="connectWithToken()">Connect</button>
    </div>
    <div style="font-size:0.75rem;color:#64748b;margin-top:6px">
      Token will be stored in URL hash and not sent to server logs.
    </div>
  </div>

  <!-- Device info panel -->
  <div class="card" id="device-panel">
    <div class="card-title">Device</div>
    <div class="info-row">
      <div class="info-item">
        <div class="info-label">Model</div>
        <div class="info-value" id="di-model">—</div>
      </div>
      <div class="info-item">
        <div class="info-label">Android</div>
        <div class="info-value" id="di-android">—</div>
      </div>
      <div class="info-item">
        <div class="info-label">ROM</div>
        <div class="info-value" id="di-rom">—</div>
      </div>
    </div>
    <div class="sim-row" id="sim-list"></div>
  </div>

  <!-- Battery + signal + SIM filter -->
  <div class="card">
    <div class="card-title">Status & SIM Filter</div>
    <div class="battery-row" id="battery-row">
      <span id="battery-text">🔋 —</span>
      <span id="signal-row"></span>
    </div>
    <div class="filter-row" style="margin-top:12px">
      <label style="font-size:0.82rem;color:#94a3b8">SIM Filter:</label>
      <select id="sim-filter-select">
        <option value="both">Accept all SIMs</option>
        <option value="0">SIM 1 only</option>
        <option value="1">SIM 2 only</option>
        <option value="none">Reject all</option>
      </select>
      <button class="btn-blue" onclick="applySimFilter()">Apply</button>
    </div>
  </div>

  <!-- Call controls -->
  <div class="card">
    <div class="card-title">Call Control</div>
    <div class="controls">
      <input type="text" id="dial-number" placeholder="Phone number">
      <button class="btn-green" onclick="sendCmd('dial',{number:document.getElementById('dial-number').value})">Dial</button>
      <button class="btn-gray" onclick="sendCmd('answer',{})">Answer</button>
      <button class="btn-red" onclick="sendCmd('hangup',{})">Hangup</button>
    </div>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
      <input type="text" id="sms-to" placeholder="To" style="flex:0.5;min-width:120px">
      <input type="text" id="sms-body" placeholder="Message" style="flex:1">
      <button class="btn-blue" onclick="sendSMS()">Send SMS</button>
    </div>
  </div>

  <!-- SMS feed -->
  <div class="card">
    <div class="card-title">SMS Feed</div>
    <div class="sms-list" id="sms-list">
      <div style="color:#64748b;font-size:0.82rem">No messages yet.</div>
    </div>
  </div>

</div>

<script>
let ws = null;
let currentDeviceId = null;
let reconnectTimer = null;

function getToken() {
  const h = window.location.hash.slice(1);
  const p = new URLSearchParams(h);
  return p.get('token') || '';
}

function setToken(t) {
  const h = new URLSearchParams(window.location.hash.slice(1));
  h.set('token', t);
  window.location.hash = h.toString();
}

function connectWithToken() {
  const t = document.getElementById('token-input').value.trim();
  if (!t) return;
  setToken(t);
  document.getElementById('token-prompt-card').style.display = 'none';
  connect();
}

function connect() {
  const token = getToken();
  if (!token) {
    document.getElementById('token-prompt-card').style.display = '';
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/ui?token=${encodeURIComponent(token)}`);
  ws.onopen = () => {
    document.getElementById('conn-badge').textContent = 'Connected';
    document.getElementById('conn-badge').className = 'badge badge-green';
    clearTimeout(reconnectTimer);
  };
  ws.onclose = (e) => {
    document.getElementById('conn-badge').textContent = e.code === 4401 ? 'Auth failed' : 'Disconnected';
    document.getElementById('conn-badge').className = 'badge badge-red';
    if (e.code !== 4401) reconnectTimer = setTimeout(connect, 3000);
  };
  ws.onerror = () => {};
  ws.onmessage = (ev) => {
    try { handleMessage(JSON.parse(ev.data)); } catch(e) {}
  };
}

function handleMessage(msg) {
  if (msg.type === 'state_update') {
    updateDeviceSelect(msg.devices);
    const d = msg.devices.find(d => d.id === currentDeviceId) || msg.devices[0];
    if (d) {
      currentDeviceId = d.id;
      updateCallBadge(d.call);
      if (d.device_info) updateDeviceInfo(d.device_info);
      if (d.device_status) updateDeviceStatus(d.device_status);
    }
  } else if (msg.type === 'event') {
    if (msg.kind === 'device_info') updateDeviceInfo(msg.data);
    else if (msg.kind === 'device_status') updateDeviceStatus(msg.data);
    else if (msg.kind === 'sms') addSmsToFeed(msg.data);
    else if (msg.kind === 'call' && msg.device_id === currentDeviceId) updateCallBadge(msg.data);
  }
}

function updateDeviceSelect(devices) {
  const sel = document.getElementById('device-select');
  const prev = sel.value;
  sel.innerHTML = '';
  devices.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.name || d.id;
    sel.appendChild(opt);
  });
  if (prev && devices.find(d => d.id === prev)) sel.value = prev;
  else if (devices.length > 0) { sel.value = devices[0].id; currentDeviceId = devices[0].id; }
}

function updateCallBadge(call) {
  const b = document.getElementById('call-badge');
  const s = call.state || 'IDLE';
  b.textContent = s + (call.number ? ' ' + call.number : '');
  b.className = 'badge ' + (s === 'ACTIVE' ? 'badge-green' : s === 'RINGING' ? 'badge-blue' : 'badge-gray');
}

function updateDeviceInfo(info) {
  const set = (id, val) => { const el = document.getElementById(id); if(el) el.textContent = val || '—'; };
  set('di-model', (info.manufacturer || '') + ' ' + (info.model || ''));
  set('di-android', 'Android ' + (info.android_version || '?') + ' (SDK ' + (info.sdk_int || '?') + ')');
  set('di-rom', info.rom);

  const simList = document.getElementById('sim-list');
  simList.innerHTML = '';
  (info.sims || []).forEach(s => {
    const div = document.createElement('div');
    div.className = 'sim-card';
    div.innerHTML = `<div class="sim-name">SIM ${s.slot + 1} · ${s.carrier || '?'}</div>
      <div class="sim-detail">${s.number || ''}</div>`;
    simList.appendChild(div);
  });

  // Update SIM filter select default from info.sim_filter
  if (info.sim_filter) {
    const filter = info.sim_filter;
    const sel = document.getElementById('sim-filter-select');
    if (filter.length === 0) sel.value = 'none';
    else if (filter.length >= 2) sel.value = 'both';
    else if (filter[0] === 0) sel.value = '0';
    else if (filter[0] === 1) sel.value = '1';
  }
}

function updateDeviceStatus(status) {
  const bat = status.battery_pct !== undefined ? status.battery_pct + '%' : '—';
  const charging = status.battery_charging ? ' ⚡' : '';
  document.getElementById('battery-text').textContent = '🔋 ' + bat + charging;

  const sigRow = document.getElementById('signal-row');
  sigRow.innerHTML = '';
  (status.sims || []).forEach(s => {
    const bars = s.signal_bars || 0;
    const barsHtml = [1,2,3,4].map(n =>
      `<span class="bar" style="height:${n*4+2}px" class="bar${bars >= n ? ' lit' : ''}"></span>`
    ).join('');
    const span = document.createElement('span');
    span.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-size:0.78rem;margin-left:12px';
    span.innerHTML = `📶 <span class="badge badge-sim">SIM${s.slot+1}</span> ${s.carrier||'?'} ${s.network_type||''}
      <span class="signal-bars">${barsHtml}</span> <span style="color:#64748b">${s.signal_dbm||''}dBm</span>`;
    sigRow.appendChild(span);
  });
}

function addSmsToFeed(sms) {
  const list = document.getElementById('sms-list');
  // Remove placeholder
  const placeholder = list.querySelector('[style*="No messages"]');
  if (placeholder) placeholder.remove();

  const div = document.createElement('div');
  div.className = 'sms-item';
  const ts = sms.timestamp ? new Date(sms.timestamp).toLocaleTimeString() : '';
  const carrier = sms.sim_carrier ? ` · ${sms.sim_carrier}` : '';
  const simBadge = sms.sim_slot !== undefined
    ? `<span class="badge badge-sim">SIM ${sms.sim_slot + 1}${carrier}</span>`
    : '';
  div.innerHTML = `
    <div class="sms-meta">
      ${simBadge}
      <span class="sms-sender">${sms.from || sms.sender || '?'}</span>
      <span class="sms-time">${ts}</span>
    </div>
    <div class="sms-body">${escHtml(sms.body || sms.message || '')}</div>
  `;
  list.insertBefore(div, list.firstChild);
  while (list.children.length > 50) list.removeChild(list.lastChild);
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function sendCmd(cmd, extra) {
  if (!ws || ws.readyState !== 1 || !currentDeviceId) return;
  ws.send(JSON.stringify({ command: cmd, device_id: currentDeviceId, ...extra }));
}

function sendSMS() {
  const to = document.getElementById('sms-to').value.trim();
  const body = document.getElementById('sms-body').value.trim();
  if (!to || !body) return;
  sendCmd('send_sms', { number: to, message: body });
  document.getElementById('sms-body').value = '';
}

function applySimFilter() {
  const val = document.getElementById('sim-filter-select').value;
  let allowed = [];
  if (val === 'both') allowed = [0, 1];
  else if (val === '0') allowed = [0];
  else if (val === '1') allowed = [1];
  else if (val === 'none') allowed = [];
  sendCmd('set_sim_filter', { allowed_sims: allowed });
}

document.getElementById('device-select').addEventListener('change', (e) => {
  currentDeviceId = e.target.value || null;
});

// Start
const token = getToken();
if (token) connect();
else document.getElementById('token-prompt-card').style.display = '';
</script>
</body>
</html>
```

- [ ] **Step 2: Verify dashboard serves correctly**

Push the changes and start the server:
```bash
cd server
AUDIO_BRIDGE_TOKEN=mytoken python main.py
```

Open `http://localhost:8000/#token=mytoken` in a browser.

Verify:
- Connection badge shows "Connected"
- Token prompt hidden (token in URL hash)
- Device panel shows placeholder dashes (no device connected yet)
- SIM filter dropdown is present
- SMS feed shows "No messages yet"

- [ ] **Step 3: Commit**

```bash
git add server/dashboard.html
git commit -m "dashboard: device info panel, battery/signal, SIM filter dropdown, SMS badges"
```

---

## Self-Review

**Spec coverage check:**

| Requirement | Task |
|---|---|
| Fix hardcoded token `default_secure_token_123` | Task 6 Step 2 (server), Task 5 Step 18 (daemon) |
| WS auth for /ws/ui | Task 6 Step 5 |
| WS auth for /ws/audio | Task 6 Step 6 |
| HMAC nonce replay protection | Task 6 Steps 4 + Task 5 Step 17 |
| TLS setup scripts | Task 6 Steps 10, 12, 13 |
| SMS routing fix (`event` → `type`) | Task 6 Step 7 |
| Eliminate Zygisk | Tasks 1 (build), 2 (service.sh), 4 Step 1 (delete AudioCapture) |
| NDK r27c | Task 1 Step 1 |
| Voice TX injection (PCM 27) | Task 5 Steps 5-11 |
| Voice RX capture (PCM 0) | Task 5 Step 10 |
| Block real mic | Task 5 Step 5 (`Voice Tx Device Mute`) |
| No bootloop | Task 1 (remove Zygisk), Task 5 (daemon-only PCM access) |
| SIM routing filter (reject unwanted SIM calls) | Task 3 Steps 4, 7 |
| SMS SIM1/SIM2 badge | Task 3 Step 2 + Task 7 `addSmsToFeed` |
| Device info panel | Task 3 Step 5 + Task 6 Step 8 + Task 7 |
| Battery % + signal heartbeat | Task 3 Step 5 + Task 6 Step 8 + Task 7 |
| T_DEVICE_INFO (0x08) / T_DEVICE_STATUS (0x09) | Task 4 header + Task 5 Steps 14-15 + Task 6 Step 8 |
| config.json with PCM device overrides | Task 2 Step 4 + Task 5 Step 2 |
| Heartbeat 90s timeout + g_last_pong at connect | Task 5 Step 18 |
| Thread lifecycle: join before pcm_close | Task 5 Step 11 (`voice_call_stop`) |
| `pcm_write` inside `pcm_mtx` | Task 5 Step 9 (voice_tx_thread) |
| Jitter buffer 100ms pre-fill / 300ms cap | Task 5 Steps 7, 9 |
| Opus PLC on 30ms timeout | Task 5 Step 9 |
| EPIPE recovery | Task 5 Step 9 |
| SSR reconnect | Task 5 Step 8 |

**Placeholder scan:** No TBD or TODO items found in any step.

**Type consistency check:**
- `send_to_java_raw(const char*)` introduced in Task 5 Step 15 and used in Task 5 Steps 15, 18 — consistent
- `T_DEVICE_INFO = 0x08`, `T_DEVICE_STATUS = 0x09` defined in `audio_bridge.h` (Task 4) and mirrored as `T_DEVICE_INFO = 8` in `server/main.py` (Task 6 Step 3) — consistent
- `{"type":"call_state","state":"active","sim":N}` produced by TelephonyHelper (Task 3 Step 3) and consumed by `handle_java_ipc_message` (Task 5 Step 12) — consistent
- `{"type":"device_status",...}` produced by TelephonyHelper (Task 3 Step 5) and routed in `status_sender_thread` (Task 5 Step 14) — consistent
- WS command `{"command":"set_sim_filter","allowed_sims":[...]}` produced by dashboard (Task 7) and handled in `ws_ui` (Task 6 Step 9) and forwarded as T_CONTROL to daemon and then via `send_to_java_raw` to APK (Task 5 Step 15) — consistent
