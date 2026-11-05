import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import { unzipSync, strFromU8 } from 'fflate';
import { XMLValidator } from 'fast-xml-parser';
import { normalizeUrl, parseCatalog, loadCatalog, sleep, BrowserReader } from '../src/source.js';
import { Library, safeName, atomicWrite } from '../src/storage.js';
import { Engine } from '../src/engine.js';
import { projectRoot } from '../src/paths.js';

const sample = (count = 3) => ({ id: '42', origin: 'https://example.com', url: 'https://example.com/novel/42', title: '테스트 & 작품', author: '작가 <이름>', description: '설명\n둘째 줄', chapters: Array.from({ length: count }, (_, i) => ({ id: String(100 + i), number: i + 1, label: `${i + 1}화`, title: `제목 ${i + 1} & <기호>` })) });
const body = '첫 번째 문단입니다. 한글과 특수문자 & < > 를 확인합니다.\n한 줄 더 있습니다.\n\n두 번째 문단입니다.';
function htmlWithWindow(window) {
  const data = `4:${JSON.stringify(['$', 'div', null, { initial: window }])}\n`;
  const cut = Math.floor(data.length / 2);
  return `<html><head><title>테스트 &amp; 작품 - 작가 | 사이트</title><meta name="description" content="설명"/></head><body><h1>테스트 &amp; 작품</h1><script>self.__next_f.push(${JSON.stringify([1, data.slice(0, cut)])})</script><script>self.__next_f.push(${JSON.stringify([1, data.slice(cut)])})</script></body></html>`;
}
async function sandbox(t) {
  const base = path.join(projectRoot, 'work', 'tests'); await fs.mkdir(base, { recursive: true });
  const folder = await fs.mkdtemp(path.join(base, 'case-'));
  t.after(async () => {
    const resolved = path.resolve(folder);
    if (!resolved.startsWith(path.resolve(base) + path.sep)) throw new Error('Unsafe test cleanup');
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return folder;
}
async function settled(engine, id) {
  for (let i = 0; i < 300; i++) { if (!engine.active) return engine.getJob(id); await sleep(50); }
  throw new Error('Test job did not finish');
}

test('URL validation accepts chapter links and normalizes query/fragment', () => {
  assert.deepEqual(normalizeUrl(' https://example.com/novel/42/100?x=1#top '), { url: 'https://example.com/novel/42', origin: 'https://example.com', id: '42' });
  for (const value of ['file:///novel/42', 'javascript:alert(1)', 'https://u:p@example.com/novel/42', 'https://example.com/novel/new', '../novel/42']) assert.throws(() => normalizeUrl(value));
});
test('catalog parses fragmented React records without executing scripts', () => {
  const window = { ok: true, items: sample().chapters.map(ch => ({ ...ch, episodeLabel: ch.label })), hasOlder: false };
  const parsed = parseCatalog(htmlWithWindow(window), 'https://example.com/novel/42');
  assert.equal(parsed.title, '테스트 & 작품'); assert.equal(parsed.author, '작가'); assert.equal(parsed.initial.items.length, 3);
  assert.throws(() => parseCatalog('<html><h1>로그인</h1></html>', 'https://example.com/novel/42'), /회차 목록/);
  assert.throws(() => parseCatalog('<a class="novel-ep-link" href="/novel/42/100"><span class="ne-num">1화</span><span class="ne-title">첫 화</span></a>', 'https://example.com/novel/42'), /페이지 정보/);
});
test('catalog paginates, removes duplicates and sorts by episode number', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const chapters = sample().chapters;
  const first = { ok: true, items: [chapters[2], chapters[1]], hasOlder: true, olderCursor: '2:101' };
  let requests = 0;
  globalThis.fetch = async url => {
    requests++;
    return new Response(String(url).includes('/api/') ? JSON.stringify({ ok: true, items: [chapters[1], chapters[0]], hasOlder: false }) : htmlWithWindow(first), { status: 200 });
  };
  const result = await loadCatalog('https://example.com/novel/42');
  assert.deepEqual(result.chapters.map(ch => ch.number), [1, 2, 3]); assert.equal(requests, 2);
});
test('Windows filenames strip paths, forbidden characters and reserved device names', () => {
  assert.equal(safeName('CON.txt'), '_CON.txt'); assert.equal(safeName('a/b\\c:d*e?'), 'a_b_c_d_e_');
  assert.equal(safeName('title.  '), 'title'); assert.equal(safeName('  '), '제목 없음');
});
test('concurrent Windows checkpoint writes serialize without losing the final state', async t => {
  const folder = await sandbox(t); const file = path.join(folder, 'checkpoint.json');
  await Promise.all(Array.from({ length: 80 }, (_, i) => atomicWrite(file, JSON.stringify({ i }))));
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { i: 79 });
  assert.deepEqual(await fs.readdir(folder), ['checkpoint.json']);
});
test('TXT checksums prevent corrupt or incomplete EPUB export; valid EPUB has coherent XML/TOC/spine', async t => {
  const folder = await sandbox(t); const lib = new Library(folder); const book = await lib.merge(sample());
  await lib.saveChapter(book, book.chapters[0], body);
  await assert.rejects(lib.export(book, book.chapters.map(ch => ch.id)), /TXT가 없거나 손상/);
  assert.equal((await fs.readdir(lib.folder(book))).some(file => file.endsWith('.epub')), false);
  for (const ch of book.chapters.slice(1)) await lib.saveChapter(book, ch, body);
  const output = await lib.export(book, book.chapters.map(ch => ch.id));
  const epub = await fs.readFile(path.join(lib.folder(book), output.epub));
  assert.equal(epub.readUInt32LE(0), 0x04034b50); assert.equal(epub.readUInt16LE(8), 0);
  assert.equal(epub.subarray(30, 38).toString(), 'mimetype');
  const zip = unzipSync(epub); assert.equal(strFromU8(zip.mimetype), 'application/epub+zip');
  for (const [name, bytes] of Object.entries(zip)) if (/\.(xml|opf|ncx|xhtml)$/.test(name)) assert.equal(XMLValidator.validate(strFromU8(bytes)), true, name);
  const opf = load(strFromU8(zip['OEBPS/content.opf']), { xmlMode: true });
  const nav = load(strFromU8(zip['OEBPS/nav.xhtml']), { xmlMode: true });
  assert.equal(opf('spine > itemref').length, 4); assert.equal(nav('nav li').length, 3);
  for (const el of opf('manifest item').toArray()) assert.ok(zip[`OEBPS/${opf(el).attr('href')}`]);
  assert.ok(strFromU8(zip['OEBPS/chapter-00001.xhtml']).includes('한글과 특수문자 &amp; &lt; &gt;'));
  await fs.appendFile(lib.chapterPath(book, book.chapters[0]), '손상');
  assert.equal(await lib.readChapter(book, book.chapters[0]), null);
  await assert.rejects(lib.export(book, book.chapters.map(ch => ch.id)), /손상/);
});
test('engine completes, persists, and reuses verified TXT on a second request', async t => {
  const folder = await sandbox(t); let reads = 0;
  const engine = new Engine(folder, { reader: { read: async () => { reads++; return body; }, close: async () => {} }, catalogLoader: async () => sample(2) });
  await engine.init();
  const first = await engine.start({ url: sample().url, delayMs: 1000 });
  const duplicate = await engine.start({ url: sample().url, delayMs: 1000 }); assert.equal(duplicate.jobId, first.jobId);
  await assert.rejects(engine.start({ url: sample().url, end: 1 }), /이미 수집/);
  const result = await settled(engine, first.jobId);
  assert.equal(result.status, 'completed'); assert.equal(result.completed, 2); assert.equal(result.exports.count, 2); assert.equal(reads, 2);
  const second = await engine.start({ url: sample().url }); const again = await settled(engine, second.jobId);
  assert.equal(again.reused, 2); assert.equal(again.downloaded, 0); assert.equal(reads, 2);
  const restored = new Engine(folder, { reader: { close: async () => {} } }); await restored.init();
  assert.equal(restored.getJob(first.jobId).status, 'completed');
  assert.ok(restored.revision >= again.revision);
});
test('a failed initial checkpoint releases the job slot for repair and retry', async t => {
  const folder = await sandbox(t);
  const engine = new Engine(folder, { reader: { close: async () => {} } });
  await engine.init(); engine.persist = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(engine.start({ url: sample().url }), /disk unavailable/);
  assert.equal(engine.active, null); assert.equal(engine.jobs.size, 0);
});
test('interrupted jobs become resumable and cancellation leaves no complete export', async t => {
  const folder = await sandbox(t); let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const engine = new Engine(folder, { catalogLoader: async () => sample(2), reader: {
    read: async (_book, _chapter, { signal }) => { entered(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); },
    close: async () => {},
  } });
  await engine.init(); const job = await engine.start({ url: sample().url }); await ready;
  await engine.cancel({ jobId: job.jobId }); const result = await settled(engine, job.jobId);
  assert.equal(result.status, 'cancelled'); assert.equal(result.exports, null);
  const saved = engine.getJob(job.jobId); saved.status = 'running'; await atomicWrite(path.join(folder, 'jobs', `${job.jobId}.json`), JSON.stringify(saved));
  const restored = new Engine(folder, { reader: { read: async () => body, close: async () => {} }, catalogLoader: async () => sample(2) });
  await restored.init(); assert.equal(restored.getJob(job.jobId).status, 'interrupted');
  await restored.resume({ jobId: job.jobId }); assert.equal((await settled(restored, job.jobId)).status, 'completed');
});
test('browser treats a visible temporary site error as retryable without user intervention', async t => {
  const folder = await sandbox(t), reader = new BrowserReader(folder);
  const originalNow = Date.now; let tick = 0; Date.now = () => tick++ * 9000;
  t.after(() => { Date.now = originalNow; });
  reader.navigate = async () => ({ isClosed: () => false, evaluate: async () => '', locator: () => ({ allTextContents: async () => ['일시적 오류가 발생했습니다. 잠시 후 다시 시도해주세요.'] }) });
  await assert.rejects(reader.read(sample(), sample().chapters[0]), /일시적 오류/);
});
test('browser waits for user verification and keeps the same page on continue', async t => {
  const folder = await sandbox(t), reader = new BrowserReader(folder);
  const originalNow = Date.now; let tick = 0; Date.now = () => tick++ * 40000;
  t.after(() => { Date.now = originalNow; });
  let ready = false, navigations = 0, resumed = 0;
  reader.navigate = async () => { navigations++; return { isClosed: () => false, evaluate: async () => ready ? body : '', locator: () => ({ allTextContents: async () => ['인증이 필요합니다.'] }), bringToFront: async () => {} }; };
  const text = await reader.read(sample(), sample().chapters[0], { waitForResume: async () => { resumed++; ready = true; } });
  assert.equal(text, body); assert.equal(resumed, 1); assert.equal(navigations, 1);
});
