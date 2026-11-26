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

interface ScrapeOptions {
  quality: VideoQuality;
  cookieString?: string;
  mode: DownloadMode;
  maxItems: number;
  startDate?: string;
  endDate?: string;
  sourceUrl: string;
  paginate: boolean;
}

async function scrapePageViaChromium(
  targetUrl: string,
  options: ScrapeOptions,
): Promise<{
  works: DiscoveredWork[];
  profile?: CreatorProfileSummary;
  emptyBlockedResponses: number;
  loginRequired: boolean;
  hasMoreRemaining: boolean;
  warnings: string[];
}> {
  const session = await openCdpSession();
  const warnings: string[] = [];
  const worksMap = new Map<string, DiscoveredWork>();
  let profile: CreatorProfileSummary | undefined;
  let emptyBlockedResponses = 0;
  let loginRequired = false;
  let hasMoreRemaining = true;
  let apiPagesReceived = 0;
  let lastNewWorkAt = Date.now();

  const requestUrlMap = new Map<string, { url: string; status: number }>();
  const bodyTasks: Promise<void>[] = [];

  try {
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

    const parsedCookies = parseCookieString(options.cookieString || '');
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

    const handleJsonResponse = (apiUrl: string, text: string) => {
      if (!text || !text.trim()) {
        if (
          apiUrl.includes('/aweme/v1/web/aweme/post') ||
          apiUrl.includes('/aweme/v1/web/aweme/favorite') ||
          apiUrl.includes('/aweme/v1/web/mix/aweme') ||
          apiUrl.includes('/aweme/v1/web/music/aweme')
        ) {
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

      if (apiUrl.includes('/aweme/v1/web/user/profile/other') && data.user) {
        const u = data.user as Record<string, unknown>;
        profile = {
          nickname: String(u.nickname || ''),
          secUid: String(u.sec_uid || ''),
          awemeCount: Number(u.aweme_count || 0),
          favoritingCount: Number(u.favoriting_count || 0),
        };
        return;
      }

      let rawItems: RawAweme[] = [];
      if (Array.isArray(data.aweme_list)) {
        rawItems = data.aweme_list as RawAweme[];
        apiPagesReceived += 1;
        hasMoreRemaining = Boolean(data.has_more);
      } else if (data.aweme_detail && typeof data.aweme_detail === 'object') {
        rawItems = [data.aweme_detail as RawAweme];
        apiPagesReceived += 1;
        hasMoreRemaining = false;
      }

      let addedThisPage = 0;
      for (const raw of rawItems) {
        const media = parseAwemeToMedia(raw, options.quality);
        if (!media) continue;
        if (!isWithinDateRange(media.publishDate, options.startDate, options.endDate)) {
          continue;
        }
        if (!worksMap.has(media.awemeId)) {
          worksMap.set(
            media.awemeId,
            mediaToDiscoveredWork(media, options.sourceUrl, options.mode),
          );
          addedThisPage += 1;
        }
      }
      if (addedThisPage > 0) {
        lastNewWorkAt = Date.now();
      }
    };

    session.onEvent((method, params) => {
      if (method === 'Network.responseReceived') {
        const resp = params.response as { url?: string; status?: number } | undefined;
        const reqId = String(params.requestId || '');
        const url = resp?.url || '';
        if (
          url.includes('/aweme/v1/web/aweme/post') ||
          url.includes('/aweme/v1/web/aweme/favorite') ||
          url.includes('/aweme/v1/web/aweme/detail') ||
          url.includes('/aweme/v1/web/mix/aweme') ||
          url.includes('/aweme/v1/web/music/aweme') ||
          url.includes('/aweme/v1/web/user/profile/other')
        ) {
          requestUrlMap.set(reqId, { url, status: Number(resp?.status || 0) });
        }
      } else if (method === 'Network.loadingFinished') {
        const reqId = String(params.requestId || '');
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
            handleJsonResponse(meta.url, text);
          })
          .catch(() => {
            // body evicted or empty
          });
        bodyTasks.push(task);
      }
    });

    await session.send('Page.navigate', { url: targetUrl });

    // Wait for initial JS hydration + first API page
    const initDeadline = Date.now() + 12_000;
    while (Date.now() < initDeadline) {
      await new Promise((r) => setTimeout(r, 500));
      if (
        worksMap.size > 0 ||
        loginRequired ||
        (emptyBlockedResponses > 0 && Date.now() - lastNewWorkAt > 4000)
      ) {
        break;
      }
    }

    // Dismiss any login modal if present
    await session
      .send('Runtime.evaluate', {
        expression: `(() => {
          const selectors = ['.dy-account-close', '[class*="login"] [class*="close"]', '[aria-label*="关闭"]'];
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.click) el.click();
          }
        })()`,
      })
      .catch(() => undefined);

    if (options.paginate && !loginRequired) {
      // If mode is 'like' or 'mix' on a user homepage, try clicking the matching tab
      if (options.mode === 'like' || options.mode === 'mix') {
        const tabLabel = options.mode === 'like' ? '喜欢' : '合集';
        await session
          .send('Runtime.evaluate', {
            expression: `(() => {
              const tabs = Array.from(document.querySelectorAll('[role="tab"], [data-e2e*="tab"], div, span'));
              const match = tabs.find(el => el.childElementCount === 0 && (el.textContent || '').trim().startsWith('${tabLabel}'));
              if (match && match.click) match.click();
            })()`,
          })
          .catch(() => undefined);
        await new Promise((r) => setTimeout(r, 1500));
      }

      const crawlDeadline = Date.now() + 35_000;
      let idleRounds = 0;
      let scrollCount = 0;
      const maxScrolls = 35;

      while (Date.now() < crawlDeadline && scrollCount < maxScrolls) {
        if (loginRequired) break;
        if (options.maxItems > 0 && worksMap.size >= options.maxItems) break;
        if (apiPagesReceived > 0 && !hasMoreRemaining) break;
        if (worksMap.size === 0 && emptyBlockedResponses >= 2) break;

        const beforeCount = worksMap.size;
        await session
          .send('Runtime.evaluate', {
            expression: `(() => {
              window.scrollTo(0, document.body.scrollHeight);
              const scroller = document.querySelector('#douyin-right-container, [data-e2e="user-post-list"]')?.parentElement;
              if (scroller) scroller.scrollTop = scroller.scrollHeight;
            })()`,
          })
          .catch(() => undefined);

        scrollCount += 1;
        await new Promise((r) => setTimeout(r, 1250));
        await Promise.allSettled(bodyTasks.splice(0, bodyTasks.length));

        if (worksMap.size === beforeCount) {
          idleRounds += 1;
          if (idleRounds >= 4) break;
        } else {
          idleRounds = 0;
        }
      }
    }

    await Promise.allSettled(bodyTasks);

    // Secondary DOM safety net: if API was empty/truncated, check visible DOM /video/ and /note/ links
    if (worksMap.size === 0) {
      const domRes = await session
        .send('Runtime.evaluate', {
          returnByValue: true,
          expression: `JSON.stringify(
            Array.from(document.querySelectorAll('a[href*="/video/"], a[href*="/note/"]'))
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
      const cap = options.maxItems > 0 ? Math.min(ids.length, options.maxItems) : Math.min(ids.length, 30);
      for (const awemeId of ids.slice(0, cap)) {
        const media = await fetchSingleAwemeBySharePage(
          awemeId,
          options.quality,
          options.cookieString,
        );
        if (media && isWithinDateRange(media.publishDate, options.startDate, options.endDate)) {
          worksMap.set(
            media.awemeId,
            mediaToDiscoveredWork(media, options.sourceUrl, options.mode),
          );
        }
      }
    }

    let finalWorks = Array.from(worksMap.values());
    if (options.maxItems > 0 && finalWorks.length > options.maxItems) {
      finalWorks = finalWorks.slice(0, options.maxItems);
    }

    return {
      works: finalWorks,
      profile,
      emptyBlockedResponses,
      loginRequired,
      hasMoreRemaining,
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
    if (shareMedia) {
      return {
        works: [mediaToDiscoveredWork(shareMedia, targetDesktopUrl, 'post')],
        warnings: [],
      };
    }

    const cdpRes = await scrapePageViaChromium(targetDesktopUrl, {
      quality: settings.videoQuality,
      cookieString: settings.cookieString,
      mode: 'post',
      maxItems: 1,
      sourceUrl: targetDesktopUrl,
      paginate: false,
    });
    if (cdpRes.works.length === 0) {
      warnings.push(
        `作品 ${awemeId} 未能解析到直链（可能已删除、设为私密或需要填入有效抖音 Cookie）。`,
      );
    }
    return {
      works: cdpRes.works,
      warnings,
      requiresCookie: cdpRes.loginRequired || cdpRes.emptyBlockedResponses > 0,
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

    for (const mode of activeModes) {
      const cdpRes = await scrapePageViaChromium(
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
        },
      );
      if (cdpRes.profile && cdpRes.profile.nickname) {
        finalProfile = cdpRes.profile;
      }
      if (cdpRes.loginRequired || cdpRes.emptyBlockedResponses > 0) {
        requiresCookie = true;
      }
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
    } else if (totalExpected > 0 && works.length < totalExpected && settings.maxItemsPerMode === 0) {
      warnings.push(
        `博主「${authorLabel}」主页标称 ${totalExpected} 个作品，本次共解析到 ${works.length} 个（视频 ${videoCount} / 图文 ${galleryCount}）。部分作品可能因日期筛选、私密状态或风控分页上限未返回。`,
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
    const cdpRes = await scrapePageViaChromium(targetDesktopUrl, {
      quality: settings.videoQuality,
      cookieString: settings.cookieString,
      mode: link.type === 'collection' ? 'mix' : 'music',
      maxItems: settings.maxItemsPerMode,
      startDate: settings.startDate,
      endDate: settings.endDate,
      sourceUrl: targetDesktopUrl,
      paginate: true,
    });
    if (cdpRes.works.length === 0) {
      warnings.push(
        `未能从该${link.label}解析到作品列表，请确认已在配置中填入有效抖音 Cookie 后重试。`,
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
