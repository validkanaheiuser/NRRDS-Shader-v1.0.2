#!/system/bin/sh
MODDIR=${0%/*}
LOG=/data/local/tmp/audio_bridge_service.log

echo "$(date) Audio Bridge service.sh started" >> $LOG

# Auto-grant permissions (suppress errors if app not yet installed)
pm grant com.audiobridge android.permission.CALL_PHONE 2>/dev/null
pm grant com.audiobridge android.permission.ANSWER_PHONE_CALLS 2>/dev/null
pm grant com.audiobridge android.permission.READ_PHONE_STATE 2>/dev/null
pm grant com.audiobridge android.permission.READ_PRECISE_PHONE_STATE 2>/dev/null
pm grant com.audiobridge android.permission.SEND_SMS 2>/dev/null
pm grant com.audiobridge android.permission.RECEIVE_SMS 2>/dev/null
pm grant com.audiobridge android.permission.READ_SMS 2>/dev/null
pm grant com.audiobridge android.permission.POST_NOTIFICATIONS 2>/dev/null
pm grant com.audiobridge android.permission.RECORD_AUDIO 2>/dev/null
# CAPTURE_AUDIO_OUTPUT is a signature/system permission; pm grant cannot grant it.
# It is allowlisted in privapp-permissions-audiobridge.xml for priv-app installs.
# Force appops to ALLOW so system_server doesn't gate on OP_RECORD_AUDIO_OUTPUT.
appops set com.audiobridge RECORD_AUDIO allow 2>/dev/null
appops set com.audiobridge SYSTEM_ALERT_WINDOW allow 2>/dev/null

# Apply SELinux rules. sepolicy.rule is read by Magisk/KernelSU on boot; this
# is the belt to that file's suspenders. Rules cover every (app, daemon)
# domain pair we might hit.
APP_DOMAINS="priv_app system_app platform_app radio vendor_qtelephony"
DAEMON_DOMAINS="ksu magisk su init"
apply_rule() {
    local RULE="$1"
    if command -v magiskpolicy >/dev/null 2>&1; then
        magiskpolicy --live "$RULE" 2>/dev/null
    elif [ -f /data/adb/ksud ]; then
        /data/adb/ksud sepolicy patch "$RULE" 2>/dev/null
    elif command -v supolicy >/dev/null 2>&1; then
        supolicy --live "$RULE" 2>/dev/null
    fi
}
if command -v magiskpolicy >/dev/null 2>&1 || [ -f /data/adb/ksud ] || command -v supolicy >/dev/null 2>&1; then
    # Unix socket: allow app domains to connect to daemon domains
    for APP in $APP_DOMAINS; do for D in $DAEMON_DOMAINS; do
        apply_rule "allow $APP $D unix_stream_socket { connectto read write getattr }"
    done; done
    # ashmem_device_file (preferred SHM type — avoids tmpfs neverallow on GKI kernels)
    for APP in $APP_DOMAINS phone; do
        apply_rule "allow $APP ashmem_device_file chr_file { read write open map getattr ioctl }"
    done
    # tmpfs fallback
    for APP in $APP_DOMAINS phone; do
        apply_rule "allow $APP tmpfs file { read write open map getattr }"
    done
    # Allow priv_app to write its Java-side diag log to /data/local/tmp
    apply_rule "allow priv_app shell_data_file { read write create open append getattr setattr }"
    echo "$(date) SELinux rules applied" >> $LOG
else
    echo "$(date) WARNING: no sepolicy tool found" >> $LOG
fi

# Locate daemon binary once — used in every branch below.
# Prefer $MODDIR path: the /system/bin overlay may not be visible yet on
# KernelSU when service.sh runs at boot. $MODDIR is always a real directory.
DAEMON_BIN=""
if [ -f "$MODDIR/system/bin/audio-bridge" ]; then
    chmod 755 "$MODDIR/system/bin/audio-bridge" 2>/dev/null
    DAEMON_BIN="$MODDIR/system/bin/audio-bridge"
elif [ -f /system/bin/audio-bridge ]; then
    DAEMON_BIN="/system/bin/audio-bridge"
fi

start_daemon() {
    echo "$(date) Launching: $DAEMON_BIN" >> $LOG
    "$DAEMON_BIN" --daemon >> $LOG 2>&1 &
    sleep 3
    if pidof audio-bridge >/dev/null 2>&1; then
        echo "$(date) Daemon started OK, PID=$(pidof audio-bridge)" >> $LOG
    else
        echo "$(date) WARNING: Daemon failed to start — check SELinux or binary integrity" >> $LOG
    fi
}

if [ -z "$DAEMON_BIN" ]; then
    echo "$(date) ERROR: audio-bridge binary not found in MODDIR or /system/bin" >> $LOG
elif ! pidof audio-bridge >/dev/null 2>&1; then
    echo "$(date) Starting audio bridge daemon" >> $LOG
    start_daemon
else
    # At reboot the daemon may still be visible in pidof while dying from SIGTERM.
    # Wait up to 5 s; if it exits we restart, otherwise it is genuinely healthy.
    STALE=0
    for _w in 1 2 3 4 5; do
        sleep 1
        if ! pidof audio-bridge >/dev/null 2>&1; then
            STALE=1
            break
        fi
    done
    if [ "$STALE" = "1" ]; then
        echo "$(date) Stale daemon was dying; restarting" >> $LOG
        start_daemon
    else
        echo "$(date) Daemon already running, PID=$(pidof audio-bridge)" >> $LOG
    fi
fi

# Background: brief SELinux permissive window after boot so Zygisk modules
# can mmap the ashmem/SHM fd. ksud sepolicy patch is unreliable on GKI kernels
# that enforce neverallows at policy-load time. A 4-second window covers 8
# retry cycles (modules retry every 500 ms) — enough for all hooked processes.
(
    for _i in $(seq 1 60); do
        [ "$(getprop sys.boot_completed)" = "1" ] && break
        sleep 2
    done
    sleep 6
    setenforce 0 2>/dev/null
    sleep 4
    setenforce 1 2>/dev/null
    echo "$(date) SELinux permissive window closed" >> $LOG
) &

# Background: wait for the framework, install APK if needed, start service.
(
    # Wait for boot_completed (cap ~2 min).
    for i in $(seq 1 60); do
        if [ "$(getprop sys.boot_completed)" = "1" ]; then break; fi
        sleep 2
    done
    sleep 3

    # On Android 16, the priv-app overlay triggers a Resources null-deref
    # inside handleBindApplication BEFORE any user code runs, crashing on
    # every FGS start attempt. The crash check used to run before the start
    # attempts, so it always saw 0 crashes — a timing window that can never
    # close. The fix: unconditionally prefer a data-app install over the
    # priv-app overlay on every boot. pm install -r retains all granted
    # permissions and the resulting package still runs in priv_app SELinux
    # context (updated system app), but the data-app APK path avoids the
    # Android 16 priv-app resource initialization crash entirely.
    APK_STATE=$(pm path com.audiobridge 2>/dev/null)

    if [ -z "$APK_STATE" ]; then
        echo "$(date) com.audiobridge not registered; pm install from MODDIR" >> $LOG
        [ -f "$MODDIR/AudioBridge.apk" ] && \
            pm install -r -g "$MODDIR/AudioBridge.apk" >> $LOG 2>&1
        sleep 2
    elif echo "$APK_STATE" | grep -q "/system/priv-app/"; then
        echo "$(date) com.audiobridge is priv-app — reinstalling as data-app (avoids Android 16 handleBindApplication crash)" >> $LOG
        if [ -f "$MODDIR/AudioBridge.apk" ]; then
            pm install -r -g "$MODDIR/AudioBridge.apk" >> $LOG 2>&1
            sleep 2
        fi
    else
        echo "$(date) com.audiobridge present at $APK_STATE (data-app, ok)" >> $LOG
    fi

    # Start the FGS directly. Running as root (uid=0) is explicitly exempt from
    # Android 12+'s background FGS restriction in ActiveServices.java, so
    # `am start-foreground-service` bypasses ForegroundServiceStartNotAllowedException
    # without needing a visible activity. Service must call startForeground() within 5s.
    FGS_OUT=$(am start-foreground-service --user 0 com.audiobridge/.AudioBridgeService 2>&1)
    echo "$(date) FGS direct: $FGS_OUT" >> $LOG
    sleep 4
    if pidof com.audiobridge >/dev/null 2>&1; then
        echo "$(date) AudioBridgeService running (pid=$(pidof com.audiobridge))" >> $LOG
        exit 0
    fi
    # Fallback: start via LauncherActivity (translucent theme ensures a window is
    # created so the activity is considered visible and the FGS call is exempt).
    echo "$(date) Direct FGS start may have failed — trying LauncherActivity fallback" >> $LOG
    OUT=$(am start --user 0 -n com.audiobridge/.LauncherActivity 2>&1)
    echo "$(date) LauncherActivity: $OUT" >> $LOG
    sleep 4
    if pidof com.audiobridge >/dev/null 2>&1; then
        echo "$(date) AudioBridgeService running via LauncherActivity" >> $LOG
    else
        echo "$(date) WARNING: AudioBridgeService not running after both attempts" >> $LOG
    fi
) &

# Background: keep webroot status files fresh so the WebUI can read them
# via fetch() without needing ksu.exec(). Runs every 15 s indefinitely.
# Includes config values (host/port/token) so the WebUI can display them.
(
    WROOT="$MODDIR/webroot"
    while true; do
        P=$(cat /data/local/tmp/audio_bridge.pid 2>/dev/null | tr -d ' \t\n\r')
        H=$(grep '^HOST='  /data/local/tmp/audio_bridge.conf 2>/dev/null | cut -d= -f2-)
        PR=$(grep '^PORT=' /data/local/tmp/audio_bridge.conf 2>/dev/null | cut -d= -f2-)
        TK=$(grep '^TOKEN=' /data/local/tmp/audio_bridge.conf 2>/dev/null | cut -d= -f2-)
        ZY=$(logcat -d -t 100 -s AudioBridge-Zygisk 2>/dev/null | grep -c "Connected to daemon" 2>/dev/null)
        [ -z "$ZY" ] && ZY=0
        SO=0; [ -f "$MODDIR/zygisk/arm64-v8a.so" ] && SO=1
        if [ -n "$P" ] && [ -d "/proc/$P" ]; then
            C=$(grep -aE "Connected to server!|Disconnected,|No server configured" \
                /data/local/tmp/audio_bridge.log 2>/dev/null | tail -1 | sed 's/"/'"'"'/g')
            printf '{"running":true,"pid":"%s","conn":"%s","host":"%s","port":"%s","token":"%s","zygisk":%s,"so":%s}\n' \
                "$P" "$C" "$H" "$PR" "$TK" "$ZY" "$SO" > "$WROOT/status.json" 2>/dev/null
        else
            printf '{"running":false,"pid":"","conn":"","host":"%s","port":"%s","token":"%s","zygisk":%s,"so":%s}\n' \
                "$H" "$PR" "$TK" "$ZY" "$SO" > "$WROOT/status.json" 2>/dev/null
        fi
        tail -n 60 /data/local/tmp/audio_bridge.log \
            > "$WROOT/daemon.log" 2>/dev/null
        tail -n 25 /data/local/tmp/audio_bridge_service.log \
            > "$WROOT/service.log" 2>/dev/null
        sleep 15
    done
) &
