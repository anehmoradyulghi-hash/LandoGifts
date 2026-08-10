import fs from 'fs';
import path from 'path';
import db, { getSetting, setSetting } from './db.js';

/* =========================================================================
 * Automatic database backups
 * Runs on an interval (default: every 24h) and copies the live database to a
 * timestamped file in data/backups/, using better-sqlite3's built-in backup()
 * API rather than a raw file copy — this is safe even while the app is
 * running in WAL mode, unlike copying the .db file directly. Old backups
 * beyond the configured retention count are pruned automatically.
 * ========================================================================= */
const DATA_DIR = path.join(process.cwd(), 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

export function getBackupConfig() {
  return {
    enabled: getSetting('backup_enabled', '1') === '1',
    intervalHours: Number(getSetting('backup_interval_hours', '24')),
    retentionCount: Number(getSetting('backup_retention_count', '14')),
  };
}
export function setBackupConfig(c) {
  setSetting('backup_enabled', c.enabled ? '1' : '0');
  setSetting('backup_interval_hours', String(Math.max(1, Number(c.intervalHours) || 24)));
  setSetting('backup_retention_count', String(Math.max(1, Number(c.retentionCount) || 14)));
}

export function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.db'))
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function runBackupNow() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, `lando-gifts-${stamp}.db`);
  await db.backup(dest);
  pruneOldBackups();
  return dest;
}

function pruneOldBackups() {
  const { retentionCount } = getBackupConfig();
  const backups = listBackups();
  for (const old of backups.slice(retentionCount)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, old.name)); } catch (e) { /* already gone — fine */ }
  }
}

let backupTimer = null;
export function startBackupScheduler() {
  if (backupTimer) clearInterval(backupTimer);
  const tick = async () => {
    try {
      const cfg = getBackupConfig();
      if (!cfg.enabled) return;
      await runBackupNow();
    } catch (e) { console.error('[db backup]', e); }
  };
  // Check hourly whether it's time to run, based on the configured interval and how old the most
  // recent backup is — this way changing the interval in the admin panel takes effect without a restart.
  backupTimer = setInterval(() => {
    const cfg = getBackupConfig();
    if (!cfg.enabled) return;
    const backups = listBackups();
    const latest = backups[0];
    const hoursSinceLast = latest ? (Date.now() - new Date(latest.createdAt).getTime()) / 3600000 : Infinity;
    if (hoursSinceLast >= cfg.intervalHours) tick();
  }, 60 * 60 * 1000);
  // Also do an initial check shortly after boot, in case backups were never run and the app restarts
  // frequently (so a fresh deploy doesn't wait a full hour for its first backup).
  setTimeout(() => {
    const cfg = getBackupConfig();
    if (cfg.enabled && listBackups().length === 0) tick();
  }, 30 * 1000);
}
