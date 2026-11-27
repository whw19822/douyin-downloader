import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BatchJobStore } from './jobStore';
import { PersistenceStore } from './persistence';
import type { ArchiveItem, BatchJob, BatchSettings } from '../src/lib/types';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('BatchJobStore persists settings and UI preferences across restarts', () => {
  const dataDir = makeTempDir('douyin-persist-settings-');
  try {
    const store1 = new BatchJobStore({ dataDir });
    const updated = store1.updateSettings({
      downloadPath: '/tmp/my-douyin-downloads',
      modes: ['post', 'mix', 'like'],
      maxItemsPerMode: 45,
      videoQuality: '1440p',
      concurrency: 7,
      retryTimes: 0,
      rateLimitPerSec: 4.5,
      startDate: '2026-01-01',
      endDate: '2026-11-26',
      incremental: false,
      redownloadMissingFiles: false,
      folderStyle: false,
      authorDir: 'sec_uid',
      filenameTemplate: '{author}_{id}',
      folderTemplate: '{date}_{author}',
      includeVideo: true,
      includeCover: false,
      includeMusic: true,
      includeAvatar: true,
      includeJson: false,
      cookieString: 'ttwid=abc123; msToken=xyz789',
      proxyUrl: 'http://127.0.0.1:7890',
    });
    assert.equal(updated.retryTimes, 0);

    store1.updatePreferences({
      theme: 'dark',
      draftInput: 'https://www.douyin.com/video/7400000000000000001',
    });

    // Simulate process restart with a brand new store instance
    const store2 = new BatchJobStore({ dataDir });
    const restoredSettings: BatchSettings = store2.getSettings();
    assert.equal(restoredSettings.downloadPath, '/tmp/my-douyin-downloads');
    assert.deepEqual(restoredSettings.modes, ['post', 'mix', 'like']);
    assert.equal(restoredSettings.maxItemsPerMode, 45);
    assert.equal(restoredSettings.videoQuality, '1440p');
    assert.equal(restoredSettings.concurrency, 7);
    assert.equal(restoredSettings.retryTimes, 0);
    assert.equal(restoredSettings.rateLimitPerSec, 4.5);
    assert.equal(restoredSettings.startDate, '2026-01-01');
    assert.equal(restoredSettings.endDate, '2026-11-26');
    assert.equal(restoredSettings.incremental, false);
    assert.equal(restoredSettings.redownloadMissingFiles, false);
    assert.equal(restoredSettings.folderStyle, false);
    assert.equal(restoredSettings.authorDir, 'sec_uid');
    assert.equal(restoredSettings.filenameTemplate, '{author}_{id}');
    assert.equal(restoredSettings.folderTemplate, '{date}_{author}');
    assert.equal(restoredSettings.includeCover, false);
    assert.equal(restoredSettings.includeMusic, true);
    assert.equal(restoredSettings.includeAvatar, true);
    assert.equal(restoredSettings.includeJson, false);
    assert.equal(restoredSettings.cookieString, 'ttwid=abc123; msToken=xyz789');
    assert.equal(restoredSettings.proxyUrl, 'http://127.0.0.1:7890');

    const restoredPrefs = store2.getPreferences();
    assert.equal(restoredPrefs.theme, 'dark');
    assert.equal(
      restoredPrefs.draftInput,
      'https://www.douyin.com/video/7400000000000000001',
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('BatchJobStore restores jobs, archive, disk file links, and recovers interrupted tasks', () => {
  const dataDir = makeTempDir('douyin-persist-state-');
  const mediaFile = path.join(dataDir, 'sample-video.mp4');
  fs.writeFileSync(mediaFile, Buffer.from('fake-mp4-binary-payload'));

  try {
    const persistence = new PersistenceStore(dataDir);
    const now = new Date().toISOString();

    const archiveEntry: ArchiveItem = {
      awemeId: '7400000000000000111',
      title: '已下载的测试视频',
      author: '测试博主',
      authorId: 'sec_uid_1',
      type: 'video',
      mode: 'post',
      publishDate: '2026-11-20',
      downloadedAt: now,
      quality: 'highest',
      sizeBytes: 23,
      filename: '2026-11-20_已下载的测试视频_7400000000000000111',
      folderName: '2026-11-20_已下载的测试视频_7400000000000000111',
      sourceUrl: 'https://www.douyin.com/video/7400000000000000111',
      artifacts: ['MP4 视频 (highest)'],
      savedFiles: [
        {
          kind: 'video',
          filename: 'sample-video.mp4',
          relativePath: 'sample-video.mp4',
          sizeBytes: 23,
        },
      ],
      filePresent: true,
    };

    const interruptedJob: BatchJob = {
      jobId: 'job-interrupted',
      label: '真实批量下载（2 个作品：2 视频 / 0 图文）',
      createdAt: now,
      startedAt: now,
      status: 'running',
      sourceUrls: [
        'https://www.douyin.com/video/7400000000000000111',
        'https://www.douyin.com/video/7400000000000000222',
      ],
      warnings: [],
      settingsSnapshot: {
        ...new BatchJobStore({ dataDir }).getSettings(),
        hasCookie: false,
      },
      items: [
        {
          itemId: 'job-interrupted-1',
          awemeId: '7400000000000000111',
          sourceUrl: 'https://www.douyin.com/video/7400000000000000111',
          resolvedUrl: 'https://www.douyin.com/video/7400000000000000111',
          type: 'video',
          mode: 'post',
          title: '已下载的测试视频',
          author: '测试博主',
          authorId: 'sec_uid_1',
          publishDate: '2026-11-20',
          quality: 'highest',
          sizeBytes: 23,
          filename: 'sample-video',
          folderName: 'sample-video',
          status: 'success',
          progress: 100,
          retries: 0,
          message: '已完成',
          upstreamStatus: 'live',
          artifacts: ['MP4 视频 (highest)'],
          savedFiles: archiveEntry.savedFiles,
          downloadReady: true,
          updatedAt: now,
        },
        {
          itemId: 'job-interrupted-2',
          awemeId: '7400000000000000222',
          sourceUrl: 'https://www.douyin.com/video/7400000000000000222',
          resolvedUrl: 'https://www.douyin.com/video/7400000000000000222',
          type: 'video',
          mode: 'post',
          title: '退出时正在下载的视频',
          author: '测试博主',
          authorId: 'sec_uid_1',
          publishDate: '2026-11-21',
          quality: 'highest',
          sizeBytes: 0,
          filename: 'pending-video',
          folderName: 'pending-video',
          status: 'running',
          progress: 42,
          retries: 0,
          message: '正在下载...',
          upstreamStatus: 'live',
          artifacts: ['MP4 视频 (highest)'],
          savedFiles: [],
          downloadReady: false,
          updatedAt: now,
        },
      ],
      total: 2,
      success: 1,
      skipped: 0,
      failed: 0,
      pending: 0,
      running: 1,
      progressPercent: 71,
      downloadableCount: 1,
    };

    persistence.saveState({
      jobs: [interruptedJob],
      archive: [archiveEntry],
      itemDiskFiles: {
        'job-interrupted:job-interrupted-1': [
          {
            kind: 'video',
            filename: 'sample-video.mp4',
            absolutePath: mediaFile,
            relativePath: 'sample-video.mp4',
            sizeBytes: 23,
          },
        ],
      },
      archiveDiskFiles: {
        '7400000000000000111': [
          {
            kind: 'video',
            filename: 'sample-video.mp4',
            absolutePath: mediaFile,
            relativePath: 'sample-video.mp4',
            sizeBytes: 23,
          },
        ],
      },
    });

    // Load into fresh store instance simulating restart
    const restored = new BatchJobStore({ dataDir });
    const jobs = restored.listJobs();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, 'partial');
    assert.equal(jobs[0].items[0].status, 'success');
    assert.equal(jobs[0].items[0].downloadReady, true);
    assert.equal(jobs[0].items[1].status, 'cancelled');
    assert.equal(jobs[0].items[1].progress, 0);
    assert.match(jobs[0].items[1].message, /中断/);

    const archive = restored.listArchive();
    assert.equal(archive.length, 1);
    assert.equal(archive[0].awemeId, '7400000000000000111');
    assert.equal(archive[0].filePresent, true);
    assert.equal(restored.getArchiveFiles('7400000000000000111').length, 1);
    assert.equal(
      restored.getItemFiles('job-interrupted', 'job-interrupted-1').length,
      1,
    );

    // Deleting job and archive item persists across next restart
    assert.equal(restored.deleteJob('job-interrupted'), true);
    assert.equal(restored.deleteArchiveItem('7400000000000000111'), true);

    const afterDelete = new BatchJobStore({ dataDir });
    assert.equal(afterDelete.listJobs().length, 0);
    assert.equal(afterDelete.listArchive().length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('PersistenceStore recovers cleanly from corrupt JSON files', () => {
  const dataDir = makeTempDir('douyin-persist-corrupt-');
  try {
    fs.writeFileSync(path.join(dataDir, 'settings.json'), '{not-valid-json', 'utf8');
    fs.writeFileSync(path.join(dataDir, 'state.json'), '<<<broken>>>', 'utf8');

    const store = new BatchJobStore({ dataDir });
    assert.equal(store.listJobs().length, 0);
    assert.equal(store.listArchive().length, 0);
    assert.equal(store.getSettings().concurrency, 3);

    const files = fs.readdirSync(dataDir);
    assert.ok(files.some((f) => f.startsWith('settings.json.corrupt.')));
    assert.ok(files.some((f) => f.startsWith('state.json.corrupt.')));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
