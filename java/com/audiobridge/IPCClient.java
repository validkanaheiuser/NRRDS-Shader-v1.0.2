package com.audiobridge;

import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class IPCClient {
    private static final String TAG = "AudioBridge-IPC";
    private static final String SOCKET_NAME = "audio_bridge";
    // Diagnostics log: writable by the app, readable by root. Lets you see
    // what the Java side is doing without needing adb logcat.
    private static final String DIAG_LOG = "/data/local/tmp/audio_bridge_java.log";
    private static final SimpleDateFormat TS =
        new SimpleDateFormat("HH:mm:ss", Locale.US);

    private static IPCClient sInstance;

    private LocalSocket mSocket;
    private PrintWriter mOut;
    private BufferedReader mIn;

    // Dedicated binary socket for streaming PCM audio to the daemon.
    // Kept separate from mSocket so audio writes never block the JSON IPC path.
    private LocalSocket     mAudioSocket;
    private OutputStream    mAudioOut;

    private boolean mRunning = false;
    private ExecutorService mExecutor = Executors.newSingleThreadExecutor();
    private Handler mMainHandler = new Handler(Looper.getMainLooper());
    private android.content.Context mContext;

    public static synchronized IPCClient init(android.content.Context ctx) {
        if (sInstance == null) {
            sInstance = new IPCClient();
        }
        sInstance.mContext = ctx.getApplicationContext();
        return sInstance;
    }

    private void setStatus(String line) {
        AudioBridgeService.updateStatus(mContext, line);
    }

    private static void diag(String msg) {
        Log.i(TAG, msg);
        try (FileWriter w = new FileWriter(DIAG_LOG, true)) {
            w.write(TS.format(new Date()) + " " + msg + "\n");
        } catch (IOException ignored) {
            // /data/local/tmp is usually priv_app-writable via shell_data_file
            // grants in our sepolicy.rule; if not, we still have logcat.
        }
    }
    
    public static synchronized IPCClient getInstance() {
        if (sInstance == null) {
            sInstance = new IPCClient();
        }
        return sInstance;
    }

    private IPCClient() {
        startConnectionThread();
    }

    private void startConnectionThread() {
        mRunning = true;
        diag("startConnectionThread() — pid=" + android.os.Process.myPid()
             + " uid=" + android.os.Process.myUid());
        setStatus("Connecting to daemon…");
        mExecutor.execute(() -> {
            int attempt = 0;
            while (mRunning) {
                attempt++;
                try {
                    connectAndListen();
                } catch (Exception e) {
                    diag("connect attempt " + attempt + " failed: "
                         + e.getClass().getSimpleName() + ": " + e.getMessage());
                    setStatus("Daemon unreachable · retry " + attempt);
                    try { Thread.sleep(5000); } catch (InterruptedException ie) {}
                }
            }
        });
    }

    private void connectAndListen() throws IOException, JSONException {
        diag("Connecting to abstract socket @" + SOCKET_NAME);

        LocalSocket sock = new LocalSocket();
        sock.connect(new LocalSocketAddress(SOCKET_NAME, LocalSocketAddress.Namespace.ABSTRACT));

        // Assign mOut/mIn/mSocket under the instance lock so sendEvent()
        // can safely read mOut from any thread without using mExecutor
        // (mExecutor is single-threaded and blocked here in readLine, so
        // any mExecutor.execute() submitted by sendEvent() would queue
        // forever and never run — this was the root cause of call state
        // events never reaching the server).
        synchronized (this) {
            mSocket = sock;
            mOut = new PrintWriter(new OutputStreamWriter(sock.getOutputStream()), true);
            mIn  = new BufferedReader(new InputStreamReader(sock.getInputStream()));
        }

        mOut.println("HELO_JAVA");
        diag("Connected — HELO_JAVA sent");
        setStatus("Daemon connected · telephony ready");
        connectAudioStream();

        String line;
        while (mRunning && (line = mIn.readLine()) != null) {
            if (line.trim().isEmpty()) continue;
            try {
                JSONObject json = new JSONObject(line);
                handleCommand(json);
            } catch (JSONException e) {
                Log.e(TAG, "Invalid JSON from daemon: " + line);
            }
        }

        // Clean up under lock so sendEvent() sees a consistent null state.
        synchronized (this) {
            mOut = null;
            mIn  = null;
            mSocket = null;
            mAudioOut = null;
            if (mAudioSocket != null) {
                try { mAudioSocket.close(); } catch (IOException ignored) {}
                mAudioSocket = null;
            }
        }
        try { sock.close(); } catch (IOException ignored) {}
        throw new IOException("Socket closed by remote");
    }

    private void handleCommand(JSONObject json) {
        mMainHandler.post(() -> {
            try {
                String cmd = json.getString("command");
                TelephonyHelper th = TelephonyHelper.getInstance(null);
                if (th == null) return;
                
                if ("place_call".equals(cmd)) {
                    th.placeCall(json.getString("number"));
                } else if ("end_call".equals(cmd)) {
                    th.endCall();
                } else if ("answer_call".equals(cmd)) {
                    th.answerCall();
                } else if ("mute".equals(cmd)) {
                    th.setMute(json.optBoolean("on", true));
                } else if ("send_sms".equals(cmd)) {
                    th.sendSMS(json.getString("number"), json.getString("message"));
                } else if ("dtmf".equals(cmd)) {
                    th.sendDtmf(json.optString("digit", ""));
                } else if ("audio_route".equals(cmd)) {
                    th.setAudioRoute(json.optString("route", "earpiece"));
                } else if ("volume".equals(cmd)) {
                    th.setVolume(json.optInt("level", 7));
                } else {
                    Log.w(TAG, "Unknown command from daemon: " + cmd);
                }
            } catch (Exception e) {
                Log.e(TAG, "Error handling command", e);
            }
        });
    }

    public void sendEvent(JSONObject json) {
        // Write directly under the instance lock — NOT via mExecutor, which
        // is single-threaded and permanently blocked in connectAndListen()'s
        // readLine loop. Tasks submitted there would queue forever.
        synchronized (this) {
            if (mOut != null) {
                mOut.println(json.toString());
            } else {
                Log.w(TAG, "sendEvent: IPC not connected, dropped: " + json.toString());
            }
        }
    }

    /**
     * Open a second abstract socket connection dedicated to binary PCM streaming.
     * Protocol: [b"HELO_AUDIO\n"] then repeating [4-byte BE length][PCM bytes].
     */
    private void connectAudioStream() {
        new Thread(() -> {
            try {
                LocalSocket s = new LocalSocket();
                s.connect(new LocalSocketAddress(SOCKET_NAME, LocalSocketAddress.Namespace.ABSTRACT));
                OutputStream out = s.getOutputStream();
                out.write("HELO_AUDIO\n".getBytes("UTF-8"));
                out.flush();
                synchronized (IPCClient.this) {
                    mAudioSocket = s;
                    mAudioOut    = out;
                }
                diag("Audio stream connected");
                // Keep thread alive to maintain the connection until the main socket closes.
                InputStream in = s.getInputStream();
                //noinspection ResultOfMethodCallIgnored
                while (mRunning) {
                    int r = in.read(new byte[64]);
                    if (r < 0) break;
                }
            } catch (IOException e) {
                diag("Audio stream connect failed: " + e.getMessage());
            }
            synchronized (IPCClient.this) {
                if (mAudioSocket != null) {
                    try { mAudioSocket.close(); } catch (IOException ignored) {}
                    mAudioSocket = null;
                }
                mAudioOut = null;
            }
        }, "AudioIPC").start();
    }

    /**
     * Send a raw PCM chunk to the daemon over the binary audio socket.
     * Frame format: [4-byte big-endian length][PCM bytes (S16LE, 8 kHz, mono)].
     * Non-blocking: silently drops the frame if the socket is not yet ready.
     */
    public void sendAudio(byte[] buf, int offset, int len) {
        OutputStream out;
        synchronized (this) { out = mAudioOut; }
        if (out == null) return;
        byte[] hdr = {
            (byte)(len >> 24), (byte)(len >> 16), (byte)(len >> 8), (byte)len
        };
        try {
            out.write(hdr);
            out.write(buf, offset, len);
        } catch (IOException e) {
            synchronized (this) {
                mAudioOut = null;
                if (mAudioSocket != null) {
                    try { mAudioSocket.close(); } catch (IOException ignored) {}
                    mAudioSocket = null;
                }
            }
        }
    }

    public void disconnect() {
        mRunning = false;
        try {
            if (mSocket != null) {
                mSocket.close();
                mSocket = null;
            }
        } catch (IOException e) {
            // ignore
        }
    }
}
