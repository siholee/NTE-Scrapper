import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserReader, loadCatalog, normalizeUrl, sleep, chapterUrl } from './source.js';
import { Library, atomicWrite } from './storage.js';

const activeStates = new Set(['queued', 'discovering', 'running', 'waiting', 'exporting', 'cancelling']);
const now = () => new Date().toISOString();
export class Engine {
  constructor(root, { reader, catalogLoader } = {}) {
    this.root = root;
    this.library = new Library(path.join(root, 'library'));
    this.reader = reader || new BrowserReader(root);
    this.catalogLoader = catalogLoader || loadCatalog;
    this.jobs = new Map(); this.active = null; this.signal = null; this.resumeWait = null;
    this.revision = 0;
  }
  async init() {
    await fs.mkdir(path.join(this.root, 'jobs'), { recursive: true });
    for (const entry of await fs.readdir(path.join(this.root, 'jobs'))) {
      if (!entry.endsWith('.json')) continue;
      try {
        const job = JSON.parse(await fs.readFile(path.join(this.root, 'jobs', entry), 'utf8'));
        this.revision = Math.max(this.revision, job.revision || 0);
        if (activeStates.has(job.status)) {
          job.status = 'interrupted'; job.message = '프로세스가 종료되었습니다. nte_continue로 저장된 TXT부터 이어받으세요.';
          job.updatedAt = now();
          await this.persist(job);
        }
        this.jobs.set(job.jobId, job);
      } catch { /* Keep unrelated/corrupt job files untouched. */ }
    }
  }
  async persist(job) { await atomicWrite(path.join(this.root, 'jobs', `${job.jobId}.json`), JSON.stringify(job, null, 2)); }
  async update(job, patch) {
    Object.assign(job, patch, { updatedAt: now(), revision: ++this.revision });
    await this.persist(job);
  }
  log(job, message) { job.logs = [...(job.logs || []), { at: now(), message }].slice(-60); }
  summary(book) {
    return { bookKey: path.basename(this.library.folder(book)), id: book.id, title: book.title, author: book.author, url: book.url, total: book.chapters.length, saved: Object.keys(book.saved).length, directory: this.library.folder(book), exports: book.exports };
  }
  async getBook(bookKey) {
    const books = await this.library.list();
    const book = books.find(b => path.basename(this.library.folder(b)) === bookKey);
    if (!book) throw new Error('저장된 작품을 찾을 수 없습니다. nte_library로 bookKey를 확인해주세요.');
    return book;
  }
  async inspect({ url }) {
    const catalog = await this.catalogLoader(url);
    // Inspection does not overwrite a manifest while the worker is writing it.
    const saved = (await this.library.list()).find(b => this.library.folder(b) === this.library.folder(catalog));
    return { ...this.summary({ ...catalog, saved: saved?.saved || {}, exports: saved?.exports || {} }), chapters: catalog.chapters.map(ch => ({ ...ch, saved: !!saved?.saved[ch.id] })) };
  }
  getJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('작업을 찾을 수 없습니다. nte_status를 인자 없이 호출해 작업 ID를 확인해주세요.');
    return structuredClone(job);
  }
  async start({ url, start = 1, end, delayMs = 7000 }) {
    const normalized = normalizeUrl(url);
    if (!Number.isInteger(start) || start < 1 || (end !== undefined && (!Number.isInteger(end) || end < start))) throw new Error('수집 범위는 1 이상의 정수이며 마지막 회차는 시작 회차 이상이어야 합니다.');
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 30000) throw new Error('요청 간격은 7000~30000ms입니다.');
    delayMs = Math.max(7000, delayMs);
    if (this.active) {
      const existing = this.jobs.get(this.active);
      if (existing.url === normalized.url && existing.start === start && existing.end === end) return this.getJob(existing.jobId);
      throw new Error(`이미 수집 중인 작업이 있습니다: ${this.active}. 완료 후 시작해주세요.`);
    }
    const job = { jobId: randomUUID(), url: normalized.url, start, end, delayMs, status: 'queued', total: 0, completed: 0, downloaded: 0, reused: 0, current: null, error: null, exports: null, logs: [], createdAt: now(), updatedAt: now(), revision: ++this.revision, message: '수집을 준비하고 있습니다.' };
    this.jobs.set(job.jobId, job); this.active = job.jobId;
    try { await this.persist(job); }
    catch (error) { this.jobs.delete(job.jobId); this.active = null; throw error; }
    this.launch(job);
    return this.getJob(job.jobId);
  }
  launch(job) {
    job.delayMs = Math.max(7000, job.delayMs || 7000);
    this.active = job.jobId; this.signal = new AbortController();
    this.running = this.run(job, this.signal.signal).catch(error => { console.error('[NTE job fatal]', error.message); }).finally(() => {
      if (this.active === job.jobId) { this.active = null; this.signal = null; this.resumeWait = null; }
    });
  }
  async run(job, signal) {
    try {
      await this.update(job, { status: 'discovering', error: null, current: null, completed: 0, downloaded: 0, reused: 0, exports: null, message: '전체 회차 목록을 확인하고 있습니다.' });
      const catalog = await this.catalogLoader(job.url, { signal });
      signal.throwIfAborted();
      const book = await this.library.merge(catalog);
      const chosen = book.chapters.filter(ch => ch.number >= job.start && (job.end === undefined || ch.number <= job.end));
      if (!chosen.length) throw new Error('선택 범위에 수집할 회차가 없습니다.');
      book.selection = chosen.map(ch => ch.id);
      await this.library.persist(book);
      await this.update(job, { bookKey: path.basename(this.library.folder(book)), title: book.title, total: chosen.length, bookTotal: book.chapters.length, directory: this.library.folder(book), status: 'running', message: `${chosen.length}개 회차 수집 시작` });
      this.log(job, `${book.title}: ${chosen.length}개 회차`);
      let lastRequest = 0;
      for (const chapter of chosen) {
        signal.throwIfAborted();
        await this.update(job, { current: { id: chapter.id, number: chapter.number, title: chapter.title, url: chapterUrl(book, chapter) }, message: `${chapter.label} 확인 중` });
        const existing = await this.library.readChapter(book, chapter);
        if (existing) { job.reused++; }
        else {
          const remaining = job.delayMs - (Date.now() - lastRequest);
          if (remaining > 0) await sleep(remaining);
          signal.throwIfAborted();
          lastRequest = Date.now();
          let lastError;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const text = await this.reader.read(book, chapter, {
                signal,
                onWaiting: message => { this.log(job, message); },
                waitForResume: async () => {
                  await this.update(job, { status: 'waiting', message: '본문이 표시되지 않았습니다. nte_diagnose로 확인하세요. 인증·로그인이 필요하면 사용자가 브라우저에서 직접 완료한 뒤 nte_continue를 호출하세요.' });
                  await new Promise((resolve, reject) => {
                    const onAbort = () => { this.resumeWait = null; reject(signal.reason); };
                    const cleanup = () => signal.removeEventListener('abort', onAbort);
                    this.resumeWait = () => { cleanup(); resolve(); };
                    signal.addEventListener('abort', onAbort, { once: true });
                    if (signal.aborted) { cleanup(); onAbort(); }
                  });
                  await this.update(job, { status: 'running', message: `${chapter.label} 본문 다시 확인 중` });
                },
              });
              signal.throwIfAborted();
              await this.library.saveChapter(book, chapter, text);
              lastError = null; job.downloaded++; break;
            } catch (error) {
              if (signal.aborted) throw error;
              lastError = error;
              this.log(job, `${chapter.label} 재시도 ${attempt + 1}/3: ${error.message}`);
              if ([401, 403, 404, 410].includes(error.status)) break;
              if (attempt < 2) await sleep(2000 * (attempt + 1));
            }
          }
          if (lastError) throw lastError;
        }
        job.completed++;
        await this.update(job, { message: `${job.completed}/${job.total}개 TXT 저장 완료` });
      }
      signal.throwIfAborted();
      await this.update(job, { status: 'exporting', current: null, message: '모든 선택 회차의 TXT를 검증하고 EPUB을 만들고 있습니다.' });
      const exports = await this.library.export(book, chosen.map(ch => ch.id));
      this.log(job, `${exports.count}개 TXT 검증 및 EPUB 생성 완료`);
      await this.update(job, { status: 'completed', message: `${exports.count}개 회차 TXT와 EPUB 저장 완료`, finishedAt: now(), exports: { ...exports, txtPath: path.join(this.library.folder(book), exports.txt), epubPath: path.join(this.library.folder(book), exports.epub) } });
    } catch (error) {
      const cancelled = signal.aborted;
      this.log(job, error.message || String(error));
      await this.update(job, { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? null : error.message || String(error), message: cancelled ? '수집을 중단했습니다. 저장된 TXT는 이어받을 수 있습니다.' : '오류로 중단했습니다. nte_diagnose로 확인하고 nte_continue로 이어받으세요.', finishedAt: now() });
    } finally {
      if (job.status !== 'waiting') await this.reader.close();
    }
  }
  async resume({ jobId }) {
    const job = this.jobs.get(jobId); if (!job) return this.getJob(jobId);
    if (job.status === 'waiting' && this.active === jobId) {
      const resume = this.resumeWait;
      if (!resume) throw new Error('아직 대기 상태를 준비 중입니다. 잠시 후 다시 시도해주세요.');
      this.resumeWait = null; resume();
      return this.getJob(jobId);
    }
    if (activeStates.has(job.status)) return this.getJob(jobId);
    if (this.active) throw new Error(`다른 수집이 실행 중입니다: ${this.active}`);
    if (job.status === 'completed') return this.getJob(jobId);
    const previousStatus = job.status, previousFinishedAt = job.finishedAt;
    delete job.finishedAt;
    // Reserve synchronously before doing any I/O to prevent two clients racing.
    job.status = 'queued'; this.active = jobId;
    try { await this.persist(job); }
    catch (error) { job.status = previousStatus; job.finishedAt = previousFinishedAt; this.active = null; throw error; }
    this.launch(job);
    return this.getJob(jobId);
  }
  async cancel({ jobId }) {
    const job = this.jobs.get(jobId); if (!job) return this.getJob(jobId);
    if (this.active === jobId && this.signal && job.status !== 'completed') {
      const controller = this.signal;
      try { await this.update(job, { status: 'cancelling', message: '현재 작업을 안전하게 중단하고 있습니다.' }); }
      finally { controller.abort(new Error('사용자가 수집을 중단했습니다.')); }
    }
    return this.getJob(jobId);
  }
  async status({ jobId, waitMs = 0, afterRevision } = {}) {
    if (!jobId) return { activeJobId: this.active, jobs: [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20).map(job => this.getJob(job.jobId)) };
    const initial = this.getJob(jobId);
    const deadline = Date.now() + Math.max(0, Math.min(25000, waitMs));
    while (activeStates.has(this.getJob(jobId).status) && this.getJob(jobId).revision <= (afterRevision ?? initial.revision) && Date.now() < deadline) await sleep(250);
    return this.getJob(jobId);
  }
  async list() { return { books: (await this.library.list()).map(b => this.summary(b)) }; }
  async export({ bookKey, start, end }) {
    if (this.active) throw new Error('수집이 완료된 뒤 내보내주세요.');
    const book = await this.getBook(bookKey);
    const chapters = book.chapters.filter(ch => (start === undefined || ch.number >= start) && (end === undefined || ch.number <= end));
    const result = await this.library.export(book, chapters.map(ch => ch.id));
    return { ...result, directory: this.library.folder(book), txtPath: path.join(this.library.folder(book), result.txt), epubPath: path.join(this.library.folder(book), result.epub) };
  }
  async diagnose({ jobId }) {
    const job = this.getJob(jobId);
    const result = { job, browserOpen: !!this.reader.page && !this.reader.page.isClosed(), logs: job.logs, advice: 'failed/interrupted/cancelled: 문제를 해결하고 nte_continue. waiting: 브라우저 인증·로그인 또는 로딩 상태 확인 후 nte_continue. completed: exports의 TXT/EPUB을 전달.' };
    if (result.browserOpen) {
      const page = this.reader.page;
      const screenshotPath = path.join(this.root, 'diagnostics', `${jobId}.png`);
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      try {
        result.browser = await page.evaluate(() => ({ url: location.href, title: document.title, notices: [...document.querySelectorAll('.novel-loading, [role="alert"]')].map(el => el.innerText).filter(Boolean).slice(0, 8) }));
        await page.screenshot({ path: screenshotPath }); result.screenshotPath = screenshotPath;
      } catch (error) { result.browserError = error.message.split('\n')[0]; }
    }
    return result;
  }
  async dispatch(method, args = {}) {
    switch (method) {
      case 'health': return { name: 'NTE Scrapper', version: '2.0.0', ready: true, root: this.root, activeJobId: this.active };
      case 'inspect': return this.inspect(args);
      case 'start': return this.start(args);
      case 'status': return this.status(args);
      case 'continue': return this.resume(args);
      case 'cancel': return this.cancel(args);
      case 'library': return this.list();
      case 'export': return this.export(args);
      case 'diagnose': return this.diagnose(args);
      default: throw new Error('지원하지 않는 작업입니다.');
    }
  }
}
