document.addEventListener('DOMContentLoaded', async () => {

    const hostInput       = document.getElementById('host');
    const portInput       = document.getElementById('port');
    const tokenInput      = document.getElementById('token');
    const daemonBadge      = document.getElementById('daemon-badge');
    const daemonPid        = document.getElementById('daemon-pid');
    const daemonConnection = document.getElementById('daemon-connection');
    const daemonServer     = document.getElementById('daemon-server');
    const zygiskStatus     = document.getElementById('zygisk-status');
    const logOutput       = document.getElementById('log-output');
    const btnTest         = document.getElementById('btn-test');
    const btnSave         = document.getElementById('btn-save');
    const btnRefreshLogs  = document.getElementById('btn-refresh-logs');
    const testResult      = document.getElementById('test-result');

    const MODDIR  = '/data/adb/modules/audio_bridge';
    const CONFFILE = '/data/local/tmp/audio_bridge.conf';
    const LOGFILE  = '/data/local/tmp/audio_bridge.log';
    // Shell snippet that resolves the daemon binary path (MODDIR preferred)
    const FIND_DAEMON =
        `DAEMON=$(ls ${MODDIR}/system/bin/audio-bridge /system/bin/audio-bridge 2>/dev/null | head -1)`;

    let config = { HOST: '', PORT: '59100', TOKEN: '' };

    // ── Shell exec via KernelSU ───────────────────────────────────────────────
    async function runCmd(cmd) {
        if (typeof ksu === 'undefined' || typeof ksu.exec !== 'function') {
            return { errno: 1, stdout: '', stderr: 'ksu unavailable' };
        }
        try {
            const r = await ksu.exec(cmd);
            // Guard null/undefined return (can happen on some KSU builds)
            if (!r) return { errno: 1, stdout: '', stderr: 'ksu.exec returned null' };
            // Old KernelSU used 'output' instead of 'stdout'
            return {
                errno:  r.errno  !== undefined ? r.errno  : 1,
                stdout: r.stdout !== undefined ? r.stdout : (r.output || ''),
                stderr: r.stderr !== undefined ? r.stderr : ''
            };
        } catch (e) {
            return { errno: 1, stdout: '', stderr: String(e.message || e) };
        }
    }

    // Escape a value for embedding inside a shell single-quoted string
    function sq(s) {
        return String(s).replace(/'/g, "'\\''");
    }

    // ── Config load ───────────────────────────────────────────────────────────
    async function loadConfig() {
        const res = await runCmd(`cat ${CONFFILE} 2>/dev/null`);
        if (res.errno === 0 && res.stdout) {
            res.stdout.split('\n').forEach(line => {
                const eq = line.indexOf('=');
                if (eq > 0) {
                    const k = line.slice(0, eq).trim();
                    const v = line.slice(eq + 1).trim();
                    if (k) config[k] = v;
                }
            });
        }
        hostInput.value  = config.HOST  || '';
        portInput.value  = config.PORT  || '59100';
        tokenInput.value = config.TOKEN || '';
        updateServerLabel();
    }

    function updateServerLabel() {
        const h = hostInput.value.trim() || config.HOST;
        const p = portInput.value.trim() || config.PORT;
        daemonServer.textContent = h ? `${h}:${p}` : 'Not configured';
    }

    hostInput.addEventListener('input', updateServerLabel);
    portInput.addEventListener('input', updateServerLabel);

    // ── Daemon status ─────────────────────────────────────────────────────────
    async function checkStatus() {
        // Step 1: read PID file (tiny command — avoids shell complexity limits)
        const pidRes = await runCmd('cat /data/local/tmp/audio_bridge.pid 2>/dev/null');
        const pid    = (pidRes.stdout || '').replace(/\s/g, '');

        // Step 2: check /proc/<pid> in a separate call
        let running = false;
        if (pid) {
            const procRes = await runCmd('[ -d /proc/' + pid + ' ] && echo Y || echo N');
            running = (procRes.stdout || '').trim().charAt(0) === 'Y';
        }

        if (running) {
            daemonBadge.textContent = 'Running';
            daemonBadge.className   = 'badge running';
            daemonPid.textContent   = pid;

            // Step 3: last connection-status line from daemon log
            const logRes = await runCmd(
                'grep -aE "Connected to server!|Disconnected,|No server configured" ' +
                '/data/local/tmp/audio_bridge.log 2>/dev/null | tail -1'
            );
            const conn = (logRes.stdout || '').trim();
            if (conn.includes('Connected to server!')) {
                daemonConnection.textContent = 'Connected';
                daemonConnection.className   = 'conn-badge connected';
            } else if (conn.includes('No server configured')) {
                daemonConnection.textContent = 'Waiting for config';
                daemonConnection.className   = 'conn-badge waiting';
            } else {
                daemonConnection.textContent = 'Disconnected';
                daemonConnection.className   = 'conn-badge disconnected';
            }
        } else {
            daemonBadge.textContent      = 'Stopped';
            daemonBadge.className        = 'badge stopped';
            daemonPid.textContent        = '--';
            daemonConnection.textContent = '--';
            daemonConnection.className   = 'conn-badge';
        }

        // Zygisk hook status
        const zyRes = await runCmd(
            'logcat -b main -d -t 50 -s AudioBridge-Zygisk 2>/dev/null | grep -c "Connected to daemon"'
        );
        const zyCount = parseInt(zyRes.stdout || '0', 10);
        if (zygiskStatus) {
            if (zyCount > 0) {
                zygiskStatus.textContent = `Active (${zyCount} proc)`;
                zygiskStatus.style.color = 'var(--success)';
            } else {
                const soRes = await runCmd(
                    '[ -f ' + MODDIR + '/zygisk/arm64-v8a.so ] && echo yes || echo no'
                );
                const soExists = (soRes.stdout || '').includes('yes');
                zygiskStatus.textContent = soExists ? 'Not loaded (enable Zygisk in KSU)' : 'Missing .so — rebuild module';
                zygiskStatus.style.color = 'var(--danger)';
            }
        }
    }

    // ── Log fetch ─────────────────────────────────────────────────────────────
    async function fetchLogs() {
        // ksu diagnostic line — shows whether ksu.exec works and as what user
        const diagRes = await runCmd('echo ksu_ok && id');
        const ksuOk   = (diagRes.stdout || '').includes('ksu_ok');
        const diagLine = ksuOk
            ? '── ksu-exec: ok (' + (diagRes.stdout || '').split('\n').slice(1,2).join('').trim() + ') ──\n'
            : '── ksu-exec: FAILED — ' + (diagRes.stderr || diagRes.stdout || 'no output') + ' ──\n';

        const res = await runCmd(
            `{ echo '── daemon ──'; tail -n 40 ${LOGFILE} 2>/dev/null; ` +
            `echo '── service ──'; tail -n 15 /data/local/tmp/audio_bridge_service.log 2>/dev/null; ` +
            `echo '── java ──'; tail -n 20 /data/local/tmp/audio_bridge_java.log 2>/dev/null; ` +
            `echo '── zygisk ──'; logcat -b main -d -t 30 -s AudioBridge-Zygisk 2>/dev/null; ` +
            `echo '── java-logcat ──'; logcat -b main -d -t 50 -s AudioBridge-Service AudioBridge-Boot 2>/dev/null; } 2>/dev/null`
        );
        logOutput.textContent = diagLine + (res.stdout || 'No logs available yet.');
        const terminal = document.querySelector('.terminal');
        if (terminal) terminal.scrollTop = terminal.scrollHeight;
    }

    // ── Test connection ───────────────────────────────────────────────────────
    btnTest.addEventListener('click', async () => {
        const host  = hostInput.value.trim();
        const port  = portInput.value.trim();
        const token = tokenInput.value.trim();

        if (!host || !port) {
            showResult('error', 'Please enter a valid Host and Port.');
            return;
        }

        btnTest.disabled    = true;
        btnTest.textContent = 'Testing...';
        showResult('hidden', '');

        const cmd =
            `${FIND_DAEMON}; ` +
            `"$DAEMON" --host '${sq(host)}' --port '${sq(port)}' --token '${sq(token)}' --check-server 2>&1`;
        const res = await runCmd(cmd);

        if (res.errno === 0) {
            showResult('success', 'Connection successful! TLS handshake passed.');
        } else {
            showResult('error', `Connection failed.\n${res.stderr || res.stdout || 'Check IP / Port / Token.'}`);
        }

        btnTest.disabled    = false;
        btnTest.textContent = 'Test Connection';
    });

    // ── Save & Restart ────────────────────────────────────────────────────────
    btnSave.addEventListener('click', async () => {
        const host  = hostInput.value.trim();
        const port  = portInput.value.trim();
        const token = tokenInput.value.trim();

        if (!host || !port) {
            showResult('error', 'Please enter a valid Host and Port.');
            return;
        }

        btnSave.disabled    = true;
        btnSave.textContent = 'Saving...';

        // Write config with printf %s format specifiers to avoid backslash
        // interpretation in the format string, and single-quote each argument
        // so shell metacharacters in host/token are harmless.
        await runCmd(
            `printf '%s\\n%s\\n%s\\n' 'HOST=${sq(host)}' 'PORT=${sq(port)}' 'TOKEN=${sq(token)}' > ${CONFFILE}`
        );

        // Kill existing daemon cleanly (SIGTERM → clean shutdown)
        await runCmd(`kill $(pidof audio-bridge 2>/dev/null) 2>/dev/null; sleep 2`);

        // Restart daemon directly using the module binary (avoids running the
        // full boot service.sh which applies SELinux rules, pm-grant, etc.)
        await runCmd(
            `${FIND_DAEMON}; [ -n "$DAEMON" ] && "$DAEMON" --daemon >> ${LOGFILE} 2>&1 || true`
        );

        showResult('success', 'Saved. Daemon restarting — status updates in 4 s.');
        updateServerLabel();

        setTimeout(async () => {
            btnSave.disabled    = false;
            btnSave.textContent = 'Save & Restart';
            await checkStatus();
            await fetchLogs();
            showResult('hidden', '');
        }, 4000);
    });

    // ── Refresh button ────────────────────────────────────────────────────────
    btnRefreshLogs.addEventListener('click', async () => {
        await fetchLogs();
        await checkStatus();
    });

    // ── Helpers ───────────────────────────────────────────────────────────────
    function showResult(type, message) {
        testResult.className   = `test-result ${type}`;
        testResult.textContent = message;
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    await loadConfig();
    await checkStatus();
    await fetchLogs();

    const intervalId = setInterval(async () => {
        await checkStatus();
        await fetchLogs();
    }, 5000);

    window.addEventListener('beforeunload', () => clearInterval(intervalId));
});
