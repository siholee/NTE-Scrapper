import { load } from 'cheerio';

export const isMarumaru = hostname => /^marumaru\d+\.com$/i.test(hostname);
const PAGE_SIZE = 30;
const READER_ORIGIN = 'https://api.storagewebtoon.store';

export async function loadMarumaruCatalog(book, { fetchPage, onProgress }) {
  const endpoint = new URL(`/api/v1/reader/A2/works/${book.id}`, READER_ORIGIN);
  endpoint.searchParams.set('size', String(PAGE_SIZE));
  const chapters = [];
  const seen = new Set();
  let metadata;
  let total;
  let description;

  // The public reader uses this list. UI page numbers can change before the
  // corresponding rows are rendered, so check the response's own page number.
  for (let page = 1; page === 1 || chapters.length < total; page++) {
    endpoint.searchParams.set('page', String(page));
    let data;
    try { data = JSON.parse(await fetchPage(endpoint.href)); }
    catch (error) {
      throw new Error(`마루마루 공개 목록 ${page}페이지를 읽지 못했습니다. ${error instanceof SyntaxError ? 'JSON 형식의 응답을 받지 못했습니다.' : error.message}`, { cause: error });
    }
    const { item, episodes } = data || {};
    if (data?.ok !== true || String(item?.id) !== book.id || item.media_type !== 'NOVEL' ||
        !item.title?.trim() || data.page !== page || data.size !== PAGE_SIZE ||
        !Number.isSafeInteger(data.total) || data.total < 1 || data.total > 15_000 ||
        !Array.isArray(episodes)) {
      throw new Error(`마루마루 목록 ${page}페이지의 작품이나 페이지 정보가 일치하지 않습니다.`);
    }
    if (page === 1) {
      metadata = item;
      total = data.total;
      description = typeof data.synopsis === 'string' ? load(data.synopsis).text().trim() : '';
    }
    if (data.total !== total || episodes.length !== Math.min(PAGE_SIZE, total - chapters.length)) {
      throw new Error(`마루마루 목록 ${page}페이지에 누락이 있거나 총 회차가 변경됐습니다.`);
    }
    for (const episode of episodes) {
      const id = String(episode?.id);
      const title = episode?.title?.trim();
      if (!/^\d+$/.test(id) || seen.has(id) || !title) {
        throw new Error(`마루마루 목록 ${page}페이지에 중복되거나 올바르지 않은 회차가 있습니다.`);
      }
      const number = total - chapters.length;
      seen.add(id);
      chapters.push({ id, number, label: `목록 ${number}화`, title, url: `${book.url}/${id}`, ready: episode.ready });
    }
    onProgress(`목록 ${chapters.length}/${total}개 확인`);
  }
  chapters.reverse();
  return {
    ...book, source: 'marumaru', title: metadata.title.trim(),
    author: metadata.author?.trim() || '작자 미상', description, chapters,
  };
}
