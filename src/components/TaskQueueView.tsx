import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  ChevronRight,
  Download,
  FileCode2,
  RotateCcw,
  Search,
  Square,
  Trash2,
} from 'lucide-react';
import { formatBytes } from '../lib/batchRules';
import type { BatchJob, JobItemStatus, JobStatus } from '../lib/types';

interface TaskQueueViewProps {
  jobs: BatchJob[];
  loading: boolean;
  onCancelJob: (jobId: string) => Promise<void>;
  onRetryJob: (jobId: string) => Promise<void>;
  onDeleteJob: (jobId: string) => Promise<void>;
  onGoToBatch: () => void;
  onNotify: (msg: string) => void;
}

type FilterStatus = 'all' | 'active' | 'success' | 'attention';

const JOB_STATUS_META: Record<JobStatus, { label: string; color: string }> = {
  pending: { label: '排队中', color: 'text-slate-600 dark:text-slate-400' },
  running: { label: '并发下载中', color: 'text-rose-600 dark:text-rose-400' },
  success: { label: '全部完成', color: 'text-emerald-700 dark:text-emerald-400' },
  partial: { label: '部分完成', color: 'text-amber-700 dark:text-amber-400' },
  failed: { label: '任务失败', color: 'text-red-600 dark:text-red-400' },
  cancelled: { label: '已取消', color: 'text-slate-500 dark:text-slate-400' },
};

const ITEM_STATUS_META: Record<JobItemStatus, { label: string; color: string }> = {
  pending: { label: '等待中', color: 'text-slate-500 dark:text-slate-400' },
  running: { label: '下载中', color: 'text-rose-600 dark:text-rose-400' },
  success: { label: '已落盘', color: 'text-emerald-700 dark:text-emerald-400' },
  skipped: { label: '增量跳过', color: 'text-amber-700 dark:text-amber-400' },
  failed: { label: '失败', color: 'text-red-600 dark:text-red-400' },
  cancelled: { label: '已取消', color: 'text-slate-500 dark:text-slate-400' },
};

export function TaskQueueView({
  jobs,
  loading,
  onCancelJob,
  onRetryJob,
  onDeleteJob,
  onGoToBatch,
  onNotify,
}: TaskQueueViewProps) {
  const [filter, setFilter] = useState<FilterStatus>('all');
  const [query, setQuery] = useState('');
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});

  const toggleExpanded = (jobId: string) => {
    setExpandedIds((prev) => ({ ...prev, [jobId]: !prev[jobId] }));
  };

  const totals = useMemo(() => {
    return jobs.reduce(
      (acc, job) => {
        acc.items += job.total;
        acc.success += job.success;
        acc.skipped += job.skipped;
        acc.failed += job.failed;
        return acc;
      },
      { items: 0, success: 0, skipped: 0, failed: 0 },
    );
  }, [jobs]);

  const filteredJobs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs.filter((job) => {
      if (filter === 'active' && job.status !== 'running' && job.status !== 'pending') {
        return false;
      }
      if (filter === 'success' && job.status !== 'success') {
        return false;
      }
      if (
        filter === 'attention' &&
        job.status !== 'failed' &&
        job.status !== 'partial' &&
        job.status !== 'cancelled'
      ) {
        return false;
      }
      if (!q) return true;
      return (
        job.label.toLowerCase().includes(q) ||
        job.jobId.toLowerCase().includes(q) ||
        job.items.some(
          (i) =>
            i.title.toLowerCase().includes(q) ||
            i.author.toLowerCase().includes(q) ||
            i.awemeId.includes(q),
        )
      );
    });
  }, [jobs, filter, query]);

  const handleExport = (jobId: string, format: 'yaml' | 'jsonl') => {
    const link = document.createElement('a');
    link.href = `/api/jobs/${encodeURIComponent(jobId)}/export?format=${format}`;
    link.download = format === 'yaml' ? `config-${jobId}.yml` : `manifest-${jobId}.jsonl`;
    link.click();
    onNotify(format === 'yaml' ? '已导出该任务 config.yml' : '已导出该任务 JSONL 明细');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            并发下载队列与文件保存
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            真实从抖音 CDN 下载视频 MP4 与无水印图集原图至服务端目录，完成后可直接点击「打包下载 ZIP」或逐条保存到本机。
          </p>
        </div>
        <button
          type="button"
          onClick={onGoToBatch}
          className="px-4 py-2 rounded-lg text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 transition-colors whitespace-nowrap shrink-0"
        >
          新建批量任务
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 bg-white dark:bg-[#111622] border border-slate-200 dark:border-slate-800 rounded-xl divide-y lg:divide-y-0 lg:divide-x divide-slate-200 dark:divide-slate-800">
        <div className="px-5 py-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">累计调度作品</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {totals.items}
          </div>
        </div>
        <div className="px-5 py-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">真实下载成功</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
            {totals.success}
          </div>
        </div>
        <div className="px-5 py-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">增量去重跳过</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-amber-700 dark:text-amber-400">
            {totals.skipped}
          </div>
        </div>
        <div className="px-5 py-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">失败 / 已取消</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-red-600 dark:text-red-400">
            {totals.failed}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label="按任务状态筛选"
          className="inline-flex items-center gap-1 p-1 bg-slate-200/70 dark:bg-slate-800/80 rounded-lg"
        >
          {(
            [
              ['all', '全部任务'],
              ['active', '进行中'],
              ['success', '已完成'],
              ['attention', '部分 / 失败'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              onClick={() => setFilter(key)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                filter === key
                  ? 'bg-white dark:bg-[#111622] text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-64">
          <Search
            className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索任务标题、作者或作品 ID"
            placeholder="搜索任务、作者或作品 ID..."
            className="w-full pl-9 pr-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#111622] text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-rose-500 focus:outline-none"
          />
        </div>
      </div>

      {loading ? (
        <div className="bg-white dark:bg-[#111622] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          {[1, 2].map((n) => (
            <div key={n} className="h-16 rounded-lg bg-slate-100 dark:bg-slate-800/60 animate-pulse" />
          ))}
        </div>
      ) : filteredJobs.length === 0 ? (
        <div className="bg-white dark:bg-[#111622] border border-slate-200 dark:border-slate-800 rounded-xl py-14 px-6 text-center">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
            暂无真实下载任务
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            前往批量下载页粘贴抖音视频、图文或博主主页链接，解析后即可下载真实媒体文件到本地。
          </p>
          <button
            type="button"
            onClick={onGoToBatch}
            className="mt-4 px-4 py-2 rounded-lg text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 transition-colors"
          >
            前往批量下载
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredJobs.map((job, idx) => {
            const expanded = expandedIds[job.jobId] ?? idx === 0;
            const statusMeta = JOB_STATUS_META[job.status];
            const isActive = job.status === 'pending' || job.status === 'running';
            const hasRetryable = job.items.some(
              (i) => i.status === 'failed' || i.status === 'cancelled',
            );

            return (
              <article
                key={job.jobId}
                className="bg-white dark:bg-[#111622] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden"
              >
                <div className="px-5 py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => toggleExpanded(job.jobId)}
                        aria-expanded={expanded}
                        aria-label={`${expanded ? '收起' : '展开'}任务 ${job.label} 的明细`}
                        className="p-1 -ml-1 rounded text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
                      >
                        {expanded ? (
                          <ChevronDown className="w-4 h-4" aria-hidden="true" />
                        ) : (
                          <ChevronRight className="w-4 h-4" aria-hidden="true" />
                        )}
                      </button>
                      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                        {job.label}
                      </h2>
                      <span className={`text-xs font-semibold whitespace-nowrap ${statusMeta.color}`}>
                        {statusMeta.label}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400 pl-6 tabular-nums">
                      <span className="font-mono">{job.jobId}</span>
                      <span aria-hidden="true">·</span>
                      <span>画质 {job.settingsSnapshot.videoQuality}</span>
                      <span aria-hidden="true">·</span>
                      <span>并发 {job.settingsSnapshot.concurrency} 线程</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        已落盘 {job.success} / 跳过 {job.skipped} / 失败 {job.failed}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 pl-6 lg:pl-0 shrink-0">
                    <div className="w-24 flex items-center gap-2 mr-1">
                      <div className="flex-1 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                        <div
                          className={`h-full transition-all duration-200 ${
                            job.status === 'failed'
                              ? 'bg-red-600'
                              : job.status === 'success'
                                ? 'bg-emerald-600'
                                : 'bg-rose-600'
                          }`}
                          style={{ width: `${job.progressPercent}%` }}
                        />
                      </div>
                      <span className="font-mono text-xs tabular-nums text-slate-600 dark:text-slate-300 w-8 text-right">
                        {job.progressPercent}%
                      </span>
                    </div>

                    {job.downloadableCount > 0 && (
                      <a
                        href={`/api/files/job/${encodeURIComponent(job.jobId)}/zip`}
                        download={`douyin-batch-${job.jobId}.zip`}
                        onClick={() => onNotify('正在打包生成 ZIP 并开始浏览器下载...')}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 transition-colors whitespace-nowrap"
                      >
                        <Archive className="w-3.5 h-3.5" aria-hidden="true" />
                        打包下载全部 ({job.downloadableCount}) .zip
                      </a>
                    )}

                    {isActive && (
                      <button
                        type="button"
                        onClick={() => onCancelJob(job.jobId)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800/80 hover:bg-amber-50 dark:hover:bg-amber-950/40 whitespace-nowrap"
                      >
                        <Square className="w-3 h-3" aria-hidden="true" />
                        取消
                      </button>
                    )}

                    {hasRetryable && (
                      <button
                        type="button"
                        onClick={() => onRetryJob(job.jobId)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800/80 hover:bg-rose-50 dark:hover:bg-rose-950/40 whitespace-nowrap"
                      >
                        <RotateCcw className="w-3 h-3" aria-hidden="true" />
                        重试失败项
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => handleExport(job.jobId, 'yaml')}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                    >
                      <FileCode2 className="w-3 h-3" aria-hidden="true" />
                      YAML
                    </button>

                    <button
                      type="button"
                      onClick={() => handleExport(job.jobId, 'jsonl')}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                    >
                      <Download className="w-3 h-3" aria-hidden="true" />
                      JSONL
                    </button>

                    <button
                      type="button"
                      onClick={() => onDeleteJob(job.jobId)}
                      aria-label={`删除任务 ${job.jobId}`}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>

                {job.warnings && job.warnings.length > 0 && (
                  <div className="mx-5 mb-4 rounded-lg border border-amber-200 dark:border-amber-800/80 bg-amber-50/70 dark:bg-amber-950/30 p-3 space-y-1.5">
                    {job.warnings.map((w, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs text-amber-900 dark:text-amber-200">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                        <span>{w}</span>
                      </div>
                    ))}
                  </div>
                )}

                {expanded && job.items.length > 0 && (
                  <div className="border-t border-slate-200 dark:border-slate-800 overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-slate-50/80 dark:bg-[#0D121D] border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                          <th className="py-2.5 px-5 font-medium">作品标题与落盘文件</th>
                          <th className="py-2.5 px-3 font-medium">作者 / 类型</th>
                          <th className="py-2.5 px-3 font-medium text-right">实际大小</th>
                          <th className="py-2.5 px-3 font-medium">状态与说明</th>
                          <th className="py-2.5 px-5 font-medium text-right">下载 / 进度</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70 text-xs">
                        {job.items.map((item) => {
                          const itemMeta = ITEM_STATUS_META[item.status];
                          return (
                            <tr
                              key={item.itemId}
                              className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30"
                            >
                              <td className="py-2.5 px-5 max-w-[320px]">
                                <div className="font-medium text-slate-900 dark:text-slate-100 truncate">
                                  {item.title}
                                </div>
                                <div className="font-mono text-[11px] text-slate-400 dark:text-slate-500 truncate mt-0.5">
                                  {item.filename}
                                  {item.savedFiles.length > 0 &&
                                    ` · ${item.savedFiles.length} 个文件`}
                                </div>
                              </td>
                              <td className="py-2.5 px-3 whitespace-nowrap text-slate-600 dark:text-slate-300">
                                <span>{item.author}</span>
                                <span className="mx-1.5 text-slate-300 dark:text-slate-600">·</span>
                                <span className="text-slate-500 dark:text-slate-400">
                                  {item.type === 'gallery'
                                    ? `图文(${item.imageUrls?.length || 0}图)`
                                    : '视频'}
                                </span>
                              </td>
                              <td className="py-2.5 px-3 whitespace-nowrap text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                                {item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : '—'}
                              </td>
                              <td className="py-2.5 px-3 max-w-[260px]">
                                <div className={`font-medium ${itemMeta.color}`}>
                                  {itemMeta.label}
                                  {item.retries > 0 && `（已重试 ${item.retries} 次）`}
                                </div>
                                <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                                  {item.message}
                                </div>
                              </td>
                              <td className="py-2.5 px-5 whitespace-nowrap text-right">
                                {item.downloadReady ? (
                                  <a
                                    href={`/api/files/item/${encodeURIComponent(job.jobId)}/${encodeURIComponent(item.itemId)}`}
                                    download
                                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-rose-700 dark:text-rose-300 bg-rose-50 hover:bg-rose-100 dark:bg-rose-500/15 dark:hover:bg-rose-500/25 transition-colors"
                                  >
                                    <Download className="w-3 h-3" aria-hidden="true" />
                                    保存文件
                                  </a>
                                ) : (
                                  <span className="font-mono tabular-nums text-slate-600 dark:text-slate-300">
                                    {item.progress}%
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
