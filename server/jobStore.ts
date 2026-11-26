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
  type ArchiveItem,
  type BatchJob,
  type BatchSettings,
  type DiscoveredWork,
  type JobItem,
  type ParsedLink,
} from '../src/lib/types';
import {
  discoverWorksForLink,
  type CreatorProfileSummary,
} from './douyinScraper';
import {
  downloadAwemeMediaToDisk,
  type DownloadedFileRecord,
} from './mediaDownloader';

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

class BatchJobStore {
  private settings: BatchSettings = {
    ...DEFAULT_BATCH_SETTINGS,
    cookieString: process.env.DOUYIN_COOKIE || '',
    proxyUrl: process.env.DOUYIN_PROXY || '',
  };
  private jobs = new Map<string, BatchJob>();
  private archive = new Map<string, ArchiveItem>();
  private itemDiskFiles = new Map<string, DownloadedFileRecord[]>();
  private archiveDiskFiles = new Map<string, DownloadedFileRecord[]>();
  private jobAbortControllers = new Map<string, AbortController>();
  private cancelledJobs = new Set<string>();

  getSettings(): BatchSettings {
    return { ...this.settings };
  }

  updateSettings(partial: Partial<BatchSettings>): BatchSettings {
    this.settings = {
      ...this.settings,
      ...partial,
      concurrency: Math.min(
        12,
        Math.max(1, Number(partial.concurrency ?? this.settings.concurrency) || 3),
      ),
      retryTimes: Math.min(
        10,
        Math.max(0, Number(partial.retryTimes ?? this.settings.retryTimes) || 3),
      ),
      rateLimitPerSec: Math.min(
        20,
        Math.max(
          0.5,
          Number(partial.rateLimitPerSec ?? this.settings.rateLimitPerSec) || 2,
        ),
      ),
      maxItemsPerMode: Math.max(
        0,
        Number(partial.maxItemsPerMode ?? this.settings.maxItemsPerMode) || 0,
      ),
    };
    return this.getSettings();
  }

  listJobs(): BatchJob[] {
    return Array.from(this.jobs.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  getJob(jobId: string): BatchJob | undefined {
    return this.jobs.get(jobId);
  }

  deleteJob(jobId: string): boolean {
    this.cancelJob(jobId);
    const job = this.jobs.get(jobId);
    if (job) {
      for (const item of job.items) {
        this.itemDiskFiles.delete(`${jobId}:${item.itemId}`);
      }
    }
    return this.jobs.delete(jobId);
  }

  listArchive(): ArchiveItem[] {
    for (const [awemeId, arch] of this.archive.entries()) {
      const files = this.archiveDiskFiles.get(awemeId) || [];
      arch.filePresent = files.some((f) => fs.existsSync(f.absolutePath));
    }
    return Array.from(this.archive.values()).sort(
      (a, b) =>
        new Date(b.downloadedAt).getTime() - new Date(a.downloadedAt).getTime(),
    );
  }

  deleteArchiveItem(awemeId: string): boolean {
    this.archiveDiskFiles.delete(awemeId);
    return this.archive.delete(awemeId);
  }

  toggleArchiveFilePresent(awemeId: string): ArchiveItem | undefined {
    const existing = this.archive.get(awemeId);
    if (!existing) return undefined;
    const updated: ArchiveItem = {
      ...existing,
      filePresent: !existing.filePresent,
    };
    this.archive.set(awemeId, updated);
    return updated;
  }

  getItemFiles(jobId: string, itemId: string): DownloadedFileRecord[] {
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
    const merged: BatchSettings = {
      ...this.settings,
      ...(overrideSettings || {}),
    };
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
    const merged: BatchSettings = {
      ...this.settings,
      ...(overrideSettings || {}),
    };
    if (overrideSettings?.cookieString !== undefined) {
      this.settings.cookieString = overrideSettings.cookieString;
    }

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
      void this.runJobWorkerPool(jobId, merged);
    } else {
      job.finishedAt = new Date().toISOString();
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

        item.sizeBytes = result.totalBytes;
        item.savedFiles = savedMeta;
        item.downloadReady = result.files.length > 0;
        item.status = 'success';
        item.progress = 100;
        item.message = `已真实下载 ${result.files.length} 个文件至 ${path.relative(process.cwd(), result.outputDir)}`;
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
  }

  cancelJob(jobId: string): BatchJob | undefined {
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
    }
    return job;
  }

  retryFailedItems(jobId: string): BatchJob | undefined {
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
