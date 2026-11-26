import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

interface CdpSession {
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onEvent: (handler: (method: string, params: Record<string, unknown>) => void) => void;
  close: () => void;
}

interface EmbeddedServerHandle {
  port: number;
  host: string;
  close: () => Promise<void>;
}

interface EmbeddedServerModule {
  createAndStartServer: (options: {
    port?: number;
    host?: string;
    distDir?: string;
    isProd?: boolean;
    createCdpSession?: () => Promise<CdpSession>;
  }) => Promise<EmbeddedServerHandle>;
}

const APP_NAME = '抖存批量工作台';
const SCRAPER_DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

let mainWindow: BrowserWindow | null = null;
let serverHandle: EmbeddedServerHandle | null = null;
let appUrl: string | null = null;
const activeScrapeClosers = new Set<() => void>();

function getDefaultDownloadDir(): string {
  const dir = path.join(app.getPath('downloads'), 'DouyinBatchStudio');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore mkdir errors until first download
  }
  return dir;
}

function buildAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: 'about' as const, label: `关于 ${APP_NAME}` },
              { type: 'separator' as const },
              {
                label: '在访达中打开下载目录',
                accelerator: 'CmdOrCtrl+Shift+O',
                click: () => {
                  void shell.openPath(getDefaultDownloadDir());
                },
              },
              { type: 'separator' as const },
              { role: 'services' as const, label: '服务' },
              { type: 'separator' as const },
              { role: 'hide' as const, label: `隐藏 ${APP_NAME}` },
              { role: 'hideOthers' as const, label: '隐藏其他' },
              { role: 'unhide' as const, label: '显示全部' },
              { type: 'separator' as const },
              { role: 'quit' as const, label: `退出 ${APP_NAME}` },
            ],
          },
        ]
      : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏幕' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(isMac
          ? [
              { type: 'separator' as const },
              { role: 'front' as const, label: '前置全部窗口' },
            ]
          : [{ role: 'close' as const, label: '关闭' }]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createElectronCdpSession(): Promise<CdpSession> {
  const partition = `douyin-scrape-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const scrapeSession = session.fromPartition(partition, { cache: false });

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      session: scrapeSession,
      offscreen: true,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  let closed = false;
  const listeners: Array<(method: string, params: Record<string, unknown>) => void> = [];

  const onMessage = (
    _event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
  ) => {
    for (const listener of listeners) {
      try {
        listener(method, params || {});
      } catch {
        // ignore listener errors
      }
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    activeScrapeClosers.delete(close);
    try {
      if (!win.isDestroyed()) {
        win.webContents.debugger.removeListener('message', onMessage);
        if (win.webContents.debugger.isAttached()) {
          win.webContents.debugger.detach();
        }
        win.destroy();
      }
    } catch {
      // ignore cleanup errors
    }
    void scrapeSession.clearStorageData().catch(() => undefined);
  };

  activeScrapeClosers.add(close);

  try {
    scrapeSession.setUserAgent(SCRAPER_DESKTOP_UA, 'zh-CN,zh;q=0.9');
    win.webContents.setAudioMuted(true);
    win.webContents.setUserAgent(SCRAPER_DESKTOP_UA);
    win.webContents.setFrameRate(15);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    await win.loadURL('about:blank');

    win.webContents.debugger.attach('1.3');
    win.webContents.debugger.on('message', onMessage);

    await win.webContents.debugger
      .sendCommand('Emulation.setUserAgentOverride', {
        userAgent: SCRAPER_DESKTOP_UA,
        acceptLanguage: 'zh-CN,zh;q=0.9',
        platform: 'Win32',
      })
      .catch(() => undefined);

    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        if (closed || win.isDestroyed()) {
          reject(new Error(`CDP 会话已关闭: ${method}`));
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error(`CDP 调用超时: ${method}`));
        }, 12_000);
        win.webContents.debugger
          .sendCommand(method, params)
          .then((result) => {
            clearTimeout(timer);
            resolve((result as Record<string, unknown>) || {});
          })
          .catch((err) => {
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      });

    return {
      send,
      onEvent: (handler) => listeners.push(handler),
      close,
    };
  } catch (err) {
    close();
    throw err;
  }
}

async function startEmbeddedBackend(): Promise<string> {
  if (process.env.ELECTRON_DEV_URL) {
    return process.env.ELECTRON_DEV_URL;
  }

  const downloadDir = getDefaultDownloadDir();
  process.env.DOUYIN_EMBEDDED_SERVER = '1';
  process.env.DOUYIN_DESKTOP = '1';
  process.env.DOUYIN_DOWNLOAD_BASE_DIR = downloadDir;

  const appRoot = app.getAppPath();
  const serverEntryPath = path.join(appRoot, 'dist-electron', 'server.mjs');
  const distDir = path.join(appRoot, 'dist');

  const mod = (await import(
    pathToFileURL(serverEntryPath).href
  )) as EmbeddedServerModule;

  serverHandle = await mod.createAndStartServer({
    port: 0,
    host: '127.0.0.1',
    distDir,
    isProd: true,
    createCdpSession: createElectronCdpSession,
  });

  return `http://${serverHandle.host}:${serverHandle.port}`;
}

function registerIpcHandlers(): void {
  ipcMain.handle('desktop:get-info', () => ({
    isDesktop: true,
    platform: process.platform,
    downloadDir: getDefaultDownloadDir(),
    appVersion: app.getVersion(),
  }));

  ipcMain.handle('desktop:open-downloads', async (_event, customPath?: string) => {
    const fallback = getDefaultDownloadDir();
    const target =
      typeof customPath === 'string' &&
      path.isAbsolute(customPath) &&
      !customPath.includes('..') &&
      fs.existsSync(customPath)
        ? customPath
        : fallback;

    fs.mkdirSync(target, { recursive: true });
    const errMsg = await shell.openPath(target);
    return { ok: !errMsg, path: target };
  });

  ipcMain.handle('desktop:select-directory', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择抖音媒体默认保存目录',
      defaultPath: getDefaultDownloadDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });
}

function createMainWindow(targetUrl: string): BrowserWindow {
  const iconPath = path.join(app.getAppPath(), 'build', 'icon.png');
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: APP_NAME,
    backgroundColor: '#F8FAFC',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        void shell.openExternal(url);
      }
    } catch {
      // ignore invalid URLs
    }
    return { action: 'deny' };
  });

  win.webContents.session.on('will-download', (_event, item) => {
    const filename = item.getFilename();
    if (filename) {
      const targetDir = getDefaultDownloadDir();
      fs.mkdirSync(targetDir, { recursive: true });
      item.setSavePath(path.join(targetDir, filename));
    }
  });

  void win.loadURL(targetUrl);

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  return win;
}

const hasSingleLock = app.requestSingleInstanceLock();
if (!hasSingleLock) {
  app.quit();
} else {
  app.setName(APP_NAME);

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    buildAppMenu();
    registerIpcHandlers();

    try {
      appUrl = await startEmbeddedBackend();
      mainWindow = createMainWindow(appUrl);
    } catch (err) {
      dialog.showErrorBox(
        `${APP_NAME} 启动失败`,
        err instanceof Error ? err.message : '内置本地服务启动异常，请稍后重试。',
      );
      app.quit();
    }

    app.on('activate', () => {
      if ((!mainWindow || mainWindow.isDestroyed()) && appUrl) {
        mainWindow = createMainWindow(appUrl);
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    for (const closeScrape of Array.from(activeScrapeClosers)) {
      closeScrape();
    }
    if (serverHandle) {
      const handle = serverHandle;
      serverHandle = null;
      void handle.close();
    }
  });
}
