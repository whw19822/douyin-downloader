export interface DesktopBridge {
  isDesktop: boolean;
  platform: string;
  getDesktopInfo: () => Promise<{
    isDesktop: boolean;
    platform: string;
    downloadDir: string;
    appVersion: string;
  }>;
  openDownloadsFolder: (
    customPath?: string,
  ) => Promise<{ ok: boolean; path: string }>;
  selectDownloadDirectory: () => Promise<string | null>;
}

declare global {
  interface Window {
    douyinDesktop?: DesktopBridge;
  }
}

export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window !== 'undefined' && window.douyinDesktop?.isDesktop) {
    return window.douyinDesktop;
  }
  return null;
}
