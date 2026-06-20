/**
 * Audio Bridge - Complete System with Telephony & SMS Control
 * Version: 3.0
 * License: MIT
 */

#include <limits.h>
#include <climits>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <time.h>
#include <sys/system_properties.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <sys/prctl.h>
#include <signal.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <pthread.h>
#include <tinyalsa/asoundlib.h>
#include <opus/opus.h>
#include <mbedtls/net_sockets.h>
#include <mbedtls/ssl.h>
#include <mbedtls/entropy.h>
#include <mbedtls/ctr_drbg.h>
#include <mbedtls/error.h>
#include <mbedtls/debug.h>
#include <vector>
#include <deque>
#include <queue>
#include <mutex>
#include <atomic>
#include <thread>
#include <chrono>
#include <string>
#include <map>
#include <condition_variable>
#include <sstream>
#include <iomanip>
#include <sys/resource.h>

// ──────────────────────────────────────────────────────────────────────────
// Configuration Constants
// ──────────────────────────────────────────────────────────────────────────

#include "audio_bridge.h"

static const char* g_host        = nullptr;
static int         g_port        = 59100;
static const char* g_token       = nullptr;  // required: set from config.json
static const char* g_socket_path = "/data/local/tmp/audio_bridge.sock";
static const char* g_pid_file    = "/data/local/tmp/audio_bridge.pid";
static const int   JITTER_FRAMES = 6;

// ──────────────────────────────────────────────────────────────────────────
// Global State
// ──────────────────────────────────────────────────────────────────────────

static std::atomic<bool> g_running{true};
static std::atomic<bool> g_connected{false};
static std::atomic<int>  g_call_state{CALL_IDLE};

static std::mutex              g_status_mutex;
static std::condition_variable g_status_cv;
static std::queue<std::string> g_status_queue;
static std::atomic<bool>       g_status_pending{false};

static std::mutex              g_call_mutex;
static std::string             g_current_number;
static std::map<std::string, std::string> g_active_calls;

// ──────────────────────────────────────────────────────────────────────────
// JSON Helper (Minimal implementation without external lib)
// ──────────────────────────────────────────────────────────────────────────

class SimpleJson {
public:
    enum Type { OBJECT, ARRAY, STRING, NUMBER, BOOLEAN, NULL_TYPE };
    
    Type type;
    std::string string_value;
    double number_value;
    bool bool_value;
    std::map<std::string, SimpleJson> object_value;
    std::vector<SimpleJson> array_value;
    
    SimpleJson() : type(NULL_TYPE) {}
    SimpleJson(Type t) : type(t) {}
    SimpleJson(const std::string& str) : type(STRING), string_value(str) {}
    SimpleJson(const char* str) : type(STRING), string_value(str) {}
    SimpleJson(double num) : type(NUMBER), number_value(num) {}
    SimpleJson(bool b) : type(BOOLEAN), bool_value(b) {}
    
    std::string toString() const {
        std::ostringstream oss;
        serialize(oss);
        return oss.str();
    }
    
    void serialize(std::ostringstream& oss) const {
        switch(type) {
            case OBJECT:
                oss << "{";
                {
                    bool first = true;
                    for(const auto& p : object_value) {
                        if(!first) oss << ",";
                        oss << "\"" << escape(p.first) << "\":";
                        p.second.serialize(oss);
                        first = false;
                    }
                }
                oss << "}";
                break;
            case ARRAY:
                oss << "[";
                {
                    bool first = true;
                    for(const auto& v : array_value) {
                        if(!first) oss << ",";
                        v.serialize(oss);
                        first = false;
                    }
                }
                oss << "]";
                break;
            case STRING:
                oss << "\"" << escape(string_value) << "\"";
                break;
            case NUMBER:
                oss << std::fixed << number_value;
                break;
            case BOOLEAN:
                oss << (bool_value ? "true" : "false");
                break;
            case NULL_TYPE:
                oss << "null";
                break;
        }
    }
    
    static std::string escape(const std::string& s) {
        std::string result;
        for(char c : s) {
            switch(c) {
                case '"': result += "\\\""; break;
                case '\\': result += "\\\\"; break;
                case '\n': result += "\\n"; break;
                case '\r': result += "\\r"; break;
                case '\t': result += "\\t"; break;
                default: result += c;
            }
        }
        return result;
    }
    
    static SimpleJson parse(const std::string& json) {
        // Simplified parser for demo - use jsoncpp in production
        SimpleJson obj;
        obj.type = OBJECT;
        
        // Very basic parsing - just enough for our protocol
        size_t pos = json.find("\"command\"");
        if(pos != std::string::npos) {
            pos = json.find(":", pos);
            if(pos != std::string::npos) {
                size_t start = json.find("\"", pos + 1);
                size_t end = json.find("\"", start + 1);
                if(start != std::string::npos && end != std::string::npos) {
                    obj.object_value["command"] = SimpleJson(json.substr(start + 1, end - start - 1));
                }
            }
        }
        
        pos = json.find("\"number\"");
        if(pos != std::string::npos) {
            pos = json.find(":", pos);
            if(pos != std::string::npos) {
                size_t start = json.find("\"", pos + 1);
                size_t end = json.find("\"", start + 1);
                if(start != std::string::npos && end != std::string::npos) {
                    obj.object_value["number"] = SimpleJson(json.substr(start + 1, end - start - 1));
                }
            }
        }
        
        pos = json.find("\"message\"");
        if(pos != std::string::npos) {
            pos = json.find(":", pos);
            if(pos != std::string::npos) {
                size_t start = json.find("\"", pos + 1);
                size_t end = json.find("\"", start + 1);
                if(start != std::string::npos && end != std::string::npos) {
                    obj.object_value["message"] = SimpleJson(json.substr(start + 1, end - start - 1));
                }
            }
        }

        // Parse string fields for new commands
        for (const char* key : {"digit", "route"}) {
            std::string needle = std::string("\"") + key + "\"";
            pos = json.find(needle);
            if(pos != std::string::npos) {
                pos = json.find(":", pos);
                if(pos != std::string::npos) {
                    size_t start = json.find("\"", pos + 1);
                    size_t end = json.find("\"", start + 1);
                    if(start != std::string::npos && end != std::string::npos) {
                        obj.object_value[key] = SimpleJson(json.substr(start + 1, end - start - 1));
                    }
                }
            }
        }

        // Parse "on" (boolean)
        pos = json.find("\"on\"");
        if(pos != std::string::npos) {
            pos = json.find(":", pos);
            if(pos != std::string::npos) {
                size_t vpos = pos + 1;
                while(vpos < json.size() && (json[vpos] == ' ' || json[vpos] == '\t')) vpos++;
                obj.object_value["on"] = SimpleJson(json.compare(vpos, 4, "true") == 0);
            }
        }

        // Parse "level" (number)
        pos = json.find("\"level\"");
        if(pos != std::string::npos) {
            pos = json.find(":", pos);
            if(pos != std::string::npos) {
                size_t vpos = pos + 1;
                while(vpos < json.size() && (json[vpos] == ' ' || json[vpos] == '\t')) vpos++;
                size_t end = vpos;
                while(end < json.size() && (isdigit((unsigned char)json[end]) || json[end] == '-' || json[end] == '.')) end++;
                if(end > vpos) {
                    try { obj.object_value["level"] = SimpleJson(std::stod(json.substr(vpos, end - vpos))); }
                    catch(...) {}
                }
            }
        }

        return obj;
    }

    std::string getString(const std::string& key, const std::string& def = "") const {
        auto it = object_value.find(key);
        return (it != object_value.end() && it->second.type == STRING) ?
               it->second.string_value : def;
    }

    bool getBool(const std::string& key, bool def = false) const {
        auto it = object_value.find(key);
        if (it == object_value.end()) return def;
        if (it->second.type == BOOLEAN) return it->second.bool_value;
        if (it->second.type == NUMBER)  return it->second.number_value != 0.0;
        return def;
    }

    double getNumber(const std::string& key, double def = 0.0) const {
        auto it = object_value.find(key);
        if (it == object_value.end()) return def;
        if (it->second.type == NUMBER) return it->second.number_value;
        if (it->second.type == STRING) {
            try { return std::stod(it->second.string_value); } catch(...) {}
        }
        return def;
    }

    bool hasKey(const std::string& key) const {
        return object_value.find(key) != object_value.end();
    }
};

static std::mutex              g_sms_mutex;
static std::map<std::string, SimpleJson> g_sms_tracking;

static std::mutex              g_log_mutex;
static FILE*                   g_log_file = nullptr;

static std::atomic<int>        g_java_fd{-1};

// TLS State
static mbedtls_net_context      g_net;
static mbedtls_entropy_context  g_entropy;
static mbedtls_ctr_drbg_context g_ctr_drbg;
static mbedtls_ssl_context      g_ssl;
static mbedtls_ssl_config       g_conf;
static std::mutex               g_tls_write_mutex;

// ──────────────────────────────────────────────────────────────────────────
// Logging Utilities
// ──────────────────────────────────────────────────────────────────────────

#define LOG_TAG "AudioBridge"

static std::string read_self_context() {
    FILE* f = fopen("/proc/self/attr/current", "r");
    if (!f) return "unknown";
    char buf[256] = {0};
    size_t n = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    if (n == 0) return "unknown";
    // Strip trailing whitespace/nulls
    while (n > 0 && (buf[n-1] == '\n' || buf[n-1] == ' ' || buf[n-1] == '\0')) {
        buf[--n] = '\0';
    }
    return std::string(buf);
}

static void log_init() {
    g_log_file = fopen("/data/local/tmp/audio_bridge.log", "a");
    if(g_log_file) {
        time_t now = time(nullptr);
        fprintf(g_log_file, "\n=== Audio Bridge v%d.%d.%d started at %s ===\n",
                VERSION_MAJOR, VERSION_MINOR, VERSION_PATCH, ctime(&now));
        fflush(g_log_file);
    }
}

static void log_write(const char* level, const char* fmt, ...) {
    std::lock_guard<std::mutex> lk(g_log_mutex);
    
    time_t now = time(nullptr);
    struct tm tm;
    localtime_r(&now, &tm);
    
    char time_buf[32];
    strftime(time_buf, sizeof(time_buf), "%Y-%m-%d %H:%M:%S", &tm);
    
    va_list args;
    va_start(args, fmt);
    
    // Console output
    fprintf(stderr, "[%s] [%s] ", time_buf, level);
    vfprintf(stderr, fmt, args);
    fprintf(stderr, "\n");
    
    // File output
    if(g_log_file) {
        fprintf(g_log_file, "[%s] [%s] ", time_buf, level);
        vfprintf(g_log_file, fmt, args);
        fprintf(g_log_file, "\n");
        fflush(g_log_file);
    }
    
    va_end(args);
}

#define LOGI(...) log_write("INFO", __VA_ARGS__)
#define LOGW(...) log_write("WARN", __VA_ARGS__)
#define LOGE(...) log_write("ERROR", __VA_ARGS__)
#define LOGD(...) log_write("DEBUG", __VA_ARGS__)

// Forward declarations for network utilities used by voice threads
static bool send_frame(mbedtls_net_context* net, uint8_t type, const void* data, uint32_t len);
static bool send_all(mbedtls_net_context* net, const void* data, size_t len);

// ── Daemon Configuration ──────────────────────────────────────────────────────
struct DaemonConfig {
    char host[256]              = {};
    int  port                   = 59100;
    char token[256]             = {};
    bool use_tls                = false;
    char server_cert_sha256[65] = {};
    int  pcm_card               = 0;
    int  pcm_tx_device          = 27;
    int  pcm_rx_device          = 0;
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

// ── Voice Call PCM Context ────────────────────────────────────────────────────
static constexpr int TX_TARGET_FRAMES = 5;
static constexpr int TX_MAX_FRAMES    = 15;

struct VoiceCallContext {
    std::atomic<bool> active{false};
    std::atomic<bool> reconnecting{false};

    struct pcm*             tx_pcm = nullptr;
    std::mutex              pcm_mtx;
    std::deque<std::vector<uint8_t>> tx_queue;
    std::mutex              queue_mtx;
    std::condition_variable queue_cv;

    struct pcm*             rx_pcm = nullptr;

    std::thread             tx_thread;
    std::thread             rx_thread;

    int sim_slot = -1;
};

static VoiceCallContext g_voice;
static std::atomic<time_t> g_last_pong{0};

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
    set_ctl(mix, "Incall_Music Audio Mixer MultiMedia9", 1);
    set_ctl(mix, "MultiMedia1 Mixer VOC_REC_DL", 1);
    const int mute_vals[] = {1, -1, 20};
    set_ctl_array(mix, "Voice Tx Device Mute", mute_vals, 3);
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

static void enqueue_tx_opus_frame(const uint8_t* data, int len) {
    std::vector<uint8_t> pkt(data, data + len);
    {
        std::unique_lock<std::mutex> lk(g_voice.queue_mtx);
        while ((int)g_voice.tx_queue.size() >= TX_MAX_FRAMES) {
            g_voice.tx_queue.pop_front();
            LOGW("tx queue full, dropping oldest frame");
        }
        g_voice.tx_queue.push_back(std::move(pkt));
    }
    g_voice.queue_cv.notify_one();
}

static bool attempt_reopen_tx_pcm() {
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

static void voice_tx_thread() {
    prctl(PR_SET_NAME, "ab-voice-tx", 0, 0, 0);
    struct sched_param sp{}; sp.sched_priority = 3;
    if (pthread_setschedparam(pthread_self(), SCHED_RR, &sp) != 0)
        setpriority(PRIO_PROCESS, 0, -15);

    int err;
    OpusDecoder* dec = opus_decoder_create(SAMPLE_RATE, CHANNELS, &err);
    if (!dec) { LOGE("voice_tx: opus_decoder_create failed: %d", err); return; }

    std::vector<int16_t> pcm_buf(FRAME_SAMPLES);

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

        int n;
        if (got_pkt) {
            n = opus_decode(dec, pkt.data(), (opus_int32)pkt.size(),
                            pcm_buf.data(), FRAME_SAMPLES, 0);
        } else {
            n = opus_decode(dec, nullptr, 0, pcm_buf.data(), FRAME_SAMPLES, 0);
        }
        if (n < 0) {
            LOGW("voice_tx: opus_decode error %d", n);
            memset(pcm_buf.data(), 0, FRAME_SAMPLES * 2);
        }

        {
            std::lock_guard<std::mutex> lk(g_voice.pcm_mtx);
            if (!g_voice.tx_pcm) continue;
            int r = pcm_write(g_voice.tx_pcm, pcm_buf.data(), FRAME_SAMPLES * 2);
            if (r != 0) {
                const char* errmsg = pcm_get_error(g_voice.tx_pcm);
                if (errmsg && strstr(errmsg, "Broken pipe")) {
                    pcm_prepare(g_voice.tx_pcm);
                } else {
                    LOGW("voice_tx: pcm_write failed: %s", errmsg ? errmsg : "?");
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
        struct pcm* snap;
        {
            std::lock_guard<std::mutex> lk(g_voice.pcm_mtx);
            snap = g_voice.rx_pcm;
            if (!snap) break;
        }
        int r = pcm_read(snap, pcm_buf.data(), FRAME_SAMPLES * 2);
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

    if (g_voice.tx_thread.joinable()) g_voice.tx_thread.join();
    if (g_voice.rx_thread.joinable())  g_voice.rx_thread.join();

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

static void handle_java_ipc_message(const char* json_str, size_t len) {
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
        std::lock_guard<std::mutex> lk(g_status_mutex);
        g_status_queue.push(std::string(json_str, len));
        g_status_pending = true;
        g_status_cv.notify_one();
        return;
    }

    if (strstr(json_str, "\"type\":\"device_info\"") ||
        strstr(json_str, "\"type\":\"device_status\"")) {
        std::lock_guard<std::mutex> lk(g_status_mutex);
        g_status_queue.push(std::string(json_str, len));
        g_status_pending = true;
        g_status_cv.notify_one();
        return;
    }

    {
        std::lock_guard<std::mutex> lk(g_status_mutex);
        g_status_queue.push(std::string(json_str, len));
        g_status_pending = true;
    }
    g_status_cv.notify_one();
}

static void send_to_java_raw(const char* json_str) {
    int fd = g_java_fd.load();
    if (fd < 0) return;
    std::string msg = std::string(json_str) + "\n";
    ssize_t r = write(fd, msg.c_str(), msg.size());
    (void)r;
}

// ──────────────────────────────────────────────────────────────────────────
// System Helpers
// ──────────────────────────────────────────────────────────────────────────

static std::string get_prop(const char* key, const char* def = "") {
    char val[PROP_VALUE_MAX] = {};
    __system_property_get(key, val);
    return val[0] ? val : def;
}

static std::string get_device_id() {
    const char* ID_FILE = "/data/local/tmp/audio_bridge_id";
    FILE* f = fopen(ID_FILE, "r");
    static char buf[64];
    
    if(f && fscanf(f, "%63s", buf) == 1 && buf[0]) { 
        fclose(f); 
        return buf; 
    }
    if(f) fclose(f);
    
    std::string s = get_prop("ro.serialno");
    if(s.empty()) {
        srand(time(nullptr) ^ getpid());
        snprintf(buf, sizeof(buf), "%08x%08x", rand(), rand());
        s = buf;
    }
    
    if((f = fopen(ID_FILE, "w"))) {
        fprintf(f, "%s\n", s.c_str());
        fclose(f);
        chmod(ID_FILE, 0600);
    }
    return s;
}

static void write_pid_file() {
    FILE* f = fopen(g_pid_file, "w");
    if(f) {
        fprintf(f, "%d\n", getpid());
        fclose(f);
    }
}

static void send_to_java(const SimpleJson& json) {
    int fd = g_java_fd.load();
    if (fd >= 0) {
        std::string serialized = json.toString() + "\n";
        send(fd, serialized.c_str(), serialized.length(), 0);
    } else {
        LOGW("Cannot send to Java: IPC disconnected");
    }
}

static void jni_place_call(const std::string& number) {
    SimpleJson json;
    json.type = SimpleJson::OBJECT;
    json.object_value["command"] = SimpleJson("place_call");
    json.object_value["number"] = SimpleJson(number);
    send_to_java(json);
}

static void jni_end_call() {
    SimpleJson json;
    json.type = SimpleJson::OBJECT;
    json.object_value["command"] = SimpleJson("end_call");
    send_to_java(json);
}

static void jni_answer_call() {
    SimpleJson json;
    json.type = SimpleJson::OBJECT;
    json.object_value["command"] = SimpleJson("answer_call");
    send_to_java(json);
}

static std::string jni_send_sms(const std::string& number, const std::string& message) {
    SimpleJson json;
    json.type = SimpleJson::OBJECT;
    json.object_value["command"] = SimpleJson("send_sms");
    json.object_value["number"] = SimpleJson(number);
    json.object_value["message"] = SimpleJson(message);
    send_to_java(json);
    return "";
}

static void jni_send_dtmf(const std::string& digit) {
    SimpleJson json;
    json.type = SimpleJson::OBJECT;
    json.object_value["command"] = SimpleJson("dtmf");
    json.object_value["digit"] = SimpleJson(digit);
    send_to_java(json);
}

static void jni_set_audio_route(const std::string& route) {
    SimpleJson json;
    json.type = SimpleJson::OBJECT;
    json.object_value["command"] = SimpleJson("audio_route");
    json.object_value["route"] = SimpleJson(route);
    send_to_java(json);
}

static void jni_set_volume(int level) {
    SimpleJson json;
    json.type = SimpleJson::OBJECT;
    json.object_value["command"] = SimpleJson("volume");
    json.object_value["level"] = SimpleJson((double)level);
    send_to_java(json);
}

static void remove_pid_file() {
    unlink(g_pid_file);
}

// ──────────────────────────────────────────────────────────────────────────
// Network Utilities (TCP via mbedtls_net)
// ──────────────────────────────────────────────────────────────────────────

static bool send_all(mbedtls_net_context* net, const void* data, size_t len) {
    std::lock_guard<std::mutex> lk(g_tls_write_mutex);
    const auto* p = (const uint8_t*)data;
    while(len > 0) {
        int n = mbedtls_net_send(net, p, len);
        if(n <= 0) {
            if(n == MBEDTLS_ERR_SSL_WANT_READ || n == MBEDTLS_ERR_SSL_WANT_WRITE) continue;
            g_connected = false; // Mark connection as broken
            g_status_cv.notify_all(); // Wake up any sleeping threads
            return false;
        }
        p += n;
        len -= n;
    }
    return true;
}

static bool recv_all(mbedtls_net_context* net, void* data, size_t len) {
    auto* p = (uint8_t*)data;
    while(len > 0) {
        int n = mbedtls_net_recv(net, p, len);
        if(n <= 0) {
            if(n == MBEDTLS_ERR_SSL_WANT_READ || n == MBEDTLS_ERR_SSL_WANT_WRITE) continue;
            g_connected = false; // Mark connection as broken
            g_status_cv.notify_all(); // Wake up any sleeping threads
            return false;
        }
        p += n;
        len -= n;
    }
    return true;
}

static bool send_frame(mbedtls_net_context* net, uint8_t type, const void* data, uint32_t len) {
    uint8_t hdr[5];
    hdr[0] = type;
    hdr[1] = (len >> 24) & 0xFF;
    hdr[2] = (len >> 16) & 0xFF;
    hdr[3] = (len >>  8) & 0xFF;
    hdr[4] = (len >>  0) & 0xFF;
    return send_all(net, hdr, 5) && send_all(net, data, len);
}

static bool send_json(mbedtls_net_context* net, uint8_t type, const SimpleJson& json) {
    std::string str = json.toString();
    return send_frame(net, type, str.c_str(), str.length());
}

static void tcp_cleanup() {
    mbedtls_net_free(&g_net);
}

static bool tcp_connect(const char* host, int port) {
    tcp_cleanup();
    mbedtls_net_init(&g_net);
    
    char port_str[10];
    snprintf(port_str, sizeof(port_str), "%d", port);
    
    LOGI("Connecting to %s:%s (TCP)...", host, port_str);
    if(mbedtls_net_connect(&g_net, host, port_str, MBEDTLS_NET_PROTO_TCP) != 0) {
        LOGE("TCP connection failed");
        return false;
    }
    
    // Enable TCP Keepalive so we detect dropped connections
    int keepalive = 1;
    int keepcnt = 3;
    int keepidle = 5;
    int keepintvl = 2;
    setsockopt(g_net.fd, SOL_SOCKET, SO_KEEPALIVE, &keepalive, sizeof(keepalive));
    setsockopt(g_net.fd, IPPROTO_TCP, TCP_KEEPCNT, &keepcnt, sizeof(keepcnt));
    setsockopt(g_net.fd, IPPROTO_TCP, TCP_KEEPIDLE, &keepidle, sizeof(keepidle));
    setsockopt(g_net.fd, IPPROTO_TCP, TCP_KEEPINTVL, &keepintvl, sizeof(keepintvl));
    
    LOGI("TCP connection established");
    return true;
}

#include <ctime>
#include "mbedtls/md.h"

static bool handshake(mbedtls_net_context* net) {
    SimpleJson reg;
    reg.type = SimpleJson::OBJECT;
    reg.object_value["type"] = SimpleJson("register");
    reg.object_value["name"] = SimpleJson(get_prop("ro.product.model", "Android"));
    reg.object_value["brand"] = SimpleJson(get_prop("ro.product.brand", ""));
    reg.object_value["android"] = SimpleJson(get_prop("ro.build.version.release", ""));
    
    std::string dev_id = get_device_id();
    reg.object_value["id"] = SimpleJson(dev_id);
    reg.object_value["mode"] = SimpleJson("full_control");
    reg.object_value["version"] = SimpleJson(std::to_string(VERSION_MAJOR) + "." + 
                                            std::to_string(VERSION_MINOR) + "." + 
                                            std::to_string(VERSION_PATCH));
    reg.object_value["features"] = SimpleJson::ARRAY;
    reg.object_value["features"].array_value.push_back(SimpleJson("audio"));
    reg.object_value["features"].array_value.push_back(SimpleJson("call_control"));
    reg.object_value["features"].array_value.push_back(SimpleJson("sms"));
    
    // Generate HMAC
    time_t t = time(nullptr);
    struct tm* gm = gmtime(&t);
    char date_str[16];
    strftime(date_str, sizeof(date_str), "%d-%m-%y", gm); // Current dd-mm-yy UTC
    reg.object_value["date"] = SimpleJson(date_str); // Send date so server uses exact matching string
    
    // Generate a random nonce (16 bytes → 32 hex chars)
    char nonce_hex[33] = {};
    for (int i = 0; i < 16; i++) {
        snprintf(nonce_hex + i*2, 3, "%02x", (unsigned)(rand() & 0xFF));
    }
    reg.object_value["nonce"] = SimpleJson(nonce_hex);

    std::string msg = dev_id + "-" + date_str + "-" + nonce_hex;
    unsigned char hmac[32];
    const mbedtls_md_info_t* md_info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    mbedtls_md_hmac(md_info, (const unsigned char*)g_token, g_token ? strlen(g_token) : 0, 
                    (const unsigned char*)msg.c_str(), msg.length(), hmac);
                    
    char hex[65];
    for(int i = 0; i < 32; i++) sprintf(hex + i*2, "%02x", hmac[i]);
    reg.object_value["hmac"] = SimpleJson(hex);
    
    std::string str = reg.toString() + "\n";
    
    if(!send_all(net, str.c_str(), str.size())) return false;
    
    std::string line;
    char c;
    while(true) {
        if(!recv_all(net, &c, 1)) return false;
        if(c == '\n') break;
        line += c;
        if(line.size() > 512) return false;
    }
    
    LOGI("Handshake response: %s", line.c_str());
    return line.find("\"ok\"") != std::string::npos;
}

// ──────────────────────────────────────────────────────────────────────────
// Thread Functions
// ──────────────────────────────────────────────────────────────────────────

static void status_sender_thread(mbedtls_net_context* net) {
    LOGI("Status sender started");
    
    while(g_running && g_connected) {
        std::string json_str;
        bool has_status = false;
        
        {
            std::unique_lock<std::mutex> lk(g_status_mutex);
            
            if(!g_status_pending) {
                g_status_cv.wait_for(lk, std::chrono::milliseconds(100));
            }
            
            if(!g_status_queue.empty()) {
                json_str = g_status_queue.front();
                g_status_queue.pop();
                has_status = true;
                g_status_pending = !g_status_queue.empty();
            }
        }
        
        if(has_status && g_connected) {
            // Route SMS events to T_SMS; everything else (call state, errors) to T_CALL_STATUS.
            // JNI callbacks produce "type":"sms_received" / "type":"sms_status" — check "type",
            // not "event" (which never appears in any callback output).
            uint8_t frame_type = T_CALL_STATUS;
            if (json_str.find("\"type\":\"sms") != std::string::npos) {
                frame_type = T_SMS;
            } else if (json_str.find("\"type\":\"device_info\"") != std::string::npos) {
                frame_type = T_DEVICE_INFO;
            } else if (json_str.find("\"type\":\"device_status\"") != std::string::npos) {
                frame_type = T_DEVICE_STATUS;
            }
            if(send_frame(net, frame_type, json_str.c_str(), json_str.length())) {
                LOGD("Status sent (type=0x%02x): %s", frame_type, json_str.substr(0, 100).c_str());
            } else {
                LOGE("Failed to send status, re-queueing");
                std::lock_guard<std::mutex> lk(g_status_mutex);
                g_status_queue.push(json_str);
                g_status_pending = true;
            }
        }
    }
    
    LOGI("Status sender exited");
}

static void receive_virtual_mic_thread(mbedtls_net_context* net) {
    struct sched_param sp{};
    sp.sched_priority = 2;
    if (pthread_setschedparam(pthread_self(), SCHED_RR, &sp) != 0) {
        setpriority(PRIO_PROCESS, 0, -10);
    }

    std::vector<uint8_t> pkt(MAX_PKT);
    uint8_t hdr[5];
    uint64_t frames_received = 0;

    while(g_running && g_connected) {
        if(!recv_all(net, hdr, 5)) break;

        uint8_t type = hdr[0];
        uint32_t len = ((uint32_t)hdr[1] << 24) | ((uint32_t)hdr[2] << 16) |
                       ((uint32_t)hdr[3] <<  8) | ((uint32_t)hdr[4]);

        if(len >= MAX_PKT) break;
        if(len > 0 && !recv_all(net, pkt.data(), len)) break;

        if(type == T_PONG) {
            g_last_pong.store(time(nullptr));
            continue;
        }

        if(type == T_CONTROL) {
            pkt.data()[len] = '\0';
            std::string json_str((char*)pkt.data(), len);

            SimpleJson root = SimpleJson::parse(json_str);
            std::string cmd = root.getString("command");

            LOGI("Control command: %s", cmd.c_str());

            if(cmd == "dial") {
                std::string number = root.getString("number");
                if(!number.empty()) {
                    send_to_java_raw(json_str.c_str());
                }
            } else if(cmd == "hangup" || cmd == "end_call") {
                send_to_java_raw("{\"command\":\"hangup\"}");
            } else if(cmd == "answer") {
                send_to_java_raw("{\"command\":\"answer\"}");
            } else if(cmd == "mute") {
                send_to_java_raw(json_str.c_str());
            } else if(cmd == "send_sms") {
                std::string number = root.getString("number");
                std::string message = root.getString("message");
                if(!number.empty() && !message.empty()) {
                    send_to_java_raw(json_str.c_str());
                    LOGI("SMS queued to APK");
                }
            } else if(cmd == "dtmf") {
                std::string digit = root.getString("digit");
                if(!digit.empty()) {
                    send_to_java_raw(json_str.c_str());
                    LOGI("DTMF: %s", digit.c_str());
                }
            } else if(cmd == "audio_route") {
                std::string route = root.getString("route", "earpiece");
                send_to_java_raw(json_str.c_str());
                LOGI("Audio route: %s", route.c_str());
            } else if(cmd == "volume") {
                int level = (int)root.getNumber("level", 7.0);
                send_to_java_raw(json_str.c_str());
                LOGI("Volume: %d", level);
            } else if(cmd == "set_sim_filter") {
                send_to_java_raw(json_str.c_str());
                LOGI("Forwarded set_sim_filter to APK");
            } else if(cmd == "get_device_info") {
                send_to_java_raw("{\"command\":\"get_device_info\"}");
            } else if(cmd == "ping") {
                SimpleJson pong;
                pong.type = SimpleJson::OBJECT;
                pong.object_value["type"] = SimpleJson("pong");
                pong.object_value["timestamp"] = SimpleJson((double)time(nullptr));
                send_json(net, T_PONG, pong);
            }

            continue;
        }

        if(type == T_VIRTUAL_MIC) {
            if (len > 0 && g_voice.active.load()) {
                enqueue_tx_opus_frame(pkt.data(), (int)len);
            }
            frames_received++;
            continue;
        }
    }

    LOGI("Virtual mic receiver exited (frames: %llu)", (unsigned long long)frames_received);
}

static void read_java_client(int fd) {
    // Log the peer's SELinux context — useful for crafting sepolicy rules.
    char peercon[256] = "unknown";
    socklen_t peer_len = sizeof(peercon);
    struct ucred cred{};
    socklen_t cred_len = sizeof(cred);
    getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &cred_len);
    // Read /proc/<pid>/attr/current for the peer's label.
    char path[64];
    snprintf(path, sizeof(path), "/proc/%d/attr/current", cred.pid);
    if (FILE* f = fopen(path, "r")) {
        size_t n = fread(peercon, 1, sizeof(peercon) - 1, f);
        fclose(f);
        if (n > 0) {
            peercon[n] = '\0';
            while (n > 0 && (peercon[n-1] == '\n' || peercon[n-1] == '\0')) peercon[--n] = '\0';
        }
    }
    LOGI("Java IPC Client connected (fd=%d pid=%d uid=%d peercon=%s)",
         fd, cred.pid, cred.uid, peercon);
    g_java_fd.store(fd);
    
    FILE* f = fdopen(fd, "r");
    if (!f) {
        close(fd);
        return;
    }

    char line[4096];
    while(g_running && fgets(line, sizeof(line), f)) {
        // Strip trailing CR/LF.
        size_t len = strlen(line);
        while (len > 0 && (line[len-1] == '\n' || line[len-1] == '\r')) line[--len] = '\0';
        if (len == 0) continue;

        handle_java_ipc_message(line, len);
    }
    
    LOGI("Java IPC Client disconnected");
    if (g_java_fd.load() == fd) {
        g_java_fd.store(-1);
    }
    fclose(f);
}

static void unix_socket_server_thread() {
    unlink(g_socket_path);
    
    int server_fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if(server_fd < 0) {
        LOGE("Unix socket creation failed: %s", strerror(errno));
        return;
    }
    
    struct sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    addr.sun_path[0] = '\0';
    strcpy(addr.sun_path + 1, "audio_bridge");
    size_t addr_len = offsetof(struct sockaddr_un, sun_path) + 1 + strlen("audio_bridge");
    
    if(bind(server_fd, (struct sockaddr*)&addr, addr_len) < 0) {
        LOGE("Unix socket bind failed: %s", strerror(errno));
        close(server_fd);
        return;
    }
    
    if(listen(server_fd, 5) < 0) {
        LOGE("Unix socket listen failed: %s", strerror(errno));
        close(server_fd);
        return;
    }
    
    LOGI("Unix socket listening on %s", g_socket_path);

    while(g_running) {
        fd_set fds;
        FD_ZERO(&fds);
        FD_SET(server_fd, &fds);
        
        struct timeval tv{1, 0};
        int ret = select(server_fd + 1, &fds, nullptr, nullptr, &tv);
        if(ret < 0) break;
        if(ret == 0) continue;
        
        int client_fd = accept(server_fd, nullptr, nullptr);
        if(client_fd < 0) continue;
        
        char cmd[256];
        ssize_t n = recv(client_fd, cmd, sizeof(cmd) - 1, 0);
        if(n > 0) {
            cmd[n] = '\0';
            
            if(strcmp(cmd, "PING") == 0) {
                send(client_fd, "PONG", 4, 0);
                close(client_fd);
            } else if(strncmp(cmd, "HELO_JAVA", 9) == 0) {
                std::thread java_client_thread(read_java_client, client_fd);
                java_client_thread.detach();
                // Do NOT close client_fd here
            } else {
                close(client_fd);
            }
        } else {
            close(client_fd);
        }
    }
    
    close(server_fd);
    unlink(g_socket_path);
    LOGI("Unix socket server exited");
}

// ──────────────────────────────────────────────────────────────────────────
// Signal Handlers
// ──────────────────────────────────────────────────────────────────────────

static void signal_handler(int sig) {
    LOGI("Received signal %d, shutting down...", sig);
    g_running = false;
    g_connected = false;
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────

int main(int argc, char** argv) {
    bool check_server = false;
    
    // Parse arguments
    for(int i = 1; i < argc; i++) {
        if(!strcmp(argv[i], "--host") && i+1 < argc) g_host = argv[++i];
        else if(!strcmp(argv[i], "--port") && i+1 < argc) g_port = atoi(argv[++i]);
        else if(!strcmp(argv[i], "--socket") && i+1 < argc) g_socket_path = argv[++i];
        else if(!strcmp(argv[i], "--token") && i+1 < argc) g_token = argv[++i];
        else if(!strcmp(argv[i], "--check-server")) check_server = true;
        else if(!strcmp(argv[i], "--daemon")) {
            // Daemonize
            if(fork() > 0) exit(0);
            setsid();
            // Redirect stdin/stdout/stderr to /dev/null.
            // stderr must be closed too: service.sh runs us with ">> log 2>&1",
            // so inherited fd2 points at the log file, causing every log_write()
            // call (which writes to both stderr AND g_log_file) to be duplicated.
            int devnull = open("/dev/null", O_RDWR);
            if(devnull >= 0) {
                dup2(devnull, STDIN_FILENO);
                dup2(devnull, STDOUT_FILENO);
                dup2(devnull, STDERR_FILENO);
                close(devnull);
            }
            // Write PID file immediately so service.sh can detect us
            write_pid_file();
        }
    }
    
    // Load config from config.json
    static char config_path[512] = "/data/adb/modules/audio_bridge/files/config.json";
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--config") && i + 1 < argc) {
            strncpy(config_path, argv[++i], sizeof(config_path) - 1);
        }
    }
    load_config_json(config_path);
    if (g_cfg.host[0]) g_host = g_cfg.host;
    if (g_cfg.port)    g_port = g_cfg.port;
    if (g_cfg.token[0]) g_token = g_cfg.token;
    
    if(check_server) {
        if(!g_host) {
            LOGE("--check-server requires --host");
            return 1;
        }
        LOGI("Checking TCP connection to %s:%d...", g_host, g_port);
        if(!tcp_connect(g_host, g_port)) {
            LOGE("TCP Connection failed");
            return 1;
        }
        if(!handshake(&g_net)) {
            LOGE("Handshake/Auth failed");
            tcp_cleanup();
            return 1;
        }
        LOGI("Connection and auth successful!");
        tcp_cleanup();
        return 0; // Success
    }
    
    // Setup signal handlers
    signal(SIGPIPE, SIG_IGN);   // prevent silent kill when server closes TCP connection mid-write
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    signal(SIGHUP, signal_handler);

    // Seed random number generator for nonce entropy
    srand((unsigned)time(nullptr) ^ (unsigned)getpid());

    // Initialize
    log_init();
    write_pid_file();
    
    LOGI("╔══════════════════════════════════════════════════════════════╗");
    LOGI("║     Audio Bridge v%d.%d.%d - Full Telephony & SMS Control    ║",
         VERSION_MAJOR, VERSION_MINOR, VERSION_PATCH);
    LOGI("╚══════════════════════════════════════════════════════════════╝");
    LOGI("SELinux context: %s (daemon domain — add sepolicy rules against this)",
         read_self_context().c_str());
    if(g_host) {
        LOGI("Target: %s:%d", g_host, g_port);
    } else {
        LOGI("No server configured yet. Waiting for config via WebUI...");
    }
    LOGI("Device ID: %s", get_device_id().c_str());
    
    // Start Unix socket server
    std::thread unix_thread(unix_socket_server_thread);
    
    // Main connection loop - wait for config if no host set
    while(g_running) {
        if(!g_host || !g_host[0]) {
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
        
        g_connected = false;

        if(!tcp_connect(g_host, g_port)) {
            // tcp_connect already logged the attempt and its failure
            LOGW("Retrying in 15s");
            sleep(15);
            continue;
        }
        
        if(!handshake(&g_net)) {
            LOGW("Handshake/Auth failed, retrying in 15s");
            tcp_cleanup();
            sleep(15);
            continue;
        }
        
        g_connected = true;
        LOGI("Connected to server!");

        // Initialize pong tracker at connect time
        g_last_pong.store(time(nullptr));

        // Start worker threads
        std::thread status_thread(status_sender_thread, &g_net);
        std::thread mic_thread(receive_virtual_mic_thread, &g_net);
        
        // Connection watchdog: 15s ping, 90s pong timeout
        while(g_running && g_connected) {
            sleep(15);
            if(!g_connected) break;

            time_t now = time(nullptr);
            if (now - g_last_pong.load() > 90) {
                LOGW("Heartbeat timeout (90s without pong), disconnecting");
                g_connected = false;
                g_status_cv.notify_all();
                break;
            }

            if(!send_frame(&g_net, T_PING, nullptr, 0)) {
                LOGW("Ping send failed, disconnecting");
                g_connected = false;
                g_status_cv.notify_all();
                break;
            }
            send_to_java_raw("{\"command\":\"get_device_status\"}");
        }

        voice_call_stop();
        status_thread.join();
        mic_thread.join();
        
        tcp_cleanup();
        g_connected = false;
        LOGI("Disconnected, reconnecting in 5s");
        sleep(5);
    }
    
    unix_thread.join();
    
    // Cleanup
    if(g_log_file) fclose(g_log_file);
    
    remove_pid_file();
    LOGI("Audio Bridge terminated");
    
    return 0;
}