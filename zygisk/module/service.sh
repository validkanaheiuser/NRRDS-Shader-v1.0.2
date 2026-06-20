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
