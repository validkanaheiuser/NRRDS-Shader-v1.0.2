package com.audiobridge;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;

import java.io.FileWriter;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Transparent trampoline activity whose only job is to start AudioBridgeService
 * as a foreground service. Used as a fallback when service.sh's direct
 * am start-foreground-service call doesn't produce a running process.
 *
 * Why not Theme.NoDisplay? On Android 14+ (API 34+), Theme.NoDisplay activities
 * that call finish() in onCreate() without setContentView() may not be registered
 * as "visible" by the ActivityManager, which can cause startForegroundService()
 * to fail with ForegroundServiceStartNotAllowedException. Theme.Translucent creates
 * a real (transparent) window, properly satisfying the "activity in foreground"
 * exemption. The activity is on-screen for < 1 frame so there is no visual artifact.
 */
public class LauncherActivity extends Activity {
    private static final String TAG = "AudioBridge-Launcher";
    private static final String DIAG = "/data/local/tmp/audio_bridge_java.log";
    private static final SimpleDateFormat TS =
        new SimpleDateFormat("HH:mm:ss", Locale.US);

    private static void diag(String msg) {
        android.util.Log.i(TAG, msg);
        try (FileWriter w = new FileWriter(DIAG, true)) {
            w.write(TS.format(new Date()) + " [launcher] " + msg + "\n");
        } catch (IOException ignored) {}
    }

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        overridePendingTransition(0, 0);  // suppress enter animation — transparent window
        diag("onCreate — starting foreground service");
        Intent svc = new Intent(this, AudioBridgeService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(svc);
            } else {
                startService(svc);
            }
            diag("startForegroundService returned normally");
        } catch (Throwable t) {
            diag("startForegroundService FAILED: "
                 + t.getClass().getSimpleName() + ": " + t.getMessage());
        }
        finish();
    }
}
