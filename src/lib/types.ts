export type DouyinUrlType =
  | 'video'
  | 'user'
  | 'gallery'
  | 'collection'
  | 'music'
  | 'live'
  | 'live_replay'
  | 'short'
  | 'lvdetail'
  | 'unsupported';

export type DownloadMode = 'post' | 'like' | 'mix' | 'music' | 'collect';

export type VideoQuality =
  | 'original'
  | 'highest'
  | '1440p'
  | '1080p'
  | '720p'
  | '540p'
  | 'lowest';

export type AuthorDirMode = 'nickname' | 'sec_uid' | 'nickname_uid';

export interface ParsedLink {
  id: string;
  originalUrl: string;
  resolvedUrl?: string;
  type: DouyinUrlType;
  targetId?: string;
  supported: boolean;
  reason?: string;
  label: string;
}

export interface DiscoveredWork {
  awemeId: string;
  sourceUrl: string;
  type: DouyinUrlType;
  mode: DownloadMode;
  title: string;
  author: string;
  authorId: string;
  publishDate: string;
  publishTs: number;
  videoUrl?: string;
  videoUri?: string;
  width?: number;
  height?: number;
  imageUrls: string[];
  coverUrl?: string;
  musicUrl?: string;
  avatarUrl?: string;
  sizeBytes: number;
  diggCount?: number;
  commentCount?: number;
}

export interface BatchSettings {
  downloadPath: string;
  modes: DownloadMode[];
  maxItemsPerMode: number;
  videoQuality: VideoQuality;
  concurrency: number;
  retryTimes: number;
  rateLimitPerSec: number;
  startDate: string;
  endDate: string;
  incremental: boolean;
  redownloadMissingFiles: boolean;
  downloadPinned: boolean;
  folderStyle: boolean;
  authorDir: AuthorDirMode;
  filenameTemplate: string;
  folderTemplate: string;
  includeVideo: boolean;
  includeCover: boolean;
  includeMusic: boolean;
  includeAvatar: boolean;
  includeJson: boolean;
  includeComments: boolean;
  cookieString: string;
  proxyUrl: string;
}

export type JobStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type JobItemStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'skipped'
  | 'failed'
  | 'cancelled';

export interface SavedFileMeta {
  kind: 'video' | 'image' | 'cover' | 'music' | 'avatar' | 'json';
  filename: string;
  relativePath: string;
  sizeBytes: number;
}

export interface JobItem {
  itemId: string;
  awemeId: string;
  sourceUrl: string;
  resolvedUrl: string;
  type: DouyinUrlType;
  mode: DownloadMode;
  title: string;
  author: string;
  authorId: string;
  publishDate: string;
  quality: VideoQuality;
  sizeBytes: number;
  filename: string;
  folderName: string;
  status: JobItemStatus;
  progress: number;
  retries: number;
  message: string;
  upstreamStatus: 'live' | 'resolved' | 'offline-manifest';
  mediaUrl?: string;
  videoUri?: string;
  imageUrls?: string[];
  coverUrl?: string;
  musicUrl?: string;
  avatarUrl?: string;
  artifacts: string[];
  savedFiles: SavedFileMeta[];
  downloadReady: boolean;
  updatedAt: string;
}

export interface BatchJob {
  jobId: string;
  label: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  status: JobStatus;
  sourceUrls: string[];
  warnings?: string[];
  settingsSnapshot: Omit<BatchSettings, 'cookieString'> & { hasCookie: boolean };
  items: JobItem[];
  total: number;
  success: number;
  skipped: number;
  failed: number;
  pending: number;
  running: number;
  progressPercent: number;
  downloadableCount: number;
}

export interface ArchiveItem {
  awemeId: string;
  title: string;
  author: string;
  authorId: string;
  type: DouyinUrlType;
  mode: DownloadMode;
  publishDate: string;
  downloadedAt: string;
  quality: VideoQuality;
  sizeBytes: number;
  filename: string;
  folderName: string;
  sourceUrl: string;
  artifacts: string[];
  savedFiles: SavedFileMeta[];
  filePresent: boolean;
}

export interface HotBoardItem {
  rank: number;
  word: string;
  hotValue: number;
  label?: string;
  searchUrl: string;
  category: string;
}

export interface UiPreferences {
  theme: 'light' | 'dark';
  draftInput: string;
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  theme: 'light',
  draftInput: '',
};

export const DEFAULT_BATCH_SETTINGS: BatchSettings = {
  downloadPath: './Downloaded/',
  modes: ['post'],
  maxItemsPerMode: 0,
  videoQuality: 'highest',
  concurrency: 3,
  retryTimes: 3,
  rateLimitPerSec: 2,
  startDate: '',
  endDate: '',
  incremental: true,
  redownloadMissingFiles: true,
  downloadPinned: false,
  folderStyle: true,
  authorDir: 'nickname_uid',
  filenameTemplate: '{date}_{title}_{id}',
  folderTemplate: '{date}_{title}_{id}',
  includeVideo: true,
  includeCover: true,
  includeMusic: false,
  includeAvatar: false,
  includeJson: true,
  includeComments: false,
  cookieString: '',
  proxyUrl: '',
};
