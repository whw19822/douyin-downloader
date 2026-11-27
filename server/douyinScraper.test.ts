import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChromeLaunchArgs,
  buildNextCursorApiUrl,
  classifyDouyinApiUrl,
  discoverWorksForLink,
  isHeadlessShellBinary,
  resolveDominantAuthorSecUid,
  setCustomCdpSessionFactory,
  shouldAcceptWorkForTarget,
  type CdpSession,
  type ScrapeTarget,
} from './douyinScraper';
import { parseAwemeToMedia, type RawAweme } from '../src/lib/douyinParser';
import { DEFAULT_BATCH_SETTINGS } from '../src/lib/types';

function makeRawAweme(overrides: Partial<RawAweme> & { aweme_id: string }): RawAweme {
  return {
    aweme_type: 0,
    desc: `作品_${overrides.aweme_id}`,
    create_time: 1735000000,
    author: {
      nickname: '目标博主',
      sec_uid: 'MS4wLjABAAAA_target',
    },
    video: {
      play_addr: {
        url_list: [`https://v26-web.douyinvod.com/playwm/${overrides.aweme_id}.mp4`],
        data_size: 1024000,
      },
    },
    ...overrides,
  };
}

test('isHeadlessShellBinary identifies playwright headless shell vs full Chrome', () => {
  assert.equal(
    isHeadlessShellBinary('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    false,
  );
  assert.equal(isHeadlessShellBinary('/usr/bin/google-chrome'), false);
  assert.equal(
    isHeadlessShellBinary('/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell'),
    true,
  );
});

test('buildChromeLaunchArgs enables --headless=new and isolated --user-data-dir for macOS Chrome', () => {
  const args = buildChromeLaunchArgs(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/tmp/douyin-cdp-test',
  );
  assert.ok(args.includes('--headless=new'));
  assert.ok(args.includes('--user-data-dir=/tmp/douyin-cdp-test'));
  assert.ok(args.includes('--use-mock-keychain'));
  assert.ok(args.includes('--no-first-run'));
  assert.ok(args.includes('--mute-audio'));
  assert.ok(args.includes('--remote-debugging-port=0'));
});

test('buildChromeLaunchArgs omits --headless=new for chrome-headless-shell but keeps isolated --user-data-dir', () => {
  const args = buildChromeLaunchArgs(
    '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell',
    '/tmp/douyin-cdp-shell',
  );
  assert.equal(args.includes('--headless=new'), false);
  assert.ok(args.includes('--user-data-dir=/tmp/douyin-cdp-shell'));
});

test('classifyDouyinApiUrl isolates endpoints and matching query identifiers per scrape target', () => {
  const userPostTarget: ScrapeTarget = {
    kind: 'user_post',
    expectedSecUid: 'SEC_TARGET',
    strictAuthorFilter: true,
  };
  assert.equal(
    classifyDouyinApiUrl(
      'https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=SEC_TARGET&max_cursor=0',
      userPostTarget,
    ),
    'target',
  );
  assert.equal(
    classifyDouyinApiUrl(
      'https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=SEC_OTHER&max_cursor=0',
      userPostTarget,
    ),
    'ignore',
  );
  assert.equal(
    classifyDouyinApiUrl(
      'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=12345',
      userPostTarget,
    ),
    'ignore',
  );
  assert.equal(
    classifyDouyinApiUrl(
      'https://www.douyin.com/aweme/v1/web/aweme/favorite/?sec_user_id=SEC_TARGET',
      userPostTarget,
    ),
    'ignore',
  );
  assert.equal(
    classifyDouyinApiUrl(
      'https://www.douyin.com/aweme/v1/web/user/profile/other/?sec_user_id=SEC_TARGET',
      userPostTarget,
    ),
    'profile',
  );
  assert.equal(
    classifyDouyinApiUrl(
      'https://www.douyin.com/aweme/v1/web/user/profile/other/?sec_user_id=SEC_OTHER',
      userPostTarget,
    ),
    'ignore',
  );

  const collectionTarget: ScrapeTarget = {
    kind: 'collection',
    expectedMixId: '7300000000000000001',
    strictAuthorFilter: true,
  };
  assert.equal(
    classifyDouyinApiUrl(
      'https://www.douyin.com/aweme/v1/web/mix/aweme/?mix_id=7300000000000000001&cursor=0',
      collectionTarget,
    ),
    'target',
  );
  assert.equal(
    classifyDouyinApiUrl(
      'https://www.douyin.com/aweme/v1/web/mix/aweme/?mix_id=7399999999999999999&cursor=0',
      collectionTarget,
    ),
    'ignore',
  );
  assert.equal(
    classifyDouyinApiUrl(
      'https://www.douyin.com/aweme/v1/web/mix/detail/?mix_id=7300000000000000001',
      collectionTarget,
    ),
    'mix_detail',
  );
  assert.equal(
    classifyDouyinApiUrl(
      'https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=SEC_OTHER',
      collectionTarget,
    ),
    'ignore',
  );
});

test('shouldAcceptWorkForTarget filters other authors and mismatched mixes while preserving like/music modes', () => {
  const ownRaw = makeRawAweme({
    aweme_id: '101',
    author: { nickname: '目标博主', sec_uid: 'SEC_TARGET' },
    mix_info: { mix_id: '9001', author: { sec_uid: 'SEC_TARGET' } },
  });
  const otherAuthorRaw = makeRawAweme({
    aweme_id: '102',
    author: { nickname: '其他作者', sec_uid: 'SEC_OTHER' },
    mix_info: { mix_id: '9001', author: { sec_uid: 'SEC_TARGET' } },
  });
  const otherMixRaw = makeRawAweme({
    aweme_id: '103',
    author: { nickname: '目标博主', sec_uid: 'SEC_TARGET' },
    mix_info: { mix_id: '9999', author: { sec_uid: 'SEC_TARGET' } },
  });

  const ownMedia = parseAwemeToMedia(ownRaw)!;
  const otherAuthorMedia = parseAwemeToMedia(otherAuthorRaw)!;
  const otherMixMedia = parseAwemeToMedia(otherMixRaw)!;

  const userPostTarget: ScrapeTarget = {
    kind: 'user_post',
    expectedSecUid: 'SEC_TARGET',
    strictAuthorFilter: true,
  };
  assert.equal(shouldAcceptWorkForTarget(ownRaw, ownMedia, userPostTarget).accepted, true);
  assert.deepEqual(
    shouldAcceptWorkForTarget(otherAuthorRaw, otherAuthorMedia, userPostTarget),
    { accepted: false, reason: 'other_author' },
  );

  const collectionTarget: ScrapeTarget = {
    kind: 'collection',
    expectedMixId: '9001',
    strictAuthorFilter: true,
  };
  assert.equal(
    shouldAcceptWorkForTarget(ownRaw, ownMedia, collectionTarget, 'SEC_TARGET').accepted,
    true,
  );
  assert.deepEqual(
    shouldAcceptWorkForTarget(otherAuthorRaw, otherAuthorMedia, collectionTarget, 'SEC_TARGET'),
    { accepted: false, reason: 'other_author' },
  );
  assert.deepEqual(
    shouldAcceptWorkForTarget(otherMixRaw, otherMixMedia, collectionTarget, 'SEC_TARGET'),
    { accepted: false, reason: 'other_mix' },
  );

  // Like mode intentionally keeps works by other authors
  const likeTarget: ScrapeTarget = {
    kind: 'user_like',
    expectedSecUid: 'SEC_TARGET',
    strictAuthorFilter: false,
  };
  assert.equal(shouldAcceptWorkForTarget(otherAuthorRaw, otherAuthorMedia, likeTarget).accepted, true);
});

test('buildNextCursorApiUrl updates cursor and strips stale signature parameters', () => {
  const next = buildNextCursorApiUrl(
    'https://www.douyin.com/aweme/v1/web/mix/aweme/?mix_id=9001&cursor=0&count=20&a_bogus=OLD&X-Bogus=OLD2&_signature=OLD3',
    'cursor',
    20,
  );
  assert.equal(next, '/aweme/v1/web/mix/aweme/?mix_id=9001&cursor=20&count=20');
});

test('resolveDominantAuthorSecUid picks the majority author when mix metadata is absent', () => {
  const dominant = resolveDominantAuthorSecUid([
    {
      awemeId: '1',
      sourceUrl: '',
      type: 'video',
      mode: 'mix',
      title: 'a',
      author: 'A',
      authorId: 'SEC_A',
      publishDate: '2025-01-01',
      publishTs: 1,
      imageUrls: [],
      sizeBytes: 0,
    },
    {
      awemeId: '2',
      sourceUrl: '',
      type: 'video',
      mode: 'mix',
      title: 'b',
      author: 'B',
      authorId: 'SEC_B',
      publishDate: '2025-01-01',
      publishTs: 1,
      imageUrls: [],
      sizeBytes: 0,
    },
    {
      awemeId: '3',
      sourceUrl: '',
      type: 'video',
      mode: 'mix',
      title: 'c',
      author: 'A',
      authorId: 'SEC_A',
      publishDate: '2025-01-01',
      publishTs: 1,
      imageUrls: [],
      sizeBytes: 0,
    },
  ]);
  assert.equal(dominant, 'SEC_A');
});

test('discoverWorksForLink uses registered custom CDP session (e.g. Electron built-in Chromium) for user homepage', async () => {
  let closed = false;
  let navigatedUrl = '';
  const listeners: Array<(method: string, params: Record<string, unknown>) => void> = [];

  const mockSession: CdpSession = {
    onEvent(handler) {
      listeners.push(handler);
    },
    async send(method, params = {}) {
      if (method === 'Page.navigate') {
        navigatedUrl = String(params.url || '');
        const reqId = 'req-user-post-1';
        setTimeout(() => {
          for (const listener of listeners) {
            listener('Network.responseReceived', {
              requestId: reqId,
              response: {
                url: 'https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=MS4wLjABAAAA_demo',
                status: 200,
              },
            });
            listener('Network.loadingFinished', { requestId: reqId });
          }
        }, 10);
        return {};
      }
      if (method === 'Network.getResponseBody') {
        return {
          body: JSON.stringify({
            status_code: 0,
            has_more: 0,
            aweme_list: [
              {
                aweme_id: '7499999999999999991',
                aweme_type: 0,
                desc: '测试用户主页视频',
                create_time: 1735000000,
                author: {
                  nickname: '测试博主',
                  sec_uid: 'MS4wLjABAAAA_demo',
                },
                video: {
                  play_addr: {
                    url_list: ['https://v26-web.douyinvod.com/playwm/demo.mp4'],
                    data_size: 1024000,
                  },
                },
              },
            ],
          }),
        };
      }
      return {};
    },
    close() {
      closed = true;
    },
  };

  setCustomCdpSessionFactory(async () => mockSession);
  try {
    const res = await discoverWorksForLink(
      {
        id: 'link-test-user-1',
        originalUrl: 'https://www.douyin.com/user/MS4wLjABAAAA_demo',
        resolvedUrl: 'https://www.douyin.com/user/MS4wLjABAAAA_demo',
        type: 'user',
        label: '博主主页',
        targetId: 'MS4wLjABAAAA_demo',
        supported: true,
      },
      {
        ...DEFAULT_BATCH_SETTINGS,
        modes: ['post'],
        cookieString: 'msToken=abc; __Host-test=1; __Secure-sid=2',
      },
    );

    assert.equal(navigatedUrl, 'https://www.douyin.com/user/MS4wLjABAAAA_demo');
    assert.equal(closed, true);
    assert.equal(res.works.length, 1);
    assert.equal(res.works[0].awemeId, '7499999999999999991');
    assert.equal(res.works[0].videoUrl, 'https://v26-web.douyinvod.com/play/demo.mp4');
  } finally {
    setCustomCdpSessionFactory(null);
  }
});

test('discoverWorksForLink paginates user homepage via mouseWheel to the bottom, ignores unrelated endpoints, and filters other authors', async () => {
  const listeners: Array<(method: string, params: Record<string, unknown>) => void> = [];
  const bodies = new Map<string, string>();
  let pageNum = 0;
  let wheelEvents = 0;

  const emitResponse = (reqId: string, url: string, payload: unknown) => {
    bodies.set(reqId, JSON.stringify(payload));
    for (const listener of listeners) {
      listener('Network.requestWillBeSent', { requestId: reqId, request: { url } });
      listener('Network.responseReceived', {
        requestId: reqId,
        response: { url, status: 200 },
      });
      listener('Network.loadingFinished', { requestId: reqId });
    }
  };

  const mockSession: CdpSession = {
    onEvent(handler) {
      listeners.push(handler);
    },
    async send(method, params = {}) {
      if (method === 'Page.navigate') {
        setTimeout(() => {
          // Emit an unrelated aweme/detail (previously corrupted has_more=false and mixed other author!)
          emitResponse(
            'req-unrelated-detail',
            'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=888888',
            {
              status_code: 0,
              aweme_detail: makeRawAweme({
                aweme_id: '888888',
                author: { nickname: '无关推荐作者', sec_uid: 'MS4wLjABAAAA_stranger' },
              }),
            },
          );
          // Emit another creator's post feed (must be ignored by sec_user_id check)
          emitResponse(
            'req-other-user-post',
            'https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=MS4wLjABAAAA_stranger&max_cursor=0',
            {
              status_code: 0,
              has_more: 0,
              aweme_list: [
                makeRawAweme({
                  aweme_id: '888889',
                  author: { nickname: '无关博主', sec_uid: 'MS4wLjABAAAA_stranger' },
                }),
              ],
            },
          );
          // Emit page 1 of target creator, including one co-created / other-author item mixed in
          pageNum = 1;
          emitResponse(
            'req-post-p1',
            'https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=MS4wLjABAAAA_target&max_cursor=0',
            {
              status_code: 0,
              has_more: 1,
              max_cursor: 1001,
              aweme_list: [
                makeRawAweme({ aweme_id: '7500001' }),
                makeRawAweme({
                  aweme_id: '7500002',
                  author: { nickname: '共创其他作者', sec_uid: 'MS4wLjABAAAA_other' },
                }),
              ],
            },
          );
        }, 10);
        return {};
      }
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseWheel') {
        wheelEvents += 1;
        if (pageNum === 1) {
          pageNum = 2;
          setTimeout(() => {
            emitResponse(
              'req-post-p2',
              'https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=MS4wLjABAAAA_target&max_cursor=1001',
              {
                status_code: 0,
                has_more: 1,
                max_cursor: 1002,
                aweme_list: [makeRawAweme({ aweme_id: '7500003' })],
              },
            );
          }, 10);
        } else if (pageNum === 2) {
          pageNum = 3;
          setTimeout(() => {
            emitResponse(
              'req-post-p3',
              'https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=MS4wLjABAAAA_target&max_cursor=1002',
              {
                status_code: 0,
                has_more: 0,
                max_cursor: 0,
                aweme_list: [
                  makeRawAweme({ aweme_id: '7500004' }),
                  makeRawAweme({
                    aweme_id: '7500005',
                    author: { nickname: '另一位作者', sec_uid: 'MS4wLjABAAAA_third' },
                  }),
                ],
              },
            );
          }, 10);
        }
        return {};
      }
      if (method === 'Network.getResponseBody') {
        return { body: bodies.get(String(params.requestId || '')) || '' };
      }
      return {};
    },
    close() {
      // noop
    },
  };

  setCustomCdpSessionFactory(async () => mockSession);
  try {
    const res = await discoverWorksForLink(
      {
        id: 'link-user-full',
        originalUrl: 'https://www.douyin.com/user/MS4wLjABAAAA_target',
        resolvedUrl: 'https://www.douyin.com/user/MS4wLjABAAAA_target',
        type: 'user',
        label: '博主主页',
        targetId: 'MS4wLjABAAAA_target',
        supported: true,
      },
      {
        ...DEFAULT_BATCH_SETTINGS,
        modes: ['post'],
        cookieString: 'msToken=valid',
      },
    );

    assert.ok(wheelEvents >= 2, 'should dispatch real mouseWheel events to paginate');
    assert.deepEqual(
      res.works.map((w) => w.awemeId),
      ['7500001', '7500003', '7500004'],
    );
    assert.ok(res.works.every((w) => w.authorId === 'MS4wLjABAAAA_target'));
  } finally {
    setCustomCdpSessionFactory(null);
  }
});

test('discoverWorksForLink paginates direct collection links completely and filters non-owner works', async () => {
  const listeners: Array<(method: string, params: Record<string, unknown>) => void> = [];
  const bodies = new Map<string, string>();
  let page = 0;

  const emitResponse = (reqId: string, url: string, payload: unknown) => {
    bodies.set(reqId, JSON.stringify(payload));
    for (const listener of listeners) {
      listener('Network.requestWillBeSent', { requestId: reqId, request: { url } });
      listener('Network.responseReceived', {
        requestId: reqId,
        response: { url, status: 200 },
      });
      listener('Network.loadingFinished', { requestId: reqId });
    }
  };

  const mockSession: CdpSession = {
    onEvent(handler) {
      listeners.push(handler);
    },
    async send(method, params = {}) {
      if (method === 'Page.navigate') {
        setTimeout(() => {
          // Sidebar / unrelated mix must be ignored
          emitResponse(
            'req-other-mix',
            'https://www.douyin.com/aweme/v1/web/mix/aweme/?mix_id=999999&cursor=0',
            {
              status_code: 0,
              has_more: 0,
              aweme_list: [
                makeRawAweme({
                  aweme_id: '999001',
                  author: { nickname: '侧边栏作者', sec_uid: 'MS4wLjABAAAA_sidebar' },
                }),
              ],
            },
          );
          // Page 1 arrives BEFORE mix/detail (tests post-filter consistency pass too!)
          page = 1;
          emitResponse(
            'req-mix-p1',
            'https://www.douyin.com/aweme/v1/web/mix/aweme/?mix_id=7300111&cursor=0&count=10',
            {
              status_code: 0,
              has_more: 1,
              cursor: 10,
              aweme_list: [
                makeRawAweme({
                  aweme_id: '7600001',
                  author: { nickname: '合集作者', sec_uid: 'MS4wLjABAAAA_mix_owner' },
                }),
                makeRawAweme({
                  aweme_id: '7600002',
                  author: { nickname: '夹杂推荐作者', sec_uid: 'MS4wLjABAAAA_intruder' },
                }),
              ],
            },
          );
          // mix/detail arrives afterwards with authoritative owner sec_uid
          emitResponse(
            'req-mix-detail',
            'https://www.douyin.com/aweme/v1/web/mix/detail/?mix_id=7300111',
            {
              status_code: 0,
              mix_info: {
                mix_id: '7300111',
                mix_name: '完整教学合集',
                author: { nickname: '合集作者', sec_uid: 'MS4wLjABAAAA_mix_owner' },
                statis: { updated_to_episode: 2 },
              },
            },
          );
        }, 10);
        return {};
      }
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseWheel') {
        if (page === 1) {
          page = 2;
          setTimeout(() => {
            emitResponse(
              'req-mix-p2',
              'https://www.douyin.com/aweme/v1/web/mix/aweme/?mix_id=7300111&cursor=10&count=10',
              {
                status_code: 0,
                has_more: 0,
                cursor: 20,
                aweme_list: [
                  makeRawAweme({
                    aweme_id: '7600003',
                    author: { nickname: '合集作者', sec_uid: 'MS4wLjABAAAA_mix_owner' },
                  }),
                ],
              },
            );
          }, 10);
        }
        return {};
      }
      if (method === 'Network.getResponseBody') {
        return { body: bodies.get(String(params.requestId || '')) || '' };
      }
      return {};
    },
    close() {
      // noop
    },
  };

  setCustomCdpSessionFactory(async () => mockSession);
  try {
    const res = await discoverWorksForLink(
      {
        id: 'link-col-1',
        originalUrl: 'https://www.douyin.com/collection/7300111',
        resolvedUrl: 'https://www.douyin.com/collection/7300111',
        type: 'collection',
        label: '作品合集',
        targetId: '7300111',
        supported: true,
      },
      {
        ...DEFAULT_BATCH_SETTINGS,
        cookieString: 'msToken=valid',
      },
    );

    assert.deepEqual(
      res.works.map((w) => w.awemeId),
      ['7600001', '7600003'],
    );
    assert.ok(res.works.every((w) => w.authorId === 'MS4wLjABAAAA_mix_owner'));
    assert.equal(res.warnings.length, 0);
  } finally {
    setCustomCdpSessionFactory(null);
  }
});

test('discoverWorksForLink discovers all mixes on user homepage in mix mode and scrapes each collection', async () => {
  const listeners: Array<(method: string, params: Record<string, unknown>) => void> = [];
  const bodies = new Map<string, string>();
  const navigatedUrls: string[] = [];

  const emitResponse = (reqId: string, url: string, payload: unknown) => {
    bodies.set(reqId, JSON.stringify(payload));
    for (const listener of listeners) {
      listener('Network.requestWillBeSent', { requestId: reqId, request: { url } });
      listener('Network.responseReceived', {
        requestId: reqId,
        response: { url, status: 200 },
      });
      listener('Network.loadingFinished', { requestId: reqId });
    }
  };

  const mockSession: CdpSession = {
    onEvent(handler) {
      listeners.push(handler);
    },
    async send(method, params = {}) {
      if (method === 'Page.navigate') {
        const url = String(params.url || '');
        navigatedUrls.push(url);
        if (url.includes('/user/MS4wLjABAAAA_target')) {
          setTimeout(() => {
            // Initial post request on homepage must be ignored in mix mode
            emitResponse(
              'req-ignored-post',
              'https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=MS4wLjABAAAA_target',
              {
                status_code: 0,
                has_more: 0,
                aweme_list: [makeRawAweme({ aweme_id: '7700000' })],
              },
            );
            // Clicking 合集 triggers mix/list
            emitResponse(
              'req-mix-list',
              'https://www.douyin.com/aweme/v1/web/mix/list/?sec_user_id=MS4wLjABAAAA_target&cursor=0',
              {
                status_code: 0,
                has_more: 0,
                mix_infos: [
                  {
                    mix_id: '81001',
                    mix_name: '合集一',
                    author: { sec_uid: 'MS4wLjABAAAA_target', nickname: '目标博主' },
                  },
                  {
                    mix_id: '81002',
                    mix_name: '他人关联合集',
                    author: { sec_uid: 'MS4wLjABAAAA_someone_else', nickname: '他人' },
                  },
                ],
              },
            );
          }, 10);
        } else if (url.includes('/collection/81001')) {
          setTimeout(() => {
            emitResponse(
              'req-mix-81001',
              'https://www.douyin.com/aweme/v1/web/mix/aweme/?mix_id=81001&cursor=0',
              {
                status_code: 0,
                has_more: 0,
                aweme_list: [
                  makeRawAweme({ aweme_id: '7700001' }),
                  makeRawAweme({
                    aweme_id: '7700002',
                    author: { nickname: '其他作者', sec_uid: 'MS4wLjABAAAA_other' },
                  }),
                ],
              },
            );
          }, 10);
        }
        return {};
      }
      if (method === 'Network.getResponseBody') {
        return { body: bodies.get(String(params.requestId || '')) || '' };
      }
      return {};
    },
    close() {
      // noop
    },
  };

  setCustomCdpSessionFactory(async () => mockSession);
  try {
    const res = await discoverWorksForLink(
      {
        id: 'link-user-mix',
        originalUrl: 'https://www.douyin.com/user/MS4wLjABAAAA_target',
        resolvedUrl: 'https://www.douyin.com/user/MS4wLjABAAAA_target',
        type: 'user',
        label: '博主主页',
        targetId: 'MS4wLjABAAAA_target',
        supported: true,
      },
      {
        ...DEFAULT_BATCH_SETTINGS,
        modes: ['mix'],
        cookieString: 'msToken=valid',
      },
    );

    assert.deepEqual(navigatedUrls, [
      'https://www.douyin.com/user/MS4wLjABAAAA_target',
      'https://www.douyin.com/collection/81001',
    ]);
    assert.deepEqual(
      res.works.map((w) => w.awemeId),
      ['7700001'],
    );
  } finally {
    setCustomCdpSessionFactory(null);
  }
});

test('discoverWorksForLink falls back to in-page XHR cursor continuation when DOM scroll stalls with has_more=1', async () => {
  const listeners: Array<(method: string, params: Record<string, unknown>) => void> = [];
  const bodies = new Map<string, string>();
  const xhrUrlsCalled: string[] = [];

  const emitResponse = (reqId: string, url: string, payload: unknown) => {
    bodies.set(reqId, JSON.stringify(payload));
    for (const listener of listeners) {
      listener('Network.requestWillBeSent', { requestId: reqId, request: { url } });
      listener('Network.responseReceived', {
        requestId: reqId,
        response: { url, status: 200 },
      });
      listener('Network.loadingFinished', { requestId: reqId });
    }
  };

  const mockSession: CdpSession = {
    onEvent(handler) {
      listeners.push(handler);
    },
    async send(method, params = {}) {
      if (method === 'Page.navigate') {
        setTimeout(() => {
          emitResponse(
            'req-col-p1',
            'https://www.douyin.com/aweme/v1/web/mix/aweme/?mix_id=7300222&cursor=0&count=10&a_bogus=SIG1',
            {
              status_code: 0,
              has_more: 1,
              cursor: 10,
              aweme_list: [
                makeRawAweme({
                  aweme_id: '7800001',
                  author: { nickname: '合集博主', sec_uid: 'MS4wLjABAAAA_target' },
                  mix_info: { mix_id: '7300222', author: { sec_uid: 'MS4wLjABAAAA_target' } },
                }),
              ],
            },
          );
        }, 10);
        return {};
      }
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '');
        if (expr.includes('new XMLHttpRequest()')) {
          const match = expr.match(/xhr\.open\('GET', "([^"]+)"/);
          const path = match?.[1] || '';
          xhrUrlsCalled.push(path);
          if (path.includes('cursor=10')) {
            return {
              result: {
                value: JSON.stringify({
                  status_code: 0,
                  has_more: 0,
                  cursor: 20,
                  aweme_list: [
                    makeRawAweme({
                      aweme_id: '7800002',
                      author: { nickname: '合集博主', sec_uid: 'MS4wLjABAAAA_target' },
                      mix_info: { mix_id: '7300222', author: { sec_uid: 'MS4wLjABAAAA_target' } },
                    }),
                  ],
                }),
              },
            };
          }
        }
        return {};
      }
      if (method === 'Network.getResponseBody') {
        return { body: bodies.get(String(params.requestId || '')) || '' };
      }
      return {};
    },
    close() {
      // noop
    },
  };

  setCustomCdpSessionFactory(async () => mockSession);
  try {
    const res = await discoverWorksForLink(
      {
        id: 'link-col-xhr',
        originalUrl: 'https://www.douyin.com/collection/7300222',
        resolvedUrl: 'https://www.douyin.com/collection/7300222',
        type: 'collection',
        label: '作品合集',
        targetId: '7300222',
        supported: true,
      },
      {
        ...DEFAULT_BATCH_SETTINGS,
        cookieString: 'msToken=valid',
      },
    );

    assert.equal(xhrUrlsCalled.length, 1);
    assert.ok(xhrUrlsCalled[0].includes('cursor=10'));
    assert.equal(xhrUrlsCalled[0].includes('a_bogus'), false);
    assert.deepEqual(
      res.works.map((w) => w.awemeId),
      ['7800001', '7800002'],
    );
  } finally {
    setCustomCdpSessionFactory(null);
  }
});

test('discoverWorksForLink keeps other authors in user like mode while ignoring initial post list', async () => {
  const listeners: Array<(method: string, params: Record<string, unknown>) => void> = [];
  const bodies = new Map<string, string>();

  const emitResponse = (reqId: string, url: string, payload: unknown) => {
    bodies.set(reqId, JSON.stringify(payload));
    for (const listener of listeners) {
      listener('Network.requestWillBeSent', { requestId: reqId, request: { url } });
      listener('Network.responseReceived', {
        requestId: reqId,
        response: { url, status: 200 },
      });
      listener('Network.loadingFinished', { requestId: reqId });
    }
  };

  const mockSession: CdpSession = {
    onEvent(handler) {
      listeners.push(handler);
    },
    async send(method, params = {}) {
      if (method === 'Page.navigate') {
        setTimeout(() => {
          emitResponse(
            'req-post-ignored',
            'https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=MS4wLjABAAAA_target',
            {
              status_code: 0,
              has_more: 0,
              aweme_list: [makeRawAweme({ aweme_id: '7900000' })],
            },
          );
          emitResponse(
            'req-fav-1',
            'https://www.douyin.com/aweme/v1/web/aweme/favorite/?sec_user_id=MS4wLjABAAAA_target&max_cursor=0',
            {
              status_code: 0,
              has_more: 0,
              aweme_list: [
                makeRawAweme({
                  aweme_id: '7900001',
                  author: { nickname: '被点赞的作者', sec_uid: 'MS4wLjABAAAA_liked_creator' },
                }),
              ],
            },
          );
        }, 10);
        return {};
      }
      if (method === 'Network.getResponseBody') {
        return { body: bodies.get(String(params.requestId || '')) || '' };
      }
      return {};
    },
    close() {
      // noop
    },
  };

  setCustomCdpSessionFactory(async () => mockSession);
  try {
    const res = await discoverWorksForLink(
      {
        id: 'link-user-like',
        originalUrl: 'https://www.douyin.com/user/MS4wLjABAAAA_target',
        resolvedUrl: 'https://www.douyin.com/user/MS4wLjABAAAA_target',
        type: 'user',
        label: '博主主页',
        targetId: 'MS4wLjABAAAA_target',
        supported: true,
      },
      {
        ...DEFAULT_BATCH_SETTINGS,
        modes: ['like'],
        cookieString: 'msToken=valid',
      },
    );

    assert.deepEqual(
      res.works.map((w) => w.awemeId),
      ['7900001'],
    );
    assert.equal(res.works[0].authorId, 'MS4wLjABAAAA_liked_creator');
  } finally {
    setCustomCdpSessionFactory(null);
  }
});
