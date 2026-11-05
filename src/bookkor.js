import { createHash } from 'node:crypto';
import { load } from 'cheerio';

export const isBookkor = hostname => hostname === 'bookkor.com' || hostname.endsWith('.bookkor.com');

export function normalizeBookkorUrl(url) {
  let parts;
  try { parts = url.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part)); }
  catch { throw new Error('Bookkor 주소의 한글 인코딩이 올바르지 않습니다.'); }
  if (!isBookkor(url.hostname) || parts.length < 1 || parts.length > 2 || !/^[\p{L}\p{N}_-]+$/u.test(parts[0]) || (parts[1] && !/^\d+-ep-[\w-]+$/.test(parts[1]))) throw new Error('Bookkor 작품 목록 또는 회차 주소를 입력해주세요.');
  const slug = parts[0];
  url.pathname = '/' + encodeURIComponent(slug); url.search = ''; url.hash = '';
  return { url: url.href, origin: url.origin, source: 'bookkor', slug, id: 'bk-' + createHash('sha256').update(slug).digest('hex').slice(0, 12) };
}

export function parseBookkorCatalog(html, url) {
  const normalized = normalizeBookkorUrl(new URL(url));
  const $ = load(html);
  let page;
  try { page = JSON.parse($('script[data-page="app"][type="application/json"]').text()); }
  catch { throw new Error('Bookkor 작품 데이터를 읽지 못했습니다. 접속 상태 또는 사이트 구조를 확인해주세요.'); }
  const { comic, episodes, content } = page.props || {};
  if (page.component !== 'contents/List' || content?.reader !== 'novel' || !comic?.title || comic.slug !== normalized.slug || !Array.isArray(episodes) || !episodes.length) throw new Error('Bookkor 소설의 전체 회차 목록을 찾지 못했습니다.');
  const byId = new Map();
  for (const row of episodes) {
    if (!Array.isArray(row) || row.length < 3) throw new Error('Bookkor 회차 형식이 변경되었습니다.');
    const [rawId, rawTitle, episodeSlug] = row;
    const id = String(rawId), title = String(rawTitle || '').trim();
    const number = Number(title.match(/^(\d+(?:\.\d+)?)\s*(?:화|회)/)?.[1]);
    if (!/^\d+$/.test(id) || !Number.isFinite(number) || number < 1 || !/^\d+-ep-[\w-]+$/.test(episodeSlug)) throw new Error(`Bookkor 회차 번호나 주소를 확인할 수 없습니다: ${title}`);
    const chapter = { id, number, label: `${number}화`, title: title.replace(/^\d+(?:\.\d+)?\s*(?:화|회)\s*/, '') || title, slug: episodeSlug, url: `${normalized.url}/${encodeURIComponent(episodeSlug)}` };
    if (byId.has(id) && byId.get(id).url !== chapter.url) throw new Error('동일한 Bookkor 회차 ID에 서로 다른 주소가 있습니다.');
    byId.set(id, chapter);
  }
  // Split episodes such as 314-p1 / 314-p2 have the same chapter number,
  // but distinct IDs. Keep both and order by their original publication IDs.
  const chapters = [...byId.values()].sort((a, b) => a.number - b.number || a.id.localeCompare(b.id, 'en', { numeric: true }));
  return { ...normalized, title: String(comic.title).trim(), author: comic.author?.trim() || '작자 미상', description: comic.description ? load(String(comic.description)).text().trim() : '', seriesId: String(comic.id), chapters };
}

// Executed in the ordinary browser after the site's own rendering code runs.
// Server HTML may contain substituted characters; never export it as body text.
export function readBookkorRenderedText({ expectedUrl, bookSlug, episodeSlug }) {
  if (new URL(location.href).pathname !== new URL(expectedUrl).pathname) return '';
  const reader = document.querySelector('article.novel-reader');
  if (!reader || !document.querySelector('#app')?.__vue_app__) return '';
  let props;
  try { props = JSON.parse(document.querySelector('script[data-page="app"][type="application/json"]')?.textContent || '').props; }
  catch { return ''; }
  if (props?.series?.slug !== bookSlug || props?.episode?.slug !== episodeSlug || props?.episode?.body?.type !== 'html') return '';
  const paragraphs = [...reader.querySelectorAll('p')].map(p => p.innerText.trim()).filter(Boolean);
  const text = paragraphs.join('\n\n');
  if (!text || paragraphs.some(p => /구글에\s*["“]?북코["”]?를?\s*검색/.test(p))) return '';
  return text;
}
