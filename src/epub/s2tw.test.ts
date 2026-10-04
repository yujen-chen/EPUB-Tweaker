import { beforeAll, describe, expect, it } from 'vitest';
import { decodeText, openArchiveSync } from './archive';
import { inspectEpub, processEpub } from './process';
import { parseBook } from './parser';
import { changedRatio, countCjk, loadConverter, MAX_TRADITIONAL_RATIO, MIN_CHANGED_RATIO, toTwQuotes, type Convert } from './s2tw';
import { syntheticEpub } from '../test/fixtures';

const defaults = { vertical: false, horizontal: false, japaneseMode: false, s2tw: false, progression: 'auto' as const, imageMappings: {} };

let convert: Convert;
beforeAll(async () => {
  convert = await loadConverter();
});

describe('toTwQuotes', () => {
  it('converts double quotes', () => {
    expect(toTwQuotes('“你好，”他說。')).toEqual({ text: '「你好，」他說。', count: 2 });
  });

  it('converts inner single quotes', () => {
    expect(toTwQuotes('“他說‘走吧’。”').text).toBe('「他說『走吧』。」');
  });

  it('keeps apostrophes next to Latin characters', () => {
    expect(toTwQuotes('don’t and students’ books')).toEqual({ text: 'don’t and students’ books', count: 0 });
    expect(toTwQuotes('‘Hello’').text).toBe('‘Hello’');
  });
});

it('matches the expected Taiwan vocabulary', () => {
  expect(convert('这个软件的信息，')).toBe('這個軟體的資訊，');
  expect(convert('出租车')).toBe('計程車');
});

it('converts XHTML, OPF metadata and NCX through processEpub', async () => {
  const input = syntheticEpub({ language: 'zh-CN', version: 2, title: '软件', navLabel: '信息', bodyHtml: '<p title="软件" class="x">“这个软件的信息，”他说。</p>' });
  const result = await processEpub('book.epub', input, { ...defaults, s2tw: true });
  const files = openArchiveSync(result.output);
  const chapter = decodeText(files.get('OEBPS/chapter.xhtml')!);
  expect(chapter).toContain('「這個軟體的資訊，」他說。');
  expect(chapter).toContain('title="軟體"');
  expect(chapter).toContain('lang="zh-TW"');
  expect(chapter).toContain('xml:lang="zh-TW"');
  expect(chapter).toContain('id="reading"');
  const packageText = decodeText(files.get('OEBPS/content.opf')!);
  expect(packageText).toContain('<dc:title>軟體</dc:title>');
  expect(packageText).toContain('<dc:language>zh-TW</dc:language>');
  expect(packageText).toContain('urn:uuid:fixture');
  expect(decodeText(files.get('OEBPS/toc.ncx')!)).toContain('<text>資訊</text>');
  expect(result.report.entries.some((entry) => entry.rule === 's2tw')).toBe(true);
});

it('skips script, style and rt contents', async () => {
  const input = syntheticEpub({ language: 'zh-CN', version: 2, bodyHtml: '<ruby>汉<rt>软件</rt></ruby><script>var s="软件";</script>' });
  const result = await processEpub('book.epub', input, { ...defaults, s2tw: true });
  const chapter = decodeText(openArchiveSync(result.output).get('OEBPS/chapter.xhtml')!);
  expect(chapter).toContain('<rt>软件</rt>');
  expect(chapter).toContain('var s="软件";');
  expect(chapter).toContain('漢');
});

it('leaves blank text nodes untouched', async () => {
  const input = syntheticEpub({ language: 'zh-CN', version: 2, bodyHtml: '<p>  </p><p>这里</p>' });
  const result = await processEpub('book.epub', input, { ...defaults, s2tw: true });
  const chapter = decodeText(openArchiveSync(result.output).get('OEBPS/chapter.xhtml')!);
  expect(chapter).toContain('<p>  </p>');
  expect(chapter).toContain('<p>這裡</p>');
});

it('computes the per-character changed ratio', () => {
  const simplified = parseBook(openArchiveSync(syntheticEpub({ bodyHtml: '<p>我们坐出租车去学校，这里的书很多。</p>' })));
  expect(changedRatio(countCjk(simplified), convert)).toBeGreaterThan(MAX_TRADITIONAL_RATIO);
  const traditional = parseBook(openArchiveSync(syntheticEpub({ bodyHtml: `<p>${'我們坐計程車去學校，這裡的書很多。'.repeat(20)}</p>` })));
  expect(changedRatio(countCjk(traditional), convert)).toBeLessThan(MIN_CHANGED_RATIO);
});

it('refuses books that are not Simplified', async () => {
  await expect(processEpub('tw.epub', syntheticEpub({ language: 'zh-TW' }), { ...defaults, s2tw: true })).rejects.toMatchObject({ code: 'S2TW_NOT_SIMPLIFIED' });
  await expect(processEpub('zh.epub', syntheticEpub({ language: 'zh', bodyHtml: `<p>${'我們坐計程車去學校，這裡的書很多。'.repeat(20)}</p>` }), { ...defaults, s2tw: true })).rejects.toMatchObject({ code: 'S2TW_NOT_SIMPLIFIED' });
  await expect(processEpub('en.epub', syntheticEpub(), { ...defaults, s2tw: true })).rejects.toMatchObject({ code: 'S2TW_NOT_SIMPLIFIED' });
});

it('combines s2tw with Japanese mode', async () => {
  const input = syntheticEpub({ language: 'zh-CN', version: 2, bodyHtml: '<p>这里的书</p>' });
  const result = await processEpub('book.epub', input, { ...defaults, s2tw: true, japaneseMode: true });
  expect(result.info.language).toBe('ja');
  expect(result.report.languageBefore).toBe('zh-CN');
  expect(decodeText(openArchiveSync(result.output).get('OEBPS/chapter.xhtml')!)).toContain('這裡的書');
});

it('converts the output filename unless a custom name is given', async () => {
  const input = syntheticEpub({ language: 'zh-CN', version: 2, bodyHtml: '<p>这里</p>' });
  const result = await processEpub('软件.epub', input, { ...defaults, s2tw: true });
  expect(result.outputName).toBe('軟體-tweaked.epub');
  const custom = await processEpub('软件.epub', input, { ...defaults, s2tw: true, outputName: '自訂' });
  expect(custom.outputName).toBe('自訂.epub');
});

it('detects the simplified ratio at inspect time', async () => {
  const info = await inspectEpub(syntheticEpub({ language: 'zh-CN', version: 2, bodyHtml: '<p>我们坐出租车去学校</p>' }));
  expect(info.simplifiedRatio).toBeGreaterThan(MAX_TRADITIONAL_RATIO);
  expect((await inspectEpub(syntheticEpub())).simplifiedRatio).toBeUndefined();
});

it('leaves books untouched when the option is off', async () => {
  const input = syntheticEpub({ language: 'zh-CN', version: 2, bodyHtml: '<p>这里</p>' });
  const result = await processEpub('book.epub', input, defaults);
  expect(result.report.entries.some((entry) => entry.rule === 's2tw')).toBe(false);
  expect(decodeText(openArchiveSync(result.output).get('OEBPS/chapter.xhtml')!)).toContain('这里');
});

it('converts the EPUB 3 navigation document and the NCX docTitle', async () => {
  const epub3 = await processEpub('book.epub', syntheticEpub({ language: 'zh-CN', version: 3, navLabel: '信息', bodyHtml: '<p>这里</p>' }), { ...defaults, s2tw: true });
  const nav = decodeText(openArchiveSync(epub3.output).get('OEBPS/nav.xhtml')!);
  expect(nav).toContain('>資訊</a>');
  expect(nav).toContain('lang="zh-TW"');
  const epub2 = await processEpub('book.epub', syntheticEpub({ language: 'zh-CN', version: 2, title: '软件', bodyHtml: '<p>这里</p>' }), { ...defaults, s2tw: true });
  expect(decodeText(openArchiveSync(epub2.output).get('OEBPS/toc.ncx')!)).toContain('<docTitle><text>軟體</text></docTitle>');
});

it('converts file-as, calibre metadata and descriptive Dublin Core fields only', async () => {
  const metadataExtras = '<dc:description>这个软件</dc:description><meta property="file-as">软件</meta><meta name="calibre:series" content="软件系列"/><meta name="calibre:title_sort" content="软件"/><meta name="calibre:other" content="软件"/>';
  const result = await processEpub('book.epub', syntheticEpub({ language: 'zh-CN', metadataExtras, bodyHtml: '<p>这里</p>' }), { ...defaults, s2tw: true });
  const packageText = decodeText(openArchiveSync(result.output).get('OEBPS/content.opf')!);
  expect(packageText).toContain('<dc:description>這個軟體</dc:description>');
  expect(packageText).toContain('<meta property="file-as">軟體</meta>');
  expect(packageText).toContain('name="calibre:series" content="軟體系列"');
  expect(packageText).toContain('name="calibre:title_sort" content="軟體"');
  expect(packageText).toContain('name="calibre:other" content="软件"');
});

it('warns about embedded fonts only when the book declares @font-face', async () => {
  const fontHtml = '<p>这里</p><style>@font-face{font-family:"X";src:url(x.ttf)}</style>';
  const withFont = await processEpub('book.epub', syntheticEpub({ language: 'zh-CN', bodyHtml: fontHtml }), { ...defaults, s2tw: true });
  expect(withFont.report.entries.some((entry) => entry.rule === 's2tw-embedded-font' && entry.kind === 'warning')).toBe(true);
  expect(decodeText(openArchiveSync(withFont.output).get('OEBPS/chapter.xhtml')!)).toContain('font-family:"X"');
  const withoutFont = await processEpub('book.epub', syntheticEpub({ language: 'zh-CN', bodyHtml: '<p>这里</p>' }), { ...defaults, s2tw: true });
  expect(withoutFont.report.entries.some((entry) => entry.rule === 's2tw-embedded-font')).toBe(false);
});

it('refuses a second conversion of its own output', async () => {
  const first = await processEpub('book.epub', syntheticEpub({ language: 'zh-CN', bodyHtml: '<p>这里的书很多</p>' }), { ...defaults, s2tw: true });
  await expect(processEpub(first.outputName, first.output, { ...defaults, s2tw: true })).rejects.toMatchObject({ code: 'S2TW_NOT_SIMPLIFIED' });
});
