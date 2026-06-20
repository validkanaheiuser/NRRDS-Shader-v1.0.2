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
