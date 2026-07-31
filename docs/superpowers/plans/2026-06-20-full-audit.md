# Audio Bridge — Full System Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thực hiện full audit 14 phase cho Audio Bridge module (KernelSU + Zygisk + native daemon + APK + Python server) — tìm mọi bug, security issue, race condition, technical debt, và chuẩn bị roadmap.

**Architecture:** KernelSU module chứa Zygisk `.so` hook vào zygote, native C++ daemon chạy root qua `service.sh`, Java APK foreground service kết nối daemon qua abstract Unix socket, Python FastAPI server nhận audio/lệnh từ daemon qua TCP 59100.

**Tech Stack:** C++17 (NDK 29), Java/Android SDK 28+, Python 3 FastAPI, shadowhook (ByteDance), tinyalsa, Opus codec, KernelSU module system, Zygisk API v4.

## Global Constraints

- Mọi kết luận phải trích dẫn: file + function + line number
- Không được suy đoán — nếu chưa thấy code: ghi "CHƯA ĐỦ BẰNG CHỨNG ĐỂ KẾT LUẬN"
- Ưu tiên bằng chứng: source code > commit > official doc > advisory
- Output tích lũy vào `docs/audit/YYYY-MM-DD-full-audit-report.md`
- Mỗi task commit partial report khi xong

---

## File Map (đọc theo thứ tự)

| File | Loại | Phase |
|------|------|-------|
| `zygisk/module/module.prop` | KernelSU metadata | 1, 3 |
| `zygisk/module/post-fs-data.sh` | KernelSU hook | 2, 3 |
| `zygisk/module/service.sh` | KernelSU service | 2, 3 |
| `zygisk/module/uninstall.sh` | KernelSU uninstall | 3 |
| `zygisk/src/zygisk_module.cpp` | Zygisk module (595 lines) | 1, 4, 5, 6, 7 |
| `jni/audio_bridge.h` | Shared header | 1, 5 |
| `jni/audio_bridge.cpp` | Native daemon (1687 lines) | 1, 5, 6, 7, 8, 10 |
| `jni/opus_wrapper.cpp` | Opus codec | 1, 10 |
| `jni/opus_wrapper.h` | Opus header | 1 |
| `java/com/audiobridge/AudioBridgeService.java` | Android FGS | 1, 5, 7 |
| `java/com/audiobridge/AudioCapture.java` | Audio capture | 1, 4, 10 |
| `java/com/audiobridge/IPCClient.java` | Unix socket IPC | 1, 5, 8 |
| `java/com/audiobridge/TelephonyHelper.java` | Call/SMS control | 1, 5, 7 |
| `java/com/audiobridge/BootReceiver.java` | Boot broadcast | 1, 2 |
| `java/com/audiobridge/LauncherActivity.java` | Launcher | 1 |
| `server/main.py` | FastAPI server | 1, 8, 9 |
| `server/protocol.md` | Protocol spec | 1, 5, 8 |
| `server/dashboard.html` | Web UI | 1, 8 |
| `server/server.js` | Node.js alt server | 1 |
| `server/requirements.txt` | Python deps | 11 |
| `server/package.json` | Node.js deps | 11 |
| `server/test_client.py` | Test client | 7 |
| `server/test_server.py` | Test server | 7 |
| `server/test_tls.py` | TLS test | 6, 8 |
| `config/audio_bridge.conf` | Config | 1, 13 |
| `config/audio_policy.conf` | Audio policy | 4 |
| `build.sh` | Build automation (900+ lines) | 1, 11 |
| `Android.mk` | NDK build | 1 |
| `Application.mk` | NDK ABI/STL config | 1, 11 |
| `jni/Android.mk` | JNI build | 1 |
| `CMakeLists.txt` | CMake build | 1 |
| `.github/workflows/build.yml` | CI/CD | 1, 11 |
| `scripts/install.sh` | Install script | 2, 3 |
| `scripts/start.sh` | Start script | 2 |
| `scripts/stop.sh` | Stop script | 2 |
| `scripts/uninstall.sh` | Uninstall | 3 |
| `zygisk/module/webroot/app.js` | Web UI JS | 8 |
| `zygisk/module/webroot/index.html` | Web UI HTML | 8 |
| `INSTRUCTION.md` | Dev notes | 1 |
| `README.md` | Overview | 1 |
| `update.json` | KSU update feed | 3 |
| `scratch/check_braces.py` | Debug tool | 13 |
| `scratch/patch_debug.py` | Debug tool | 13 |

---

## Task 1: Project Mapping (Phase 1)

**Files (read all):**
- `README.md`, `INSTRUCTION.md`, `CLAUDE.md`
- `zygisk/module/module.prop`
- `build.sh` (full — 900+ lines)
- `Android.mk`, `Application.mk`, `jni/Android.mk`, `CMakeLists.txt`
- `.github/workflows/build.yml`
- `config/audio_bridge.conf`, `config/audio_policy.conf`
- `update.json`

**Output section:** `## Phase 1 — Repository Structure` trong report

- [ ] **Step 1: Đọc README.md và INSTRUCTION.md**

  ```
  Read: README.md
  Read: INSTRUCTION.md
  ```
  Extract: mục tiêu project, kiến trúc tổng quan, dependencies.

- [ ] **Step 2: Đọc module.prop**

  ```
  Read: zygisk/module/module.prop
  ```
  Extract: id, name, version, versionCode, author, minKernelSU, minMagisk.
  Ghi nhận: module supports KernelSU hay Magisk hay cả hai.

- [ ] **Step 3: Đọc toàn bộ build.sh**

  ```
  Read: build.sh (offset 0, limit 300)
  Read: build.sh (offset 300, limit 300)
  Read: build.sh (offset 600, limit 300)
  ... tiếp tục cho đến hết
  ```
  Extract:
  - Mọi `CFLAGS`, `LDFLAGS`, linker flags
  - NDK version, ABI targets
  - Output file list: APK, zip, .so
  - Mọi `cat >` heredoc sinh ra file gì
  - Thứ tự build steps

- [ ] **Step 4: Đọc build configs**

  ```
  Read: Android.mk
  Read: Application.mk
  Read: jni/Android.mk
  Read: CMakeLists.txt
  ```
  Extract: target ABIs, STL linkage (c++_static/c++_shared/nostdlib++), min API.

- [ ] **Step 5: Đọc CI/CD**

  ```
  Read: .github/workflows/build.yml
  ```
  Extract: NDK version, Java version, Gradle version, secrets used, artifact paths.

- [ ] **Step 6: Vẽ cây thư mục và phân loại**

  Xuất:
  ```
  audio-bridge-concept/
  ├── [BUILD SYSTEM] Android.mk, Application.mk, CMakeLists.txt, build.sh
  ├── [CI/CD] .github/workflows/build.yml
  ├── [CONFIG] config/audio_bridge.conf, config/audio_policy.conf
  ├── [KERNELSU MODULE] zygisk/module/
  │   ├── module.prop
  │   ├── post-fs-data.sh
  │   ├── service.sh
  │   ├── uninstall.sh
  │   └── webroot/ [WEB UI]
  ├── [ZYGISK] zygisk/src/zygisk_module.cpp
  ├── [NATIVE DAEMON] jni/audio_bridge.cpp, jni/audio_bridge.h
  ├── [CODEC] jni/opus_wrapper.cpp, jni/opus_wrapper.h
  ├── [APK/JAVA] java/com/audiobridge/
  ├── [SERVER] server/main.py, server/dashboard.html, ...
  └── [SCRIPTS] scripts/
  ```

- [ ] **Step 7: Ghi vào report và commit partial**

  ```bash
  git add docs/audit/
  git commit -m "audit: Phase 1 — project mapping complete"
  ```

---

## Task 2: Boot Flow Analysis (Phase 2)

**Files:**
- `zygisk/module/post-fs-data.sh`
- `zygisk/module/service.sh`
- `scripts/install.sh`, `scripts/start.sh`, `scripts/stop.sh`
- `java/com/audiobridge/BootReceiver.java`

**Output section:** `## Phase 2 — Boot Flow`

- [ ] **Step 1: Đọc post-fs-data.sh**

  ```
  Read: zygisk/module/post-fs-data.sh
  ```
  Extract:
  - Làm gì ở post-fs-data stage
  - Có mount, copy, chmod gì không
  - Có exit sớm không

- [ ] **Step 2: Đọc service.sh đầy đủ**

  ```
  Read: zygisk/module/service.sh
  ```
  Extract:
  - Thứ tự khởi động daemon
  - Cách pm grant permissions
  - Cách apply SELinux rules
  - APK install logic
  - FGS start logic
  - Background loop (status.json refresh)

- [ ] **Step 3: Đọc BootReceiver.java**

  ```
  Read: java/com/audiobridge/BootReceiver.java
  ```
  Extract:
  - Intent filters
  - Có `BOOT_COMPLETED` receiver không
  - Có conflict với service.sh không (double-start risk)

- [ ] **Step 4: Đọc scripts/**

  ```
  Read: scripts/install.sh
  Read: scripts/start.sh
  Read: scripts/stop.sh
  ```
  Extract: manual install path vs. KernelSU module path.

- [ ] **Step 5: Vẽ sequence diagram**

  ```
  Android Boot
    ↓
  init (stage: post-fs-data)
    ↓ [triggers post-fs-data.sh]
  KernelSU module loader
    ↓ [OverlayFS mount]
  init (stage: late_start service)
    ↓ [triggers service.sh]
  pm grant permissions
    ↓
  apply SELinux rules (magiskpolicy / ksud)
    ↓
  launch audio-bridge daemon ($MODDIR/files/audio-bridge)
    ↓
  wait boot_completed
    ↓
  pm install AudioBridge.apk (if needed)
    ↓
  am start-foreground-service AudioBridgeService
    ↓
  AudioBridgeService.onCreate()
    ↓
  IPCClient connects @audio_bridge socket
    ↓
  [parallel] Zygisk loads arm64-v8a.so into zygote
    ↓
  [every app fork] postAppSpecialize() in Zygisk module
  ```

- [ ] **Step 6: Ghi report, commit**

  ```bash
  git commit -m "audit: Phase 2 — boot flow analysis"
  ```

---

## Task 3: KernelSU Analysis (Phase 3)

**Files:**
- `zygisk/module/module.prop`
- `zygisk/module/post-fs-data.sh`
- `zygisk/module/service.sh`
- `zygisk/module/uninstall.sh`
- `scripts/uninstall.sh`
- `update.json`
- `build.sh` (phần tạo module zip)

**Output section:** `## Phase 3 — KernelSU Analysis`

- [ ] **Step 1: Kiểm tra module.prop fields**

  Đối chiếu với KernelSU Module Guide (https://kernelsu.org/guide/module.html):

  | Field | Required | Present? | Value |
  |-------|----------|----------|-------|
  | id | YES | ? | ? |
  | name | YES | ? | ? |
  | version | YES | ? | ? |
  | versionCode | YES | ? | ? |
  | author | NO | ? | ? |
  | description | NO | ? | ? |
  | minKernelSU | NO | ? | ? |

  Ghi bất kỳ field nào sai format hoặc thiếu.

- [ ] **Step 2: Phân tích hook scripts**

  KernelSU lifecycle hooks theo thứ tự:
  1. `post-fs-data.sh` — runs as root, before /data mounted
  2. `service.sh` — runs as root, after /data mounted, late_start
  3. `boot-completed` (không tồn tại trong repo?) — ghi rõ

  Với mỗi script:
  - Xác định chính xác làm gì
  - Xác định idempotent không (chạy lại lần 2 có an toàn không)
  - Xác định có race condition với KernelSU mount không

- [ ] **Step 3: Kiểm tra OverlayFS**

  Tìm trong `build.sh` và `post-fs-data.sh`:
  - Có tạo `system/` overlay không
  - Có tạo `system.prop` không
  - Cấu trúc zip có đúng KernelSU format không (`META-INF/com/google/android/`)

- [ ] **Step 4: Kiểm tra update.json**

  ```
  Read: update.json
  ```
  Extract: version, zipUrl, changelog URL. Verify format matches KernelSU update feed spec.

- [ ] **Step 5: Ghi findings, commit**

  Ghi rõ mọi điểm khác biệt so với KernelSU official spec.

  ```bash
  git commit -m "audit: Phase 3 — KernelSU analysis"
  ```

---

## Task 4: Zygisk Analysis (Phase 4)

**Files:**
- `zygisk/src/zygisk_module.cpp` (595 lines — đọc toàn bộ)
- `config/audio_policy.conf`
- `java/com/audiobridge/AudioCapture.java`

**Output section:** `## Phase 4 — Zygisk Analysis`

- [ ] **Step 1: Đọc toàn bộ zygisk_module.cpp**

  ```
  Read: zygisk/src/zygisk_module.cpp (offset 0, limit 200)
  Read: zygisk/src/zygisk_module.cpp (offset 200, limit 200)
  Read: zygisk/src/zygisk_module.cpp (offset 400, limit 200)
  ```
  Extract khi đọc:
  - Class name và class hierarchy
  - `REGISTER_ZYGISK_MODULE()` macro location
  - `onLoad()` — ở line bao nhiêu, làm gì
  - `preAppSpecialize()` — filter logic
  - `postAppSpecialize()` — hook installation
  - `preServerSpecialize()` / `postServerSpecialize()` — có không
  - Hook library: shadowhook symbols (`shadowhook_init`, `shadowhook_hook_sym_name`)
  - Mọi `dlopen()` / `dlsym()` call — library nào, symbol nào
  - Allow-list packages

- [ ] **Step 2: Xác định hook framework**

  Tìm trong zygisk_module.cpp:
  ```
  Grep: shadowhook_init
  Grep: shadowhook_hook_sym_name
  Grep: DobbyHook
  Grep: bytehook
  ```
  Ghi rõ: framework nào, version nào (từ `dlopen` path), mode (UNIQUE/SHARED).

- [ ] **Step 3: Liệt kê tất cả hooks**

  Với mỗi `shadowhook_hook_sym_name()` call:
  ```
  Library: <library name>
  Symbol:  <symbol name>
  New fn:  <replacement function>
  Orig:    <original pointer stored where>
  ```

- [ ] **Step 4: Phân tích process filter**

  Trong `preAppSpecialize()`:
  - Package allow-list: liệt kê đầy đủ
  - Có setOption(DLCLOSE_MODULE_LIBRARY) khi không match không
  - Có kiểm tra uid không
  - Có kiểm tra is_child_zygote không

- [ ] **Step 5: Phân tích SHM connection**

  Trong `postAppSpecialize()` hoặc `onLoad()`:
  - Kết nối `@audio_bridge` socket lúc nào
  - Gửi `GET_SHM_FD` — nhận fd qua SCM_RIGHTS
  - `mmap()` — kích thước, flags
  - `module_active` flag được set khi nào

- [ ] **Step 6: Ghi findings, commit**

  ```bash
  git commit -m "audit: Phase 4 — Zygisk analysis"
  ```

---

## Task 5: Call Graph (Phase 5)

**Files:**
- `jni/audio_bridge.cpp` (1687 lines — đọc toàn bộ)
- `jni/audio_bridge.h`
- `java/com/audiobridge/AudioBridgeService.java`
- `java/com/audiobridge/IPCClient.java`
- `java/com/audiobridge/TelephonyHelper.java`
- `server/protocol.md`

**Output section:** `## Phase 5 — Call Graph & Execution Paths`

- [ ] **Step 1: Đọc audio_bridge.h**

  ```
  Read: jni/audio_bridge.h
  ```
  Extract: tất cả structs, enums, constants, logging macros.

- [ ] **Step 2: Đọc audio_bridge.cpp — phần đầu (globals + main)**

  ```
  Read: jni/audio_bridge.cpp (offset 0, limit 300)
  ```
  Extract:
  - Tất cả global variables (tên, type, init value)
  - `main()` function: tham số, signal handlers, thread spawning

- [ ] **Step 3: Đọc audio_bridge.cpp — threads**

  ```
  Read: jni/audio_bridge.cpp (offset 300, limit 300)
  Read: jni/audio_bridge.cpp (offset 600, limit 300)
  Read: jni/audio_bridge.cpp (offset 900, limit 300)
  Read: jni/audio_bridge.cpp (offset 1200, limit 300)
  Read: jni/audio_bridge.cpp (offset 1500, limit 200)
  ```
  Extract với mỗi thread function:
  - Tên function
  - Spawned từ đâu (line bao nhiêu)
  - Loop condition
  - Shared state accessed
  - Blocking calls

- [ ] **Step 4: Vẽ call graph daemon**

  ```
  main()
  ├── signal(SIGPIPE, SIG_IGN)
  ├── setup_shared_memory()
  │   └── memfd_create() / ashmem fallback
  ├── thread: unix_socket_server_thread()
  │   └── accept() loop
  │       ├── GET_SHM_FD → sendmsg(SCM_RIGHTS)
  │       ├── PING → PONG
  │       ├── HELO_JAVA → read_java_client()
  │       └── HELO_AUDIO → read_java_audio_stream()
  ├── thread: tcp_connect_thread()
  │   └── connect(host:59100)
  ├── thread: capture_speaker_thread()
  │   └── SHM speaker_frames → encode Opus → T_SPEAKER frame → TCP
  ├── thread: receive_virtual_mic_thread()
  │   └── TCP → decode Opus → SHM mic_frames
  ├── thread: tinyalsa_mic_inject_thread()
  │   └── SHM mic_frames → pcm_write()
  ├── thread: status_sender_thread()
  │   └── Java events queue → T_CALL_STATUS / T_SMS → TCP
  └── thread: ping_thread()
      └── T_PING / T_PONG keepalive
  ```

- [ ] **Step 5: Đọc Java IPC layer**

  ```
  Read: java/com/audiobridge/IPCClient.java
  Read: java/com/audiobridge/AudioBridgeService.java
  Read: java/com/audiobridge/TelephonyHelper.java
  ```
  Extract:
  - Cách connect `@audio_bridge`
  - `sendEvent()` — ghi trực tiếp hay qua executor?
  - TelephonyHelper callbacks → IPCClient flow

- [ ] **Step 6: Đọc protocol.md**

  ```
  Read: server/protocol.md
  ```
  Extract: frame format, field definitions, state machine.

- [ ] **Step 7: Ghi call graph, commit**

  ```bash
  git commit -m "audit: Phase 5 — call graph complete"
  ```

---

## Task 6: Security Audit (Phase 6)

**Files:** Tất cả file đã đọc ở Task 2-5 + `server/test_tls.py`

**Output section:** `## Phase 6 — Security Findings`

- [ ] **Step 1: Memory safety scan — audio_bridge.cpp**

  Tìm trong audio_bridge.cpp:
  ```
  Grep: malloc|free|new|delete|memcpy|memset|strcpy|sprintf
  Grep: \[.*\].*=  (array writes)
  Grep: pkt\.data\(\)  (vector subscript)
  ```
  Với mỗi match: xác định bounds check có không, OOB possibility.

- [ ] **Step 2: Thread safety scan**

  Tìm tất cả shared mutable state:
  - Global variables không phải `std::atomic`
  - `std::atomic` variables — đảm bảo memory_order đúng
  - `std::mutex` usage — lock/unlock pairs đúng không
  - Thread function có giữ lock qua blocking call không

  Với mỗi shared variable: liệt kê mọi writer thread và reader thread.

- [ ] **Step 3: IPC security scan**

  Unix socket `@audio_bridge`:
  - Abstract namespace — ai có thể connect? (bất kỳ process cùng namespace network)
  - Authentication: có token/nonce không?
  - SCM_CREDENTIALS: có verify PID/UID không?

  TCP port 59100:
  - Bind address: `0.0.0.0` hay `127.0.0.1`?
  - Authentication: có auth token không?
  - TLS: có không?

  SHM:
  - `memfd_create(MFD_CLOEXEC?)` — flag?
  - Zygisk module có thể corrupt SHM layout không?

- [ ] **Step 4: TLS audit**

  ```
  Read: server/test_tls.py
  ```
  - Server có TLS không (check main.py)
  - Certificate validation
  - `server.crt` / `server.key` trong repo — hardcoded private key?

- [ ] **Step 5: SELinux bypass audit**

  Trong service.sh:
  - `magiskpolicy --live` rules — có `allow * * * *` quá rộng không
  - `appops set com.audiobridge RECORD_AUDIO allow` — bypass permission model?

- [ ] **Step 6: Privilege audit**

  Daemon runs as root:
  - Có drop privileges sau init không?
  - Có chroot/seccomp không?

- [ ] **Step 7: Hook safety**

  Trong zygisk_module.cpp:
  - `orig_fn` pointer — được init trước khi gọi hook không?
  - Re-entrant risk: hook fn gọi lại hooked function không?
  - Exception safety trong hook (Zygisk dùng `-fno-exceptions`)

- [ ] **Step 8: Ghi findings theo format**

  Mỗi finding:
  ```
  File: <path>
  Function: <name>
  Line: <N>
  Issue: <type>
  Path: <call chain>
  Reason: <explanation>
  Impact: <effect>
  Severity: Critical | High | Medium | Low
  Fix: <proposed fix>
  ```

  ```bash
  git commit -m "audit: Phase 6 — security audit"
  ```

---

## Task 7: Bug Hunt (Phase 7)

**Files:**
- `jni/audio_bridge.cpp`
- `zygisk/src/zygisk_module.cpp`
- `java/com/audiobridge/IPCClient.java`
- `java/com/audiobridge/TelephonyHelper.java`
- `server/test_client.py`, `server/test_server.py`

**Output section:** `## Phase 7 — Bug Catalog`

- [ ] **Step 1: Off-by-one scan**

  Tìm mọi:
  - `if (len > MAX)` → nên là `>= MAX`?
  - `buf[len]` với `len == sizeof(buf)` → OOB
  - Ring buffer index: `% RING_SIZE` — overflow?

  Với mỗi instance: trace execution path để confirm exploitable.

- [ ] **Step 2: Ring buffer consumer race**

  Tìm mọi nơi đọc `read_index`:
  ```
  Grep: read_index
  Grep: write_index
  Grep: speaker_read_idx
  Grep: speaker_write_idx
  ```
  Với mỗi consumer: xác định có mutex bảo vệ không.
  Với mỗi dual-consumer pair: xác định race window.

- [ ] **Step 3: Java IPC bug scan**

  Trong `IPCClient.java`:
  - `sendEvent()` — gọi từ thread nào?
  - `mOut.println()` vs `mExecutor.execute()` — deadlock risk?
  - Socket close / null check — NPE risk?

- [ ] **Step 4: SMS routing bug**

  Trong `status_sender_thread()`:
  - `json_str.find("\"type\":\"sms")` — match với mọi SMS type variant không?
  - TelephonyHelper.java — callback format là gì chính xác?
  - Có mismatch key giữa Java callback và C++ filter không?

- [ ] **Step 5: Daemon restart handling**

  Zygisk module sau khi daemon restart:
  - `g_active` flag reset không?
  - Reconnect logic có không?
  - SHM fd còn valid không sau daemon restart?

- [ ] **Step 6: Resource leak scan**

  - `pcm_open()` — có `pcm_close()` trong mọi exit path không?
  - `accept()` fd — có `close()` trong mọi exit path không?
  - Thread detach vs join — có leak không?
  - `mmap()` — có `munmap()` không?

- [ ] **Step 7: Ghi bug catalog, commit**

  Format mỗi bug theo Phase 7 template.

  ```bash
  git commit -m "audit: Phase 7 — bug hunt complete"
  ```

---

## Task 8: Network Analysis (Phase 8)

**Files:**
- `server/main.py` (FastAPI)
- `server/dashboard.html`
- `zygisk/module/webroot/app.js`
- `zygisk/module/webroot/index.html`
- `jni/audio_bridge.cpp` (TCP client code)
- `server/server.js`
- `server/requirements.txt`

**Output section:** `## Phase 8 — Network Analysis`

- [ ] **Step 1: Đọc server/main.py**

  ```
  Read: server/main.py (offset 0, limit 300)
  Read: server/main.py (offset 300, limit 300)
  ... tiếp tục
  ```
  Extract:
  - Tất cả HTTP endpoints: path, method, auth requirement
  - WebSocket endpoints
  - TCP server port 59100 handler
  - Authentication mechanism (token)
  - CORS settings
  - TLS (uvicorn ssl_certfile?)
  - Timeout settings
  - Reconnect / retry logic

- [ ] **Step 2: Đọc server/requirements.txt và server.js**

  ```
  Read: server/requirements.txt
  Read: server/server.js
  ```
  Extract: dependency versions, Node.js server as alternative.

- [ ] **Step 3: Đọc WebUI**

  ```
  Read: server/dashboard.html
  Read: zygisk/module/webroot/app.js
  Read: zygisk/module/webroot/index.html
  ```
  Extract:
  - Endpoint URLs hardcoded
  - Auth token handling (localStorage? URL param? header?)
  - WebSocket URL
  - XSS risk: `innerHTML` với unsanitized data?
  - CSRF: fetch with credentials?

- [ ] **Step 4: TCP protocol audit**

  Trong audio_bridge.cpp:
  - Frame format: `[1B type][4B len BE][payload]`
  - Buffer size cho recv — có đủ không?
  - Partial read handling — có loop recv đủ bytes không?
  - Max frame size validation

- [ ] **Step 5: Liệt kê tất cả endpoints**

  Format:
  ```
  Endpoint: GET /api/status
  Auth: Bearer token
  Response: JSON {running, pid, ...}
  Risk: token in status.json webroot (plaintext)
  ```

- [ ] **Step 6: Ghi report, commit**

  ```bash
  git commit -m "audit: Phase 8 — network analysis"
  ```

---

## Task 9: SELinux Analysis (Phase 9)

**Files:**
- `zygisk/module/service.sh` (SELinux rules)
- `build.sh` (sepolicy.rule generation)
- Grep cho `sepolicy.rule`

**Output section:** `## Phase 9 — SELinux Analysis`

- [ ] **Step 1: Tìm tất cả SELinux rules**

  ```
  Grep: allow.*{  (sepolicy rules)
  Grep: sepolicy\.rule
  Grep: magiskpolicy
  Grep: ksud.*sepolicy
  ```

- [ ] **Step 2: Phân tích từng rule**

  Với mỗi `allow <subject> <object>:<class> { <permissions> }`:
  - Subject domain là gì
  - Object type là gì
  - Permission set có quá rộng không
  - Có thể bị exploit bởi malicious app không

- [ ] **Step 3: Kiểm tra `appops set`**

  Trong service.sh:
  - `appops set com.audiobridge RECORD_AUDIO allow`
  - `appops set com.audiobridge SYSTEM_ALERT_WINDOW allow`
  - Ý nghĩa: bypass Android permission dialog
  - Risk: nếu APK bị thay thế bởi malicious package cùng tên

- [ ] **Step 4: Kiểm tra priv-app permissions**

  Tìm trong build.sh:
  ```
  Grep: privapp-permissions
  Grep: CAPTURE_AUDIO_OUTPUT
  ```
  Đánh giá: có file `privapp-permissions-audiobridge.xml` không, nội dung đúng không.

- [ ] **Step 5: Ghi findings, commit**

  ```bash
  git commit -m "audit: Phase 9 — SELinux analysis"
  ```

---

## Task 10: Performance Audit (Phase 10)

**Files:**
- `jni/audio_bridge.cpp` (threading, loops)
- `jni/opus_wrapper.cpp` (codec)
- `java/com/audiobridge/AudioCapture.java`

**Output section:** `## Phase 10 — Performance Findings`

- [ ] **Step 1: Đọc opus_wrapper.cpp**

  ```
  Read: jni/opus_wrapper.cpp
  Read: jni/opus_wrapper.h
  ```
  Extract:
  - Encoder settings: bitrate, complexity, frame size
  - Decoder settings
  - Error handling
  - Reuse encoder/decoder objects không hay recreate mỗi frame?

- [ ] **Step 2: Scan busy loops**

  Tìm trong audio_bridge.cpp:
  ```
  Grep: while.*true
  Grep: for.*;;
  Grep: sleep\|usleep\|nanosleep
  ```
  Với mỗi loop: có sleep/yield không, hay spin 100% CPU?

- [ ] **Step 3: Scan vector operations**

  Tìm:
  ```
  Grep: vector.*erase
  Grep: \.erase\(.*begin
  ```
  O(N) erase từ front → jitter trong audio thread.

- [ ] **Step 4: Scan JNI crossings**

  Trong AudioCapture.java và AudioBridgeService.java:
  - Tần suất gọi native methods
  - Gọi từ audio callback thread không

- [ ] **Step 5: Scan logging**

  ```
  Grep: LOGI\|LOGD\|LOGW
  ```
  Đếm số lần log trong hot path (audio frames).
  Log trong hot path → latency spike.

- [ ] **Step 6: Audio latency chain**

  Tính toán theoretical latency:
  - FRAME_MS = 20ms (từ audio_bridge.h)
  - JITTER_FRAMES = 3 → 60ms buffer
  - SHM ring size = 64 → 1280ms max
  - TCP RTT: không đo được từ code
  - Opus encode/decode latency

- [ ] **Step 7: Ghi findings, commit**

  ```bash
  git commit -m "audit: Phase 10 — performance audit"
  ```

---

## Task 11: Compatibility Audit (Phase 11)

**Files:**
- `Application.mk`, `CMakeLists.txt`, `build.sh`
- `.github/workflows/build.yml`
- `server/requirements.txt`, `server/package.json`
- `zygisk/src/zygisk_module.cpp` (API version checks)
- `java/com/audiobridge/AudioBridgeService.java` (SDK version checks)

**Output section:** `## Phase 11 — Compatibility Matrix`

- [ ] **Step 1: Android API level coverage**

  Tìm trong Java code:
  ```
  Grep: Build\.VERSION\.SDK_INT
  Grep: @RequiresApi
  Grep: if.*API_.*>=
  ```
  Với mỗi version guard: xác định có fallback cho API < threshold không.

- [ ] **Step 2: NDK và ABI**

  Từ Application.mk và build.sh:
  - ABI_FILTER: arm64-v8a only? arm-v7a included?
  - MIN_API: 28? 21?
  - NDK 29 specific features used?

- [ ] **Step 3: KernelSU vs Magisk compat**

  Trong service.sh:
  - `command -v magiskpolicy` vs `[ -f /data/adb/ksud ]` — cả hai path?
  - APK install: `pm install` works both ways?

- [ ] **Step 4: ZygiskNext vs ReZygisk vs Magisk built-in**

  Trong zygisk_module.cpp:
  - Zygisk API version: `ZYGISK_API_VERSION`
  - TLS: đã fix `-nostdlib++` → compat với ZygiskNext restricted linker
  - Re-entrant safe cho ReZygisk?

- [ ] **Step 5: Android 12+ restrictions**

  - FGS `FOREGROUND_SERVICE_TYPE` required từ Android 14?
  - `am start-foreground-service` từ root: exempt từ background restriction?
  - `MediaProjection` requires user consent: ảnh hưởng audio capture?

- [ ] **Step 6: Android 16 issues**

  Service.sh có comment về Android 16 priv-app crash:
  - Xác nhận fix đã đúng
  - `handleBindApplication` crash root cause là gì chính xác

- [ ] **Step 7: tinyalsa compatibility**

  Trong audio_bridge.cpp:
  - Android 12+: HAL owns PCM device → `pcm_open()` fails
  - Fallback path có không?
  - `tinyalsa_mic_inject_thread` có exit gracefully không khi `pcm_open` fails?

- [ ] **Step 8: Python/Node version**

  ```
  Read: server/requirements.txt
  Read: server/package.json
  ```
  Python 3.x minimum? FastAPI version? uvicorn version?

- [ ] **Step 9: Ghi matrix, commit**

  Format:

  | Feature | Android 10 | 11 | 12 | 13 | 14 | 15 | 16 |
  |---------|------------|----|----|----|----|----|----|
  | FGS start | ✓ | ✓ | ? | ? | ? | ? | ? |
  | tinyalsa | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
  | ... | | | | | | | |

  ```bash
  git commit -m "audit: Phase 11 — compatibility audit"
  ```

---

## Task 12: Feature Preparation (Phase 12)

**Files:** Tất cả file đã đọc.

**Output section:** `## Phase 12 — Feature Expansion Opportunities`

- [ ] **Step 1: Identify audio pipeline extension points**

  Trong zygisk_module.cpp:
  - Hook `AudioRecord::read` — có thể extend để capture multiple streams?
  - Hook `AudioTrack::write` — có thể inject synthesized audio?
  - Mỗi opportunity: file, function, line, risk

- [ ] **Step 2: Identify server API extension points**

  Trong server/main.py:
  - Endpoint gap: thiếu endpoint nào hữu ích?
  - WebSocket protocol: có thể thêm bidirectional control?

- [ ] **Step 3: Identify daemon extension points**

  Trong audio_bridge.cpp:
  - Frame types: T_SPEAKER, T_VIRTUAL_MIC, T_CONTROL, T_CALL_STATUS, T_SMS, T_PING, T_PONG
  - Type 0x08-0xFE: available slots cho tính năng mới
  - `unix_socket_server_thread` — có thể thêm command mới

- [ ] **Step 4: Ghi opportunities, commit**

  Mỗi opportunity format:
  ```
  Feature: <tên>
  Entry point: <file>:<function>:<line>
  Dependencies: <cần gì trước>
  Risk: <rủi ro>
  Effort: Low | Medium | High
  ```

  ```bash
  git commit -m "audit: Phase 12 — feature preparation"
  ```

---

## Task 13: Technical Debt (Phase 13)

**Files:** Tất cả file đã đọc + `scratch/check_braces.py`, `scratch/patch_debug.py`

**Output section:** `## Phase 13 — Technical Debt`

- [ ] **Step 1: Scan hardcoded values**

  ```
  Grep: 59100|8000|48000|20|4000
  Grep: "audio_bridge"|"@audio_bridge"
  Grep: "/data/local/tmp"
  Grep: "com\.audiobridge"
  ```
  Phân loại: config-worthy vs intentionally hardcoded.

- [ ] **Step 2: Scan duplicated constants**

  Đã biết: `SHM_RING_SIZE` defined in 3 places (header, daemon, zygisk).
  Tìm thêm: có constant nào khác bị duplicate?

  ```
  Grep: FRAME_SAMPLES|FRAME_BYTES|MAX_PKT|SAMPLE_RATE
  ```

- [ ] **Step 3: Scan God functions**

  Tìm functions > 100 lines:
  - `service.sh` — monolithic
  - `unix_socket_server_thread()` — handles all IPC commands
  - `main()` — spawns all threads
  Ghi: function, line count, responsibilities

- [ ] **Step 4: Scan dead code**

  ```
  Grep: #if 0|\/\*.*unused|TODO|FIXME|HACK|XXX
  ```
  Đọc `scratch/check_braces.py` và `scratch/patch_debug.py` — debug tools trong repo.

- [ ] **Step 5: Scan unsafe singletons và globals**

  Tìm tất cả `static` globals trong audio_bridge.cpp:
  - Không phải `std::atomic` nhưng accessed từ nhiều thread
  - Không có mutex protection

- [ ] **Step 6: Ghi debt list, commit**

  ```bash
  git commit -m "audit: Phase 13 — technical debt"
  ```

---

## Task 14: Final Report (Phase 14)

**Output:** `docs/audit/2026-06-20-full-audit-report.md`

- [ ] **Step 1: Compile Executive Summary**

  - Tóm tắt: project làm gì, kiến trúc, 3-5 critical findings
  - Risk rating tổng thể: Critical / High / Medium / Low

- [ ] **Step 2: Assemble all sections**

  Ghép tất cả partial outputs từ Task 1-13 thành report cuối.

  Sections:
  1. Executive Summary
  2. Architecture Diagram
  3. Boot Flow Sequence
  4. KernelSU Analysis
  5. Zygisk Analysis
  6. Security Findings (sorted by severity)
  7. Performance Findings
  8. Compatibility Matrix
  9. Technical Debt List
  10. Critical Bugs (với fix proposals)
  11. Refactor Roadmap
  12. Feature Roadmap
  13. References

- [ ] **Step 3: Refactor Roadmap**

  Priority order:
  1. Critical security fixes (blocking)
  2. Critical crash fixes (blocking)
  3. High severity bugs
  4. Technical debt với highest ROI
  5. Performance improvements
  6. Compatibility fixes

- [ ] **Step 4: Feature Roadmap**

  Phase tiếp theo từ Phase 12 findings.

- [ ] **Step 5: Self-review**

  Chạy checklist:
  - [ ] Mọi Phase 1-13 đã có section trong report
  - [ ] Không có "có thể", "dường như", "có lẽ" trong report
  - [ ] Mọi finding có file + function + line
  - [ ] Severity đã gán cho mọi bug
  - [ ] Fix đã proposed cho mọi Critical/High bug

- [ ] **Step 6: Final commit**

  ```bash
  git add docs/audit/
  git commit -m "audit: Phase 14 — final report complete"
  ```

---

## References

- KernelSU Module Guide: https://kernelsu.org/guide/module.html
- Zygisk API: https://github.com/topjohnwu/Magisk/blob/master/native/src/zygisk/api.hpp
- ZygiskNext: https://github.com/Dr-TSNG/ZygiskNext
- shadowhook: https://github.com/bytedance/android-inline-hook
- Android NDK 29 Release Notes (NDK team, accessed 2026-06-20)
- TinyALSA: https://github.com/tinyalsa/tinyalsa
- Opus Codec: https://opus-codec.org/docs/

---

*Plan created: 2026-06-20 | Scope: Full 14-phase audit | Estimated: 8-12 hours agentic execution*
