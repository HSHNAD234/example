const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// --- DATABASE CONFIGURATION ---
let localDb = null;

// In-memory settings cache (huge perf win: avoid SQLite I/O on every poll)
const _settingsCache = new Map();
let _settingsCacheLoaded = false;
const KNOWN_SETTINGS_KEYS = [
    'game_path', 'server_address', 'discord_access_token',
    'is_installed', 'central_server_url', 'boatltpk_custom_ip'
];

const _reloadSettingsCache = () => new Promise((resolve) => {
    if (!localDb) { resolve(false); return; }
    localDb.all(`SELECT key, value FROM settings`, (err, rows) => {
        if (err) { resolve(false); return; }
        _settingsCache.clear();
        for (const row of (rows || [])) {
            if (row && row.key !== undefined && row.key !== null) {
                _settingsCache.set(String(row.key), (row.value === undefined || row.value === null) ? '' : String(row.value));
            }
        }
        for (const k of KNOWN_SETTINGS_KEYS) {
            if (!_settingsCache.has(k)) _settingsCache.set(k, '');
        }
        _settingsCacheLoaded = true;
        resolve(true);
    });
});

function initializeDatabase(app) {
    return new Promise((resolve, reject) => {
        const dbPath = path.join(app.getPath('userData'), 'settings.db');
        console.log(`[Database] Initializing SQLite at: ${dbPath}`);

        try {
            const sqlite3 = require('sqlite3').verbose();
            localDb = new sqlite3.Database(dbPath, (err) => {
                if (err) {
                    console.error('Could not connect to local settings database', err);
                    reject(err);
                    return;
                }
                console.log('Connected to local settings database');
            });

            let pending = 1;
            const doneOne = (err) => {
                if (err) console.warn('[Database] init step warning:', err.message);
                if (--pending <= 0) {
                    _reloadSettingsCache().then(() => {
                        console.log('[Database] initializeDatabase completed successfully.');
                        resolve();
                    });
                }
            };

            localDb.serialize(() => {
                localDb.run(`CREATE TABLE IF NOT EXISTS settings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    key TEXT UNIQUE,
                    value TEXT
                )`, (createErr) => {
                    if (createErr) console.error('[Database] Create settings table error:', createErr.message);
                });
                const defaults = [
                    ['game_path', ''],
                    ['server_address', ''],
                    ['discord_access_token', ''],
                    ['is_installed', 'false'],
                    ['central_server_url', ''],
                    ['boatltpk_custom_ip', '']
                ];
                pending += defaults.length;
                for (const [k, v] of defaults) {
                    localDb.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [k, v], (insertErr) => {
                        doneOne(insertErr);
                    });
                }
                doneOne(null);
            });
        } catch (e) {
            console.error("SQLite failed to initialize:", e.message);
            reject(e);
        }
    });
}

// --- SUPABASE CLIENT MANAGER ---
let supabase = null;

// HARDCODED SUPABASE CREDENTIALS
const SUPABASE_URL = "https://zspygbnnxpfsoxbihaqm.supabase.co";
const SUPABASE_KEY = "sb_publishable_NVUG0ARc5ASwaLduDWzD8w_isX7hSKy";

const initSupabase = async () => {
    if (SUPABASE_URL && SUPABASE_KEY) {
        try {
            supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
            console.log("Supabase Client Initialized");
        } catch (e) {
            console.error("Failed to initialize Supabase:", e);
        }
    }
};

// Initialize on start
initSupabase();

module.exports = {
    initializeDatabase,

    // Batch-get all known settings in ONE call (no per-key SQLite roundtrip)
    // Returns object: { game_path, server_address, is_installed, central_server_url, boatltpk_custom_ip, discord_access_token }
    getAllSettings: async () => {
        if (!_settingsCacheLoaded) await _reloadSettingsCache();
        const out = {};
        for (const k of KNOWN_SETTINGS_KEYS) out[k] = _settingsCache.get(k) || '';
        return out;
    },

    // --- SETTINGS (Local SQLite only, skip on Vercel) ---
    getSetting: (key) => {
        return new Promise(async (resolve, reject) => {
            if (!localDb) return resolve(null);
            const keyStr = String(key);
            if (_settingsCacheLoaded) {
                const cached = _settingsCache.get(keyStr);
                return resolve(cached === undefined ? null : cached);
            }
            localDb.get(`SELECT value FROM settings WHERE key = ?`, [keyStr], (err, row) => {
                if (err) { reject(err); return; }
                const out = (row && row.value !== undefined) ? row.value : null;
                resolve(out);
            });
        });
    },

    setSetting: (key, value) => {
        return new Promise((resolve, reject) => {
            if (!localDb) {
                console.warn(`[setSetting] localDb=null — cannot write key="${key}"`);
                return resolve();
            }
            const keyStr = String(key);
            const valueStr = (value === null || value === undefined) ? '' : String(value);
            // Save old value for rollback in case DB write fails (keep cache honest)
            const hadOld = _settingsCache.has(keyStr);
            const oldValue = hadOld ? _settingsCache.get(keyStr) : null;
            _settingsCache.set(keyStr, valueStr);

            const rollbackCache = () => {
                if (hadOld) _settingsCache.set(keyStr, oldValue);
                else _settingsCache.delete(keyStr);
            };

            const tryUpsert = (cb) => {
                const upsertSql = `INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
                localDb.run(upsertSql, [keyStr, valueStr], (err) => {
                    if (err) cb(err); else cb(null);
                });
            };
            const fallbackDeleteInsert = (cb) => {
                if (!localDb) return cb(new Error('localDb missing'));
                localDb.serialize(() => {
                    localDb.run(`DELETE FROM settings WHERE key = ?`, [keyStr], () => {
                        localDb.run(`INSERT INTO settings(key, value) VALUES(?, ?)`, [keyStr, valueStr], (insErr) => {
                            if (insErr) cb(insErr); else cb(null);
                        });
                    });
                });
            };
            tryUpsert((err) => {
                if (err) {
                    console.warn(`[setSetting] Upsert failed key="${keyStr}", using fallback.`);
                    fallbackDeleteInsert((err2) => {
                        if (err2) {
                            console.error(`[setSetting] FALLBACK also failed key="${keyStr}":`, err2.message);
                            rollbackCache();
                            reject(err2);
                        } else {
                            resolve();
                        }
                    });
                } else {
                    resolve();
                }
            });
        });
    },

    // Force reload settings directly from SQLite (bypass/write-through cache).
    // Use after you need to verify a write actually persisted to disk.
    flushSettingsCache: () => _reloadSettingsCache(),
    
    // --- GAME DATA (Supabase Only - Removed SQLite Sync) ---
    getPlayerBySteamId: async (steamId) => {
        if (!supabase) return null;
        const { data, error } = await supabase.from('players').select('*').eq('steam_id', steamId).single();
        if (error && error.code !== 'PGRST116') console.error("Supabase Error (getPlayer):", error);
        return data;
    },
    
    createPlayer: async (playerData) => {
        const { steamId, username, email } = playerData;
        if (!supabase) return null;

        const { data, error } = await supabase.from('players').insert([{ 
            steam_id: steamId, username, email, level: 1, exp: 0, coins: 1000, inventory: [], last_login: new Date()
        }]).select().single();
        
        if (error) console.error("Supabase Error (createPlayer):", error);
        return data;
    },
    
    updatePlayerLogin: async (id) => {
        if (!supabase) return;
        await supabase.from('players').update({ last_login: new Date() }).eq('id', id);
    },

    addItemToInventory: async (playerId, itemId, quantity = 1) => {
        if (!supabase) return;
        await supabase.from('inventory').insert([{ player_id: playerId, item_id: itemId, quantity, equipped: false }]);
    },

    getInventory: async (playerId) => {
        if (!supabase) return [];
        const { data } = await supabase.from('inventory').select('*').eq('player_id', playerId);
        return data || [];
    },

    getPlayerStats: async (playerId) => {
        if (!supabase) return null;
        const { data } = await supabase.from('player_stats').select('*').eq('player_id', playerId).single();
        return data;
    },

    updatePlayerStats: async (playerId, stats) => {
        const { wins, losses, kills, deaths } = stats;
        const totalMatches = (wins || 0) + (losses || 0);
        if (!supabase) return;
        await supabase.from('player_stats').upsert({ 
            player_id: playerId, total_matches: totalMatches, wins, losses, kills, deaths 
        });
    },

    addMatchLog: async (playerId, matchData, result) => {
        if (!supabase) return;
        await supabase.from('match_logs').insert([{ 
            player_id: playerId, match_data: matchData, result, created_at: new Date() 
        }]);
    },

    getAllProducts: async () => {
        if (!supabase) return [];
        const { data } = await supabase.from('store_products').select('*');
        return data || [];
    }
};
