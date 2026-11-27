import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  generateConfigYaml,
  shouldSkipIncremental,
  summarizeJobItems,
} from '../src/lib/batchRules';
import { renderNamingTemplate } from '../src/lib/naming';
import { parseBatchInput, resolveParsedLinks } from '../src/lib/urlParser';
import {
  DEFAULT_BATCH_SETTINGS,
  DEFAULT_UI_PREFERENCES,
  type ArchiveItem,
  type BatchJob,
  type BatchSettings,
  type DiscoveredWork,
  type DownloadMode,
  type JobItem,
  type ParsedLink,
  type UiPreferences,
} from '../src/lib/types';
import {
  discoverWorksForLink,
  type CreatorProfileSummary,
} from './douyinScraper';
import {
  downloadAwemeMediaToDisk,
  type DownloadedFileRecord,
} from './mediaDownloader';
import { PersistenceStore, resolveDefaultDataDir } from './persistence';

const MAX_PERSISTED_JOBS = 200;
const MAX_DRAFT_INPUT_LENGTH = 200_000;
const VALID_MODES = new Set<DownloadMode>([
  'post',
  'like',
  'mix',
  'music',
  'collect',
]);

function toFiniteNumber(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeSettings(
  partial: Partial<BatchSettings>,
  base: BatchSettings,
): BatchSettings {
  const merged: BatchSettings = {
    ...base,
    ...partial,
  };

  const validModes = Array.isArray(merged.modes)
    ? merged.modes.filter((m): m is DownloadMode => VALID_MODES.has(m))
    : [];

  return {
    ...merged,
    downloadPath:
      typeof merged.downloadPath === 'string' && merged.downloadPath.trim()
        ? merged.downloadPath.trim()
        : base.downloadPath,
    modes: validModes.length > 0 ? Array.from(new Set(validModes)) : base.modes,
    concurrency: Math.min(
      12,
      Math.max(1, Math.round(toFiniteNumber(merged.concurrency, base.concurrency))),
    ),
    retryTimes: Math.min(
      10,
      Math.max(0, Math.round(toFiniteNumber(merged.retryTimes, base.retryTimes))),
    ),
    rateLimitPerSec: Math.min(
      20,
      Math.max(0.5, toFiniteNumber(merged.rateLimitPerSec, base.rateLimitPerSec)),
    ),
    maxItemsPerMode: Math.max(
      0,
      Math.round(toFiniteNumber(merged.maxItemsPerMode, base.maxItemsPerMode)),
    ),
    startDate: typeof merged.startDate === 'string' ? merged.startDate : '',
    endDate: typeof merged.endDate === 'string' ? merged.endDate : '',
    cookieString: typeof merged.cookieString === 'string' ? merged.cookieString : '',
    proxyUrl: typeof merged.proxyUrl === 'string' ? merged.proxyUrl : '',
  };
}

function normalizePreferences(
  partial: Partial<UiPreferences>,
  base: UiPreferences,
): UiPreferences {
  const theme =
    partial.theme === 'dark' || partial.theme === 'light'
      ? partial.theme
      : base.theme;
  const draftInput =
    typeof partial.draftInput === 'string'
      ? partial.draftInput.slice(0, MAX_DRAFT_INPUT_LENGTH)
      : base.draftInput;
  return { theme, draftInput };
}

function isValidDiskFileRecord(entry: unknown): entry is DownloadedFileRecord {
  if (!entry || typeof entry !== 'object') return false;
  const rec = entry as Partial<DownloadedFileRecord>;
  return (
    typeof rec.filename === 'string' &&
    typeof rec.absolutePath === 'string' &&
    typeof rec.relativePath === 'string' &&
    typeof rec.kind === 'string' &&
    typeof rec.sizeBytes === 'number'
  );
}

function buildArtifactLabels(work: DiscoveredWork, settings: BatchSettings): string[] {
  const list: string[] = [];
  if (work.type === 'gallery' && work.imageUrls.length > 0) {
    list.push(`${work.imageUrls.length} 张无水印原图`);
  } else if (settings.includeVideo && work.videoUrl) {
    list.push(`MP4 视频 (${settings.videoQuality})`);
  }
  if (settings.includeCover && work.coverUrl) list.push('高清封面');
  if (settings.includeMusic && work.musicUrl) list.push('背景音乐');
  if (settings.includeAvatar && work.avatarUrl) list.push('作者头像');
  if (settings.includeJson) list.push('元数据 JSON');
  return list.length > 0 ? list : ['元数据 JSON'];
}

export class BatchJobStore {
  private settings: BatchSettings = {
    ...DEFAULT_BATCH_SETTINGS,
    cookieString: process.env.DOUYIN_COOKIE || '',
    proxyUrl: process.env.DOUYIN_PROXY || '',
  };
  private preferences: UiPreferences = { ...DEFAULT_UI_PREFERENCES };
  private jobs = new Map<string, BatchJob>();
  private archive = new Map<string, ArchiveItem>();
  private itemDiskFiles = new Map<string, DownloadedFileRecord[]>();
  private archiveDiskFiles = new Map<string, DownloadedFileRecord[]>();
  private jobAbortControllers = new Map<string, AbortController>();
  private cancelledJobs = new Set<string>();
  private persistence: PersistenceStore | null = null;
  private initialized = false;

  constructor(options?: { dataDir?: string }) {
    if (options?.dataDir) {
      this.configurePersistence(options.dataDir);
    }
  }

  configurePersistence(dataDir?: string): string {
    const resolvedDir = dataDir ? path.resolve(dataDir) : resolveDefaultDataDir();
    if (this.initialized && this.persistence?.getDataDir() === resolvedDir) {
      return resolvedDir;
    }
    this.persistence = new PersistenceStore(resolvedDir);
    this.initialized = true;
    this.loadFromDisk();
    return resolvedDir;
  }

  getDataDir(): string {
    this.ensureInitialized();
    return this.persistence!.getDataDir();
  }

  flush(): void {
    if (!this.initialized || !this.persistence) return;
    this.persistSettingsNow();
    this.persistStateNow();
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      this.configurePersistence();
    }
  }

  private loadFromDisk(): void {
    const store = this.persistence;
    if (!store) return;

    this.jobs.clear();
    this.archive.clear();
    this.itemDiskFiles.clear();
    this.archiveDiskFiles.clear();
    this.jobAbortControllers.clear();
    this.cancelledJobs.clear();

    const envDefaults: BatchSettings = {
      ...DEFAULT_BATCH_SETTINGS,
      cookieString: process.env.DOUYIN_COOKIE || '',
      proxyUrl: process.env.DOUYIN_PROXY || '',
    };

    const { settings: savedSettings, preferences: savedPrefs } = store.loadSettings();
    if (savedSettings) {
      this.settings = normalizeSettings(savedSettings, DEFAULT_BATCH_SETTINGS);
    } else {
      this.settings = envDefaults;
    }

    if (savedPrefs) {
      this.preferences = normalizePreferences(savedPrefs, DEFAULT_UI_PREFERENCES);
    } else {
      this.preferences = { ...DEFAULT_UI_PREFERENCES };
    }

    const savedState = store.loadState();
    if (!savedState) return;

    for (const [awemeId, files] of Object.entries(savedState.archiveDiskFiles)) {
      if (Array.isArray(files)) {
        const valid = files.filter(isValidDiskFileRecord);
        if (valid.length > 0) {
          this.archiveDiskFiles.set(awemeId, valid);
        }
      }
    }

    for (const [key, files] of Object.entries(savedState.itemDiskFiles)) {
      if (Array.isArray(files)) {
        const valid = files.filter(isValidDiskFileRecord);
        if (valid.length > 0) {
          this.itemDiskFiles.set(key, valid);
        }
      }
    }

    for (const item of savedState.archive) {
      if (!item || typeof item.awemeId !== 'string' || !item.awemeId) continue;
      const diskFiles = this.archiveDiskFiles.get(item.awemeId) || [];
      this.archive.set(item.awemeId, {
        ...item,
        savedFiles: Array.isArray(item.savedFiles) ? item.savedFiles : [],
        artifacts: Array.isArray(item.artifacts) ? item.artifacts : [],
        filePresent:
          diskFiles.length > 0
            ? diskFiles.some((f) => fs.existsSync(f.absolutePath))
            : Boolean(item.filePresent),
      });
    }

    const now = new Date().toISOString();
    let needsResave = false;

    const sortedJobs = savedState.jobs
      .filter((job): job is BatchJob => Boolean(job && typeof job.jobId === 'string'))
      .sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
      .slice(0, MAX_PERSISTED_JOBS);

    for (const rawJob of sortedJobs) {
      const items: JobItem[] = Array.isArray(rawJob.items)
        ? rawJob.items.map((rawItem) => {
            const item: JobItem = {
              ...rawItem,
              savedFiles: Array.isArray(rawItem.savedFiles) ? rawItem.savedFiles : [],
              artifacts: Array.isArray(rawItem.artifacts) ? rawItem.artifacts : [],
            };

            if (item.status === 'running' || item.status === 'pending') {
              item.status = 'cancelled';
              item.progress = 0;
              item.downloadReady = false;
              item.message = '上次应用退出导致下载中断，可点击「重试失败项」继续';
              item.updatedAt = now;
              needsResave = true;
            } else if (item.status === 'success' || item.status === 'skipped') {
              const directFiles =
                this.itemDiskFiles.get(`${rawJob.jobId}:${item.itemId}`) ||
                this.archiveDiskFiles.get(item.awemeId) ||
                [];
              item.downloadReady = directFiles.some((f) => fs.existsSync(f.absolutePath));
            }
            return item;
          })
        : [];

      const job: BatchJob = {
        ...rawJob,
        sourceUrls: Array.isArray(rawJob.sourceUrls) ? rawJob.sourceUrls : [],
        warnings: Array.isArray(rawJob.warnings) ? rawJob.warnings : [],
        items,
      };

      if (job.status === 'running' || job.status === 'pending') {
        this.refreshJobSummary(job);
        if (
          job.items.length > 0 &&
          job.failed === 0 &&
          job.items.every((i) => i.status === 'success' || i.status === 'skipped')
        ) {
          job.status = 'success';
        } else if (job.success > 0 || job.skipped > 0) {
          job.status = 'partial';
        } else {
          job.status = 'cancelled';
        }
        job.finishedAt = job.finishedAt || now;
        needsResave = true;
      } else {
        this.refreshJobSummary(job);
      }

      this.jobs.set(job.jobId, job);
    }

    if (needsResave) {
      this.persistStateNow();
    }
  }

  private persistSettingsNow(): void {
    if (!this.persistence) return;
    this.persistence.saveSettings(this.settings, this.preferences);
  }

  private persistStateNow(): void {
    if (!this.persistence) return;

    const sortedJobs = Array.from(this.jobs.values())
      .sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
      .slice(0, MAX_PERSISTED_JOBS);

    const activeJobIds = new Set(sortedJobs.map((j) => j.jobId));
    const itemDiskFilesObj: Record<string, DownloadedFileRecord[]> = {};
    for (const [key, files] of this.itemDiskFiles.entries()) {
      const jobId = key.split(':')[0];
      if (activeJobIds.has(jobId) && files.length > 0) {
        itemDiskFilesObj[key] = files;
      }
    }

    const archiveDiskFilesObj: Record<string, DownloadedFileRecord[]> = {};
    for (const [awemeId, files] of this.archiveDiskFiles.entries()) {
      if (this.archive.has(awemeId) && files.length > 0) {
        archiveDiskFilesObj[awemeId] = files;
      }
    }

    this.persistence.saveState({
      jobs: sortedJobs,
      archive: Array.from(this.archive.values()),
      itemDiskFiles: itemDiskFilesObj,
      archiveDiskFiles: archiveDiskFilesObj,
    });
  }

  getSettings(): BatchSettings {
    this.ensureInitialized();
    return { ...this.settings };
  }

  updateSettings(partial: Partial<BatchSettings>): BatchSettings {
    this.ensureInitialized();
    this.settings = normalizeSettings(partial, this.settings);
    this.persistSettingsNow();
    return this.getSettings();
  }

  getPreferences(): UiPreferences {
    this.ensureInitialized();
    return { ...this.preferences };
  }

  updatePreferences(partial: Partial<UiPreferences>): UiPreferences {
    this.ensureInitialized();
    this.preferences = normalizePreferences(partial, this.preferences);
    this.persistSettingsNow();
    return this.getPreferences();
  }

  listJobs(): BatchJob[] {
    this.ensureInitialized();
    return Array.from(this.jobs.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  getJob(jobId: string): BatchJob | undefined {
    this.ensureInitialized();
    return this.jobs.get(jobId);
  }

  deleteJob(jobId: string): boolean {
    this.ensureInitialized();
    this.cancelJob(jobId);
    const job = this.jobs.get(jobId);
    if (job) {
      for (const item of job.items) {
        this.itemDiskFiles.delete(`${jobId}:${item.itemId}`);
      }
    }
    const deleted = this.jobs.delete(jobId);
    if (deleted) {
      this.persistStateNow();
    }
    return deleted;
  }

  listArchive(): ArchiveItem[] {
    this.ensureInitialized();
    for (const [awemeId, arch] of this.archive.entries()) {
      const files = this.archiveDiskFiles.get(awemeId) || [];
      if (files.length > 0) {
        arch.filePresent = files.some((f) => fs.existsSync(f.absolutePath));
      }
    }
    return Array.from(this.archive.values()).sort(
      (a, b) =>
        new Date(b.downloadedAt).getTime() - new Date(a.downloadedAt).getTime(),
    );
  }

  deleteArchiveItem(awemeId: string): boolean {
    this.ensureInitialized();
    this.archiveDiskFiles.delete(awemeId);
    const deleted = this.archive.delete(awemeId);
    if (deleted) {
      this.persistStateNow();
    }
    return deleted;
  }

  toggleArchiveFilePresent(awemeId: string): ArchiveItem | undefined {
    this.ensureInitialized();
    const existing = this.archive.get(awemeId);
    if (!existing) return undefined;
    const updated: ArchiveItem = {
      ...existing,
      filePresent: !existing.filePresent,
    };
    this.archive.set(awemeId, updated);
    this.persistStateNow();
    return updated;
  }

  getItemFiles(jobId: string, itemId: string): DownloadedFileRecord[] {
    this.ensureInitialized();
    const direct = this.itemDiskFiles.get(`${jobId}:${itemId}`);
    if (direct && direct.length > 0) return direct;
    const job = this.jobs.get(jobId);
    const item = job?.items.find((i) => i.itemId === itemId);
    if (item) {
      return this.archiveDiskFiles.get(item.awemeId) || [];
    }
    return [];
  }

  getJobAllFiles(jobId: string): DownloadedFileRecord[] {
    this.ensureInitialized();
    const job = this.jobs.get(jobId);
    if (!job) return [];
    const seenPaths = new Set<string>();
    const all: DownloadedFileRecord[] = [];
    for (const item of job.items) {
      const files = this.getItemFiles(jobId, item.itemId);
      for (const f of files) {
        if (!seenPaths.has(f.absolutePath) && fs.existsSync(f.absolutePath)) {
          seenPaths.add(f.absolutePath);
          all.push(f);
        }
      }
    }
    return all;
  }

  getArchiveFiles(awemeId: string): DownloadedFileRecord[] {
    this.ensureInitialized();
    return (this.archiveDiskFiles.get(awemeId) || []).filter((f) =>
      fs.existsSync(f.absolutePath),
    );
  }

  async discoverFromText(
    rawText: string,
    overrideSettings?: Partial<BatchSettings>,
  ): Promise<{
    links: ParsedLink[];
    works: DiscoveredWork[];
    profiles: CreatorProfileSummary[];
    warnings: string[];
    requiresCookie: boolean;
  }> {
    this.ensureInitialized();
    const merged: BatchSettings =
      overrideSettings && Object.keys(overrideSettings).length > 0
        ? this.updateSettings(overrideSettings)
        : this.getSettings();
    const { links } = parseBatchInput(rawText);

    const resolvedLinks: ParsedLink[] = await resolveParsedLinks(links, {
      cookieString: merged.cookieString,
      maxRedirects: 5,
      timeoutMs: 4500,
    });

    const worksMap = new Map<string, DiscoveredWork>();
    const profiles: CreatorProfileSummary[] = [];
    const warnings: string[] = [];
    let requiresCookie = false;

    for (const link of resolvedLinks) {
      const result = await discoverWorksForLink(link, merged);
      if (result.profile) profiles.push(result.profile);
      if (result.requiresCookie) requiresCookie = true;
      warnings.push(...result.warnings);
      for (const w of result.works) {
        if (!worksMap.has(w.awemeId)) {
          worksMap.set(w.awemeId, w);
        }
      }
    }

    return {
      links: resolvedLinks,
      works: Array.from(worksMap.values()),
      profiles,
      warnings,
      requiresCookie,
    };
  }

  async createJob(
    input: {
      urls?: string[];
      works?: DiscoveredWork[];
    },
    overrideSettings?: Partial<BatchSettings>,
  ): Promise<BatchJob> {
    this.ensureInitialized();
    const merged: BatchSettings =
      overrideSettings && Object.keys(overrideSettings).length > 0
        ? this.updateSettings(overrideSettings)
        : this.getSettings();

    const jobId = `job-${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    let discoveredWorks: DiscoveredWork[] = [];
    const warnings: string[] = [];
    const sourceUrls: string[] = Array.isArray(input.urls) ? input.urls : [];

    if (Array.isArray(input.works) && input.works.length > 0) {
      discoveredWorks = input.works;
    } else if (sourceUrls.length > 0) {
      const discovery = await this.discoverFromText(sourceUrls.join('\n'), merged);
      discoveredWorks = discovery.works;
      warnings.push(...discovery.warnings);
    }

    const archivedIds = new Set(this.archive.keys());
    const items: JobItem[] = discoveredWorks.map((work, idx) => {
      const archived = this.archive.get(work.awemeId);
      const existingDiskFiles = this.archiveDiskFiles.get(work.awemeId) || [];
      const hasFileOnDisk =
        Boolean(archived?.filePresent) &&
        existingDiskFiles.some((f) => fs.existsSync(f.absolutePath));

      const skip = shouldSkipIncremental(work.awemeId, archivedIds, {
        incremental: merged.incremental,
        redownloadMissingFiles: merged.redownloadMissingFiles,
        fileExistsOnDisk: hasFileOnDisk,
      });

      const filename = renderNamingTemplate(merged.filenameTemplate, {
        id: work.awemeId,
        title: work.title,
        author: work.author,
        author_id: work.authorId,
        date: work.publishDate,
        timestamp: work.publishTs,
        type: work.type,
        mode: work.mode,
      });
      const folderName = renderNamingTemplate(merged.folderTemplate, {
        id: work.awemeId,
        title: work.title,
        author: work.author,
        author_id: work.authorId,
        date: work.publishDate,
        timestamp: work.publishTs,
        type: work.type,
        mode: work.mode,
      });

      if (skip && existingDiskFiles.length > 0) {
        this.itemDiskFiles.set(`${jobId}:${jobId}-${idx + 1}`, existingDiskFiles);
      }

      return {
        itemId: `${jobId}-${idx + 1}`,
        awemeId: work.awemeId,
        sourceUrl: work.sourceUrl,
        resolvedUrl: work.sourceUrl,
        type: work.type,
        mode: work.mode,
        title: work.title,
        author: work.author,
        authorId: work.authorId,
        publishDate: work.publishDate,
        quality: merged.videoQuality,
        sizeBytes: work.sizeBytes || archived?.sizeBytes || 0,
        filename,
        folderName,
        status: skip ? 'skipped' : 'pending',
        progress: skip ? 100 : 0,
        retries: 0,
        message: skip ? '增量去重命中，本地文件已完整存在' : '等待并发队列下载媒体文件',
        upstreamStatus: 'live',
        mediaUrl: work.videoUrl,
        imageUrls: work.imageUrls,
        coverUrl: work.coverUrl,
        musicUrl: work.musicUrl,
        avatarUrl: work.avatarUrl,
        artifacts: buildArtifactLabels(work, merged),
        savedFiles: skip
          ? existingDiskFiles.map((f) => ({
              kind: f.kind,
              filename: f.filename,
              relativePath: f.relativePath,
              sizeBytes: f.sizeBytes,
            }))
          : [],
        downloadReady: skip && hasFileOnDisk,
        updatedAt: now,
      };
    });

    const summary = summarizeJobItems(items);
    const { cookieString: _ignored, ...safeSnapshot } = merged;
    void _ignored;

    const job: BatchJob = {
      jobId,
      label:
        items.length > 0
          ? `真实批量下载（${items.length} 个作品：${items.filter((i) => i.type === 'video').length} 视频 / ${items.filter((i) => i.type === 'gallery').length} 图文）`
          : `解析任务（未获取到可下载作品）`,
      createdAt: now,
      status:
        items.length === 0
          ? 'failed'
          : items.some((i) => i.status === 'pending')
            ? 'pending'
            : 'success',
      sourceUrls:
        sourceUrls.length > 0
          ? sourceUrls
          : discoveredWorks.map((w) => w.sourceUrl),
      warnings,
      settingsSnapshot: {
        ...safeSnapshot,
        hasCookie: Boolean(merged.cookieString.trim()),
      },
      items,
      ...summary,
      downloadableCount: items.filter((i) => i.downloadReady).length,
    };

    this.jobs.set(jobId, job);

    if (items.some((i) => i.status === 'pending')) {
      this.persistStateNow();
      void this.runJobWorkerPool(jobId, merged);
    } else {
      job.finishedAt = new Date().toISOString();
      this.persistStateNow();
    }

    return job;
  }

  private refreshJobSummary(job: BatchJob) {
    const summary = summarizeJobItems(job.items);
    job.total = summary.total;
    job.success = summary.success;
    job.skipped = summary.skipped;
    job.failed = summary.failed;
    job.pending = summary.pending;
    job.running = summary.running;
    job.progressPercent = summary.progressPercent;
    job.downloadableCount = job.items.filter((i) => i.downloadReady).length;
  }

  private async runJobWorkerPool(jobId: string, settings: BatchSettings) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    this.cancelledJobs.delete(jobId);
    const controller = new AbortController();
    this.jobAbortControllers.set(jobId, controller);

    job.status = 'running';
    job.startedAt = job.startedAt || new Date().toISOString();
    this.persistStateNow();

    const pendingItems = job.items.filter((i) => i.status === 'pending');
    let cursor = 0;

    const worker = async () => {
      while (cursor < pendingItems.length) {
        if (this.cancelledJobs.has(jobId) || controller.signal.aborted) {
          return;
        }
        const item = pendingItems[cursor];
        cursor += 1;
        await this.downloadSingleItem(job, item, settings, controller.signal);
      }
    };

    const poolSize = Math.min(
      Math.max(1, settings.concurrency),
      Math.max(1, pendingItems.length),
    );
    await Promise.all(Array.from({ length: poolSize }, () => worker()));
    this.jobAbortControllers.delete(jobId);

    if (this.cancelledJobs.has(jobId)) {
      for (const item of job.items) {
        if (item.status === 'pending' || item.status === 'running') {
          item.status = 'cancelled';
          item.message = '任务已手动取消';
          item.updatedAt = new Date().toISOString();
        }
      }
      this.refreshJobSummary(job);
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      this.persistStateNow();
      return;
    }

    this.refreshJobSummary(job);
    job.finishedAt = new Date().toISOString();
    if (job.failed === 0) {
      job.status = 'success';
    } else if (job.success > 0 || job.skipped > 0) {
      job.status = 'partial';
    } else {
      job.status = 'failed';
    }
    this.persistStateNow();
  }

  private async downloadSingleItem(
    job: BatchJob,
    item: JobItem,
    settings: BatchSettings,
    signal: AbortSignal,
  ) {
    item.status = 'running';
    item.progress = 5;
    item.message = '正在建立抖音 CDN 连接...';
    item.updatedAt = new Date().toISOString();
    this.refreshJobSummary(job);

    const maxAttempts = Math.max(1, settings.retryTimes + 1);
    let lastError = '下载失败';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (signal.aborted || this.cancelledJobs.has(job.jobId)) return;
      try {
        const result = await downloadAwemeMediaToDisk(
          {
            awemeId: item.awemeId,
            title: item.title,
            author: item.author,
            authorId: item.authorId,
            publishDate: item.publishDate,
            publishTs: 0,
            mediaType: item.type,
            videoUrl: item.mediaUrl,
            imageUrls: item.imageUrls || [],
            coverUrl: item.coverUrl,
            musicUrl: item.musicUrl,
            avatarUrl: item.avatarUrl,
            sizeBytes: item.sizeBytes,
          },
          item.filename,
          item.folderName,
          settings,
          {
            signal,
            onProgress: (percent, message) => {
              item.progress = percent;
              item.message = message;
              item.updatedAt = new Date().toISOString();
              this.refreshJobSummary(job);
            },
          },
        );

        this.itemDiskFiles.set(`${job.jobId}:${item.itemId}`, result.files);
        this.archiveDiskFiles.set(item.awemeId, result.files);

        const savedMeta = result.files.map((f) => ({
          kind: f.kind,
          filename: f.filename,
          relativePath: f.relativePath,
          sizeBytes: f.sizeBytes,
        }));

        const relOutputDir = path.relative(process.cwd(), result.outputDir);
        const displayOutputDir =
          relOutputDir && !relOutputDir.startsWith('..')
            ? relOutputDir
            : result.outputDir;

        item.sizeBytes = result.totalBytes;
        item.savedFiles = savedMeta;
        item.downloadReady = result.files.length > 0;
        item.status = 'success';
        item.progress = 100;
        item.message = `已真实下载 ${result.files.length} 个文件至 ${displayOutputDir}`;
        item.updatedAt = new Date().toISOString();

        this.archive.set(item.awemeId, {
          awemeId: item.awemeId,
          title: item.title,
          author: item.author,
          authorId: item.authorId,
          type: item.type,
          mode: item.mode,
          publishDate: item.publishDate,
          downloadedAt: item.updatedAt,
          quality: item.quality,
          sizeBytes: result.totalBytes,
          filename: item.filename,
          folderName: item.folderName,
          sourceUrl: item.sourceUrl,
          artifacts: item.artifacts,
          savedFiles: savedMeta,
          filePresent: true,
        });

        this.refreshJobSummary(job);
        this.persistStateNow();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : 'CDN 下载异常';
        if (attempt < maxAttempts && !signal.aborted) {
          item.retries = attempt;
          item.message = `下载失败（${lastError}），准备第 ${attempt} 次重试...`;
          item.updatedAt = new Date().toISOString();
          await new Promise((r) => setTimeout(r, 800 * attempt));
        }
      }
    }

    item.status = 'failed';
    item.progress = 0;
    item.downloadReady = false;
    item.message = lastError;
    item.updatedAt = new Date().toISOString();
    this.refreshJobSummary(job);
    this.persistStateNow();
  }

  cancelJob(jobId: string): BatchJob | undefined {
    this.ensureInitialized();
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    this.cancelledJobs.add(jobId);
    this.jobAbortControllers.get(jobId)?.abort();
    if (job.status === 'pending' || job.status === 'running') {
      for (const item of job.items) {
        if (item.status === 'pending' || item.status === 'running') {
          item.status = 'cancelled';
          item.message = '任务已手动取消';
          item.updatedAt = new Date().toISOString();
        }
      }
      this.refreshJobSummary(job);
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      this.persistStateNow();
    }
    return job;
  }

  retryFailedItems(jobId: string): BatchJob | undefined {
    this.ensureInitialized();
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    let retried = 0;
    for (const item of job.items) {
      if (item.status === 'failed' || item.status === 'cancelled') {
        item.status = 'pending';
        item.progress = 0;
        item.retries += 1;
        item.message = `第 ${item.retries} 次手动重试排队中`;
        item.updatedAt = new Date().toISOString();
        retried += 1;
      }
    }
    if (retried > 0) {
      this.refreshJobSummary(job);
      job.finishedAt = undefined;
      this.persistStateNow();
      void this.runJobWorkerPool(jobId, {
        ...job.settingsSnapshot,
        cookieString: this.settings.cookieString,
      });
    }
    return job;
  }

  exportJobContent(
    jobId: string,
    format: 'yaml' | 'jsonl' | 'manifest',
  ): { filename: string; contentType: string; body: string } | null {
    this.ensureInitialized();
    const job = this.jobs.get(jobId);
    if (!job) return null;

    if (format === 'yaml') {
      const yaml = generateConfigYaml(job.sourceUrls, {
        ...job.settingsSnapshot,
        cookieString: this.settings.cookieString,
      });
      return {
        filename: `config-${job.jobId}.yml`,
        contentType: 'text/yaml; charset=utf-8',
        body: yaml,
      };
    }

    if (format === 'jsonl') {
      const lines = job.items.map((item) => JSON.stringify(item)).join('\n');
      return {
        filename: `manifest-${job.jobId}.jsonl`,
        contentType: 'application/x-ndjson; charset=utf-8',
        body: `${lines}\n`,
      };
    }

    return {
      filename: `batch-${job.jobId}.json`,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(job, null, 2),
    };
  }
}

export const jobStore = new BatchJobStore();
