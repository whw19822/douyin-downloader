import { useMemo, useState } from 'react';
import {
  Download,
  FileCheck2,
  FileWarning,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import { formatBytes } from '../lib/batchRules';
import { URL_TYPE_LABELS } from '../lib/urlParser';
import type { ArchiveItem, DouyinUrlType } from '../lib/types';

interface ArchiveViewProps {
  items: ArchiveItem[];
  loading: boolean;
  onDeleteItem: (awemeId: string) => Promise<void>;
  onToggleFilePresent: (awemeId: string) => Promise<void>;
  onRedownloadUrl: (url: string) => void;
  onGoToBatch: () => void;
}

type TypeFilter = 'all' | 'video' | 'gallery' | 'collection' | 'music';

export function ArchiveView({
  items,
  loading,
  onDeleteItem,
  onToggleFilePresent,
  onRedownloadUrl,
  onGoToBatch,
}: ArchiveViewProps) {
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (typeFilter !== 'all' && item.type !== typeFilter) return false;
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.author.toLowerCase().includes(q) ||
        item.awemeId.includes(q) ||
        item.filename.toLowerCase().includes(q)
      );
    });
  }, [items, query, typeFilter]);

  const totalBytes = useMemo(
    () => items.reduce((sum, item) => sum + item.sizeBytes, 0),
    [items],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            已存作品档案
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            增量下载会自动核对此处的作品 ID 与磁盘主文件完整性，避免重复消耗流量与带宽。
          </p>
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
          共 {items.length} 条记录 · 合计 {formatBytes(totalBytes)}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label="按作品类型筛选档案"
          className="inline-flex items-center gap-1 p-1 bg-slate-200/70 dark:bg-slate-800/80 rounded-lg overflow-x-auto"
        >
          {(
            [
              ['all', '全部'],
              ['video', '单条视频'],
              ['gallery', '图文作品'],
              ['collection', '作品合集'],
              ['music', '音乐原声'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={typeFilter === key}
              onClick={() => setTypeFilter(key)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                typeFilter === key
                  ? 'bg-white dark:bg-[#111622] text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-72">
          <Search
            className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="按标题、作者或作品 ID 检索档案"
            placeholder="检索标题、作者、文件名或作品 ID..."
            className="w-full pl-9 pr-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#111622] text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-rose-500 focus:outline-none"
          />
        </div>
      </div>

      <section className="bg-white dark:bg-[#111622] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map((n) => (
              <div key={n} className="h-11 rounded bg-slate-100 dark:bg-slate-800/60 animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-14 px-6 text-center">
            <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
              {items.length === 0 ? '档案库为空' : '未找到匹配的已存作品'}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              {items.length === 0
                ? '完成任意批量下载任务后，作品元数据与去重索引会自动记录在此。'
                : '请尝试清空搜索关键字或切换类型筛选。'}
            </p>
            {items.length === 0 && (
              <button
                type="button"
                onClick={onGoToBatch}
                className="mt-4 px-4 py-2 rounded-lg text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 transition-colors"
              >
                去添加下载任务
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50/80 dark:bg-[#0D121D] border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-5 font-medium">作品与命名落盘</th>
                  <th className="py-3 px-3 font-medium">作者 / 类型</th>
                  <th className="py-3 px-3 font-medium">磁盘校验</th>
                  <th className="py-3 px-3 font-medium text-right">发布日期</th>
                  <th className="py-3 px-3 font-medium text-right">体积</th>
                  <th className="py-3 px-5 font-medium text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70 text-xs">
                {filtered.map((item) => (
                  <tr
                    key={item.awemeId}
                    className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30"
                  >
                    <td className="py-3 px-5 max-w-[360px]">
                      <div className="font-medium text-slate-900 dark:text-slate-100 truncate">
                        {item.title}
                      </div>
                      <div className="font-mono text-[11px] text-slate-400 dark:text-slate-500 truncate mt-0.5">
                        {item.filename} · {item.artifacts.join(' / ')}
                      </div>
                    </td>
                    <td className="py-3 px-3 whitespace-nowrap text-slate-600 dark:text-slate-300">
                      <span>{item.author}</span>
                      <span className="mx-1.5 text-slate-300 dark:text-slate-600">·</span>
                      <span className="text-slate-500 dark:text-slate-400">
                        {URL_TYPE_LABELS[item.type as DouyinUrlType] || item.type}
                      </span>
                    </td>
                    <td className="py-3 px-3 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => onToggleFilePresent(item.awemeId)}
                        title="点击切换磁盘文件状态以测试增量补下逻辑"
                        className={`inline-flex items-center gap-1.5 font-medium hover:underline underline-offset-4 ${
                          item.filePresent
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-amber-700 dark:text-amber-400'
                        }`}
                      >
                        {item.filePresent ? (
                          <FileCheck2 className="w-3.5 h-3.5" aria-hidden="true" />
                        ) : (
                          <FileWarning className="w-3.5 h-3.5" aria-hidden="true" />
                        )}
                        <span>{item.filePresent ? '文件完整' : '缺失待补下'}</span>
                      </button>
                    </td>
                    <td className="py-3 px-3 whitespace-nowrap text-right font-mono tabular-nums text-slate-500 dark:text-slate-400">
                      {item.publishDate}
                    </td>
                    <td className="py-3 px-3 whitespace-nowrap text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                      {formatBytes(item.sizeBytes)}
                    </td>
                    <td className="py-3 px-5 whitespace-nowrap text-right">
                      <div className="inline-flex items-center gap-1.5">
                        {item.filePresent && (
                          <a
                            href={`/api/files/archive/${encodeURIComponent(item.awemeId)}`}
                            download
                            aria-label={`保存文件 ${item.title}`}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded text-rose-600 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/30 font-medium transition-colors"
                          >
                            <Download className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>保存文件</span>
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => onRedownloadUrl(item.sourceUrl)}
                          aria-label={`重新下载 ${item.title}`}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded text-slate-600 hover:text-rose-600 dark:text-slate-400 dark:hover:text-rose-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                        >
                          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>回填队列</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteItem(item.awemeId)}
                          aria-label={`移除档案 ${item.title}`}
                          className="p-1.5 rounded text-slate-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
