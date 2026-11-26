import { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  FileCode2,
  Film,
  Image as ImageIcon,
  KeyRound,
  Link2,
  Loader2,
  Search,
  Trash2,
} from 'lucide-react';
import {
  formatBytes,
  generateCliCommand,
  generateConfigYaml,
} from '../lib/batchRules';
import {
  discoverWorksApi,
  inspectLinksApi,
  type CreatorProfileSummary,
} from '../lib/api';
import { parseBatchInput } from '../lib/urlParser';
import type {
  BatchSettings,
  DiscoveredWork,
  DownloadMode,
  ParsedLink,
  VideoQuality,
} from '../lib/types';

interface BatchDownloaderViewProps {
  rawInput: string;
  onChangeRawInput: (value: string) => void;
  settings: BatchSettings;
  onChangeSettings: (next: BatchSettings) => void;
  onSubmitBatch: (payload: { urls?: string[]; works?: DiscoveredWork[] }) => Promise<void>;
  submitting: boolean;
  onNotify: (message: string) => void;
}

const MODE_OPTIONS: Array<{ id: DownloadMode; label: string }> = [
  { id: 'post', label: '发布作品' },
  { id: 'mix', label: '作品合集' },
  { id: 'like', label: '点赞列表' },
  { id: 'music', label: '音乐原声' },
  { id: 'collect', label: '我的收藏' },
];

const QUALITY_OPTIONS: Array<{ value: VideoQuality; label: string }> = [
  { value: 'highest', label: '最高转码档 (highest)' },
  { value: 'original', label: '探测原始画质 (original)' },
  { value: '1440p', label: '2K 优先 (1440p)' },
  { value: '1080p', label: '全高清 (1080p)' },
  { value: '720p', label: '高清 (720p)' },
  { value: '540p', label: '标清 (540p)' },
  { value: 'lowest', label: '最低省流 (lowest)' },
];

export function BatchDownloaderView({
  rawInput,
  onChangeRawInput,
  settings,
  onChangeSettings,
  onSubmitBatch,
  submitting,
  onNotify,
}: BatchDownloaderViewProps) {
  const [resolvedLinks, setResolvedLinks] = useState<ParsedLink[] | null>(null);
  const [resolving, setResolving] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoveredWorks, setDiscoveredWorks] = useState<DiscoveredWork[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [profiles, setProfiles] = useState<CreatorProfileSummary[]>([]);
  const [discoveryWarnings, setDiscoveryWarnings] = useState<string[]>([]);
  const [needsCookieHint, setNeedsCookieHint] = useState(false);
  const [copiedCli, setCopiedCli] = useState(false);

  const cookieInputRef = useRef<HTMLTextAreaElement | null>(null);

  const clientParsed = useMemo(() => parseBatchInput(rawInput), [rawInput]);
  const displayedLinks = resolvedLinks ?? clientParsed.links;
  const supportedLinks = useMemo(
    () => displayedLinks.filter((l) => l.supported),
    [displayedLinks],
  );
  const unsupportedLinks = useMemo(
    () => displayedLinks.filter((l) => !l.supported),
    [displayedLinks],
  );
  const hasUserOrCollectionLink = useMemo(
    () =>
      supportedLinks.some(
        (l) => l.type === 'user' || l.type === 'collection' || l.type === 'music',
      ),
    [supportedLinks],
  );

  const selectedWorks = useMemo(
    () => discoveredWorks.filter((w) => selectedIds.has(w.awemeId)),
    [discoveredWorks, selectedIds],
  );

  const handleInputChange = (val: string) => {
    setResolvedLinks(null);
    onChangeRawInput(val);
  };

  const handleResolveShortLinks = async () => {
    if (!rawInput.trim()) {
      onNotify('请先粘贴至少一条抖音链接或分享口令');
      return;
    }
    setResolving(true);
    try {
      const res = await inspectLinksApi(rawInput, true);
      setResolvedLinks(res.links);
      onNotify(
        `短链识别完成：共 ${res.links.length} 条链接（可用 ${res.supportedCount} 条）`,
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '短链解析失败');
    } finally {
      setResolving(false);
    }
  };

  const handleDeepDiscover = async () => {
    if (supportedLinks.length === 0) {
      onNotify('请先粘贴有效的抖音主页、视频、图文或合集链接');
      return;
    }
    setDiscovering(true);
    setDiscoveryWarnings([]);
    setNeedsCookieHint(false);
    try {
      const res = await discoverWorksApi(rawInput, settings);
      setResolvedLinks(res.links);
      setDiscoveredWorks(res.works);
      setProfiles(res.profiles);
      setDiscoveryWarnings(res.warnings);
      setNeedsCookieHint(res.requiresCookie);
      setSelectedIds(new Set(res.works.map((w) => w.awemeId)));

      const videos = res.works.filter((w) => w.type === 'video').length;
      const galleries = res.works.filter((w) => w.type === 'gallery').length;
      if (res.works.length > 0) {
        onNotify(
          `真实解析完成：共获取到 ${res.works.length} 个作品（${videos} 个视频 · ${galleries} 个图文）`,
        );
      } else if (res.warnings.length > 0) {
        onNotify(res.warnings[0]);
      } else {
        onNotify('未解析到可下载作品，请检查链接或 Cookie 状态');
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : '真实作品列表解析失败');
    } finally {
      setDiscovering(false);
    }
  };

  const handleRemoveLink = (targetOriginalUrl: string) => {
    const remaining = displayedLinks
      .filter((l) => l.originalUrl !== targetOriginalUrl)
      .map((l) => l.originalUrl);
    setResolvedLinks(null);
    onChangeRawInput(remaining.join('\n'));
  };

  const toggleMode = (mode: DownloadMode) => {
    const exists = settings.modes.includes(mode);
    const nextModes = exists
      ? settings.modes.filter((m) => m !== mode)
      : [...settings.modes, mode];
    if (nextModes.length === 0) return;
    onChangeSettings({ ...settings, modes: nextModes });
  };

  const toggleWorkSelect = (awemeId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(awemeId)) next.delete(awemeId);
      else next.add(awemeId);
      return next;
    });
  };

  const selectByType = (kind: 'all' | 'video' | 'gallery' | 'none') => {
    if (kind === 'none') {
      setSelectedIds(new Set());
      return;
    }
    if (kind === 'all') {
      setSelectedIds(new Set(discoveredWorks.map((w) => w.awemeId)));
      return;
    }
    setSelectedIds(
      new Set(discoveredWorks.filter((w) => w.type === kind).map((w) => w.awemeId)),
    );
  };

  const handleExportYaml = () => {
    const yaml = generateConfigYaml(
      supportedLinks.map((l) => l.resolvedUrl || l.originalUrl),
      settings,
    );
    const blob = new Blob([yaml], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'config.yml';
    a.click();
    URL.revokeObjectURL(url);
    onNotify('已导出兼容 douyin-downloader 的 config.yml');
  };

  const handleCopyCli = async () => {
    const cmd = generateCliCommand(
      supportedLinks.map((l) => l.resolvedUrl || l.originalUrl),
      settings,
    );
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedCli(true);
      onNotify('已复制 CLI 批量下载命令');
      setTimeout(() => setCopiedCli(false), 1800);
    } catch {
      onNotify('浏览器未授予剪贴板权限，请手动导出 config.yml');
    }
  };

  const handleStartDownload = async () => {
    if (discoveredWorks.length > 0) {
      if (selectedWorks.length === 0) {
        onNotify('请至少勾选一个已解析的作品后再开始下载');
        return;
      }
      await onSubmitBatch({ works: selectedWorks });
      return;
    }

    if (supportedLinks.length === 0) {
      onNotify('请先粘贴有效的抖音链接');
      return;
    }
    await onSubmitBatch({
      urls: supportedLinks.map((l) => l.resolvedUrl || l.originalUrl),
    });
  };

  const videoCount = discoveredWorks.filter((w) => w.type === 'video').length;
  const galleryCount = discoveredWorks.filter((w) => w.type === 'gallery').length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          批量链接解析与真实媒体下载
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          免内测码直接解锁无限条数批量下载。粘贴抖音链接后点击「深度解析全部作品」核对视频与图文清单，再一键下载无水印 MP4 / 原图到本地或打包 ZIP。
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-7 space-y-6">
          <section className="bg-white dark:bg-[#111622] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label
                htmlFor="batch-links-textarea"
                className="text-sm font-semibold text-slate-900 dark:text-slate-100"
              >
                粘贴抖音链接或分享口令（支持多行混合粘贴）
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleResolveShortLinks}
                  disabled={resolving || !rawInput.trim()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                >
                  {resolving ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                  解析短链
                </button>
                {rawInput && (
                  <button
                    type="button"
                    onClick={() => {
                      handleInputChange('');
                      setDiscoveredWorks([]);
                      setProfiles([]);
                      setDiscoveryWarnings([]);
                      setNeedsCookieHint(false);
                    }}
                    className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-500 hover:text-rose-600 dark:text-slate-400 dark:hover:text-rose-400 transition-colors whitespace-nowrap shrink-0"
                  >
                    清空
                  </button>
                )}
              </div>
            </div>

            <textarea
              id="batch-links-textarea"
              rows={5}
              value={rawInput}
              onChange={(e) => handleInputChange(e.target.value)}
              placeholder={`每行一条链接，或直接粘贴整段抖音 App 分享文案：\nhttps://www.douyin.com/user/MS4wLjABAAAA...\nhttps://v.douyin.com/iRNBhojb/\nhttps://www.douyin.com/video/7400000000000000001\nhttps://www.douyin.com/note/7400000000000000002`}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-[#0B0F17] px-3.5 py-3 text-sm font-mono text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-rose-500 focus:outline-none focus:ring-2 focus:ring-rose-500/20 resize-y"
            />

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                <span>已识别 {displayedLinks.length} 条</span>
                <span aria-hidden="true">·</span>
                <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                  可解析 {supportedLinks.length} 条
                </span>
                {unsupportedLinks.length > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="text-amber-700 dark:text-amber-400 font-medium">
                      已拦截 {unsupportedLinks.length} 条
                    </span>
                  </>
                )}
              </div>

              <button
                type="button"
                disabled={discovering || supportedLinks.length === 0}
                onClick={handleDeepDiscover}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
              >
                {discovering ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Search className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                {discovering ? '正在分页拉取真实作品...' : '深度解析全部作品（视频 + 图文）'}
              </button>
            </div>

            {displayedLinks.length > 0 && (
              <div className="border-t border-slate-200 dark:border-slate-800 pt-3 overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                      <th className="py-2 pr-3 font-medium">链接类型</th>
                      <th className="py-2 px-3 font-medium">目标 ID / 链接</th>
                      <th className="py-2 px-3 font-medium">状态</th>
                      <th className="py-2 pl-2 text-right font-medium">移除</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70 text-xs">
                    {displayedLinks.map((item) => (
                      <tr key={item.originalUrl}>
                        <td className="py-2 pr-3 whitespace-nowrap font-medium text-slate-800 dark:text-slate-200">
                          {item.label}
                        </td>
                        <td className="py-2 px-3 max-w-[280px]">
                          <div className="font-mono text-slate-700 dark:text-slate-300 truncate">
                            {item.targetId || item.originalUrl}
                          </div>
                          {item.reason && (
                            <div className="text-[11px] text-amber-700 dark:text-amber-400 mt-0.5">
                              {item.reason}
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-3 whitespace-nowrap">
                          {item.supported ? (
                            <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                              就绪
                            </span>
                          ) : (
                            <span className="text-rose-600 dark:text-rose-400 font-medium">
                              不支持
                            </span>
                          )}
                        </td>
                        <td className="py-2 pl-2 text-right">
                          <button
                            type="button"
                            onClick={() => handleRemoveLink(item.originalUrl)}
                            aria-label={`移除链接 ${item.targetId || item.originalUrl}`}
                            className="p-1 rounded text-slate-400 hover:text-rose-600 dark:hover:text-rose-400"
                          >
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {(profiles.length > 0 || discoveryWarnings.length > 0 || discoveredWorks.length > 0) && (
            <section className="bg-white dark:bg-[#111622] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    真实解析作品列表
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 tabular-nums mt-0.5">
                    {profiles.length > 0
                      ? profiles
                          .map(
                            (p) =>
                              `博主「${p.nickname}」（主页共 ${p.awemeCount} 作品 / ${p.favoritingCount} 喜欢）`,
                          )
                          .join(' · ')
                      : '已从抖音真实接口解析出以下可下载作品'}
                  </p>
                </div>

                {discoveredWorks.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <button
                      type="button"
                      onClick={() => selectByType('all')}
                      className="px-2.5 py-1 rounded-md bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 whitespace-nowrap"
                    >
                      全选 ({discoveredWorks.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => selectByType('video')}
                      className="px-2.5 py-1 rounded-md bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 whitespace-nowrap"
                    >
                      仅视频 ({videoCount})
                    </button>
                    <button
                      type="button"
                      onClick={() => selectByType('gallery')}
                      className="px-2.5 py-1 rounded-md bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 whitespace-nowrap"
                    >
                      仅图文 ({galleryCount})
                    </button>
                    <button
                      type="button"
                      onClick={() => selectByType('none')}
                      className="px-2.5 py-1 rounded-md text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 whitespace-nowrap"
                    >
                      清空勾选
                    </button>
                  </div>
                )}
              </div>

              {discoveryWarnings.length > 0 && (
                <div className="rounded-lg border border-amber-200 dark:border-amber-800/80 bg-amber-50/70 dark:bg-amber-950/30 p-3.5 space-y-2">
                  {discoveryWarnings.map((warn, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs text-amber-900 dark:text-amber-200 leading-relaxed">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                      <span>{warn}</span>
                    </div>
                  ))}
                  {needsCookieHint && (
                    <button
                      type="button"
                      onClick={() => cookieInputRef.current?.focus()}
                      className="ml-6 text-xs font-semibold text-rose-700 dark:text-rose-400 underline underline-offset-4"
                    >
                      立即填写右侧抖音 Cookie →
                    </button>
                  )}
                </div>
              )}

              {discoveredWorks.length > 0 && (
                <div className="overflow-x-auto max-h-[420px] overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-lg">
                  <table className="w-full text-left border-collapse">
                    <thead className="sticky top-0 bg-slate-50 dark:bg-[#0D121D] border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 z-10">
                      <tr>
                        <th className="py-2.5 px-3 w-8 font-medium">选</th>
                        <th className="py-2.5 px-3 font-medium">封面与作品标题</th>
                        <th className="py-2.5 px-3 font-medium whitespace-nowrap">类型</th>
                        <th className="py-2.5 px-3 font-medium text-right whitespace-nowrap">
                          发布日期
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70 text-xs">
                      {discoveredWorks.map((work) => {
                        const checked = selectedIds.has(work.awemeId);
                        return (
                          <tr
                            key={work.awemeId}
                            className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30"
                          >
                            <td className="py-2.5 px-3 align-middle">
                              <input
                                type="checkbox"
                                checked={checked}
                                aria-label={`选择作品 ${work.title}`}
                                onChange={() => toggleWorkSelect(work.awemeId)}
                                className="w-4 h-4 rounded accent-rose-600 cursor-pointer"
                              />
                            </td>
                            <td className="py-2.5 px-3 max-w-[340px]">
                              <div className="flex items-center gap-3">
                                {work.coverUrl ? (
                                  <img
                                    src={`/api/media-proxy?url=${encodeURIComponent(work.coverUrl)}`}
                                    alt={work.title}
                                    referrerPolicy="no-referrer"
                                    className="w-10 h-10 rounded object-cover bg-slate-100 dark:bg-slate-800 shrink-0"
                                  />
                                ) : (
                                  <div className="w-10 h-10 rounded bg-slate-100 dark:bg-slate-800 flex items-center justify-center shrink-0 text-slate-400">
                                    {work.type === 'gallery' ? (
                                      <ImageIcon className="w-4 h-4" aria-hidden="true" />
                                    ) : (
                                      <Film className="w-4 h-4" aria-hidden="true" />
                                    )}
                                  </div>
                                )}
                                <div className="min-w-0">
                                  <div className="font-medium text-slate-900 dark:text-slate-100 truncate">
                                    {work.title}
                                  </div>
                                  <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5 tabular-nums">
                                    {work.author} · ID {work.awemeId}
                                    {work.sizeBytes > 0 && ` · ${formatBytes(work.sizeBytes)}`}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="py-2.5 px-3 whitespace-nowrap text-slate-700 dark:text-slate-300">
                              {work.type === 'gallery'
                                ? `图文 (${work.imageUrls.length} 张)`
                                : '无水印视频'}
                            </td>
                            <td className="py-2.5 px-3 whitespace-nowrap text-right font-mono tabular-nums text-slate-500 dark:text-slate-400">
                              {work.publishDate}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </div>

        <section className="xl:col-span-5 bg-white dark:bg-[#111622] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-5">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              抓取参数与抖音 Cookie
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              单条视频/图文可免登录直接解析；抓取博主主页全部作品与合集请先填入浏览器 Cookie。
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="inline-cookie-textarea"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-800 dark:text-slate-200"
              >
                <KeyRound className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400" aria-hidden="true" />
                抖音 Cookie（抓取博主完整主页必填）
              </label>
              <span className="text-[11px] text-slate-500 dark:text-slate-400">
                {settings.cookieString.trim() ? '已配置' : hasUserOrCollectionLink ? '建议填写' : '可选'}
              </span>
            </div>
            <textarea
              ref={cookieInputRef}
              id="inline-cookie-textarea"
              rows={2}
              value={settings.cookieString}
              onChange={(e) =>
                onChangeSettings({ ...settings, cookieString: e.target.value })
              }
              placeholder="登录 douyin.com 后按 F12 → Network → 复制任意请求头中的 Cookie 粘贴到此处"
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-[#0B0F17] px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-rose-500 focus:outline-none"
            />
          </div>

          <div className="space-y-2 border-t border-slate-200 dark:border-slate-800 pt-4">
            <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              主页抓取模式（可多选）
            </span>
            <div className="flex flex-wrap gap-1.5">
              {MODE_OPTIONS.map((mode) => {
                const active = settings.modes.includes(mode.id);
                return (
                  <button
                    key={mode.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleMode(mode.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      active
                        ? 'bg-slate-900 text-white dark:bg-rose-600 dark:text-white'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                    }`}
                  >
                    {mode.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label
                htmlFor="video-quality-select"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                视频画质偏好
              </label>
              <select
                id="video-quality-select"
                value={settings.videoQuality}
                onChange={(e) =>
                  onChangeSettings({
                    ...settings,
                    videoQuality: e.target.value as VideoQuality,
                  })
                }
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:border-rose-500 focus:outline-none"
              >
                {QUALITY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="max-items-input"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                单模式上限（0 = 全部）
              </label>
              <input
                id="max-items-input"
                type="number"
                min={0}
                max={1000}
                value={settings.maxItemsPerMode}
                onChange={(e) =>
                  onChangeSettings({
                    ...settings,
                    maxItemsPerMode: Math.max(0, Number(e.target.value) || 0),
                  })
                }
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-xs font-mono tabular-nums text-slate-900 dark:text-slate-100 focus:border-rose-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label
                htmlFor="start-date-input"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                起始发布日期（可选）
              </label>
              <input
                id="start-date-input"
                type="date"
                value={settings.startDate}
                onChange={(e) =>
                  onChangeSettings({ ...settings, startDate: e.target.value })
                }
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100 focus:border-rose-500 focus:outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="end-date-input"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                截止发布日期（含当天）
              </label>
              <input
                id="end-date-input"
                type="date"
                value={settings.endDate}
                onChange={(e) =>
                  onChangeSettings({ ...settings, endDate: e.target.value })
                }
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100 focus:border-rose-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <label
                htmlFor="concurrency-range"
                className="font-medium text-slate-700 dark:text-slate-300"
              >
                并发下载线程数
              </label>
              <span className="font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                {settings.concurrency} 线程
              </span>
            </div>
            <input
              id="concurrency-range"
              type="range"
              min={1}
              max={12}
              value={settings.concurrency}
              onChange={(e) =>
                onChangeSettings({
                  ...settings,
                  concurrency: Number(e.target.value),
                })
              }
              className="w-full accent-rose-600 cursor-pointer"
            />
          </div>

          <div className="border-t border-slate-200 dark:border-slate-800 pt-4 space-y-2.5">
            <label className="flex items-center justify-between gap-3 cursor-pointer">
              <span className="text-xs text-slate-700 dark:text-slate-300">
                启用增量下载（自动跳过本地已完整下载的作品）
              </span>
              <input
                type="checkbox"
                checked={settings.incremental}
                onChange={(e) =>
                  onChangeSettings({ ...settings, incremental: e.target.checked })
                }
                className="w-4 h-4 rounded accent-rose-600"
              />
            </label>
            <label className="flex items-center justify-between gap-3 cursor-pointer">
              <span className="text-xs text-slate-700 dark:text-slate-300">
                磁盘主文件缺失时自动重新下载
              </span>
              <input
                type="checkbox"
                checked={settings.redownloadMissingFiles}
                onChange={(e) =>
                  onChangeSettings({
                    ...settings,
                    redownloadMissingFiles: e.target.checked,
                  })
                }
                className="w-4 h-4 rounded accent-rose-600"
              />
            </label>
          </div>

          <div className="border-t border-slate-200 dark:border-slate-800 pt-4 space-y-2">
            <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              实际落盘产物
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs text-slate-700 dark:text-slate-300">
              {(
                [
                  ['includeVideo', '视频 / 图集原图'],
                  ['includeCover', '高清封面'],
                  ['includeMusic', '背景音乐'],
                  ['includeAvatar', '作者头像'],
                  ['includeJson', '元数据 JSON'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 cursor-pointer py-1">
                  <input
                    type="checkbox"
                    checked={settings[key]}
                    onChange={(e) =>
                      onChangeSettings({ ...settings, [key]: e.target.checked })
                    }
                    className="w-3.5 h-3.5 rounded accent-rose-600"
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="pt-2 space-y-2.5">
            <button
              type="button"
              disabled={
                submitting ||
                discovering ||
                (discoveredWorks.length > 0
                  ? selectedWorks.length === 0
                  : supportedLinks.length === 0)
              }
              onClick={handleStartDownload}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold text-white bg-rose-600 hover:bg-rose-700 disabled:bg-slate-300 dark:disabled:bg-slate-700 disabled:text-slate-500 dark:disabled:text-slate-400 transition-colors whitespace-nowrap"
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="w-4 h-4" aria-hidden="true" />
              )}
              <span>
                {discoveredWorks.length > 0
                  ? `开始真实下载已选作品（${selectedWorks.length} 个）`
                  : supportedLinks.length > 0
                    ? `直接解析并批量下载（${supportedLinks.length} 条链接）`
                    : '请先输入抖音链接'}
              </span>
            </button>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleExportYaml}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
              >
                <FileCode2 className="w-3.5 h-3.5" aria-hidden="true" />
                导出 config.yml
              </button>
              <button
                type="button"
                onClick={handleCopyCli}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
              >
                {copiedCli ? (
                  <Check className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
                ) : (
                  <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                {copiedCli ? '已复制命令' : '复制 CLI 命令'}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
