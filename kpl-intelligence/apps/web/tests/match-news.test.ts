import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectMatchNews } from '../app/features/feed/match-news.ts';

const items = [
  { id: 'later', gameNo: 2, publishedAt: '2026-10-07T16:00:00Z' },
  { id: 'earlier', gameNo: 1, publishedAt: '2026-10-07T12:00:00Z' },
  { id: 'unassigned', gameNo: null, publishedAt: '2026-10-07T14:00:00Z' },
  { id: 'unknown-time', gameNo: 2, publishedAt: null },
];

test('match reports show all sources newest first, leaving unknown timestamps last without mutating inputs', () => {
  const before = structuredClone(items);
  assert.deepEqual(selectMatchNews(items, 'all').map(m => m.id), ['later', 'unassigned', 'earlier', 'unknown-time']);
  assert.deepEqual(items, before);
});

test('game filters use exact stored association; unknown game reports stay separate', () => {
  assert.deepEqual(selectMatchNews(items, 2).map(m => m.id), ['later', 'unknown-time']);
  assert.deepEqual(selectMatchNews(items, 'other').map(m => m.id), ['unassigned']);
  assert.deepEqual(selectMatchNews(items, 5), []);
});
