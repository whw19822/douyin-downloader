import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBatchInput } from './src/lib/urlParser';
import { validateNamingTemplate } from './src/lib/naming';
import { generateConfigYaml } from './src/lib/batchRules';
import { fetchDouyinHotBoard, inspectAndResolveLinks } from './server/douyinService';
import { jobStore } from './server/jobStore';
import { isAllowedMediaHost, streamFilesAsZip } from './server/mediaDownloader';
import type { BatchSettings, DiscoveredWork } from './src/lib/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '6mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      edition: 'open-batch-real-downloader',
      timestamp: new Date().toISOString(),
    });
  });

  app.post('/api/inspect', async (req, res) => {
    try {
      const rawText = typeof req.body?.rawText === 'string' ? req.body.rawText : '';
      const resolveShort = Boolean(req.body?.resolveShort ?? true);
      const { links, duplicatesRemoved } = parseBatchInput(rawText);
      const currentSettings = jobStore.getSettings();
      const resolvedLinks = resolveShort
        ? await inspectAndResolveLinks(links, currentSettings.cookieString)
        : links;

      res.json({
        links: resolvedLinks,
        duplicatesRemoved,
        supportedCount: resolvedLinks.filter((l) => l.supported).length,
        unsupportedCount: resolvedLinks.filter((l) => !l.supported).length,
      });
    } catch {
      res.status(500).json({ error: '链接解析失败，请检查输入格式' });
    }
  });

  app.post('/api/discover', async (req, res) => {
    try {
      const rawText = typeof req.body?.rawText === 'string' ? req.body.rawText : '';
      if (!rawText.trim()) {
        res.status(400).json({ error: '请先输入至少一条抖音链接' });
        return;
      }
      const settings = (req.body?.settings || {}) as Partial<BatchSettings>;
      if (settings.cookieString !== undefined) {
        jobStore.updateSettings({ cookieString: settings.cookieString });
      }
      const result = await jobStore.discoverFromText(rawText, settings);
      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : '深度解析抖音作品列表失败',
      });
    }
  });

  app.get('/api/jobs', (_req, res) => {
    res.json({ jobs: jobStore.listJobs() });
  });

  app.get('/api/jobs/:jobId', (req, res) => {
    const job = jobStore.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: '未找到指定任务' });
      return;
    }
    res.json({ job });
  });

  app.post('/api/jobs', async (req, res) => {
    try {
      const urls = Array.isArray(req.body?.urls)
        ? req.body.urls.filter(
            (u: unknown): u is string => typeof u === 'string' && u.trim().length > 0,
          )
        : [];
      const works = Array.isArray(req.body?.works)
        ? (req.body.works as DiscoveredWork[])
        : [];

      if (urls.length === 0 && works.length === 0) {
        res.status(400).json({ error: '请先解析作品列表或输入有效的抖音链接' });
        return;
      }

      const settings = (req.body?.settings || {}) as Partial<BatchSettings>;
      if (settings.filenameTemplate !== undefined) {
        const check = validateNamingTemplate(settings.filenameTemplate);
        if (!check.valid) {
          res.status(400).json({ error: check.error || '文件命名模板不合法' });
          return;
        }
      }
      if (settings.folderTemplate !== undefined) {
        const check = validateNamingTemplate(settings.folderTemplate);
        if (!check.valid) {
          res.status(400).json({ error: check.error || '目录命名模板不合法' });
          return;
        }
      }

      const job = await jobStore.createJob({ urls, works }, settings);
      res.status(201).json({ job });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : '创建批量下载任务失败',
      });
    }
  });

  app.post('/api/jobs/:jobId/cancel', (req, res) => {
    const job = jobStore.cancelJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: '未找到指定任务' });
      return;
    }
    res.json({ job });
  });

  app.post('/api/jobs/:jobId/retry', (req, res) => {
    const job = jobStore.retryFailedItems(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: '未找到指定任务' });
      return;
    }
    res.json({ job });
  });

  app.delete('/api/jobs/:jobId', (req, res) => {
    const deleted = jobStore.deleteJob(req.params.jobId);
    if (!deleted) {
      res.status(404).json({ error: '未找到指定任务' });
      return;
    }
    res.json({ ok: true });
  });

  app.get('/api/jobs/:jobId/export', (req, res) => {
    const formatParam = String(req.query.format || 'yaml');
    const format =
      formatParam === 'jsonl' || formatParam === 'manifest' ? formatParam : 'yaml';
    const exported = jobStore.exportJobContent(req.params.jobId, format);
    if (!exported) {
      res.status(404).json({ error: '未找到指定任务' });
      return;
    }
    res.setHeader('Content-Type', exported.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`);
    res.send(exported.body);
  });

  // Real binary file download: single item (direct MP4 or multi-file ZIP)
  app.get('/api/files/item/:jobId/:itemId', async (req, res) => {
    const files = jobStore
      .getItemFiles(req.params.jobId, req.params.itemId)
      .filter((f) => fs.existsSync(f.absolutePath));

    if (files.length === 0) {
      res.status(404).json({ error: '本地未找到该作品的已下载文件' });
      return;
    }

    const primaryVideo = files.find((f) => f.kind === 'video');
    if (primaryVideo && files.filter((f) => f.kind === 'image').length === 0 && files.length <= 2) {
      const encoded = encodeURIComponent(primaryVideo.filename);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="douyin-video.mp4"; filename*=UTF-8''${encoded}`,
      );
      fs.createReadStream(primaryVideo.absolutePath).pipe(res);
      return;
    }

    await streamFilesAsZip(
      res,
      `douyin-${req.params.itemId}.zip`,
      files.map((f) => ({
        absolutePath: f.absolutePath,
        archiveName: f.relativePath || f.filename,
      })),
    );
  });

  // Real binary file download: entire batch job as ZIP
  app.get('/api/files/job/:jobId/zip', async (req, res) => {
    const files = jobStore.getJobAllFiles(req.params.jobId);
    await streamFilesAsZip(
      res,
      `douyin-batch-${req.params.jobId}.zip`,
      files.map((f) => ({
        absolutePath: f.absolutePath,
        archiveName: f.relativePath || f.filename,
      })),
    );
  });

  // Real binary file download: archived item from disk
  app.get('/api/files/archive/:awemeId', async (req, res) => {
    const files = jobStore.getArchiveFiles(req.params.awemeId);
    if (files.length === 0) {
      res.status(404).json({ error: '磁盘中未找到该归档作品的实际媒体文件' });
      return;
    }
    const primaryVideo = files.find((f) => f.kind === 'video');
    if (primaryVideo && files.filter((f) => f.kind === 'image').length === 0 && files.length <= 2) {
      const encoded = encodeURIComponent(primaryVideo.filename);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="douyin-video.mp4"; filename*=UTF-8''${encoded}`,
      );
      fs.createReadStream(primaryVideo.absolutePath).pipe(res);
      return;
    }
    await streamFilesAsZip(
      res,
      `douyin-${req.params.awemeId}.zip`,
      files.map((f) => ({
        absolutePath: f.absolutePath,
        archiveName: f.relativePath || f.filename,
      })),
    );
  });

  // SSRF-safe thumbnail proxy for Douyin cover images
  app.get('/api/media-proxy', async (req, res) => {
    const rawUrl = String(req.query.url || '');
    if (!rawUrl || !isAllowedMediaHost(rawUrl)) {
      res.status(400).end();
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const upstream = await fetch(rawUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
          Referer: 'https://www.douyin.com/',
        },
        signal: controller.signal,
      });
      if (!upstream.ok) {
        res.status(upstream.status).end();
        return;
      }
      const ct = upstream.headers.get('content-type') || 'image/jpeg';
      if (!ct.startsWith('image/')) {
        res.status(400).end();
        return;
      }
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    } catch {
      res.status(502).end();
    } finally {
      clearTimeout(timer);
    }
  });

  app.get('/api/archive', (_req, res) => {
    res.json({ items: jobStore.listArchive() });
  });

  app.delete('/api/archive/:awemeId', (req, res) => {
    const ok = jobStore.deleteArchiveItem(req.params.awemeId);
    if (!ok) {
      res.status(404).json({ error: '未找到归档记录' });
      return;
    }
    res.json({ ok: true });
  });

  app.post('/api/archive/:awemeId/toggle-file', (req, res) => {
    const item = jobStore.toggleArchiveFilePresent(req.params.awemeId);
    if (!item) {
      res.status(404).json({ error: '未找到归档记录' });
      return;
    }
    res.json({ item });
  });

  app.get('/api/settings', (_req, res) => {
    const settings = jobStore.getSettings();
    res.json({
      settings,
      yaml: generateConfigYaml([], settings),
    });
  });

  app.put('/api/settings', (req, res) => {
    const body = (req.body || {}) as Partial<BatchSettings>;
    if (body.filenameTemplate !== undefined) {
      const check = validateNamingTemplate(body.filenameTemplate);
      if (!check.valid) {
        res.status(400).json({ error: check.error });
        return;
      }
    }
    if (body.folderTemplate !== undefined) {
      const check = validateNamingTemplate(body.folderTemplate);
      if (!check.valid) {
        res.status(400).json({ error: check.error });
        return;
      }
    }
    const updated = jobStore.updateSettings(body);
    res.json({
      settings: updated,
      yaml: generateConfigYaml([], updated),
    });
  });

  app.get('/api/hot-board', async (req, res) => {
    const settings = jobStore.getSettings();
    const forceRefresh = req.query.refresh === '1';
    const result = await fetchDouyinHotBoard(settings.cookieString, forceRefresh);
    res.json(result);
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Douyin Batch Studio running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
