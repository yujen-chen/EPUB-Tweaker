import { decodeText, encodeText } from './archive';
import { EpubError } from './errors';
import type { BookModel } from './model';
import { elementsByLocalName, firstByLocalName, parseXml, serializeXml } from './xml';
import type { ReportEntry } from '../types';

export type Convert = (text: string) => string;

export const MIN_CHANGED_RATIO = 0.005;
export const MAX_TRADITIONAL_RATIO = 0.05;
export const TRADITIONAL_LANGUAGE = /^zh-(?:tw|hk|mo|hant)/i;

const XHTML_TYPES = new Set(['application/xhtml+xml', 'text/html']);
const SKIP_ELEMENTS = new Set(['script', 'style', 'rt', 'rp']);
const TEXT_ATTRIBUTES = ['alt', 'title'];
const DC_TEXT_TAGS = ['title', 'creator', 'contributor', 'publisher', 'description', 'subject'];
const CJK = /[㐀-鿿豈-﫿]/;
const LATIN = /[A-Za-z0-9]/;

let converterPromise: Promise<Convert> | undefined;

export function loadConverter(): Promise<Convert> {
  converterPromise ??= import('opencc-js/cn2t').then(({ Converter }) => Converter({ from: 'cn', to: 'twp' }));
  converterPromise.catch(() => { converterPromise = undefined; });
  return converterPromise;
}

export function toTwQuotes(text: string): { text: string; count: number } {
  let output = '';
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const previous = i > 0 ? text[i - 1] : '';
    const next = i + 1 < text.length ? text[i + 1] : '';
    if (char === '“') { output += '「'; count += 1; }
    else if (char === '”') { output += '」'; count += 1; }
    else if (char === '‘' && !LATIN.test(previous) && !LATIN.test(next)) { output += '『'; count += 1; }
    else if (char === '’' && !LATIN.test(previous) && !LATIN.test(next)) { output += '』'; count += 1; }
    else output += char;
  }
  return { text: output, count };
}

function createTextConverter(convert: Convert) {
  const state = { quotes: 0 };
  return {
    state,
    text(value: string): string {
      if (!value.trim()) return value;
      const quoted = toTwQuotes(convert(value));
      state.quotes += quoted.count;
      return quoted.text;
    }
  };
}

function xhtmlItems(book: BookModel) {
  return book.manifest.filter((item) => XHTML_TYPES.has(item.mediaType));
}

export function countCjk(book: BookModel): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of xhtmlItems(book)) {
    const data = book.files.get(item.path);
    if (!data) continue;
    const body = firstByLocalName(parseXml(decodeText(data), item.path), 'body');
    for (const char of body?.textContent ?? '') if (CJK.test(char)) counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  return counts;
}

export function changedRatio(counts: Map<string, number>, convert: Convert): number {
  let total = 0;
  let changed = 0;
  for (const [char, count] of counts) {
    total += count;
    if (convert(char) !== char) changed += count;
  }
  return changed / Math.max(total, 1);
}

export function assertSimplifiedSource(book: BookModel, convert: Convert): number {
  if (TRADITIONAL_LANGUAGE.test(book.language)) throw new EpubError('S2TW_NOT_SIMPLIFIED', `The book language is already Traditional Chinese (${book.language}).`);
  const counts = countCjk(book);
  if (!counts.size) throw new EpubError('S2TW_NOT_SIMPLIFIED', 'No Chinese text was found in this book.');
  const ratio = changedRatio(counts, convert);
  if (ratio < MIN_CHANGED_RATIO) throw new EpubError('S2TW_NOT_SIMPLIFIED', `Only ${(ratio * 100).toFixed(2)}% of Chinese characters are Simplified; the text looks Traditional already.`);
  return ratio;
}

export async function detectSimplifiedRatio(book: BookModel): Promise<number | undefined> {
  if (TRADITIONAL_LANGUAGE.test(book.language) || (book.language && !/^zh/i.test(book.language))) return undefined;
  const counts = countCjk(book);
  if (!counts.size) return undefined;
  try {
    return changedRatio(counts, await loadConverter());
  } catch {
    return undefined;
  }
}

function convertTree(element: Element, tx: ReturnType<typeof createTextConverter>): void {
  for (const attribute of TEXT_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value) element.setAttribute(attribute, tx.text(value));
  }
  const name = element.localName || element.nodeName.split(':').pop() || '';
  if (SKIP_ELEMENTS.has(name)) return;
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 3) (child as Text).data = tx.text((child as Text).data);
    else if (child.nodeType === 1) convertTree(child as Element, tx);
  }
}

export function applyS2tw(book: BookModel, entries: ReportEntry[], s2tw: { convert: Convert; ratio: number }): void {
  const tx = createTextConverter(s2tw.convert);
  const metadata = firstByLocalName(book.packageDocument, 'metadata');
  if (metadata) {
    for (const tag of DC_TEXT_TAGS) {
      for (const element of elementsByLocalName(metadata, tag)) element.textContent = tx.text(element.textContent ?? '');
    }
    for (const meta of elementsByLocalName(metadata, 'meta')) {
      if (meta.getAttribute('property') === 'file-as') meta.textContent = tx.text(meta.textContent ?? '');
      const name = meta.getAttribute('name');
      const content = meta.getAttribute('content');
      if ((name === 'calibre:title_sort' || name === 'calibre:series') && content) meta.setAttribute('content', tx.text(content));
    }
    const language = firstByLocalName(metadata, 'language');
    if (language) language.textContent = 'zh-TW';
    else {
      const element = book.packageDocument.createElementNS('http://purl.org/dc/elements/1.1/', 'dc:language');
      element.textContent = 'zh-TW';
      metadata.appendChild(element);
    }
  }
  book.language = 'zh-TW';
  let docs = 0;
  let hasEmbeddedFonts = false;
  for (const item of xhtmlItems(book)) {
    const data = book.files.get(item.path);
    if (!data) continue;
    const source = decodeText(data);
    if (/@font-face/i.test(source)) hasEmbeddedFonts = true;
    const document = parseXml(source, item.path);
    convertTree(document.documentElement, tx);
    document.documentElement.setAttribute('lang', 'zh-TW');
    document.documentElement.setAttribute('xml:lang', 'zh-TW');
    book.files.set(item.path, encodeText(serializeXml(document)));
    docs += 1;
  }
  for (const item of book.manifest.filter((entry) => entry.mediaType === 'application/x-dtbncx+xml')) {
    const data = book.files.get(item.path);
    if (!data) continue;
    const document = parseXml(decodeText(data), item.path);
    for (const element of elementsByLocalName(document, 'text')) element.textContent = tx.text(element.textContent ?? '');
    book.files.set(item.path, encodeText(serializeXml(document)));
    docs += 1;
  }
  for (const item of book.manifest.filter((entry) => entry.mediaType === 'text/css')) {
    const data = book.files.get(item.path);
    if (data && /@font-face/i.test(decodeText(data))) hasEmbeddedFonts = true;
  }
  entries.push({
    rule: 's2tw', kind: 'tweak', path: book.packagePath,
    message: `Converted ${docs} content documents to Traditional Chinese (Taiwan); ${tx.state.quotes} quote marks changed; ${(s2tw.ratio * 100).toFixed(2)}% of CJK characters were Simplified.`, count: docs
  });
  if (hasEmbeddedFonts) entries.push({
    rule: 's2tw-embedded-font', kind: 'warning', path: book.packagePath,
    message: 'This book embeds fonts; subset fonts from Simplified books may lack Traditional glyphs.', code: 'S2TW_EMBEDDED_FONT'
  });
}
