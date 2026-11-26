import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateConfigYaml,
  isWithinDateRange,
  shouldSkipIncremental,
  summarizeJobItems,
} from './batchRules';
import { DEFAULT_BATCH_SETTINGS, type JobItem } from './types';

test('isWithinDateRange enforces inclusive start and end boundaries', () => {
  assert.equal(isWithinDateRange('2026-05-10', '2026-05-01', '2026-05-10'), true);
  assert.equal(isWithinDateRange('2026-05-01', '2026-05-01', '2026-05-10'), true);
  assert.equal(isWithinDateRange('2026-04-30', '2026-05-01', '2026-05-10'), false);
  assert.equal(isWithinDateRange('2026-05-11', '2026-05-01', '2026-05-10'), false);
});

test('shouldSkipIncremental respects increase and redownloadMissingFiles switches', () => {
  const archived = new Set(['739481']);
  assert.equal(
    shouldSkipIncremental('739481', archived, {
      incremental: true,
      redownloadMissingFiles: true,
      fileExistsOnDisk: true,
    }),
    true,
  );
  assert.equal(
    shouldSkipIncremental('739481', archived, {
      incremental: true,
      redownloadMissingFiles: true,
      fileExistsOnDisk: false,
    }),
    false,
  );
  assert.equal(
    shouldSkipIncremental('739481', archived, {
      incremental: true,
      redownloadMissingFiles: false,
      fileExistsOnDisk: false,
    }),
    true,
  );
  assert.equal(
    shouldSkipIncremental('739481', archived, {
      incremental: false,
      redownloadMissingFiles: true,
      fileExistsOnDisk: true,
    }),
    false,
  );
});

test('generateConfigYaml outputs valid douyin-downloader YAML with modes and quality', () => {
  const yaml = generateConfigYaml(
    ['https://www.douyin.com/user/MS4wLjABAAAA_test'],
    {
      ...DEFAULT_BATCH_SETTINGS,
      modes: ['post', 'mix'],
      videoQuality: 'original',
      concurrency: 6,
      startDate: '2026-01-01',
      endDate: '2026-10-31',
    },
  );
  assert.match(yaml, /video_quality: original/);
  assert.match(yaml, /thread: 6/);
  assert.match(yaml, /- post/);
  assert.match(yaml, /- mix/);
  assert.match(yaml, /start_time: "2026-01-01"/);
});

test('summarizeJobItems computes accurate status tallies and progress', () => {
  const base: Omit<JobItem, 'itemId' | 'status' | 'progress'> = {
    awemeId: '1',
    sourceUrl: 'https://www.douyin.com/video/1',
    resolvedUrl: 'https://www.douyin.com/video/1',
    type: 'video',
    mode: 'post',
    title: 'Sample',
    author: 'Author',
    authorId: 'uid',
    publishDate: '2026-10-01',
    quality: 'highest',
    sizeBytes: 1024,
    filename: '2026-10-01_Sample_1',
    folderName: '2026-10-01_Sample_1',
    retries: 0,
    message: '',
    upstreamStatus: 'resolved',
    artifacts: ['video'],
    savedFiles: [],
    downloadReady: false,
    updatedAt: '2026-10-01T00:00:00Z',
  };
  const summary = summarizeJobItems([
    { ...base, itemId: 'a', status: 'success', progress: 100 },
    { ...base, itemId: 'b', status: 'skipped', progress: 100 },
    { ...base, itemId: 'c', status: 'running', progress: 50 },
    { ...base, itemId: 'd', status: 'failed', progress: 0 },
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.success, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.running, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.progressPercent, 63);
});
