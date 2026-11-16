import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarumaruList } from '../src/marumaru.js';

const origin = 'https://marumaru111.com';
const book = { origin, id: '25259', url: origin + '/novel/25259' };
const list = `<main>
  <h1 class="hero-toki-title">테스트</h1>
  <div class="hero-toki-stats"><div><strong>334</strong><span>총 회차</span></div></div>
  <ul class="ep-list-v2"><li>
    <a class="ep-row-v2-link" href="/novel/25259/4647616">
      <span class="ep-row-v2-no">334</span>
      <div class="ep-row-v2-title"><strong>194화 원문 제목</strong></div>
    </a>
  </li></ul>
  <div class="list-page pager"><a class="pager-btn" href="/novel/25259?order=desc" aria-disabled="true">‹</a>
  <a class="pager-btn" href="/novel/25259?order=desc&amp;page=2">›</a></div>
</main>`;

test('keeps a Marumaru list ordinal distinct from the number in the original title', () => {
  const result = parseMarumaruList(list, book, book.url);
  assert.equal(result.total, 334);
  assert.deepEqual(result.chapters.map(chapter => [chapter.number, chapter.title]), [[334, '194화 원문 제목']]);
  assert.equal(result.next, book.url + '?order=desc&page=2');
});

test('does not accept a different site as the next catalog page', () => {
  assert.throws(() => parseMarumaruList(list.replace('/novel/25259?order=desc&amp;page=2', 'https://example.com/novel/25259'), book, book.url), /다음 페이지 주소/);
});
