import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import type { Response } from 'express';
import { sanitizeFilename } from '../src/lib/naming';
import type { ParsedAwemeMedia } from '../src/lib/douyinParser';
import type { BatchSettings } from '../src/lib/types';

const DOWNLOAD_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const ALLOWED_MEDIA_HOST_SUFFIXES = [
  'douyin.com',
  'iesdouyin.com',
  'douyinvod.com',
  'douyinpic.com',
  'douyincdn.com',
  'douyinstatic.com',
  'byteimg.com',
  'bytedance.com',
  'bytetos.com',
  'snssdk.com',
  'amemv.com',
  'zjcdn.com',
  'pstatp.com',
  'toutiaovod.com',
  'ixigua.com',
  'volccdn.com',
];

export function isAllowedMediaHost(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_MEDIA_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    );
  } catch {
    return false;
  }
}

export interface DownloadedFileRecord {
  kind: 'video' | 'image' | 'cover' | 'music' | 'avatar' | 'json';
  filename: string;
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
}

export interface MediaDownloadResult {
  files: DownloadedFileRecord[];
  totalBytes: number;
  outputDir: string;
}

export function guessImageExt(url: string, contentType?: string | null): string {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('png')) return '.png';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('gif')) return '.gif';
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';

  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // use raw url
  }
  const matches = pathname.match(/\.(jpe?g|png|webp|gif)(?=[^a-z0-9]|$)/gi);
  if (matches && matches.length > 0) {
    const ext = matches[matches.length - 1].toLowerCase();
    return ext === '.jpeg' ? '.jpg' : ext;
  }
  return '.jpg';
}

export async function probeOriginalVideoUrl(
  videoUri: string,
  selectedSizeBytes: number,
  options: {
    cookieString?: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ url: string; sizeBytes: number } | null> {
  if (!videoUri || !videoUri.trim()) return null;
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') return null;

  const probeUrl =
    `https://www.douyin.com/aweme/v1/play/?video_id=${encodeURIComponent(videoUri.trim())}` +
    '&ratio=default&line=0&is_play_url=1&watermark=0&source=PackSourceEnum_PUBLISH';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  const onParentAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onParentAbort, { once: true });

  try {
    const headers: Record<string, string> = {
      'User-Agent': DOWNLOAD_USER_AGENT,
      Referer: 'https://www.douyin.com/',
      Accept: '*/*',
      Range: 'bytes=0-0',
    };
    if (options.cookieString?.trim()) {
      headers.Cookie = options.cookieString.trim();
    }
    const res = await fetchFn(probeUrl, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
    if (res.status !== 200 && res.status !== 206) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.startsWith('video/')) return null;

    const finalUrl = res.url || probeUrl;
    if (!isAllowedMediaHost(finalUrl)) return null;

    const contentRange = res.headers.get('content-range') || '';
    const rawTotal = contentRange.includes('/')
      ? contentRange.split('/').pop()
      : res.headers.get('content-length');
    const totalSize = Number(rawTotal || 0);
    if (!Number.isFinite(totalSize) || totalSize <= 0) return null;

    // Only promote original stream when it is genuinely larger than the selected transcoded tier
    if (selectedSizeBytes > 0 && totalSize <= selectedSizeBytes) {
      return null;
    }
    return { url: finalUrl, sizeBytes: totalSize };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onParentAbort);
  }
}

async function downloadBinaryFile(
  url: string,
  destPath: string,
  options: {
    cookieString?: string;
    accept?: string;
    adjustExtByContentType?: boolean;
    onProgress?: (received: number, total: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ sizeBytes: number; contentType: string | null; finalPath: string }> {
  if (!isAllowedMediaHost(url)) {
    throw new Error(`媒体链接域名不在白名单内: ${url.slice(0, 80)}`);
  }

  const headers: Record<string, string> = {
    'User-Agent': DOWNLOAD_USER_AGENT,
    Referer: 'https://www.douyin.com/',
    Accept: options.accept || '*/*',
  };
  if (options.cookieString?.trim()) {
    headers.Cookie = options.cookieString.trim();
  }

  const response = await fetch(url, {
    method: 'GET',
    headers,
    redirect: 'follow',
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`CDN 下载失败 (HTTP ${response.status})`);
  }

  if (!isAllowedMediaHost(response.url)) {
    throw new Error('媒体重定向目标域名不受信任');
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  const contentType = response.headers.get('content-type');
  let finalPath = destPath;
  if (options.adjustExtByContentType && contentType) {
    const detectedExt = guessImageExt(url, contentType);
    const currentExt = path.extname(destPath).toLowerCase();
    if (detectedExt && detectedExt !== currentExt) {
      finalPath = `${destPath.slice(0, destPath.length - currentExt.length)}${detectedExt}`;
    }
  }
  await fsp.mkdir(path.dirname(finalPath), { recursive: true });

  const tmpPath = `${finalPath}.part`;
  let received = 0;

  try {
    const nodeReadable = Readable.fromWeb(
      response.body as unknown as import('node:stream/web').ReadableStream,
    );
    nodeReadable.on('data', (chunk: Buffer) => {
      received += chunk.length;
      options.onProgress?.(received, contentLength);
    });
    const fileStream = fs.createWriteStream(tmpPath);
    await pipeline(nodeReadable, fileStream);

    const stat = await fsp.stat(tmpPath);
    if (stat.size === 0) {
      throw new Error('下载文件为空 (0 字节)');
    }
    await fsp.rename(tmpPath, finalPath);
    return { sizeBytes: stat.size, contentType, finalPath };
  } catch (err) {
    await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

export function resolveSafeDownloadRoot(downloadPath: string): string {
  const desktopMode = process.env.DOUYIN_DESKTOP === '1';
  const baseRoot = process.env.DOUYIN_DOWNLOAD_BASE_DIR
    ? path.resolve(process.env.DOUYIN_DOWNLOAD_BASE_DIR)
    : path.resolve(process.cwd(), 'Downloaded');
  const raw = (downloadPath || './Downloaded/').trim();

  if (
    !raw ||
    raw === './Downloaded/' ||
    raw === './Downloaded' ||
    raw === 'Downloaded' ||
    raw === 'Downloaded/'
  ) {
    return baseRoot;
  }

  // In macOS desktop app mode, allow saving directly to user-selected absolute folders
  if (desktopMode && path.isAbsolute(raw) && !raw.includes('..')) {
    return path.resolve(raw);
  }

  const cleaned = raw.replace(/^\.?\//, '').replace(/\.\./g, '').trim();
  if (!cleaned) {
    return baseRoot;
  }

  const anchor = process.env.DOUYIN_DOWNLOAD_BASE_DIR ? baseRoot : process.cwd();
  const candidate = path.resolve(anchor, cleaned);
  if (!candidate.startsWith(anchor)) {
    return baseRoot;
  }
  return candidate;
}

export function buildAuthorFolderName(
  author: string,
  authorId: string,
  mode: BatchSettings['authorDir'],
): string {
  const safeName = sanitizeFilename(author || '未知作者', 48);
  const safeUid = sanitizeFilename(authorId || 'unknown', 40);
  if (mode === 'sec_uid') return safeUid;
  if (mode === 'nickname_uid' && authorId) return `${safeName}_${safeUid.slice(-12)}`;
  return safeName;
}

export function resolveMediaOutputLocation(
  media: Pick<ParsedAwemeMedia, 'awemeId' | 'author' | 'authorId'>,
  baseFilename: string,
  folderName: string,
  settings: Pick<BatchSettings, 'downloadPath' | 'authorDir' | 'folderStyle'>,
): { rootDir: string; authorFolder: string; itemDir: string; safeStem: string } {
  const rootDir = resolveSafeDownloadRoot(settings.downloadPath);
  const authorFolder = buildAuthorFolderName(
    media.author,
    media.authorId,
    settings.authorDir,
  );
  const itemDir = settings.folderStyle
    ? path.join(rootDir, authorFolder, sanitizeFilename(folderName, 80))
    : path.join(rootDir, authorFolder);

  let safeStem = sanitizeFilename(baseFilename, 80);
  // When flattening all works directly into the author folder, ensure awemeId stays
  // in the filename stem so works with identical long titles never overwrite each other.
  if (!settings.folderStyle && media.awemeId && !safeStem.includes(media.awemeId)) {
    const suffix = `_${sanitizeFilename(media.awemeId, 32)}`;
    const maxPrefixLen = Math.max(1, 80 - suffix.length);
    safeStem = `${safeStem.slice(0, maxPrefixLen).replace(/[. ]+$/g, '')}${suffix}`;
  }

  return { rootDir, authorFolder, itemDir, safeStem };
}

export async function downloadAwemeMediaToDisk(
  media: ParsedAwemeMedia,
  baseFilename: string,
  folderName: string,
  settings: BatchSettings,
  options: {
    onProgress?: (percent: number, message: string) => void;
    signal?: AbortSignal;
  } = {},
): Promise<MediaDownloadResult> {
  const { rootDir, itemDir, safeStem } = resolveMediaOutputLocation(
    media,
    baseFilename,
    folderName,
    settings,
  );

  await fsp.mkdir(itemDir, { recursive: true });
  const files: DownloadedFileRecord[] = [];
  let totalBytes = 0;

  const pushFile = (kind: DownloadedFileRecord['kind'], absPath: string, sizeBytes: number) => {
    files.push({
      kind,
      filename: path.basename(absPath),
      absolutePath: absPath,
      relativePath: path.relative(rootDir, absPath),
      sizeBytes,
    });
    totalBytes += sizeBytes;
  };

  if (media.mediaType === 'gallery' && media.imageUrls.length > 0) {
    const count = media.imageUrls.length;
    for (let i = 0; i < count; i += 1) {
      const imgUrl = media.imageUrls[i];
      const ext = guessImageExt(imgUrl);
      const imgName = `${safeStem}_img_${String(i + 1).padStart(2, '0')}${ext}`;
      const dest = path.join(itemDir, imgName);
      options.onProgress?.(
        Math.round((i / count) * 80),
        `正在下载图集第 ${i + 1}/${count} 张无水印原图...`,
      );
      const { sizeBytes, finalPath } = await downloadBinaryFile(imgUrl, dest, {
        cookieString: settings.cookieString,
        accept: 'image/jpeg,image/png,*/*;q=0.8',
        adjustExtByContentType: true,
        signal: options.signal,
      });
      pushFile('image', finalPath, sizeBytes);
    }
  } else if (settings.includeVideo && media.videoUrl) {
    const dest = path.join(itemDir, `${safeStem}.mp4`);
    let targetVideoUrl = media.videoUrl;
    if (settings.videoQuality === 'original' && media.videoUri) {
      options.onProgress?.(6, '正在探测上传原始画质流...');
      const probed = await probeOriginalVideoUrl(media.videoUri, media.sizeBytes, {
        cookieString: settings.cookieString,
        signal: options.signal,
      });
      if (probed?.url) {
        targetVideoUrl = probed.url;
      }
    }

    options.onProgress?.(10, '正在连接抖音 CDN 流式下载无水印视频...');
    let downloaded: { sizeBytes: number; finalPath: string };
    try {
      downloaded = await downloadBinaryFile(targetVideoUrl, dest, {
        cookieString: settings.cookieString,
        signal: options.signal,
        onProgress: (received, total) => {
          if (total > 0) {
            const pct = Math.min(88, Math.max(12, Math.round((received / total) * 85)));
            options.onProgress?.(
              pct,
              `正在下载视频 ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`,
            );
          } else {
            options.onProgress?.(
              50,
              `正在下载视频 ${(received / 1048576).toFixed(1)} MB...`,
            );
          }
        },
      });
    } catch (err) {
      if (targetVideoUrl !== media.videoUrl && !options.signal?.aborted) {
        // Fallback to selected highest transcoded track if probed original stream fails
        downloaded = await downloadBinaryFile(media.videoUrl, dest, {
          cookieString: settings.cookieString,
          signal: options.signal,
        });
      } else {
        throw err;
      }
    }
    pushFile('video', downloaded.finalPath, downloaded.sizeBytes);
  } else if (media.mediaType === 'video' && !media.videoUrl) {
    throw new Error('未获取到该视频的直链地址（可能触发风控或作品不可见）');
  }

  if (settings.includeCover && media.coverUrl) {
    try {
      const ext = guessImageExt(media.coverUrl);
      const dest = path.join(itemDir, `${safeStem}_cover${ext}`);
      const { sizeBytes, finalPath } = await downloadBinaryFile(media.coverUrl, dest, {
        cookieString: settings.cookieString,
        accept: 'image/jpeg,image/png,*/*;q=0.8',
        adjustExtByContentType: true,
        signal: options.signal,
      });
      pushFile('cover', finalPath, sizeBytes);
    } catch {
      // non-fatal accessory artifact
    }
  }

  if (settings.includeMusic && media.musicUrl) {
    try {
      const dest = path.join(itemDir, `${safeStem}_music.mp3`);
      const { sizeBytes, finalPath } = await downloadBinaryFile(media.musicUrl, dest, {
        cookieString: settings.cookieString,
        signal: options.signal,
      });
      pushFile('music', finalPath, sizeBytes);
    } catch {
      // non-fatal accessory artifact
    }
  }

  if (settings.includeAvatar && media.avatarUrl) {
    try {
      const ext = guessImageExt(media.avatarUrl);
      const dest = path.join(itemDir, `${safeStem}_avatar${ext}`);
      const { sizeBytes, finalPath } = await downloadBinaryFile(media.avatarUrl, dest, {
        cookieString: settings.cookieString,
        accept: 'image/jpeg,image/png,*/*;q=0.8',
        adjustExtByContentType: true,
        signal: options.signal,
      });
      pushFile('avatar', finalPath, sizeBytes);
    } catch {
      // non-fatal accessory artifact
    }
  }

  if (settings.includeJson) {
    const dest = path.join(itemDir, `${safeStem}_meta.json`);
    const payload = JSON.stringify(
      {
        aweme_id: media.awemeId,
        title: media.title,
        author: media.author,
        author_id: media.authorId,
        publish_date: media.publishDate,
        media_type: media.mediaType,
        video_url: media.videoUrl,
        image_urls: media.imageUrls,
        cover_url: media.coverUrl,
        music_url: media.musicUrl,
        digg_count: media.diggCount,
        comment_count: media.commentCount,
      },
      null,
      2,
    );
    await fsp.writeFile(dest, payload, 'utf8');
    pushFile('json', dest, Buffer.byteLength(payload, 'utf8'));
  }

  options.onProgress?.(100, `已落盘 ${files.length} 个文件`);
  return {
    files,
    totalBytes,
    outputDir: itemDir,
  };
}

export async function streamFilesAsZip(
  res: Response,
  zipFilename: string,
  files: Array<{ absolutePath: string; archiveName: string }>,
): Promise<void> {
  const existing: Array<{ absolutePath: string; archiveName: string }> = [];
  for (const f of files) {
    try {
      const stat = await fsp.stat(f.absolutePath);
      if (stat.isFile() && stat.size > 0) {
        existing.push(f);
      }
    } catch {
      // skip missing files
    }
  }

  if (existing.length === 0) {
    res.status(404).json({ error: '暂无可打包下载的本地文件，请先完成下载任务' });
    return;
  }

  const encodedName = encodeURIComponent(zipFilename);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="douyin-batch.zip"; filename*=UTF-8''${encodedName}`,
  );

  const archive = new ZipArchive({ zlib: { level: 1 } });
  archive.on('error', () => {
    if (!res.headersSent) {
      res.status(500).json({ error: 'ZIP 打包失败' });
    } else {
      res.end();
    }
  });
  archive.pipe(res);

  for (const f of existing) {
    archive.file(f.absolutePath, { name: f.archiveName });
  }
  await archive.finalize();
}
