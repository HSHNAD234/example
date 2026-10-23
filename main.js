const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const path = require('path');
const { exec, execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const http = require('http');
const url = require('url');
const db = require('./database');

// Discord Auth Configuration
const DISCORD_CLIENT_ID = '1432203667829821450'; 
const REDIRECT_URI = 'http://localhost:53134/callback';
const AUTH_JSON_URL = 'https://hshmwhitelist.malakor.online/api/whitelist';

let authServer = null;

// App Update Configuration
const APP_UPDATE_JSON_URL = 'https://api.npoint.io/d2f1a6192837d901e8f9';

// Fix for sandbox: Store user data locally instead of AppData
// NOTE: __dirname points inside app.asar when packaged (read-only archive) —
// Chromium's network service can't create cache/network-context dirs there,
// which silently breaks network requests (OAuth, axios, etc). Use a real
// writable folder next to the exe in production instead.
app.setPath('userData', app.isPackaged
    ? path.join(path.dirname(process.execPath), 'userData')
    : path.join(__dirname, 'userData'));

let _adminCheckResult = null;

function checkIsAdmin() {
    if (process.platform !== 'win32') return true;
    let pass1 = false, pass2 = false, pass3 = false;

    try {
        execSync('net session', { timeout: 3000, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
        pass1 = true;
    } catch (_) { pass1 = false; }

    try {
        const whoami = execSync('whoami /groups /fo list', { timeout: 3000, encoding: 'utf8', windowsHide: true });
        if (whoami) {
            if (whoami.indexOf('S-1-5-32-544') !== -1) {
                const lines = whoami.split(/\r?\n/);
                let inAdminSid = false;
                let hasDenyOrDisabled = false;
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i] || '';
                    if (line.indexOf('S-1-5-32-544') !== -1) inAdminSid = true;
                    if (inAdminSid) {
                        const low = line.toLowerCase();
                        if (low.indexOf('deny') !== -1 || low.indexOf('disabled') !== -1 || low.indexOf('used for deny') !== -1) {
                            hasDenyOrDisabled = true;
                        }
                        if (line.trim() === '') { inAdminSid = false; }
                    }
                }
                pass2 = !hasDenyOrDisabled;
            }
        }
    } catch (_) { pass2 = false; }

    try {
        const sysRoot = process.env.SYSTEMROOT || 'C:\\Windows';
        const sysFolder = path.join(sysRoot, 'System32');
        const testFile = path.join(sysFolder, '__malakor_admin_write_test_' + Date.now() + '.tmp');
        fs.writeFileSync(testFile, 'x');
        fs.unlinkSync(testFile);
        pass3 = true;
    } catch (_) { pass3 = false; }

    _adminCheckResult = pass1 || pass2 || pass3;
    console.log(`[Admin Check] elevated:${pass1} (net session), adminGroup:${pass2} (whoami High IL/SID), systemWrite:${pass3} => ${_adminCheckResult}`);
    return _adminCheckResult;
}

function promptAdminRights() {
    return new Promise((resolve) => {
        try {
            app.focus({ steal: true });
        } catch (_) {}

        const display = (() => {
            try {
                return screen.getPrimaryDisplay().workAreaSize;
            } catch (_) {
                return { width: 1280, height: 720 };
            }
        })();
        const anchorW = 520;
        const anchorH = 260;
        const anchorX = Math.max(0, Math.floor((display.width - anchorW) / 2));
        const anchorY = Math.max(0, Math.floor((display.height - anchorH) / 2));

        const topmostWin = new BrowserWindow({
            width: anchorW, height: anchorH,
            x: anchorX, y: anchorY,
            show: false,
            frame: false,
            transparent: true,
            alwaysOnTop: 'screen-saver',
            skipTaskbar: true,
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            closable: false,
            focusable: true,
            hasShadow: false,
            opacity: 0.0001,
            webPreferences: { nodeIntegration: false, contextIsolation: true }
        });
        topmostWin.setAlwaysOnTop(true, 'screen-saver');
        topmostWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        topmostWin.setMenuBarVisibility(false);
        topmostWin.focus();
        topmostWin.showInactive();

        const exePath = process.execPath;
        const exeName = (path.basename(exePath) || '').toLowerCase();
        const projectDir = __dirname;
        let isDevMode = !app.isPackaged;
        if (exeName === 'electron.exe' || (process.defaultApp === true)) {
            isDevMode = true;
        }

        let runExe, runArgs;
        if (isDevMode) {
            runExe = exePath;
            const appArg = projectDir;
            const rawArgs = process.argv.slice(1);
            let finalArgs = [appArg];
            for (const a of rawArgs) {
                const aLow = (a || '').toLowerCase();
                if (aLow === projectDir.toLowerCase() ||
                    aLow === path.resolve(projectDir).toLowerCase() ||
                    aLow === '.' ||
                    /\\electron[\\/]?$/i.test(a) ||
                    /electron\.exe$/i.test(a)) continue;
                finalArgs.push(a);
            }
            runArgs = finalArgs;
        } else {
            runExe = exePath;
            runArgs = process.argv.slice(1);
        }

        // projectDir (__dirname) points inside app.asar when packaged - not a real
        // directory, so WSH's CurrentDirectory rejects it. Use the exe's real folder instead.
        const cwdForElevate = isDevMode ? projectDir : path.dirname(exePath);

        let relaunchInvoked = false;
        function _invokeRelaunchAsAdmin() {
            if (relaunchInvoked) return true;
            relaunchInvoked = true;

            const quotePwsh = (s) => {
                if (s === null || s === undefined) return "''";
                return "'" + String(s).replace(/'/g, "''") + "'";
            };
            const quoteCmd = (s) => {
                if (s === null || s === undefined) return '""';
                if (/[ \t&|<>^,]/.test(s)) return '"' + String(s).replace(/"/g, '\\"') + '"';
                return String(s);
            };
            let tmpDir;
            try { tmpDir = app.getPath('temp'); } catch (_) { tmpDir = process.env.TEMP || process.env.TMP || projectDir; }
            try { if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}
            const methods = [];

            methods.push({
                name: 'shell-openpath-vbs-runas',
                fn: () => new Promise((res) => {
                    const runArgsStr = runArgs.map(a => {
                        if (/[ "\t]/.test(a)) return '"' + a.replace(/"/g, '""') + '"';
                        return a;
                    }).join(' ');
                    const vbsContent = `Set WshShell = CreateObject("WScript.Shell")\r\n` +
                        `WshShell.CurrentDirectory = "${cwdForElevate.replace(/"/g, '""')}"\r\n` +
                        `Set s = CreateObject("Shell.Application")\r\n` +
                        `s.ShellExecute "${runExe.replace(/"/g, '""')}", "${runArgsStr.replace(/"/g, '""')}", "${cwdForElevate.replace(/"/g, '""')}", "runas", 1\r\n` +
                        `WScript.Quit 0\r\n`;
                    const vbs = path.join(tmpDir, '__malakor_elevate_' + Date.now() + '.vbs');
                    try { fs.writeFileSync(vbs, vbsContent); } catch (_) { return res(false); }
                    let ok = false;
                    try {
                        const { shell } = require('electron');
                        shell.openPath(vbs);
                        ok = true;
                    } catch (e) {
                        console.log('[Relaunch Admin] shell.openPath(vbs) error:', e.message);
                        ok = false;
                    }
                    setTimeout(() => {
                        try { if (fs.existsSync(vbs)) fs.unlinkSync(vbs); } catch (_) {}
                        res(ok);
                    }, 4200);
                })
            });

            methods.push({
                name: 'shell-openpath-cmd-batch',
                fn: () => new Promise((res) => {
                    const argStr = runArgs.map(quoteCmd).join(' ');
                    const batContent = `@echo off\r\n` +
                        `chcp 65001 >nul\r\n` +
                        `cd /d "${projectDir}"\r\n` +
                        `start "" powershell -NoProfile -WindowStyle Normal -Command "Start-Process -FilePath '${runExe.replace(/'/g, "''")}' -ArgumentList '${argStr.replace(/'/g, "''")}' -WorkingDirectory '${projectDir.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Normal"\r\n` +
                        `exit /b 0\r\n`;
                    const bat = path.join(tmpDir, '__malakor_elevate_' + Date.now() + '.cmd');
                    try { fs.writeFileSync(bat, batContent); } catch (_) { return res(false); }
                    let ok = false;
                    try {
                        const { shell } = require('electron');
                        shell.openPath(bat);
                        ok = true;
                    } catch (e) {
                        console.log('[Relaunch Admin] shell.openPath(bat) error:', e.message);
                        ok = false;
                    }
                    setTimeout(() => {
                        try { if (fs.existsSync(bat)) fs.unlinkSync(bat); } catch (_) {}
                        res(ok);
                    }, 4000);
                })
            });

            methods.push({
                name: 'cscript-vbs-shellexecute-runas',
                fn: () => new Promise((res) => {
                    const runArgsStr = runArgs.map(a => {
                        if (/[ "\t]/.test(a)) return '"' + a.replace(/"/g, '""') + '"';
                        return a;
                    }).join(' ');
                    const shellRun = `Set s = CreateObject("Shell.Application")\r\n` +
                        `s.ShellExecute "${runExe.replace(/"/g, '""')}", "${runArgsStr.replace(/"/g, '""')}", "${projectDir.replace(/"/g, '""')}", "runas", 1\r\n` +
                        `WScript.Quit 0\r\n`;
                    const vbs = path.join(tmpDir, '__malakor_elevate_' + Date.now() + '.vbs');
                    try { fs.writeFileSync(vbs, shellRun); } catch (_) { return res(false); }
                    const proc = spawn('cscript.exe', ['//Nologo', vbs], {
                        cwd: projectDir,
                        windowsHide: false,
                        shell: false,
                        detached: true,
                        stdio: ['ignore', 'pipe', 'pipe']
                    });
                    let ok = false;
                    let stdoutBuf = '';
                    let stderrBuf = '';
                    proc.on('error', (e) => { console.log('[Relaunch Admin] cscript spawn error:', e.message); });
                    proc.on('spawn', () => { ok = true; });
                    proc.stdout && proc.stdout.on('data', (d) => { stdoutBuf += String(d || ''); });
                    proc.stderr && proc.stderr.on('data', (d) => { stderrBuf += String(d || ''); });
                    proc.on('close', (code) => {
                        if (stdoutBuf) console.log('[Relaunch Admin] cscript stdout:', stdoutBuf);
                        if (stderrBuf) console.log('[Relaunch Admin] cscript stderr:', stderrBuf);
                    });
                    setTimeout(() => {
                        try { if (fs.existsSync(vbs)) fs.unlinkSync(vbs); } catch (_) {}
                        res(ok);
                    }, 4500);
                    try { proc.unref(); } catch (_) {}
                })
            });

            methods.push({
                name: 'powershell-startprocess-normal-window',
                fn: () => new Promise((res) => {
                    const argListPwsh = runArgs.length > 0
                        ? ' -ArgumentList @(' + runArgs.map(quotePwsh).join(', ') + ')'
                        : '';
                    const psScript = `Start-Process -FilePath ${quotePwsh(runExe)}${argListPwsh} -WorkingDirectory ${quotePwsh(projectDir)} -Verb RunAs -WindowStyle Normal`;
                    const psEncoded = Buffer.from(psScript, 'utf16le').toString('base64');
                    console.log('[Relaunch Admin] Starting PowerShell Start-Process (Normal window)...');
                    const proc = spawn('powershell.exe', [
                        '-NoProfile', '-WindowStyle', 'Normal',
                        '-EncodedCommand', psEncoded
                    ], {
                        cwd: projectDir,
                        windowsHide: false,
                        shell: false,
                        detached: true,
                        stdio: ['ignore', 'pipe', 'pipe']
                    });
                    let stderrOut = '';
                    let stdoutOut = '';
                    let settled = false;
                    let spawned = false;
                    proc.stderr && proc.stderr.on('data', (d) => { stderrOut += String(d || ''); });
                    proc.stdout && proc.stdout.on('data', (d) => { stdoutOut += String(d || ''); });
                    proc.on('spawn', () => { spawned = true; });
                    proc.on('error', (e) => {
                        console.log('[Relaunch Admin] PS spawn error:', e.message);
                        if (!settled) { settled = true; res(false); }
                    });
                    proc.on('close', (code) => {
                        if (stdoutOut) console.log('[Relaunch Admin] PS stdout:', stdoutOut);
                        if (stderrOut) console.log('[Relaunch Admin] PS stderr:', stderrOut);
                        if (settled) return;
                        settled = true;
                        res(spawned);
                    });
                    setTimeout(() => { if (!settled) { settled = true; res(spawned); } }, 8000);
                    try { proc.unref(); } catch (_) {}
                })
            });

            methods.push({
                name: 'powershell-shell-com-normal',
                fn: () => new Promise((res) => {
                    const runArgsStr = runArgs.map(a => {
                        if (/[ "\t]/.test(a)) return '"' + a.replace(/"/g, '""') + '"';
                        return a;
                    }).join(' ');
                    const verb = 'runas';
                    const show = 1;
                    const ps = `$s = New-Object -ComObject Shell.Application; $s.ShellExecute(${quotePwsh(runExe)}, ${quotePwsh(runArgsStr)}, ${quotePwsh(projectDir)}, ${quotePwsh(verb)}, ${show})`;
                    const psEncoded = Buffer.from(ps, 'utf16le').toString('base64');
                    console.log('[Relaunch Admin] Starting PowerShell Shell COM (Normal window)...');
                    const proc = spawn('powershell.exe', [
                        '-NoProfile', '-WindowStyle', 'Normal',
                        '-EncodedCommand', psEncoded
                    ], {
                        cwd: projectDir,
                        windowsHide: false,
                        shell: false,
                        detached: true,
                        stdio: ['ignore', 'pipe', 'pipe']
                    });
                    let stderrOut = '';
                    let settled = false;
                    let spawned = false;
                    proc.stderr && proc.stderr.on('data', (d) => { stderrOut += String(d || ''); });
                    proc.on('spawn', () => { spawned = true; });
                    proc.on('error', () => { if (!settled) { settled = true; res(false); } });
                    proc.on('close', (code) => {
                        if (stderrOut) console.log('[Relaunch Admin] PS-com stderr:', stderrOut);
                        if (settled) return;
                        settled = true;
                        res(spawned || code === 0);
                    });
                    setTimeout(() => { if (!settled) { settled = true; res(spawned); } }, 7000);
                    try { proc.unref(); } catch (_) {}
                })
            });

            methods.push({
                name: 'cmd-runas-utility-fixed',
                fn: () => new Promise((res) => {
                    const argStr = runArgs.map(a => {
                        if (/[ "\t&|<>^]/.test(a)) return '"' + a.replace(/"/g, '^"') + '"';
                        return a;
                    }).join(' ');
                    const domU = (process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' : '') + (process.env.USERNAME || '');
                    const runExeQ = /[ \t]/.test(runExe) ? `"${runExe}"` : runExe;
                    const cmdLine = `@echo off & cd /d "${projectDir}" & runas /user:"${domU}" /savecred ${runExeQ} ${argStr} >nul 2>&1`;
                    console.log('[Relaunch Admin] Trying runas utility...');
                    const proc = spawn('cmd.exe', ['/C', cmdLine], {
                        cwd: projectDir,
                        windowsHide: false,
                        shell: true,
                        detached: true,
                        stdio: ['ignore', 'ignore', 'ignore']
                    });
                    let ok = false;
                    proc.on('error', () => {});
                    proc.on('spawn', () => { ok = true; });
                    setTimeout(() => res(ok), 4000);
                    try { proc.unref(); } catch (_) {}
                })
            });

            methods.push({
                name: 'explorer-invoke-runas',
                fn: () => new Promise((res) => {
                    const vbsContent = `Set WshShell = CreateObject("WScript.Shell")\r\n` +
                        `WshShell.CurrentDirectory = "${projectDir.replace(/"/g, '""')}"\r\n` +
                        `Set s = CreateObject("Shell.Application")\r\n` +
                        `s.ShellExecute "${runExe.replace(/"/g, '""')}", "${runArgs.map(a => (/\s/.test(a)?'"'+a.replace(/"/g,'""')+'"':a)).join(' ').replace(/"/g,'""')}", "${projectDir.replace(/"/g, '""')}", "runas", 1\r\n` +
                        `WScript.Sleep 1500\r\n` +
                        `WScript.Quit 0\r\n`;
                    const vbs = path.join(tmpDir, '__malakor_elev2_' + Date.now() + '.vbs');
                    try { fs.writeFileSync(vbs, vbsContent); } catch (_) { return res(false); }
                    let ok = false;
                    try {
                        const { shell } = require('electron');
                        shell.openPath(vbs);
                        ok = true;
                    } catch (e) {
                        console.log('[Relaunch Admin] explorer vbs openPath error:', e.message);
                        ok = false;
                    }
                    setTimeout(() => {
                        try { if (fs.existsSync(vbs)) fs.unlinkSync(vbs); } catch (_) {}
                        res(ok);
                    }, 5000);
                })
            });

            return (async () => {
                for (const m of methods) {
                    try {
                        console.log('[Relaunch Admin] Trying method:', m.name);
                        const ok = await m.fn();
                        if (ok) {
                            console.log('[Relaunch Admin] Method SUCCESS:', m.name);
                            return true;
                        }
                        console.log('[Relaunch Admin] Method returned false, next:', m.name);
                    } catch (e) {
                        console.log('[Relaunch Admin] Method EXCEPTION:', m.name, '->', e.message || e);
                    }
                }
                console.error('[Relaunch Admin] ALL methods failed.');
                return false;
            })();
        }

        let detailMsg = 'Restart as Admin?\n\nA Windows UAC prompt will appear to request elevation.';
        if (isDevMode) {
            detailMsg += `\n\n(Dev mode detected: will relaunch electron.exe with project path)`;
        }

        dialog.showMessageBox(topmostWin, {
            type: 'info',
            title: 'Admin Rights Required',
            message: 'This proxy requires Administrator privileges.',
            detail: detailMsg,
            buttons: ['&Yes', '&No'],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
            normalizeAccessKeys: true
        }).then(async (result) => {
            try { topmostWin.destroy(); } catch (_) {}
            if (result.response === 0) {
                let ok = false;
                try {
                    console.log('[Admin Prompt] User clicked YES -> invoking relaunch methods...');
                    ok = await _invokeRelaunchAsAdmin();
                    console.log('[Admin Prompt] Relaunch pipeline finished, ok =', ok);
                } catch (err) {
                    console.error('[Relaunch Admin Error]', err.message || err);
                    ok = false;
                }
                const waitMs = ok ? 4200 : 1800;
                console.log(`[Admin Prompt] Waiting ${waitMs}ms before quit (ok=${ok}) — this gives Windows time to show UAC prompt.`);
                if (!ok) {
                    try {
                        const fbDisplay = screen.getPrimaryDisplay().workAreaSize;
                        const fx = Math.max(0, Math.floor((fbDisplay.width - 520) / 2));
                        const fy = Math.max(0, Math.floor((fbDisplay.height - 260) / 2));
                        const fbWin = new BrowserWindow({
                            width: 520, height: 260, x: fx, y: fy,
                            show: false, frame: false, transparent: true, opacity: 0.0001,
                            alwaysOnTop: 'screen-saver', skipTaskbar: true, focusable: true, hasShadow: false,
                            webPreferences: { nodeIntegration: false, contextIsolation: true }
                        });
                        fbWin.setAlwaysOnTop(true, 'screen-saver');
                        fbWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
                        fbWin.showInactive();
                        dialog.showErrorBox(
                            'Relaunch Failed',
                            'Could not restart as Administrator automatically.\n\nPlease close this app, then right-click the app icon and choose "Run as Administrator" manually.'
                        );
                        try { fbWin.destroy(); } catch (_) {}
                    } catch (_) {}
                }
                let quitFired = false;
                setTimeout(() => {
                    if (quitFired) return;
                    quitFired = true;
                    console.log('[Admin Prompt] Calling app.quit() now.');
                    app.quit();
                    setTimeout(() => {
                        console.log('[Admin Prompt] app.quit() did not exit fast enough, forcing exit.');
                        process.exit(0);
                    }, 800);
                    resolve(false);
                }, waitMs);
            } else {
                console.log('[Admin Prompt] User clicked NO -> exiting.');
                app.quit();
                resolve(false);
            }
        }).catch((e) => {
            console.log('[Admin Prompt] dialog error:', e && e.message ? e.message : e);
            try { topmostWin.destroy(); } catch (__) {}
            app.quit();
            resolve(false);
        });
    });
}

async function ensureAdminOrExit() {
    if (process.platform !== 'win32') return true;
    if (checkIsAdmin()) return true;
    return await promptAdminRights();
}

// Handle File Selection via Native Dialog
ipcMain.handle('select-game-file', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
            { name: 'Executables', extensions: ['exe'] },
            { name: 'All Files', extensions: ['*'] }
        ]
    });
    
    if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
    }
    return null;
});

const server = require('./server'); // Import the express server

function createWindow() {
    const win = new BrowserWindow({
        width: 900,
        height: 520,
        frame: false, // REMOVE FRAME (Title bar, etc.)
        resizable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false 
        },
        autoHideMenuBar: true,
        title: "Malakor Game Launcher",
        backgroundColor: '#000000'
    });

    // Load the local server
    // Since server.js starts listening on port 3000, we can load localhost:3000
    // We should wait a bit or ensure server is ready, but typically it's fast enough.
    // Alternatively, we could serve files directly via file:// protocol but since we have API logic in express,
    // keeping the server running in the background is easier for logic reuse.
    
    // Retry loading if connection fails
    const loadApp = () => {
        win.loadURL('http://localhost:3000').catch((err) => {
            console.log('Server not ready, retrying in 1s...');
            setTimeout(loadApp, 1000);
        });
    };
    
    setTimeout(loadApp, 1000);

    // Open DevTools for debugging (optional)
    // win.webContents.openDevTools();

    // Check for App Updates from JSON
    win.once('ready-to-show', () => {
        // checkAppUpdate(win); // TEMP disabled — auto-install was interrupting Discord auth mid-flow
        checkAutoLogin(win);
    });
}

async function checkAutoLogin(win) {
    try {
        const savedToken = await db.getSetting('discord_access_token');
        if (savedToken) {
            console.log('[Auth] Found saved token, attempting auto-login...');
            await verifyDiscordUser(savedToken, win.webContents);
        }
    } catch (err) {
        console.error('[Auto Login Error]', err.message);
    }
}

async function checkAppUpdate(win) {
    try {
        const currentVersion = app.getVersion();
        console.log(`[App Update] Current Version: ${currentVersion}`);
        
        const response = await axios.get(APP_UPDATE_JSON_URL, { headers: { 'Cache-Control': 'no-cache' } });
        const remoteConfig = response.data;

        if (remoteConfig && remoteConfig.appVersion && remoteConfig.appVersion !== currentVersion) {
            win.webContents.send('app-update-available', {
                version: remoteConfig.appVersion,
                description: remoteConfig.appDescription,
                downloadUrl: remoteConfig.appDownloadUrl
            });
        }
    } catch (err) {
        console.error('[App Update Error]', err.message);
    }
}

// Handle App Close
ipcMain.on('close-app', () => {
    app.quit();
});

ipcMain.on('open-external-url', (event, url) => {
    if (url) shell.openExternal(url);
});

// --- Discord Auth Logic ---
ipcMain.on('start-discord-login', (event) => {
    const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=token&scope=identify`;
    
    // Start local server to catch the callback
    if (authServer) authServer.close();
    
    authServer = http.createServer((req, res) => {
        const parsedUrl = url.parse(req.url, true);
        
        // OAuth2 Implicit Grant returns token in URL fragment (#), 
        // so we need a small HTML/JS to send it to the server
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
            <html>
                <body style="background:#121215;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
                    <div style="text-align:center;">
                        <h2>Verifying Authentication...</h2>
                        <p>You can close this window now.</p>
                    </div>
                    <script>
                        const hash = window.location.hash.substring(1);
                        const params = new URLSearchParams(hash);
                        const token = params.get('access_token');
                        if (token) {
                            fetch('/token?access_token=' + token).then(() => {
                                window.close();
                            });
                        }
                    </script>
                </body>
            </html>
        `);

        if (parsedUrl.pathname === '/token') {
            const token = parsedUrl.query.access_token;
            if (token) {
                verifyDiscordUser(token, event.sender);
                authServer.close();
                authServer = null;
            }
        }
    });

    authServer.listen(53134);
    shell.openExternal(authUrl);
});

async function verifyDiscordUser(token, webContents) {
    try {
        // 1. Get user info from Discord
        const userRes = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 8000
        });
        const user = userRes.data;
        
        webContents.send('discord-user-info', {
            id: user.id,
            username: user.username,
            avatar: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
        });

        // 2. Check permission from JSON API
        const authRes = await axios.get(AUTH_JSON_URL, { headers: { 'Cache-Control': 'no-cache' }, timeout: 8000 });
        const allowedIds = authRes.data; // Expecting array of strings ["id1", "id2"]

        if (Array.isArray(allowedIds) && allowedIds.includes(user.id)) {
            // Save token for auto login
            await db.setSetting('discord_access_token', token);
            webContents.send('auth-success');
        } else {
            // Remove invalid token
            await db.setSetting('discord_access_token', '');
            webContents.send('auth-failed', "You don't have permission to access Malakor Launcher.");
        }
    } catch (err) {
        console.error('[Auth Error]', err.message, err.response ? err.response.status : '', err.response ? err.response.data : '');
        // Remove potentially expired token
        await db.setSetting('discord_access_token', '');
        webContents.send('auth-failed', "Verification failed. Please login again.");
    }
}

app.whenReady().then(async () => {
    const ok = await ensureAdminOrExit();
    if (!ok) return;

    const userDataPath = app.getPath('userData');

    // CRITICAL: Initialize SQLite BEFORE calling any route that uses db.setSetting/getSetting
    // Without this, localDb=null forever, and writes silently resolve without saving.
    try {
        if (db && typeof db.initializeDatabase === 'function') {
            await db.initializeDatabase(app);
            console.log('[Bootstrap] Database initialized successfully.');
        } else {
            console.error('[Bootstrap] db.initializeDatabase is not available. Settings will not persist!');
        }
    } catch (err) {
        console.error('[Bootstrap] Database initialization failed (continuing anyway):', err.message || err);
    }

    try {
        if (server && typeof server.initializeServer === 'function') {
            await server.initializeServer(userDataPath);
            console.log('[Bootstrap] Server initialized successfully.');
        } else {
            console.error('[Bootstrap] server.initializeServer is not available.');
        }
    } catch (err) {
        console.error('[Bootstrap] Server initialization failed:', err.message);
    }

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});