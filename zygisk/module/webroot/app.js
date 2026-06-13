document.addEventListener('DOMContentLoaded', async () => {

    const hostInput        = document.getElementById('host');
    const portInput        = document.getElementById('port');
    const tokenInput       = document.getElementById('token');
    const daemonBadge      = document.getElementById('daemon-badge');
    const daemonPid        = document.getElementById('daemon-pid');
    const daemonConnection = document.getElementById('daemon-connection');
    const daemonServer     = document.getElementById('daemon-server');
    const zygiskStatus     = document.getElementById('zygisk-status');
    const logOutput        = document.getElementById('log-output');
    const btnTest          = document.getElementById('btn-test');
    const btnSave          = document.getElementById('btn-save');
    const btnRefreshLogs   = document.getElementById('btn-refresh-logs');
    const testResult       = document.getElementById('test-result');

    const MODDIR   = '/data/adb/modules/audio_bridge';
    const CONFFILE = '/data/local/tmp/audio_bridge.conf';
    const LOGFILE  = '/data/local/tmp/audio_bridge.log';
    const FIND_DAEMON =
        `DAEMON=$(ls ${MODDIR}/system/bin/audio-bridge /system/bin/audio-bridge 2>/dev/null | head -1)`;

    let config = { HOST: '', PORT: '59100', TOKEN: 'default_secure_token_123' };

    // ── fetch() helper — reads files served from module webroot ──────────────
    async function fetchFile(path) {
        try {
            const r = await fetch(path + '?' + Date.now(), { cache: 'no-store' });
            return r.ok ? await r.text() : null;
        } catch (e) {
            return null;
        }
    }

    async function fetchJSON(path) {
        const text = await fetchFile(path);
        if (!text) return null;
        try { return JSON.parse(text); } catch (e) { return null; }
    }

    // ── ksu.exec() — used only for write operations (save config, restart) ───
    async function runCmd(cmd) {
        if (typeof ksu === 'undefined' || typeof ksu.exec !== 'function') {
            return { errno: 1, stdout: '', stderr: 'ksu unavailable' };
        }
        try {
            const r = await ksu.exec(cmd);
            if (!r) return { errno: 1, stdout: '', stderr: 'ksu.exec returned null' };
            return {
                errno:  r.errno  !== undefined ? r.errno  : 1,
                stdout: r.stdout !== undefined ? r.stdout : (r.output || ''),
                stderr: r.stderr !== undefined ? r.stderr : ''
            };
        } catch (e) {
            return { errno: 1, stdout: '', stderr: String(e.message || e) };
        }
    }

    function sq(s) { return String(s).replace(/'/g, "'\\''"); }

    // ── Config load — ksu.exec() primary, status.json fallback ──────────────
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
        } else {
            // ksu.exec unavailable — read config embedded in status.json
            const status = await fetchJSON('./status.json');
            if (status) {
                if (status.host)  config.HOST  = status.host;
                if (status.port)  config.PORT  = status.port;
                if (status.token) config.TOKEN = status.token;
            }
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

    // ── Daemon status — fetch() primary, ksu.exec() fallback ─────────────────
    async function checkStatus() {
        let running = false, pid = '', conn = '';

        // Primary: read status.json written by service.sh's background loop
        const status = await fetchJSON('./status.json');
        if (status !== null) {
            running = !!status.running;
            pid     = status.pid  || '';
            conn    = status.conn || '';
        } else {
            // Fallback: ksu.exec() small calls when fetch isn't available
            const pidRes = await runCmd('cat /data/local/tmp/audio_bridge.pid 2>/dev/null');
            pid = (pidRes.stdout || '').replace(/\s/g, '');
            if (pid) {
                const procRes = await runCmd('[ -d /proc/' + pid + ' ] && echo Y || echo N');
                running = (procRes.stdout || '').trim().charAt(0) === 'Y';
            }
            if (running) {
                const logRes = await runCmd(
                    'grep -aE "Connected to server!|Disconnected,|No server configured" ' +
                    '/data/local/tmp/audio_bridge.log 2>/dev/null | tail -1'
                );
                conn = (logRes.stdout || '').trim();
            }
        }

        if (running) {
            daemonBadge.textContent = 'running';
            daemonBadge.className   = 'badge badge-running';
            daemonPid.textContent   = pid || '—';
            if (conn.includes('Connected to server!')) {
                daemonConnection.textContent = 'connected';
                daemonConnection.className   = 'detail-val conn-ok';
            } else if (conn.includes('No server configured')) {
                daemonConnection.textContent = 'waiting for config';
                daemonConnection.className   = 'detail-val conn-wait';
            } else {
                daemonConnection.textContent = 'disconnected';
                daemonConnection.className   = 'detail-val conn-bad';
            }
        } else {
            daemonBadge.textContent      = status === null ? 'unknown' : 'stopped';
            daemonBadge.className        = status === null ? 'badge badge-unknown' : 'badge badge-stopped';
            daemonPid.textContent        = '—';
            daemonConnection.textContent = '—';
            daemonConnection.className   = 'detail-val';
        }

        // Zygisk — ksu.exec() only, no fetch() equivalent
        const zyRes   = await runCmd(
            'logcat -b main -d -t 50 -s AudioBridge-Zygisk 2>/dev/null | grep -c "Connected to daemon"'
        );
        const zyCount = parseInt(zyRes.stdout || '0', 10);
        if (zygiskStatus) {
            if (zyCount > 0) {
                zygiskStatus.textContent = `Active (${zyCount} proc)`;
                zygiskStatus.style.color = 'var(--success)';
            } else if (zyRes.errno === 0) {
                // exec worked; .so present?
                const soRes  = await runCmd(
                    '[ -f ' + MODDIR + '/zygisk/arm64-v8a.so ] && echo yes || echo no'
                );
                const soExists = (soRes.stdout || '').includes('yes');
                zygiskStatus.textContent = soExists
                    ? 'Not loaded (enable Zygisk in KSU)'
                    : 'Missing .so — rebuild module';
                zygiskStatus.style.color = 'var(--danger)';
            } else {
                zygiskStatus.textContent = 'ksu.exec unavailable';
                zygiskStatus.style.color = '';
            }
        }
    }

    // ── Log fetch — fetch() primary for daemon/service, ksu.exec for logcat ──
    async function fetchLogs() {
        let out = '';

        const daemonLog  = await fetchFile('./daemon.log');
        const serviceLog = await fetchFile('./service.log');

        if (daemonLog !== null || serviceLog !== null) {
            // Files served from webroot — ksu.exec not needed
            out += '── daemon ──\n'  + (daemonLog  || '(empty)') + '\n';
            out += '── service ──\n' + (serviceLog || '(empty)') + '\n';
        } else {
            // Fallback to ksu.exec for log files
            const res = await runCmd(
                `{ echo '── daemon ──'; tail -n 40 ${LOGFILE} 2>/dev/null; ` +
                `echo '── service ──'; tail -n 20 /data/local/tmp/audio_bridge_service.log 2>/dev/null; } 2>/dev/null`
            );
            out += res.stdout || '── no logs (ksu.exec unavailable, webroot not yet populated) ──\n';
        }

        // logcat sections always need ksu.exec
        const jRes = await runCmd(
            'logcat -b main -d -t 50 -s AudioBridge-Service AudioBridge-Boot 2>/dev/null'
        );
        if (jRes.errno === 0 && jRes.stdout) {
            out += '── java-logcat ──\n' + jRes.stdout + '\n';
        }

        const zRes = await runCmd(
            'logcat -b main -d -t 30 -s AudioBridge-Zygisk 2>/dev/null'
        );
        if (zRes.errno === 0 && zRes.stdout) {
            out += '── zygisk ──\n' + zRes.stdout + '\n';
        }

        logOutput.textContent = out || 'No logs available yet.';
        const terminal = document.querySelector('.terminal');
        if (terminal) terminal.scrollTop = terminal.scrollHeight;
    }

    // ── Test connection ───────────────────────────────────────────────────────
    btnTest.addEventListener('click', async () => {
        const host  = hostInput.value.trim();
        const port  = portInput.value.trim();
        const token = tokenInput.value.trim();

        if (!host || !port) { showResult('error', 'Please enter a valid Host and Port.'); return; }

        btnTest.disabled    = true;
        btnTest.textContent = 'Testing...';
        showResult('hidden', '');

        const res = await runCmd(
            `${FIND_DAEMON}; ` +
            `"$DAEMON" --host '${sq(host)}' --port '${sq(port)}' --token '${sq(token)}' --check-server 2>&1`
        );

        if (res.errno === 0) {
            showResult('success', 'Connection successful! TLS handshake passed.');
        } else if (res.errno !== 0 && !res.stdout && !res.stderr.includes('fail')) {
            // ksu.exec unavailable — check if daemon is already connected via status.json
            const status = await fetchJSON('./status.json');
            const conn   = (status && status.conn) || '';
            if (conn.includes('Connected to server!')) {
                showResult('success', 'Daemon is connected to the server (verified via status).');
            } else if (status && status.running) {
                showResult('error', 'Daemon running but not connected.\nStatus: ' + (conn || 'unknown'));
            } else {
                showResult('error', 'ksu.exec unavailable — cannot run connection test.\nCheck status card above for connection state.');
            }
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

        if (!host || !port) { showResult('error', 'Please enter a valid Host and Port.'); return; }

        btnSave.disabled    = true;
        btnSave.textContent = 'Saving...';

        const writeRes = await runCmd(
            `printf '%s\\n%s\\n%s\\n' 'HOST=${sq(host)}' 'PORT=${sq(port)}' 'TOKEN=${sq(token)}' > ${CONFFILE}`
        );

        if (writeRes.errno !== 0 && writeRes.stderr === 'ksu unavailable') {
            showResult('error', 'ksu.exec unavailable — cannot save config from this WebUI.\nPush config manually: echo "HOST=x\\nPORT=y\\nTOKEN=z" > ' + CONFFILE);
            btnSave.disabled    = false;
            btnSave.textContent = 'Save & Restart';
            return;
        }

        await runCmd(`kill $(pidof audio-bridge 2>/dev/null) 2>/dev/null; sleep 2`);
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
        testResult.className   = `result ${type}`;
        testResult.textContent = message;
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    await loadConfig();
    await checkStatus();
    await fetchLogs();

    const intervalId = setInterval(async () => {
        await checkStatus();
        await fetchLogs();
    }, 15000);

    window.addEventListener('beforeunload', () => clearInterval(intervalId));
});
