package com.audiobridge;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.content.pm.ServiceInfo;

import java.io.FileWriter;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * AudioBridgeService - Foreground service for persistent operation
 */
public class AudioBridgeService extends Service {
    private static final String TAG = "AudioBridge-Service";
    private static final String CHANNEL_ID = "audio_bridge_channel";
    private static final int NOTIFICATION_ID = 1001;
    private static final String DIAG = "/data/local/tmp/audio_bridge_java.log";
    private static final SimpleDateFormat TS =
        new SimpleDateFormat("HH:mm:ss", Locale.US);

    private static void diag(String msg) {
        android.util.Log.i(TAG, msg);
        try (FileWriter w = new FileWriter(DIAG, true)) {
            w.write(TS.format(new Date()) + " [service] " + msg + "\n");
        } catch (IOException ignored) {}
    }

    @Override
    public void onCreate() {
        super.onCreate();
        diag("onCreate entered (sdk=" + Build.VERSION.SDK_INT + ")");
        createNotificationChannel();
        // API 34+ requires startForeground() to receive the type declared in the
        // manifest. mediaPlayback has no daily time limit (dataSync is capped at
        // 6 h/day on API 35+). On API 34+ the untyped overload throws
        // MissingForegroundServiceTypeException so we NEVER fall back to it.
        boolean fg = false;
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIFICATION_ID, buildNotification(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
                fg = true;
                diag("startForeground(mediaPlayback) ok");
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                try {
                    startForeground(NOTIFICATION_ID, buildNotification(),
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
                    fg = true;
                    diag("startForeground(mediaPlayback,api29) ok");
                } catch (Throwable e2) {
                    startForeground(NOTIFICATION_ID, buildNotification());
                    fg = true;
                    diag("startForeground(untyped,api29 fallback) ok");
                }
            } else {
                startForeground(NOTIFICATION_ID, buildNotification());
                fg = true;
                diag("startForeground(untyped,pre-Q) ok");
            }
        } catch (Throwable e) {
            diag("startForeground FAILED: " + e.getClass().getSimpleName()
                 + ": " + e.getMessage());
        }
        if (!fg) {
            diag("FGS start failed — service will be killed within 5s");
        }
        try {
            TelephonyHelper.getInstance(this);
        } catch (Exception e) {
            diag("TelephonyHelper init failed: " + e.getClass().getSimpleName() + ": " + e.getMessage());
        }
        try {
            // Register the connected listener before init() starts the connection thread.
            IPCClient.getInstance().setOnConnectedListener(() -> {
                TelephonyHelper th = TelephonyHelper.getInstance();
                if (th != null) {
                    try {
                        IPCClient.getInstance().sendEvent(th.buildDeviceInfo());
                    } catch (Exception e) {
                        diag("sendDeviceInfo on connect: " + e.getClass().getSimpleName() + ": " + e.getMessage());
                    }
                }
            });
            IPCClient.init(this);
        } catch (Exception e) {
            diag("IPCClient init failed: " + e.getClass().getSimpleName() + ": " + e.getMessage());
        }
        diag("onCreate finished (fg=" + fg + ")");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        android.util.Log.i(TAG, "AudioBridgeService destroyed");
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Audio Bridge",
                NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("Audio Bridge status");
            channel.setShowBadge(true);
            channel.setSound(null, null);     // visible but silent
            channel.enableVibration(false);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private Notification buildNotification() {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        return builder
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(getString(R.string.notification_text))
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .build();
    }

    /** Called from IPCClient when the daemon connection state changes. */
    public static void updateStatus(android.content.Context ctx, String stateLine) {
        if (ctx == null) return;
        try {
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm == null) return;
            Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(ctx, CHANNEL_ID)
                : new Notification.Builder(ctx);
            nm.notify(NOTIFICATION_ID, b
                .setContentTitle("Audio Bridge")
                .setContentText(stateLine)
                .setSmallIcon(android.R.drawable.ic_menu_call)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build());
        } catch (Exception ignored) {}
    }
}
