import { load } from 'cheerio';

export const isMarumaru = hostname => /^marumaru\d+\.com$/i.test(hostname);

export function parseMarumaruList(html, book, pageUrl) {
  const $ = load(html);
  const title = $('main .hero-toki-title').text().trim();
  const totalText = $('.hero-toki-stats div').filter((_, node) => $(node).find('span').text().trim() === '총 회차').find('strong').text();
  const total = Number(totalText.replace(/,/g, ''));
  if (!title || !Number.isSafeInteger(total) || total < 1) {
    throw new Error('마루마루 작품 목록이 열리지 않았습니다. 브라우저에서 주소와 접속 상태를 확인해주세요.');
  }
  const chapters = $('main .ep-list-v2 a.ep-row-v2-link').toArray().map(element => {
    const link = $(element);
    const url = new URL(link.attr('href'), pageUrl);
    const id = url.pathname.match(new RegExp(`^/novel/${book.id}/(\\d+)/?$`))?.[1];
    const number = Number(link.find('.ep-row-v2-no').text().trim().replace(/,/g, ''));
    const title = link.find('.ep-row-v2-title strong').text().trim();
    if (!id || url.origin !== book.origin || !Number.isSafeInteger(number) || number < 1 || !title) {
      throw new Error('마루마루 회차 링크, 번호 또는 제목을 확인할 수 없습니다.');
    }
    return { id, number, title, label: `목록 ${number}화`, url: url.href };
  });
  const nextLink = $('.list-page.pager a.pager-btn').filter((_, element) => $(element).text().trim() === '›' && $(element).attr('aria-disabled') !== 'true').attr('href');
  const next = nextLink ? new URL(nextLink, pageUrl) : null;
  if (next && (next.origin !== book.origin || next.pathname !== new URL(book.url).pathname)) {
    throw new Error('마루마루 목록의 다음 페이지 주소가 올바르지 않습니다.');
  }
  return {
    title, total, chapters, next: next?.href,
    author: $('.hero-toki-author').text().trim() || '작자 미상',
    description: $('.hero-toki-syn').text().trim(),
  };
}
