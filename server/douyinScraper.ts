import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractAwemeListFromRouterData,
  extractRouterDataFromHtml,
  parseAwemeToMedia,
  parseCookieString,
  type ParsedAwemeMedia,
  type RawAweme,
} from '../src/lib/douyinParser';
import { isWithinDateRange } from '../src/lib/batchRules';
import { buildCanonicalDouyinUrl } from '../src/lib/urlParser';
import type {
  BatchSettings,
  DiscoveredWork,
  DownloadMode,
  ParsedLink,
  VideoQuality,
} from '../src/lib/types';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

export interface CreatorProfileSummary {
  nickname: string;
  secUid: string;
  awemeCount: number;
  favoritingCount: number;
  avatarUrl?: string;
}

export interface DiscoveryResult {
  works: DiscoveredWork[];
  profile?: CreatorProfileSummary;
  warnings: string[];
  requiresCookie?: boolean;
}

export function isHeadlessShellBinary(chromePath: string): boolean {
  return /headless[-_]shell/i.test(path.basename(chromePath));
}

export function buildChromeLaunchArgs(
  chromePath: string,
  userDataDir: string,
): string[] {
  const args: string[] = [];

  if (!isHeadlessShellBinary(chromePath)) {
    // Full GUI Chrome / Chromium / Edge / Brave binaries on macOS/Linux/Windows
    // MUST run in headless mode so they never open a visible window or hijack a tab.
    args.push('--headless=new');
  }

  args.push(
    // Always use an isolated temporary profile directory:
    // 1. Prevents forwarding `about:blank` to an already-running Chrome instance (SingletonLock)
    //    and exiting immediately with code 0.
    // 2. Satisfies Chrome 136+'s requirement that --remote-debugging-port use a non-default
    //    --user-data-dir.
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--use-mock-keychain',
    '--password-store=basic',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--mute-audio',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1440,900',
    '--lang=zh-CN',
    `--user-agent=${DESKTOP_UA}`,
    '--remote-debugging-port=0',
    'about:blank',
  );

  return args;
}

function findChromeBinary(): string | null {
  const home = os.homedir();
  const candidates = [
    process.env.CHROME_PATH,
    // macOS standard Chrome / Chromium / Edge / Brave / Arc paths
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Arc.app/Contents/MacOS/Arc',
    // Linux / container Playwright Chromium paths
    '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell',
    '/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    // Windows standard Chrome / Edge paths
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

function mediaToDiscoveredWork(
  media: ParsedAwemeMedia,
  sourceUrl: string,
  mode: DownloadMode,
): DiscoveredWork {
  const canonicalUrl =
    media.mediaType === 'gallery'
      ? `https://www.douyin.com/note/${media.awemeId}`
      : `https://www.douyin.com/video/${media.awemeId}`;
  return {
    awemeId: media.awemeId,
    sourceUrl:
      sourceUrl && (sourceUrl.includes(`/video/${media.awemeId}`) || sourceUrl.includes(`/note/${media.awemeId}`))
        ? sourceUrl
        : canonicalUrl,
    type: media.mediaType,
    mode,
    title: media.title,
    author: media.author,
    authorId: media.authorId,
    publishDate: media.publishDate,
    publishTs: media.publishTs,
    videoUrl: media.videoUrl,
    videoUri: media.videoUri,
    isNeedSetCookie: media.isNeedSetCookie,
    width: media.width,
    height: media.height,
    sourceWidth: media.sourceWidth,
    sourceHeight: media.sourceHeight,
    imageUrls: media.imageUrls,
    coverUrl: media.coverUrl,
    musicUrl: media.musicUrl,
    avatarUrl: media.avatarUrl,
    sizeBytes: media.sizeBytes,
    diggCount: media.diggCount,
    commentCount: media.commentCount,
  };
}

export async function fetchUserProfileInfo(
  secUid: string,
  cookieString?: string,
): Promise<CreatorProfileSummary | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const headers: Record<string, string> = {
      'User-Agent': MOBILE_UA,
      Referer: 'https://www.iesdouyin.com/',
      Accept: 'application/json',
    };
    if (cookieString?.trim()) {
      headers.Cookie = cookieString.trim();
    }
    const res = await fetch(
      `https://www.iesdouyin.com/web/api/v2/user/info/?sec_uid=${encodeURIComponent(secUid)}`,
      { headers, signal: controller.signal },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      user_info?: {
        nickname?: string;
        aweme_count?: number;
        favoriting_count?: number;
        avatar_larger?: { url_list?: string[] };
      };
    };
    const info = json.user_info;
    if (!info) return null;
    return {
      nickname: info.nickname || `创作者_${secUid.slice(-6)}`,
      secUid,
      awemeCount: Number(info.aweme_count || 0),
      favoritingCount: Number(info.favoriting_count || 0),
      avatarUrl: info.avatar_larger?.url_list?.[0],
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchSingleAwemeBySharePage(
  awemeId: string,
  quality: VideoQuality,
  cookieString?: string,
  preferGallery = false,
): Promise<ParsedAwemeMedia | null> {
  const encodedId = encodeURIComponent(awemeId);
  const urlsToTry = preferGallery
    ? [
        `https://www.iesdouyin.com/share/note/${encodedId}/`,
        `https://www.iesdouyin.com/share/slides/${encodedId}/`,
        `https://www.iesdouyin.com/share/video/${encodedId}/`,
      ]
    : [
        `https://www.iesdouyin.com/share/video/${encodedId}/`,
        `https://www.iesdouyin.com/share/note/${encodedId}/`,
        `https://www.iesdouyin.com/share/slides/${encodedId}/`,
      ];

  for (const shareUrl of urlsToTry) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6500);
    try {
      const headers: Record<string, string> = {
        'User-Agent': MOBILE_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      };
      if (cookieString?.trim()) {
        headers.Cookie = cookieString.trim();
      }
      const res = await fetch(shareUrl, {
        headers,
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!res.ok) continue;
      const html = await res.text();
      const routerData = extractRouterDataFromHtml(html);
      if (!routerData) continue;
      const rawList = extractAwemeListFromRouterData(routerData);
      for (const raw of rawList) {
        const parsed = parseAwemeToMedia(raw, quality);
        if (parsed && (parsed.videoUrl || parsed.imageUrls.length > 0)) {
          return parsed;
        }
      }
    } catch {
      // try next URL
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

export interface CdpSession {
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onEvent: (handler: (method: string, params: Record<string, unknown>) => void) => void;
  close: () => void;
}

export type CdpSessionFactory = () => Promise<CdpSession>;

let customCdpSessionFactory: CdpSessionFactory | null = null;

export function setCustomCdpSessionFactory(factory: CdpSessionFactory | null): void {
  customCdpSessionFactory = factory;
}

function readDevToolsActivePort(userDataDir: string): string | null {
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  try {
    if (!fs.existsSync(portFile)) return null;
    const lines = fs
      .readFileSync(portFile, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const port = Number(lines[0]);
    const wsPath = lines[1] || '/devtools/browser';
    if (!Number.isFinite(port) || port <= 0) return null;
    return `ws://127.0.0.1:${port}${wsPath.startsWith('/') ? wsPath : `/${wsPath}`}`;
  } catch {
    return null;
  }
}

async function resolvePageTargetWsUrl(baseHttp: string): Promise<string> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseHttp}/json/list`);
      if (res.ok) {
        const targets = (await res.json()) as Array<{
          type?: string;
          webSocketDebuggerUrl?: string;
        }>;
        const pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (pageTarget?.webSocketDebuggerUrl) {
          return pageTarget.webSocketDebuggerUrl;
        }
      }
    } catch {
      // retry until DevTools HTTP endpoint is ready
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  for (const method of ['PUT', 'GET'] as const) {
    try {
      const res = await fetch(`${baseHttp}/json/new?about:blank`, { method });
      if (res.ok) {
        const created = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (created.webSocketDebuggerUrl) {
          return created.webSocketDebuggerUrl;
        }
      }
    } catch {
      // try fallback method
    }
  }

  throw new Error('未能获取 Chromium 页面调试目标');
}

async function openExternalChromeCdpSession(): Promise<CdpSession> {
  const chromePath = findChromeBinary();
  if (!chromePath) {
    throw new Error('未找到可用的 Chrome / Chromium 浏览器，无法启动页面抓取引擎');
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-cdp-'));
  const proc: ChildProcess = spawn(
    chromePath,
    buildChromeLaunchArgs(chromePath, userDataDir),
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let ws: WebSocket | null = null;
  let cleanedUp = false;

  const removeUserDataDir = () => {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore temp profile cleanup errors
    }
  };

  proc.once('exit', () => {
    const timer = setTimeout(removeUserDataDir, 250);
    timer.unref?.();
  });

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      ws?.close();
    } catch {
      // ignore
    }
    try {
      if (proc.exitCode === null && !proc.killed) {
        proc.kill('SIGKILL');
      }
    } catch {
      // ignore
    }
    const timer = setTimeout(removeUserDataDir, 400);
    timer.unref?.();
  };

  try {
    const wsBrowserUrl = await new Promise<string>((resolve, reject) => {
      let stderrBuf = '';
      let settled = false;

      const finish = (err: Error | null, url?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(portPoller);
        if (err) reject(err);
        else resolve(url!);
      };

      const timer = setTimeout(
        () => finish(new Error('Chromium 启动超时')),
        15_000,
      );

      const portPoller = setInterval(() => {
        const activePortUrl = readDevToolsActivePort(userDataDir);
        if (activePortUrl) {
          finish(null, activePortUrl);
        }
      }, 200);

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        const match = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) {
          finish(null, match[1]);
        }
      });

      proc.on('error', (err) => {
        finish(new Error(`Chromium 启动失败: ${err.message}`));
      });

      proc.on('exit', (code) => {
        const tail = stderrBuf
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(-3)
          .join(' | ');
        finish(
          new Error(
            tail
              ? `Chromium 异常退出 (code=${code}): ${tail}`
              : `Chromium 异常退出 (code=${code})`,
          ),
        );
      });
    });

    const baseHttp = wsBrowserUrl
      .replace(/^ws:\/\//, 'http://')
      .replace(/\/devtools\/browser.*$/, '');
    const pageWsUrl = await resolvePageTargetWsUrl(baseHttp);

    ws = new WebSocket(pageWsUrl);
    let msgId = 1;
    const pending = new Map<
      number,
      { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
    >();
    const listeners: Array<(method: string, params: Record<string, unknown>) => void> = [];

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
          result?: Record<string, unknown>;
          error?: { message?: string };
        };
        if (msg.id && pending.has(msg.id)) {
          const entry = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(msg.error.message || 'CDP error'));
          else entry.resolve(msg.result || {});
        } else if (msg.method) {
          for (const listener of listeners) {
            listener(msg.method, msg.params || {});
          }
        }
      } catch {
        // ignore malformed frames
      }
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 6000);
      ws!.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws!.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP WebSocket 连接失败'));
      });
    });

    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = msgId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP 调用超时: ${method}`));
        }, 12_000);
        pending.set(id, {
          resolve: (val) => {
            clearTimeout(timer);
            resolve(val);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
        ws!.send(JSON.stringify({ id, method, params }));
      });

    return {
      send,
      onEvent: (handler) => listeners.push(handler),
      close: cleanup,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

async function openCdpSession(): Promise<CdpSession> {
  if (customCdpSessionFactory) {
    try {
      return await customCdpSessionFactory();
    } catch (err) {
      console.warn(
        '[douyinScraper] 内置 Chromium 会话初始化失败，回退至系统无头 Chrome:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  return openExternalChromeCdpSession();
}

export type ScrapeTargetKind =
  | 'single'
  | 'user_post'
  | 'user_like'
  | 'user_mix_list'
  | 'user_collect'
  | 'collection'
  | 'music';

export interface ScrapeTarget {
  kind: ScrapeTargetKind;
  expectedSecUid?: string;
  expectedMixId?: string;
  expectedMusicId?: string;
  expectedAwemeId?: string;
  strictAuthorFilter: boolean;
}

export interface DiscoveredMixSummary {
  mixId: string;
  mixName: string;
  authorSecUid?: string;
  authorNickname?: string;
  expectedEpisodeCount?: number;
}

interface ScrapeOptions {
  quality: VideoQuality;
  cookieString?: string;
  mode: DownloadMode;
  maxItems: number;
  startDate?: string;
  endDate?: string;
  sourceUrl: string;
  paginate: boolean;
  target: ScrapeTarget;
}

interface PageScrapeResult {
  works: DiscoveredWork[];
  mixes: DiscoveredMixSummary[];
  profile?: CreatorProfileSummary;
  collectionOwnerSecUid?: string;
  collectionOwnerNickname?: string;
  expectedCollectionEpisodes?: number;
  filteredOtherAuthorCount: number;
  emptyBlockedResponses: number;
  loginRequired: boolean;
  hasMoreRemaining: boolean;
  warnings: string[];
}

interface ScrollStepResult {
  moved: boolean;
  maxScrollHeight: number;
  wheelTargets: Array<{ x: number; y: number }>;
  reachedBottomText: boolean;
  isLoading: boolean;
}

const MAX_SCROLL_ROUNDS = 600;
const MAX_CRAWL_DURATION_MS = 8 * 60_000;
const MAX_IDLE_ROUNDS = 8;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getApiQueryParam(apiUrl: string, keys: string[]): string | undefined {
  if (!apiUrl) return undefined;
  try {
    const parsed = new URL(apiUrl, 'https://www.douyin.com');
    for (const key of keys) {
      const val = parsed.searchParams.get(key)?.trim();
      if (val) return val;
    }
  } catch {
    // ignore malformed URLs
  }
  return undefined;
}

export function classifyDouyinApiUrl(
  apiUrl: string,
  target: ScrapeTarget,
): 'target' | 'profile' | 'mix_detail' | 'ignore' {
  if (!apiUrl) return 'ignore';

  if (apiUrl.includes('/aweme/v1/web/user/profile/other')) {
    if (
      target.kind === 'user_post' ||
      target.kind === 'user_like' ||
      target.kind === 'user_mix_list' ||
      target.kind === 'user_collect'
    ) {
      const reqSecUid = getApiQueryParam(apiUrl, ['sec_user_id', 'sec_uid']);
      if (target.expectedSecUid && reqSecUid && reqSecUid !== target.expectedSecUid) {
        return 'ignore';
      }
      return 'profile';
    }
    return 'ignore';
  }

  if (apiUrl.includes('/aweme/v1/web/mix/detail')) {
    if (target.kind === 'collection') {
      const reqMixId = getApiQueryParam(apiUrl, ['mix_id']);
      if (target.expectedMixId && reqMixId && reqMixId !== target.expectedMixId) {
        return 'ignore';
      }
      return 'mix_detail';
    }
    return 'ignore';
  }

  switch (target.kind) {
    case 'single': {
      if (!apiUrl.includes('/aweme/v1/web/aweme/detail')) return 'ignore';
      const reqAwemeId = getApiQueryParam(apiUrl, ['aweme_id']);
      if (target.expectedAwemeId && reqAwemeId && reqAwemeId !== target.expectedAwemeId) {
        return 'ignore';
      }
      return 'target';
    }
    case 'user_post': {
      if (!apiUrl.includes('/aweme/v1/web/aweme/post')) return 'ignore';
      const reqSecUid = getApiQueryParam(apiUrl, ['sec_user_id', 'sec_uid']);
      if (target.expectedSecUid && reqSecUid && reqSecUid !== target.expectedSecUid) {
        return 'ignore';
      }
      return 'target';
    }
    case 'user_like': {
      if (!apiUrl.includes('/aweme/v1/web/aweme/favorite')) return 'ignore';
      const reqSecUid = getApiQueryParam(apiUrl, ['sec_user_id', 'sec_uid']);
      if (target.expectedSecUid && reqSecUid && reqSecUid !== target.expectedSecUid) {
        return 'ignore';
      }
      return 'target';
    }
    case 'user_collect': {
      if (
        !apiUrl.includes('/aweme/v1/web/aweme/listcollection') &&
        !apiUrl.includes('/aweme/v1/web/aweme/collect')
      ) {
        return 'ignore';
      }
      return 'target';
    }
    case 'user_mix_list': {
      if (!apiUrl.includes('/aweme/v1/web/mix/list')) return 'ignore';
      const reqSecUid = getApiQueryParam(apiUrl, ['sec_user_id', 'sec_uid']);
      if (target.expectedSecUid && reqSecUid && reqSecUid !== target.expectedSecUid) {
        return 'ignore';
      }
      return 'target';
    }
    case 'collection': {
      if (!apiUrl.includes('/aweme/v1/web/mix/aweme')) return 'ignore';
      const reqMixId = getApiQueryParam(apiUrl, ['mix_id']);
      if (target.expectedMixId && reqMixId && reqMixId !== target.expectedMixId) {
        return 'ignore';
      }
      return 'target';
    }
    case 'music': {
      if (!apiUrl.includes('/aweme/v1/web/music/aweme')) return 'ignore';
      const reqMusicId = getApiQueryParam(apiUrl, ['music_id']);
      if (target.expectedMusicId && reqMusicId && reqMusicId !== target.expectedMusicId) {
        return 'ignore';
      }
      return 'target';
    }
    default:
      return 'ignore';
  }
}

export function shouldAcceptWorkForTarget(
  raw: RawAweme | null,
  media: ParsedAwemeMedia,
  target: ScrapeTarget,
  resolvedOwnerSecUid?: string,
  resolvedOwnerNickname?: string,
): { accepted: boolean; reason?: 'other_author' | 'other_mix' | 'other_aweme' } {
  if (target.kind === 'single' && target.expectedAwemeId) {
    if (media.awemeId !== target.expectedAwemeId) {
      return { accepted: false, reason: 'other_aweme' };
    }
  }

  if (target.kind === 'collection' && target.expectedMixId) {
    const rawMixId = raw?.mix_info?.mix_id;
    if (rawMixId !== undefined && rawMixId !== null && String(rawMixId).trim()) {
      if (String(rawMixId).trim() !== target.expectedMixId) {
        return { accepted: false, reason: 'other_mix' };
      }
    }
  }

  if (target.strictAuthorFilter) {
    const ownerSecUid = (resolvedOwnerSecUid || target.expectedSecUid || '').trim();
    if (ownerSecUid) {
      if (media.authorId) {
        if (media.authorId !== ownerSecUid) {
          return { accepted: false, reason: 'other_author' };
        }
      } else if (resolvedOwnerNickname) {
        if (media.author !== resolvedOwnerNickname) {
          return { accepted: false, reason: 'other_author' };
        }
      } else {
        return { accepted: false, reason: 'other_author' };
      }
    }
  }

  return { accepted: true };
}

export function resolveDominantAuthorSecUid(works: DiscoveredWork[]): string | undefined {
  const counts = new Map<string, number>();
  for (const work of works) {
    const id = work.authorId?.trim();
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  let bestId: string | undefined;
  let bestCount = 0;
  for (const [id, count] of counts.entries()) {
    if (count > bestCount) {
      bestId = id;
      bestCount = count;
    }
  }
  return bestId;
}

export function buildNextCursorApiUrl(
  templateUrl: string,
  cursorParam: 'cursor' | 'max_cursor',
  nextCursor: string | number,
): string | null {
  if (!templateUrl) return null;
  try {
    const parsed = new URL(templateUrl, 'https://www.douyin.com');
    parsed.searchParams.set(cursorParam, String(nextCursor));
    parsed.searchParams.delete('a_bogus');
    parsed.searchParams.delete('X-Bogus');
    parsed.searchParams.delete('_signature');
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

function getCursorParamName(kind: ScrapeTargetKind): 'cursor' | 'max_cursor' {
  if (kind === 'user_post' || kind === 'user_like') {
    return 'max_cursor';
  }
  return 'cursor';
}

function extractNextCursorFromPayload(
  data: Record<string, unknown>,
  kind: ScrapeTargetKind,
): string | undefined {
  const primaryKey = getCursorParamName(kind);
  const candidates =
    primaryKey === 'max_cursor'
      ? [data.max_cursor, data.cursor]
      : [data.cursor, data.max_cursor];
  for (const val of candidates) {
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
      return String(val);
    }
    if (typeof val === 'string' && val.trim() && val.trim() !== '0') {
      return val.trim();
    }
  }
  return undefined;
}

async function prepareCdpSession(session: CdpSession, cookieString?: string): Promise<void> {
  await session.send('Network.enable');
  await session.send('Page.enable');
  await session.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
      window.chrome = { runtime: {} };
    `,
  });

  const parsedCookies = parseCookieString(cookieString || '');
  if (parsedCookies.length > 0) {
    const cdpCookies: Array<Record<string, unknown>> = parsedCookies.flatMap<
      Record<string, unknown>
    >((c) => {
      if (c.name.startsWith('__Host-')) {
        return [
          {
            name: c.name,
            value: c.value,
            url: 'https://www.douyin.com',
            path: '/',
            secure: true,
          },
        ];
      }
      const secure = c.name.startsWith('__Secure-') ? true : undefined;
      return [
        { ...c, domain: '.douyin.com', ...(secure ? { secure } : {}) },
        { ...c, domain: '.iesdouyin.com', ...(secure ? { secure } : {}) },
      ];
    });
    try {
      await session.send('Network.setCookies', { cookies: cdpCookies });
    } catch {
      for (const cookie of cdpCookies) {
        await session.send('Network.setCookie', cookie).catch(() => undefined);
      }
    }
  }
}

async function dismissBlockingModals(session: CdpSession): Promise<void> {
  await session
    .send('Runtime.evaluate', {
      expression: `(() => {
        let closed = false;
        const selectors = [
          '.dy-account-close',
          '[class*="login"] [class*="close"]',
          '[id*="login"] [class*="close"]',
          '[class*="modal"] [aria-label*="关闭"]',
          '[role="dialog"] [aria-label*="关闭"]',
          '[aria-label="关闭"]'
        ];
        for (const sel of selectors) {
          const nodes = Array.from(document.querySelectorAll(sel));
          for (const el of nodes) {
            const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            if (rect && rect.width > 0 && rect.height > 0 && typeof el.click === 'function') {
              el.click();
              closed = true;
            }
          }
        }
        if (closed) {
          if (document.body && document.body.style.overflow === 'hidden') {
            document.body.style.overflow = '';
          }
          if (document.documentElement && document.documentElement.style.overflow === 'hidden') {
            document.documentElement.style.overflow = '';
          }
        }
      })()`,
    })
    .catch(() => undefined);
}

async function clickUserHomepageTab(session: CdpSession, tabLabel: string): Promise<boolean> {
  const res = await session
    .send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const label = ${JSON.stringify(tabLabel)};
        const isMatch = (text) => {
          const t = (text || '').replace(/\\s+/g, ' ').trim();
          return t === label || t.startsWith(label + ' ') || new RegExp('^' + label + '\\\\s*\\\\d').test(t);
        };
        const priority = Array.from(document.querySelectorAll('[role="tab"], [data-e2e*="tab"]'));
        const fallback = Array.from(document.querySelectorAll('a, button, div, span')).filter(
          (el) => el.childElementCount <= 2
        );
        const candidates = [...priority, ...fallback];
        for (const el of candidates) {
          const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
          if (!rect || rect.width < 16 || rect.height < 12 || rect.top < 0 || rect.top > 850) {
            continue;
          }
          if (isMatch(el.textContent || '')) {
            if (typeof el.scrollIntoView === 'function') {
              el.scrollIntoView({ behavior: 'instant', block: 'center' });
            }
            if (typeof el.click === 'function') {
              el.click();
              return true;
            }
          }
        }
        return false;
      })()`,
    })
    .catch(() => ({ result: { value: false } }));

  return Boolean((res.result as { value?: unknown })?.value);
}

async function performMouseAndContainerScroll(
  session: CdpSession,
  kind: ScrapeTargetKind,
  nudge: boolean,
): Promise<ScrollStepResult> {
  const isCollectionMode = kind === 'collection';

  if (nudge) {
    // Back up slightly first so IntersectionObserver bottom sentinels re-trigger when we scroll down again
    await session
      .send('Runtime.evaluate', {
        expression: `(() => {
          const isScrollable = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const oy = style ? style.overflowY : '';
            return (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 20;
          };
          const targets = new Set();
          if (document.scrollingElement && document.scrollingElement.scrollHeight > document.scrollingElement.clientHeight + 20) {
            targets.add(document.scrollingElement);
          }
          for (const sel of ['#douyin-right-container', '#parent-route-container']) {
            const el = document.querySelector(sel);
            if (el && el.scrollHeight > el.clientHeight + 20) targets.add(el);
          }
          for (const el of Array.from(document.querySelectorAll('div, main, section, ul, aside'))) {
            if (isScrollable(el)) {
              const r = el.getBoundingClientRect();
              if (r.width >= 180 && r.height >= 150) targets.add(el);
            }
          }
          for (const el of targets) {
            el.scrollTop = Math.max(0, el.scrollTop - 360);
            el.dispatchEvent(new Event('scroll', { bubbles: true }));
          }
          window.scrollBy(0, -360);
        })()`,
      })
      .catch(() => undefined);
    await sleep(220);
  }

  const evalRes = await session
    .send('Runtime.evaluate', {
      returnByValue: true,
      expression: `JSON.stringify((() => {
        const isCollection = ${JSON.stringify(isCollectionMode)};
        const isNudge = ${JSON.stringify(nudge)};

        const isVisible = (el) => {
          if (!el || !el.getBoundingClientRect) return false;
          const r = el.getBoundingClientRect();
          return r.width >= 160 && r.height >= 140 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
        };

        const isScrollable = (el) => {
          if (!el) return false;
          if (el === document.scrollingElement || el === document.documentElement || el === document.body) {
            return el.scrollHeight > window.innerHeight + 10;
          }
          const style = window.getComputedStyle(el);
          const oy = style ? style.overflowY : '';
          return (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 10;
        };

        const scored = new Map();
        const addCandidate = (el, bonus) => {
          if (!el || !isScrollable(el)) return;
          if (el !== document.scrollingElement && el !== document.documentElement && el !== document.body && !isVisible(el)) {
            return;
          }
          const prev = scored.get(el) || 0;
          scored.set(el, Math.max(prev, bonus));
        };

        if (document.scrollingElement) {
          addCandidate(document.scrollingElement, isCollection ? 30 : 60);
        }

        const anchorSelectors = isCollection
          ? [
              '[data-e2e*="mix"]',
              '[data-e2e*="collection"]',
              '[class*="mix"]',
              '[class*="collection"]',
              '[class*="episode"]',
              '[data-e2e="scroll-list"]',
              '#douyin-right-container',
              '#parent-route-container'
            ]
          : [
              '[data-e2e="user-post-list"]',
              '[data-e2e="user-like-list"]',
              '[data-e2e="user-mix-list"]',
              '[data-e2e="scroll-list"]',
              '#douyin-right-container',
              '#parent-route-container'
            ];

        for (const sel of anchorSelectors) {
          const nodes = Array.from(document.querySelectorAll(sel));
          for (const node of nodes) {
            addCandidate(node, 110);
            let cur = node.parentElement;
            let depth = 0;
            while (cur && depth < 6) {
              addCandidate(cur, 100 - depth * 5);
              cur = cur.parentElement;
              depth += 1;
            }
          }
        }

        for (const el of Array.from(document.querySelectorAll('div, main, section, ul, aside'))) {
          if (!isScrollable(el) || !isVisible(el)) continue;
          const linkCount = el.querySelectorAll('a[href*="/video/"], a[href*="/note/"], a[href*="/collection/"]').length;
          const cls = String(el.className || '').toLowerCase();
          const hasMixHint = cls.includes('mix') || cls.includes('collection') || cls.includes('episode') || cls.includes('list');
          let score = 20 + Math.min(40, linkCount * 4);
          if (isCollection && hasMixHint) score += 70;
          if (isCollection && linkCount >= 3) score += 45;
          addCandidate(el, score);
        }

        const ranked = Array.from(scored.entries())
          .sort((a, b) => {
            if (b[1] !== a[1]) return b[1] - a[1];
            return (b[0].scrollHeight || 0) - (a[0].scrollHeight || 0);
          })
          .map(([el]) => el)
          .slice(0, 5);

        let moved = false;
        let maxScrollHeight = Math.max(
          document.body ? document.body.scrollHeight : 0,
          document.documentElement ? document.documentElement.scrollHeight : 0
        );
        const wheelTargets = [];

        for (const el of ranked) {
          const beforeTop = el.scrollTop || 0;
          const sh = el.scrollHeight || 0;
          const ch = el.clientHeight || window.innerHeight || 900;
          if (sh > maxScrollHeight) maxScrollHeight = sh;

          // Stepped scroll followed by bottom scroll to wake virtualized lists & IntersectionObservers
          const stepped = Math.min(sh, beforeTop + Math.max(Math.round(ch * 0.9), 800));
          el.scrollTop = stepped;
          el.dispatchEvent(new Event('scroll', { bubbles: true }));
          el.scrollTop = sh;
          el.dispatchEvent(new Event('scroll', { bubbles: true }));

          if (Math.abs((el.scrollTop || 0) - beforeTop) > 4) {
            moved = true;
          }

          if (wheelTargets.length < 2) {
            if (el === document.scrollingElement || el === document.documentElement || el === document.body) {
              wheelTargets.push({ x: Math.round(window.innerWidth * 0.5), y: Math.round(window.innerHeight * 0.6) });
            } else {
              const r = el.getBoundingClientRect();
              wheelTargets.push({
                x: Math.round(Math.max(40, Math.min(window.innerWidth - 40, r.left + r.width * 0.5))),
                y: Math.round(Math.max(40, Math.min(window.innerHeight - 40, r.top + r.height * 0.55)))
              });
            }
          }
        }

        // Scroll the last rendered card into view inside primary list
        const lastItemSelectors = isCollection
          ? [
              '[data-e2e*="mix"] li:last-child',
              '[data-e2e*="mix"] a[href*="/video/"]',
              '[class*="mix"] a[href*="/video/"]',
              '[class*="collection"] a[href*="/video/"]',
              '[data-e2e="scroll-list"] > *:last-child'
            ]
          : [
              '[data-e2e="user-post-list"] li:last-child',
              '[data-e2e="user-like-list"] li:last-child',
              '[data-e2e="user-mix-list"] li:last-child',
              '[data-e2e="scroll-list"] > *:last-child'
            ];
        for (const sel of lastItemSelectors) {
          const matches = document.querySelectorAll(sel);
          if (matches.length > 0) {
            const last = matches[matches.length - 1];
            if (last && typeof last.scrollIntoView === 'function') {
              last.scrollIntoView({ behavior: 'instant', block: 'end' });
              break;
            }
          }
        }

        const beforeWinY = window.scrollY || 0;
        window.scrollTo(0, maxScrollHeight);
        window.dispatchEvent(new Event('scroll'));
        if (Math.abs((window.scrollY || 0) - beforeWinY) > 4) {
          moved = true;
        }

        if (isNudge) {
          const loadMoreKeywords = ['加载更多', '查看更多', '展开更多', '展开全部'];
          const btns = Array.from(document.querySelectorAll('button, [role="button"], div, span')).filter(
            (el) => el.childElementCount === 0
          );
          for (const btn of btns) {
            const txt = (btn.textContent || '').trim();
            if (txt.length <= 12 && loadMoreKeywords.some((kw) => txt === kw)) {
              const r = btn.getBoundingClientRect ? btn.getBoundingClientRect() : null;
              if (r && r.width > 10 && r.height > 10 && typeof btn.click === 'function') {
                btn.click();
                break;
              }
            }
          }
        }

        const bodyText = (document.body && document.body.innerText ? document.body.innerText : '').slice(-4000);
        const reachedBottomText =
          bodyText.includes('暂时没有更多了') ||
          bodyText.includes('没有更多了') ||
          bodyText.includes('已经到底了');
        const isLoading = bodyText.includes('加载中');

        return {
          moved,
          maxScrollHeight,
          wheelTargets: wheelTargets.length > 0 ? wheelTargets : [{ x: 720, y: 500 }],
          reachedBottomText,
          isLoading
        };
      })())`,
    })
    .catch(() => ({ result: { value: '' } }));

  let parsed: ScrollStepResult = {
    moved: false,
    maxScrollHeight: 0,
    wheelTargets: [{ x: 720, y: 500 }],
    reachedBottomText: false,
    isLoading: false,
  };
  try {
    const rawVal = String((evalRes.result as { value?: string })?.value || '');
    if (rawVal) {
      const obj = JSON.parse(rawVal) as Partial<ScrollStepResult>;
      parsed = {
        moved: Boolean(obj.moved),
        maxScrollHeight: Number(obj.maxScrollHeight || 0),
        wheelTargets:
          Array.isArray(obj.wheelTargets) && obj.wheelTargets.length > 0
            ? obj.wheelTargets
            : [{ x: 720, y: 500 }],
        reachedBottomText: Boolean(obj.reachedBottomText),
        isLoading: Boolean(obj.isLoading),
      };
    }
  } catch {
    // fallback defaults
  }

  // Dispatch real mouseWheel events over each detected scrollable container so Douyin's
  // wheel / IntersectionObserver / virtualized scrollers genuinely paginate to the bottom.
  for (const pt of parsed.wheelTargets.slice(0, 2)) {
    await session
      .send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: pt.x,
        y: pt.y,
      })
      .catch(() => undefined);

    const ticks = nudge ? 4 : 3;
    for (let t = 0; t < ticks; t += 1) {
      await session
        .send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: pt.x,
          y: pt.y,
          deltaX: 0,
          deltaY: 960,
        })
        .catch(() => undefined);
      await sleep(75);
    }
  }

  return parsed;
}

async function fetchNextCursorViaInPageXhr(
  session: CdpSession,
  nextPathAndQuery: string,
): Promise<string | null> {
  const evalRes = await session
    .send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        return await new Promise((resolve) => {
          try {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', ${JSON.stringify(nextPathAndQuery)}, true);
            xhr.withCredentials = true;
            xhr.timeout = 8500;
            xhr.onload = () => {
              resolve(xhr.status >= 200 && xhr.status < 300 ? (xhr.responseText || '') : '');
            };
            xhr.onerror = () => resolve('');
            xhr.ontimeout = () => resolve('');
            xhr.send();
          } catch {
            resolve('');
          }
        });
      })()`,
    })
    .catch(() => ({ result: { value: '' } }));

  const text = String((evalRes.result as { value?: string })?.value || '');
  return text.trim() ? text : null;
}

async function scrapePageInSession(
  session: CdpSession,
  targetUrl: string,
  options: ScrapeOptions,
): Promise<PageScrapeResult> {
  const warnings: string[] = [];
  const worksMap = new Map<string, DiscoveredWork>();
  const mixesMap = new Map<string, DiscoveredMixSummary>();
  let profile: CreatorProfileSummary | undefined;
  let collectionOwnerSecUid: string | undefined =
    options.target.expectedSecUid?.trim() || undefined;
  let collectionOwnerNickname: string | undefined;
  let expectedCollectionEpisodes: number | undefined;
  let filteredOtherAuthorCount = 0;
  let emptyBlockedResponses = 0;
  let loginRequired = false;
  let hasMoreRemaining = true;
  let targetApiPagesReceived = 0;
  let lastTargetApiUrl = '';
  let lastNextCursor: string | undefined;
  let olderThanStartDatePages = 0;
  let active = true;

  const requestUrlMap = new Map<
    string,
    { url: string; status: number; role: 'target' | 'profile' | 'mix_detail' }
  >();
  const inFlightTargetRequestIds = new Set<string>();
  const bodyTasks: Promise<void>[] = [];

  const handleJsonResponse = (
    apiUrl: string,
    role: 'target' | 'profile' | 'mix_detail',
    text: string,
  ) => {
    if (!text || !text.trim()) {
      if (role === 'target') {
        emptyBlockedResponses += 1;
      }
      return;
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    const statusCode = Number(data.status_code ?? 0);
    const statusMsg = String(data.status_msg || '');
    if (
      statusCode === 2483 ||
      statusMsg.includes('请先登录') ||
      statusMsg.includes('用户未登录')
    ) {
      loginRequired = true;
      return;
    }

    if (role === 'profile' && data.user && typeof data.user === 'object') {
      const u = data.user as Record<string, unknown>;
      const secUid = String(u.sec_uid || options.target.expectedSecUid || '');
      profile = {
        nickname: String(u.nickname || ''),
        secUid,
        awemeCount: Number(u.aweme_count || 0),
        favoritingCount: Number(u.favoriting_count || 0),
      };
      if (!collectionOwnerSecUid && secUid) {
        collectionOwnerSecUid = secUid;
      }
      if (!collectionOwnerNickname && profile.nickname) {
        collectionOwnerNickname = profile.nickname;
      }
      return;
    }

    if (role === 'mix_detail') {
      const mixInfo = (data.mix_info || data.mix_detail) as
        | {
            author?: { sec_uid?: string; nickname?: string };
            statis?: { updated_to_episode?: number; current_episode?: number };
          }
        | undefined;
      if (mixInfo?.author?.sec_uid) {
        collectionOwnerSecUid = String(mixInfo.author.sec_uid).trim();
      }
      if (mixInfo?.author?.nickname) {
        collectionOwnerNickname = String(mixInfo.author.nickname).trim();
      }
      const epCount = Number(
        mixInfo?.statis?.updated_to_episode || mixInfo?.statis?.current_episode || 0,
      );
      if (epCount > 0) {
        expectedCollectionEpisodes = epCount;
      }
      return;
    }

    if (role !== 'target') return;

    lastTargetApiUrl = apiUrl;
    const nextCursor = extractNextCursorFromPayload(data, options.target.kind);
    if (nextCursor) {
      lastNextCursor = nextCursor;
    }

    // Handle user_mix_list (/aweme/v1/web/mix/list)
    if (options.target.kind === 'user_mix_list') {
      const rawMixes = Array.isArray(data.mix_infos)
        ? (data.mix_infos as Array<{
            mix_id?: string | number;
            mix_name?: string;
            author?: { sec_uid?: string; nickname?: string };
            statis?: { updated_to_episode?: number; current_episode?: number };
          }>)
        : [];
      targetApiPagesReceived += 1;
      hasMoreRemaining = Boolean(data.has_more);

      for (const rawMix of rawMixes) {
        const mixId = String(rawMix.mix_id || '').trim();
        if (!mixId) continue;
        const mixAuthorSecUid = rawMix.author?.sec_uid?.trim();
        if (
          options.target.expectedSecUid &&
          mixAuthorSecUid &&
          mixAuthorSecUid !== options.target.expectedSecUid
        ) {
          continue;
        }
        if (!mixesMap.has(mixId)) {
          const epCount = Number(
            rawMix.statis?.updated_to_episode || rawMix.statis?.current_episode || 0,
          );
          mixesMap.set(mixId, {
            mixId,
            mixName: (rawMix.mix_name || '').trim() || `合集_${mixId}`,
            authorSecUid: mixAuthorSecUid,
            authorNickname: rawMix.author?.nickname?.trim(),
            expectedEpisodeCount: epCount > 0 ? epCount : undefined,
          });
        }
      }
      return;
    }

    let rawItems: RawAweme[] = [];
    if (Array.isArray(data.aweme_list)) {
      rawItems = data.aweme_list as RawAweme[];
      targetApiPagesReceived += 1;
      hasMoreRemaining = Boolean(data.has_more);
    } else if (data.aweme_detail && typeof data.aweme_detail === 'object') {
      rawItems = [data.aweme_detail as RawAweme];
      targetApiPagesReceived += 1;
      hasMoreRemaining = false;
    } else {
      return;
    }

    // In collection mode, learn owner sec_uid from mix_info on items if mix/detail hasn't arrived yet
    if (options.target.kind === 'collection' && !collectionOwnerSecUid) {
      for (const raw of rawItems) {
        const mixAuthorSec = raw.mix_info?.author?.sec_uid?.trim();
        if (mixAuthorSec) {
          collectionOwnerSecUid = mixAuthorSec;
          if (!collectionOwnerNickname && raw.mix_info?.author?.nickname) {
            collectionOwnerNickname = raw.mix_info.author.nickname.trim();
          }
          break;
        }
      }
    }

    let nonPinnedCount = 0;
    let olderThanStartCount = 0;

    for (const raw of rawItems) {
      const media = parseAwemeToMedia(raw, options.quality);
      if (!media) continue;

      const check = shouldAcceptWorkForTarget(
        raw,
        media,
        options.target,
        collectionOwnerSecUid,
        collectionOwnerNickname || profile?.nickname,
      );
      if (!check.accepted) {
        if (check.reason === 'other_author') {
          filteredOtherAuthorCount += 1;
        }
        continue;
      }

      if (options.startDate && !raw.is_top) {
        nonPinnedCount += 1;
        if (media.publishDate < options.startDate) {
          olderThanStartCount += 1;
        }
      }

      if (!isWithinDateRange(media.publishDate, options.startDate, options.endDate)) {
        continue;
      }
      if (!worksMap.has(media.awemeId)) {
        worksMap.set(
          media.awemeId,
          mediaToDiscoveredWork(media, options.sourceUrl, options.mode),
        );
      }
    }

    if (
      options.target.kind === 'user_post' &&
      options.startDate &&
      nonPinnedCount > 0 &&
      olderThanStartCount === nonPinnedCount
    ) {
      olderThanStartDatePages += 1;
    } else if (nonPinnedCount > 0) {
      olderThanStartDatePages = 0;
    }
  };

  session.onEvent((method, params) => {
    if (!active) return;

    if (method === 'Network.requestWillBeSent') {
      const req = params.request as { url?: string } | undefined;
      const reqId = String(params.requestId || '');
      const url = req?.url || '';
      if (reqId && classifyDouyinApiUrl(url, options.target) === 'target') {
        inFlightTargetRequestIds.add(reqId);
      }
    } else if (method === 'Network.responseReceived') {
      const resp = params.response as { url?: string; status?: number } | undefined;
      const reqId = String(params.requestId || '');
      const url = resp?.url || '';
      const role = classifyDouyinApiUrl(url, options.target);
      if (reqId && role !== 'ignore') {
        requestUrlMap.set(reqId, { url, status: Number(resp?.status || 0), role });
        if (role === 'target') {
          inFlightTargetRequestIds.add(reqId);
        }
      }
    } else if (method === 'Network.loadingFinished') {
      const reqId = String(params.requestId || '');
      inFlightTargetRequestIds.delete(reqId);
      const meta = requestUrlMap.get(reqId);
      if (!meta) return;
      requestUrlMap.delete(reqId);
      const task = session
        .send('Network.getResponseBody', { requestId: reqId })
        .then((res) => {
          const body = String(res.body || '');
          const text = res.base64Encoded
            ? Buffer.from(body, 'base64').toString('utf8')
            : body;
          handleJsonResponse(meta.url, meta.role, text);
        })
        .catch(() => {
          // body evicted or empty
        });
      bodyTasks.push(task);
    } else if (method === 'Network.loadingFailed') {
      const reqId = String(params.requestId || '');
      inFlightTargetRequestIds.delete(reqId);
      requestUrlMap.delete(reqId);
    }
  });

  const flushBodyTasks = async () => {
    if (bodyTasks.length > 0) {
      await Promise.allSettled(bodyTasks.splice(0, bodyTasks.length));
    }
  };

  const tabToClick =
    options.target.kind === 'user_like'
      ? '喜欢'
      : options.target.kind === 'user_mix_list'
        ? '合集'
        : options.target.kind === 'user_collect'
          ? '收藏'
          : null;

  try {
    await session.send('Page.navigate', { url: targetUrl });

    if (tabToClick) {
      // Wait for user homepage tabs/profile to hydrate before clicking the target tab
      const hydrateDeadline = Date.now() + 6_000;
      let clicked = false;
      while (Date.now() < hydrateDeadline) {
        await sleep(300);
        await flushBodyTasks();
        if (loginRequired || targetApiPagesReceived > 0) {
          clicked = true;
          break;
        }
        await dismissBlockingModals(session);
        clicked = await clickUserHomepageTab(session, tabToClick);
        if (clicked) break;
      }
      if (!clicked && !loginRequired && targetApiPagesReceived === 0) {
        await dismissBlockingModals(session);
        await clickUserHomepageTab(session, tabToClick);
      }
    }

    // Wait for initial JS hydration + first target API page
    const initDeadline = Date.now() + 12_000;
    const initStart = Date.now();
    while (Date.now() < initDeadline) {
      await sleep(200);
      await flushBodyTasks();
      if (
        targetApiPagesReceived > 0 ||
        loginRequired ||
        (emptyBlockedResponses > 0 && Date.now() - initStart > 3500)
      ) {
        break;
      }
    }

    await dismissBlockingModals(session);

    const collectedCount = () =>
      options.target.kind === 'user_mix_list' ? mixesMap.size : worksMap.size;

    if (options.paginate && !loginRequired) {
      const crawlDeadline = Date.now() + MAX_CRAWL_DURATION_MS;
      let idleRounds = 0;
      let scrollCount = 0;
      let prevMaxScrollHeight = 0;
      let xhrFallbackFailed = false;
      let usingXhrContinuation = false;
      const triedCursors = new Set<string>();

      while (Date.now() < crawlDeadline && scrollCount < MAX_SCROLL_ROUNDS) {
        await flushBodyTasks();

        if (loginRequired) break;
        if (
          options.target.kind !== 'user_mix_list' &&
          options.maxItems > 0 &&
          worksMap.size >= options.maxItems
        ) {
          break;
        }
        if (
          targetApiPagesReceived > 0 &&
          !hasMoreRemaining &&
          inFlightTargetRequestIds.size === 0
        ) {
          break;
        }
        if (olderThanStartDatePages >= 2 && inFlightTargetRequestIds.size === 0) {
          break;
        }
        if (collectedCount() === 0 && emptyBlockedResponses >= 3) {
          break;
        }

        const beforePages = targetApiPagesReceived;
        const beforeCount = collectedCount();
        const shouldNudge = idleRounds >= 2;

        if (shouldNudge) {
          await dismissBlockingModals(session);
        }

        const scrollRes = await performMouseAndContainerScroll(
          session,
          options.target.kind,
          shouldNudge,
        );
        scrollCount += 1;

        // Event-driven wait: resume promptly once a new target page arrives and settles,
        // or wait longer if a target API request is actively in-flight.
        const minWaitUntil = Date.now() + 350;
        const normalWaitDeadline = Date.now() + 1_500;
        const inFlightWaitDeadline = Date.now() + 3_500;

        while (Date.now() < inFlightWaitDeadline) {
          await sleep(100);
          await flushBodyTasks();

          const gotNewPage =
            targetApiPagesReceived > beforePages || collectedCount() > beforeCount;
          if (gotNewPage && inFlightTargetRequestIds.size === 0) {
            // Brief settle so DOM renders the newly appended cards before the next scroll
            await sleep(150);
            await flushBodyTasks();
            break;
          }
          if (loginRequired) break;
          if (
            targetApiPagesReceived > 0 &&
            !hasMoreRemaining &&
            inFlightTargetRequestIds.size === 0
          ) {
            break;
          }
          if (
            Date.now() >= normalWaitDeadline &&
            inFlightTargetRequestIds.size === 0
          ) {
            break;
          }
          if (Date.now() >= minWaitUntil && scrollRes.reachedBottomText && inFlightTargetRequestIds.size === 0 && targetApiPagesReceived > 0 && !hasMoreRemaining) {
            break;
          }
        }

        const pageAdvanced =
          targetApiPagesReceived > beforePages || collectedCount() > beforeCount;
        const heightExpanded = scrollRes.maxScrollHeight > prevMaxScrollHeight + 24;
        if (scrollRes.maxScrollHeight > prevMaxScrollHeight) {
          prevMaxScrollHeight = scrollRes.maxScrollHeight;
        }

        if (pageAdvanced) {
          idleRounds = 0;
        } else if (heightExpanded || scrollRes.isLoading) {
          // Container is still expanding or showing a loading spinner; be patient
          idleRounds = Math.min(idleRounds + 1, Math.max(1, MAX_IDLE_ROUNDS - 3));
        } else {
          idleRounds += 1;
        }

        // If DOM scrolling stalled while the API still reports has_more=true and we have a cursor,
        // try in-page XHR continuation (signed by Douyin's own in-page bdms/webmssdk hook).
        const xhrTriggerRounds = usingXhrContinuation ? 1 : 3;
        if (
          !pageAdvanced &&
          idleRounds >= xhrTriggerRounds &&
          !xhrFallbackFailed &&
          hasMoreRemaining &&
          lastTargetApiUrl &&
          lastNextCursor &&
          !triedCursors.has(lastNextCursor) &&
          inFlightTargetRequestIds.size === 0
        ) {
          const cursorToTry = lastNextCursor;
          triedCursors.add(cursorToTry);
          const nextPath = buildNextCursorApiUrl(
            lastTargetApiUrl,
            getCursorParamName(options.target.kind),
            cursorToTry,
          );
          if (nextPath) {
            const pagesBeforeXhr = targetApiPagesReceived;
            const xhrText = await fetchNextCursorViaInPageXhr(session, nextPath);
            await sleep(150);
            await flushBodyTasks();

            if (xhrText && targetApiPagesReceived === pagesBeforeXhr) {
              handleJsonResponse(
                `https://www.douyin.com${nextPath}`,
                'target',
                xhrText,
              );
            }

            if (targetApiPagesReceived > pagesBeforeXhr) {
              usingXhrContinuation = true;
              idleRounds = 0;
              await sleep(450);
              continue;
            } else {
              xhrFallbackFailed = true;
            }
          }
        }

        if (
          scrollRes.reachedBottomText &&
          targetApiPagesReceived > 0 &&
          inFlightTargetRequestIds.size === 0 &&
          idleRounds >= 3
        ) {
          break;
        }

        if (idleRounds >= MAX_IDLE_ROUNDS) {
          break;
        }
      }
    }

    await flushBodyTasks();

    // DOM fallback for user_mix_list: pick up any /collection/<id> links rendered on the 合集 tab
    if (options.target.kind === 'user_mix_list' && mixesMap.size === 0) {
      const domMixRes = await session
        .send('Runtime.evaluate', {
          returnByValue: true,
          expression: `JSON.stringify(
            Array.from(
              document.querySelectorAll(
                '[data-e2e="user-mix-list"] a[href*="/collection/"], #douyin-right-container a[href*="/collection/"], a[href*="/mix/detail/"]'
              )
            ).map((a) => ({
              href: a.getAttribute('href') || '',
              title: (a.textContent || '').trim()
            }))
          )`,
        })
        .catch(() => ({ result: { value: '[]' } }));

      let mixLinks: Array<{ href?: string; title?: string }> = [];
      try {
        mixLinks = JSON.parse(
          String((domMixRes.result as { value?: string })?.value || '[]'),
        );
      } catch {
        mixLinks = [];
      }

      for (const item of mixLinks) {
        const mixId = item.href?.match(/\/(?:collection|mix\/detail)\/(\d+)/)?.[1];
        if (mixId && !mixesMap.has(mixId)) {
          mixesMap.set(mixId, {
            mixId,
            mixName: item.title || `合集_${mixId}`,
            authorSecUid: options.target.expectedSecUid,
          });
        }
      }
    }

    // Secondary DOM safety net for works: scoped to the primary content container,
    // and strictly filtered by target author / awemeId.
    if (options.target.kind !== 'user_mix_list' && worksMap.size === 0) {
      const domSelector =
        options.target.kind === 'user_post'
          ? '[data-e2e="user-post-list"] a[href*="/video/"], [data-e2e="user-post-list"] a[href*="/note/"], #douyin-right-container a[href*="/video/"], #douyin-right-container a[href*="/note/"]'
          : options.target.kind === 'collection'
            ? '[data-e2e*="mix"] a[href*="/video/"], [data-e2e*="collection"] a[href*="/video/"], [class*="mix"] a[href*="/video/"], #douyin-right-container a[href*="/video/"]'
            : '#douyin-right-container a[href*="/video/"], #douyin-right-container a[href*="/note/"], a[href*="/video/"], a[href*="/note/"]';

      const domRes = await session
        .send('Runtime.evaluate', {
          returnByValue: true,
          expression: `JSON.stringify(
            Array.from(document.querySelectorAll(${JSON.stringify(domSelector)}))
              .map(a => a.getAttribute('href') || '')
              .filter(Boolean)
          )`,
        })
        .catch(() => ({ result: { value: '[]' } }));

      let hrefs: string[] = [];
      try {
        hrefs = JSON.parse(String((domRes.result as { value?: string })?.value || '[]'));
      } catch {
        hrefs = [];
      }

      const ids = Array.from(
        new Set(
          hrefs
            .map((h) => h.match(/\/(?:video|note)\/(\d+)/)?.[1])
            .filter((id): id is string => Boolean(id)),
        ),
      );
      const cap =
        options.maxItems > 0 ? Math.min(ids.length, options.maxItems) : Math.min(ids.length, 30);
      for (const awemeId of ids.slice(0, cap)) {
        if (options.target.kind === 'single' && options.target.expectedAwemeId && awemeId !== options.target.expectedAwemeId) {
          continue;
        }
        const media = await fetchSingleAwemeBySharePage(
          awemeId,
          options.quality,
          options.cookieString,
        );
        if (!media) continue;
        const check = shouldAcceptWorkForTarget(
          null,
          media,
          options.target,
          collectionOwnerSecUid,
          collectionOwnerNickname || profile?.nickname,
        );
        if (!check.accepted) {
          if (check.reason === 'other_author') {
            filteredOtherAuthorCount += 1;
          }
          continue;
        }
        if (isWithinDateRange(media.publishDate, options.startDate, options.endDate)) {
          worksMap.set(
            media.awemeId,
            mediaToDiscoveredWork(media, options.sourceUrl, options.mode),
          );
        }
      }
    }

    let finalWorks = Array.from(worksMap.values());

    // Final author consistency pass (handles cases where collection owner sec_uid arrived
    // via mix/detail after page 1 of mix/aweme, or falls back to the dominant author in a collection).
    if (options.target.strictAuthorFilter && finalWorks.length > 0) {
      const effectiveOwnerSecUid =
        collectionOwnerSecUid ||
        options.target.expectedSecUid ||
        (options.target.kind === 'collection'
          ? resolveDominantAuthorSecUid(finalWorks)
          : undefined);
      const effectiveOwnerNickname = collectionOwnerNickname || profile?.nickname;

      if (effectiveOwnerSecUid) {
        collectionOwnerSecUid = effectiveOwnerSecUid;
        const beforeFilter = finalWorks.length;
        finalWorks = finalWorks.filter((work) => {
          if (work.authorId) {
            return work.authorId === effectiveOwnerSecUid;
          }
          if (effectiveOwnerNickname) {
            return work.author === effectiveOwnerNickname;
          }
          return false;
        });
        filteredOtherAuthorCount += beforeFilter - finalWorks.length;
      }
    }

    if (options.maxItems > 0 && finalWorks.length > options.maxItems) {
      finalWorks = finalWorks.slice(0, options.maxItems);
    }

    return {
      works: finalWorks,
      mixes: Array.from(mixesMap.values()),
      profile,
      collectionOwnerSecUid,
      collectionOwnerNickname,
      expectedCollectionEpisodes,
      filteredOtherAuthorCount,
      emptyBlockedResponses,
      loginRequired,
      hasMoreRemaining,
      warnings,
    };
  } finally {
    active = false;
  }
}

async function scrapePageViaChromium(
  targetUrl: string,
  options: ScrapeOptions,
): Promise<PageScrapeResult> {
  const session = await openCdpSession();
  try {
    await prepareCdpSession(session, options.cookieString);
    return await scrapePageInSession(session, targetUrl, options);
  } finally {
    session.close();
  }
}

async function scrapeUserMixesViaChromium(
  secUid: string,
  settings: BatchSettings,
  sourceUrl: string,
): Promise<PageScrapeResult> {
  const session = await openCdpSession();
  try {
    await prepareCdpSession(session, settings.cookieString);

    const mixListRes = await scrapePageInSession(
      session,
      `https://www.douyin.com/user/${encodeURIComponent(secUid)}`,
      {
        quality: settings.videoQuality,
        cookieString: settings.cookieString,
        mode: 'mix',
        maxItems: 0,
        startDate: settings.startDate,
        endDate: settings.endDate,
        sourceUrl,
        paginate: true,
        target: {
          kind: 'user_mix_list',
          expectedSecUid: secUid,
          strictAuthorFilter: true,
        },
      },
    );

    const worksMap = new Map<string, DiscoveredWork>();
    let filteredOtherAuthorCount = mixListRes.filteredOtherAuthorCount;
    let emptyBlockedResponses = mixListRes.emptyBlockedResponses;
    let loginRequired = mixListRes.loginRequired;
    const warnings = [...mixListRes.warnings];

    for (const mix of mixListRes.mixes) {
      if (settings.maxItemsPerMode > 0 && worksMap.size >= settings.maxItemsPerMode) {
        break;
      }
      const remaining =
        settings.maxItemsPerMode > 0
          ? Math.max(1, settings.maxItemsPerMode - worksMap.size)
          : 0;
      const collectionUrl = `https://www.douyin.com/collection/${encodeURIComponent(mix.mixId)}`;
      const colRes = await scrapePageInSession(session, collectionUrl, {
        quality: settings.videoQuality,
        cookieString: settings.cookieString,
        mode: 'mix',
        maxItems: remaining,
        startDate: settings.startDate,
        endDate: settings.endDate,
        sourceUrl: collectionUrl,
        paginate: true,
        target: {
          kind: 'collection',
          expectedMixId: mix.mixId,
          expectedSecUid: secUid,
          strictAuthorFilter: true,
        },
      });

      filteredOtherAuthorCount += colRes.filteredOtherAuthorCount;
      emptyBlockedResponses += colRes.emptyBlockedResponses;
      if (colRes.loginRequired) loginRequired = true;
      warnings.push(...colRes.warnings);

      for (const work of colRes.works) {
        if (!worksMap.has(work.awemeId)) {
          worksMap.set(work.awemeId, work);
        }
      }
    }

    let finalWorks = Array.from(worksMap.values());
    if (settings.maxItemsPerMode > 0 && finalWorks.length > settings.maxItemsPerMode) {
      finalWorks = finalWorks.slice(0, settings.maxItemsPerMode);
    }

    return {
      works: finalWorks,
      mixes: mixListRes.mixes,
      profile: mixListRes.profile,
      collectionOwnerSecUid: secUid,
      collectionOwnerNickname: mixListRes.profile?.nickname,
      filteredOtherAuthorCount,
      emptyBlockedResponses,
      loginRequired,
      hasMoreRemaining: false,
      warnings,
    };
  } finally {
    session.close();
  }
}

export async function discoverWorksForLink(
  link: ParsedLink,
  settings: BatchSettings,
): Promise<DiscoveryResult> {
  const warnings: string[] = [];
  const resolvedUrl = link.resolvedUrl || link.originalUrl;

  if (!link.supported) {
    return {
      works: [],
      warnings: [link.reason || `暂不支持的链接类型: ${link.originalUrl}`],
    };
  }

  if (link.type === 'video' || link.type === 'gallery') {
    const awemeId = link.targetId;
    if (!awemeId) {
      return { works: [], warnings: [`无法从链接中提取作品 ID: ${resolvedUrl}`] };
    }
    const targetDesktopUrl =
      buildCanonicalDouyinUrl(link.type, awemeId) || resolvedUrl;

    const shareMedia = await fetchSingleAwemeBySharePage(
      awemeId,
      settings.videoQuality,
      settings.cookieString,
      link.type === 'gallery',
    );

    const shareRawVideo = shareMedia?.raw?.video as { bit_rate?: unknown[] } | undefined;
    const shareHasBitRates =
      Array.isArray(shareRawVideo?.bit_rate) && shareRawVideo!.bit_rate!.length > 0;
    const shareShortEdge =
      shareMedia?.width && shareMedia?.height
        ? Math.min(shareMedia.width, shareMedia.height)
        : 0;
    const wantsHighResVideo =
      settings.videoQuality === 'highest' ||
      settings.videoQuality === 'original' ||
      settings.videoQuality === '1440p' ||
      settings.videoQuality === '1080p';

    // Mobile share pages often omit video.bit_rate and only expose a 540p/720p stream.
    // When a cookie is available and user requested high quality, try desktop aweme/detail
    // via Chromium to fetch the full bit_rate ladder, falling back to shareMedia if needed.
    if (
      shareMedia &&
      shareMedia.awemeId === awemeId &&
      (shareMedia.mediaType !== 'video' ||
        shareHasBitRates ||
        shareShortEdge >= 1080 ||
        !wantsHighResVideo ||
        !settings.cookieString.trim())
    ) {
      return {
        works: [mediaToDiscoveredWork(shareMedia, targetDesktopUrl, 'post')],
        warnings: [],
      };
    }

    let cdpWorks: DiscoveredWork[] = [];
    let cdpRequiresCookie = false;
    try {
      const cdpRes = await scrapePageViaChromium(targetDesktopUrl, {
        quality: settings.videoQuality,
        cookieString: settings.cookieString,
        mode: 'post',
        maxItems: 1,
        sourceUrl: targetDesktopUrl,
        paginate: false,
        target: {
          kind: 'single',
          expectedAwemeId: awemeId,
          strictAuthorFilter: false,
        },
      });
      cdpWorks = cdpRes.works;
      cdpRequiresCookie = cdpRes.loginRequired || cdpRes.emptyBlockedResponses > 0;
    } catch {
      // Fall back to shareMedia if desktop Chromium is unavailable
    }

    if (cdpWorks.length > 0) {
      return {
        works: cdpWorks,
        warnings: [],
        requiresCookie: false,
      };
    }

    if (shareMedia && shareMedia.awemeId === awemeId) {
      return {
        works: [mediaToDiscoveredWork(shareMedia, targetDesktopUrl, 'post')],
        warnings: [],
      };
    }

    warnings.push(
      `作品 ${awemeId} 未能解析到直链（可能已删除、设为私密或需要填入有效抖音 Cookie）。`,
    );
    return {
      works: [],
      warnings,
      requiresCookie: cdpRequiresCookie,
    };
  }

  if (link.type === 'user') {
    const secUid = link.targetId;
    if (!secUid) {
      return { works: [], warnings: [`无法从主页链接中提取 sec_uid: ${resolvedUrl}`] };
    }

    const quickProfile = await fetchUserProfileInfo(secUid, settings.cookieString);
    const activeModes: DownloadMode[] =
      settings.modes.length > 0 ? settings.modes : ['post'];
    const allWorks = new Map<string, DiscoveredWork>();
    let finalProfile = quickProfile || undefined;
    let requiresCookie = false;
    let totalFilteredOtherAuthor = 0;

    for (const mode of activeModes) {
      let cdpRes: PageScrapeResult;
      if (mode === 'mix') {
        cdpRes = await scrapeUserMixesViaChromium(secUid, settings, resolvedUrl);
      } else {
        const targetKind: ScrapeTargetKind =
          mode === 'like'
            ? 'user_like'
            : mode === 'collect'
              ? 'user_collect'
              : 'user_post';
        cdpRes = await scrapePageViaChromium(
          `https://www.douyin.com/user/${encodeURIComponent(secUid)}`,
          {
            quality: settings.videoQuality,
            cookieString: settings.cookieString,
            mode,
            maxItems: settings.maxItemsPerMode,
            startDate: settings.startDate,
            endDate: settings.endDate,
            sourceUrl: resolvedUrl,
            paginate: true,
            target: {
              kind: targetKind,
              expectedSecUid: secUid,
              strictAuthorFilter: targetKind === 'user_post',
            },
          },
        );
      }

      if (cdpRes.profile && cdpRes.profile.nickname) {
        finalProfile = cdpRes.profile;
      }
      if (cdpRes.loginRequired || cdpRes.emptyBlockedResponses > 0) {
        requiresCookie = true;
      }
      totalFilteredOtherAuthor += cdpRes.filteredOtherAuthorCount;
      for (const w of cdpRes.works) {
        if (!allWorks.has(w.awemeId)) {
          allWorks.set(w.awemeId, w);
        }
      }
    }

    const works = Array.from(allWorks.values());
    const videoCount = works.filter((w) => w.type === 'video').length;
    const galleryCount = works.filter((w) => w.type === 'gallery').length;
    const totalExpected = finalProfile?.awemeCount || 0;
    const authorLabel = finalProfile?.nickname || secUid.slice(-8);

    if (works.length === 0) {
      if (requiresCookie || !settings.cookieString.trim()) {
        warnings.push(
          `已识别博主「${authorLabel}」（主页共 ${totalExpected || '若干'} 个作品），但抖音对未登录/失效 Cookie 的主页列表接口返回了空内容。请粘贴你浏览器中的抖音 Cookie 后重新解析，即可完整分页获取全部视频与图文。`,
        );
      } else {
        warnings.push(
          `未能从博主「${authorLabel}」主页获取到作品，请检查 Cookie 是否已过期、账号是否设为私密，或稍后重试。`,
        );
      }
    } else if (
      activeModes.includes('post') &&
      totalExpected > 0 &&
      works.length < totalExpected &&
      settings.maxItemsPerMode === 0
    ) {
      const filterNote =
        totalFilteredOtherAuthor > 0
          ? `（已自动过滤 ${totalFilteredOtherAuthor} 个非该作者/共创作品）`
          : '';
      warnings.push(
        `博主「${authorLabel}」主页标称 ${totalExpected} 个作品，本次共解析到 ${works.length} 个（视频 ${videoCount} / 图文 ${galleryCount}）${filterNote}。部分作品可能因日期筛选、私密/仅互关状态或风控分页上限未返回。`,
      );
    }

    return {
      works,
      profile: finalProfile,
      warnings,
      requiresCookie: works.length === 0 && (requiresCookie || !settings.cookieString.trim()),
    };
  }

  if (link.type === 'collection' || link.type === 'music') {
    const targetDesktopUrl =
      buildCanonicalDouyinUrl(link.type, link.targetId) || resolvedUrl;
    const isCollection = link.type === 'collection';
    const cdpRes = await scrapePageViaChromium(targetDesktopUrl, {
      quality: settings.videoQuality,
      cookieString: settings.cookieString,
      mode: isCollection ? 'mix' : 'music',
      maxItems: settings.maxItemsPerMode,
      startDate: settings.startDate,
      endDate: settings.endDate,
      sourceUrl: targetDesktopUrl,
      paginate: true,
      target: isCollection
        ? {
            kind: 'collection',
            expectedMixId: link.targetId,
            strictAuthorFilter: true,
          }
        : {
            kind: 'music',
            expectedMusicId: link.targetId,
            strictAuthorFilter: false,
          },
    });
    if (cdpRes.works.length === 0) {
      warnings.push(
        `未能从该${link.label}解析到作品列表，请确认已在配置中填入有效抖音 Cookie 后重试。`,
      );
    } else if (
      isCollection &&
      cdpRes.expectedCollectionEpisodes &&
      cdpRes.works.length < cdpRes.expectedCollectionEpisodes &&
      settings.maxItemsPerMode === 0
    ) {
      const filterNote =
        cdpRes.filteredOtherAuthorCount > 0
          ? `（已自动过滤 ${cdpRes.filteredOtherAuthorCount} 个非合集作者作品）`
          : '';
      warnings.push(
        `该合集标称 ${cdpRes.expectedCollectionEpisodes} 集，本次共解析到 ${cdpRes.works.length} 个作品${filterNote}。部分剧集可能因日期筛选、下架或私密状态未返回。`,
      );
    }
    return {
      works: cdpRes.works,
      warnings,
      requiresCookie: cdpRes.works.length === 0 && !settings.cookieString.trim(),
    };
  }

  return {
    works: [],
    warnings: [
      `${link.label}暂不支持一次性文件流直下，建议导出 config.yml 后使用本地 FFmpeg 分段录制。`,
    ],
  };
}
