import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  guessImageExt,
  isAllowedMediaHost,
  probeOriginalVideoUrl,
  resolveMediaOutputLocation,
} from './mediaDownloader';
import { generateXBogus } from './xbogus';
import { BatchJobStore } from './jobStore';
import { PersistenceStore } from './persistence';
import { DEFAULT_BATCH_SETTINGS } from '../src/lib/types';

test('resolveMediaOutputLocation separates per-work folders when folderStyle is true and flattens into author folder when false', () => {
  const baseMedia = {
    awemeId: '7400000000000000123',
    author: '摄影博主A',
    authorId: 'MS4wLjABAAAA_authorA',
  };

  const nested = resolveMediaOutputLocation(
    baseMedia,
    '2026-11-27_雪山日出_7400000000000000123',
    '2026-11-27_雪山日出_7400000000000000123',
    {
      downloadPath: './Downloaded/',
      authorDir: 'nickname',
      folderStyle: true,
    },
  );
  assert.equal(nested.authorFolder, '摄影博主A');
  assert.equal(
    path.relative(nested.rootDir, nested.itemDir),
    path.join('摄影博主A', '2026-11-27_雪山日出_7400000000000000123'),
  );

  const flat = resolveMediaOutputLocation(
    baseMedia,
    '2026-11-27_雪山日出_7400000000000000123',
    '2026-11-27_雪山日出_7400000000000000123',
    {
      downloadPath: './Downloaded/',
      authorDir: 'nickname',
      folderStyle: false,
    },
  );
  assert.equal(path.relative(flat.rootDir, flat.itemDir), '摄影博主A');
  assert.equal(flat.safeStem, '2026-11-27_雪山日出_7400000000000000123');
});

test('resolveMediaOutputLocation preserves awemeId suffix in flat mode to prevent long-title overwrites', () => {
  const longTitleStem = '2026-11-27_' + '超长重复标题内容'.repeat(12);
  const first = resolveMediaOutputLocation(
    { awemeId: '7400000000000000001', author: '博主B', authorId: 'SEC_B' },
    longTitleStem,
    longTitleStem,
    {
      downloadPath: './Downloaded/',
      authorDir: 'nickname',
      folderStyle: false,
    },
  );
  const second = resolveMediaOutputLocation(
    { awemeId: '7400000000000000002', author: '博主B', authorId: 'SEC_B' },
    longTitleStem,
    longTitleStem,
    {
      downloadPath: './Downloaded/',
      authorDir: 'nickname',
      folderStyle: false,
    },
  );

  assert.equal(first.itemDir, second.itemDir);
  assert.ok(first.safeStem.endsWith('_7400000000000000001'));
  assert.ok(second.safeStem.endsWith('_7400000000000000002'));
  assert.notEqual(first.safeStem, second.safeStem);
});

test('BatchJobStore skips archived works even when local files are missing when redownloadMissingFiles is false', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-inc-skip-'));
  try {
    const persistence = new PersistenceStore(tmpDir);
    persistence.saveSettings(
      {
        ...DEFAULT_BATCH_SETTINGS,
        incremental: true,
        redownloadMissingFiles: false,
        folderStyle: false,
      },
      { theme: 'light', draftInput: '' },
    );
    persistence.saveState({
      jobs: [],
      archive: [
        {
          awemeId: '7499999999999999888',
          title: '已删除本地文件的历史档案',
          author: '测试博主',
          authorId: 'SEC_TEST',
          type: 'video',
          mode: 'post',
          publishDate: '2026-11-20',
          downloadedAt: '2026-11-20T10:00:00.000Z',
          quality: 'highest',
          sizeBytes: 2048000,
          filename: '2026-11-20_已删除本地文件的历史档案_7499999999999999888',
          folderName: '2026-11-20_已删除本地文件的历史档案_7499999999999999888',
          sourceUrl: 'https://www.douyin.com/video/7499999999999999888',
          artifacts: ['MP4 视频 (highest)'],
          savedFiles: [],
          filePresent: false,
        },
      ],
      itemDiskFiles: {},
      archiveDiskFiles: {
        '7499999999999999888': [
          {
            kind: 'video',
            filename: 'missing.mp4',
            absolutePath: path.join(tmpDir, 'nonexistent-deleted.mp4'),
            relativePath: 'nonexistent-deleted.mp4',
            sizeBytes: 2048000,
          },
        ],
      },
    });

    const store = new BatchJobStore({ dataDir: tmpDir });
    const loadedSettings = store.getSettings();
    assert.equal(loadedSettings.incremental, true);
    assert.equal(loadedSettings.redownloadMissingFiles, false);
    assert.equal(loadedSettings.folderStyle, false);

    const job = await store.createJob({
      works: [
        {
          awemeId: '7499999999999999888',
          sourceUrl: 'https://www.douyin.com/video/7499999999999999888',
          type: 'video',
          mode: 'post',
          title: '已删除本地文件的历史档案',
          author: '测试博主',
          authorId: 'SEC_TEST',
          publishDate: '2026-11-20',
          publishTs: 1795100000,
          videoUrl: 'https://v26-web.douyinvod.com/play/demo.mp4',
          imageUrls: [],
          sizeBytes: 2048000,
        },
      ],
    });

    assert.equal(job.status, 'success');
    assert.equal(job.skipped, 1);
    assert.equal(job.items[0].status, 'skipped');
    assert.equal(job.items[0].downloadReady, false);
    assert.equal(job.items[0].savedFiles.length, 0);
    assert.match(job.items[0].message, /已存档案自动跳过（本地文件缺失）/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('guessImageExt handles Douyin CDN tilde paths and Content-Type accurately', () => {
  assert.equal(
    guessImageExt('https://p3-sign.douyinpic.com/tos-cn-i-1~tplv-dy-aweme-images:q75.webp?x=1'),
    '.webp',
  );
  assert.equal(
    guessImageExt('https://p3-sign.douyinpic.com/tos-cn-i-1~noop.jpeg?x=1'),
    '.jpg',
  );
  assert.equal(
    guessImageExt('https://p3-sign.douyinpic.com/tos-cn-i-1~noop.image?x=1', 'image/webp'),
    '.webp',
  );
});

test('probeOriginalVideoUrl signs desktop play URL with X-Bogus, falls back to snssdk mobile play, and enforces size/4K rules', async () => {
  const signed = generateXBogus(
    'https://www.douyin.com/aweme/v1/play/?video_id=v0200_uri&ratio=default',
    undefined,
    1700000000,
  );
  assert.ok(signed.signedUrl.includes('&X-Bogus='));
  assert.ok(signed.token.length >= 20);
  assert.equal(isAllowedMediaHost('https://v99-coldx.bytevcloud.com/original.mp4'), true);

  // Desktop 403 -> automatically falls back to aweme.snssdk.com mobile play endpoint
  const calledUrls: string[] = [];
  const fallbackMockFetch = (async (url: string) => {
    calledUrls.push(String(url));
    if (String(url).includes('www.douyin.com')) {
      return { status: 403, url: String(url), headers: new Headers() };
    }
    return {
      status: 206,
      url: 'https://v99-coldx.douyinvod.com/original-4k.mp4',
      headers: new Headers({
        'content-type': 'video/mp4',
        'content-range': 'bytes 0-0/45000000',
      }),
    };
  }) as unknown as typeof fetch;

  const promoted = await probeOriginalVideoUrl('v0200_uri', 12_000_000, {
    isNeedSetCookie: true,
    fetchImpl: fallbackMockFetch,
  });
  assert.equal(calledUrls.length, 2);
  assert.ok(calledUrls[0].includes('X-Bogus='));
  assert.ok(calledUrls[0].includes('ss_is_p_v_ss=1'));
  assert.ok(calledUrls[1].startsWith('https://aweme.snssdk.com/aweme/v1/play/'));
  assert.equal(promoted?.url, 'https://v99-coldx.douyinvod.com/original-4k.mp4');
  assert.equal(promoted?.sizeBytes, 45_000_000);

  // Smaller same-resolution probe is rejected
  const smallerMockFetch = (async () => ({
    status: 206,
    url: 'https://v26-web.douyinvod.com/smaller-orig.mp4',
    headers: new Headers({
      'content-type': 'video/mp4',
      'content-range': 'bytes 0-0/8000000',
    }),
  })) as unknown as typeof fetch;

  const rejected = await probeOriginalVideoUrl('v0200_uri', 12_000_000, {
    fetchImpl: smallerMockFetch,
  });
  assert.equal(rejected, null);

  // Higher-res source (e.g. 2160x3840 H.265 master vs 1080p H.264 track) promotes when >= 65% size
  const promoted4k = await probeOriginalVideoUrl('v0200_uri', 12_000_000, {
    preferHigherResSource: true,
    fetchImpl: (async () => ({
      status: 206,
      url: 'https://v26-web.douyinvod.com/4k-hevc.mp4',
      headers: new Headers({
        'content-type': 'video/mp4',
        'content-range': 'bytes 0-0/10000000',
      }),
    })) as unknown as typeof fetch,
  });
  assert.equal(promoted4k?.url, 'https://v26-web.douyinvod.com/4k-hevc.mp4');
});
