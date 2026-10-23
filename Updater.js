const axios = require('axios');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { exec } = require('child_process');

class Updater {
    constructor(gameDir, logCallback) {
        this.gameDir = path.resolve(gameDir);
        if (!this.gameDir.endsWith(path.sep)) {
            this.gameDir = this.gameDir + path.sep;
        }
        this.log = logCallback;
        this.configUrl = 'https://api.npoint.io/d2f1a6192837d901e8f9';
        this.versionFilePath = path.join(this.gameDir, 'version.json');
        this.manifestFilePath = path.join(this.gameDir, 'patch-manifest.json');

        console.log("[Updater Init] Game Directory:", this.gameDir);
        console.log("[Updater Init] Version File Path:", this.versionFilePath);
        console.log("[Updater Init] Manifest File Path:", this.manifestFilePath);
    }

    clearAttribAndDeleteExistingFiles(zipEntries) {
        return new Promise((resolve) => {
            if (process.platform !== 'win32') {
                resolve();
                return;
            }
            const fileEntries = zipEntries.filter(e => !e.entryName.endsWith('/'));
            if (fileEntries.length === 0) {
                resolve();
                return;
            }
            const actions = [];
            const existingPaths = [];
            for (const entry of fileEntries) {
                const rel = entry.entryName.replace(/\\/g, '/');
                const fullPath = path.join(this.gameDir, rel);
                try {
                    if (!fs.existsSync(fullPath)) continue;
                } catch (_) { continue; }
                const escaped = `"${fullPath}"`;
                actions.push(`attrib -R -H -S -A ${escaped} >nul 2>&1`);
                existingPaths.push(fullPath);
            }
            if (actions.length === 0) {
                resolve();
                return;
            }
            // Single attrib pass. No per-chunk recursion (eliminates hang risk).
            // Then aggressive delete (unlink -> rename trick for locked files -> best effort del).
            const cmdLine = actions.join(' & ');
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const cleanupThenResolve = async () => {
                const suffix = `_obsolete_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
                for (const p of existingPaths) {
                    const resolved = path.resolve(p);
                    if (!resolved.startsWith(this.gameDir)) continue;

                    // 1) Plain unlinkSync
                    let removed = false;
                    for (let attempt = 1; attempt <= 3 && !removed; attempt++) {
                        try {
                            if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
                            removed = true;
                        } catch (_) {
                            if (attempt < 3) {
                                try { require('child_process').execSync(`attrib -R -H -S -A "${resolved}" >nul 2>&1`, { timeout: 1500, stdio: 'ignore' }); } catch (__) {}
                                await sleep(180 * attempt);
                            }
                        }
                    }
                    if (removed) continue;

                    // 2) Rename trick: Windows allows renaming open files (shared delete).
                    //    Even if we can't delete it right now, the path is freed for extraction.
                    try {
                        const renamed = resolved + suffix;
                        if (fs.existsSync(renamed)) { try { fs.unlinkSync(renamed); } catch (_) {} }
                        try { fs.renameSync(resolved, renamed); } catch (_) {}
                        // Try delayed remove
                        setTimeout(() => { try { fs.unlinkSync(renamed); } catch (_) {} }, 20000);
                    } catch (_) {
                        // 3) Last ditch: cmd /c del /F /Q
                        try {
                            require('child_process').exec(`cmd /c del /F /Q "${resolved}" >nul 2>&1`, { windowsHide: true, timeout: 2500 });
                        } catch (__) {}
                    }
                }
                resolve();
            };
            try {
                exec(cmdLine, {
                    windowsHide: true,
                    maxBuffer: 10 * 1024 * 1024,
                    timeout: actions.length * 30 + 8000,
                    killSignal: 'SIGTERM'
                }, () => {
                    // Always continue — attrib failure must not block patching.
                    cleanupThenResolve();
                });
            } catch (_) {
                cleanupThenResolve();
            }
        });
    }

    getLocalVersion() {
        try {
            if (fs.existsSync(this.versionFilePath)) {
                const data = fs.readFileSync(this.versionFilePath, 'utf8');
                const config = JSON.parse(data);
                console.log("[Updater] Read local version:", config.version);
                return config.version || '0.0.0';
            } else {
                console.log("[Updater] No version.json found at:", this.versionFilePath);
            }
        } catch (e) {
            console.error("[Updater] Error reading local version:", e.message);
        }
        return '0.0.0';
    }

    saveLocalVersion(version) {
        try {
            const data = JSON.stringify({ version, updatedAt: new Date().toISOString() }, null, 2);
            fs.writeFileSync(this.versionFilePath, data, 'utf8');
            this.log(`[Updater] Local version saved: v${version}`);
            console.log("[Updater] Version file written to:", this.versionFilePath);
        } catch (e) {
            this.log(`[Updater Error] Failed to save local version: ${e.message}`);
            console.error("[Updater Error] Write failed:", e);
        }
    }

    loadManifest() {
        try {
            if (fs.existsSync(this.manifestFilePath)) {
                const raw = fs.readFileSync(this.manifestFilePath, 'utf8');
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed.files)) {
                    return parsed.files;
                }
            } else {
                console.log("[Updater] No patch-manifest.json found yet (first patch run).");
            }
        } catch (e) {
            console.error("[Updater] Error reading patch manifest:", e.message);
        }
        return [];
    }

    saveManifest(fileList) {
        try {
            const data = JSON.stringify({
                files: fileList,
                updatedAt: new Date().toISOString()
            }, null, 2);
            fs.writeFileSync(this.manifestFilePath, data, 'utf8');
            this.log(`[Updater] Patch manifest saved (${fileList.length} files tracked).`);
        } catch (e) {
            this.log(`[Updater Error] Failed to save patch manifest: ${e.message}`);
            console.error("[Updater Error] Manifest write failed:", e);
        }
    }

    cleanupStaleFiles(oldManifest, newZipEntries) {
        const newFileSet = new Set(
            newZipEntries
                .filter(entry => !entry.entryName.endsWith('/'))
                .map(entry => entry.entryName.replace(/\\/g, '/'))
        );

        const staleFiles = oldManifest.filter(relPath => !newFileSet.has(relPath));

        if (staleFiles.length === 0) {
            this.log("[Updater] No stale patch files to remove.");
            return staleFiles;
        }

        this.log(`[Updater] Found ${staleFiles.length} stale file(s) from previous patch. Removing...`);

        for (const relPath of staleFiles) {
            const fullPath = path.join(this.gameDir, relPath);

            const resolved = path.resolve(fullPath);
            if (!resolved.startsWith(this.gameDir)) {
                this.log(`[Updater Warning] Skipped suspicious path outside game dir: ${relPath}`);
                continue;
            }

            try {
                if (fs.existsSync(resolved)) {
                    fs.unlinkSync(resolved);
                    this.log(`[Updater] Removed stale file: ${relPath}`);
                }
            } catch (e) {
                this.log(`[Updater Warning] Could not remove ${relPath}: ${e.message}`);
            }
        }

        this.removeEmptyDirs(this.gameDir);

        return staleFiles;
    }

    removeEmptyDirs(dir) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            return;
        }

        for (const entry of entries) {
            if (entry.isDirectory()) {
                const subDir = path.join(dir, entry.name);
                this.removeEmptyDirs(subDir);
                try {
                    const remaining = fs.readdirSync(subDir);
                    if (remaining.length === 0) {
                        fs.rmdirSync(subDir);
                        console.log("[Updater] Removed empty directory:", subDir);
                    }
                } catch (e) {
                }
            }
        }
    }

    async checkUpdate() {
        try {
            const localVersion = this.getLocalVersion();
            this.log(`[Updater] Checking for updates (Local: v${localVersion})...`);

            const response = await axios.get(this.configUrl, {
                headers: { 'Cache-Control': 'no-cache' },
                timeout: 10000
            });
            const remoteConfig = response.data;

            if (!remoteConfig || !remoteConfig.version) {
                this.log("[Updater Error] Invalid JSON structure from server");
                return null;
            }

            console.log("[Updater] Comparing:", remoteConfig.version, "vs", localVersion);

            if (remoteConfig.version !== localVersion) {
                this.log(`[Updater] New update found: v${remoteConfig.version}`);
                return {
                    update: true,
                    version: remoteConfig.version,
                    downloadUrl: remoteConfig.downloadUrl,
                    description: remoteConfig.description
                };
            } else {
                this.log("[Updater] Game is up to date.");
                return { update: false };
            }
        } catch (err) {
            this.log(`[Updater Error] Failed to check update: ${err.message}`);
            return null;
        }
    }

    async checkAppUpdate(currentAppVersion) {
        try {
            this.log(`[Updater] Checking for app update (Local app: v${currentAppVersion})...`);

            const response = await axios.get(this.configUrl, {
                headers: { 'Cache-Control': 'no-cache' },
                timeout: 10000
            });
            const remoteConfig = response.data;

            if (!remoteConfig || !remoteConfig.appVersion) {
                this.log("[Updater] No appVersion field found in remote config. Skipping app update check.");
                return null;
            }

            console.log("[Updater] App version compare:", remoteConfig.appVersion, "vs", currentAppVersion);

            if (remoteConfig.appVersion !== currentAppVersion) {
                this.log(`[Updater] New app version available: v${remoteConfig.appVersion}`);
                return {
                    update: true,
                    appVersion: remoteConfig.appVersion,
                    appDownloadUrl: remoteConfig.appDownloadUrl,
                    appDescription: remoteConfig.appDescription
                };
            } else {
                this.log("[Updater] App is up to date.");
                return { update: false };
            }
        } catch (err) {
            this.log(`[Updater Error] Failed to check app update: ${err.message}`);
            return null;
        }
    }

    async downloadApp(appDownloadUrl, onProgress) {
        try {
            const fileName = path.basename(appDownloadUrl.split('?')[0]) || 'app-update-setup.exe';
            const destPath = path.join(this.gameDir, fileName);

            this.log(`[Updater] Downloading app update: ${fileName}...`);

            const response = await axios({
                method: 'get',
                url: appDownloadUrl,
                responseType: 'stream',
                timeout: 120000
            });

            const contentType = response.headers['content-type'];
            console.log("[Updater] App download Content-Type:", contentType);

            if (contentType && contentType.includes('text/html')) {
                throw new Error("Received HTML instead of the installer file. The download link may be expired.");
            }

            const totalLength = response.headers['content-length'];
            let downloadedLength = 0;

            const writer = fs.createWriteStream(destPath);

            response.data.on('data', (chunk) => {
                downloadedLength += chunk.length;
                if (totalLength) {
                    const percent = Math.round((downloadedLength / totalLength) * 100);
                    if (onProgress) onProgress(percent, 'Downloading app update...');
                } else {
                    if (onProgress) onProgress(0, `Downloading app... (${(downloadedLength / 1024 / 1024).toFixed(2)} MB)`);
                }
            });

            return new Promise((resolve, reject) => {
                response.data.pipe(writer);

                writer.on('finish', () => {
                    writer.close();
                    this.log(`[Updater] App installer downloaded to: ${destPath}`);
                    resolve(destPath);
                });

                writer.on('error', (err) => {
                    this.log(`[Updater Error] App download write failed: ${err.message}`);
                    reject(err);
                });
            });

        } catch (err) {
            this.log(`[Updater Error] App download failed: ${err.message}`);
            throw err;
        }
    }

    async downloadAndExtract(downloadUrl, onProgress) {
        const tempZipPath = path.join(this.gameDir, 'update_temp.zip');
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const _safeRmTemp = async () => {
            for (let i = 0; i < 3; i++) {
                try { if (fs.existsSync(tempZipPath)) { fs.unlinkSync(tempZipPath); } break; } catch (_) { await sleep(200 + i * 200); }
            }
        };
        try {
            // 1) Remove any stale temp zip from a previous failed run
            await _safeRmTemp();

            this.log(`[Updater] Downloading update from Dropbox...`);

            const response = await axios({
                method: 'get',
                url: downloadUrl,
                responseType: 'stream',
                timeout: 60000
            });

            const contentType = response.headers['content-type'];
            console.log("[Updater] Download Content-Type:", contentType);

            if (contentType && contentType.includes('text/html')) {
                throw new Error("Received HTML instead of ZIP. The Dropbox link might be incorrect or expired.");
            }

            const totalLength = response.headers['content-length'];
            let downloadedLength = 0;

            const writer = fs.createWriteStream(tempZipPath, { flags: 'w', mode: 0o666 });

            response.data.on('data', (chunk) => {
                downloadedLength += chunk.length;
                if (totalLength) {
                    const percent = Math.round((downloadedLength / totalLength) * 100);
                    if (onProgress) onProgress(percent, 'Downloading...');
                } else {
                    if (onProgress) onProgress(0, `Downloading... (${(downloadedLength / 1024 / 1024).toFixed(2)} MB)`);
                }
            });

            const result = await new Promise((resolve, reject) => {
                let writerFinished = false;
                let streamClosed = false;
                const _tryFinish = () => {
                    if (writerFinished && streamClosed) resolve(true);
                };
                response.data.pipe(writer);
                writer.on('finish', () => {
                    writerFinished = true;
                    try { writer.close(() => { streamClosed = true; _tryFinish(); }); }
                    catch (_) { streamClosed = true; _tryFinish(); }
                });
                writer.on('error', (err) => {
                    this.log(`[Updater Error] Write failed: ${err.message}`);
                    reject(err);
                });
                response.data.on('error', (err) => {
                    this.log(`[Updater Error] Download stream failed: ${err.message}`);
                    reject(err);
                });
                // Extra safety in case neither finish nor error fires
                setTimeout(() => { if (!writerFinished && !streamClosed) {
                    try { writer.destroy(); } catch (_) {}
                    reject(new Error('Download stream timeout (no response for 180s).'));
                } }, 180000);
            });

            this.log(`[Updater] Download complete (${(downloadedLength / 1024 / 1024).toFixed(2)} MB). Extracting...`);
            if (onProgress) onProgress(82, 'Extracting files...');

            await new Promise(r => setTimeout(r, 500));

            let zip;
            try {
                zip = new AdmZip(tempZipPath);
            } catch (zipErr) {
                throw new Error(`ZIP file is invalid or corrupted (${zipErr.message}). Re-run update to re-download.`);
            }
            const zipEntries = zip.getEntries();

            if (zipEntries.length === 0) {
                throw new Error("Downloaded ZIP is empty.");
            }

            const oldManifest = this.loadManifest();

            this.log(`[Updater] Preparing ${zipEntries.length} files for extraction...`);
            await this.clearAttribAndDeleteExistingFiles(zipEntries);

            this.log(`[Updater] Extracting ${zipEntries.length} files...`);
            let extractSuccess = false;
            let lastErr = null;

            for (let attempt = 1; attempt <= 4; attempt++) {
                try {
                    zip.extractAllTo(this.gameDir, true);
                    extractSuccess = true;
                    break;
                } catch (e) {
                    lastErr = e;
                    if (attempt < 4) {
                        this.log(`[Updater] Extract attempt ${attempt} failed: ${e.message}. Retrying...`);
                        // Attempt 2: just re-delete obstinate files again
                        if (attempt === 2) await this.clearAttribAndDeleteExistingFiles(zipEntries);
                        // Attempt 3: per-file fallback extraction (adm-zip extractAllTo is all-or-nothing)
                        if (attempt === 3) {
                            this.log(`[Updater] Trying per-file extraction fallback...`);
                            let perFileOk = true;
                            for (const entry of zipEntries) {
                                const rel = entry.entryName.replace(/\\/g, '/');
                                if (rel.endsWith('/')) {
                                    try { fs.mkdirSync(path.join(this.gameDir, rel), { recursive: true }); } catch (_) {}
                                    continue;
                                }
                                const target = path.join(this.gameDir, rel);
                                try {
                                    if (fs.existsSync(target)) {
                                        fs.unlinkSync(target);
                                    } else {
                                        fs.mkdirSync(path.dirname(target), { recursive: true });
                                    }
                                    zip.extractEntryTo(entry, this.gameDir, false, true);
                                } catch (perFileErr) {
                                    // Rename trick for the single stubborn file that can't be removed
                                    try {
                                        if (fs.existsSync(target)) {
                                            const renamed = target + `_stale_${Date.now()}`;
                                            try { fs.renameSync(target, renamed); } catch (_) {}
                                            setTimeout(() => { try { fs.unlinkSync(renamed); } catch (_) {} }, 20000);
                                        }
                                        fs.mkdirSync(path.dirname(target), { recursive: true });
                                        zip.extractEntryTo(entry, this.gameDir, false, true);
                                    } catch (_) {
                                        this.log(`[Updater WARN] Could not update: ${rel} (${perFileErr.message})`);
                                        perFileOk = false;
                                    }
                                }
                            }
                            if (perFileOk) { extractSuccess = true; break; }
                        }
                        await new Promise(r => setTimeout(r, attempt * 600));
                    }
                }
            }
            if (!extractSuccess) {
                throw lastErr || new Error('Extraction failed after multiple attempts.');
            }

            this.log(`[Updater] Extraction successful.`);
            if (onProgress) onProgress(96, 'Cleaning up old files...');

            this.cleanupStaleFiles(oldManifest, zipEntries);

            const newFileList = zipEntries
                .filter(entry => !entry.entryName.endsWith('/'))
                .map(entry => entry.entryName.replace(/\\/g, '/'));
            this.saveManifest(newFileList);

            try {
                const configRes = await axios.get(this.configUrl, { timeout: 10000 });
                if (configRes.data && configRes.data.version) {
                    this.saveLocalVersion(configRes.data.version);
                } else {
                    this.log("[Updater Warning] Could not read version from config after update.");
                }
            } catch (versionErr) {
                this.log(`[Updater Warning] Failed to fetch version after update: ${versionErr.message}. Will retry on next launch.`);
            }

            if (onProgress) onProgress(100, 'Update complete!');
            await _safeRmTemp();
            return true;
        } catch (err) {
            this.log(`[Updater Error] ${err.message}`);
            console.error("[Updater Error] Detail:", err);
            // Always clean temp zip on failure too
            await _safeRmTemp();
            throw err;
        }
    }
}

module.exports = Updater;
