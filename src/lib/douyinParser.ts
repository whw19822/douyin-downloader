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
  videoUri?: string;
  isNeedSetCookie?: boolean;
  imageUrls: string[];
  coverUrl?: string;
  musicUrl?: string;
  avatarUrl?: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  diggCount?: number;
  commentCount?: number;
  raw?: Record<string, unknown>;
}

interface RawUrlAddr {
  url_list?: string[];
  urlList?: string[];
  uri?: string;
  data_size?: number;
  width?: number;
  height?: number;
  w?: number;
  h?: number;
}

interface RawBitRate {
  bit_rate?: number;
  gear_name?: string;
  quality_type?: number;
  width?: number;
  height?: number;
  is_h265?: number;
  is_bytevc1?: number;
  play_addr?: RawUrlAddr;
  play_addr_h264?: RawUrlAddr;
  play_addr_265?: RawUrlAddr;
  play_addr_bytevc1?: RawUrlAddr;
}

interface RawImageItem {
  watermark_free_download_url_list?: string[];
  origin_image?: RawUrlAddr;
  display_image?: RawUrlAddr;
  url_list?: string[];
  urlList?: string[];
  download_url?: RawUrlAddr | string;
  download_addr?: RawUrlAddr;
  download_url_list?: string[];
  owner_watermark_image?: RawUrlAddr;
  width?: number;
  height?: number;
  w?: number;
  h?: number;
  video?: {
    play_addr?: RawUrlAddr;
    play_addr_h264?: RawUrlAddr;
    play_addr_265?: RawUrlAddr;
    bit_rate?: RawBitRate[];
  };
}

export interface RawAweme {
  aweme_id?: string | number;
  aweme_type?: number;
  desc?: string;
  create_time?: number;
  is_top?: number | boolean;
  mix_info?: {
    mix_id?: string | number;
    mix_name?: string;
    author?: {
      nickname?: string;
      sec_uid?: string;
    };
  };
  author?: {
    nickname?: string;
    sec_uid?: string;
    uid?: string;
    avatar_larger?: RawUrlAddr;
    avatar_thumb?: RawUrlAddr;
  };
  video?: {
    vid?: string;
    is_need_set_cookie?: number | boolean;
    play_addr?: RawUrlAddr;
    play_addr_h264?: RawUrlAddr;
    play_addr_265?: RawUrlAddr;
    play_addr_256?: RawUrlAddr;
    play_addr_bytevc1?: RawUrlAddr;
    download_addr?: RawUrlAddr;
    cover?: RawUrlAddr;
    origin_cover?: RawUrlAddr;
    cover_original_scale?: RawUrlAddr;
    dynamic_cover?: RawUrlAddr;
    bit_rate?: RawBitRate[];
    width?: number;
    height?: number;
  };
  image_post_info?: {
    images?: RawImageItem[] | null;
    image_list?: RawImageItem[] | null;
  };
  images?: RawImageItem[] | null;
  image_list?: RawImageItem[] | null;
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

const STANDARD_LONG_EDGE_TO_SHORT_EDGE: Array<[number, number]> = [
  [3840, 2160],
  [2560, 1440],
  [1920, 1080],
  [1280, 720],
  [960, 540],
  [854, 480],
  [640, 360],
];

const WATERMARK_URL_HINTS = [
  'tplv-dy-water',
  'dy-water',
  'owner_watermark',
  'watermark_image',
  'watermark=1',
  'playwm',
];

export function isWatermarkedMediaUrl(url: string): boolean {
  const lower = (url || '').toLowerCase();
  return WATERMARK_URL_HINTS.some((hint) => lower.includes(hint));
}

export function toWatermarkFreeUrl(url: string): string {
  return url.replace('/playwm/', '/play/').replace(/^http:\/\//i, 'https://');
}

function upgradePlayEndpointRatio(url: string, quality: VideoQuality): string {
  if (!url.includes('/aweme/v1/play/')) return url;
  try {
    const parsed = new URL(url);
    const currentRatio = (parsed.searchParams.get('ratio') || '').toLowerCase();
    if (!currentRatio) return url;

    const currentNum = Number(currentRatio.replace(/p$/i, '')) || 0;
    if (quality === 'highest' || quality === 'original') {
      // Never cap highest/original at 1080p: ratio=default delivers un-downscaled 2K/4K masters!
      if (currentRatio !== 'default') {
        parsed.searchParams.set('ratio', 'default');
        return parsed.toString();
      }
    } else if (quality === '1440p') {
      if (currentNum > 0 && currentNum < 1440) {
        parsed.searchParams.set('ratio', '1440p');
        return parsed.toString();
      }
    } else if (quality === '1080p') {
      if (currentNum > 0 && currentNum < 1080) {
        parsed.searchParams.set('ratio', '1080p');
        return parsed.toString();
      }
    }
  } catch {
    // ignore malformed URLs
  }
  return url;
}

function extractUrlStrings(source?: RawUrlAddr | string[] | string | null): string[] {
  if (!source) return [];
  if (typeof source === 'string') {
    return source.startsWith('http') ? [source] : [];
  }
  if (Array.isArray(source)) {
    return source.filter((u): u is string => typeof u === 'string' && u.startsWith('http'));
  }
  const rawList = Array.isArray(source.url_list)
    ? source.url_list
    : Array.isArray(source.urlList)
      ? source.urlList
      : [];
  return rawList.filter((u): u is string => typeof u === 'string' && u.startsWith('http'));
}

function pickBestPlayUrlFromList(
  urls?: string[],
  quality?: VideoQuality,
): string | undefined {
  if (!Array.isArray(urls) || urls.length === 0) return undefined;
  const valid = urls.filter((u): u is string => typeof u === 'string' && u.startsWith('http'));
  if (valid.length === 0) return undefined;

  // Prefer direct watermark-free CDN URLs (e.g. douyinvod.com) over /aweme/v1/play/ redirect
  // endpoints or /playwm/ watermarked endpoints.
  const scored = valid.map((raw, idx) => {
    const lower = raw.toLowerCase();
    const isPlayWm = lower.includes('/playwm/');
    const isPlayRedirect = lower.includes('/aweme/v1/play');
    const score = (isPlayWm ? 20 : 0) + (isPlayRedirect ? 10 : 0);
    return { raw, score, idx };
  });
  scored.sort((a, b) => a.score - b.score || a.idx - b.idx);
  const cleaned = toWatermarkFreeUrl(scored[0].raw);
  return quality ? upgradePlayEndpointRatio(cleaned, quality) : cleaned;
}

function firstValidUrl(urls?: string[]): string | undefined {
  return pickBestPlayUrlFromList(urls);
}

function parseGearNameShortEdge(gearName?: string): number {
  if (!gearName) return 0;
  const lower = gearName.toLowerCase();
  if (lower.includes('4k') || lower.includes('2160')) return 2160;
  if (lower.includes('2k') || lower.includes('1440')) return 1440;
  if (lower.includes('1080')) return 1080;
  if (lower.includes('720')) return 720;
  if (lower.includes('540')) return 540;
  if (lower.includes('480')) return 480;
  if (lower.includes('360')) return 360;
  return 0;
}

function computeTrackResolution(
  entry: { width?: number; height?: number; gear_name?: string },
  playAddr?: RawUrlAddr,
): { width: number; height: number; shortEdge: number; pixels: number } {
  const width = Math.max(0, Math.round(Number(playAddr?.width || entry.width || 0) || 0));
  const height = Math.max(0, Math.round(Number(playAddr?.height || entry.height || 0) || 0));

  if (width > 0 && height > 0) {
    return {
      width,
      height,
      shortEdge: Math.min(width, height),
      pixels: width * height,
    };
  }

  const singleEdge = Math.max(width, height);
  if (singleEdge > 0) {
    let bestShort = 0;
    let bestDiff = Infinity;
    for (const [longStd, shortStd] of STANDARD_LONG_EDGE_TO_SHORT_EDGE) {
      const diff = Math.abs(longStd - singleEdge);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestShort = shortStd;
      }
    }
    return {
      width,
      height,
      shortEdge: bestShort,
      pixels: singleEdge * bestShort,
    };
  }

  const gearShort = parseGearNameShortEdge(entry.gear_name);
  if (gearShort > 0) {
    const estLong = Math.round((gearShort * 16) / 9);
    return {
      width: 0,
      height: 0,
      shortEdge: gearShort,
      pixels: gearShort * estLong,
    };
  }

  return { width: 0, height: 0, shortEdge: 0, pixels: 0 };
}

interface NormalizedVideoCandidate {
  url: string;
  uri?: string;
  bitRate: number;
  dataSize: number;
  width: number;
  height: number;
  shortEdge: number;
  pixels: number;
}

export function pickBestVideoMedia(
  aweme: RawAweme,
  quality: VideoQuality,
): {
  url?: string;
  uri?: string;
  isNeedSetCookie?: boolean;
  sizeBytes: number;
  width?: number;
  height?: number;
  sourceWidth?: number;
  sourceHeight?: number;
} {
  const video = aweme.video;
  const sourceWidth = Math.max(
    0,
    Math.round(Number(video?.width || video?.play_addr?.width || 0) || 0),
  ) || undefined;
  const sourceHeight = Math.max(
    0,
    Math.round(Number(video?.height || video?.play_addr?.height || 0) || 0),
  ) || undefined;
  const isNeedSetCookie = Boolean(video?.is_need_set_cookie);
  const canonicalUri = video?.play_addr?.uri || video?.vid;

  const candidates: NormalizedVideoCandidate[] = [];
  const seenUrls = new Set<string>();

  const pushCandidate = (
    addr: RawUrlAddr | undefined,
    meta: { bitRate?: number; width?: number; height?: number; gear_name?: string } = {},
  ) => {
    if (!addr) return;
    const url = pickBestPlayUrlFromList(extractUrlStrings(addr), quality);
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    const res = computeTrackResolution(meta, addr);
    candidates.push({
      url,
      uri: addr.uri || canonicalUri,
      bitRate: Math.max(0, Number(meta.bitRate || 0) || 0),
      dataSize: Math.max(0, Number(addr.data_size || 0) || 0),
      width: res.width,
      height: res.height,
      shortEdge: res.shortEdge,
      pixels: res.pixels,
    });
  };

  if (Array.isArray(video?.bit_rate)) {
    for (const entry of video.bit_rate) {
      if (!entry || typeof entry !== 'object') continue;
      const addrs = [
        entry.play_addr,
        entry.play_addr_h264,
        entry.play_addr_265,
        entry.play_addr_bytevc1,
      ];
      for (const addr of addrs) {
        pushCandidate(addr, {
          bitRate: entry.bit_rate,
          width: entry.width,
          height: entry.height,
          gear_name: entry.gear_name,
        });
      }
    }
  }

  // IMPORTANT: On Douyin, top-level video.play_addr often carries the original source dimensions
  // (e.g. 2160x3840) even though its url_list serves a downscaled 1080p/720p playback stream.
  // Only fall back to top-level play_addr variants when video.bit_rate has no usable tracks!
  const cameFromBitRate = candidates.length > 0;
  if (!cameFromBitRate) {
    const topLevelAddrs = [
      video?.play_addr_h264,
      video?.play_addr_265,
      video?.play_addr_256,
      video?.play_addr_bytevc1,
      video?.play_addr,
      video?.download_addr,
    ];
    for (const addr of topLevelAddrs) {
      if (!addr) continue;
      pushCandidate(addr, {
        width: addr.width || video?.width,
        height: addr.height || video?.height,
      });
    }
  }

  if (candidates.length === 0) {
    return {
      url: undefined,
      uri: canonicalUri,
      isNeedSetCookie,
      sizeBytes: 0,
      width: sourceWidth,
      height: sourceHeight,
      sourceWidth,
      sourceHeight,
    };
  }

  const sorted = [...candidates];
  if (quality === 'lowest') {
    sorted.sort((a, b) => {
      const brA = a.bitRate || Number.MAX_SAFE_INTEGER;
      const brB = b.bitRate || Number.MAX_SAFE_INTEGER;
      if (a.pixels !== b.pixels && a.pixels > 0 && b.pixels > 0) {
        if (brA !== brB) return brA - brB;
        return a.pixels - b.pixels;
      }
      if (brA !== brB) return brA - brB;
      if (a.pixels !== b.pixels) return a.pixels - b.pixels;
      return a.dataSize - b.dataSize;
    });
  } else if (quality in TARGET_HEIGHT_BY_QUALITY) {
    const target = TARGET_HEIGHT_BY_QUALITY[quality]!;
    sorted.sort((a, b) => {
      const diffA = a.shortEdge > 0 ? Math.abs(a.shortEdge - target) : Number.MAX_SAFE_INTEGER;
      const diffB = b.shortEdge > 0 ? Math.abs(b.shortEdge - target) : Number.MAX_SAFE_INTEGER;
      if (diffA !== diffB) return diffA - diffB;
      if (b.bitRate !== a.bitRate) return b.bitRate - a.bitRate;
      if (b.pixels !== a.pixels) return b.pixels - a.pixels;
      return b.dataSize - a.dataSize;
    });
  } else {
    // 'highest' and 'original' (base tier before original-master probe):
    // Prioritize highest actual track pixel resolution first, then highest bit_rate, then data_size.
    sorted.sort((a, b) => {
      if (b.pixels !== a.pixels) return b.pixels - a.pixels;
      if (b.shortEdge !== a.shortEdge) return b.shortEdge - a.shortEdge;
      if (b.bitRate !== a.bitRate) return b.bitRate - a.bitRate;
      return b.dataSize - a.dataSize;
    });
  }

  const chosen = sorted[0];
  return {
    url: chosen.url,
    // Prefer canonical video URI (video.play_addr.uri / video.vid) for /aweme/v1/play/?ratio=default probing
    uri: canonicalUri || chosen.uri,
    isNeedSetCookie,
    sizeBytes: chosen.dataSize,
    width: chosen.width || (!cameFromBitRate ? sourceWidth : undefined),
    height: chosen.height || (!cameFromBitRate ? sourceHeight : undefined),
    sourceWidth,
    sourceHeight,
  };
}

function getImageResolutionScore(meta?: { width?: number; height?: number; w?: number; h?: number }): number {
  if (!meta) return 0;
  const w = Math.max(0, Math.round(Number(meta.width || meta.w || 0) || 0));
  const h = Math.max(0, Math.round(Number(meta.height || meta.h || 0) || 0));
  if (w > 0 && h > 0) return w * h;
  return w || h || 0;
}

function getImageFormatRank(url: string): number {
  let pathname = url.toLowerCase();
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    // use raw lowercased string
  }
  if (/\.(jpe?g|png)(?:[^a-z0-9]|$)/i.test(pathname)) return 0;
  if (/\.(webp|heic|heif)(?:[^a-z0-9]|$)/i.test(pathname)) return 2;
  return 1;
}

function iterGalleryItems(aweme: RawAweme): RawImageItem[] {
  const fromImagePost = aweme.image_post_info?.images || aweme.image_post_info?.image_list;
  if (Array.isArray(fromImagePost) && fromImagePost.length > 0) {
    return fromImagePost;
  }
  if (Array.isArray(aweme.images) && aweme.images.length > 0) {
    return aweme.images;
  }
  if (Array.isArray(aweme.image_list) && aweme.image_list.length > 0) {
    return aweme.image_list;
  }
  if (Array.isArray(aweme.image_infos) && aweme.image_infos.length > 0) {
    return aweme.image_infos;
  }
  return [];
}

function pickBestImageUrlFromItem(img: RawImageItem): string | undefined {
  // Source priority matches Douyin's real asset semantics:
  // rank 0..3 = watermark-free display/origin assets;
  // rank 4..7 = download/owner_watermark assets (often carry ~tplv-dy-water watermarks).
  const sources: Array<{
    urls: string[];
    meta?: { width?: number; height?: number; w?: number; h?: number };
    sourceRank: number;
  }> = [
    { urls: extractUrlStrings(img.watermark_free_download_url_list), meta: img, sourceRank: 0 },
    { urls: extractUrlStrings(img.origin_image), meta: img.origin_image || img, sourceRank: 1 },
    { urls: extractUrlStrings(img.display_image), meta: img.display_image || img, sourceRank: 2 },
    { urls: extractUrlStrings(img), meta: img, sourceRank: 3 },
    {
      urls: extractUrlStrings(img.download_url),
      meta: typeof img.download_url === 'object' ? img.download_url : img,
      sourceRank: 4,
    },
    { urls: extractUrlStrings(img.download_addr), meta: img.download_addr || img, sourceRank: 5 },
    { urls: extractUrlStrings(img.download_url_list), meta: img, sourceRank: 6 },
    {
      urls: extractUrlStrings(img.owner_watermark_image),
      meta: img.owner_watermark_image || img,
      sourceRank: 7,
    },
  ];

  const ranked: Array<{
    url: string;
    watermarkRank: number;
    pixels: number;
    sourceRank: number;
    formatRank: number;
    order: number;
  }> = [];

  let order = 0;
  for (const src of sources) {
    const pixels = getImageResolutionScore(src.meta);
    for (const rawUrl of src.urls) {
      const normalizedUrl = rawUrl.replace(/^http:\/\//i, 'https://');
      const watermarkRank =
        src.sourceRank >= 4 || isWatermarkedMediaUrl(normalizedUrl) ? 1 : 0;
      ranked.push({
        url: normalizedUrl,
        watermarkRank,
        pixels,
        sourceRank: src.sourceRank,
        formatRank: getImageFormatRank(normalizedUrl),
        order: order++,
      });
    }
  }

  if (ranked.length === 0) return undefined;

  ranked.sort(
    (a, b) =>
      a.watermarkRank - b.watermarkRank ||
      b.pixels - a.pixels ||
      a.sourceRank - b.sourceRank ||
      a.formatRank - b.formatRank ||
      a.order - b.order,
  );

  return ranked[0].url;
}

export function extractGalleryImages(aweme: RawAweme): string[] {
  const rawList = iterGalleryItems(aweme);
  const urls: string[] = [];
  for (const img of rawList) {
    if (!img || typeof img !== 'object') continue;
    const best = pickBestImageUrlFromItem(img);
    if (best) {
      urls.push(best);
    }
  }
  return urls;
}

function pickBestCoverUrl(aweme: RawAweme, galleryImages: string[]): string | undefined {
  const sources = [
    ...extractUrlStrings(aweme.video?.origin_cover),
    ...extractUrlStrings(aweme.video?.cover_original_scale),
    ...extractUrlStrings(aweme.video?.cover),
  ].map((u) => u.replace(/^http:\/\//i, 'https://'));

  if (sources.length > 0) {
    const ranked = sources.map((url, idx) => ({
      url,
      watermarkRank: isWatermarkedMediaUrl(url) ? 1 : 0,
      formatRank: getImageFormatRank(url),
      idx,
    }));
    ranked.sort(
      (a, b) =>
        a.watermarkRank - b.watermarkRank ||
        a.formatRank - b.formatRank ||
        a.idx - b.idx,
    );
    return ranked[0].url;
  }

  return galleryImages[0];
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
  const videoPicked = pickBestVideoMedia(aweme, quality);
  // Some /note/ awemes with aweme_type=68 carry video-only assets with no gallery images;
  // only treat as gallery when gallery images exist (or no video asset is available).
  const isGallery =
    imageUrls.length > 0 ||
    ((aweme.aweme_type === 68 || aweme.aweme_type === 2) && !videoPicked.url);

  const coverUrl = pickBestCoverUrl(aweme, imageUrls);
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
    videoUrl: isGallery ? undefined : videoPicked.url,
    videoUri: isGallery ? undefined : videoPicked.uri,
    isNeedSetCookie: isGallery ? undefined : videoPicked.isNeedSetCookie,
    imageUrls,
    coverUrl,
    musicUrl,
    avatarUrl,
    sizeBytes: isGallery ? 0 : videoPicked.sizeBytes,
    width: isGallery ? undefined : videoPicked.width,
    height: isGallery ? undefined : videoPicked.height,
    sourceWidth: isGallery ? undefined : videoPicked.sourceWidth,
    sourceHeight: isGallery ? undefined : videoPicked.sourceHeight,
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
