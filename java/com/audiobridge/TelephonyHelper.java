package com.audiobridge;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.app.PendingIntent;
import android.provider.Telephony;
import android.telecom.TelecomManager;
import android.telephony.CellSignalStrength;
import android.telephony.PhoneStateListener;
import android.telephony.SignalStrength;
import android.telephony.SmsManager;
import android.telephony.SmsMessage;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyCallback;
import android.telephony.TelephonyManager;
import android.Manifest;
import android.os.Bundle;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * TelephonyHelper - Provides call control and SMS functionality
 * Used by Audio Bridge native code via JNI
 */
public class TelephonyHelper {
    private static final String TAG = "AudioBridge-Telephony";
    private static TelephonyHelper sInstance;

    private Context mContext;
    private TelephonyManager mTelephonyManager;
    private TelecomManager mTelecomManager;
    private AudioManager mAudioManager;
    private SmsManager mSmsManager;
    private Handler mMainHandler;

    private final Map<String, SMSInfo> mPendingSMS = new ConcurrentHashMap<>();
    private final Map<String, CallInfo> mActiveCalls = new ConcurrentHashMap<>();
    private String mCurrentActiveCall = null;

    // ── SIM filter ─────────────────────────────────────────────────────────
    private final Set<Integer> mSimFilter = new HashSet<>(Arrays.asList(0, 1));
    private int mLastCallSimSlot = 0;

    // ── Call state machine ─────────────────────────────────────────────────
    // Android's CALL_STATE_* doesn't distinguish incoming vs outgoing. We
    // maintain the direction ourselves based on who initiated the state
    // transition (placeCall from dashboard → outgoing; RINGING without a
    // prior placeCall → incoming).
    private enum Dir { UNKNOWN, INCOMING, OUTGOING }
    private Dir    mDir          = Dir.UNKNOWN;
    private String mActiveNumber = "";
    private long   mStartedAt    = 0;      // ms since epoch
    private boolean mMuted       = false;
    @SuppressWarnings("deprecation")
    private android.telephony.PhoneStateListener mPhoneStateListener;

    // Native methods removed in favor of IPCClient

    // Singleton
    public static synchronized TelephonyHelper getInstance(Context context) {
        if (sInstance == null) {
            sInstance = new TelephonyHelper(context.getApplicationContext());
        }
        return sInstance;
    }

    public static TelephonyHelper getInstance() {
        return sInstance;
    }

    private TelephonyHelper(Context context) {
        mContext = context;
        mMainHandler = new Handler(Looper.getMainLooper());
        mTelephonyManager = (TelephonyManager) context.getSystemService(Context.TELEPHONY_SERVICE);
        mTelecomManager = (TelecomManager) context.getSystemService(Context.TELECOM_SERVICE);
        mAudioManager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        // getSystemService(SmsManager.class) honours the default subscription on API 28+
        // and avoids the deprecated SmsManager.getDefault() path (deprecated API 31).
        mSmsManager = context.getSystemService(SmsManager.class);
        if (mSmsManager == null) mSmsManager = SmsManager.getDefault();

        loadSimFilter();

        try {
            registerCallListener();
        } catch (SecurityException se) {
            android.util.Log.e(TAG, "registerCallListener failed (missing READ_PHONE_STATE or READ_PRECISE_PHONE_STATE): " + se.getMessage());
        } catch (Exception e) {
            android.util.Log.e(TAG, "registerCallListener unexpected error: " + e.getMessage());
        }

        try {
            registerSMSReceiver();
        } catch (Exception e) {
            android.util.Log.e(TAG, "registerSMSReceiver failed: " + e.getMessage());
        }

        // Emit an initial IDLE state so the dashboard doesn't sit on stale data.
        emitCallState("IDLE", "unknown", "");

        android.util.Log.i(TAG, "TelephonyHelper initialized");
    }

    // ── SIM filter methods ─────────────────────────────────────────────────

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
            android.util.Log.e(TAG, "rejectCall: " + e.getMessage());
        }
    }

    // ── Event emitters ─────────────────────────────────────────────────────

    /**
     * Emit the legacy {"type":"call"} event for the server dashboard.
     * Kept for backward compat with server's T_CALL_STATUS handler.
     */
    private void emitCallState(String state, String dir, String number) {
        try {
            JSONObject e = new JSONObject();
            e.put("type", "call");
            e.put("state", state);
            e.put("direction", dir);
            e.put("number", number != null ? number : "");
            e.put("started_at", mStartedAt);
            e.put("duration_ms", mStartedAt > 0 ? (System.currentTimeMillis() - mStartedAt) : 0);
            e.put("muted", mMuted);
            IPCClient.getInstance().sendEvent(e);
        } catch (JSONException je) {
            android.util.Log.w(TAG, "emitCallState: " + je.getMessage());
        }
    }

    /**
     * Emit the new {"type":"call_state"} event for daemon voice PCM control.
     * The daemon uses this to call voice_call_start(N) / voice_call_stop().
     */
    private void emitCallStateDaemon(String state, String number, int simSlot) {
        try {
            JSONObject ev = new JSONObject();
            ev.put("type", "call_state");
            ev.put("state", state);
            ev.put("number", number != null ? number : "");
            ev.put("sim", simSlot);
            ev.put("timestamp", System.currentTimeMillis());
            IPCClient.getInstance().sendEvent(ev);
        } catch (JSONException e) {
            android.util.Log.e(TAG, "emitCallStateDaemon: " + e.getMessage());
        }
    }

    private void emitError(String op, String code, String msg) {
        try {
            JSONObject e = new JSONObject();
            e.put("type", "error");
            e.put("op", op);
            e.put("code", code);
            e.put("message", msg != null ? msg : "");
            IPCClient.getInstance().sendEvent(e);
            android.util.Log.w(TAG, "emitError " + op + " " + code + ": " + msg);
        } catch (JSONException je) {
            android.util.Log.w(TAG, "emitError(json): " + je.getMessage());
        }
    }

    @SuppressWarnings("deprecation")
    private void registerCallListener() {
        if (mTelephonyManager == null) {
            android.util.Log.w(TAG, "TelephonyManager unavailable — call state monitoring disabled");
            return;
        }
        // READ_PHONE_STATE is required for LISTEN_CALL_STATE; on apps targeting
        // API 31+ some Android 16 builds also enforce READ_PRECISE_PHONE_STATE.
        // Check at runtime and log clearly rather than crashing the service.
        if (mContext.checkSelfPermission(Manifest.permission.READ_PHONE_STATE)
                != PackageManager.PERMISSION_GRANTED) {
            android.util.Log.w(TAG, "READ_PHONE_STATE not granted — call state monitoring disabled");
            return;
        }
        // PhoneStateListener is deprecated since API 31 but still functional through
        // Android 16 — it provides the incoming ringing number which TelephonyCallback
        // dropped for privacy. Since we run as a privileged app with READ_PHONE_STATE
        // and READ_PRECISE_PHONE_STATE, LISTEN_CALL_STATE works correctly.
        mPhoneStateListener = new PhoneStateListener() {
            @Override
            public void onCallStateChanged(int state, String incomingNumber) {
                handleCallStateChange(state, incomingNumber != null ? incomingNumber : "");
            }
        };
        mTelephonyManager.listen(mPhoneStateListener, PhoneStateListener.LISTEN_CALL_STATE);
        android.util.Log.i(TAG, "PhoneStateListener registered for CALL_STATE");
    }

    private void handleCallStateChange(int state, String number) {
        mMainHandler.post(() -> {
            updateCallTracking(state, number);

            // Map Android CALL_STATE_* → our richer state + direction.
            String stateName;
            switch (state) {
                case TelephonyManager.CALL_STATE_RINGING:
                    // Detect which SIM this call is on before anything else.
                    int simSlot = getIncomingCallSimSlot();
                    // Save SIM slot for use in OFFHOOK/IDLE states
                    mLastCallSimSlot = simSlot;
                    // Apply SIM filter — reject calls from non-allowed SIM slots.
                    if (!mSimFilter.contains(simSlot)) {
                        android.util.Log.i(TAG, "Rejecting call on SIM " + simSlot + " (not in filter)");
                        rejectCall();
                        emitCallStateDaemon("rejected_filter", number, simSlot);
                        return;
                    }
                    stateName = "RINGING";
                    // Only overwrite direction if we weren't mid-dial.
                    if (mDir != Dir.OUTGOING) mDir = Dir.INCOMING;
                    if (!number.isEmpty()) mActiveNumber = number;
                    if (mStartedAt == 0) mStartedAt = System.currentTimeMillis();
                    String numRinging = mActiveNumber.isEmpty() ? (number != null ? number : "") : mActiveNumber;
                    // Emit legacy event for server dashboard
                    emitCallState(stateName, dirString(mDir), numRinging);
                    // Emit new call_state event for daemon voice PCM control
                    emitCallStateDaemon("ringing", numRinging, simSlot);
                    return;
                case TelephonyManager.CALL_STATE_OFFHOOK:
                    stateName = "ACTIVE";
                    if (mDir == Dir.UNKNOWN) mDir = Dir.OUTGOING;  // edge case
                    if (mStartedAt == 0) mStartedAt = System.currentTimeMillis();
                    break;
                case TelephonyManager.CALL_STATE_IDLE:
                default:
                    stateName = "IDLE";
                    break;
            }

            String num = mActiveNumber.isEmpty() ? (number != null ? number : "") : mActiveNumber;
            // Emit legacy event for server dashboard
            emitCallState(stateName, dirString(mDir), num);
            // Emit new call_state event for daemon voice PCM control
            String daemonState;
            if ("ACTIVE".equals(stateName)) {
                daemonState = "active";
            } else if ("IDLE".equals(stateName)) {
                daemonState = "idle";
            } else {
                daemonState = stateName.toLowerCase();
            }
            // For OFFHOOK/ACTIVE use the sim slot saved from RINGING event
            // (or 0 if no RINGING event was seen, e.g. outgoing calls).
            emitCallStateDaemon(daemonState, num, mLastCallSimSlot);

            if ("IDLE".equals(stateName)) {
                resetCallState();
            }
        });
    }

    private void updateCallTracking(int state, String number) {
        if (state == TelephonyManager.CALL_STATE_IDLE) {
            mActiveCalls.clear();
            mCurrentActiveCall = null;
        } else if (state == TelephonyManager.CALL_STATE_RINGING) {
            String callId = "call_" + System.currentTimeMillis();
            mActiveCalls.put(callId, new CallInfo(number, state, true));
        } else if (state == TelephonyManager.CALL_STATE_OFFHOOK) {
            if (mCurrentActiveCall == null) {
                String callId = "call_" + System.currentTimeMillis();
                mCurrentActiveCall = callId;
                mActiveCalls.put(callId, new CallInfo(number, state, false));
            }
        }
    }

    private void registerSMSReceiver() {
        IntentFilter filter = new IntentFilter();
        filter.addAction(Telephony.Sms.Intents.SMS_RECEIVED_ACTION);
        // API 33+ requires explicit RECEIVER_EXPORTED flag for system-broadcast receivers;
        // omitting it throws IllegalArgumentException on Android 13+.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            mContext.registerReceiver(new SMSBroadcastReceiver(), filter, Context.RECEIVER_EXPORTED);
        } else {
            mContext.registerReceiver(new SMSBroadcastReceiver(), filter);
        }
    }

    // ── Device info / status ───────────────────────────────────────────────

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
            android.util.Log.e(TAG, "buildDeviceInfo: " + e.getMessage());
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
            android.util.Log.e(TAG, "buildDeviceStatus: " + e.getMessage());
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

    // Public API - Call Control

    /** Returns true on dispatch success; emits error event + returns false on failure. */
    public boolean placeCall(String number) {
        if (number == null || number.trim().isEmpty()) {
            emitError("dial", "INVALID_NUMBER", "number is empty");
            return false;
        }
        if (mContext.checkSelfPermission(Manifest.permission.CALL_PHONE)
                != PackageManager.PERMISSION_GRANTED) {
            emitError("dial", "PERMISSION_DENIED", "CALL_PHONE not granted");
            return false;
        }

        String clean = number.replaceAll("[\\s()\\-]", "");
        Uri uri = Uri.fromParts("tel", clean, null);

        // Preemptively mark outgoing so the very next onCallStateChanged
        // (→ OFFHOOK on dispatch) is labelled correctly.
        mDir          = Dir.OUTGOING;
        mActiveNumber = clean;
        mStartedAt    = System.currentTimeMillis();
        emitCallState("DIALING", "outgoing", clean);

        if (mTelecomManager != null) {
            try {
                // EXTRA_CALL_SOURCE is API 34 analytics attribution; not
                // functionally required and not exposed by older AGPs. Omitted.
                mTelecomManager.placeCall(uri, new Bundle());
                android.util.Log.i(TAG, "placeCall(Telecom) → " + clean);
                return true;
            } catch (SecurityException se) {
                emitError("dial", "SECURITY", se.getMessage());
                resetCallState();
                emitCallState("IDLE", "unknown", "");
                return false;
            } catch (Exception e) {
                android.util.Log.w(TAG, "TelecomManager.placeCall failed, trying intent", e);
                // fall through
            }
        }

        Intent intent = new Intent(Intent.ACTION_CALL, uri);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            mContext.startActivity(intent);
            android.util.Log.i(TAG, "placeCall(intent) → " + clean);
            return true;
        } catch (Exception e) {
            emitError("dial", "INTENT_FAILED", e.getMessage());
            resetCallState();
            emitCallState("IDLE", "unknown", "");
            return false;
        }
    }

    public void setMute(boolean on) {
        try {
            if (mAudioManager != null) {
                mAudioManager.setMicrophoneMute(on);
                mMuted = on;
                emitCallState(
                    mActiveNumber.isEmpty() ? "IDLE" : "ACTIVE",
                    dirString(mDir),
                    mActiveNumber);
                android.util.Log.i(TAG, "setMicrophoneMute(" + on + ")");
            } else {
                emitError("mute", "NO_AUDIO_MGR", "AudioManager unavailable");
            }
        } catch (Exception e) {
            emitError("mute", "EXCEPTION", e.getMessage());
        }
    }

    public void sendDtmf(String digit) {
        if (digit == null || digit.isEmpty()) return;
        int tone = charToTone(digit.charAt(0));
        if (tone < 0) return;
        try {
            ToneGenerator tg = new ToneGenerator(AudioManager.STREAM_VOICE_CALL, 80);
            tg.startTone(tone, 160);
            mMainHandler.postDelayed(() -> { tg.stopTone(); tg.release(); }, 220);
        } catch (Exception e) {
            emitError("dtmf", "EXCEPTION", e.getMessage());
        }
    }

    private int charToTone(char c) {
        switch (c) {
            case '0': return ToneGenerator.TONE_DTMF_0;
            case '1': return ToneGenerator.TONE_DTMF_1;
            case '2': return ToneGenerator.TONE_DTMF_2;
            case '3': return ToneGenerator.TONE_DTMF_3;
            case '4': return ToneGenerator.TONE_DTMF_4;
            case '5': return ToneGenerator.TONE_DTMF_5;
            case '6': return ToneGenerator.TONE_DTMF_6;
            case '7': return ToneGenerator.TONE_DTMF_7;
            case '8': return ToneGenerator.TONE_DTMF_8;
            case '9': return ToneGenerator.TONE_DTMF_9;
            case '*': return ToneGenerator.TONE_DTMF_S;
            case '#': return ToneGenerator.TONE_DTMF_P;
            default:  return -1;
        }
    }

    public void setAudioRoute(String route) {
        if (mAudioManager == null) { emitError("audio_route", "NO_AUDIO_MGR", "AudioManager unavailable"); return; }
        try {
            boolean speaker = "speaker".equalsIgnoreCase(route);
            mAudioManager.setMode(AudioManager.MODE_IN_CALL);
            mAudioManager.setSpeakerphoneOn(speaker);
            android.util.Log.i(TAG, "setAudioRoute(" + route + ") → speaker=" + speaker);
        } catch (Exception e) {
            emitError("audio_route", "EXCEPTION", e.getMessage());
        }
    }

    public void setVolume(int level) {
        if (mAudioManager == null) { emitError("volume", "NO_AUDIO_MGR", "AudioManager unavailable"); return; }
        try {
            int max = mAudioManager.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL);
            int vol = Math.max(0, Math.min(max, level));
            mAudioManager.setStreamVolume(AudioManager.STREAM_VOICE_CALL, vol, 0);
            android.util.Log.i(TAG, "setVolume(" + level + ") → clamped=" + vol + "/" + max);
        } catch (Exception e) {
            emitError("volume", "EXCEPTION", e.getMessage());
        }
    }

    private void resetCallState() {
        mDir = Dir.UNKNOWN;
        mActiveNumber = "";
        mStartedAt = 0;
        mMuted = false;
        mLastCallSimSlot = 0;
    }

    private static String dirString(Dir d) {
        switch (d) {
            case INCOMING: return "incoming";
            case OUTGOING: return "outgoing";
            default:       return "unknown";
        }
    }

    public boolean endCall() {
        if (mContext.checkSelfPermission(Manifest.permission.ANSWER_PHONE_CALLS)
                != PackageManager.PERMISSION_GRANTED) {
            emitError("hangup", "PERMISSION_DENIED", "ANSWER_PHONE_CALLS not granted");
            return false;
        }
        if (mTelecomManager == null) {
            emitError("hangup", "NO_TELECOM", "TelecomManager unavailable");
            return false;
        }
        try {
            mTelecomManager.endCall();
            android.util.Log.i(TAG, "endCall()");
            return true;
        } catch (Exception e) {
            emitError("hangup", "EXCEPTION", e.getMessage());
            return false;
        }
    }

    public boolean answerCall() {
        if (mContext.checkSelfPermission(Manifest.permission.ANSWER_PHONE_CALLS)
                != PackageManager.PERMISSION_GRANTED) {
            emitError("answer", "PERMISSION_DENIED", "ANSWER_PHONE_CALLS not granted");
            return false;
        }
        if (mTelecomManager == null) {
            emitError("answer", "NO_TELECOM", "TelecomManager unavailable");
            return false;
        }
        try {
            mTelecomManager.acceptRingingCall();
            android.util.Log.i(TAG, "answerCall()");
            return true;
        } catch (Exception e) {
            emitError("answer", "EXCEPTION", e.getMessage());
            return false;
        }
    }

    // Public API - SMS

    public String sendSMS(String phoneNumber, String message) {
        if (mContext.checkSelfPermission(Manifest.permission.SEND_SMS)
                != PackageManager.PERMISSION_GRANTED) {
            android.util.Log.w(TAG, "SEND_SMS permission not granted");
            return null;
        }

        String messageId = UUID.randomUUID().toString();

        SMSInfo info = new SMSInfo();
        info.id = messageId;
        info.number = phoneNumber;
        info.message = message;
        info.timestamp = System.currentTimeMillis();

        ArrayList<String> parts = mSmsManager.divideMessage(message);
        info.parts = parts;
        info.totalParts = parts.size();

        mPendingSMS.put(messageId, info);

        ArrayList<PendingIntent> sentIntents = new ArrayList<>();
        ArrayList<PendingIntent> deliveryIntents = new ArrayList<>();

        for (int i = 0; i < parts.size(); i++) {
            Intent sentIntent = new Intent("SMS_SENT_" + messageId);
            sentIntent.putExtra("message_id", messageId);
            sentIntent.putExtra("part", i);
            PendingIntent sentPI = PendingIntent.getBroadcast(
                mContext, i, sentIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            sentIntents.add(sentPI);

            Intent deliveryIntent = new Intent("SMS_DELIVERED_" + messageId);
            deliveryIntent.putExtra("message_id", messageId);
            PendingIntent deliveryPI = PendingIntent.getBroadcast(
                mContext, i + 1000, deliveryIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            deliveryIntents.add(deliveryPI);
        }

        try {
            mSmsManager.sendMultipartTextMessage(phoneNumber, null, parts,
                                                  sentIntents, deliveryIntents);
            registerSMSReceivers(messageId);
            android.util.Log.i(TAG, "SMS sent to " + phoneNumber + " (ID: " + messageId + ")");
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to send SMS", e);
            try {
                JSONObject event = new JSONObject();
                event.put("event", "sms_sent");
                event.put("message_id", messageId);
                event.put("result_code", 1);
                IPCClient.getInstance().sendEvent(event);
            } catch (JSONException je) { je.printStackTrace(); }
            mPendingSMS.remove(messageId);
            return null;
        }

        return messageId;
    }

    private void registerSMSReceivers(String messageId) {
        IntentFilter sentFilter = new IntentFilter("SMS_SENT_" + messageId);
        IntentFilter deliveredFilter = new IntentFilter("SMS_DELIVERED_" + messageId);

        BroadcastReceiver sentReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String id = intent.getStringExtra("message_id");
                SMSInfo info = mPendingSMS.get(id);

                if (info != null) {
                    int resultCode = getResultCode();

                    if (resultCode == Activity.RESULT_OK) {
                        info.sentParts++;
                        if (info.sentParts == info.totalParts) {
                            try {
                                JSONObject event = new JSONObject();
                                event.put("event", "sms_sent");
                                event.put("message_id", id);
                                event.put("result_code", -1);
                                IPCClient.getInstance().sendEvent(event);
                            } catch (JSONException je) { je.printStackTrace(); }
                        }
                    } else {
                        try {
                            JSONObject event = new JSONObject();
                            event.put("event", "sms_sent");
                            event.put("message_id", id);
                            event.put("result_code", resultCode);
                            IPCClient.getInstance().sendEvent(event);
                        } catch (JSONException je) { je.printStackTrace(); }
                        mPendingSMS.remove(id);
                    }
                }

                try {
                    mContext.unregisterReceiver(this);
                } catch (IllegalArgumentException e) {}
            }
        };

        BroadcastReceiver deliveredReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String id = intent.getStringExtra("message_id");
                SMSInfo info = mPendingSMS.get(id);

                if (info != null) {
                    if (getResultCode() == Activity.RESULT_OK) {
                        try {
                            JSONObject event = new JSONObject();
                            event.put("event", "sms_delivered");
                            event.put("message_id", id);
                            IPCClient.getInstance().sendEvent(event);
                        } catch (JSONException je) { je.printStackTrace(); }
                        mPendingSMS.remove(id);
                    }
                }

                try {
                    mContext.unregisterReceiver(this);
                } catch (IllegalArgumentException e) {}
            }
        };

        mContext.registerReceiver(sentReceiver, sentFilter,
                                  Context.RECEIVER_EXPORTED);
        mContext.registerReceiver(deliveredReceiver, deliveredFilter,
                                  Context.RECEIVER_EXPORTED);
    }

    // Inner classes

    private static class CallInfo {
        String number;
        int state;
        long startTime;
        boolean isIncoming;

        CallInfo(String num, int st, boolean incoming) {
            number = num;
            state = st;
            startTime = System.currentTimeMillis();
            isIncoming = incoming;
        }
    }

    private static class SMSInfo {
        String id;
        String number;
        String message;
        ArrayList<String> parts;
        int totalParts;
        int sentParts;
        long timestamp;
    }

    private class SMSBroadcastReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())) {
                Bundle bundle = intent.getExtras();
                if (bundle != null) {
                    Object[] pdus = (Object[]) bundle.get("pdus");
                    // "format" distinguishes "3gpp" (GSM) from "3gpp2" (CDMA).
                    // The single-arg createFromPdu() was deprecated in API 23.
                    String format = bundle.getString("format");
                    if (pdus != null) {
                        // Determine SIM slot and carrier from subscription info.
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

                        for (Object pdu : pdus) {
                            SmsMessage sms;
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && format != null) {
                                sms = SmsMessage.createFromPdu((byte[]) pdu, format);
                            } else {
                                //noinspection deprecation
                                sms = SmsMessage.createFromPdu((byte[]) pdu);
                            }
                            if (sms == null) continue;
                            String sender = sms.getDisplayOriginatingAddress();
                            String messageBody = sms.getDisplayMessageBody();

                            try {
                                JSONObject event = new JSONObject();
                                event.put("type", "sms");
                                event.put("ver", 1);
                                event.put("from", sender);
                                event.put("body", messageBody);
                                event.put("sim_slot", simSlot);
                                event.put("sim_carrier", simCarrier);
                                event.put("timestamp", System.currentTimeMillis());
                                IPCClient.getInstance().sendEvent(event);
                            } catch (JSONException je) { je.printStackTrace(); }
                        }
                    }
                }
            }
        }
    }
}
