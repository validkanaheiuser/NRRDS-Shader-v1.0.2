# Kế hoạch: Đổi cơ chế TCP → Poll-based control + Audio on-demand

Ngày: 2026-07-30
Trạng thái: **SUPERSEDED** — sau khi so sánh FCM vs Control Socket vs Polling, user
chọn **Control Socket**. Hoá ra kiến trúc này **đã tồn tại** trong daemon (TCP bền
vững + audio on-demand theo `voice_call_start`). Việc cần làm chỉ là làm socket **nhẹ
khi idle** để tiết kiệm pin — đã implement trong `jni/audio_bridge.cpp` (nới TCP
keepalive 5s→60s, app ping 15s→60s, tách `get_device_status`, tất cả cấu hình được qua
config.json). Tài liệu poll bên dưới giữ lại để tham khảo, KHÔNG còn là hướng đang làm.

---

## 1. Quyết định đã chốt (từ trao đổi với user)

- **Không dùng Firebase/FCM.** Chỉ phụ thuộc server của user.
- **Control (server→phone): Android poll HTTPS mỗi 5–10s (cố định).** User chấp nhận
  đánh đổi pin khi máy rảnh, ưu tiên đơn giản + chỉ dựa vào server mình.
- **Audio: chỉ realtime khi đang gọi.** Mở TCP on-demand, xong cuộc gọi thì đóng.
- **Event (phone→server): báo ngay khi có cuộc gọi/SMS đến** (không đợi đủ vòng poll
  cho những việc gấp; SMS có thể piggyback vòng poll kế nếu muốn đơn giản).

### Giả định cần user xác nhận
- **Vòng poll đặt trong DAEMON ROOT** (không phải app Java). Lý do: daemon là tiến trình
  native chạy root → có thể dùng wakeup alarm (`CLOCK_BOOTTIME_ALARM`) để poll đúng 5–10s
  kể cả khi máy khoá màn hình/Doze. Nếu đặt trong app, Doze sẽ hoãn poll → không đạt 5–10s
  khi khoá màn hình (chỉ hợp nếu máy luôn cắm sạc/thức).

## 2. Kiến trúc mới

```
IDLE:  Không TCP. Daemon root poll POST /api/sync mỗi 5–10s (TLS).
       Mỗi vòng: gửi event đang chờ + nhận lệnh đang chờ.

LỆNH DASHBOARD (dial/send_sms/hangup/answer):
       Dashboard → /ws/ui → server enqueueCommand(deviceId, cmd)
       → vòng /api/sync kế tiếp phone nhận lệnh → forward xuống Java qua IPC
       → Java thực thi (TelephonyHelper) → kết quả báo lại ở vòng sync sau.

CUỘC GỌI ĐẾN / DIAL KẾT NỐI:
       Java báo call_status=active cho daemon (IPC)
       → daemon MỞ TCP :59100 + handshake HMAC (giữ nguyên) + voice_rx/voice_tx
       → audio realtime tới dashboard qua /ws/audio/{device_id} (giữ nguyên).

SMS ĐẾN:
       Java báo daemon (IPC) → daemon đẩy event vào hàng chờ → gửi ở /api/sync
       (hoặc trigger 1 vòng sync ngay để dashboard thấy nhanh).

KẾT THÚC GỌI:
       Java báo call_status=idle → daemon đóng TCP audio → về IDLE (chỉ còn poll).
```

Ba kênh:

| Kênh | Cơ chế | Cổng | Khi nào |
|------|--------|------|---------|
| Control 2 chiều | HTTP(S) `POST /api/sync` | 8000 | Mỗi 5–10s |
| Audio | TCP frame (giao thức cũ) | 59100 | Chỉ khi đang gọi |
| Dashboard | WS `/ws/ui`, `/ws/audio` | 8000 | Khi mở dashboard |

## 3. Giao thức mới

### `POST /api/sync` (phone → server, mỗi 5–10s)

Auth: **HMAC-SHA256** header (tách biệt với session user của dashboard).
Ký trên `method + path + timestamp + nonce + body` để chống replay.

Headers:
```
X-Device-Id: <device_id>
X-Timestamp: <unix ms>
X-Nonce: <random hex>
X-Signature: hex(HMAC-SHA256(AUDIO_BRIDGE_TOKEN, method|path|ts|nonce|sha256(body)))
```

Request body (phone→server):
```json
{
  "events": [
    {"kind":"sms","data":{...}},
    {"kind":"call_status","data":{"state":"ringing","number":"+8490..."}}
  ],
  "acks": ["cmd_id_1", "cmd_id_2"],
  "features": ["sms","call"],
  "info": {"brand":"...","android":"...","name":"..."}
}
```

Response (server→phone):
```json
{
  "commands": [
    {"id":"cmd_abc","command":"dial","params":{"number":"+8490..."}},
    {"id":"cmd_def","command":"send_sms","params":{"number":"...","message":"..."}}
  ],
  "next_poll_ms": 5000
}
```

- `commands`: lệnh đang chờ, kèm `id`. Server chuyển sang trạng thái "in-flight".
  Phone thực thi xong → đưa id vào `acks` vòng sau → server xoá.
- Idempotency theo `id`: nếu phone chạy rồi mà chưa ack (mất mạng), lệnh vẫn in-flight;
  phone phải nhớ id đã chạy để không chạy 2 lần.
- `next_poll_ms`: server điều nhịp (mặc định 5000). Cho phép sau này làm adaptive mà
  không đổi client.

### Audio TCP `:59100` — GIỮ NGUYÊN
Handshake HMAC + frame `[1B type][4B len BE][payload]`, T_SPEAKER/T_VIRTUAL_MIC/... không đổi.
Khác biệt duy nhất: **daemon chỉ connect khi có cuộc gọi**, không giữ bền vững.

## 4. Thay đổi theo file

### server/server.js
1. **`handleAPI`**: thêm nhánh `POST /api/sync` (đặt TRƯỚC các route session-user).
   - Middleware `verifyDeviceHmac(req, rawBody)` → 401 nếu sai.
   - Ingest `events` → `mgr.broadcastEvent({type:'event', kind, device_id, data})`
     (dùng lại đúng format hiện có, kể cả wrap SMS như CLAUDE.md yêu cầu).
   - Xử lý `acks` → xoá khỏi in-flight.
   - Cập nhật presence: `device.lastSyncTs = Date.now()` (tạo device entry nếu chưa có,
     từ `info`). Đây là nguồn "online" mới thay cho TCP handshake.
   - Trả `commands` (pending → in-flight) + `next_poll_ms`.
2. **Command queue**: thêm `Map<deviceId, {pending:[], inflight:Map}>` + helpers
   `enqueueCommand`, `takePending`, `ackCommand`. Sinh `id` bằng `crypto.randomUUID()`.
3. **`handleUI`**: đổi `dial/answer/hangup/send_sms/...` từ `d.sendControl(...)` (push TCP)
   → `enqueueCommand(did, {command, params})`. Trả về UI trạng thái "queued".
4. **`DeviceManager`**: thêm `lastSyncTs`; "online" = synced trong ~2.5× poll interval.
   Cần cho phép device tồn tại mà KHÔNG có TCP (hiện device tạo lúc handshake TCP).
   Audio TCP khi connect sẽ **tra cứu/áp AudioHub theo device_id** đã có.
5. **`/api/devices`** (dashboard): thêm cờ `online` dựa trên `lastSyncTs`.
6. Giữ nguyên: TCP server :59100, AudioHub, `/ws/audio`, `/ws/ui` audio path.

### jni/audio_bridge.cpp
1. **Bỏ vòng giữ TCP bền vững cho control** (vòng `while(g_running && g_connected)` nhận
   T_CONTROL). T_CONTROL không còn tới qua TCP.
2. **Thêm control loop mới (HTTP client qua mbedtls TLS):**
   - Timer wakeup: `timerfd_create(CLOCK_BOOTTIME_ALARM)` mỗi `next_poll_ms`.
   - Mỗi tick: build `POST /api/sync` (HMAC header) → đọc response → parse `commands`.
   - Với mỗi command: map sang IPC Java qua `send_to_java_raw(...)` — TÁI SỬ DỤNG đúng
     logic đang có ở nhánh T_CONTROL (`dial→place_call`, `hangup→end_call`,
     `answer→answer_call`, `send_sms`, dtmf, audio_route, volume...).
   - Gom event từ Java (sms, call_status) vào hàng chờ để gửi vòng sau; ack command đã chạy.
   - **Native task mới lớn nhất**: HTTP/1.1 client tối giản trên mbedtls (build request,
     đọc status + Content-Length + body). Xem mục Quyết định #A.
3. **Audio TCP on-demand:**
   - Nghe call_status từ Java (đã có `g_call_state`): active/offhook → `tcp_connect` +
     `handshake` + start voice threads; idle → đóng TCP, dừng threads.
   - `handshake()`, `voice_rx()`, `voice_tx()`, `send_frame()` giữ nguyên.

### java/com/audiobridge/*
- **Gần như không đổi** nếu poll đặt trong daemon. Java tiếp tục:
  - Nhận `place_call/end_call/answer_call/send_sms/...` từ daemon qua IPC (đã có).
  - Gửi `call_status` + `sms_received` lên daemon qua IPC (đã có).
- Chỉ cần đảm bảo foreground service giữ daemon sống (đã có `AudioBridgeService`).

### server/dashboard (Vue)
- Hiển thị `online` theo lastSync; dial/SMS giờ là **bất đồng bộ** (trạng thái queued →
  sent → done thay vì phản hồi tức thì). Thêm toast "đã gửi, chờ máy nhận (≤10s)".

## 5. Bảo mật
- Device auth = HMAC-SHA256 với `AUDIO_BRIDGE_TOKEN` (đã có), thêm timestamp+nonce chống
  replay; từ chối nếu `|now - ts| > 30s` hoặc nonce đã dùng (LRU cache nonce).
- `/api/sync` KHÔNG dùng session-user; tách hẳn khỏi auth dashboard.
- Audio TCP handshake HMAC giữ nguyên.

## 6. Edge cases / rủi ro
- **Mất mạng giữa chừng khi đã chạy lệnh nhưng chưa ack** → phone lưu id đã chạy (đĩa/nvram)
  để idempotent; server giữ in-flight với timeout (vd 60s) rồi mới coi là fail.
- **Nhiều lệnh dồn**: queue giữ thứ tự; giới hạn độ dài để tránh phình.
- **Cuộc gọi đến ngay khi đang poll**: daemon mở audio TCP độc lập với vòng poll; hai luồng
  không chặn nhau.
- **Doze bóp app**: đã tránh bằng cách đặt poll trong daemon root + wakeup alarm.
- **Không có root / daemon chết**: mất control hoàn toàn → cần foreground service tự
  respawn daemon (kiểm tra service.sh + watchdog).
- **Trễ audio khi bắt đầu gọi**: tốn thời gian tcp_connect+TLS handshake mỗi cuộc gọi
  (~vài trăm ms) — chấp nhận được.

## 7. Các phase triển khai (review/merge từng phase)

- **Phase 1 — Server: sync API + command queue + HMAC device auth.**
  Không đụng phone. Test bằng curl/test_client giả lập phone poll.
  DoD: enqueue dial qua /ws/ui → curl /api/sync nhận được command → ack → biến mất.
- **Phase 2 — Server: presence theo lastSync + /api/devices online + UI queued state.**
- **Phase 3 — Daemon: control loop HTTP poll + map command → IPC Java + wakeup alarm.**
  DoD: dashboard dial → máy thật quay số trong ≤10s.
- **Phase 4 — Daemon: audio TCP on-demand theo call_status; bỏ TCP bền vững.**
  DoD: chỉ có TCP :59100 khi đang gọi; idle không có kết nối.
- **Phase 5 — Event phone→server (SMS/call_status) qua /api/sync (+ trigger sync ngay).**
- **Phase 6 (tùy chọn) — adaptive next_poll_ms; watchdog respawn daemon.**

## 8. Quyết định còn mở (cần user chốt khi vào Phase 1/3)

- **#A. Cách daemon "poll":**
  - (A1) **HTTP/1.1 over mbedtls TLS** tới `/api/sync` — đúng mô hình "HTTPS response"
    user muốn; tốn công viết HTTP client tối giản trong C++.
  - (A2) **Frame-based sync trên :59100** (kết nối ngắn, dùng lại mbedtls+frame sẵn có,
    thêm T_SYNC) — ít code native hơn, nhưng handshake TLS mỗi 5–10s hơi tốn; và không
    phải "HTTP" đúng nghĩa.
  - Khuyến nghị: A1 (khớp ý user) trừ khi muốn tối giản native → A2.
- **#B. Vị trí poll loop:** daemon root (khuyến nghị, sống trong Doze) vs app Java
  (chỉ hợp nếu máy luôn thức).
- **#C. SMS đến:** piggyback vòng poll kế (đơn giản, ≤10s trễ) vs trigger sync ngay
  (nhanh hơn, thêm chút logic).
