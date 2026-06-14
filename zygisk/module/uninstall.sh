#!/system/bin/sh
# Runs when the user removes the module via KernelSU / Magisk Manager.
# IMPORTANT: this script runs during early boot (post-fs-data stage) before
# the Android framework starts. pm/am are NOT available here, so we cannot
# call `pm uninstall` directly. Instead we drop a one-shot cleanup script
# into /data/adb/service.d/ which KernelSU executes later; that script waits
# for sys.boot_completed before invoking pm.
LOG=/data/local/tmp/audio_bridge_uninstall.log
echo "$(date) uninstall.sh started" >> $LOG

# Kill the daemon if it is running (the socket is accessible this early).
if pidof audio-bridge >/dev/null 2>&1; then
    PID=$(pidof audio-bridge)
    kill "$PID" 2>/dev/null
    sleep 1
    kill -9 "$PID" 2>/dev/null
    echo "$(date) daemon killed (was PID $PID)" >> $LOG
fi

# Remove diagnostic + runtime files we created in /data/local/tmp.
rm -f /data/local/tmp/audio_bridge.log \
      /data/local/tmp/audio_bridge_java.log \
      /data/local/tmp/audio_bridge_service.log \
      /data/local/tmp/audio_bridge.sock \
      /data/local/tmp/audio_bridge.pid \
      /data/local/tmp/audio_bridge.conf \
      /data/local/tmp/audio_bridge_id

# Schedule APK removal for after boot_completed.
# pm is unavailable at this stage; we leave a one-shot script in service.d
# that runs once the framework is up, uninstalls the package, then removes
# itself so it never fires again on subsequent boots.
mkdir -p /data/adb/service.d
cat > /data/adb/service.d/audio_bridge_cleanup.sh << 'CLEANUP'
#!/system/bin/sh
LOG=/data/local/tmp/audio_bridge_uninstall.log
echo "$(date) cleanup script: waiting for boot_completed" >> $LOG
for i in $(seq 1 90); do
    if [ "$(getprop sys.boot_completed)" = "1" ]; then
        sleep 3
        if pm path com.audiobridge >/dev/null 2>&1; then
            am force-stop com.audiobridge 2>/dev/null
            pm uninstall com.audiobridge >> $LOG 2>&1
            echo "$(date) pm uninstall com.audiobridge done" >> $LOG
        else
            echo "$(date) com.audiobridge not registered, nothing to uninstall" >> $LOG
        fi
        rm -f /data/adb/service.d/audio_bridge_cleanup.sh
        exit 0
    fi
    sleep 2
done
echo "$(date) cleanup script: timed out waiting for boot_completed" >> $LOG
rm -f /data/adb/service.d/audio_bridge_cleanup.sh
CLEANUP
chmod 755 /data/adb/service.d/audio_bridge_cleanup.sh
echo "$(date) cleanup script installed to /data/adb/service.d/audio_bridge_cleanup.sh" >> $LOG

echo "$(date) uninstall.sh complete" >> $LOG
