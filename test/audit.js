import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { XMLValidator } from 'fast-xml-parser';
import { load } from 'cheerio';
import { Library } from '../src/storage.js';
import { dataRoot } from '../src/paths.js';

const key = process.argv[2];
if (!key || path.basename(key) !== key) throw new Error('사용법: node test/audit.js "작품명_ID"');
const library = new Library(path.join(dataRoot, 'library'));
const book = (await library.list()).find(b => path.basename(library.folder(b)) === key);
assert.ok(book, 'Book must exist');
assert.equal(book.exports.count, book.chapters.length, 'Audit requires the complete book');
const file = path.join(library.folder(book), book.exports.epub);
const bytes = await fs.readFile(file), zip = unzipSync(bytes);
assert.equal(bytes.readUInt32LE(0), 0x04034b50);
assert.equal(bytes.readUInt16LE(8), 0, 'mimetype must be stored without compression');
assert.equal(bytes.subarray(30, 38).toString(), 'mimetype');
assert.equal(strFromU8(zip.mimetype), 'application/epub+zip');
let xmlFiles = 0, characters = 0;
for (const [name, content] of Object.entries(zip)) {
  if (/\.(xml|opf|ncx|xhtml)$/.test(name)) { assert.equal(XMLValidator.validate(strFromU8(content)), true, name); xmlFiles++; }
}
const opf = load(strFromU8(zip['OEBPS/content.opf']), { xmlMode: true });
const nav = load(strFromU8(zip['OEBPS/nav.xhtml']), { xmlMode: true });
assert.equal(opf('spine itemref').length, book.chapters.length + 1);
assert.equal(nav('nav li').length, book.chapters.length);
for (const element of opf('manifest item').toArray()) assert.ok(zip[`OEBPS/${opf(element).attr('href')}`]);
for (let index = 0; index < book.chapters.length; index++) {
  const chapter = book.chapters[index];
  const text = await library.readChapter(book, chapter);
  assert.ok(text, `Missing/corrupt TXT: ${chapter.number}`); characters += text.length;
  const name = `chapter-${String(index + 1).padStart(5, '0')}.xhtml`;
  const $ = load(strFromU8(zip[`OEBPS/${name}`]), { xmlMode: true });
  $('br').replaceWith('\n');
  const epubText = $('section > p').toArray().map(p => $(p).text()).join('\n\n');
  assert.equal(epubText.replace(/\n\s*\n/g, '\n\n'), text.replace(/\n\s*\n/g, '\n\n'), `TXT/EPUB text mismatch: ${chapter.number}`);
}
const result = { title: book.title, chapters: book.chapters.length, verifiedTxt: book.chapters.length, epubChapters: nav('nav li').length, validXmlFiles: xmlFiles, textCharacters: characters, epubBytes: bytes.length, txtPath: path.join(library.folder(book), book.exports.txt), epubPath: file, verifiedAt: new Date().toISOString() };
console.log(JSON.stringify(result, null, 2));
