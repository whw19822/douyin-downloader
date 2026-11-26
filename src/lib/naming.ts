export const ALLOWED_TEMPLATE_VARIABLES = [
  'id',
  'title',
  'author',
  'author_id',
  'date',
  'year',
  'month',
  'day',
  'time',
  'hour',
  'minute',
  'second',
  'timestamp',
  'type',
  'mode',
] as const;

export const MAX_TEMPLATE_LENGTH = 200;

const ALLOWED_SET = new Set<string>(ALLOWED_TEMPLATE_VARIABLES);
const PLACEHOLDER_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
const ILLEGAL_FILENAME_CHARS_RE = /[<>:"/\\|?*]/g;
const WINDOWS_RESERVED_STEMS = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

export interface TemplateValidationResult {
  valid: boolean;
  error?: string;
  variables: string[];
}

export interface NamingContext {
  id: string;
  title: string;
  author: string;
  author_id?: string;
  date: string;
  timestamp?: number;
  type: string;
  mode?: string;
}

export function validateNamingTemplate(template: string): TemplateValidationResult {
  if (typeof template !== 'string' || !template.trim()) {
    return { valid: false, error: '命名模板不能为空', variables: [] };
  }

  if (template.length > MAX_TEMPLATE_LENGTH) {
    return {
      valid: false,
      error: `命名模板长度不能超过 ${MAX_TEMPLATE_LENGTH} 个字符`,
      variables: [],
    };
  }

  if (template.includes('/') || template.includes('\\')) {
    return {
      valid: false,
      error: '命名模板不能包含路径分隔符 / 或 \\',
      variables: [],
    };
  }

  const variables: string[] = [];
  let match: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((match = PLACEHOLDER_RE.exec(template)) !== null) {
    variables.push(match[1]);
  }

  if (variables.length === 0) {
    return {
      valid: false,
      error: '模板至少需要包含一个有效变量（如 {id}、{title}、{date}）',
      variables: [],
    };
  }

  const unknown = Array.from(new Set(variables.filter((v) => !ALLOWED_SET.has(v))));
  if (unknown.length > 0) {
    return {
      valid: false,
      error: `包含未识别的变量: ${unknown.map((v) => `{${v}}`).join(', ')}`,
      variables,
    };
  }

  return { valid: true, variables };
}

export function sanitizeFilename(filename: string, maxLength = 80): string {
  const withoutControls = Array.from(filename, (ch) => {
    if (ch === '\r' || ch === '\n') return ' ';
    const code = ch.charCodeAt(0);
    return code <= 0x1f ? '_' : ch;
  }).join('');
  let cleaned = withoutControls
    .replace(ILLEGAL_FILENAME_CHARS_RE, '_')
    .replace(/^[. ]+|[. ]+$/g, '');

  if (cleaned.length > maxLength) {
    cleaned = cleaned.slice(0, maxLength).replace(/[. ]+$/g, '');
  }

  const stem = cleaned.split('.')[0]?.toUpperCase() || '';
  if (WINDOWS_RESERVED_STEMS.has(stem)) {
    cleaned = `_${cleaned}`.slice(0, maxLength);
  }

  return cleaned || 'untitled';
}

export function renderNamingTemplate(
  template: string,
  context: NamingContext,
  fallback = 'untitled',
): string {
  const [year = '', month = '', day = ''] = (context.date || '').split('-');
  const dt = context.timestamp ? new Date(context.timestamp * 1000) : null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const hour = dt && !Number.isNaN(dt.getTime()) ? pad(dt.getHours()) : '12';
  const minute = dt && !Number.isNaN(dt.getTime()) ? pad(dt.getMinutes()) : '00';
  const second = dt && !Number.isNaN(dt.getTime()) ? pad(dt.getSeconds()) : '00';

  const map: Record<string, string> = {
    id: context.id || '',
    title: context.title || 'no_title',
    author: context.author || '',
    author_id: context.author_id || '',
    date: context.date || '',
    year,
    month,
    day,
    time: `${hour}-${minute}-${second}`,
    hour,
    minute,
    second,
    timestamp: context.timestamp ? String(context.timestamp) : '',
    type: context.type || 'video',
    mode: context.mode || 'post',
  };

  const rendered = template.replace(PLACEHOLDER_RE, (_, key: string) => map[key] ?? '');
  const safe = sanitizeFilename(rendered);
  return safe === 'untitled' && fallback ? sanitizeFilename(fallback) : safe;
}
