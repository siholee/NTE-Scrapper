import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createEpub } from './epub.js';

export function safeName(value) {
  let name = String(value).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 72).replace(/[. ]+$/g, '');
  if (!name) name = '제목 없음';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}
export const checksum = text => createHash('sha256').update(text).digest('hex');
const writes = new Map();
export async function atomicWrite(file, content) {
  const key = path.resolve(file);
  const previous = writes.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, content);
      // Windows scanners/readers can briefly hold a destination without FILE_SHARE_DELETE.
      // Retry atomic replacement; never delete a good checkpoint before replacing it.
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(temp, file); break; }
        catch (error) {
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 8) throw error;
          await new Promise(resolve => setTimeout(resolve, 30 * (attempt + 1)));
        }
      }
    } catch (error) { await fs.rm(temp, { force: true }).catch(() => {}); throw error; }
  });
  writes.set(key, pending);
  try { await pending; } finally { if (writes.get(key) === pending) writes.delete(key); }
}
export class Library {
  constructor(root) { this.root = root; }
  folder(book) { return path.join(this.root, `${safeName(book.title)}_${book.id}`); }
  async persist(book) { await atomicWrite(path.join(this.folder(book), 'book.json'), JSON.stringify(book, null, 2)); }
  async merge(catalog) {
    let saved;
    try { saved = JSON.parse(await fs.readFile(path.join(this.folder(catalog), 'book.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('기존 저장 정보를 읽지 못했습니다. book.json을 확인해주세요.'); }
    const book = { ...saved, ...catalog, saved: saved?.saved || {}, selection: saved?.selection || [], exports: saved?.exports || {}, updatedAt: new Date().toISOString() };
    await this.persist(book);
    return book;
  }
  async list() {
    await fs.mkdir(this.root, { recursive: true });
    const books = [];
    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const book = JSON.parse(await fs.readFile(path.join(this.root, entry.name, 'book.json'), 'utf8'));
        if (entry.name !== path.basename(this.folder(book))) continue;
        books.push(book);
      } catch { /* Ignore unrelated folders and report unreadable books on explicit open. */ }
    }
    return books.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  chapterPath(book, chapter) {
    const saved = book.saved[chapter.id];
    const file = saved?.file || `${String(chapter.number).padStart(4, '0')}_${safeName(chapter.title)}_${chapter.id}.txt`;
    if (path.basename(file) !== file || !file.endsWith('.txt')) throw new Error('저장 파일 이름이 올바르지 않습니다.');
    return path.join(this.folder(book), 'chapters', file);
  }
  async readChapter(book, chapter) {
    const meta = book.saved[chapter.id];
    if (!meta?.sha256) return null;
    try {
      const full = await fs.readFile(this.chapterPath(book, chapter), 'utf8');
      if (checksum(full) !== meta.sha256) return null;
      const split = full.indexOf('\n\n');
      return split >= 0 && full.slice(split + 2).trim() ? full.slice(split + 2).trim() : null;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async saveChapter(book, chapter, text) {
    if (typeof text !== 'string' || text.trim().length < 20) throw new Error('본문이 비어 있어 저장하지 않았습니다.');
    const full = `${chapter.label} · ${chapter.title}\n\n${text.trim()}\n`;
    const file = this.chapterPath(book, chapter);
    await atomicWrite(file, full);
    book.saved[chapter.id] = { file: path.basename(file), sha256: checksum(full), characters: text.trim().length, savedAt: new Date().toISOString() };
    book.updatedAt = new Date().toISOString();
    await this.persist(book);
  }
  async export(book, ids) {
    const selection = new Set(ids);
    if (!selection.size) throw new Error('내보낼 회차를 선택해주세요.');
    const chosen = book.chapters.filter(ch => selection.has(ch.id));
    if (chosen.length !== selection.size) throw new Error('존재하지 않는 회차가 포함되어 있습니다.');
    const chapters = [];
    for (const chapter of chosen) {
      const text = await this.readChapter(book, chapter);
      if (!text) throw new Error(`${chapter.label} TXT가 없거나 손상되었습니다. 수집을 다시 시작해주세요.`);
      chapters.push({ ...chapter, text });
    }
    const isFull = chosen.length === book.chapters.length;
    const suffix = isFull ? '' : ` (${chosen[0].number}-${chosen.at(-1).number}화)`;
    const base = safeName(book.title) + suffix;
    const txt = `${book.title}\r\n${book.author}\r\n원문: ${book.url}\r\n\r\n` + chapters.map(ch => `${ch.label} · ${ch.title}\n\n${ch.text}`).join('\n\n\n' + '─'.repeat(30) + '\n\n\n').replace(/\n/g, '\r\n');
    await atomicWrite(path.join(this.folder(book), `${base}.txt`), '\uFEFF' + txt);
    await atomicWrite(path.join(this.folder(book), `${base}.epub`), createEpub(book, chapters));
    const result = { txt: `${base}.txt`, epub: `${base}.epub`, count: chosen.length, ids: chosen.map(ch => ch.id), createdAt: new Date().toISOString() };
    book.exports = result;
    await this.persist(book);
    return result;
  }
}
