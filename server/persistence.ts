import fs from 'node:fs';
import path from 'node:path';
import type {
  ArchiveItem,
  BatchJob,
  BatchSettings,
  UiPreferences,
} from '../src/lib/types';
import type { DownloadedFileRecord } from './mediaDownloader';

export interface PersistedSettingsFile {
  version: 1;
  updatedAt: string;
  settings: BatchSettings;
  preferences: UiPreferences;
}

export interface PersistedAppState {
  version: 1;
  updatedAt: string;
  jobs: BatchJob[];
  archive: ArchiveItem[];
  itemDiskFiles: Record<string, DownloadedFileRecord[]>;
  archiveDiskFiles: Record<string, DownloadedFileRecord[]>;
}

export function resolveDefaultDataDir(): string {
  const fromEnv = process.env.DOUYIN_DATA_DIR?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.resolve(process.cwd(), '.douyin-studio-data');
}

function ensurePrivateDirSync(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function writeJsonAtomicSync(filePath: string, payload: unknown, mode = 0o600): void {
  const dir = path.dirname(filePath);
  ensurePrivateDirSync(dir);

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`;

  try {
    const serialized = JSON.stringify(payload, null, 2);
    fs.writeFileSync(tmpPath, serialized, { encoding: 'utf8', mode });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // ignore temp cleanup failure
    }
    throw err;
  }
}

function backupCorruptFileSync(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const backupPath = `${filePath}.corrupt.${Date.now()}`;
    fs.renameSync(filePath, backupPath);
  } catch {
    // ignore backup failure
  }
}

function readJsonFileSync<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(`[PersistenceStore] Failed to parse ${filePath}, backing up:`, err);
    backupCorruptFileSync(filePath);
    return null;
  }
}

export class PersistenceStore {
  private readonly dataDir: string;
  private readonly settingsPath: string;
  private readonly statePath: string;

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    this.settingsPath = path.join(this.dataDir, 'settings.json');
    this.statePath = path.join(this.dataDir, 'state.json');
  }

  getDataDir(): string {
    return this.dataDir;
  }

  getSettingsPath(): string {
    return this.settingsPath;
  }

  getStatePath(): string {
    return this.statePath;
  }

  loadSettings(): {
    settings: Partial<BatchSettings> | null;
    preferences: Partial<UiPreferences> | null;
  } {
    const parsed = readJsonFileSync<Partial<PersistedSettingsFile>>(this.settingsPath);
    if (!parsed || typeof parsed !== 'object') {
      return { settings: null, preferences: null };
    }
    const settings =
      parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : null;
    const preferences =
      parsed.preferences && typeof parsed.preferences === 'object'
        ? parsed.preferences
        : null;
    return { settings, preferences };
  }

  saveSettings(settings: BatchSettings, preferences: UiPreferences): void {
    const payload: PersistedSettingsFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      settings,
      preferences,
    };
    try {
      writeJsonAtomicSync(this.settingsPath, payload, 0o600);
    } catch (err) {
      console.warn('[PersistenceStore] Failed to save settings:', err);
    }
  }

  loadState(): PersistedAppState | null {
    const parsed = readJsonFileSync<Partial<PersistedAppState>>(this.statePath);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      archive: Array.isArray(parsed.archive) ? parsed.archive : [],
      itemDiskFiles:
        parsed.itemDiskFiles && typeof parsed.itemDiskFiles === 'object'
          ? parsed.itemDiskFiles
          : {},
      archiveDiskFiles:
        parsed.archiveDiskFiles && typeof parsed.archiveDiskFiles === 'object'
          ? parsed.archiveDiskFiles
          : {},
    };
  }

  saveState(state: Omit<PersistedAppState, 'version' | 'updatedAt'>): void {
    const payload: PersistedAppState = {
      version: 1,
      updatedAt: new Date().toISOString(),
      ...state,
    };
    try {
      writeJsonAtomicSync(this.statePath, payload, 0o600);
    } catch (err) {
      console.warn('[PersistenceStore] Failed to save state:', err);
    }
  }
}
