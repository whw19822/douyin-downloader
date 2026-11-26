import {
  Archive,
  Download,
  Flame,
  ListChecks,
  Moon,
  Sun,
  X,
} from 'lucide-react';

export type WorkspaceTab = 'batch' | 'queue' | 'archive' | 'settings';

interface SidebarProps {
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  activeJobCount: number;
  totalJobCount: number;
  archiveCount: number;
  darkMode: boolean;
  onToggleTheme: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const NAV_ITEMS: Array<{
  id: WorkspaceTab;
  label: string;
  icon: typeof Download;
}> = [
  { id: 'batch', label: '批量下载', icon: Download },
  { id: 'queue', label: '任务队列', icon: ListChecks },
  { id: 'archive', label: '已存档案', icon: Archive },
  { id: 'settings', label: '热点与配置', icon: Flame },
];

export function Sidebar({
  activeTab,
  onSelectTab,
  activeJobCount,
  totalJobCount,
  archiveCount,
  darkMode,
  onToggleTheme,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const navContent = (
    <div className="flex h-full flex-col bg-white dark:bg-[#111622] border-r border-slate-200 dark:border-slate-800">
      <div className="flex items-center justify-between h-14 px-5 border-b border-slate-200 dark:border-slate-800 shrink-0">
        <span className="font-display text-base font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap">
          抖存批量工作台
        </span>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="关闭导航菜单"
          className="lg:hidden p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-rose-600"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <nav aria-label="主工作区导航" className="flex-1 px-3 py-4 space-y-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          let countText = '';
          if (item.id === 'queue') {
            countText = activeJobCount > 0 ? `${activeJobCount} 运行中` : String(totalJobCount);
          } else if (item.id === 'archive') {
            countText = String(archiveCount);
          }

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onSelectTab(item.id);
                onCloseMobile();
              }}
              aria-current={isActive ? 'page' : undefined}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap focus-visible:outline-2 focus-visible:outline-rose-600 ${
                isActive
                  ? 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/70 dark:hover:text-slate-100'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>{item.label}</span>
              </span>
              {countText && (
                <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">
                  {countText}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="px-4 py-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
        <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          开源免内测码版 · 全量批量队列、增量去重与多模式归档直接开放。
        </p>
        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={darkMode ? '切换到浅色模式' : '切换到深色模式'}
          className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-300 bg-slate-100 hover:bg-slate-200/80 dark:bg-slate-800 dark:hover:bg-slate-700/80 transition-colors whitespace-nowrap focus-visible:outline-2 focus-visible:outline-rose-600"
        >
          <span>{darkMode ? '当前：深色界面' : '当前：浅色界面'}</span>
          {darkMode ? (
            <Sun className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <Moon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block w-[240px] shrink-0 h-screen sticky top-0">
        {navContent}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <button
            type="button"
            aria-label="关闭侧边栏背景"
            onClick={onCloseMobile}
            className="fixed inset-0 bg-slate-950/40"
          />
          <aside className="relative z-10 w-[260px] max-w-[82vw] h-full">
            {navContent}
          </aside>
        </div>
      )}
    </>
  );
}
