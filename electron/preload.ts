import { contextBridge, ipcRenderer } from 'electron';

export interface DesktopInfo {
  isDesktop: boolean;
  platform: string;
  downloadDir: string;
  appVersion: string;
}

const desktopBridge = {
  isDesktop: true,
  platform: process.platform,
  getDesktopInfo: (): Promise<DesktopInfo> =>
    ipcRenderer.invoke('desktop:get-info'),
  openDownloadsFolder: (customPath?: string): Promise<{ ok: boolean; path: string }> =>
    ipcRenderer.invoke('desktop:open-downloads', customPath),
  selectDownloadDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('desktop:select-directory'),
};

contextBridge.exposeInMainWorld('douyinDesktop', desktopBridge);
