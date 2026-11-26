import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChromeLaunchArgs,
  discoverWorksForLink,
  isHeadlessShellBinary,
  setCustomCdpSessionFactory,
  type CdpSession,
} from './douyinScraper';
import { DEFAULT_BATCH_SETTINGS } from '../src/lib/types';

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
