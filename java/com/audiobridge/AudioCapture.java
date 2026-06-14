package com.audiobridge;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.util.Log;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Captures cellular call audio (both uplink + downlink) via AudioSource.VOICE_CALL
 * and streams raw PCM to the daemon over a dedicated binary audio socket connection.
 *
 * Requires android.permission.CAPTURE_AUDIO_OUTPUT (granted via privapp-permissions XML).
 * Falls back to VOICE_COMMUNICATION if VOICE_CALL is denied (works for VoIP calls).
 */
public class AudioCapture {
    private static final String TAG = "AudioBridge-Audio";
    static final int SAMPLE_RATE   = 8000;
    static final int FRAME_SAMPLES = 160;   // 20 ms at 8 kHz
    static final int FRAME_BYTES   = FRAME_SAMPLES * 2;  // 16-bit PCM

    private static AudioCapture sInstance;

    private AudioRecord mRecord;
    private Thread      mThread;
    private final AtomicBoolean mRunning = new AtomicBoolean(false);

    public static synchronized AudioCapture getInstance() {
        if (sInstance == null) sInstance = new AudioCapture();
        return sInstance;
    }

    private AudioCapture() {}

    public void start() {
        if (mRunning.getAndSet(true)) return;

        int minBuf  = AudioRecord.getMinBufferSize(SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        int bufSize = Math.max(minBuf, FRAME_BYTES * 8);

        AudioRecord rec = tryCreate(MediaRecorder.AudioSource.VOICE_CALL, bufSize);
        if (rec == null) {
            Log.w(TAG, "VOICE_CALL unavailable — falling back to VOICE_COMMUNICATION");
            rec = tryCreate(MediaRecorder.AudioSource.VOICE_COMMUNICATION, bufSize);
        }
        if (rec == null || rec.getState() != AudioRecord.STATE_INITIALIZED) {
            Log.e(TAG, "AudioRecord init failed — call audio capture disabled");
            if (rec != null) rec.release();
            mRunning.set(false);
            return;
        }

        mRecord = rec;
        mRecord.startRecording();
        Log.i(TAG, "AudioRecord started (source=" + mRecord.getAudioSource()
                + " rate=" + SAMPLE_RATE + ")");

        mThread = new Thread(this::captureLoop, "AudioCapture");
        mThread.setPriority(Thread.MAX_PRIORITY - 1);
        mThread.start();
    }

    public void stop() {
        if (!mRunning.getAndSet(false)) return;
        if (mThread != null) {
            mThread.interrupt();
            mThread = null;
        }
        if (mRecord != null) {
            try { mRecord.stop(); } catch (Exception ignored) {}
            mRecord.release();
            mRecord = null;
        }
        Log.i(TAG, "AudioCapture stopped");
    }

    private void captureLoop() {
        byte[]     buf = new byte[FRAME_BYTES];
        IPCClient  ipc = IPCClient.getInstance();

        while (mRunning.get()) {
            int n = mRecord.read(buf, 0, FRAME_BYTES);
            if (n <= 0) {
                if (!mRunning.get()) break;
                try { Thread.sleep(5); } catch (InterruptedException e) { break; }
                continue;
            }
            ipc.sendAudio(buf, 0, n);
        }
    }

    private static AudioRecord tryCreate(int source, int bufSize) {
        try {
            return new AudioRecord(source, SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufSize);
        } catch (Exception e) {
            Log.w(TAG, "AudioRecord(" + source + ") failed: " + e.getMessage());
            return null;
        }
    }
}
