import type { BatchSettings, JobItem } from './types';

export function isWithinDateRange(
  publishDate: string,
  startDate?: string,
  endDate?: string,
): boolean {
  if (!publishDate) return true;
  const normalized = publishDate.slice(0, 10);
  if (startDate && startDate.trim() && normalized < startDate.trim()) {
    return false;
  }
  if (endDate && endDate.trim() && normalized > endDate.trim()) {
    return false;
  }
  return true;
}

export function shouldSkipIncremental(
  awemeId: string,
  archivedIds: Set<string>,
  options: {
    incremental: boolean;
    redownloadMissingFiles: boolean;
    fileExistsOnDisk: boolean;
  },
): boolean {
  if (!options.incremental) return false;
  if (!archivedIds.has(awemeId)) return false;
  if (options.redownloadMissingFiles) {
    return options.fileExistsOnDisk;
  }
  return true;
}

export function summarizeJobItems(items: JobItem[]) {
  let success = 0;
  let skipped = 0;
  let failed = 0;
  let pending = 0;
  let running = 0;
  let totalProgress = 0;

  for (const item of items) {
    if (item.status === 'success') success += 1;
    else if (item.status === 'skipped') skipped += 1;
    else if (item.status === 'failed' || item.status === 'cancelled') failed += 1;
    else if (item.status === 'running') running += 1;
    else pending += 1;

    totalProgress += item.progress;
  }

  const total = items.length;
  const progressPercent = total > 0 ? Math.round(totalProgress / total) : 0;

  return {
    total,
    success,
    skipped,
    failed,
    pending,
    running,
    progressPercent,
  };
}

function escapeYamlString(val: string): string {
  const safe = val.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${safe}"`;
}

export function generateConfigYaml(
  links: string[],
  settings: BatchSettings,
): string {
  const effectiveLinks =
    links.length > 0
      ? links
      : ['https://www.douyin.com/user/MS4wLjABAAAA6O7EZyfDRYXxJrUTpf91K3tmB4rBROkAw-nYMfld8ss'];

  const linkLines = effectiveLinks.map((u) => `  - ${u}`).join('\n');
  const modeLines = (settings.modes.length > 0 ? settings.modes : ['post'])
    .map((m) => `  - ${m}`)
    .join('\n');

  const lines = [
    '# 由 抖存批量工作台（免内测码开源版）生成',
    '# 兼容 douyin-downloader CLI 引擎',
    'link:',
    linkLines,
    '',
    `path: ${settings.downloadPath || './Downloaded/'}`,
    '',
    `video: ${settings.includeVideo}`,
    `music: ${settings.includeMusic}`,
    `cover: ${settings.includeCover}`,
    `avatar: ${settings.includeAvatar}`,
    `json: ${settings.includeJson}`,
    '',
    `start_time: ${escapeYamlString(settings.startDate || '')}`,
    `end_time: ${escapeYamlString(settings.endDate || '')}`,
    '',
    `folderstyle: ${settings.folderStyle}`,
    `filename_template: ${escapeYamlString(settings.filenameTemplate)}`,
    `folder_template: ${escapeYamlString(settings.folderTemplate)}`,
    `author_dir: ${escapeYamlString(settings.authorDir)}`,
    `download_pinned: ${settings.downloadPinned}`,
    '',
    'mode:',
    modeLines,
    '',
    'number:',
    `  post: ${settings.maxItemsPerMode}`,
    `  like: ${settings.maxItemsPerMode}`,
    `  mix: ${settings.maxItemsPerMode}`,
    `  music: ${settings.maxItemsPerMode}`,
    `  collect: ${settings.maxItemsPerMode}`,
    '',
    `redownload_missing_files: ${settings.redownloadMissingFiles}`,
    '',
    'increase:',
    `  post: ${settings.incremental}`,
    `  like: ${settings.incremental}`,
    `  mix: ${settings.incremental}`,
    `  music: ${settings.incremental}`,
    '',
    `thread: ${settings.concurrency}`,
    `retry_times: ${settings.retryTimes}`,
    `rate_limit: ${settings.rateLimitPerSec}`,
    `proxy: ${escapeYamlString(settings.proxyUrl || '')}`,
    'database: true',
    'database_path: dy_downloader.db',
    `video_quality: ${settings.videoQuality}`,
    '',
    'comments:',
    `  enabled: ${settings.includeComments}`,
    '  include_replies: false',
    '  max_comments: 0',
    '  page_size: 20',
  ];

  if (settings.cookieString.trim()) {
    lines.push('', `cookies: ${escapeYamlString(settings.cookieString.trim())}`);
  }

  return `${lines.join('\n')}\n`;
}

export function generateCliCommand(
  links: string[],
  settings: BatchSettings,
): string {
  const args = ['douyin-dl', '-c', 'config.yml', '-t', String(settings.concurrency)];
  if (settings.downloadPath && settings.downloadPath !== './Downloaded/') {
    args.push('-p', `"${settings.downloadPath}"`);
  }
  for (const url of links.slice(0, 3)) {
    args.push('-u', `"${url}"`);
  }
  if (links.length > 3) {
    args.push(`# 其余 ${links.length - 3} 条链接已写入 config.yml`);
  }
  return args.join(' ');
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let value = bytes;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value >= 100 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`;
}
