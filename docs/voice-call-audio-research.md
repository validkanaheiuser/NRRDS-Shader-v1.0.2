# Voice Call Audio Capture & Injection — Research Reference

Verified against: SM6150 kernel (android_kernel_xiaomi_sm6150), LineageOS 23.2 (Android 15).
Written to be applicable across Qualcomm SoCs and Android versions. Non-Qualcomm SoCs (MediaTek, Exynos)
have analogous mechanisms — specific control names differ but the methodology is identical.

---

## 1. Architecture — How Voice Call Audio Actually Flows

### The Critical Fact: CPU Does Not Touch Call Audio

On all modern Android phones (Qualcomm, MTK, Exynos), cellular voice call audio is processed
entirely inside the modem DSP (ADSP/Hexagon on Qualcomm, DSP on MTK). The ARM CPU only sends
control commands. No PCM samples pass through the Linux kernel for a normal voice call.

```
[Mic] → [CODEC] → [ADSP] ←→ [Modem/Baseband] ←→ [Network]
                      ↓
                  [CODEC] → [Speaker]

ARM CPU = control plane only (open/close sessions, set gains, routing).
PCM samples live entirely in ADSP SRAM and shared DRAM — not in Linux kernel address space.
```

### Two CPU-Side Tap-Point Mechanisms

The only way to get PCM samples to/from the CPU during a cellular call is via explicit tap-points
that the kernel audio driver exposes over ALSA:

| Mechanism | Direction | How it works |
|-----------|-----------|--------------|
| **INCALL_RECORD** (passive tap) | Capture only | ADSP copies call audio to a PCM buffer the CPU reads. Passive — does not affect the call. |
| **HPCM** (Host PCM, VSS_IVPCM) | Bidirectional | ADSP routes audio through CPU. CPU can read AND write each direction. True mic replacement. |

INCALL_RECORD is simpler and always available. HPCM requires the modem firmware to support
VSS_IVPCM tap points (most Qualcomm VoLTE stacks do).

---

## 2. Qualcomm AFE Pseudo-Ports (SM6150 / All Qualcomm)

These are virtual AFE ports the kernel driver exposes for CPU-side audio access during calls.
Defined in `sound/soc/msm/qdsp6v2/q6afe.h` and `platform.c` across all QCOM kernels.

```
AFE_PORT_ID_VOICE_RECORD_RX   = 0x8003   Downlink tap  (far end → speaker)
AFE_PORT_ID_VOICE_RECORD_TX   = 0x8004   Uplink tap    (mic → far end)
AFE_PORT_ID_VOICE_PLAYBACK_TX = 0x8005   Uplink inject (replace what far end hears)
```

Voice session IDs (used internally by HAL/modem):
```
VOICEMMODE1_VSID = 0x11C05000   Primary SIM cellular calls on modern Android
VOICEMMODE2_VSID = 0x11DC5000   Dual-SIM secondary slot
VOICE_SESSION_VSID = 0x10C01000  Legacy (pre-VoLTE)
```

---

## 3. INCALL_RECORD — Passive Call Capture

### How to Discover the Mixer Controls and PCM Device

**Step 1: Run this during an active call on the target device:**
```bash
tinymix | grep -i voc
tinymix | grep -i incall
tinymix | grep -i voice
cat /proc/asound/pcm
```

**Step 2: Identify the capture mixer controls.**

Pattern: `MultiMediaX Mixer VOC_REC_DL` and `MultiMediaX Mixer VOC_REC_UL`
- DL = downlink = what the far end is saying (speaker direction)
- UL = uplink = what you are saying (mic direction)

SM6150/trinket (confirmed in mixer_paths_tashalite.xml):
```
MultiMedia9 Mixer VOC_REC_DL    → captures downlink
MultiMedia9 Mixer VOC_REC_UL    → captures uplink
```

Other QCOM variants you may find:
```
MultiMedia1 Mixer VOC_REC_DL
MultiMedia2 Mixer VOC_REC_DL
VoiceMMode1 Capture Mixer VOC_REC_DL
```

**Step 3: Identify which ALSA PCM device corresponds to the mixer.**

ALSA device numbering for MultiMediaX: device = X-1 (MultiMedia1 = dev 0, MultiMedia9 = dev 8).

Verify by cross-referencing `cat /proc/asound/pcm` output with platform.c constants:
```
AUDIO_RECORD_PCM_DEVICE = 0          (MultiMedia1)
MULTIMEDIA9_PCM_DEVICE  = 8          (MultiMedia9)
```

### PCM Config for Capture

```c
struct pcm_config cfg = {
    .channels    = 1,
    .rate        = 8000,     // native narrowband voice; try 16000 for HD Voice
    .period_size = 160,      // 20ms at 8kHz; 160 at 16kHz = 10ms
    .period_count = 4,
    .format      = PCM_FORMAT_S16_LE,
};
// Open: pcm_open(0, dev, PCM_IN, &cfg)
// dev = 8 for MultiMedia9 on SM6150; confirm with /proc/asound/pcm
```

Must set mixer controls BEFORE pcm_open. Must call pcm_open AFTER call is connected
(500ms delay recommended after OFFHOOK state transition).

### Shell Verification Commands

```bash
# During active call — check if controls exist and accept value 1
tinymix "MultiMedia9 Mixer VOC_REC_DL" 1
tinymix "MultiMedia9 Mixer VOC_REC_UL" 1

# Open capture and dump to file:
tinycap /sdcard/call_capture.wav -D 0 -d 8 -r 8000 -c 1 -b 16

# If that fails, try dev 0:
tinycap /sdcard/call_capture.wav -D 0 -d 0 -r 8000 -c 1 -b 16

# Reset controls after test:
tinymix "MultiMedia9 Mixer VOC_REC_DL" 0
tinymix "MultiMedia9 Mixer VOC_REC_UL" 0
```

---

## 4. INCALL_MUSIC_UPLINK — Inject Into Mic Path (Simple Method)

This is the "music on hold" feature repurposed: injects audio into the uplink (TX) path.
The **far end hears your injected audio** instead of (or mixed with) the real microphone.

### Qualcomm (SM6150 and most QCOM devices)

```bash
# Set mixer control:
tinymix "Incall_Music Audio Mixer MultiMedia2" 1

# Play audio to inject:
tinyplay inject.wav -D 0 -d 27

# Reset:
tinymix "Incall_Music Audio Mixer MultiMedia2" 0
```

PCM device 27 = `INCALL_MUSIC_UPLINK_PCM_DEVICE` (hardcoded constant in platform.c for all
SM6150/SM8150/SM8250/SM8350 series; may differ on older SoCs like MSM8996/MSM8998).

Config:
```c
struct pcm_config cfg = {
    .channels    = 1,
    .rate        = 8000,    // or 48000 — HAL does SRC internally
    .period_size = 160,
    .period_count = 4,
    .format      = PCM_FORMAT_S16_LE,
};
// pcm_open(0, 27, PCM_OUT, &cfg)
```

Alternate mixer control names seen across devices:
```
Incall_Music Audio Mixer MultiMedia2
VoiceMMode1 Playback Mixer MultiMedia2
Voice_Rx Mixer MultiMedia2
```

### Why This Works (AFE Route)

Setting the mixer control tells the ADSP to open port `VOICE_PLAYBACK_TX (0x8005)` and route
MultiMedia2's output into the uplink path. Despite the confusing name "PLAYBACK_TX", this sends
audio INTO the TX (mic-to-modem) path — the far end hears it.

---

## 5. HPCM (Host PCM) — Bidirectional, True Mic Replacement

HPCM gives the CPU bidirectional access: read what the far end is saying AND inject replacement
audio for what the modem hears as the microphone. Uses VSS_IVPCM tap-points in the modem firmware.

### DAI Names (from msm-pcm-host-voice-v2.c)

```
VoiceMMode1 HOST TX PLAYBACK   → inject audio replacing the microphone (far end hears it)
VoiceMMode1 HOST TX CAPTURE    → capture what the microphone is sending to modem
VoiceMMode1 HOST RX PLAYBACK   → inject into earpiece (near end hears it)
VoiceMMode1 HOST RX CAPTURE    → capture what the modem is sending to speaker
```

Find these in `/proc/asound/pcm` during an active call. The device numbers vary by kernel.

```bash
cat /proc/asound/pcm | grep -i host
# Example output:
# 00-41: VoiceMMode1 HOST TX PLAYBACK : capture 1
# 00-42: VoiceMMode1 HOST RX CAPTURE  : playback 1
```

### PCM Config for HPCM

```c
struct pcm_config cfg = {
    .channels    = 1,
    .rate        = 16000,   // HPCM native rate; try 8000 if 16000 fails
    .period_size = 160,     // 10ms at 16kHz
    .period_count = 4,
    .format      = PCM_FORMAT_S16_LE,
};
// Inject (mic replacement): pcm_open(0, hpcm_tx_dev, PCM_OUT, &cfg)
// Capture (what mic sends): pcm_open(0, hpcm_tx_dev, PCM_IN, &cfg)
```

No separate mixer control is needed to enable HPCM — opening the PCM device triggers
the modem to set up the tap point via `voc_start_host_pcm_v2()`.

### HPCM vs INCALL_MUSIC_UPLINK Decision

Use HPCM when:
- You need simultaneous inject AND capture (replace mic while also recording)
- You need guaranteed mic replacement (INCALL_MUSIC may mix instead of replace)
- The modem supports VSS_IVPCM (most Qualcomm VoLTE)

Use INCALL_MUSIC_UPLINK when:
- HPCM devices are not visible in /proc/asound/pcm
- Simpler integration is preferred
- Mixing injection with real mic is acceptable

---

## 6. Discovering What's Available on an Unknown Device

### Diagnostic Commands (run as root during an active cellular call)

```bash
# 1. Full PCM device list — DO THIS FIRST
cat /proc/asound/pcm

# 2. All mixer controls — grep for voice/call-related ones
tinymix | grep -iE "voc|incall|voice|mmode|hpcm|host"

# 3. Current state of relevant controls
tinymix | grep -iE "voc_rec|incall_music|host tx|host rx"

# 4. What the HAL opened (shows active ALSA devices)
cat /proc/asound/card0/pcm*/status 2>/dev/null

# 5. Check if ADSP voice session is active
cat /proc/asound/card0/stream* 2>/dev/null | head -40

# 6. Find the exact device numbers by name
grep -i "incall\|host\|voice\|mmode" /proc/asound/pcm

# 7. Check DSP audio topology
cat /sys/kernel/debug/regmap/*/registers 2>/dev/null | head -20
```

### Cross-SoC Mapping

| SoC Family | Capture Mixer | Inject Mixer | Inject Dev | Notes |
|------------|--------------|--------------|------------|-------|
| SM6150 (trinket) | MultiMedia9 Mixer VOC_REC_DL/UL | Incall_Music Audio Mixer MultiMedia2 | 27 | Confirmed |
| SM8150/SM8250/SM8350 | MultiMedia9 Mixer VOC_REC_DL/UL | Incall_Music Audio Mixer MultiMedia2 | 27 | Very likely same |
| MSM8998/SDM845 | MultiMedia1 Mixer VOC_REC_DL/UL | Incall_Music Audio Mixer MultiMedia2 | varies | Check platform.c |
| MediaTek | varies by platform | varies | varies | Look for "MTK_SPH_PCM" or "Voice_Rx" |
| Exynos | varies | varies | varies | Look for "VOICE_RECORD" in DSPK driver |

For any unknown device, the pattern is always:
1. `tinymix | grep -i voc` → find capture routing controls
2. `tinymix | grep -i incall` → find inject controls
3. `cat /proc/asound/pcm` → find the PCM device numbers

---

## 7. Root UID Audio Permission Bypass

### ServiceUtilities.cpp (AOSP, all Android versions)

```cpp
// frameworks/av/services/audioflinger/ServiceUtilities.cpp
bool captureAudioOutputAllowed(const AttributionSourceState& attributionSource) {
    // ...
    if (isAudioServerOrRootUid(attributionSource.uid)) return true;  // ← Root bypasses all checks
    // ...
}

static bool isAudioServerOrRootUid(uid_t uid) {
    return uid == AID_AUDIOSERVER || uid == AID_ROOT;  // 0 = root
}
```

Running as UID 0 (root — which the daemon does via KernelSU service.sh) bypasses:
- `CAPTURE_AUDIO_OUTPUT` permission check
- `CAPTURE_MEDIA_OUTPUT` permission check  
- `MODIFY_AUDIO_ROUTING` permission check
- `RECORD_AUDIO` OP check in appops

This means the daemon can open any AudioRecord source including `VOICE_CALL (4)` and
`VOICE_DOWNLINK (10)` / `VOICE_UPLINK (11)` without any permissions.

For the **APK** (runs as priv_app, not root), the workarounds are:
1. privapp-permissions XML to grant `CAPTURE_AUDIO_OUTPUT` (signature-protected, requires system signing or overlay)
2. `appops set com.yourapp RECORD_AUDIO allow` from root shell (service.sh does this)

### Java AudioRecord with VOICE_CALL

```java
// AudioSource.VOICE_CALL = 4
// Captures both uplink and downlink mixed (full call audio)
new AudioRecord(4, 8000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufSize);

// AudioSource.VOICE_DOWNLINK = 10 — only far end
// AudioSource.VOICE_UPLINK = 11 — only near end / microphone
// AudioSource.VOICE_COMMUNICATION = 7 — VoIP calls (not cellular)
```

---

## 8. SELinux Considerations

### GKI Kernel Neverallow — Critical

Android GKI kernels (5.10+, some 5.4) have hardcoded `neverallow` rules that survive
`ksud sepolicy patch` and `magiskpolicy --live`:
```
neverallow appdomain tmpfs:file { write execute };
```

This means `ksud sepolicy patch "allow priv_app tmpfs file write"` parses OK and returns 0
but the kernel SILENTLY REJECTS the policy load. You can confirm: the rule simply never takes effect.

**Solution**: Use `/dev/ashmem` instead of memfd for shared memory. Ashmem creates a
`ashmem_device_file chr_file` type, which is already allowed by AOSP base policy for all
app domains. No SELinux patching needed.

```cpp
int fd = open("/dev/ashmem", O_RDWR);
ioctl(fd, ASHMEM_SET_NAME, "my_shm");
ioctl(fd, ASHMEM_SET_SIZE, (size_t)size);
void* ptr = mmap(NULL, size, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0);
// Pass fd via SCM_RIGHTS (Unix socket ancdata) to other processes
```

### Rules That DO Work via Live Patching

Unix socket rules survive (they don't hit neverallow):
```
allow priv_app ksu unix_stream_socket { connectto read write getattr }
allow vendor_qtelephony ksu unix_stream_socket { connectto read write getattr }
```

### ALSA Access from Root Daemon

The daemon runs in the kernel security context (root/init/ksu domain depending on how KernelSU
starts it). ALSA device access from root typically requires no additional SELinux rules — the
`system_file` type context of `/dev/snd/*` is readable by root. If you get EACCES, check:
```bash
ls -Z /dev/snd/
# Look for type like audio_device or snd_device
# Add: allow u:r:su:s0 snd_device chr_file { open read write ioctl }
```

---

## 9. Timing and State Requirements

### When to Open PCM Devices

**NEVER open incall PCM devices at daemon startup.**

The ADSP voice path is only built when:
1. The phone app has an active call session
2. The modem firmware has negotiated codec/rate with the network
3. The HAL has opened its internal voice PCM devices

Opening INCALL_RECORD or INCALL_MUSIC_UPLINK before these steps causes:
- `pcm_open()` returns `EINVAL` ("Invalid argument") — ADSP rejects the open
- `pcm_open()` returns `EBUSY` — HAL grabbed the device already
- `pcm_open()` succeeds but `pcm_read()`/`pcm_write()` blocks forever or returns garbage

**Correct sequence:**
```
1. Wait for call state = OFFHOOK (from TelephonyManager callback)
2. Wait 500ms (ADSP voice path setup time)
3. Set mixer controls
4. pcm_open()
5. pcm_read()/pcm_write() loop
6. On call end: pcm_close(), reset mixer controls
```

### Detecting Call State Without Java APK

From root shell, poll `dumpsys telephony.registry | grep "mCallState"`:
```
mCallState=2   → OFFHOOK (active call)
mCallState=1   → RINGING
mCallState=0   → IDLE
```

Or via ALSA: during an active call, `cat /proc/asound/card0/pcm*/status` will show an active
voice PCM stream opened by the HAL (typically `hw:0,20` or similar for VoiceMMode1).

---

## 10. Rate Conversion

### Native Voice Call Sample Rates

| Network Type | Rate | Codec |
|-------------|------|-------|
| GSM / WCDMA (narrowband) | 8000 Hz | AMR-NB |
| LTE VoLTE narrowband | 8000 Hz | AMR-NB |
| LTE VoLTE wideband (HD Voice) | 16000 Hz | AMR-WB / EVS |
| LTE VoLTE super-wideband | 32000 Hz | EVS |

The INCALL_RECORD device will give you whatever the current call is running at. Try 8kHz first,
fall back to 16kHz. HPCM is typically fixed at 16kHz regardless of network rate.

### Upsampling to 48kHz (for Opus encoder)

If your pipeline expects 48kHz (e.g., Opus VOIP mode requires it), upsample from 8kHz:
```c
// Simple nearest-neighbour — adequate for voice
// captured: 160 samples at 8kHz (20ms)
// upsampled: 960 samples at 48kHz (20ms) — correct for Opus frame
for (int i = 0; i < 160; i++)
    for (int j = 0; j < 6; j++)
        out[i*6 + j] = in[i];
```

For better quality, use a proper SRC library (speex_resampler, libsamplerate).

### Downsampling from 48kHz to 8kHz (for injection)

```c
// SHM buffer is at 48kHz (960 samples per 20ms frame)
// INCALL_MUSIC expects 8kHz (160 samples per 20ms)
// Simple decimation: take every 6th sample
for (int i = 0; i < 160 && i*6 < 960; i++)
    out[i] = in[i * 6];
```

---

## 11. Alternative Capture: Java AudioRecord(VOICE_CALL)

As a simpler fallback that doesn't require ALSA knowledge, the APK can use:

```java
// AudioSource.VOICE_CALL = 4
// Requires CAPTURE_AUDIO_OUTPUT (signature) OR root UID
AudioRecord rec = new AudioRecord(
    MediaRecorder.AudioSource.VOICE_CALL,  // = 4
    8000,
    AudioFormat.CHANNEL_IN_MONO,
    AudioFormat.ENCODING_PCM_16BIT,
    bufferSize
);
```

This works when:
- App is installed as a system/priv-app with `CAPTURE_AUDIO_OUTPUT` granted
- OR `appops set com.pkg RECORD_AUDIO allow` was set by root shell
- Does NOT work reliably if app is data-app without privapp XML, even with appops allow

The daemon receives the raw PCM over a Unix socket and feeds it through the same Opus encoder.

---

## 12. MediaTek / Exynos Equivalent Patterns

### MediaTek (MTK)

MediaTek uses a different audio HAL (`libaudio_mtk.so`), but the ALSA layer is similar.

**Capture**: Look for mixer controls containing `"VOIP"`, `"Speech"`, or `"Modem PCM"`:
```bash
tinymix | grep -iE "speech|modem|voip|dl|ul"
# Common: "Speech_SRC_Rx" or "Modem_DL_Mixer" type controls
```

**PCM devices**: MTK often uses `hw:0,9` or `hw:0,10` for voice PCM. Check:
```bash
grep -i "modem\|speech\|voice" /proc/asound/pcm
```

### Samsung Exynos

Exynos uses the ABOX DSP. Look for:
```bash
tinymix | grep -iE "call|voice|capture|playback"
grep -i "voice\|call" /proc/asound/pcm
```
Samsung often exposes voice call audio via `/dev/voice_rx` or similar char devices rather
than standard ALSA. Check `ls /dev/voice*` and `ls /dev/abox*`.

---

## 13. Implementation Checklist for a New Device

1. **Root shell during active call, collect data:**
   ```bash
   cat /proc/asound/pcm > /sdcard/asound_pcm.txt
   tinymix > /sdcard/mixer_controls.txt
   ```
   Pull both files and search for the patterns in sections 3-5 above.

2. **Test capture with tinycap:**
   ```bash
   # Find the MultiMediaX Mixer VOC_REC_DL control name from mixer_controls.txt
   # Set it, then capture:
   tinymix "MultiMedia9 Mixer VOC_REC_DL" 1   # or whatever name you found
   tinycap /sdcard/test.wav -D 0 -d 8 -r 8000 -c 1 -b 16 -p 160 -n 4
   # Pull and play test.wav — should contain call audio
   ```

3. **Test injection with tinyplay:**
   ```bash
   tinymix "Incall_Music Audio Mixer MultiMedia2" 1
   tinyplay /sdcard/test_tone.wav -D 0 -d 27
   # Far end should hear the tone instead of your mic
   ```

4. **Update daemon constants** in `audio_bridge.cpp`:
   - Change mixer control names in `set_mixer_ctl_uint()` calls in both incall threads
   - Change `cap_dev` and `inj_dev` defaults if different from SM6150
   - Update `inj_rate` if HAL expects a different rate

5. **HPCM availability**: If `/proc/asound/pcm` shows `VoiceMMode1 HOST TX PLAYBACK`
   during a call, prefer HPCM over INCALL_MUSIC for cleaner mic replacement.

---

## 14. This Project's Implementation Summary

Files: `jni/audio_bridge.cpp` functions `tinyalsa_incall_capture_thread()` and `tinyalsa_incall_inject_thread()`

**Capture thread** (`tinyalsa_incall_capture_thread`):
- Polls `g_call_state == CALL_OFFHOOK` every 200ms
- 500ms delay after OFFHOOK for ADSP path setup
- Sets `MultiMedia9 Mixer VOC_REC_DL` + `VOC_REC_UL` (SM6150), falls back to MultiMedia1
- PCM device 8 (MultiMedia9), 8kHz, period=160, count=4
- 6× nearest-neighbour upsample to 48kHz before queuing to `g_java_pcm_queue`
- `capture_speaker_thread` encodes queued PCM as Opus and sends T_SPEAKER frames

**Inject thread** (`tinyalsa_incall_inject_thread`):
- Same state gating
- Tries `VoiceMMode1 HOST TX PLAYBACK` (HPCM) first — true mic replacement
- Falls back to `INCALL_MUSIC` PCM device (dev 27 default) with `Incall_Music Audio Mixer MultiMedia2`
- Reads SHM mic_frames ring (48kHz, written by `receive_virtual_mic_thread`)
- Decimates 6:1 to 8kHz for injection

**Diagnostics**: On first call activation, `dump_asound_pcm()` logs the full `/proc/asound/pcm`
and all attempted mixer control names appear in logcat tagged `AudioBridge`.

To view all incall logs:
```bash
adb logcat -d -s AudioBridge | grep -iE "incall|mixer|alsa|pcm"
```
