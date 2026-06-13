#!/bin/bash
# Audio Bridge Build Script
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           Audio Bridge - Full Build Script v3.0              ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"

# Configuration
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$HOME/Android/Sdk/ndk/25.2.9519653}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$PROJECT_DIR/build"
LIBS_DIR="$PROJECT_DIR/libs"
API_LEVEL=28

# Check NDK
if [ ! -d "$ANDROID_NDK_HOME" ]; then
    echo -e "${RED}Error: Android NDK not found at $ANDROID_NDK_HOME${NC}"
    echo "Set ANDROID_NDK_HOME environment variable or install NDK r25+"
    exit 1
fi

echo -e "${YELLOW}Using NDK: $ANDROID_NDK_HOME${NC}"

# Create directories
mkdir -p "$BUILD_DIR"
mkdir -p "$LIBS_DIR/arm64-v8a"
mkdir -p "$LIBS_DIR/armeabi-v7a"

# Build mbedtls
build_mbedtls() {
    local ARCH=$1
    local ABI=$2
    local TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64"
    
    echo -e "${YELLOW}Building mbedtls for $ARCH...${NC}"
    
    cd "$BUILD_DIR"
    if [ ! -d "mbedtls" ]; then
        git clone --depth 1 -b v3.6.0 https://github.com/Mbed-TLS/mbedtls.git
        cd mbedtls
        git submodule update --init
    else
        cd mbedtls
    fi
    
    export CC="$TOOLCHAIN/bin/${ARCH}-linux-android${API_LEVEL}-clang"
    export AR="$TOOLCHAIN/bin/llvm-ar"
    
    # Simple makefile build for mbedtls
    make clean 2>/dev/null || true
    make lib CC="$CC" AR="$AR" CFLAGS="-O3 -fPIC" -j$(nproc)
    
    mkdir -p "$LIBS_DIR/$ABI/include/mbedtls"
    mkdir -p "$LIBS_DIR/$ABI/include/psa"
    cp library/libmbedcrypto.a library/libmbedtls.a library/libmbedx509.a "$LIBS_DIR/$ABI/"
    cp -r include/mbedtls/* "$LIBS_DIR/$ABI/include/mbedtls/"
    cp -r include/psa/* "$LIBS_DIR/$ABI/include/psa/"
    
    echo -e "${GREEN}mbedtls built for $ARCH${NC}"
}

# Build Opus for arm64
build_opus() {
    local ARCH=$1
    local ABI=$2
    local TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64"
    
    echo -e "${YELLOW}Building Opus for $ARCH...${NC}"
    
    cd "$BUILD_DIR"
    if [ ! -d "opus" ]; then
        git clone --depth 1 https://github.com/xiph/opus.git
    fi
    cd opus
    
    # Clean previous builds
    make clean 2>/dev/null || true
    
    export CC="$TOOLCHAIN/bin/${ARCH}-linux-android${API_LEVEL}-clang"
    export CXX="$TOOLCHAIN/bin/${ARCH}-linux-android${API_LEVEL}-clang++"
    export AR="$TOOLCHAIN/bin/llvm-ar"
    export RANLIB="$TOOLCHAIN/bin/llvm-ranlib"
    
    ./autogen.sh 2>/dev/null || true
    ./configure \
        --host="${ARCH}-linux-android" \
        --prefix="$BUILD_DIR/opus-install-$ABI" \
        --disable-shared \
        --enable-static \
        --disable-doc \
        --disable-extra-programs \
        CFLAGS="-O3 -fPIC"
    
    make -j$(nproc)
    make install
    
    mkdir -p "$LIBS_DIR/$ABI/include"
    cp -r "$BUILD_DIR/opus-install-$ABI/include/opus" "$LIBS_DIR/$ABI/include/"
    cp "$BUILD_DIR/opus-install-$ABI/lib/libopus.a" "$LIBS_DIR/$ABI/"
    echo -e "${GREEN}Opus built for $ARCH${NC}"
}

# Build TinyALSA
build_tinyalsa() {
    local ARCH=$1
    local ABI=$2
    local TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64"
    
    echo -e "${YELLOW}Building TinyALSA for $ARCH...${NC}"
    
    cd "$BUILD_DIR"
    if [ ! -d "tinyalsa" ]; then
        git clone --depth 1 https://github.com/tinyalsa/tinyalsa.git
    fi
    cd tinyalsa
    
    export CC="$TOOLCHAIN/bin/${ARCH}-linux-android${API_LEVEL}-clang"
    export AR="$TOOLCHAIN/bin/llvm-ar"
    
    make clean 2>/dev/null || true
    make -C src libtinyalsa.a \
        CC="$CC" \
        AR="$AR" \
        CFLAGS="-O3 -fPIC -DANDROID"
    
    mkdir -p "$LIBS_DIR/$ABI/include/tinyalsa"
    cp src/libtinyalsa.a "$LIBS_DIR/$ABI/libtinyalsa.a" || cp libtinyalsa.a "$LIBS_DIR/$ABI/libtinyalsa.a"
    cp include/tinyalsa/*.h "$LIBS_DIR/$ABI/include/tinyalsa/"
    
    echo -e "${GREEN}TinyALSA built for $ARCH${NC}"
}

# Build main native binary
build_native() {
    local ARCH=$1
    local ABI=$2
    local TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64"
    
    echo -e "${YELLOW}Building Audio Bridge native for $ARCH...${NC}"
    
    export CC="$TOOLCHAIN/bin/${ARCH}-linux-android${API_LEVEL}-clang"
    export CXX="$TOOLCHAIN/bin/${ARCH}-linux-android${API_LEVEL}-clang++"
    
    cd "$PROJECT_DIR/jni"
    
    $CXX \
        -std=c++17 \
        -O3 \
        -fPIE \
        -DANDROID \
        -I"$LIBS_DIR/$ABI/include" \
        -I"$PROJECT_DIR/jni" \
        audio_bridge.cpp \
        -o "$BUILD_DIR/audio-bridge-$ABI" \
        -L"$LIBS_DIR/$ABI" \
        -lopus \
        -ltinyalsa \
        -lmbedtls -lmbedx509 -lmbedcrypto \
        -static-libstdc++ \
        -pthread \
        -pie \
        -Wl,--gc-sections \
        -Wl,--strip-all \
        -Wl,-z,max-page-size=16384 \
        -llog
    
    echo -e "${GREEN}Native binary built: $BUILD_DIR/audio-bridge-$ABI${NC}"
}


# Build Java helper APK
build_apk() {
    echo -e "${YELLOW}Building TelephonyHelper APK...${NC}"
    
    cd "$PROJECT_DIR"
    
    # Create Android project structure
    mkdir -p app/src/main/java/com/audiobridge
    mkdir -p app/src/main/res/values
    mkdir -p app/libs
    
    # Copy Java source
    cp java/com/audiobridge/TelephonyHelper.java app/src/main/java/com/audiobridge/
    cp java/com/audiobridge/AudioBridgeService.java app/src/main/java/com/audiobridge/
    cp java/com/audiobridge/IPCClient.java app/src/main/java/com/audiobridge/
    cp java/com/audiobridge/BootReceiver.java app/src/main/java/com/audiobridge/
    cp java/com/audiobridge/LauncherActivity.java app/src/main/java/com/audiobridge/
    
    # Create AndroidManifest.xml
    cat > app/src/main/AndroidManifest.xml << 'EOF'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.CALL_PHONE" />
    <uses-permission android:name="android.permission.ANSWER_PHONE_CALLS" />
    <uses-permission android:name="android.permission.READ_PHONE_STATE" />
    <uses-permission android:name="android.permission.READ_PRECISE_PHONE_STATE" />
    <uses-permission android:name="android.permission.SEND_SMS" />
    <uses-permission android:name="android.permission.RECEIVE_SMS" />
    <uses-permission android:name="android.permission.READ_SMS" />
    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />

    <application
        android:label="@string/app_name"
        android:icon="@android:drawable/ic_menu_call"
        android:theme="@android:style/Theme.DeviceDefault.NoActionBar"
        android:allowBackup="false"
        android:supportsRtl="true"
        android:usesCleartextTraffic="true"
        android:networkSecurityConfig="@xml/network_security_config">

        <activity
            android:name=".LauncherActivity"
            android:enabled="true"
            android:exported="true"
            android:excludeFromRecents="true"
            android:noHistory="true"
            android:finishOnTaskLaunch="true"
            android:theme="@android:style/Theme.Translucent.NoTitleBar">
            <intent-filter>
                <action android:name="android.intent.action.MAIN"/>
                <category android:name="android.intent.category.LAUNCHER"/>
            </intent-filter>
        </activity>

        <service
            android:name=".AudioBridgeService"
            android:enabled="true"
            android:exported="true"
            android:foregroundServiceType="mediaPlayback" />

        <receiver
            android:name=".BootReceiver"
            android:enabled="true"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="com.audiobridge.START" />
            </intent-filter>
        </receiver>
    </application>
</manifest>
EOF

    # Create strings.xml. The english default ensures updateLocaleListFromAppContext
    # has something to resolve — Android 14 NPE's in handleBindApplication if
    # resources are under-specified.
    cat > app/src/main/res/values/strings.xml << 'EOF'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">Audio Bridge</string>
    <string name="notification_title">Audio Bridge</string>
    <string name="notification_text">Running in background</string>
</resources>
EOF

    # locale_config referenced by @string lookups during bind-application.
    # Without this, priv-app scanning on API 34 has been observed to init
    # Resources as null and crash with getResources().getConfiguration() NPE.
    mkdir -p app/src/main/res/xml
    cat > app/src/main/res/xml/locales_config.xml << 'EOF'
<?xml version="1.0" encoding="utf-8"?>
<locale-config xmlns:android="http://schemas.android.com/apk/res/android">
    <locale android:name="en"/>
</locale-config>
EOF

    cat > app/src/main/res/xml/network_security_config.xml << 'EOF'
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true"/>
</network-security-config>
EOF

    # Copy native library
    mkdir -p app/src/main/jniLibs/arm64-v8a
    mkdir -p app/src/main/jniLibs/armeabi-v7a
    cp "$BUILD_DIR/libaudiobridge-arm64-v8a.so" app/src/main/jniLibs/arm64-v8a/libaudiobridge.so 2>/dev/null || true
    
    cat > app/settings.gradle << 'EOF'
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
rootProject.name = "AudioBridge"
EOF

    # local.properties: required so gradle can locate the Android SDK
    cat > app/local.properties << EOF
sdk.dir=${ANDROID_HOME}
EOF

    # gradle.properties: defaults for headless builds
    cat > app/gradle.properties << 'EOF'
android.useAndroidX=true
android.nonTransitiveRClass=true
android.suppressUnsupportedCompileSdk=36
org.gradle.jvmargs=-Xmx2048m
EOF

    # ── Gradle wrapper bootstrap ────────────────────────────────────────
    # AGP 8.2.2 needs Gradle ≥ 8.2. CI runners ship Gradle 8.1.1, which
    # refuses to evaluate a build.gradle that references AGP 8.2.2
    # ("Minimum supported Gradle version is 8.2"). We bootstrap by:
    #   1. Writing a MINIMAL build.gradle that the system gradle can load,
    #   2. Running `gradle wrapper --gradle-version 8.5` — which produces
    #      a gradlew that pulls its own Gradle 8.5 dist,
    #   3. Overwriting build.gradle with the real AGP config BEFORE the
    #      wrapper invokes assembleRelease.
    if [ ! -f "$PROJECT_DIR/app/gradlew" ] && command -v gradle >/dev/null 2>&1; then
        echo -e "${YELLOW}Bootstrapping gradle wrapper (stub build.gradle)...${NC}"
        cat > app/build.gradle << 'EOF'
// wrapper bootstrap stub — real build.gradle is written below, after gradlew exists
EOF
        ( cd "$PROJECT_DIR/app" && gradle wrapper --gradle-version 8.5 --quiet ) || \
            echo -e "${RED}gradle wrapper bootstrap failed${NC}"
    fi

    # Generate a release keystore if none exists.
    local KEYSTORE_PATH="${AUDIO_BRIDGE_KEYSTORE:-$PROJECT_DIR/app/audiobridge.keystore}"
    local KEYSTORE_PASS="${AUDIO_BRIDGE_KEYSTORE_PASS:-audiobridge}"
    local KEYSTORE_ALIAS="${AUDIO_BRIDGE_KEYSTORE_ALIAS:-audiobridge}"
    if [ ! -f "$KEYSTORE_PATH" ]; then
        echo -e "${YELLOW}Generating signing keystore: $KEYSTORE_PATH${NC}"
        keytool -genkeypair -noprompt \
            -keystore "$KEYSTORE_PATH" \
            -alias "$KEYSTORE_ALIAS" \
            -storepass "$KEYSTORE_PASS" \
            -keypass "$KEYSTORE_PASS" \
            -keyalg RSA -keysize 2048 -validity 10000 \
            -dname "CN=AudioBridge, O=AudioBridge, C=US" \
        || echo -e "${RED}keytool failed — ensure Java JDK is installed${NC}"
    fi

    cat > app/build.gradle << EOF
buildscript {
    repositories { google(); mavenCentral() }
    // AGP 8.2.2 is the first release with first-class compileSdk=34 support.
    // Older AGPs compile 34 but ship an older android.jar, so API-34-only
    // constants (e.g. TelecomManager.EXTRA_CALL_SOURCE) resolve as missing.
    dependencies { classpath 'com.android.tools.build:gradle:8.2.2' }
}

apply plugin: 'com.android.application'

android {
    namespace 'com.audiobridge'
    compileSdk 36

    defaultConfig {
        applicationId "com.audiobridge"
        minSdk 28
        targetSdk 36
        versionCode 1
        versionName "1.0"
    }

    signingConfigs {
        release {
            storeFile file("${KEYSTORE_PATH}")
            storePassword "${KEYSTORE_PASS}"
            keyAlias "${KEYSTORE_ALIAS}"
            keyPassword "${KEYSTORE_PASS}"
            // Enable both v1 (JAR) and v2+ (APK Signature Scheme) so the APK
            // is accepted on the full min/target SDK range.
            v1SigningEnabled true
            v2SigningEnabled true
        }
    }

    buildTypes {
        release {
            minifyEnabled false
            signingConfig signingConfigs.release
        }
    }

    compileOptions {
        sourceCompatibility JavaVersion.VERSION_1_8
        targetCompatibility JavaVersion.VERSION_1_8
    }
}

repositories { google(); mavenCentral() }
EOF

    echo -e "${GREEN}APK source prepared (signing via $KEYSTORE_PATH)${NC}"
}

# Fetch shadowhook from Maven Central. The AAR bundles prebuilt libshadowhook.so
# for every ABI plus the public header. Drastically simpler than building from
# source, and avoids Dobby's master-branch breakage (OSMemory/RuntimeModule,
# 2026-Q2).
build_shadowhook() {
    local VERSION=1.0.10
    local AAR_URL="https://repo1.maven.org/maven2/com/bytedance/android/shadowhook/${VERSION}/shadowhook-${VERSION}.aar"
    echo -e "${YELLOW}Fetching shadowhook ${VERSION} prebuilt...${NC}"

    cd "$BUILD_DIR"
    if [ ! -f "shadowhook-${VERSION}.aar" ]; then
        curl -sL -o "shadowhook-${VERSION}.aar" "$AAR_URL"
    fi

    rm -rf "$BUILD_DIR/shadowhook-aar"
    mkdir -p "$BUILD_DIR/shadowhook-aar"
    unzip -q -o "shadowhook-${VERSION}.aar" -d "$BUILD_DIR/shadowhook-aar"

    for ABI in arm64-v8a armeabi-v7a; do
        mkdir -p "$LIBS_DIR/$ABI/include/shadowhook"
        cp "$BUILD_DIR/shadowhook-aar/jni/$ABI/libshadowhook.so" "$LIBS_DIR/$ABI/" || \
            echo -e "${RED}shadowhook: missing .so for $ABI${NC}"
        cp "$BUILD_DIR/shadowhook-aar/prefab/modules/shadowhook/include/shadowhook.h" \
            "$LIBS_DIR/$ABI/include/shadowhook/"
    done
    echo -e "${GREEN}shadowhook ${VERSION} ready${NC}"
}

# Build Zygisk module
build_zygisk() {
    echo -e "${YELLOW}Building Zygisk module...${NC}"

    # Ensure shadowhook is available
    if [ ! -f "$LIBS_DIR/arm64-v8a/libshadowhook.so" ]; then
        build_shadowhook
    fi

    cd "$PROJECT_DIR/zygisk"

    local TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64"
    export CC="$TOOLCHAIN/bin/aarch64-linux-android${API_LEVEL}-clang"
    export CXX="$TOOLCHAIN/bin/aarch64-linux-android${API_LEVEL}-clang++"

    # Download Zygisk headers if needed
    if [ ! -f "zygisk.hpp" ]; then
        curl -L -o zygisk.hpp https://raw.githubusercontent.com/topjohnwu/zygisk-module-sample/master/module/jni/zygisk.hpp
    fi

    mkdir -p "$PROJECT_DIR/zygisk/module"
    mkdir -p "$PROJECT_DIR/zygisk/module/zygisk"

    # Compile Zygisk module. We don't link against libshadowhook.so — the
    # module dlopens it at runtime from its own install dir (see src/) so we
    # don't need to arrange for the dynamic linker to find it.
    $CXX \
        -std=c++17 \
        -O3 \
        -fPIC \
        -shared \
        -DANDROID \
        -I"$PROJECT_DIR/zygisk" \
        -I"$LIBS_DIR/arm64-v8a/include" \
        -I"$LIBS_DIR/arm64-v8a/include/shadowhook" \
        src/zygisk_module.cpp \
        -o "$PROJECT_DIR/zygisk/module/zygisk/arm64-v8a.so" \
        -Wl,--gc-sections \
        -Wl,-z,max-page-size=16384 \
        -ldl \
        -llog

    # Ship libshadowhook.so alongside our zygisk module
    cp "$LIBS_DIR/arm64-v8a/libshadowhook.so" "$PROJECT_DIR/zygisk/module/zygisk/"
    
    # Package into Magisk Module
    mkdir -p "$PROJECT_DIR/zygisk/module/system/priv-app/AudioBridge"
    mkdir -p "$PROJECT_DIR/zygisk/module/system/etc/permissions"
    mkdir -p "$PROJECT_DIR/zygisk/module/system/bin"
    
    # Create privapp-permissions.xml
    cat > "$PROJECT_DIR/zygisk/module/system/etc/permissions/privapp-permissions-audiobridge.xml" << 'EOF'
<?xml version="1.0" encoding="utf-8"?>
<permissions>
    <privapp-permissions package="com.audiobridge">
        <permission name="android.permission.CALL_PHONE"/>
        <permission name="android.permission.ANSWER_PHONE_CALLS"/>
        <permission name="android.permission.READ_PHONE_STATE"/>
        <permission name="android.permission.READ_PRECISE_PHONE_STATE"/>
        <permission name="android.permission.SEND_SMS"/>
        <permission name="android.permission.RECEIVE_SMS"/>
        <permission name="android.permission.READ_SMS"/>
        <permission name="android.permission.SYSTEM_ALERT_WINDOW"/>
    </privapp-permissions>
</permissions>
EOF

    # Create module.prop — minKernelSU declares the minimum ksud API that supports
    # this module's service.sh / sepolicy.rule. 11631 = KernelSU 0.9.x (stable).
    cat > "$PROJECT_DIR/zygisk/module/module.prop" << EOF
id=audio_bridge
name=Audio Bridge
version=v3.1
versionCode=310
author=AudioBridge
description=Remote audio streaming, call control and SMS via Zygisk. Android 16 + KernelSU compatible.
minKernelSU=11631
EOF

    # Create customize.sh
    cat > "$PROJECT_DIR/zygisk/module/customize.sh" << 'EOF'
ui_print "- Installing Audio Bridge"
ui_print "- Android 14 Compatible"
EOF

    # Create sepolicy.rule for every (app, daemon) domain pair we might hit.
    # KernelSU's service.sh runs the daemon in `ksu`; Magisk puts it in `magisk`
    # or `su`. The app is `priv_app` (priv-app install) or `system_app`; the
    # Phone process is `radio`. Without this, LocalSocket.connect() gets an
    # EACCES via SELinux and `am broadcast` succeeds but IPC silently fails.
    cat > "$PROJECT_DIR/zygisk/module/sepolicy.rule" << 'EOF'
allow priv_app   ksu     unix_stream_socket { connectto read write getattr }
allow priv_app   magisk  unix_stream_socket { connectto read write getattr }
allow priv_app   su      unix_stream_socket { connectto read write getattr }
allow priv_app   init    unix_stream_socket { connectto read write getattr }
allow system_app ksu     unix_stream_socket { connectto read write getattr }
allow system_app magisk  unix_stream_socket { connectto read write getattr }
allow system_app su      unix_stream_socket { connectto read write getattr }
allow platform_app ksu   unix_stream_socket { connectto read write getattr }
allow platform_app magisk unix_stream_socket { connectto read write getattr }
allow platform_app su    unix_stream_socket { connectto read write getattr }
allow radio      ksu     unix_stream_socket { connectto read write getattr }
allow radio      magisk  unix_stream_socket { connectto read write getattr }
allow radio      su      unix_stream_socket { connectto read write getattr }
# Allow the app (priv_app) to write its Java-side diag log to /data/local/tmp
allow priv_app shell_data_file { read write create open append getattr setattr }
EOF

    # Create service.sh (runs during late_start - safe, non-blocking)
    cat > "$PROJECT_DIR/zygisk/module/service.sh" << 'EOF'
#!/system/bin/sh
MODDIR=${0%/*}
LOG=/data/local/tmp/audio_bridge_service.log

echo "$(date) Audio Bridge service.sh started" >> $LOG

# Auto-grant permissions (suppress errors if app not yet installed)
pm grant com.audiobridge android.permission.CALL_PHONE 2>/dev/null
pm grant com.audiobridge android.permission.ANSWER_PHONE_CALLS 2>/dev/null
pm grant com.audiobridge android.permission.READ_PHONE_STATE 2>/dev/null
pm grant com.audiobridge android.permission.READ_PRECISE_PHONE_STATE 2>/dev/null
pm grant com.audiobridge android.permission.SEND_SMS 2>/dev/null
pm grant com.audiobridge android.permission.RECEIVE_SMS 2>/dev/null
pm grant com.audiobridge android.permission.READ_SMS 2>/dev/null
pm grant com.audiobridge android.permission.POST_NOTIFICATIONS 2>/dev/null
appops set com.audiobridge SYSTEM_ALERT_WINDOW allow 2>/dev/null

# Apply SELinux rules. sepolicy.rule is read by Magisk/KernelSU on boot; this
# is the belt to that file's suspenders. Rules cover every (app, daemon)
# domain pair we might hit.
APP_DOMAINS="priv_app system_app platform_app radio"
DAEMON_DOMAINS="ksu magisk su init"
apply_rule() {
    local RULE="$1"
    if command -v magiskpolicy >/dev/null 2>&1; then
        magiskpolicy --live "$RULE" 2>/dev/null
    elif [ -f /data/adb/ksud ]; then
        /data/adb/ksud apply-sepolicy "$RULE" 2>/dev/null
    elif command -v supolicy >/dev/null 2>&1; then
        supolicy --live "$RULE" 2>/dev/null
    fi
}
if command -v magiskpolicy >/dev/null 2>&1 || [ -f /data/adb/ksud ] || command -v supolicy >/dev/null 2>&1; then
    # Unix socket: allow app domains to connect to daemon domains
    for APP in $APP_DOMAINS; do for D in $DAEMON_DOMAINS; do
        apply_rule "allow $APP $D unix_stream_socket { connectto read write getattr }"
    done; done
    # Allow priv_app to write its Java-side diag log to /data/local/tmp
    apply_rule "allow priv_app shell_data_file { read write create open append getattr setattr }"
    echo "$(date) SELinux rules applied" >> $LOG
else
    echo "$(date) WARNING: no sepolicy tool found" >> $LOG
fi

# Locate daemon binary once — used in every branch below.
# Prefer $MODDIR path: the /system/bin overlay may not be visible yet on
# KernelSU when service.sh runs at boot. $MODDIR is always a real directory.
DAEMON_BIN=""
if [ -f "$MODDIR/system/bin/audio-bridge" ]; then
    chmod 755 "$MODDIR/system/bin/audio-bridge" 2>/dev/null
    DAEMON_BIN="$MODDIR/system/bin/audio-bridge"
elif [ -f /system/bin/audio-bridge ]; then
    DAEMON_BIN="/system/bin/audio-bridge"
fi

start_daemon() {
    echo "$(date) Launching: $DAEMON_BIN" >> $LOG
    "$DAEMON_BIN" --daemon >> $LOG 2>&1 &
    sleep 3
    if pidof audio-bridge >/dev/null 2>&1; then
        echo "$(date) Daemon started OK, PID=$(pidof audio-bridge)" >> $LOG
    else
        echo "$(date) WARNING: Daemon failed to start — check SELinux or binary integrity" >> $LOG
    fi
}

if [ -z "$DAEMON_BIN" ]; then
    echo "$(date) ERROR: audio-bridge binary not found in MODDIR or /system/bin" >> $LOG
elif ! pidof audio-bridge >/dev/null 2>&1; then
    echo "$(date) Starting audio bridge daemon" >> $LOG
    start_daemon
else
    # At reboot the daemon may still be visible in pidof while dying from SIGTERM.
    # Wait up to 5 s; if it exits we restart, otherwise it is genuinely healthy.
    STALE=0
    for _w in 1 2 3 4 5; do
        sleep 1
        if ! pidof audio-bridge >/dev/null 2>&1; then
            STALE=1
            break
        fi
    done
    if [ "$STALE" = "1" ]; then
        echo "$(date) Stale daemon was dying; restarting" >> $LOG
        start_daemon
    else
        echo "$(date) Daemon already running, PID=$(pidof audio-bridge)" >> $LOG
    fi
fi

# Background: wait for the framework, install APK if needed, start service.
(
    # Wait for boot_completed (cap ~2 min).
    for i in $(seq 1 60); do
        if [ "$(getprop sys.boot_completed)" = "1" ]; then break; fi
        sleep 2
    done
    sleep 3

    # On Android 16, the priv-app overlay triggers a Resources null-deref
    # inside handleBindApplication BEFORE any user code runs, crashing on
    # every FGS start attempt. The crash check used to run before the start
    # attempts, so it always saw 0 crashes — a timing window that can never
    # close. The fix: unconditionally prefer a data-app install over the
    # priv-app overlay on every boot. pm install -r retains all granted
    # permissions and the resulting package still runs in priv_app SELinux
    # context (updated system app), but the data-app APK path avoids the
    # Android 16 priv-app resource initialization crash entirely.
    APK_STATE=$(pm path com.audiobridge 2>/dev/null)

    if [ -z "$APK_STATE" ]; then
        echo "$(date) com.audiobridge not registered; pm install from MODDIR" >> $LOG
        [ -f "$MODDIR/AudioBridge.apk" ] && \
            pm install -r -g "$MODDIR/AudioBridge.apk" >> $LOG 2>&1
        sleep 2
    elif echo "$APK_STATE" | grep -q "/system/priv-app/"; then
        echo "$(date) com.audiobridge is priv-app — reinstalling as data-app (avoids Android 16 handleBindApplication crash)" >> $LOG
        if [ -f "$MODDIR/AudioBridge.apk" ]; then
            pm install -r -g "$MODDIR/AudioBridge.apk" >> $LOG 2>&1
            sleep 2
        fi
    else
        echo "$(date) com.audiobridge present at $APK_STATE (data-app, ok)" >> $LOG
    fi

    # Start the FGS directly. Running as root (uid=0) is explicitly exempt from
    # Android 12+'s background FGS restriction in ActiveServices.java, so
    # `am start-foreground-service` bypasses ForegroundServiceStartNotAllowedException
    # without needing a visible activity. Service must call startForeground() within 5s.
    FGS_OUT=$(am start-foreground-service --user 0 com.audiobridge/.AudioBridgeService 2>&1)
    echo "$(date) FGS direct: $FGS_OUT" >> $LOG
    sleep 4
    if pidof com.audiobridge >/dev/null 2>&1; then
        echo "$(date) AudioBridgeService running (pid=$(pidof com.audiobridge))" >> $LOG
        exit 0
    fi
    # Fallback: start via LauncherActivity (translucent theme ensures a window is
    # created so the activity is considered visible and the FGS call is exempt).
    echo "$(date) Direct FGS start may have failed — trying LauncherActivity fallback" >> $LOG
    OUT=$(am start --user 0 -n com.audiobridge/.LauncherActivity 2>&1)
    echo "$(date) LauncherActivity: $OUT" >> $LOG
    sleep 4
    if pidof com.audiobridge >/dev/null 2>&1; then
        echo "$(date) AudioBridgeService running via LauncherActivity" >> $LOG
    else
        echo "$(date) WARNING: AudioBridgeService not running after both attempts" >> $LOG
    fi
) &

# Background: keep webroot status files fresh so the WebUI can read them
# via fetch() without needing ksu.exec(). Runs every 15 s indefinitely.
# Includes config values (host/port/token) so the WebUI can display them.
(
    WROOT="$MODDIR/webroot"
    while true; do
        P=$(cat /data/local/tmp/audio_bridge.pid 2>/dev/null | tr -d ' \t\n\r')
        H=$(grep '^HOST='  /data/local/tmp/audio_bridge.conf 2>/dev/null | cut -d= -f2-)
        PR=$(grep '^PORT=' /data/local/tmp/audio_bridge.conf 2>/dev/null | cut -d= -f2-)
        TK=$(grep '^TOKEN=' /data/local/tmp/audio_bridge.conf 2>/dev/null | cut -d= -f2-)
        if [ -n "$P" ] && [ -d "/proc/$P" ]; then
            C=$(grep -aE "Connected to server!|Disconnected,|No server configured" \
                /data/local/tmp/audio_bridge.log 2>/dev/null | tail -1 | sed 's/"/'"'"'/g')
            printf '{"running":true,"pid":"%s","conn":"%s","host":"%s","port":"%s","token":"%s"}\n' \
                "$P" "$C" "$H" "$PR" "$TK" > "$WROOT/status.json" 2>/dev/null
        else
            printf '{"running":false,"pid":"","conn":"","host":"%s","port":"%s","token":"%s"}\n' \
                "$H" "$PR" "$TK" > "$WROOT/status.json" 2>/dev/null
        fi
        tail -n 60 /data/local/tmp/audio_bridge.log \
            > "$WROOT/daemon.log" 2>/dev/null
        tail -n 25 /data/local/tmp/audio_bridge_service.log \
            > "$WROOT/service.log" 2>/dev/null
        sleep 15
    done
) &
EOF
    chmod +x "$PROJECT_DIR/zygisk/module/service.sh"

    # Create post-fs-data.sh (MUST be minimal - never block boot)
    cat > "$PROJECT_DIR/zygisk/module/post-fs-data.sh" << 'EOF'
#!/system/bin/sh
# Keep empty to avoid blocking boot
MODDIR=${0%/*}
EOF
    chmod +x "$PROJECT_DIR/zygisk/module/post-fs-data.sh"

    # uninstall.sh runs when the user removes the module via Magisk/KernelSU
    # Manager. Runs with the module still mounted, so we can see $MODDIR.
    # Responsibilities:
    #   1. Uninstall the data-app copy (priv-app overlay cleans itself when
    #      the module is unmounted; pm install persists unless we remove it).
    #   2. Kill the daemon so the user doesn't need to reboot.
    #   3. Clean up /data/local/tmp diagnostic files.
    cat > "$PROJECT_DIR/zygisk/module/uninstall.sh" << 'EOF'
#!/system/bin/sh
LOG=/data/local/tmp/audio_bridge_uninstall.log
echo "$(date) uninstall.sh started" >> $LOG

# Stop the running daemon
if pidof audio-bridge >/dev/null 2>&1; then
    PID=$(pidof audio-bridge)
    kill $PID 2>/dev/null
    sleep 1
    kill -9 $PID 2>/dev/null
    echo "$(date) daemon killed (was PID $PID)" >> $LOG
fi

# Stop the foreground service and uninstall the APK.
# pm uninstall removes the package entry in all cases — both the data-app
# copy (persistent) and the priv-app overlay copy (user-space record).
# The overlay file itself is removed automatically when the module unmounts.
am stopservice --user 0 -n com.audiobridge/.AudioBridgeService 2>&1 >> $LOG
APK_PATH=$(pm path com.audiobridge 2>/dev/null)
if [ -n "$APK_PATH" ]; then
    pm uninstall --user 0 com.audiobridge >> $LOG 2>&1
    echo "$(date) pm uninstall com.audiobridge (was $APK_PATH)" >> $LOG
else
    echo "$(date) com.audiobridge not installed, nothing to uninstall" >> $LOG
fi

# Clean diagnostic/runtime files
rm -f /data/local/tmp/audio_bridge.log \
      /data/local/tmp/audio_bridge_java.log \
      /data/local/tmp/audio_bridge_service.log \
      /data/local/tmp/audio_bridge.sock \
      /data/local/tmp/audio_bridge.pid \
      /data/local/tmp/audio_bridge.conf \
      /data/local/tmp/audio_bridge_id

echo "$(date) uninstall.sh complete" >> $LOG
EOF
    chmod +x "$PROJECT_DIR/zygisk/module/uninstall.sh"

    echo -e "${GREEN}Zygisk module built${NC}"
}

# Build all
main() {
    echo -e "${YELLOW}Starting full build...${NC}"
    
    # Build mbedtls
    build_mbedtls "aarch64" "arm64-v8a"
    
    # Build dependencies for arm64
    build_opus "aarch64" "arm64-v8a"
    build_tinyalsa "aarch64" "arm64-v8a"
    
    # Build native binary
    build_native "aarch64" "arm64-v8a"

    # Prepare APK sources
    build_apk
    
    # Build the APK. The wrapper was bootstrapped inside build_apk already
    # (before we wrote the real AGP-referencing build.gradle), so we just
    # have to invoke ./gradlew here.
    echo -e "${YELLOW}Building APK via gradle wrapper...${NC}"
    if [ -f "$PROJECT_DIR/app/gradlew" ]; then
        ( cd "$PROJECT_DIR/app" && chmod +x gradlew && ./gradlew assembleRelease --no-daemon ) || \
            echo -e "${RED}Gradlew build failed${NC}"
    else
        echo -e "${RED}gradlew missing — wrapper bootstrap failed in build_apk.${NC}"
        echo -e "${RED}Install gradle (>=8.0) and re-run, or open app/ in Android Studio.${NC}"
    fi
    cd "$PROJECT_DIR"
    
    # Build Zygisk module
    build_zygisk
    
    # Package APK and binary into module. We ship two copies:
    #   1. system/priv-app/AudioBridge/AudioBridge.apk — Magisk systemless overlay
    #      makes /system/priv-app/ include the APK; Android picks it up on boot
    #      scan with privileged permissions (privapp-permissions-audiobridge.xml).
    #   2. AudioBridge.apk at module root — service.sh falls back to `pm install`
    #      from here if priv-app detection didn't pick up the package (e.g. on
    #      restrictive ROMs or when signing requirements differ).
    APK_PATH=$(find "$PROJECT_DIR/app/build/outputs/apk" -name "*.apk" 2>/dev/null | head -n 1)
    if [ -n "$APK_PATH" ] && [ -f "$APK_PATH" ]; then
        cp "$APK_PATH" "$PROJECT_DIR/zygisk/module/system/priv-app/AudioBridge/AudioBridge.apk"
        cp "$APK_PATH" "$PROJECT_DIR/zygisk/module/AudioBridge.apk"
        echo -e "${GREEN}Packaged APK: $APK_PATH${NC}"
    else
        echo -e "${RED}Warning: APK not found! Module will not be fully functional until APK is placed in zygisk/module/system/priv-app/AudioBridge/${NC}"
    fi
    
    cp "$BUILD_DIR/audio-bridge-arm64-v8a" "$PROJECT_DIR/zygisk/module/system/bin/audio-bridge"
    
    # Zip module
    cd "$PROJECT_DIR/zygisk/module"
    zip -r9 "$PROJECT_DIR/build/audio-bridge-module.zip" ./*
    cd "$PROJECT_DIR"
    
    echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║                    Build Complete!                           ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "Output files:"
    echo -e "  Magisk/KernelSU Module: ${YELLOW}$PROJECT_DIR/build/audio-bridge-module.zip${NC}"
    echo ""
    echo -e "Installation:"
    echo -e "  Flash the module zip in Magisk or KernelSU and reboot."
}

main "$@"
