import type {
  ArchiveItem,
  BatchJob,
  BatchSettings,
  DiscoveredWork,
  HotBoardItem,
  ParsedLink,
} from './types';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
    ...init,
  });

  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

export interface CreatorProfileSummary {
  nickname: string;
  secUid: string;
  awemeCount: number;
  favoritingCount: number;
  avatarUrl?: string;
}

export function inspectLinksApi(rawText: string, resolveShort = true) {
  return requestJson<{
    links: ParsedLink[];
    duplicatesRemoved: number;
    supportedCount: number;
    unsupportedCount: number;
  }>('/api/inspect', {
    method: 'POST',
    body: JSON.stringify({ rawText, resolveShort }),
  });
}

export function discoverWorksApi(rawText: string, settings: BatchSettings) {
  return requestJson<{
    links: ParsedLink[];
    works: DiscoveredWork[];
    profiles: CreatorProfileSummary[];
    warnings: string[];
    requiresCookie: boolean;
  }>('/api/discover', {
    method: 'POST',
    body: JSON.stringify({ rawText, settings }),
  });
}

export function listJobsApi() {
  return requestJson<{ jobs: BatchJob[] }>('/api/jobs');
}

export function createBatchJobApi(
  payload: { urls?: string[]; works?: DiscoveredWork[] },
  settings: BatchSettings,
) {
  return requestJson<{ job: BatchJob }>('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({ ...payload, settings }),
  });
}

export function cancelJobApi(jobId: string) {
  return requestJson<{ job: BatchJob }>(
    `/api/jobs/${encodeURIComponent(jobId)}/cancel`,
    { method: 'POST' },
  );
}

export function retryJobApi(jobId: string) {
  return requestJson<{ job: BatchJob }>(
    `/api/jobs/${encodeURIComponent(jobId)}/retry`,
    { method: 'POST' },
  );
}

export function deleteJobApi(jobId: string) {
  return requestJson<{ ok: boolean }>(`/api/jobs/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
  });
}

export function listArchiveApi() {
  return requestJson<{ items: ArchiveItem[] }>('/api/archive');
}

export function deleteArchiveItemApi(awemeId: string) {
  return requestJson<{ ok: boolean }>(
    `/api/archive/${encodeURIComponent(awemeId)}`,
    { method: 'DELETE' },
  );
}

export function toggleArchiveFileApi(awemeId: string) {
  return requestJson<{ item: ArchiveItem }>(
    `/api/archive/${encodeURIComponent(awemeId)}/toggle-file`,
    { method: 'POST' },
  );
}

export function getSettingsApi() {
  return requestJson<{ settings: BatchSettings; yaml: string }>('/api/settings');
}

export function updateSettingsApi(settings: Partial<BatchSettings>) {
  return requestJson<{ settings: BatchSettings; yaml: string }>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  });
}

export function getHotBoardApi(forceRefresh = false) {
  return requestJson<{
    items: HotBoardItem[];
    source: 'live' | 'snapshot';
    updatedAt: string;
  }>(forceRefresh ? '/api/hot-board?refresh=1' : '/api/hot-board');
}
