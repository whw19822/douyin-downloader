import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractRawUrls,
  isShortUrl,
  parseBatchInput,
  parseDouyinUrl,
} from './urlParser';

test('extractRawUrls parses pasted Douyin share copy text and strips trailing punctuation', () => {
  const pasted = `
    4.82 复制打开抖音，看看【摄影日记】的作品 https://v.douyin.com/iRNBhojb/ 复制此链接，打开Dou音搜索，直接观看视频！
    https://www.douyin.com/user/MS4wLjABAAAA6O7EZyfDRYXxJrUTpf91K3tmB4rBROkAw-nYMfld8ss，
    v.douyin.com/abc12345/
  `;
  const urls = extractRawUrls(pasted);
  assert.deepEqual(urls, [
    'https://v.douyin.com/iRNBhojb/',
    'https://www.douyin.com/user/MS4wLjABAAAA6O7EZyfDRYXxJrUTpf91K3tmB4rBROkAw-nYMfld8ss',
    'https://v.douyin.com/abc12345/',
  ]);
});

test('parseDouyinUrl classifies all supported Douyin link types and extracts IDs', () => {
  const video = parseDouyinUrl('https://www.douyin.com/video/7394812345678901234');
  assert.equal(video.type, 'video');
  assert.equal(video.targetId, '7394812345678901234');
  assert.equal(video.supported, true);

  const modal = parseDouyinUrl(
    'https://www.douyin.com/user/MS4wLjABAAAA123?modal_id=7394812345678909999',
  );
  assert.equal(modal.type, 'video');
  assert.equal(modal.targetId, '7394812345678909999');

  const user = parseDouyinUrl('https://www.douyin.com/user/MS4wLjABAAAA_test_uid');
  assert.equal(user.type, 'user');
  assert.equal(user.targetId, 'MS4wLjABAAAA_test_uid');

  const gallery = parseDouyinUrl('https://www.douyin.com/note/7394812345678901111');
  assert.equal(gallery.type, 'gallery');
  assert.equal(gallery.targetId, '7394812345678901111');

  const mix = parseDouyinUrl('https://www.douyin.com/collection/7234567890123456789');
  assert.equal(mix.type, 'collection');
  assert.equal(mix.targetId, '7234567890123456789');

  const live = parseDouyinUrl('https://live.douyin.com/80017709309');
  assert.equal(live.type, 'live');
  assert.equal(live.targetId, '80017709309');

  assert.equal(isShortUrl('v.douyin.com/test123/'), true);
});

test('parseDouyinUrl rejects lvdetail encrypted long videos and unknown hosts clearly', () => {
  const lv = parseDouyinUrl('https://www.douyin.com/lvdetail/7331203341890049058');
  assert.equal(lv.type, 'lvdetail');
  assert.equal(lv.supported, false);
  assert.match(lv.reason || '', /MPEG-CENC/);

  const unknown = parseDouyinUrl('https://example.com/video/123');
  assert.equal(unknown.type, 'unsupported');
  assert.equal(unknown.supported, false);
});

test('parseBatchInput deduplicates repeated URLs with trailing slash differences', () => {
  const result = parseBatchInput(
    'https://www.douyin.com/video/123456\nhttps://www.douyin.com/video/123456/\nhttps://www.douyin.com/note/999',
  );
  assert.equal(result.links.length, 2);
  assert.equal(result.duplicatesRemoved, 1);
});
