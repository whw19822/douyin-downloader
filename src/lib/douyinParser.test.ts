import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAwemeListFromRouterData,
  extractRouterDataFromHtml,
  parseAwemeToMedia,
  parseCookieString,
  toWatermarkFreeUrl,
} from './douyinParser';

test('toWatermarkFreeUrl replaces /playwm/ with /play/ and upgrades to https', () => {
  assert.equal(
    toWatermarkFreeUrl('http://aweme.snssdk.com/aweme/v1/playwm/?video_id=abc'),
    'https://aweme.snssdk.com/aweme/v1/play/?video_id=abc',
  );
});

test('parseAwemeToMedia extracts highest bitrate video and respects quality preference', () => {
  const raw = {
    aweme_id: '7412345678901234567',
    aweme_type: 0,
    desc: '实测航拍 4K',
    create_time: 1730000000,
    author: { nickname: '摄影师A', sec_uid: 'MS4wLjABAAAA_test' },
    video: {
      bit_rate: [
        {
          bit_rate: 1500000,
          play_addr: {
            url_list: ['https://v26-web.douyinvod.com/720p.mp4'],
            data_size: 8_000_000,
            width: 720,
            height: 1280,
          },
        },
        {
          bit_rate: 4500000,
          play_addr: {
            url_list: ['https://v26-web.douyinvod.com/1080p.mp4'],
            data_size: 24_000_000,
            width: 1080,
            height: 1920,
          },
        },
      ],
      origin_cover: { url_list: ['https://p3-sign.douyinpic.com/cover.jpeg'] },
    },
  };

  const highest = parseAwemeToMedia(raw, 'highest');
  assert.equal(highest?.mediaType, 'video');
  assert.equal(highest?.videoUrl, 'https://v26-web.douyinvod.com/1080p.mp4');
  assert.equal(highest?.sizeBytes, 24_000_000);

  const low = parseAwemeToMedia(raw, 'lowest');
  assert.equal(low?.videoUrl, 'https://v26-web.douyinvod.com/720p.mp4');
});

test('parseAwemeToMedia detects photo galleries (aweme_type 68) and extracts all image URLs', () => {
  const raw = {
    aweme_id: '7412345678909999999',
    aweme_type: 68,
    desc: '三张图集测试',
    create_time: 1731000000,
    author: { nickname: '图文作者', sec_uid: 'MS4wLjABAAAA_img' },
    images: [
      { url_list: ['https://p3-sign.douyinpic.com/1.webp', 'https://p3-sign.douyinpic.com/1.jpeg'] },
      { url_list: ['https://p3-sign.douyinpic.com/2.jpeg'] },
      { download_url_list: ['https://p3-sign.douyinpic.com/3.png'] },
    ],
  };

  const parsed = parseAwemeToMedia(raw, 'highest');
  assert.equal(parsed?.mediaType, 'gallery');
  assert.equal(parsed?.imageUrls.length, 3);
  assert.equal(parsed?.imageUrls[0], 'https://p3-sign.douyinpic.com/1.jpeg');
  assert.equal(parsed?.imageUrls[2], 'https://p3-sign.douyinpic.com/3.png');
});

test('extractRouterDataFromHtml parses window._ROUTER_DATA and finds aweme items', () => {
  const html = `<html><head></head><body><script>window._ROUTER_DATA = {"loaderData":{"video_(id)/page":{"videoInfoRes":{"item_list":[{"aweme_id":"7400000000000000001","desc":"真实分享页视频","video":{"play_addr":{"url_list":["https://v26-web.douyinvod.com/playwm/test"]}}}]}}}};</script></body></html>`;
  const data = extractRouterDataFromHtml(html);
  assert.ok(data);
  const items = extractAwemeListFromRouterData(data!);
  assert.equal(items.length, 1);
  assert.equal(items[0].aweme_id, '7400000000000000001');
});

test('parseCookieString parses semicolon-delimited cookies', () => {
  const cookies = parseCookieString('msToken=abc=123; ttwid=xyz; empty=');
  assert.equal(cookies.length, 2);
  assert.deepEqual(cookies[0], {
    name: 'msToken',
    value: 'abc=123',
    domain: '.douyin.com',
    path: '/',
  });
});
