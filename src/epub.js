import { zipSync, strToU8 } from 'fflate';
import { createHash } from 'node:crypto';

export const xml = value => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const xhtml = (title, body) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ko" lang="ko"><head><title>${xml(title)}</title><meta charset="utf-8"/><link rel="stylesheet" href="style.css"/></head><body>${body}</body></html>`;

export function createEpub(book, chapters) {
  if (!chapters.length || chapters.some(chapter => !chapter.text?.trim())) throw new Error('모든 선택 회차의 TXT가 있어야 EPUB을 만들 수 있습니다.');
  const id = `urn:sha256:${createHash('sha256').update(book.url + ':' + chapters.map(ch => ch.id).join(',')).digest('hex')}`;
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const title = xml(book.title), author = xml(book.author), source = xml(book.url);
  const entries = { mimetype: [strToU8('application/epub+zip'), { level: 0 }] };
  entries['META-INF/container.xml'] = strToU8('<?xml version="1.0" encoding="utf-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  entries['OEBPS/style.css'] = strToU8('body{font-family:serif;line-height:1.8;margin:5%;word-break:keep-all;overflow-wrap:break-word}h1{font-size:1.5em;line-height:1.5;margin-bottom:1.8em}p{margin:0 0 1em}a{color:inherit}.title-page{padding-top:15%;text-align:center}.meta{font-size:.9em;color:#666}nav ol{padding-left:1.4em}nav li{margin:.7em 0}');
  entries['OEBPS/title.xhtml'] = strToU8(xhtml(book.title, `<section class="title-page"><h1>${title}</h1><p>${author}</p><p class="meta">${chapters.length}개 회차</p><p class="meta">${xml(book.description).replace(/\n/g, '<br/>')}</p><p class="meta"><a href="${source}">원문 출처</a></p></section>`));
  const manifest = [], spine = [], toc = [], ncx = [];
  chapters.forEach((chapter, i) => {
    const name = `chapter-${String(i + 1).padStart(5, '0')}.xhtml`;
    const label = xml(`${chapter.label} · ${chapter.title}`);
    const paragraphs = chapter.text.trim().split(/\n\s*\n/).map(text => `<p>${xml(text).replace(/\n/g, '<br/>')}</p>`).join('\n');
    entries[`OEBPS/${name}`] = strToU8(xhtml(`${chapter.label} ${chapter.title}`, `<section epub:type="chapter"><h1>${label}</h1>${paragraphs}</section>`));
    manifest.push(`<item id="ch${i + 1}" href="${name}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="ch${i + 1}"/>`);
    toc.push(`<li><a href="${name}">${label}</a></li>`);
    ncx.push(`<navPoint id="point${i + 1}" playOrder="${i + 1}"><navLabel><text>${label}</text></navLabel><content src="${name}"/></navPoint>`);
  });
  entries['OEBPS/nav.xhtml'] = strToU8(xhtml('목차', `<nav epub:type="toc" id="toc"><h1>목차</h1><ol>${toc.join('')}</ol></nav>`));
  entries['OEBPS/toc.ncx'] = strToU8(`<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${id}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head><docTitle><text>${title}</text></docTitle><navMap>${ncx.join('')}</navMap></ncx>`);
  entries['OEBPS/content.opf'] = strToU8(`<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="ko"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">${id}</dc:identifier><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:language>ko</dc:language><dc:source>${source}</dc:source><dc:description>${xml(book.description)}</dc:description><meta property="dcterms:modified">${modified}</meta></metadata><manifest><item id="title" href="title.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="style.css" media-type="text/css"/>${manifest.join('')}</manifest><spine toc="ncx"><itemref idref="title"/>${spine.join('')}</spine></package>`);
  return zipSync(entries, { level: 6 });
}
