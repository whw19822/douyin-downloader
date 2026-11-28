import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAwemeListFromRouterData,
  extractGalleryImages,
  extractRouterDataFromHtml,
  isWatermarkedMediaUrl,
  parseAwemeToMedia,
  parseCookieString,
  pickBestVideoMedia,
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

test('pickBestVideoMedia highest prefers higher resolution (e.g. 1080p/4K H.265) over larger-byte lower-res H.264', () => {
  const raw = {
    aweme_id: '7500000000000000001',
    video: {
      bit_rate: [
        {
          gear_name: 'normal_720_0',
          bit_rate: 3_500_000,
          play_addr: {
            uri: 'v0200_720',
            url_list: ['https://v26-web.douyinvod.com/720p-h264.mp4'],
            data_size: 18_000_000,
            width: 720,
            height: 1280,
          },
        },
        {
          gear_name: 'adapt_1080_1',
          bit_rate: 2_200_000,
          play_addr: {
            uri: 'v0200_1080',
            url_list: ['https://v26-web.douyinvod.com/1080p-h265.mp4'],
            data_size: 11_000_000,
            width: 1080,
            height: 1920,
          },
        },
        {
          gear_name: 'normal_1080_0',
          bit_rate: 4_800_000,
          play_addr: {
            uri: 'v0200_1080_hq',
            url_list: [
              'https://www.douyin.com/aweme/v1/play/?video_id=v0200_1080_hq&ratio=720p',
              'https://v26-web.douyinvod.com/1080p-hq.mp4',
            ],
            data_size: 0, // missing data_size must not cause 720p to win!
            width: 1080,
            height: 1920,
          },
        },
      ],
    },
  };

  const highest = pickBestVideoMedia(raw, 'highest');
  // Must pick 1080p HQ (highest resolution + highest bitrate), and prefer direct CDN over /aweme/v1/play/
  assert.equal(highest.url, 'https://v26-web.douyinvod.com/1080p-hq.mp4');
  assert.equal(highest.width, 1080);
  assert.equal(highest.height, 1920);
  assert.equal(highest.uri, 'v0200_1080_hq');

  // original uses same highest base track
  const orig = pickBestVideoMedia(raw, 'original');
  assert.equal(orig.url, highest.url);

  // 720p specifically picks 720p track
  const p720 = pickBestVideoMedia(raw, '720p');
  assert.equal(p720.url, 'https://v26-web.douyinvod.com/720p-h264.mp4');
});

test('pickBestVideoMedia upgrades ratio=720p on mobile share play_addr URLs when highest quality requested', () => {
  const raw = {
    aweme_id: '7500000000000000002',
    video: {
      play_addr: {
        uri: 'v0300fg1_share',
        url_list: ['https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0300fg1_share&ratio=720p&line=0'],
      },
    },
  };

  const highest = pickBestVideoMedia(raw, 'highest');
  assert.equal(
    highest.url,
    'https://aweme.snssdk.com/aweme/v1/play/?video_id=v0300fg1_share&ratio=1080p&line=0',
  );
  assert.equal(highest.uri, 'v0300fg1_share');
});

test('extractGalleryImages strictly prefers watermark-free url_list/origin_image over watermarked download_url_list', () => {
  assert.equal(
    isWatermarkedMediaUrl('https://p3-sign.douyinpic.com/tos-cn-i-xxx~tplv-dy-water-v2:666.jpeg'),
    true,
  );
  assert.equal(
    isWatermarkedMediaUrl('https://p3-sign.douyinpic.com/tos-cn-i-xxx~noop.jpeg'),
    false,
  );

  const raw = {
    aweme_id: '7500000000000000003',
    aweme_type: 68,
    images: [
      {
        width: 1080,
        height: 1440,
        // Even if url_list is webp and download_url_list is jpeg with tplv-dy-water,
        // watermark-free url_list MUST win!
        url_list: ['https://p3-sign.douyinpic.com/tos-cn-i-1~tplv-dy-aweme-images:q75.webp'],
        download_url_list: [
          'https://p3-sign.douyinpic.com/tos-cn-i-1~tplv-dy-water-v2:abc.jpeg',
        ],
      },
      {
        watermark_free_download_url_list: [
          'https://p3-sign.douyinpic.com/tos-cn-i-2~noop.jpeg',
        ],
        url_list: ['https://p3-sign.douyinpic.com/tos-cn-i-2~q75.webp'],
        download_url_list: [
          'https://p3-sign.douyinpic.com/tos-cn-i-2~tplv-dy-water-v2:abc.jpeg',
        ],
      },
      {
        origin_image: {
          width: 2160,
          height: 2880,
          url_list: ['https://p3-sign.douyinpic.com/tos-cn-i-3~origin.jpeg'],
        },
        url_list: ['https://p3-sign.douyinpic.com/tos-cn-i-3~display.jpeg'],
        download_url_list: [
          'https://p3-sign.douyinpic.com/tos-cn-i-3~tplv-dy-water-v2:abc.jpeg',
        ],
      },
    ],
  };

  const urls = extractGalleryImages(raw);
  assert.deepEqual(urls, [
    'https://p3-sign.douyinpic.com/tos-cn-i-1~tplv-dy-aweme-images:q75.webp',
    'https://p3-sign.douyinpic.com/tos-cn-i-2~noop.jpeg',
    'https://p3-sign.douyinpic.com/tos-cn-i-3~origin.jpeg',
  ]);
});
