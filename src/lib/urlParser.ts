import type { DouyinUrlType, ParsedLink } from './types';

export const SHORT_URL_HOSTS = [
  'v.douyin.com',
  'v.iesdouyin.com',
  'd.douyin.com',
  'iesdouyin.com',
] as const;

const ALWAYS_SHORT_HOSTS = new Set<string>([
  'v.douyin.com',
  'v.iesdouyin.com',
  'd.douyin.com',
]);

const NON_SHORT_PATH_RE =
  /^\/(?:share|web|video|user|profile|note|slides|gallery|image|tuwen|collection|mix|music|live|vsdetail|lvdetail|discover|jingxuan|search|follow)(?:\/|$)/i;

const SHORT_CODE_PATH_RE = /^\/[A-Za-z0-9._~-]{3,32}\/?$/;

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

const DEFAULT_MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

// Stops cleanly before whitespace, quotes, angle brackets, CJK text, and fullwidth punctuation
// so pasted Douyin share copy like "https://v.douyin.com/iRNBhojb/复制此链接" splits accurately.
const URL_TOKEN_RE =
  /(?:https?:\/\/[^\s<>"'`\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+|(?:(?:www\.|m\.|v\.|d\.|live\.)?douyin\.com|(?:www\.|v\.)?iesdouyin\.com|webcast\.amemv\.com)\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+)/gi;

const TRAILING_PUNCTUATION_RE = /[，。、；：！!？?》）】」』"'’”.,;:]+$/;

const GALLERY_PATH_ID_RE =
  /(?:^|\/)(?:share\/)?(?:note|slides|gallery|image|tuwen)(?:\/detail)?\/(\d+)(?:\/|$)/i;
const GALLERY_PATH_PREFIX_RE =
  /(?:^|\/)(?:share\/)?(?:note|slides|gallery|image|tuwen)(?:\/detail)?(?:\/|$)/i;

const COLLECTION_PATH_ID_RE =
  /(?:^|\/)(?:share\/)?(?:collection|mix)(?:\/detail)?\/(\d+)(?:\/|$)/i;
const COLLECTION_PATH_PREFIX_RE =
  /(?:^|\/)(?:share\/)?(?:collection|mix)(?:\/detail)?(?:\/|$)/i;

const VIDEO_PATH_ID_RE =
  /(?:^|\/)(?:share\/)?video(?:\/detail)?\/(\d+)(?:\/|$)/i;
const VIDEO_PATH_PREFIX_RE =
  /(?:^|\/)(?:share\/)?video(?:\/detail)?(?:\/|$)/i;

const USER_PATH_ID_RE =
  /(?:^|\/)(?:share\/)?(?:user|profile)\/([^/?#]+)(?:\/|$)/i;
const USER_PATH_PREFIX_RE =
  /(?:^|\/)(?:share\/)?(?:user|profile)(?:\/|$)/i;

const MUSIC_PATH_ID_RE =
  /(?:^|\/)(?:share\/)?music(?:\/detail)?\/(\d+)(?:\/|$)/i;
const MUSIC_PATH_PREFIX_RE =
  /(?:^|\/)(?:share\/)?music(?:\/detail)?(?:\/|$)/i;

const LVDETAIL_PATH_ID_RE = /(?:^|\/)lvdetail\/(\d+)(?:\/|$)/i;
const LIVE_REPLAY_PATH_ID_RE =
  /(?:^|\/)(?:vsdetail|douyin\/webcast\/reflow\/episode)\/(\d+)(?:\/|$)/i;
const LIVE_PATH_ID_RE =
  /(?:^|\/)(?:(?:follow|share)\/live|live|douyin\/webcast\/reflow)\/(\d+)(?:\/|$)/i;

const VALID_SEC_UID_RE = /^[A-Za-z0-9._~+=-]+$/;
const DIGITS_ONLY_RE = /^\d+$/;

export interface ShortUrlResolveOptions {
  cookieString?: string;
  maxRedirects?: number;
  timeoutMs?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

export interface ShortUrlResolveResult {
  resolvedUrl: string;
  redirectChain: string[];
  hops: number;
}

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

function trimTrailingUnmatchedClosers(token: string): string {
  let cleaned = token.trim();
  while (cleaned.length > 0) {
    const before = cleaned;
    cleaned = cleaned.replace(TRAILING_PUNCTUATION_RE, '');
    const pairs: Array<[string, string]> = [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ];
    for (const [open, close] of pairs) {
      if (cleaned.endsWith(close)) {
        const openCount = cleaned.split(open).length - 1;
        const closeCount = cleaned.split(close).length - 1;
        if (closeCount > openCount) {
          cleaned = cleaned.slice(0, -1);
        }
      }
    }
    if (cleaned === before) break;
  }
  return cleaned;
}

function getDigitParam(params: URLSearchParams, keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = params.get(key)?.trim();
    if (!raw) continue;
    const first = raw.split(',')[0]?.trim();
    if (first && DIGITS_ONLY_RE.test(first)) {
      return first;
    }
  }
  return undefined;
}

function safeDecodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function getSecUidParam(params: URLSearchParams): string | undefined {
  for (const key of ['sec_uid', 'sec_user_id', 'secUid']) {
    const raw = params.get(key)?.trim();
    if (!raw) continue;
    const decoded = safeDecodeSegment(raw).trim();
    if (decoded && VALID_SEC_UID_RE.test(decoded)) {
      return decoded;
    }
  }
  return undefined;
}

export function isShortUrl(url: string): boolean {
  if (!url || !url.trim()) return false;
  let parsed: URL;
  try {
    parsed = new URL(normalizeShortUrl(url));
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname || '/';

  if (ALWAYS_SHORT_HOSTS.has(host)) {
    return true;
  }

  if (host === 'iesdouyin.com' || host === 'www.iesdouyin.com') {
    if (NON_SHORT_PATH_RE.test(path)) {
      return false;
    }
    return SHORT_CODE_PATH_RE.test(path);
  }

  return false;
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
    .map((token) => trimTrailingUnmatchedClosers(token))
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
  const params = parsed.searchParams;

  if (
    (isDouyinWebHost(host) && /^\/vsdetail\/\d+\/?$/i.test(path)) ||
    (host === 'webcast.amemv.com' &&
      /^\/douyin\/webcast\/reflow\/episode\/\d+\/?$/i.test(path))
  ) {
    return 'live_replay';
  }

  if (
    host === 'webcast.amemv.com' &&
    /^\/douyin\/webcast\/reflow\/\d+\/?$/i.test(path)
  ) {
    return 'live';
  }

  if (!isDouyinWebHost(host)) {
    return 'unsupported';
  }

  if (host === 'live.douyin.com') {
    return /^\/\d+\/?$/.test(path) ? 'live' : 'unsupported';
  }

  if (LVDETAIL_PATH_ID_RE.test(path)) {
    return 'lvdetail';
  }

  // Gallery / 图文 works: check before generic modal_id so /note/<id>?modal_id=<id> stays gallery.
  if (
    GALLERY_PATH_ID_RE.test(path) ||
    (GALLERY_PATH_PREFIX_RE.test(path) &&
      Boolean(getDigitParam(params, ['aweme_id', 'item_ids', 'note_id', 'modal_id'])))
  ) {
    return 'gallery';
  }

  const modalId = getDigitParam(params, ['modal_id']);
  if (modalId) {
    const isNoteHint =
      params.get('is_note') === '1' ||
      params.get('aweme_type') === '68' ||
      params.get('type') === 'note' ||
      params.get('type') === 'slides';
    return isNoteHint ? 'gallery' : 'video';
  }

  // Collections / Mixes / 合集: support /collection/<id>, /collection/<id>/<ep>, /mix/detail/<id>, /share/mix/detail/<id>, and ?mix_id= / ?collection_id=
  if (
    COLLECTION_PATH_ID_RE.test(path) ||
    Boolean(getDigitParam(params, ['mix_id', 'collection_id'])) ||
    (COLLECTION_PATH_PREFIX_RE.test(path) &&
      Boolean(getDigitParam(params, ['id'])))
  ) {
    return 'collection';
  }

  // Single Video: /video/<id>, /share/video/<id>, or /video?aweme_id=...
  if (
    VIDEO_PATH_ID_RE.test(path) ||
    (VIDEO_PATH_PREFIX_RE.test(path) &&
      Boolean(getDigitParam(params, ['aweme_id', 'item_ids', 'vid'])))
  ) {
    return 'video';
  }

  // Music: /music/<id>, /share/music/<id>, or /music?music_id=...
  if (
    MUSIC_PATH_ID_RE.test(path) ||
    (MUSIC_PATH_PREFIX_RE.test(path) &&
      Boolean(getDigitParam(params, ['music_id', 'id'])))
  ) {
    return 'music';
  }

  // User Profile / 博主主页: /user/<sec_uid>, /share/user/<sec_uid>, /profile/<sec_uid>, /share/user/?sec_uid=...
  if (
    USER_PATH_ID_RE.test(path) ||
    (USER_PATH_PREFIX_RE.test(path) && Boolean(getSecUidParam(params))) ||
    Boolean(getSecUidParam(params))
  ) {
    return 'user';
  }

  if (LIVE_PATH_ID_RE.test(path)) {
    return 'live';
  }

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
  const params = parsed.searchParams;

  switch (type) {
    case 'video':
      return (
        getDigitParam(params, ['modal_id']) ||
        path.match(VIDEO_PATH_ID_RE)?.[1] ||
        getDigitParam(params, ['aweme_id', 'item_ids', 'vid'])
      );
    case 'user': {
      const fromPath = path.match(USER_PATH_ID_RE)?.[1];
      if (fromPath) {
        const decoded = safeDecodeSegment(fromPath).trim();
        if (decoded && VALID_SEC_UID_RE.test(decoded)) {
          return decoded;
        }
      }
      return getSecUidParam(params);
    }
    case 'gallery':
      return (
        path.match(GALLERY_PATH_ID_RE)?.[1] ||
        getDigitParam(params, ['modal_id', 'aweme_id', 'item_ids', 'note_id'])
      );
    case 'collection':
      return (
        path.match(COLLECTION_PATH_ID_RE)?.[1] ||
        getDigitParam(params, ['mix_id', 'collection_id']) ||
        (COLLECTION_PATH_PREFIX_RE.test(path)
          ? getDigitParam(params, ['id'])
          : undefined)
      );
    case 'music':
      return (
        path.match(MUSIC_PATH_ID_RE)?.[1] ||
        getDigitParam(params, ['music_id', 'id'])
      );
    case 'live': {
      if (parsed.hostname.toLowerCase() === 'live.douyin.com') {
        return path.match(/^\/(\d+)\/?$/)?.[1];
      }
      return path.match(LIVE_PATH_ID_RE)?.[1];
    }
    case 'live_replay':
      return path.match(LIVE_REPLAY_PATH_ID_RE)?.[1];
    case 'short':
      return path.replace(/^\/+|\/+$/g, '') || undefined;
    case 'lvdetail':
      return path.match(LVDETAIL_PATH_ID_RE)?.[1];
    default:
      return undefined;
  }
}

export function buildCanonicalDouyinUrl(
  type: DouyinUrlType,
  targetId?: string,
): string | undefined {
  if (!targetId) return undefined;
  switch (type) {
    case 'video':
      return `https://www.douyin.com/video/${encodeURIComponent(targetId)}`;
    case 'gallery':
      return `https://www.douyin.com/note/${encodeURIComponent(targetId)}`;
    case 'user':
      return `https://www.douyin.com/user/${encodeURIComponent(targetId)}`;
    case 'collection':
      return `https://www.douyin.com/collection/${encodeURIComponent(targetId)}`;
    case 'music':
      return `https://www.douyin.com/music/${encodeURIComponent(targetId)}`;
    case 'live':
      return `https://live.douyin.com/${encodeURIComponent(targetId)}`;
    case 'live_replay':
      return `https://www.douyin.com/vsdetail/${encodeURIComponent(targetId)}`;
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

function makeDedupeKey(rawUrl: string): string {
  const trimmed = rawUrl.replace(/\/+$/, '');
  try {
    const u = new URL(trimmed);
    const normPath = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.protocol.toLowerCase()}//${u.hostname.toLowerCase()}${normPath}${u.search}`;
  } catch {
    return trimmed;
  }
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
    const key = makeDedupeKey(url);
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

/**
 * Extracts a safe Douyin redirect URL from HTML fallback pages
 * (meta refresh, canonical link, or JS location redirect).
 */
export function extractHtmlRedirectUrl(
  html: string,
  baseUrl: string,
): string | null {
  if (!html) return null;
  const snippet = html.slice(0, 32_000);
  const patterns = [
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'\s>]+)["']/i,
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
    /(?:window\.)?location(?:\.href\s*=\s*|\.replace\(\s*)["']([^"']+)["']/i,
  ];

  for (const re of patterns) {
    const match = snippet.match(re);
    const candidate = match?.[1]?.trim();
    if (!candidate) continue;
    try {
      const target = new URL(candidate, baseUrl);
      if (
        (target.protocol === 'https:' || target.protocol === 'http:') &&
        isAllowedDouyinUpstreamHost(target.hostname)
      ) {
        return target.toString();
      }
    } catch {
      // ignore invalid URL
    }
  }
  return null;
}

/**
 * Follows multi-hop HTTP redirects (301/302/303/307/308) and HTML redirect fallbacks
 * for Douyin short URLs while enforcing strict SSRF host allowlisting on every hop.
 */
export async function resolveShortUrlRedirect(
  rawUrl: string,
  options: ShortUrlResolveOptions = {},
): Promise<ShortUrlResolveResult | null> {
  if (!isShortUrl(rawUrl)) return null;

  const initialUrl = normalizeShortUrl(rawUrl);
  let initialParsed: URL;
  try {
    initialParsed = new URL(initialUrl);
  } catch {
    return null;
  }

  if (!isAllowedDouyinUpstreamHost(initialParsed.hostname)) {
    return null;
  }

  const maxRedirects = Math.min(10, Math.max(1, options.maxRedirects ?? 5));
  const timeoutMs = Math.max(500, options.timeoutMs ?? 5000);
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return null;
  }

  const headers: Record<string, string> = {
    'User-Agent': options.userAgent || DEFAULT_MOBILE_UA,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  if (options.cookieString?.trim()) {
    headers.Cookie = options.cookieString.trim();
  }

  const redirectChain: string[] = [initialUrl];
  const visited = new Set<string>([initialUrl]);
  let currentUrl = initialUrl;

  for (let hop = 0; hop < maxRedirects; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchFn(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers,
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      break;
    }
    clearTimeout(timer);

    const location = response.headers.get('location');
    if (location && REDIRECT_STATUS_CODES.has(response.status)) {
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        break;
      }
      if (
        (nextUrl.protocol !== 'https:' && nextUrl.protocol !== 'http:') ||
        !isAllowedDouyinUpstreamHost(nextUrl.hostname)
      ) {
        // Block redirect to non-Douyin host (SSRF defense)
        return null;
      }
      const nextStr = nextUrl.toString();
      if (visited.has(nextStr)) {
        break;
      }
      visited.add(nextStr);
      redirectChain.push(nextStr);
      currentUrl = nextStr;

      const detected = detectUrlType(currentUrl);
      if (detected !== 'short' && detected !== 'unsupported') {
        return {
          resolvedUrl: currentUrl,
          redirectChain,
          hops: redirectChain.length - 1,
        };
      }
      continue;
    }

    // Fallback: some Douyin short links return HTTP 200 HTML with canonical/meta/JS redirect
    if (response.status >= 200 && response.status < 300) {
      const contentType = response.headers.get('content-type') || '';
      if (!contentType || contentType.includes('text/html')) {
        try {
          const html = await response.text();
          const htmlTarget = extractHtmlRedirectUrl(html, currentUrl);
          if (htmlTarget && !visited.has(htmlTarget)) {
            visited.add(htmlTarget);
            redirectChain.push(htmlTarget);
            currentUrl = htmlTarget;
            const detected = detectUrlType(currentUrl);
            if (detected !== 'short' && detected !== 'unsupported') {
              return {
                resolvedUrl: currentUrl,
                redirectChain,
                hops: redirectChain.length - 1,
              };
            }
            continue;
          }
        } catch {
          // ignore body read failures
        }
      }
    }

    break;
  }

  if (redirectChain.length <= 1) {
    return null;
  }

  return {
    resolvedUrl: currentUrl,
    redirectChain,
    hops: redirectChain.length - 1,
  };
}

export async function parseAndResolveDouyinUrl(
  rawUrl: string,
  options: ShortUrlResolveOptions & { index?: number } = {},
): Promise<ParsedLink> {
  const idx = options.index ?? 0;
  const initial = parseDouyinUrl(rawUrl, idx);
  if (initial.type !== 'short') {
    return initial;
  }

  const redirectResult = await resolveShortUrlRedirect(
    initial.originalUrl,
    options,
  );
  if (!redirectResult) {
    return initial;
  }

  const reparsed = parseDouyinUrl(redirectResult.resolvedUrl, idx);
  return {
    ...reparsed,
    id: initial.id,
    originalUrl: initial.originalUrl,
    resolvedUrl:
      buildCanonicalDouyinUrl(reparsed.type, reparsed.targetId) ||
      redirectResult.resolvedUrl,
  };
}

export async function resolveParsedLinks(
  links: ParsedLink[],
  options: ShortUrlResolveOptions = {},
): Promise<ParsedLink[]> {
  return Promise.all(
    links.map(async (link, idx) => {
      if (link.type !== 'short') return link;
      const redirectResult = await resolveShortUrlRedirect(
        link.originalUrl,
        options,
      );
      if (!redirectResult) return link;
      const reparsed = parseDouyinUrl(redirectResult.resolvedUrl, idx);
      return {
        ...reparsed,
        id: link.id,
        originalUrl: link.originalUrl,
        resolvedUrl:
          buildCanonicalDouyinUrl(reparsed.type, reparsed.targetId) ||
          redirectResult.resolvedUrl,
      };
    }),
  );
}
