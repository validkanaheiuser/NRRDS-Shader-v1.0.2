# Audio Bridge — Claude Notes

## Build System

**Builds run on GitHub Actions, not on this PC.**

- The Android NDK and SDK are NOT installed locally.
- Do not attempt to run `build.sh` or compile the APK/daemon locally.
- To trigger a build: push changes to `main` and the GitHub workflow
  (`.github/workflows/build.yml`) will build the module zip and APK.
- After the workflow completes, the user downloads the artifact and flashes it.

## Project Overview

Rooted Android remote control system:
- **Daemon** (`jni/audio_bridge.cpp`): native C++ binary, runs as root via KernelSU `service.sh`
- **APK** (`java/com/audiobridge/`): foreground service, telephony control, IPC client
- **Server** (`server/main.py`): FastAPI, ports 8000 (HTTP/WS) + 59100 (TCP device)
- **Dashboard** (`server/dashboard.html`): single-file web UI served by the server
- **Zygisk module** (`zygisk/`): hooks audio subsystem for call audio capture/injection

## Key Architecture Notes

- Java ↔ Daemon IPC: abstract Unix socket `@audio_bridge`, newline-delimited JSON
- `IPCClient.sendEvent()` must write directly to `mOut` under `synchronized(this)` —
  NOT via `mExecutor` (single-threaded, permanently blocked in `readLine`)
- Daemon ↔ Server: TCP port 59100, binary frame protocol `[1B type][4B len BE][payload]`
- Frame types: 1=SPEAKER, 2=VIRTUAL_MIC, 3=CONTROL, 4=CALL_STATUS, 5=SMS, 6=PING, 7=PONG
- T_SMS frames from daemon must be wrapped as `{type:"event", kind, device_id, data}`
  before broadcasting to UI WebSocket clients
