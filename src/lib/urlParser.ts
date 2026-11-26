import type { DouyinUrlType, ParsedLink } from './types';

export const SHORT_URL_HOSTS = [
  'v.douyin.com',
  'v.iesdouyin.com',
  'iesdouyin.com',
] as const;

export const URL_TYPE_LABELS: Record<DouyinUrlType, string> = {
  video: '单条视频',
  user: '博主主页',
  gallery: '图文作品',
  collection: '作品合集',
  music: '音乐原声',
  live: '直播间',
  live_replay: '直播回放',
  short: '抖音短链',
  lvdetail: '放映厅加密长视频',
  unsupported: '暂不支持的链接',
};

const LVDETAIL_UNSUPPORTED_REASON =
  '放映厅长视频采用整轨 MPEG-CENC 加密，抖音作品接口直接拒绝返回可播放流，不支持下载。';

const TRAILING_PUNCTUATION_RE = /[，。、；！!？?》）】」』"'’”]+$/;
const URL_TOKEN_RE =
  /(?:https?:\/\/[^\s<>"'，。、；！》）】]+|(?:v\.douyin\.com|v\.iesdouyin\.com|www\.douyin\.com|live\.douyin\.com|iesdouyin\.com)\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+)/gi;

function hostMatches(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`);
}

function isDouyinWebHost(host: string): boolean {
  return hostMatches(host, 'douyin.com') || hostMatches(host, 'iesdouyin.com');
}

export function isAllowedDouyinUpstreamHost(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    hostMatches(lower, 'douyin.com') ||
    hostMatches(lower, 'iesdouyin.com') ||
    lower === 'webcast.amemv.com'
  );
}

export function isShortUrl(url: string): boolean {
  if (!url) return false;
  let candidate = url.trim().toLowerCase();
  if (candidate.startsWith('https://')) {
    candidate = candidate.slice('https://'.length);
  } else if (candidate.startsWith('http://')) {
    candidate = candidate.slice('http://'.length);
  }
  return SHORT_URL_HOSTS.some(
    (host) => candidate.startsWith(`${host}/`) || candidate === host,
  );
}

export function normalizeShortUrl(url: string): string {
  const stripped = (url || '').trim();
  if (/^https?:\/\//i.test(stripped)) {
    return stripped;
  }
  return `https://${stripped}`;
}

export function extractRawUrls(rawText: string): string[] {
  if (!rawText.trim()) return [];
  const matches = rawText.match(URL_TOKEN_RE) || [];
  return matches
    .map((token) => token.trim().replace(TRAILING_PUNCTUATION_RE, ''))
    .filter(Boolean)
    .map((token) => (/^https?:\/\//i.test(token) ? token : `https://${token}`));
}

export function detectUrlType(url: string): DouyinUrlType {
  if (isShortUrl(url)) {
    return 'short';
  }

  let parsed: URL;
  try {
    parsed = new URL(normalizeShortUrl(url));
  } catch {
    return 'unsupported';
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  if (
    (isDouyinWebHost(host) && /^\/vsdetail\/\d+\/?$/.test(path)) ||
    (host === 'webcast.amemv.com' &&
      /^\/douyin\/webcast\/reflow\/episode\/\d+\/?$/.test(path))
  ) {
    return 'live_replay';
  }

  if (
    host === 'webcast.amemv.com' &&
    /^\/douyin\/webcast\/reflow\/\d+\/?$/.test(path)
  ) {
    return 'live';
  }

  if (!isDouyinWebHost(host)) {
    return 'unsupported';
  }

  const modalId = parsed.searchParams.get('modal_id')?.trim();
  if (modalId) {
    return 'video';
  }

  if (host === 'live.douyin.com') {
    return /^\/\d+\/?$/.test(path) ? 'live' : 'unsupported';
  }

  if (path.includes('/lvdetail/')) return 'lvdetail';
  if (path.includes('/video/')) return 'video';
  if (path.includes('/user/')) return 'user';
  if (
    path.includes('/note/') ||
    path.includes('/gallery/') ||
    path.includes('/slides/')
  ) {
    return 'gallery';
  }
  if (path.includes('/collection/') || path.includes('/mix/')) {
    return 'collection';
  }
  if (path.includes('/music/')) return 'music';
  if (/^\/(?:follow\/|share\/)?live\/\d+\/?$/.test(path)) return 'live';

  return 'unsupported';
}

function extractTargetId(url: string, type: DouyinUrlType): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(normalizeShortUrl(url));
  } catch {
    return undefined;
  }

  const path = parsed.pathname;
  switch (type) {
    case 'video': {
      const modalId = parsed.searchParams.get('modal_id')?.trim();
      if (modalId && /^\d+$/.test(modalId)) return modalId;
      return path.match(/\/video\/(\d+)/)?.[1];
    }
    case 'user':
      return path.match(/\/user\/([A-Za-z0-9_-]+)/)?.[1];
    case 'gallery':
      return path.match(/\/(?:note|gallery|slides)\/(\d+)/)?.[1];
    case 'collection':
      return path.match(/\/(?:collection|mix)\/(\d+)/)?.[1];
    case 'music':
      return path.match(/\/music\/(\d+)/)?.[1];
    case 'live': {
      if (parsed.hostname.toLowerCase() === 'live.douyin.com') {
        return path.match(/^\/(\d+)\/?$/)?.[1];
      }
      return (
        path.match(/\/douyin\/webcast\/reflow\/(\d+)\/?$/)?.[1] ||
        path.match(/\/(?:follow\/|share\/)?live\/(\d+)\/?$/)?.[1]
      );
    }
    case 'live_replay':
      return (
        path.match(/\/vsdetail\/(\d+)/)?.[1] ||
        path.match(/\/douyin\/webcast\/reflow\/episode\/(\d+)/)?.[1]
      );
    case 'short':
      return path.replace(/^\/+|\/+$/g, '') || undefined;
    case 'lvdetail':
      return path.match(/\/lvdetail\/(\d+)/)?.[1];
    default:
      return undefined;
  }
}

export function parseDouyinUrl(rawUrl: string, index = 0): ParsedLink {
  const normalized = normalizeShortUrl(rawUrl);
  const type = detectUrlType(normalized);
  const targetId = extractTargetId(normalized, type);

  if (type === 'lvdetail') {
    return {
      id: `link-${index + 1}`,
      originalUrl: normalized,
      type,
      targetId,
      supported: false,
      reason: LVDETAIL_UNSUPPORTED_REASON,
      label: URL_TYPE_LABELS[type],
    };
  }

  if (type === 'unsupported') {
    return {
      id: `link-${index + 1}`,
      originalUrl: normalized,
      type,
      supported: false,
      reason: '无法识别为有效的抖音主页、视频、图文、合集、音乐或直播链接。',
      label: URL_TYPE_LABELS[type],
    };
  }

  return {
    id: `link-${index + 1}`,
    originalUrl: normalized,
    type,
    targetId,
    supported: true,
    label: URL_TYPE_LABELS[type],
  };
}

export function parseBatchInput(rawText: string): {
  links: ParsedLink[];
  duplicatesRemoved: number;
} {
  const rawUrls = extractRawUrls(rawText);
  const seen = new Set<string>();
  const uniqueUrls: string[] = [];
  let duplicatesRemoved = 0;

  for (const url of rawUrls) {
    const key = url.replace(/\/+$/, '');
    if (seen.has(key)) {
      duplicatesRemoved += 1;
      continue;
    }
    seen.add(key);
    uniqueUrls.push(url);
  }

  return {
    links: uniqueUrls.map((url, idx) => parseDouyinUrl(url, idx)),
    duplicatesRemoved,
  };
}
