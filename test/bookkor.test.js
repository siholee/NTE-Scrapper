import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { normalizeUrl, chapterUrl, BrowserReader } from '../src/source.js';
import { parseBookkorCatalog, readBookkorRenderedText } from '../src/bookkor.js';

const slug = '테스트-작품';
const url = 'https://010.bookkor.com/' + encodeURIComponent(slug);
function fixture(rows) {
  return `<script data-page="app" type="application/json">${JSON.stringify({ component: 'contents/List', props: { content: { reader: 'novel' }, comic: { id: 10, slug, title: '테스트 작품', author: '테스트 작가' }, episodes: rows } })}</script>`;
}
test('Bookkor Korean/encoded and episode URLs resolve to the same stable source identity', () => {
  const a = normalizeUrl('https://010.bookkor.com/테스트-작품/10-ep-book-1?x=2#top');
  const b = normalizeUrl(url);
  assert.deepEqual(a, b); assert.equal(a.source, 'bookkor'); assert.match(a.id, /^bk-[a-f0-9]{12}$/);
  assert.throws(() => normalizeUrl('https://bookkor.com.evil.test/테스트-작품'));
  assert.throws(() => normalizeUrl('https://010.bookkor.com/a%2Fb'));
});
test('Bookkor preserves split episodes and includes the entire embedded list beyond displayed rows', () => {
  const rows = Array.from({ length: 110 }, (_, i) => [1000 + i, `${i + 1}화 제목`, `10-ep-book-${i + 1}`, '2026-11-05']);
  rows.push([2001, '111화 분할 (2)', '10-ep-book-111-p2'], [2000, '111화 분할 (1)', '10-ep-book-111-p1']);
  rows.reverse();
  const book = parseBookkorCatalog(fixture(rows), url);
  assert.equal(book.chapters.length, 112); assert.equal(book.chapters[0].number, 1);
  assert.deepEqual(book.chapters.slice(-2).map(ch => ch.id), ['2000', '2001']);
  assert.match(chapterUrl(book, book.chapters.at(-1)), /111-p2$/);
  assert.throws(() => chapterUrl(book, { url: 'https://other.test/a' }), /작품 사이트/);
  assert.throws(() => parseBookkorCatalog(fixture([[1, '회차 번호 없음', '10-ep-book-1']]), url), /회차 번호/);
});
test('Bookkor rendered text excludes substituted SSR/promotional paragraphs and wrong pages', () => {
  const args = { expectedUrl: url + '/10-ep-book-1', bookSlug: slug, episodeSlug: '10-ep-book-1' };
  function extract({ hydrated = true, paragraphs = ['읽을 수 있는 첫 문단입니다.', '읽을 수 있는 둘째 문단입니다.'], episodeSlug = args.episodeSlug, locationUrl = args.expectedUrl } = {}) {
    const props = { series: { slug }, episode: { slug: episodeSlug, body: { type: 'html' } } };
    const document = { querySelector: selector => selector === 'article.novel-reader' ? { querySelectorAll: () => paragraphs.map(innerText => ({ innerText })) } : selector === '#app' ? { __vue_app__: hydrated } : { textContent: JSON.stringify({ props }) } };
    return vm.runInNewContext(`(${readBookkorRenderedText.toString()})(args)`, { document, location: { href: locationUrl }, URL, args });
  }
  assert.equal(extract(), '읽을 수 있는 첫 문단입니다.\n\n읽을 수 있는 둘째 문단입니다.');
  assert.equal(extract({ paragraphs: ['뇆꿗 첤몹 쭊홯큤즉 먂럣.', '이 작품 원문은 구글에 "북코"를 검색하세요.'] }), '');
  assert.equal(extract({ hydrated: false }), '');
  assert.equal(extract({ episodeSlug: '10-ep-book-2' }), '');
  assert.equal(extract({ locationUrl: url + '/10-ep-book-2' }), '');
});
test('a 403 served as octet-stream is diagnosed correctly and is not repeatedly navigated', async () => {
  const page = new EventEmitter(), frame = {}; let calls = 0;
  page.mainFrame = () => frame;
  page.goto = async () => { calls++; page.emit('response', { request: () => ({ isNavigationRequest: () => true }), frame: () => frame, status: () => 403 }); throw new Error('Download is starting'); };
  const reader = new BrowserReader('.'); reader.open = async () => page;
  await assert.rejects(reader.read({ origin: 'https://010.bookkor.com' }, { url: url + '/10-ep-book-1' }), error => error.status === 403 && error.message.includes('HTTP 403'));
  assert.equal(calls, 1); assert.equal(page.listenerCount('response'), 0);
});
