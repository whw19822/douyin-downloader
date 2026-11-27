import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Menu, X } from 'lucide-react';
import {
  cancelJobApi,
  createBatchJobApi,
  deleteArchiveItemApi,
  deleteJobApi,
  getPreferencesApi,
  getSettingsApi,
  listArchiveApi,
  listJobsApi,
  retryJobApi,
  toggleArchiveFileApi,
  updatePreferencesApi,
  updateSettingsApi,
} from './lib/api';
import { generateConfigYaml } from './lib/batchRules';
import { parseBatchInput } from './lib/urlParser';
import {
  DEFAULT_BATCH_SETTINGS,
  type ArchiveItem,
  type BatchJob,
  type BatchSettings,
} from './lib/types';
import { ArchiveView } from './components/ArchiveView';
import { BatchDownloaderView } from './components/BatchDownloaderView';
import { HotAndSettingsView } from './components/HotAndSettingsView';
import { Sidebar, type WorkspaceTab } from './components/Sidebar';
import { TaskQueueView } from './components/TaskQueueView';

const TAB_TITLES: Record<WorkspaceTab, string> = {
  batch: '批量下载',
  queue: '任务队列',
  archive: '已存档案',
  settings: '热点与配置',
};

export function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('batch');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('douyin_studio_theme') === 'dark';
    } catch {
      return false;
    }
  });

  const [rawInput, setRawInput] = useState('');
  const [settings, setSettings] = useState<BatchSettings>(DEFAULT_BATCH_SETTINGS);
  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const [archive, setArchive] = useState<ArchiveItem[]>([]);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const settingsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSettingsRef = useRef<BatchSettings | null>(null);
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDraftRef = useRef<string | null>(null);

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
  }, []);

  const flushPendingPersistence = useCallback(() => {
    if (settingsSaveTimerRef.current) {
      clearTimeout(settingsSaveTimerRef.current);
      settingsSaveTimerRef.current = null;
    }
    if (pendingSettingsRef.current) {
      const payload = pendingSettingsRef.current;
      pendingSettingsRef.current = null;
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon('/api/settings', blob);
      } else {
        void fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch(() => undefined);
      }
    }

    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    }
    if (pendingDraftRef.current !== null) {
      const draftInput = pendingDraftRef.current;
      pendingDraftRef.current = null;
      const blob = new Blob([JSON.stringify({ draftInput })], {
        type: 'application/json',
      });
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon('/api/preferences', blob);
      } else {
        void fetch('/api/preferences', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draftInput }),
          keepalive: true,
        }).catch(() => undefined);
      }
    }
  }, []);

  useEffect(() => {
    const onUnload = () => flushPendingPersistence();
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
      flushPendingPersistence();
    };
  }, [flushPendingPersistence]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      window.localStorage.setItem('douyin_studio_theme', darkMode ? 'dark' : 'light');
    } catch {
      // ignore storage errors
    }
  }, [darkMode]);

  const refreshData = useCallback(async () => {
    const [jobsRes, archiveRes] = await Promise.all([listJobsApi(), listArchiveApi()]);
    setJobs(jobsRes.jobs);
    setArchive(archiveRes.items);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [settingsRes, jobsRes, archiveRes, prefsRes] = await Promise.all([
          getSettingsApi(),
          listJobsApi(),
          listArchiveApi(),
          getPreferencesApi().catch(() => null),
        ]);
        if (!active) return;
        setSettings(settingsRes.settings);
        setJobs(jobsRes.jobs);
        setArchive(archiveRes.items);
        if (prefsRes?.preferences) {
          setDarkMode(prefsRes.preferences.theme === 'dark');
          if (prefsRes.preferences.draftInput) {
            setRawInput((prev) => (prev ? prev : prefsRes.preferences.draftInput));
          }
        }
      } catch (err) {
        if (active) {
          showNotice(err instanceof Error ? err.message : '初始化数据加载失败');
        }
      } finally {
        if (active) setLoadingInitial(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [showNotice]);

  const hasActiveJobs = useMemo(
    () => jobs.some((j) => j.status === 'pending' || j.status === 'running'),
    [jobs],
  );

  useEffect(() => {
    if (!hasActiveJobs) return;
    const interval = setInterval(() => {
      void refreshData();
    }, 550);
    return () => clearInterval(interval);
  }, [hasActiveJobs, refreshData]);

  const activeJobCount = useMemo(
    () => jobs.filter((j) => j.status === 'pending' || j.status === 'running').length,
    [jobs],
  );

  const handleSubmitBatch = async (payload: {
    urls?: string[];
    works?: import('./lib/types').DiscoveredWork[];
  }) => {
    if (settingsSaveTimerRef.current) {
      clearTimeout(settingsSaveTimerRef.current);
      settingsSaveTimerRef.current = null;
    }
    pendingSettingsRef.current = null;
    setSubmitting(true);
    try {
      const { job } = await createBatchJobApi(payload, settings);
      setJobs((prev) => [job, ...prev]);
      setActiveTab('queue');
      if (job.total > 0) {
        showNotice(`已启动真实下载任务（共 ${job.total} 个作品，正在从抖音 CDN 落盘）`);
      } else if (job.warnings && job.warnings.length > 0) {
        showNotice(job.warnings[0]);
      } else {
        showNotice('未解析到可下载作品，请查看任务队列说明');
      }
    } catch (err) {
      showNotice(err instanceof Error ? err.message : '创建任务失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelJob = async (jobId: string) => {
    try {
      const { job } = await cancelJobApi(jobId);
      setJobs((prev) => prev.map((j) => (j.jobId === jobId ? job : j)));
      showNotice('已取消该批量任务');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : '取消失败');
    }
  };

  const handleRetryJob = async (jobId: string) => {
    try {
      const { job } = await retryJobApi(jobId);
      setJobs((prev) => prev.map((j) => (j.jobId === jobId ? job : j)));
      showNotice('已将失败项重新加入并发队列');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : '重试失败');
    }
  };

  const handleDeleteJob = async (jobId: string) => {
    try {
      await deleteJobApi(jobId);
      setJobs((prev) => prev.filter((j) => j.jobId !== jobId));
      showNotice('已移除任务记录');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : '删除失败');
    }
  };

  const handleDeleteArchive = async (awemeId: string) => {
    try {
      await deleteArchiveItemApi(awemeId);
      setArchive((prev) => prev.filter((i) => i.awemeId !== awemeId));
      showNotice('已移除档案记录（下次增量下载将重新抓取该作品）');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : '移除失败');
    }
  };

  const handleToggleArchiveFile = async (awemeId: string) => {
    try {
      const { item } = await toggleArchiveFileApi(awemeId);
      setArchive((prev) => prev.map((i) => (i.awemeId === awemeId ? item : i)));
      showNotice(
        item.filePresent
          ? '已标记磁盘文件完整（增量模式将跳过）'
          : '已标记磁盘文件缺失（启用缺失补下后将自动重下）',
      );
    } catch (err) {
      showNotice(err instanceof Error ? err.message : '状态切换失败');
    }
  };

  const handleSaveSettings = async (next: BatchSettings) => {
    if (settingsSaveTimerRef.current) {
      clearTimeout(settingsSaveTimerRef.current);
      settingsSaveTimerRef.current = null;
    }
    pendingSettingsRef.current = null;
    const res = await updateSettingsApi(next);
    setSettings(res.settings);
  };

  const handleInlineSettingsChange = useCallback((next: BatchSettings) => {
    setSettings(next);
    pendingSettingsRef.current = next;
    if (settingsSaveTimerRef.current) {
      clearTimeout(settingsSaveTimerRef.current);
    }
    settingsSaveTimerRef.current = setTimeout(() => {
      const toPersist = pendingSettingsRef.current;
      settingsSaveTimerRef.current = null;
      pendingSettingsRef.current = null;
      if (!toPersist) return;
      void updateSettingsApi(toPersist).catch(() => undefined);
    }, 350);
  }, []);

  const handleRawInputChange = useCallback((nextValue: string) => {
    setRawInput(nextValue);
    pendingDraftRef.current = nextValue;
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current);
    }
    draftSaveTimerRef.current = setTimeout(() => {
      const toPersist = pendingDraftRef.current;
      draftSaveTimerRef.current = null;
      pendingDraftRef.current = null;
      if (toPersist === null) return;
      void updatePreferencesApi({ draftInput: toPersist }).catch(() => undefined);
    }, 500);
  }, []);

  const handleToggleTheme = useCallback(() => {
    setDarkMode((prev) => {
      const next = !prev;
      void updatePreferencesApi({ theme: next ? 'dark' : 'light' }).catch(() => undefined);
      return next;
    });
  }, []);

  const activeSupportedUrls = useMemo(
    () =>
      parseBatchInput(rawInput)
        .links.filter((l) => l.supported)
        .map((l) => l.resolvedUrl || l.originalUrl),
    [rawInput],
  );

  const handleQuickExportYaml = () => {
    const yaml = generateConfigYaml(activeSupportedUrls, settings);
    const blob = new Blob([yaml], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'config.yml';
    a.click();
    URL.revokeObjectURL(url);
    showNotice('已导出当前全局配置 config.yml');
  };

  return (
    <div className="min-h-screen flex bg-[#F8F9FA] text-[#111827] dark:bg-[#0B0F17] dark:text-[#F3F4F6]">
      <Sidebar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        activeJobCount={activeJobCount}
        totalJobCount={jobs.length}
        archiveCount={archive.length}
        darkMode={darkMode}
        onToggleTheme={handleToggleTheme}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-30 h-14 bg-white/95 dark:bg-[#111622]/95 backdrop-blur border-b border-slate-200 dark:border-slate-800 px-4 sm:px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="打开导航菜单"
              className="lg:hidden p-1.5 -ml-1 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <Menu className="w-5 h-5" aria-hidden="true" />
            </button>
            <nav aria-label="面包屑导航" className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-slate-400 dark:text-slate-500 whitespace-nowrap">
                工作台
              </span>
              <span aria-hidden="true" className="text-slate-300 dark:text-slate-600">
                /
              </span>
              <span className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                {TAB_TITLES[activeTab]}
              </span>
            </nav>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={handleQuickExportYaml}
              className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              导出 config.yml
            </button>
          </div>
        </header>

        {notice && (
          <div
            role="status"
            aria-live="polite"
            className="mx-4 sm:mx-6 mt-4 px-4 py-2.5 rounded-lg bg-slate-900 text-white dark:bg-slate-800 dark:text-slate-100 text-xs flex items-center justify-between gap-3"
          >
            <span>{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="关闭提示"
              className="p-0.5 rounded hover:bg-white/10"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        )}

        <main className="flex-1 w-full max-w-[1280px] mx-auto px-4 sm:px-6 py-6">
          {activeTab === 'batch' && (
            <BatchDownloaderView
              rawInput={rawInput}
              onChangeRawInput={handleRawInputChange}
              settings={settings}
              onChangeSettings={handleInlineSettingsChange}
              onSubmitBatch={handleSubmitBatch}
              submitting={submitting}
              onNotify={showNotice}
            />
          )}

          {activeTab === 'queue' && (
            <TaskQueueView
              jobs={jobs}
              loading={loadingInitial}
              onCancelJob={handleCancelJob}
              onRetryJob={handleRetryJob}
              onDeleteJob={handleDeleteJob}
              onGoToBatch={() => setActiveTab('batch')}
              onNotify={showNotice}
            />
          )}

          {activeTab === 'archive' && (
            <ArchiveView
              items={archive}
              loading={loadingInitial}
              onDeleteItem={handleDeleteArchive}
              onToggleFilePresent={handleToggleArchiveFile}
              onRedownloadUrl={(url) => {
                const next = rawInput.trim() ? `${rawInput.trim()}\n${url}` : url;
                handleRawInputChange(next);
                setActiveTab('batch');
                showNotice('已将作品链接回填至批量下载输入框');
              }}
              onGoToBatch={() => setActiveTab('batch')}
            />
          )}

          {activeTab === 'settings' && (
            <HotAndSettingsView
              settings={settings}
              activeLinks={activeSupportedUrls}
              onSaveSettings={handleSaveSettings}
              onAddSearchTopic={async (topic) => {
                try {
                  await navigator.clipboard.writeText(topic);
                  showNotice(`已复制热搜词「${topic}」，可直接用于抖音搜索或 CLI --search`);
                } catch {
                  showNotice(`热搜词：${topic}`);
                }
              }}
              onNotify={showNotice}
            />
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
