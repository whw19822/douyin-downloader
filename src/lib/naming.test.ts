import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderNamingTemplate,
  sanitizeFilename,
  validateNamingTemplate,
} from './naming';

test('validateNamingTemplate accepts valid templates and rejects invalid ones', () => {
  assert.equal(validateNamingTemplate('{date}_{title}_{id}').valid, true);
  assert.equal(validateNamingTemplate('').valid, false);
  assert.equal(validateNamingTemplate('static_name_only').valid, false);
  assert.equal(validateNamingTemplate('{date}/{title}_{id}').valid, false);
  assert.equal(validateNamingTemplate('{date}_{unknown_var}').valid, false);
});

test('sanitizeFilename cleans illegal path chars and Windows reserved stems', () => {
  assert.equal(sanitizeFilename('测试:视频*名称?<>|'), '测试_视频_名称____');
  assert.equal(sanitizeFilename('CON'), '_CON');
  assert.equal(sanitizeFilename('...   '), 'untitled');
});

test('renderNamingTemplate fills date, author, title, and id cleanly', () => {
  const name = renderNamingTemplate('{date}_{author}_{title}_{id}', {
    id: '73948123456',
    title: '秋日街拍：4K 实拍',
    author: '山野影像',
    date: '2026-10-15',
    type: 'video',
    mode: 'post',
  });
  assert.equal(name, '2026-10-15_山野影像_秋日街拍：4K 实拍_73948123456');
});
