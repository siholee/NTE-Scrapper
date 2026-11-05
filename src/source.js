import { load } from 'cheerio';
import { chromium } from 'playwright';
import path from 'node:path';
import { networkPacer } from './pacing.js';
import { isBookkor, normalizeBookkorUrl, parseBookkorCatalog, readBookkorRenderedText } from './bookkor.js';

export const EXAMPLE_URL = 'https://toki35.com/novel/63829';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function normalizeUrl(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('올바른 소설 목록 URL을 입력해주세요.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('HTTP/HTTPS 주소만 사용할 수 있습니다.');
  if (isBookkor(url.hostname)) return normalizeBookkorUrl(url);
  const match = url.pathname.match(/^\/novel\/(\d+)(?:\/\d+)?\/?$/);
  if (!match) throw new Error('지원하는 소설 목록 주소(/novel/작품번호 또는 Bookkor 작품 주소)를 입력해주세요.');
  url.pathname = `/novel/${match[1]}`;
  url.search = ''; url.hash = '';
  return { url: url.href, origin: url.origin, id: match[1] };
}

export function parseCatalog(html, url) {
  const $ = load(html);
  const windows = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.items) && typeof value.hasOlder === 'boolean' && value.items.every(x => x?.id && Number.isFinite(x.number))) windows.push(value);
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  }
  let flight = '';
  $('script').each((_, el) => {
    const script = $(el).text();
    const match = script.match(/(?:self\.__next_f(?:=self\.__next_f\|\|\[\])?\)?\.push|self\.__next_f\.push)\((\[[\s\S]*\])\)\s*;?$/);
    if (!match) return;
    try { const chunk = JSON.parse(match[1]); if (chunk[0] === 1 && typeof chunk[1] === 'string') flight += chunk[1]; } catch { /* Non-data scripts are never executed. */ }
  });
  for (const line of flight.split('\n')) {
    const record = line.slice(line.indexOf(':') + 1);
    if (!record.startsWith('[') && !record.startsWith('{')) continue;
    try { visit(JSON.parse(record)); } catch { /* Non-JSON React records. */ }
  }
  const initial = windows.sort((a, b) => b.items.length - a.items.length)[0];
  const items = initial?.items || [];
  if (!initial) {
    $('a.novel-ep-link').each((_, el) => {
      const href = $(el).attr('href') || '';
      const id = href.match(/\/novel\/\d+\/(\d+)/)?.[1];
      const number = Number($(el).find('.ne-num').text().match(/[\d.]+/)?.[0]);
      if (id && number) items.push({ id, number, title: $(el).find('.ne-title').text().trim(), episodeLabel: `${number}화` });
    });
    if (items.length) throw new Error('회차 목록의 페이지 정보를 확인할 수 없습니다. 사이트 구조가 변경되었을 수 있습니다.');
  }
  if (!items.length) throw new Error('회차 목록을 찾지 못했습니다. 주소 또는 사이트 접속 상태를 확인해주세요.');
  const pageTitle = $('head > title').first().text();
  const title = $('h1').first().text().trim() || pageTitle.split(' - ')[0].trim();
  const author = pageTitle.match(/ - (.*?)\s*\|/)?.[1]?.trim() || '작자 미상';
  const description = $('meta[name="description"]').attr('content') || '';
  return { ...normalizeUrl(url), title, author, description, initial };
}

export async function fetchText(url, { signal, accept = 'text/html', retry = 2 } = {}) {
  let last;
  for (let attempt = 0; attempt <= retry; attempt++) {
    signal?.throwIfAborted();
    try {
      await networkPacer.take(signal);
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/156.0.0.0 Safari/537.36', Accept: accept },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
        redirect: 'follow',
      });
      if (!response.ok) {
        const error = new Error(`사이트 응답 오류 (${response.status}). 잠시 후 다시 시도해주세요.`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      return await response.text();
    } catch (error) {
      last = error;
      if (signal?.aborted || error.retryable === false || attempt === retry) throw error;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw last;
}

export async function loadCatalog(url, { signal, onProgress = () => {} } = {}) {
  const normalized = normalizeUrl(url);
  if (normalized.source === 'bookkor') {
    const book = parseBookkorCatalog(await fetchText(normalized.url, { signal }), normalized.url);
    onProgress(`회차 목록 ${book.chapters.length}개 확인`);
    return book;
  }
  const book = parseCatalog(await fetchText(normalized.url, { signal }), normalized.url);
  const chapters = new Map();
  let window = book.initial;
  const cursors = new Set();
  for (let page = 0; ; page++) {
    for (const item of window.items) {
      if (!/^\d+$/.test(String(item.id)) || !Number.isFinite(item.number)) throw new Error('올바르지 않은 회차 데이터입니다.');
      chapters.set(String(item.id), { id: String(item.id), number: item.number, title: item.title || `${item.number}화`, label: item.episodeLabel || `${item.number}화`, gated: item.gateMode && item.gateMode !== 'none' });
    }
    onProgress(`회차 목록 ${chapters.size}개 확인`);
    if (!window.hasOlder) break;
    if (!window.olderCursor || cursors.has(window.olderCursor) || page > 500) throw new Error('회차 목록의 다음 페이지를 확인할 수 없습니다.');
    cursors.add(window.olderCursor);
    await sleep(700);
    const query = new URLSearchParams({ direction: 'older', cursor: window.olderCursor });
    const raw = await fetchText(`${book.origin}/api/novel/${book.id}/episodes/window?${query}`, { signal, accept: 'application/json' });
    try { window = JSON.parse(raw); } catch { throw new Error('회차 목록 응답을 읽을 수 없습니다.'); }
    if (!window.ok || !Array.isArray(window.items) || typeof window.hasOlder !== 'boolean') throw new Error(window.error || '회차 목록 응답 형식이 변경되었습니다.');
  }
  delete book.initial;
  book.chapters = [...chapters.values()].sort((a, b) => a.number - b.number || a.id.localeCompare(b.id, 'en', { numeric: true }));
  return book;
}

export function chapterUrl(book, chapter) {
  const value = chapter.url || `${book.origin}/novel/${book.id}/${chapter.id}`;
  const url = new URL(value);
  if (url.origin !== book.origin || url.username || url.password) throw new Error('회차 주소가 작품 사이트와 다릅니다.');
  return url.href;
}

export class BrowserReader {
  constructor(dataDir) { this.profile = path.join(dataDir, 'browser-profile'); this.context = null; this.page = null; this.launching = null; }
  async open() {
    if (this.context && this.page && !this.page.isClosed()) return this.page;
    if (this.launching) return this.launching;
    this.launching = this.launch();
    try { return await this.launching; } finally { this.launching = null; }
  }
  async launch() {
    const errors = [];
    for (const channel of ['chrome', 'msedge', undefined]) {
      try {
        this.context = await chromium.launchPersistentContext(this.profile, {
          channel, headless: false, viewport: { width: 1160, height: 850 }, acceptDownloads: false,
        });
        this.context.on('close', () => { this.context = null; this.page = null; });
        this.page = this.context.pages()[0] || await this.context.newPage();
        // Keep navigation and any required verification in the single reader window.
        this.context.on('page', page => { if (page !== this.page) page.close().catch(() => {}); });
        return this.page;
      } catch (error) { errors.push(error.message); }
    }
    throw new Error(`Chrome 또는 Edge를 실행하지 못했습니다. 브라우저가 설치되어 있는지 확인해주세요. ${errors[0]?.split('\n')[0] || ''}`);
  }
  async navigate(book, chapter) {
    const page = await this.open();
    let navigationStatus = 0;
    const observe = response => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) navigationStatus = response.status();
    };
    page.on('response', observe);
    try {
      const response = await page.goto(chapterUrl(book, chapter), { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (response && response.status() >= 400) navigationStatus = response.status();
      else return page;
    } catch (error) {
      if (navigationStatus < 400) throw error;
    } finally { page.off('response', observe); }
    const error = new Error(`회차 페이지 HTTP ${navigationStatus}: 사이트가 접근을 거부했거나 페이지를 제공하지 않습니다.`);
    error.status = navigationStatus;
    throw error;
  }
  async read(book, chapter, { signal, onWaiting = () => {}, waitForResume } = {}) {
    let page;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      try { await networkPacer.take(signal); page = await this.navigate(book, chapter); break; }
      catch (error) {
        if ([401, 403, 404, 410].includes(error.status)) throw error;
        if (attempt === 1) throw new Error(`회차 페이지를 열지 못했습니다: ${error.message.split('\n')[0]}`);
        await sleep(1500);
      }
    }
    let startedAt = Date.now();
    let deadline = startedAt + 35000;
    for (;;) {
      signal?.throwIfAborted();
      if (!page || page.isClosed()) throw new Error('본문 브라우저가 닫혔습니다. 수집을 다시 시작하면 이어받습니다.');
      const content = book.source === 'bookkor'
        ? await page.evaluate(readBookkorRenderedText, { expectedUrl: chapterUrl(book, chapter), bookSlug: book.slug, episodeSlug: chapter.slug })
        : await page.evaluate(({ novelId, episodeId }) => {
        // Read only text exposed by the site's ordinary reader after it has rendered.
        // Do not decrypt content, forge tokens, solve CAPTCHAs, or unlock paid chapters.
        if (!location.pathname.match(new RegExp(`^/novel/${novelId}/${episodeId}/?$`))) return '';
        const text = typeof window.__novelTTSText === 'string' ? window.__novelTTSText.trim() : '';
        if (text) return text;
        for (const selector of ['#novel_content', '#novel-content', '.novel-content', '.novel-text', '.novel-epub-rendered']) {
          const element = document.querySelector(selector);
          if (element?.innerText?.trim()) return element.innerText.trim();
        }
        // New reader versions keep TTS state inside a module. Read the already
        // rendered paragraphs through the reader's own retained root reference.
        // This does not alter the root or bypass content loading/access checks.
        for (const host of document.querySelectorAll('.novel-viewer *')) {
          const root = host.__novelShadow;
          if (!root) continue;
          const rendered = root.querySelector('.novel-epub-rendered');
          if (rendered?.innerText?.trim()) return rendered.innerText.trim();
          const paragraphs = [...root.querySelectorAll('p')].map(p => p.innerText?.trim()).filter(Boolean);
          if (paragraphs.length) return paragraphs.join('\n\n');
        }
        return '';
      }, { novelId: book.id, episodeId: chapter.id });
      if (content.trim().length >= 20) return content.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
      if (Date.now() - startedAt >= 8000) {
        const notices = await page.locator('.novel-loading').allTextContents();
        if (notices.some(text => /일시적 오류가 발생|잠시 후 다시 시도|temporarily unavailable/i.test(text))) {
          throw new Error(`${chapter.label}: 사이트가 일시적 오류를 표시했습니다. 페이지를 다시 열어 재시도합니다.`);
        }
      }
      if (Date.now() >= deadline) {
        if (!waitForResume) throw new Error('본문이 표시되지 않았습니다. 브라우저에서 인증 또는 로그인 상태를 확인해주세요.');
        onWaiting(`${chapter.label} 본문 대기 중. 열린 브라우저에서 인증·로그인이 필요하면 직접 완료한 뒤 ‘계속’을 누르세요.`);
        await page.bringToFront();
        await waitForResume();
        signal?.throwIfAborted();
        // Keep the page intact: a user may have just completed a challenge on it.
        startedAt = Date.now();
        deadline = startedAt + 35000;
      }
      await sleep(400);
    }
  }
  async close() { const context = this.context; this.context = null; this.page = null; if (context) await context.close().catch(() => {}); }
}
