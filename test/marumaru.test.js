import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMarumaruCatalog } from '../src/marumaru.js';

const origin = 'https://marumaru111.com';
const book = { origin, id: '25259', url: `${origin}/novel/25259` };
const item = { id: 25259, title: '테스트 작품', author: '작가', media_type: 'NOVEL' };

function response(page, { returnedPage = page, repeat = false } = {}) {
  const total = 334;
  const offset = (page - 1) * 30;
  return JSON.stringify({
    ok: true, item, page: returnedPage, size: 30, total,
    episodes: Array.from({ length: Math.min(30, total - offset) }, (_, index) => ({
      id: 2000 - (repeat ? index : offset + index),
      title: `194화 원문 제목 ${offset + index}`,
      ready: true,
    })),
  });
}

test('uses authoritative page numbers and exactly 334 distinct records in list order', async () => {
  const pages = [];
  const catalog = await loadMarumaruCatalog(book, {
    fetchPage: async address => {
      const url = new URL(address);
      assert.equal(url.pathname, '/api/v1/reader/A2/works/25259');
      assert.equal(url.searchParams.get('size'), '30');
      const page = Number(url.searchParams.get('page'));
      pages.push(page);
      return response(page);
    },
    onProgress: () => {},
  });
  assert.deepEqual(pages, Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(catalog.chapters.length, 334);
  assert.deepEqual(catalog.chapters[0], {
    id: '1667', number: 1, label: '목록 1화', title: '194화 원문 제목 333',
    url: book.url + '/1667', ready: true,
  });
  assert.equal(catalog.chapters.at(-1).id, '2000');
});

test('rejects a response that repeats page 1 or its episode IDs after changing pages', async () => {
  for (const options of [{ returnedPage: 1 }, { repeat: true }]) {
    await assert.rejects(loadMarumaruCatalog(book, {
      fetchPage: async address => {
        const page = Number(new URL(address).searchParams.get('page'));
        return response(page, page === 2 ? options : {});
      },
      onProgress: () => {},
    }), /2페이지/);
  }
});
