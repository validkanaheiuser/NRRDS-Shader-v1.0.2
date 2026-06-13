document.addEventListener('DOMContentLoaded', async () => {

    const hostInput       = document.getElementById('host');
    const portInput       = document.getElementById('port');
    const tokenInput      = document.getElementById('token');
    const daemonBadge     = document.getElementById('daemon-badge');
    const daemonPid       = document.getElementById('daemon-pid');
    const daemonConnection = document.getElementById('daemon-connection');
    const daemonServer    = document.getElementById('daemon-server');
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
        if (typeof ksu === 'undefined') {
            return { errno: 1, stdout: '', stderr: 'KernelSU WebUI not available' };
        }
        try {
            return await ksu.exec(cmd);
        } catch (e) {
            return { errno: 1, stdout: '', stderr: e.message };
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
        // Try pidof first, then pgrep, then PID file
        let pid = '';

        const r1 = await runCmd('pidof audio-bridge 2>/dev/null');
        if (r1.errno === 0 && r1.stdout.trim()) {
            pid = r1.stdout.trim().split(/\s+/)[0];
        }

        if (!pid) {
            const r2 = await runCmd('pgrep -x audio-bridge 2>/dev/null');
            if (r2.errno === 0 && r2.stdout.trim()) {
                pid = r2.stdout.trim().split(/\s+/)[0];
            }
        }

        if (!pid) {
            const r3 = await runCmd(`cat /data/local/tmp/audio_bridge.pid 2>/dev/null`);
            if (r3.errno === 0 && r3.stdout.trim()) {
                const candidate = r3.stdout.trim();
                const alive = await runCmd(`[ -d /proc/${candidate} ] && echo yes`);
                if (alive.stdout.includes('yes')) pid = candidate;
            }
        }

        if (pid) {
            daemonBadge.textContent = 'Running';
            daemonBadge.className   = 'badge running';
            daemonPid.textContent   = pid;

            // Determine connection state from the daemon log
            const logRes = await runCmd(
                `grep -aE 'Connected to server!|Disconnected,|reconnecting|No server configured' ${LOGFILE} 2>/dev/null | tail -1`
            );
            const lastLine = logRes.stdout || '';
            if (lastLine.includes('Connected to server!')) {
                daemonConnection.textContent = 'Connected';
                daemonConnection.className   = 'conn-badge connected';
            } else if (lastLine.includes('No server configured')) {
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
    }

    // ── Log fetch ─────────────────────────────────────────────────────────────
    async function fetchLogs() {
        // Combine daemon log (last 30 lines) with service log (last 10 lines)
        const res = await runCmd(
            `{ echo '── daemon ──'; tail -n 30 ${LOGFILE} 2>/dev/null; ` +
            `echo '── service ──'; tail -n 10 /data/local/tmp/audio_bridge_service.log 2>/dev/null; } 2>/dev/null`
        );
        logOutput.textContent = res.stdout || 'No logs available yet.';
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
