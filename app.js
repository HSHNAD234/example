document.addEventListener('DOMContentLoaded', () => {
    // Section Elements
    const setupSection = document.getElementById('setup-section');
    const launcherSection = document.getElementById('launcher-section');
    
    // UI Elements
    const selectGameBtn = document.getElementById('select-game-btn');
    const setupSelectBtn = document.getElementById('setup-select-btn');
    const autoSearchAgainBtn = document.getElementById('auto-search-again-btn');
    const gamePathFile = document.getElementById('gamePathFile');
    
    const selectedPathDisplay = document.getElementById('selected-path-display');
    const autoSearchStatus = document.getElementById('auto-search-status');
    const searchStatusText = document.getElementById('search-status-text');
    const searchSpinner = document.getElementById('search-spinner');
    const pathMatchHint = document.getElementById('path-match-hint');
    const saveConfigBtn = document.getElementById('save-config-btn');
    const serverUrlInput = document.getElementById('server-url-input');
    
    const progressFill = document.getElementById('progress-fill');
    const playBtn = document.getElementById('play-btn');
    const stopBtn = document.getElementById('stop-btn'); // may be null (removed from sidebar)
    const statusText = document.getElementById('status-text');
    const updateLabel = document.getElementById('update-label');
    const logsContainer = document.getElementById('logs-container');
    const dataPathText = document.getElementById('data-path');
    const changeSettingsBtn = document.getElementById('change-settings');
    const fixCaBtn = document.getElementById('fix-ca-btn');
    const serverStatusText = document.getElementById('server-status-text');
    const notificationContainer = document.getElementById('notification-container');
    const applyHostsBtn = document.getElementById('apply-hosts-btn');
    const hostsStatusText = document.getElementById('hosts-status');

    // Modal Elements
    const fixModal = document.getElementById('fix-modal');
    const confirmFixBtn = document.getElementById('confirm-fix-btn');
    const cancelFixBtn = document.getElementById('cancel-fix-btn');

    const updateModal = document.getElementById('update-modal');
    const updateModalTitle = document.getElementById('update-modal-title');
    const updateModalMessage = document.getElementById('update-modal-message');
    const updateModalDetails = document.getElementById('update-modal-details');
    const confirmUpdateBtn = document.getElementById('confirm-update-btn');
    const cancelUpdateBtn = document.getElementById('cancel-update-btn');

    // Auth Elements
    const authSection = document.getElementById('auth-section');
    const discordLoginBtn = document.getElementById('discord-login-btn');
    const authRetryBtn = document.getElementById('auth-retry-btn');
    const authUserInfo = document.getElementById('auth-user-info');
    const discordAvatar = document.getElementById('discord-avatar');
    const discordName = document.getElementById('discord-name');
    const authStatusText = document.getElementById('auth-status-text');
    const authErrorMsg = document.getElementById('auth-error-msg');

    let currentStatus = {
        gamePath: '',
        isInstalled: false,
        isRunning: false,
        bootChecksInProgress: true,
        updateCheckInProgress: false,
        autoSearchInProgress: false
    };
    try {
        const restoreFromStorage = localStorage.getItem(_STORE_COMMITTED_KEY || '__malakor_committed_path_v1');
        if (restoreFromStorage && /\.exe$/i.test(restoreFromStorage) && restoreFromStorage.length > 6) {
            _committedGamePath = restoreFromStorage;
            currentStatus.gamePath = restoreFromStorage;
            currentStatus.isInstalled = true;
            console.log(`[Boot] Restored committed gamePath from localStorage: ${restoreFromStorage}`);
        }
    } catch (_) {}
    // === CRITICAL GUARD ===: Intercept ANY attempt to set gamePath to ''/null/undefined
    // when we already have a committed path. This is the final safety net.
    try {
        let _gpValue = currentStatus.gamePath;
        Object.defineProperty(currentStatus, 'gamePath', {
            configurable: true,
            enumerable: true,
            get() { return _gpValue; },
            set(newVal) {
                const normalized = (newVal === null || newVal === undefined) ? '' : String(newVal);
                if (_committedGamePath) {
                    if (!normalized) {
                        console.warn('[currentStatus.gamePath setter] BLOCKED attempt to clear committed path. Stack:');
                        try { console.warn(new Error().stack); } catch (_) {}
                        _gpValue = _committedGamePath;
                        return;
                    }
                }
                _gpValue = normalized;
            }
        });
    } catch (e) {
        console.log('[Boot] Could not install gamePath setter guard (non-fatal):', e.message);
    }

    let pendingGamePath = '';

    // Polling - Will start after auth success
    let statusInterval, logsInterval, authInterval, hostsInterval;
    let currentUserId = '';

    // --- ตัวแปรควบคุมสถานะ Optimize Mode ---
    let launchPending = false;
    let launchCooldown = false; // ตัวล็อคป้องกัน UI รีเซ็ตเร็วเกินไป
    let _isUpdating = false;   // กัน update ซ้ำ while already in progress (game patch)
    let _appUpdating = false;  // กัน app update ซ้ำ และ lock ปุ่ม Start

    // --- RAM Optimize: Cached refs, dynamic polling, debounce, display caps ---
    const MAX_DISPLAY_LOGS = 50;
    const MAX_NOTIFICATIONS = 5;
    const optimizeOverlay = document.getElementById('optimize-overlay');
    const selectGameBtn2 = document.getElementById('select-game-btn');
    const fixCaBtn2 = document.getElementById('fix-ca-btn');

    let _lastLogsSig = '';
    let _lastStatusSig = '';

    // --- Anti-bounce / Race-condition guard state ---
    let _statusFetchSeq = 0;         // Incremental sequence counter for each fetchStatus() START
    let _lastAppliedStatusSeq = -1;  // Highest seq whose response has been destructively applied
    let _postSaveWindowMs = 0;       // If set (> Date.now()), skip destructive replace in fetchStatus()
    let _saveConfirmInProgress = false; // While true, background interval updates are paused/merged
    // Hard anti-bounce commit: once user successfully saved, this stays forever (page lifetime).
    // Even if DB / status returns empty (race, bad read, etc.), we won't bounce back to setup.
    let _committedGamePath = '';
    const _STORE_COMMITTED_KEY = '__malakor_committed_path_v1';

    // Debounce updateUI (max ~10 FPS) — avoid DOM thrash from setInterval
    let _uiTimer = 0;
    let _uiPending = false;
    let _autoSearchStarted = false;
    let _lastSearchToastKind = '';
    function _emitSearchToast(kind, message) {
        if (!message) return;
        if (_lastSearchToastKind === kind + '::' + message) return;
        _lastSearchToastKind = kind + '::' + message;
        if (kind === 'searching') showNotification(message, 'info');
        else if (kind === 'found') showNotification(message, 'success');
        else if (kind === 'notfound') showNotification(message, 'warn');
    }
    function updateUI() {
        if (_uiPending) return;
        _uiPending = true;
        if (_uiTimer) return;
        _uiTimer = setTimeout(() => {
            _uiTimer = 0;
            _uiPending = false;
            _renderUI();
        }, 80);
    }

    function _renderUI() {
        if (_committedGamePath && (!currentStatus.gamePath || currentStatus.gamePath !== _committedGamePath)) {
            console.log(`[_renderUI] Guard: applying committed path. current.gamePath=${JSON.stringify(currentStatus.gamePath)}, committed=${JSON.stringify(_committedGamePath)}`);
            try {
                const gpo = Object.getOwnPropertyDescriptor(currentStatus, 'gamePath');
                if (gpo && typeof gpo.set === 'function' && gpo.configurable) {
                    // If we installed a setter-protected prop, just assign; setter will keep history.
                }
            } catch (_) {}
            currentStatus.gamePath = _committedGamePath;
            currentStatus.isInstalled = true;
        }
        if (!currentStatus.gamePath) {
            if (setupSection && !setupSection.classList.contains('hidden')) {
                // Already on setup, nothing notable.
            } else {
                console.warn(`[_renderUI] Transition to SETUP. current.gamePath=${JSON.stringify(currentStatus.gamePath)}. committed=${JSON.stringify(_committedGamePath)}. Stack trace:`);
                try { console.warn(new Error().stack); } catch (_) {}
            }
            showSection(setupSection);
            if (!pendingGamePath) {
                const restored = _resolvePendingPath();
                if (restored) {
                    pendingGamePath = restored;
                    if (selectedPathDisplay) {
                        selectedPathDisplay.textContent = restored;
                        selectedPathDisplay.style.borderColor = 'rgba(16, 185, 129, 0.45)';
                    }
                    if (pathMatchHint) {
                        pathMatchHint.classList.remove('hidden', 'error-hint');
                        pathMatchHint.classList.add('found-hint');
                        pathMatchHint.textContent = 'Restored selection. If correct, press SAVE CONFIG below.';
                    }
                }
            }
            if (!_autoSearchStarted && !pendingGamePath && authSection && authSection.classList.contains('hidden')) {
                _autoSearchStarted = true;
                setTimeout(() => _runAutoSearch(false), 400);
            }
            return;
        }
        _autoSearchStarted = false;
        _stopAutoSearchPoll();
        showSection(launcherSection);

        const inGameState = currentStatus.isRunning || launchPending;
        const isUpdating = _isUpdating || _appUpdating;
        const backendChecking = !!(currentStatus && (currentStatus.bootChecksInProgress || currentStatus.updateCheckInProgress || currentStatus.autoSearchInProgress));
        const frontendChecking = !!(_saveConfirmInProgress || _autoSearchPollTimer || (typeof checkAutoUpdate === 'function' && checkAutoUpdate._running));
        const anyCheckInProgress = backendChecking || frontendChecking;
        const isReady = !inGameState && !isUpdating && !anyCheckInProgress;

        // ============== ALWAYS ENFORCE (no signature skip) ==============
        // These are lightweight ops. MUST run every render so state never
        // drifts out of sync (root cause of "Optimize Mode showing on idle").
        if (optimizeOverlay) {
            if (inGameState) optimizeOverlay.classList.remove('hidden');
            else optimizeOverlay.classList.add('hidden');
        }
        if (playBtn) {
            if (anyCheckInProgress || inGameState || isUpdating) {
                playBtn.classList.add('hidden');
            } else {
                playBtn.classList.remove('hidden');
            }
            playBtn.disabled = !!(inGameState || isUpdating);
        }

        // ============== HEAVY UI TEXT / COLOR / DOM CLASSES ==============
        // Skip when signature unchanged to avoid reflow-heavy rewrites.
        const sig = (inGameState ? 'G' : '') + (isUpdating ? 'U' : '') + (anyCheckInProgress ? 'C' : '') + (currentStatus.gamePath ? 'P' : '');
        if (sig !== _lastStatusSig) {
            _lastStatusSig = sig;
            if (inGameState) {
                statusText.textContent = 'IN GAME';
                statusText.style.color = 'var(--color-cyan)';
            } else if (isUpdating) {
                statusText.textContent = 'UPDATING...';
                statusText.style.color = 'var(--color-yellow)';
            } else if (anyCheckInProgress) {
                statusText.textContent = 'CHECKING...';
                statusText.style.color = 'var(--color-purple, #a78bfa)';
            } else {
                statusText.textContent = 'READY TO PLAY';
                statusText.style.color = 'var(--color-orange)';
            }
        }

        if (selectGameBtn2 && fixCaBtn2) {
            if (currentStatus.gamePath) {
                selectGameBtn2.classList.add('hidden');
                fixCaBtn2.classList.add('full-grid-width');
            } else {
                selectGameBtn2.classList.remove('hidden');
                fixCaBtn2.classList.remove('full-grid-width');
            }
        }
    }

    // Dynamic polling: Fast when active, slower when idle (fewer GC pauses + less CPU -> less RAM)
    const INTERVALS = {
        IDLE:   { status: 1600, logs: 6000, hosts: 45000 },
        ACTIVE: { status: 900,  logs: 3200, hosts: 30000 }
    };
    function _isActiveState() {
        return currentStatus.isRunning || launchPending || _isUpdating || _appUpdating;
    }
    function _restartPolling() {
        if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
        if (logsInterval)   { clearInterval(logsInterval);   logsInterval   = null; }
        if (hostsInterval)  { clearInterval(hostsInterval);  hostsInterval  = null; }
        const p = _isActiveState() ? INTERVALS.ACTIVE : INTERVALS.IDLE;
        statusInterval = setInterval(() => fetchStatus(true), p.status);
        logsInterval   = setInterval(fetchLogs,   p.logs);
        hostsInterval  = setInterval(refreshHostsStatus, p.hosts);
    }

    // --- Core Functions ---

    async function refreshHostsStatus() {
        if (!hostsStatusText) return;
        try {
            const res = await fetch('/api/hosts-status');
            if (!res.ok) throw new Error('status fail');
            const data = await res.json();
            if (data.allOk) {
                const ok = `Hosts: OK (${data.entries.filter(e=>e.present).length}/${data.entries.length})`;
                if (hostsStatusText.textContent !== ok) hostsStatusText.textContent = ok;
                if (hostsStatusText.className !== 'hosts-status status-ok') hostsStatusText.className = 'hosts-status status-ok';
            } else {
                const missing = data.entries.filter(e => !e.present).map(e => e.domain).join(', ');
                const t = `Hosts: Missing ${missing}`;
                if (hostsStatusText.textContent !== t) hostsStatusText.textContent = t;
                if (hostsStatusText.className !== 'hosts-status status-fail') hostsStatusText.className = 'hosts-status status-fail';
            }
        } catch (e) {
            if (hostsStatusText.textContent !== 'Hosts: Unavailable') hostsStatusText.textContent = 'Hosts: Unavailable';
            if (hostsStatusText.className !== 'hosts-status status-warn') hostsStatusText.className = 'hosts-status status-warn';
        }
    }

    let _autoRepairInFlight = false;
    async function fetchStatus(quick) {
        const isQuick = quick !== false;
        const mySeq = ++_statusFetchSeq;
        const destructiveAllowed = !_saveConfirmInProgress && !(Date.now() < _postSaveWindowMs);
        try {
            const res = await fetch(isQuick ? '/api/status?quick=1' : '/api/status');
            if (!res.ok) throw new Error(`Server status failed: ${res.status}`);
            
            const data = await res.json();
            const wasActive = _isActiveState();
            const incomingGamePathRaw = (data && (data.gamePath === null || data.gamePath === undefined)) ? '' : String(data ? data.gamePath || '' : '');

            if (destructiveAllowed && mySeq >= _lastAppliedStatusSeq) {
                _lastAppliedStatusSeq = mySeq;
                if (data && typeof data === 'object') {
                    if (_committedGamePath && !incomingGamePathRaw) {
                        console.log(`[fetchStatus] Incoming status has empty gamePath but committed exists; MERGE mode. seq=${mySeq}. committed=${_committedGamePath}`);
                        Object.assign(currentStatus, data);
                    } else {
                        for (const key of Object.keys(currentStatus)) {
                            try { delete currentStatus[key]; } catch (_) {}
                        }
                        for (const [k, v] of Object.entries(data)) {
                            if (k === 'gamePath') {
                                currentStatus.gamePath = v;
                            } else {
                                try { currentStatus[k] = v; } catch (_) {}
                            }
                        }
                    }
                } else {
                    console.log(`[fetchStatus] data was not an object; seq=${mySeq}. Skipping destructive replace.`);
                }
            } else if (mySeq >= _lastAppliedStatusSeq) {
                Object.assign(currentStatus, data);
            } else {
                console.log(`[fetchStatus] Stale response seq=${mySeq}, lastApplied=${_lastAppliedStatusSeq}, destructiveAllowed=${destructiveAllowed} — skipped to avoid setup bounce.`);
                return;
            }

            if (!data.isRunning && launchPending && !launchCooldown) {
                launchPending = false;
            }

            // === Display Data Path: ALWAYS update (never leave "Loading...") ===
            if (dataPathText) {
                const displayPath = incomingGamePathRaw || _committedGamePath || (currentStatus && currentStatus.gamePath) || '';
                if (displayPath) {
                    const label = incomingGamePathRaw ? `Data: ${displayPath}`
                        : _committedGamePath ? `Data (cached): ${displayPath}`
                        : `Data: ${displayPath}`;
                    if (dataPathText.textContent !== label) dataPathText.textContent = label;
                } else {
                    if (dataPathText.textContent !== 'Data: Not set') dataPathText.textContent = 'Data: Not set';
                }
            }

            // === Auto-repair backend DB: if committed exists but backend has empty gamePath ===
            if (!incomingGamePathRaw && _committedGamePath && !_autoRepairInFlight) {
                _autoRepairInFlight = true;
                console.log(`[fetchStatus] AUTO-REPAIR: backend missing game_path, will re-POST /api/configure with committed=${_committedGamePath}`);
                (async () => {
                    try {
                        const rp = await fetch('/api/configure', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ gamePath: _committedGamePath })
                        });
                        if (rp.ok) {
                            const rj = await rp.json().catch(() => ({}));
                            console.log(`[fetchStatus] AUTO-REPAIR success. Payload:`, rj);
                            if (rj && rj.gamePath) {
                                currentStatus.gamePath = rj.gamePath;
                            }
                            // After repair, also trigger auto-update (game path is now available on server)
                            try {
                                if (typeof updateLabel !== 'undefined' && updateLabel && updateLabel.textContent && updateLabel.textContent.startsWith('Update failed: Game path not set')) {
                                    updateLabel.textContent = 'Checking for game updates...';
                                    if (progressFill) progressFill.style.width = '0%';
                                }
                                setTimeout(() => {
                                    if (typeof checkAutoUpdate === 'function' && !_isUpdating) {
                                        checkAutoUpdate().catch((e) => console.warn('[Auto-Repair] checkAutoUpdate threw:', e.message || e));
                                    }
                                }, 700);
                            } catch (schedErr) {
                                console.warn('[Auto-Repair] Failed to schedule post-repair update check:', schedErr.message || schedErr);
                            }
                        } else {
                            const rj = await rp.json().catch(() => ({}));
                            console.warn(`[fetchStatus] AUTO-REPAIR failed HTTP ${rp.status}:`, rj && rj.error ? rj.error : rj);
                        }
                    } catch (e) {
                        console.warn(`[fetchStatus] AUTO-REPAIR exception:`, e.message || e);
                    } finally {
                        setTimeout(() => { _autoRepairInFlight = false; }, 1500);
                    }
                })();
            }

            if (serverStatusText) {
                if (data.serverOnline) {
                    if (serverStatusText.textContent !== 'Server Online') serverStatusText.textContent = 'Server Online';
                    if (serverStatusText.className !== 'server-status-text online-text') serverStatusText.className = 'server-status-text online-text';
                } else {
                    if (serverStatusText.textContent !== 'Server Offline') serverStatusText.textContent = 'Server Offline';
                    if (serverStatusText.className !== 'server-status-text offline-text') serverStatusText.className = 'server-status-text offline-text';
                }
            }

            if (serverUrlInput && data.customTargetHost) {
                if (serverUrlInput.value !== data.customTargetHost) serverUrlInput.value = data.customTargetHost;
            }

            updateUI();

            if (wasActive !== _isActiveState()) _restartPolling();
        } catch (err) {
            console.error('Failed to fetch status:', err);
            if (statusText && !statusText.textContent.startsWith('ERROR:')) statusText.textContent = `ERROR: ${err.message}`;
        }
    }

    async function fetchLogs() {
        try {
            const res = await fetch('/api/logs');
            const data = await res.json();
            if (!data.logs || !logsContainer) return;

            // Trim to last MAX_DISPLAY_LOGS for DOM node count cap
            const logs = data.logs.length > MAX_DISPLAY_LOGS
                ? data.logs.slice(data.logs.length - MAX_DISPLAY_LOGS)
                : data.logs;

            // Signature check: skip full re-render if logs unchanged (saves innerHTML alloc + GC)
            const sig = logs.length + '|' + logs[logs.length - 1];
            if (sig === _lastLogsSig) return;
            _lastLogsSig = sig;

            const isAtBottom = logsContainer.scrollHeight - logsContainer.scrollTop <= logsContainer.clientHeight + 50;

            // Single-pass build, no per-item array allocation
            let html = '';
            for (let i = 0; i < logs.length; i++) {
                const log = logs[i];
                let cls = 'log-entry';
                if (log.indexOf('[SYSTEM]') !== -1) cls += ' system';
                else if (log.indexOf('[ERROR]') !== -1 || log.indexOf('failed') !== -1) cls += ' danger';
                html += '<div class="';
                html += cls;
                html += '">';
                html += log;
                html += '</div>';
            }
            logsContainer.innerHTML = html;

            if (isAtBottom) logsContainer.scrollTop = logsContainer.scrollHeight;
        } catch (err) {
            console.error('Failed to fetch logs:', err);
        }
    }

    function showSection(section) {
        if (!section) return;
        // Only toggle setupSection and launcherSection for now
        [setupSection, launcherSection].forEach(s => {
            if (s) s.classList.add('hidden');
        });
        section.classList.remove('hidden');
    }

    // --- Update Logic (FULL AUTO — no user confirmation needed) ---

    async function checkAutoUpdate() {
        if (_isUpdating) return;
        if (checkAutoUpdate._running) return;
        checkAutoUpdate._running = true;
        updateUI();
        console.log("[SYSTEM] Auto-update check initiated...");
        try {
            const res = await fetch('/api/check-update');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            console.log('[SYSTEM] Update check result:', data);

            // 1) GAME Patch Update — HIGH PRIORITY (auto-download & extract immediately)
            const gameData = (data.game && data.game.update) ? data.game
                : (data.update ? { version: data.version, description: data.description, downloadUrl: data.downloadUrl }
                : null);
            if (gameData && gameData.downloadUrl) {
                showNotification(`Game Patch v${gameData.version} found! Downloading automatically...`, 'success');
                await startUpdate(gameData.downloadUrl);
                return;
            }

            // 2) LAUNCHER App Update — auto download & run installer via IPC
            if (data.app && data.app.update && data.app.appDownloadUrl) {
                if (ipcRenderer) {
                    showNotification(`Launcher v${data.app.appVersion} found! Installing automatically...`, 'success');
                    _appUpdating = true;
                    updateUI();
                    ipcRenderer.send('auto-install-app-update', {
                        downloadUrl: data.app.appDownloadUrl,
                        version: data.app.appVersion,
                        description: data.app.appDescription || ''
                    });
                } else {
                    // Non-Electron fallback: open link
                    if (data.app.appDownloadUrl) window.open(data.app.appDownloadUrl, '_blank');
                }
            }
        } catch (err) {
            console.error('[ERROR] Auto-update check failed:', err);
            const isPathNotSet = /game path not set/i.test((err && err.message) || '');
            if (!isPathNotSet) showNotification('Auto-update check failed: ' + err.message, 'error');
        } finally {
            checkAutoUpdate._running = false;
            updateUI();
        }
    }

    function showUpdateModal(title, message, details, onConfirm) {
        updateModalTitle.textContent = title;
        updateModalMessage.textContent = message;
        updateModalDetails.textContent = details || '';
        updateModal.classList.remove('hidden');

        // Setup Buttons
        const confirmBtn = confirmUpdateBtn.cloneNode(true);
        confirmUpdateBtn.parentNode.replaceChild(confirmBtn, confirmUpdateBtn);
        
        confirmBtn.addEventListener('click', () => {
            updateModal.classList.add('hidden');
            onConfirm();
        });

        cancelUpdateBtn.onclick = () => updateModal.classList.add('hidden');
    }

    async function startUpdate(downloadUrl) {
        if (!updateLabel || !progressFill) return;
        if (_isUpdating) return;
        _isUpdating = true;
        updateUI();

        updateLabel.classList.remove('hidden');
        updateLabel.textContent = 'Preparing auto-update...';
        progressFill.style.width = '0%';
        playBtn.disabled = true;

        let progressPoll = null;
        let abortController = null;
        try {
            showNotification('Starting auto-update download...', 'success');

            abortController = new AbortController();
            const fetchTimeoutMs = 30 * 60 * 1000;
            const timeoutId = setTimeout(() => abortController && abortController.abort(new Error('Update request timeout (exceeded 30 minutes).')), fetchTimeoutMs);

            const reqPromise = fetch('/api/start-update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ downloadUrl }),
                signal: abortController.signal
            });

            progressPoll = setInterval(async () => {
                try {
                    const pr = await fetch('/api/update-progress');
                    if (pr.ok) {
                        const p = await pr.json();
                        progressFill.style.width = `${Math.min(100, Math.max(0, p.percent || 0))}%`;
                        if (p.error) {
                            updateLabel.textContent = `Update failed: ${p.error}`;
                            showNotification(`Update failed: ${p.error}`, 'error');
                            if (progressPoll) { clearInterval(progressPoll); progressPoll = null; }
                            if (abortController) abortController.abort(new Error(p.error));
                            return;
                        }
                        if (p.status) {
                            updateLabel.textContent = `${p.status}${(p.percent > 0 && p.percent < 100) ? ` (${Math.round(p.percent)}%)` : ''}`;
                        }
                    }
                } catch (_) {}
            }, 300);

            const res = await reqPromise;
            clearTimeout(timeoutId);
            clearInterval(progressPoll); progressPoll = null;

            try {
                const pr = await fetch('/api/update-progress');
                if (pr.ok) {
                    const p = await pr.json();
                    progressFill.style.width = `${Math.min(100, Math.max(0, p.percent || 0))}%`;
                    if (p.error) throw new Error(p.error);
                    if (p.status) updateLabel.textContent = p.status;
                }
            } catch (_) {}

            const result = await res.json().catch(() => ({}));
            if (res.ok && result.success) {
                progressFill.style.width = '100%';
                updateLabel.textContent = 'Game patch installed! Ready to play.';
                showNotification('Game auto-update complete!');
                setTimeout(() => {
                    updateLabel.classList.add('hidden');
                    progressFill.style.width = '0%';
                }, 8000);
            } else {
                throw new Error(result.error || `Server returned ${res.status}`);
            }
        } catch (err) {
            if (progressPoll) { clearInterval(progressPoll); progressPoll = null; }
            let errorMsg = err.message;
            if (err.name === 'AbortError' && !err.message) errorMsg = 'Update request was cancelled or timed out.';
            const isPathNotSet = /game path not set/i.test(errorMsg || '');
            updateLabel.textContent = `Update failed: ${errorMsg}`;
            if (!isPathNotSet) showNotification(`Update failed: ${errorMsg}`, 'error');
        } finally {
            if (abortController) { try { abortController.abort(); } catch (_) {} }
            playBtn.disabled = false;
            _isUpdating = false;
            updateUI();
        }
    }

    // --- Notifications ---
    function showNotification(message, type = 'success') {
        if (notificationContainer && notificationContainer.children.length >= MAX_NOTIFICATIONS) {
            const first = notificationContainer.firstElementChild;
            if (first) {
                first.classList.replace('show', 'hide');
                setTimeout(() => first.remove(), 250);
            }
        }

        const notification = document.createElement('div');
        notification.className = `notification ${type}`;

        const icon = type === 'success' ? '✓' : '!';
        notification.innerHTML =
            '<div class="notification-icon">' + icon + '</div>' +
            '<div class="notification-message">' + message + '</div>';

        notificationContainer.appendChild(notification);

        setTimeout(() => notification.classList.add('show'), 100);

        setTimeout(() => {
            notification.classList.replace('show', 'hide');
            setTimeout(() => { if (notification.parentNode) notification.remove(); }, 500);
        }, 4000);
    }

    // --- Interaction Logic ---

    let ipcRenderer;
    try { ipcRenderer = require('electron').ipcRenderer; } catch (e) {}

    // Discord Auth
    if (discordLoginBtn) {
        discordLoginBtn.addEventListener('click', () => {
            if (ipcRenderer) {
                ipcRenderer.send('start-discord-login');
                discordLoginBtn.classList.add('hidden');
                authStatusText.textContent = 'Opening Discord...';
                authStatusText.style.color = 'var(--text-dim)';
            }
        });
    }

    if (authRetryBtn) {
        authRetryBtn.addEventListener('click', () => {
            authErrorMsg.classList.add('hidden');
            authRetryBtn.classList.add('hidden');
            discordLoginBtn.classList.remove('hidden');
            authUserInfo.classList.add('hidden');
        });
    }

    const handleFileSelect = async () => {
        if (ipcRenderer) {
            const path = await ipcRenderer.invoke('select-game-file');
            if (path) {
                _applySelectedGamePath(path, false);
            }
        } else {
            gamePathFile.click();
        }
    };

    function _applySelectedGamePath(path, isAutoFound) {
        if (!path) return;
        pendingGamePath = path;
        try { localStorage.setItem('_pending_game_path', path); } catch (_) {}
        if (selectedPathDisplay) {
            selectedPathDisplay.textContent = path;
            selectedPathDisplay.style.borderColor = isAutoFound ? 'rgba(16, 185, 129, 0.55)' : '';
            selectedPathDisplay.dataset.validPath = '1';
        }
        if (saveConfigBtn) saveConfigBtn.dataset.pendingPath = path;
        if (pathMatchHint) {
            pathMatchHint.classList.remove('hidden', 'found-hint', 'error-hint');
            if (isAutoFound) {
                pathMatchHint.classList.add('found-hint');
                pathMatchHint.textContent = 'Auto-detected. If this is correct, just press SAVE CONFIG below.';
            } else {
                pathMatchHint.classList.add('found-hint');
                pathMatchHint.textContent = 'Manual selection confirmed. Press SAVE CONFIG to continue.';
            }
        }
    }

    function _resolvePendingPath() {
        if (pendingGamePath) return pendingGamePath;
        try {
            const fromLs = localStorage.getItem('_pending_game_path');
            if (fromLs && /\.exe$/i.test(fromLs) && fromLs.length > 6) return fromLs;
        } catch (_) {}
        if (saveConfigBtn && saveConfigBtn.dataset && saveConfigBtn.dataset.pendingPath) {
            const p = saveConfigBtn.dataset.pendingPath;
            if (p && /\.exe$/i.test(p) && p.length > 6) return p;
        }
        if (selectedPathDisplay) {
            const t = (selectedPathDisplay.textContent || '').trim();
            if (t && t !== 'No file selected' && t !== 'Select HSHO.exe to continue' && /\.exe$/i.test(t) && t.length > 6) return t;
        }
        return '';
    }

    function _setAutoSearchStatus(type, message) {
        if (!autoSearchStatus) return;
        autoSearchStatus.classList.remove('hidden', 'searching-status', 'found-status', 'notfound-status');
        if (type === 'searching') {
            autoSearchStatus.classList.add('searching-status');
            _emitSearchToast('searching', message || 'Scanning all drives for HSHO.exe...');
        } else if (type === 'found') {
            autoSearchStatus.classList.add('found-status');
            _emitSearchToast('found', message || 'Found HSHO.exe. Auto-filled path below.');
        } else if (type === 'notfound') {
            autoSearchStatus.classList.add('notfound-status');
            _emitSearchToast('notfound', message || 'Could not find HSHO.exe automatically. Use Browse File.');
        }
        if (searchStatusText) searchStatusText.textContent = message || '';
    }

    let _autoSearchPollTimer = null;
    function _stopAutoSearchPoll() {
        if (_autoSearchPollTimer) {
            clearInterval(_autoSearchPollTimer);
            _autoSearchPollTimer = null;
            updateUI();
        }
    }

    async function _runAutoSearch(force) {
        if (!setupSection) return;
        _stopAutoSearchPoll();
        if (force) _lastSearchToastKind = '';
        _setAutoSearchStatus('searching', 'Starting deep scan: registry, shortcuts, libraries & all drives for HSHO.exe...');
        if (autoSearchAgainBtn) autoSearchAgainBtn.classList.add('hidden');
        if (pathMatchHint) pathMatchHint.classList.add('hidden');
        try {
            const initial = await fetch(`/api/auto-search-game${force ? '?force=1' : ''}`);
            if (!initial.ok) throw new Error(`Server responded ${initial.status}`);
            let data = await initial.json().catch(() => ({}));
            if (data.searching === false && data.path && pendingGamePath !== data.path) {
                _applySelectedGamePath(data.path, true);
            }
            if (data.message) {
                _setAutoSearchStatus(
                    data.found ? 'found' : (data.searching ? 'searching' : 'notfound'),
                    data.message
                );
            } else {
                _setAutoSearchStatus(data.searching ? 'searching' : (data.found ? 'found' : 'notfound'), '');
            }
            if (data.searching === true || (data.found === false && !data.message)) {
                let attempts = 0;
                const maxAttempts = 130;
                let lastKind = '';
                let lastMsg = '';
                _autoSearchPollTimer = setInterval(async () => {
                    attempts++;
                    try {
                        const r = await fetch('/api/auto-search-game');
                        if (!r.ok) throw new Error(`Server ${r.status}`);
                        const d = await r.json().catch(() => ({}));
                        const curKind = d.found ? 'found' : (d.searching ? 'searching' : 'notfound');
                        const curMsg = d.message || '';
                        if (d.message) {
                            _setAutoSearchStatus(curKind, d.message);
                        } else {
                            _setAutoSearchStatus(curKind, '');
                        }
                        if (d.found && d.path && pendingGamePath !== d.path) {
                            _applySelectedGamePath(d.path, true);
                        }
                        lastKind = curKind;
                        lastMsg = curMsg;
                        if (d.searching === false || attempts >= maxAttempts) {
                            _stopAutoSearchPoll();
                            if (autoSearchAgainBtn) autoSearchAgainBtn.classList.remove('hidden');
                            if (attempts >= maxAttempts && !d.found) {
                                _setAutoSearchStatus('notfound', 'Deep scan reached time limit. Use Browse File to select manually, or click RE-SCAN to try again.');
                            }
                        }
                    } catch (_) {
                        if (attempts >= 45) {
                            _stopAutoSearchPoll();
                            if (autoSearchAgainBtn) autoSearchAgainBtn.classList.remove('hidden');
                            _setAutoSearchStatus('notfound', 'Could not communicate with auto search service. Use Browse File.');
                        }
                    }
                }, 900);
                updateUI();
            } else {
                if (autoSearchAgainBtn) autoSearchAgainBtn.classList.remove('hidden');
            }
        } catch (err) {
            console.error('[Auto Search] Failed:', err);
            _setAutoSearchStatus('notfound', 'Auto search failed: ' + (err.message || 'Unknown error. Please use Browse File.'));
            if (autoSearchAgainBtn) autoSearchAgainBtn.classList.remove('hidden');
        }
    }

    if (autoSearchAgainBtn) autoSearchAgainBtn.addEventListener('click', () => _runAutoSearch(true));
    if (selectGameBtn) selectGameBtn.addEventListener('click', handleFileSelect);
    if (setupSelectBtn) setupSelectBtn.addEventListener('click', handleFileSelect);

    gamePathFile.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            const file = e.target.files[0];
            const path = file.path || file.name;
            _applySelectedGamePath(path, false);
        }
    });

    saveConfigBtn.addEventListener('click', async () => {
        try {
            if (typeof updateLabel !== 'undefined' && updateLabel && updateLabel.textContent && updateLabel.textContent.startsWith('Update failed: Game path not set')) {
                if (progressFill) progressFill.style.width = '0%';
                updateLabel.textContent = '';
            }
        } catch (_) {}
        const resolved = _resolvePendingPath();
        if (!resolved) return alert('Please select HSHO.exe first.');
        if (!pendingGamePath) pendingGamePath = resolved;
        const committed = pendingGamePath;
        saveConfigBtn.disabled = true;
        saveConfigBtn.textContent = 'INITIALIZING...';

        try {
            _saveConfirmInProgress = true;
            _postSaveWindowMs = Date.now() + 5000;
            updateUI();

            const res = await fetch('/api/configure', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ gamePath: pendingGamePath || undefined })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `Save failed (${res.status})`);
            }
            const configureOk = await res.json().catch(() => ({ success: true }));
            if (configureOk && configureOk.success !== true && Object.keys(configureOk).length > 0) {
            }

            pendingGamePath = '';
            try { localStorage.removeItem('_pending_game_path'); } catch (_) {}
            if (saveConfigBtn && saveConfigBtn.dataset) delete saveConfigBtn.dataset.pendingPath;
            if (selectedPathDisplay) {
                delete selectedPathDisplay.dataset.validPath;
            }
            _stopAutoSearchPoll();

            // === CRITICAL COMMIT: Install permanent anti-bounce protection NOW (before navigate) ===
            _committedGamePath = committed;
            try { localStorage.setItem(_STORE_COMMITTED_KEY, committed); } catch (_) {}
            console.log(`[Save Config] COMMITTED path forever: ${committed}`);

            currentStatus = Object.assign({}, currentStatus, { gamePath: committed, isInstalled: true });
            // Restore the setter guard (the line above did `Object.assign({}, currentStatus, ...)`
            // which created a plain object, losing the setter guard).
            try {
                let _gpValue = currentStatus.gamePath;
                Object.defineProperty(currentStatus, 'gamePath', {
                    configurable: true, enumerable: true,
                    get() { return _gpValue; },
                    set(newVal) {
                        const normalized = (newVal === null || newVal === undefined) ? '' : String(newVal);
                        if (_committedGamePath && !normalized) {
                            console.warn('[currentStatus.gamePath setter] BLOCKED attempt to clear committed path. Stack:');
                            try { console.warn(new Error().stack); } catch (_) {}
                            _gpValue = _committedGamePath;
                            return;
                        }
                        _gpValue = normalized;
                    }
                });
            } catch (e) { console.log('[Save Config] Re-install setter guard failed (non-fatal):', e.message); }

            const saveSeq = ++_statusFetchSeq;
            _lastAppliedStatusSeq = saveSeq;

            showSection(launcherSection);
            if (autoSearchStatus) autoSearchStatus.classList.add('hidden');
            if (pathMatchHint) pathMatchHint.classList.add('hidden');
            showNotification('Configuration saved successfully!');

            let confirmed = false;
            for (let attempt = 0; attempt < 8; attempt++) {
                try {
                    const q = await fetch('/api/status?quick=1');
                    if (q.ok) {
                        const d = await q.json().catch(() => ({}));
                        if (d) Object.assign(currentStatus, d);
                        if (currentStatus.gamePath && String(currentStatus.gamePath).length > 0) confirmed = true;
                    }
                } catch (e) {
                    console.log('[Save Confirm] quick poll err:', e.message || e);
                }
                updateUI();
                if (confirmed) break;
                await new Promise(r => setTimeout(r, attempt < 3 ? 250 : 450));
            }
            if (!confirmed) {
                console.log('[Save Confirm] 8 quick polls did not confirm gamePath — performing safe merge fallback.');
                try {
                    const q = await fetch('/api/status?quick=1');
                    if (q.ok) {
                        const d = await q.json().catch(() => ({}));
                        if (d) Object.assign(currentStatus, d);
                    }
                } catch (e) {
                    console.log('[Save Confirm] fallback quick poll err:', e.message || e);
                }
                if (!currentStatus.gamePath) {
                    currentStatus.gamePath = committed;
                    currentStatus.isInstalled = true;
                }
                updateUI();
            } else {
                console.log(`[Save Confirm] Confirmed successfully. isInstalled=${currentStatus.isInstalled}, gamePath=${currentStatus.gamePath}`);
            }
            _restartPolling();

            // === Auto-trigger patch update immediately after save — no need to restart launcher ===
            try {
                if (typeof updateLabel !== 'undefined' && updateLabel) {
                    updateLabel.textContent = 'Checking for game updates...';
                    updateLabel.classList.remove('hidden');
                }
                if (progressFill) progressFill.style.width = '0%';
                console.log('[Save Config] Auto triggering checkAutoUpdate in 600ms...');
                setTimeout(() => {
                    if (typeof checkAutoUpdate === 'function') {
                        checkAutoUpdate().catch((e) => console.warn('[Save Config] checkAutoUpdate threw:', e.message || e));
                    } else {
                        console.warn('[Save Config] checkAutoUpdate function not available — skipping auto update trigger.');
                    }
                }, 600);
            } catch (e) {
                console.warn('[Save Config] Failed to schedule checkAutoUpdate:', e.message || e);
            }
        } catch (err) {
            alert('Failed to save configuration: ' + err.message);
            showSection(setupSection);
        } finally {
            _saveConfirmInProgress = false;
            setTimeout(() => { _postSaveWindowMs = 0; }, 3000);
            saveConfigBtn.disabled = false;
            saveConfigBtn.textContent = 'SAVE CONFIG';
            updateUI();
        }
    });

    playBtn.addEventListener('click', async () => {
        if (_isUpdating || _appUpdating) {
            showNotification('Cannot start game while updating. Please wait...', 'error');
            return;
        }
        playBtn.disabled = true;
        const originalText = playBtn.textContent;
        playBtn.textContent = 'STARTING...';
        
        try {
            const res = await fetch('/api/launch', { method: 'POST' });
            const data = await res.json();
            if (data.error) {
                alert(data.error);
            } else {
                launchPending = true;
                launchCooldown = true; // ล็อคป้องกันหน้าต่างรีเซ็ต
                
                // ให้เวลาเกมรัน 15 วินาที ก่อนที่ตัวเช็คสถานะจะทำงานปกติตามจริง
                setTimeout(() => {
                    launchCooldown = false;
                }, 15000);

                updateUI();
                showNotification('Game starting... Optimize Mode activated!');
            }
            fetchStatus(false);
        } catch (err) {
            alert('Launch failed');
        } finally {
            playBtn.textContent = originalText;
            if (!(_isUpdating || _appUpdating || currentStatus.isRunning || launchPending)) {
                playBtn.disabled = false;
            }
        }
    });

    async function stopGame(btn) {
        launchPending = false;
        launchCooldown = false; // ปลดล็อคเมื่อตั้งใจกดหยุดเกม
        updateUI();
        if (btn) btn.disabled = true;
        if (stopBtn) stopBtn.disabled = true;

        try {
            // 1. Force kill via IPC (taskkill /F /T)
            if (ipcRenderer) {
                ipcRenderer.send('force-kill-game', 'HSHO.exe');
                // Listen for result once
                ipcRenderer.once('force-kill-result', (e, result) => {
                    if (result.success) {
                        console.log('[Stop] Game force-killed via taskkill');
                    } else {
                        console.warn('[Stop] taskkill failed:', result.error);
                    }
                    // Always call /api/stop after to sync server state
                    fetch('/api/stop', { method: 'POST' }).catch(() => {});
                    setTimeout(() => fetchStatus(false), 500);
                });
            } else {
                // Fallback: server-side stop only
                await fetch('/api/stop', { method: 'POST' });
                fetchStatus(false);
            }
        } catch (err) {
            console.error('Stop failed:', err);
        } finally {
            setTimeout(() => {
                if (btn) btn.disabled = false;
                if (stopBtn) stopBtn.disabled = false;
            }, 1000);
        }
    }

    if (stopBtn) stopBtn.addEventListener('click', () => stopGame(stopBtn));

    // Optimize overlay Stop button
    const optimizeStopBtn = document.getElementById('optimize-stop-btn');
    if (optimizeStopBtn) {
        optimizeStopBtn.addEventListener('click', () => stopGame(optimizeStopBtn));
    }

    // Modal Handlers
    fixCaBtn.addEventListener('click', () => fixModal.classList.remove('hidden'));
    cancelFixBtn.addEventListener('click', () => fixModal.classList.add('hidden'));
    confirmFixBtn.addEventListener('click', async () => {
        confirmFixBtn.disabled = true;
        confirmFixBtn.textContent = 'FIXING...';
        try {
            await fetch('/api/fix-all', { method: 'POST' });
            fixModal.classList.add('hidden');
            await refreshHostsStatus();
            alert('System repair completed!');
        } catch (err) {
            alert('Repair failed: ' + err.message);
        } finally {
            confirmFixBtn.disabled = false;
            confirmFixBtn.textContent = 'START REPAIR';
        }
    });

    // Apply Hosts button handler
    if (applyHostsBtn) {
        applyHostsBtn.addEventListener('click', async () => {
            applyHostsBtn.disabled = true;
            const originalText = applyHostsBtn.textContent;
            applyHostsBtn.textContent = 'APPLYING...';
            try {
                const res = await fetch('/api/apply-hosts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enable: true })
                });
                const data = await res.json();
                if (!res.ok) {
                    const msg = data.permission
                        ? 'Permission Denied! Please run Launcher as ADMINISTRATOR'
                        : (data.error || 'Apply failed');
                    alert(msg);
                    showNotification(msg, 'error');
                } else {
                    const count = data.entries ? data.entries.filter(e => e.present).length : 0;
                    const total = data.entries ? data.entries.length : 0;
                    showNotification(`Hosts applied! ${count}/${total} entries OK`);
                }
                await refreshHostsStatus();
            } catch (err) {
                alert('Apply Hosts failed: ' + err.message);
            } finally {
                applyHostsBtn.disabled = false;
                applyHostsBtn.textContent = originalText;
            }
        });
    }

    changeSettingsBtn.addEventListener('click', async () => {
        if (confirm('Reset all settings and re-configure game path?')) {
            _committedGamePath = '';
            try { localStorage.removeItem(_STORE_COMMITTED_KEY); } catch (_) {}
            await fetch('/api/reset', { method: 'POST' });
            pendingGamePath = '';
            try { localStorage.removeItem('_pending_game_path'); } catch (_) {}
            if (saveConfigBtn && saveConfigBtn.dataset) delete saveConfigBtn.dataset.pendingPath;
            _autoSearchStarted = false;
            _stopAutoSearchPoll();
            if (selectedPathDisplay) {
                selectedPathDisplay.textContent = 'No file selected';
                selectedPathDisplay.style.borderColor = '';
                delete selectedPathDisplay.dataset.validPath;
            }
            if (pathMatchHint) pathMatchHint.classList.add('hidden');
            fetchStatus(false);
        }
    });

    // Window Controls
    const minimizeBtn = document.getElementById('minimize-btn');
    const closeBtn = document.getElementById('close-btn');

    if (minimizeBtn) {
        minimizeBtn.addEventListener('click', () => {
            if (ipcRenderer) ipcRenderer.send('minimize-app');
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            if (ipcRenderer) {
                ipcRenderer.send('close-app');
            } else {
                window.close();
            }
        });
    }

    // Handle App Updates from IPC
    if (ipcRenderer) {
        ipcRenderer.on('discord-user-info', (event, user) => {
            currentUserId = user.id; 
            authUserInfo.classList.remove('hidden');
            discordLoginBtn.classList.add('hidden'); 
            discordAvatar.src = user.avatar;
            discordName.textContent = user.username;
            authStatusText.textContent = 'Verifying access...';
            authStatusText.style.color = 'var(--color-orange)';
        });

        ipcRenderer.on('auth-success', () => {
            if (window.__malakorAuthAlreadyInit === true) {
                console.log('[auth-success] Already initialized — skipping duplicate polling start.');
                return;
            }
            window.__malakorAuthAlreadyInit = true;
            authStatusText.textContent = 'Access Granted!';
            authStatusText.style.color = 'var(--color-green)';
            
            setTimeout(() => {
                authSection.classList.add('hidden');
                if (optimizeOverlay) optimizeOverlay.classList.add('hidden');
                playBtn.disabled = false;
                _lastStatusSig = '';
                fetchStatus(false);
                fetchLogs();
                refreshHostsStatus();
                setTimeout(checkAutoUpdate, 1500);
                _restartPolling();

                authInterval = setInterval(async () => {
                    try {
                        const res = await fetch(`/api/verify-access?id=${currentUserId}`);
                        const data = await res.json();
                        if (data.allowed === false) {
                            alert("Your access has been revoked. The application will now close.");
                            ipcRenderer.send('close-app');
                        }
                    } catch (e) {}
                }, 60000);

                showNotification(`Welcome back, ${discordName.textContent}!`);
            }, 1500);
        });

        ipcRenderer.on('auth-failed', (event, message) => {
            authStatusText.textContent = 'Access Denied';
            authStatusText.style.color = 'var(--color-red)';
            authErrorMsg.textContent = message;
            authErrorMsg.classList.remove('hidden');
            authRetryBtn.classList.remove('hidden');
        });

        ipcRenderer.on('app-update-available', (event, data) => {
            // FULL AUTO: no modal — just trigger download + install immediately
            console.log('[App Update] Triggering auto-install for v' + data.version);
            _appUpdating = true;
            updateUI();
            ipcRenderer.send('auto-install-app-update', {
                downloadUrl: data.downloadUrl,
                version: data.version,
                description: data.description || ''
            });
        });

        // Show app-installer progress on the main progress bar
        ipcRenderer.on('app-update-progress', (event, p) => {
            if (!updateLabel || !progressFill) return;
            _appUpdating = true;
            updateLabel.classList.remove('hidden');
            const percent = Math.min(100, Math.max(0, p.percent || 0));
            progressFill.style.width = `${percent}%`;
            updateLabel.textContent = `LAUNCHER UPDATE: ${p.message || ''}${percent > 0 && percent < 100 ? ` (${Math.round(percent)}%)` : ''}`;
            playBtn.disabled = true;
            updateUI();
            if (percent >= 100) {
                setTimeout(() => {
                    updateLabel.textContent = 'Launched installer — Launcher will restart soon.';
                }, 800);
            }
        });

        ipcRenderer.on('app-update-error', (event, message) => {
            console.error('[App Update] Error:', message);
            _appUpdating = false;
            showNotification('Launcher auto-update failed: ' + message, 'error');
            if (updateLabel) updateLabel.textContent = 'Launcher update failed: ' + message;
            if (progressFill) progressFill.style.width = '0%';
            playBtn.disabled = false;
            updateUI();
        });
    }
});