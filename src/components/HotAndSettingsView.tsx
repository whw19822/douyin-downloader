import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  RefreshCw,
  Save,
} from 'lucide-react';
import { getHotBoardApi } from '../lib/api';
import { generateConfigYaml } from '../lib/batchRules';
import {
  ALLOWED_TEMPLATE_VARIABLES,
  renderNamingTemplate,
  validateNamingTemplate,
} from '../lib/naming';
import type {
  AuthorDirMode,
  BatchSettings,
  HotBoardItem,
} from '../lib/types';

interface HotAndSettingsViewProps {
  settings: BatchSettings;
  activeLinks: string[];
  onSaveSettings: (next: BatchSettings) => Promise<void>;
  onAddSearchTopic: (topic: string) => void;
  onNotify: (msg: string) => void;
}

const SAMPLE_NAMING_CTX = {
  id: '7394812098765432101',
  title: '深秋胶片感城市扫街实拍',
  author: '山野映像志',
  author_id: 'MS4wLjABAAAA6O7EZy',
  date: '2026-11-26',
  timestamp: 1795651200,
  type: 'video',
  mode: 'post',
};

function formatHotScore(score: number): string {
  if (score >= 10000) {
    return `${(score / 10000).toFixed(1)} 万`;
  }
  return String(score);
}

export function HotAndSettingsView({
  settings,
  activeLinks,
  onSaveSettings,
  onAddSearchTopic,
  onNotify,
}: HotAndSettingsViewProps) {
  const [draft, setDraft] = useState<BatchSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [copiedYaml, setCopiedYaml] = useState(false);

  const [hotItems, setHotItems] = useState<HotBoardItem[]>([]);
  const [hotSource, setHotSource] = useState<'live' | 'snapshot'>('snapshot');
  const [loadingHot, setLoadingHot] = useState(true);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const loadHotBoard = async (forceRefresh = false) => {
    setLoadingHot(true);
    try {
      const res = await getHotBoardApi(forceRefresh);
      setHotItems(res.items);
      setHotSource(res.source);
    } catch {
      onNotify('热搜榜加载失败');
    } finally {
      setLoadingHot(false);
    }
  };

  useEffect(() => {
    void loadHotBoard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fileTplValidation = useMemo(
    () => validateNamingTemplate(draft.filenameTemplate),
    [draft.filenameTemplate],
  );
  const folderTplValidation = useMemo(
    () => validateNamingTemplate(draft.folderTemplate),
    [draft.folderTemplate],
  );
  const canSave = fileTplValidation.valid && folderTplValidation.valid;

  const previewFilename = useMemo(
    () =>
      fileTplValidation.valid
        ? renderNamingTemplate(draft.filenameTemplate, SAMPLE_NAMING_CTX)
        : '模板存在语法错误，请修正后预览',
    [draft.filenameTemplate, fileTplValidation.valid],
  );

  const liveYaml = useMemo(
    () => generateConfigYaml(activeLinks, draft),
    [activeLinks, draft],
  );

  const handleSave = async () => {
    if (!canSave) {
      onNotify('请先修正不合法的命名模板后再保存');
      return;
    }
    setSaving(true);
    try {
      await onSaveSettings(draft);
      onNotify('全局引擎配置与命名模板已保存');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '保存配置失败');
    } finally {
      setSaving(false);
    }
  };

  const handleInsertVariable = (varName: string) => {
    setDraft((prev) => ({
      ...prev,
      filenameTemplate: `${prev.filenameTemplate}_{${varName}}`,
    }));
  };

  const handleCopyYaml = async () => {
    try {
      await navigator.clipboard.writeText(liveYaml);
      setCopiedYaml(true);
      onNotify('已复制完整 config.yml');
      setTimeout(() => setCopiedYaml(false), 1800);
    } catch {
      onNotify('无法写入剪贴板，请直接点击下载 config.yml');
    }
  };

  const handleDownloadYaml = () => {
    const blob = new Blob([liveYaml], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'config.yml';
    a.click();
    URL.revokeObjectURL(url);
    onNotify('已下载 config.yml');
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          热点发现与引擎配置
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
          自定义文件命名模板、登录态 Cookie、速率控制并导出与原项目完全兼容的 YAML 配置文件。
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <section className="xl:col-span-7 bg-white dark:bg-[#111622] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              命名模板与全局引擎参数
            </h2>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !canSave}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 disabled:bg-slate-300 dark:disabled:bg-slate-700 disabled:text-slate-500 transition-colors whitespace-nowrap shrink-0"
            >
              <Save className="w-3.5 h-3.5" aria-hidden="true" />
              {saving ? '保存中...' : '保存配置'}
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label
                htmlFor="download-path-input"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                默认保存目录
              </label>
              <input
                id="download-path-input"
                type="text"
                value={draft.downloadPath}
                onChange={(e) => setDraft({ ...draft, downloadPath: e.target.value })}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100 focus:border-rose-500 focus:outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="author-dir-select"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                作者目录层级命名
              </label>
              <select
                id="author-dir-select"
                value={draft.authorDir}
                onChange={(e) =>
                  setDraft({ ...draft, authorDir: e.target.value as AuthorDirMode })
                }
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:border-rose-500 focus:outline-none"
              >
                <option value="nickname">仅作者昵称 (nickname)</option>
                <option value="sec_uid">仅唯一 UID (sec_uid)</option>
                <option value="nickname_uid">昵称 + UID（推荐防重名）</option>
              </select>
            </div>
          </div>

          <div className="space-y-2 border-t border-slate-200 dark:border-slate-800 pt-4">
            <label
              htmlFor="filename-template-input"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              文件命名模板
            </label>
            <input
              id="filename-template-input"
              type="text"
              value={draft.filenameTemplate}
              onChange={(e) =>
                setDraft({ ...draft, filenameTemplate: e.target.value })
              }
              aria-invalid={!fileTplValidation.valid}
              className={`w-full rounded-lg border px-3 py-2 text-xs font-mono bg-white dark:bg-[#0B0F17] text-slate-900 dark:text-slate-100 focus:outline-none ${
                fileTplValidation.valid
                  ? 'border-slate-200 dark:border-slate-700 focus:border-rose-500'
                  : 'border-red-500 focus:border-red-600'
              }`}
            />
            {!fileTplValidation.valid && (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {fileTplValidation.error}
              </p>
            )}
            <div className="text-xs text-slate-500 dark:text-slate-400">
              实时预览：
              <span className="font-mono text-slate-800 dark:text-slate-200 ml-1 break-all">
                {previewFilename}.mp4
              </span>
            </div>

            <div className="pt-1 flex flex-wrap gap-1.5">
              {ALLOWED_TEMPLATE_VARIABLES.slice(0, 9).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => handleInsertVariable(v)}
                  className="px-2 py-1 rounded text-[11px] font-mono bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 transition-colors"
                >
                  {`{${v}}`}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="folder-template-input"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              作品子目录模板
            </label>
            <input
              id="folder-template-input"
              type="text"
              value={draft.folderTemplate}
              onChange={(e) => setDraft({ ...draft, folderTemplate: e.target.value })}
              aria-invalid={!folderTplValidation.valid}
              className={`w-full rounded-lg border px-3 py-2 text-xs font-mono bg-white dark:bg-[#0B0F17] text-slate-900 dark:text-slate-100 focus:outline-none ${
                folderTplValidation.valid
                  ? 'border-slate-200 dark:border-slate-700 focus:border-rose-500'
                  : 'border-red-500 focus:border-red-600'
              }`}
            />
            {!folderTplValidation.valid && (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {folderTplValidation.error}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 border-t border-slate-200 dark:border-slate-800 pt-4">
            <div className="space-y-1.5">
              <label
                htmlFor="rate-limit-input"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                请求限速（次/秒）
              </label>
              <input
                id="rate-limit-input"
                type="number"
                step={0.5}
                min={0.5}
                max={20}
                value={draft.rateLimitPerSec}
                onChange={(e) =>
                  setDraft({ ...draft, rateLimitPerSec: Number(e.target.value) || 2 })
                }
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-xs font-mono tabular-nums text-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="retry-times-input"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                失败自动重试次数
              </label>
              <input
                id="retry-times-input"
                type="number"
                min={0}
                max={10}
                value={draft.retryTimes}
                onChange={(e) =>
                  setDraft({ ...draft, retryTimes: Number(e.target.value) || 0 })
                }
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-xs font-mono tabular-nums text-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="proxy-url-input"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                代理地址（留空直连）
              </label>
              <input
                id="proxy-url-input"
                type="text"
                placeholder="http://127.0.0.1:7890"
                value={draft.proxyUrl}
                onChange={(e) => setDraft({ ...draft, proxyUrl: e.target.value })}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="cookie-textarea"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              抖音登录态 Cookie（可选，仅用于突破风控与抓取主页列表）
            </label>
            <textarea
              id="cookie-textarea"
              rows={3}
              value={draft.cookieString}
              onChange={(e) => setDraft({ ...draft, cookieString: e.target.value })}
              placeholder="msToken=...; ttwid=...; odin_tt=...; passport_csrf_token=..."
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-[#0B0F17] px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-rose-500 focus:outline-none"
            />
          </div>
        </section>

        <div className="xl:col-span-5 space-y-6">
          <section className="bg-white dark:bg-[#111622] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  抖音实时热搜榜
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  数据源：{hotSource === 'live' ? '抖音公开热榜直连' : '本地热榜快照'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void loadHotBoard(true)}
                disabled={loadingHot}
                aria-label="刷新热搜榜"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${loadingHot ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                刷新
              </button>
            </div>

            {loadingHot ? (
              <div className="space-y-2 py-2">
                {[1, 2, 3, 4].map((n) => (
                  <div key={n} className="h-9 rounded bg-slate-100 dark:bg-slate-800/60 animate-pulse" />
                ))}
              </div>
            ) : (
              <ol className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {hotItems.slice(0, 8).map((item) => (
                  <li
                    key={item.rank}
                    className="py-2.5 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="flex items-baseline gap-2.5 min-w-0">
                      <span
                        className={`font-mono tabular-nums w-4 shrink-0 font-semibold ${
                          item.rank <= 3
                            ? 'text-rose-600 dark:text-rose-400'
                            : 'text-slate-400 dark:text-slate-500'
                        }`}
                      >
                        {item.rank}
                      </span>
                      <div className="min-w-0">
                        <div className="font-medium text-slate-900 dark:text-slate-100 truncate">
                          {item.word}
                        </div>
                        <div className="text-[11px] text-slate-400 dark:text-slate-500 tabular-nums">
                          {item.category} · 热度 {formatHotScore(item.hotValue)}
                          {item.label ? ` · ${item.label}` : ''}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onAddSearchTopic(item.word)}
                      className="text-xs font-medium text-rose-600 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300 whitespace-nowrap shrink-0"
                    >
                      复制搜索词
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="bg-white dark:bg-[#111622] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                config.yml 实时导出预览
              </h2>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleCopyYaml}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                >
                  {copiedYaml ? (
                    <Check className="w-3 h-3 text-emerald-600" aria-hidden="true" />
                  ) : (
                    <Copy className="w-3 h-3" aria-hidden="true" />
                  )}
                  {copiedYaml ? '已复制' : '复制'}
                </button>
                <button
                  type="button"
                  onClick={handleDownloadYaml}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                >
                  <Download className="w-3 h-3" aria-hidden="true" />
                  下载
                </button>
              </div>
            </div>
            <pre className="p-3.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100 text-[11px] leading-relaxed font-mono overflow-x-auto max-h-64">
              {liveYaml}
            </pre>
          </section>
        </div>
      </div>
    </div>
  );
}
