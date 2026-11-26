import type { DouyinUrlType, VideoQuality } from './types';

export interface ParsedAwemeMedia {
  awemeId: string;
  title: string;
  author: string;
  authorId: string;
  publishDate: string;
  publishTs: number;
  mediaType: DouyinUrlType;
  videoUrl?: string;
  imageUrls: string[];
  coverUrl?: string;
  musicUrl?: string;
  avatarUrl?: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  diggCount?: number;
  commentCount?: number;
  raw?: Record<string, unknown>;
}

interface RawUrlAddr {
  url_list?: string[];
  data_size?: number;
  width?: number;
  height?: number;
}

interface RawBitRate {
  bit_rate?: number;
  gear_name?: string;
  quality_type?: number;
  play_addr?: RawUrlAddr;
}

interface RawImageItem {
  url_list?: string[];
  download_url_list?: string[];
  video?: { play_addr?: RawUrlAddr };
}

export interface RawAweme {
  aweme_id?: string | number;
  aweme_type?: number;
  desc?: string;
  create_time?: number;
  author?: {
    nickname?: string;
    sec_uid?: string;
    avatar_larger?: RawUrlAddr;
    avatar_thumb?: RawUrlAddr;
  };
  video?: {
    play_addr?: RawUrlAddr;
    download_addr?: RawUrlAddr;
    cover?: RawUrlAddr;
    origin_cover?: RawUrlAddr;
    dynamic_cover?: RawUrlAddr;
    bit_rate?: RawBitRate[];
    width?: number;
    height?: number;
  };
  images?: RawImageItem[] | null;
  image_infos?: RawImageItem[] | null;
  music?: {
    play_url?: RawUrlAddr;
    title?: string;
  };
  statistics?: {
    digg_count?: number;
    comment_count?: number;
  };
}

const TARGET_HEIGHT_BY_QUALITY: Partial<Record<VideoQuality, number>> = {
  '1440p': 1440,
  '1080p': 1080,
  '720p': 720,
  '540p': 540,
};

export function toWatermarkFreeUrl(url: string): string {
  return url.replace('/playwm/', '/play/').replace(/^http:\/\//i, 'https://');
}

function firstValidUrl(urls?: string[]): string | undefined {
  if (!Array.isArray(urls)) return undefined;
  for (const raw of urls) {
    if (typeof raw === 'string' && raw.startsWith('http')) {
      return toWatermarkFreeUrl(raw);
    }
  }
  return undefined;
}

export function pickBestVideoMedia(
  aweme: RawAweme,
  quality: VideoQuality,
): { url?: string; sizeBytes: number; width?: number; height?: number } {
  const bitRates = Array.isArray(aweme.video?.bit_rate)
    ? aweme.video!.bit_rate!.filter((b) => Boolean(firstValidUrl(b.play_addr?.url_list)))
    : [];

  if (bitRates.length > 0) {
    const sorted = [...bitRates].sort((a, b) => {
      const sizeA = a.play_addr?.data_size || a.bit_rate || 0;
      const sizeB = b.play_addr?.data_size || b.bit_rate || 0;
      return sizeB - sizeA;
    });

    let chosen: RawBitRate = sorted[0];
    if (quality === 'lowest') {
      chosen = sorted[sorted.length - 1];
    } else if (quality in TARGET_HEIGHT_BY_QUALITY) {
      const target = TARGET_HEIGHT_BY_QUALITY[quality]!;
      chosen = sorted.reduce((best, curr) => {
        const bestDim = Math.min(best.play_addr?.width || 1080, best.play_addr?.height || 1080);
        const currDim = Math.min(curr.play_addr?.width || 1080, curr.play_addr?.height || 1080);
        return Math.abs(currDim - target) < Math.abs(bestDim - target) ? curr : best;
      }, sorted[0]);
    }

    return {
      url: firstValidUrl(chosen.play_addr?.url_list),
      sizeBytes: Number(chosen.play_addr?.data_size || 0),
      width: chosen.play_addr?.width,
      height: chosen.play_addr?.height,
    };
  }

  const fallbackAddr = aweme.video?.play_addr || aweme.video?.download_addr;
  return {
    url: firstValidUrl(fallbackAddr?.url_list),
    sizeBytes: Number(fallbackAddr?.data_size || 0),
    width: fallbackAddr?.width || aweme.video?.width,
    height: fallbackAddr?.height || aweme.video?.height,
  };
}

export function extractGalleryImages(aweme: RawAweme): string[] {
  const rawList = Array.isArray(aweme.images) && aweme.images.length > 0
    ? aweme.images
    : Array.isArray(aweme.image_infos)
      ? aweme.image_infos
      : [];

  const urls: string[] = [];
  for (const img of rawList) {
    const candidates = [
      ...(Array.isArray(img.download_url_list) ? img.download_url_list : []),
      ...(Array.isArray(img.url_list) ? img.url_list : []),
    ].filter((u) => typeof u === 'string' && u.startsWith('http'));

    if (candidates.length === 0) continue;
    const preferred =
      candidates.find((u) => /\.(jpe?g|png)(\?|$)/i.test(u)) || candidates[0];
    urls.push(preferred.replace(/^http:\/\//i, 'https://'));
  }
  return urls;
}

export function formatUnixDate(ts?: number): string {
  if (!ts || !Number.isFinite(ts) || ts <= 0) {
    return new Date().toISOString().slice(0, 10);
  }
  const ms = ts > 1e12 ? ts : ts * 1000;
  const dt = new Date(ms);
  if (Number.isNaN(dt.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return dt.toISOString().slice(0, 10);
}

export function parseAwemeToMedia(
  aweme: RawAweme,
  quality: VideoQuality = 'highest',
): ParsedAwemeMedia | null {
  const awemeId = String(aweme.aweme_id || '').trim();
  if (!awemeId) return null;

  const imageUrls = extractGalleryImages(aweme);
  const isGallery =
    imageUrls.length > 0 || aweme.aweme_type === 68 || aweme.aweme_type === 2;
  const videoPicked = isGallery
    ? { url: undefined, sizeBytes: 0, width: undefined, height: undefined }
    : pickBestVideoMedia(aweme, quality);

  const coverUrl =
    firstValidUrl(aweme.video?.origin_cover?.url_list) ||
    firstValidUrl(aweme.video?.cover?.url_list) ||
    imageUrls[0];

  const musicUrl = firstValidUrl(aweme.music?.play_url?.url_list);
  const avatarUrl =
    firstValidUrl(aweme.author?.avatar_larger?.url_list) ||
    firstValidUrl(aweme.author?.avatar_thumb?.url_list);

  const publishTs = Number(aweme.create_time || 0);
  const publishDate = formatUnixDate(publishTs);
  const title = (aweme.desc || '').trim() || `抖音作品_${awemeId}`;
  const author = (aweme.author?.nickname || '').trim() || '未知作者';
  const authorId = (aweme.author?.sec_uid || '').trim();

  return {
    awemeId,
    title,
    author,
    authorId,
    publishDate,
    publishTs,
    mediaType: isGallery ? 'gallery' : 'video',
    videoUrl: videoPicked.url,
    imageUrls,
    coverUrl,
    musicUrl,
    avatarUrl,
    sizeBytes: videoPicked.sizeBytes,
    width: videoPicked.width,
    height: videoPicked.height,
    diggCount: aweme.statistics?.digg_count,
    commentCount: aweme.statistics?.comment_count,
    raw: aweme as unknown as Record<string, unknown>,
  };
}

export function extractRouterDataFromHtml(html: string): Record<string, unknown> | null {
  const marker = 'window._ROUTER_DATA';
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const eqIdx = html.indexOf('=', idx);
  if (eqIdx === -1) return null;
  const scriptEnd = html.indexOf('</script>', eqIdx);
  if (scriptEnd === -1) return null;

  let jsonStr = html.slice(eqIdx + 1, scriptEnd).trim();
  if (jsonStr.endsWith(';')) {
    jsonStr = jsonStr.slice(0, -1).trim();
  }
  try {
    return JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function extractAwemeListFromRouterData(
  routerData: Record<string, unknown>,
): RawAweme[] {
  const loaderData = routerData.loaderData as Record<string, unknown> | undefined;
  if (!loaderData || typeof loaderData !== 'object') return [];

  const found: RawAweme[] = [];
  const seen = new Set<string>();

  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (
      obj.aweme_id &&
      (obj.video || obj.images || obj.image_infos || obj.desc !== undefined)
    ) {
      const id = String(obj.aweme_id);
      if (!seen.has(id)) {
        seen.add(id);
        found.push(obj as unknown as RawAweme);
      }
      return;
    }
    for (const val of Object.values(obj)) {
      walk(val);
    }
  };

  walk(loaderData);
  return found;
}

export function parseCookieString(
  cookieString: string,
): Array<{ name: string; value: string; domain: string; path: string }> {
  if (!cookieString || !cookieString.trim()) return [];
  const result: Array<{ name: string; value: string; domain: string; path: string }> = [];
  for (const part of cookieString.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name || !value) continue;
    result.push({
      name,
      value,
      domain: '.douyin.com',
      path: '/',
    });
  }
  return result;
}
