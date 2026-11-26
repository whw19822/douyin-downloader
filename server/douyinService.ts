import {
  isAllowedDouyinUpstreamHost,
  isShortUrl,
  normalizeShortUrl,
  parseDouyinUrl,
} from '../src/lib/urlParser';
import type { HotBoardItem, ParsedLink } from '../src/lib/types';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export const SNAPSHOT_HOT_BOARD: HotBoardItem[] = [
  {
    rank: 1,
    word: '深秋胶片感城市扫街教程',
    hotValue: 11842000,
    label: '热',
    searchUrl: 'https://www.douyin.com/search/%E6%B7%B1%E7%A7%8B%E8%83%B6%E7%89%87%E6%84%9F%E5%9F%8E%E5%B8%82%E6%89%AB%E8%A1%97%E6%95%99%E7%A8%8B',
    category: '影像创作',
  },
  {
    rank: 2,
    word: '4K HDR 航拍雪山日照金山',
    hotValue: 10395000,
    label: '爆',
    searchUrl: 'https://www.douyin.com/search/4K%20HDR%20%E8%88%AA%E6%8B%8D%E9%9B%AA%E5%B1%B1%E6%97%A5%E7%85%A7%E9%87%91%E5%B1%B1',
    category: '自然风光',
  },
  {
    rank: 3,
    word: '独立开发者效率工作流分享',
    hotValue: 9640000,
    label: '新',
    searchUrl: 'https://www.douyin.com/search/%E7%8B%AC%E7%AB%8B%E5%BC%80%E5%8F%91%E8%80%85%E6%95%88%E7%8E%87%E5%B7%A5%E4%BD%9C%E6%B5%81',
    category: '科技数码',
  },
  {
    rank: 4,
    word: '家庭手冲咖啡极简萃取参数',
    hotValue: 8821000,
    searchUrl: 'https://www.douyin.com/search/%E5%AE%B6%E5%BA%AD%E6%89%8B%E5%86%B2%E5%92%96%E5%95%A1',
    category: '生活方式',
  },
  {
    rank: 5,
    word: '极简桌面改造与理线方案',
    hotValue: 8190000,
    label: '热',
    searchUrl: 'https://www.douyin.com/search/%E6%9E%81%E7%AE%80%E6%A1%8C%E9%9D%A2%E6%94%B9%E9%80%A0',
    category: '家居设计',
  },
  {
    rank: 6,
    word: '街头复古爵士鼓现场即兴',
    hotValue: 7450000,
    searchUrl: 'https://www.douyin.com/search/%E8%A1%97%E5%A4%B4%E5%A4%8D%E5%8F%A4%E7%88%B5%E5%A3%AB%E9%BC%93',
    category: '音乐现场',
  },
  {
    rank: 7,
    word: '非遗木作榫卯结构全景拆解',
    hotValue: 6912000,
    label: '新',
    searchUrl: 'https://www.douyin.com/search/%E9%9D%9E%E9%81%97%E6%9C%A8%E4%BD%9C%E6%A6%AB%E5%8D%AF',
    category: '人文纪实',
  },
  {
    rank: 8,
    word: '城市夜跑 10 公里配速心率实录',
    hotValue: 6340000,
    searchUrl: 'https://www.douyin.com/search/%E5%9F%8E%E5%B8%82%E5%A4%9C%E8%B7%91',
    category: '运动健身',
  },
];

export async function resolveDouyinShortUrl(
  rawUrl: string,
  cookieString?: string,
): Promise<string | null> {
  if (!isShortUrl(rawUrl)) return null;
  const normalized = normalizeShortUrl(rawUrl);

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }

  if (!isAllowedDouyinUpstreamHost(parsed.hostname)) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3200);
  try {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };
    if (cookieString?.trim()) {
      headers.Cookie = cookieString.trim();
    }

    const response = await fetch(normalized, {
      method: 'GET',
      redirect: 'manual',
      headers,
      signal: controller.signal,
    });

    const location = response.headers.get('location');
    if (location) {
      const target = new URL(location, normalized);
      if (isAllowedDouyinUpstreamHost(target.hostname)) {
        return target.toString();
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeDouyinPageTitle(
  url: string,
  cookieString?: string,
): Promise<{ title?: string; author?: string; reachable: boolean }> {
  let parsed: URL;
  try {
    parsed = new URL(normalizeShortUrl(url));
  } catch {
    return { reachable: false };
  }

  if (!isAllowedDouyinUpstreamHost(parsed.hostname)) {
    return { reachable: false };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Referer: 'https://www.douyin.com/',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    };
    if (cookieString?.trim()) {
      headers.Cookie = cookieString.trim();
    }
    const res = await fetch(parsed.toString(), {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      return { reachable: false };
    }
    const html = (await res.text()).slice(0, 64_000);
    const titleMatch =
      html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<title>([^<]+)<\/title>/i);
    const rawTitle = titleMatch?.[1]?.replace(/\s*-\s*抖音.*$/, '').trim();
    if (
      rawTitle &&
      !rawTitle.includes('验证码') &&
      !rawTitle.includes('安全验证') &&
      rawTitle !== '抖音'
    ) {
      return { title: rawTitle, reachable: true };
    }
    return { reachable: false };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectAndResolveLinks(
  links: ParsedLink[],
  cookieString?: string,
): Promise<ParsedLink[]> {
  return Promise.all(
    links.map(async (link, idx) => {
      if (link.type !== 'short') return link;
      const resolved = await resolveDouyinShortUrl(link.originalUrl, cookieString);
      if (!resolved) return link;
      const reparsed = parseDouyinUrl(resolved, idx);
      return {
        ...reparsed,
        originalUrl: link.originalUrl,
        resolvedUrl: resolved,
      };
    }),
  );
}

let hotBoardCache: {
  items: HotBoardItem[];
  source: 'live' | 'snapshot';
  updatedAt: string;
  expiresAt: number;
} | null = null;

export async function fetchDouyinHotBoard(
  cookieString?: string,
  forceRefresh = false,
): Promise<{ items: HotBoardItem[]; source: 'live' | 'snapshot'; updatedAt: string }> {
  const nowMs = Date.now();
  if (!forceRefresh && hotBoardCache && hotBoardCache.expiresAt > nowMs) {
    return {
      items: hotBoardCache.items,
      source: hotBoardCache.source,
      updatedAt: hotBoardCache.updatedAt,
    };
  }

  const updatedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1400);
  try {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Referer: 'https://www.douyin.com/',
      Accept: 'application/json',
    };
    if (cookieString?.trim()) {
      headers.Cookie = cookieString.trim();
    }
    const res = await fetch(
      'https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/',
      { headers, signal: controller.signal },
    );
    if (!res.ok) {
      hotBoardCache = {
        items: SNAPSHOT_HOT_BOARD,
        source: 'snapshot',
        updatedAt,
        expiresAt: nowMs + 5 * 60_000,
      };
      return { items: SNAPSHOT_HOT_BOARD, source: 'snapshot', updatedAt };
    }
    const json = (await res.json()) as {
      word_list?: Array<{ word?: string; hot_value?: number; label?: number }>;
    };
    const list = Array.isArray(json.word_list) ? json.word_list : [];
    if (list.length === 0) {
      hotBoardCache = {
        items: SNAPSHOT_HOT_BOARD,
        source: 'snapshot',
        updatedAt,
        expiresAt: nowMs + 5 * 60_000,
      };
      return { items: SNAPSHOT_HOT_BOARD, source: 'snapshot', updatedAt };
    }
    const labelMap: Record<number, string> = { 1: '新', 2: '荐', 3: '热', 4: '爆' };
    const items: HotBoardItem[] = list.slice(0, 20).map((row, idx) => {
      const word = String(row.word || '').trim() || `热搜话题 #${idx + 1}`;
      return {
        rank: idx + 1,
        word,
        hotValue: Number(row.hot_value || 0),
        label: row.label ? labelMap[row.label] : undefined,
        searchUrl: `https://www.douyin.com/search/${encodeURIComponent(word)}`,
        category: '实时榜单',
      };
    });
    hotBoardCache = {
      items,
      source: 'live',
      updatedAt,
      expiresAt: nowMs + 5 * 60_000,
    };
    return { items, source: 'live', updatedAt };
  } catch {
    hotBoardCache = {
      items: SNAPSHOT_HOT_BOARD,
      source: 'snapshot',
      updatedAt,
      expiresAt: nowMs + 5 * 60_000,
    };
    return { items: SNAPSHOT_HOT_BOARD, source: 'snapshot', updatedAt };
  } finally {
    clearTimeout(timer);
  }
}
