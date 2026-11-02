#!/usr/bin/env node
// Пересборка result.xlsx из отладочного пакета запуска — без повторной загрузки страниц.
// Берёт run_summary.json и <год>_<док>_p<стр>_next_data.json из папки yaarchive_debug/<дата_время>/ и прогоняет
// их через текущие confession-rows.js / revision-rows.js / layout.js и тот же модуль листов (excel-sheets.js),
// что и расширение. Так новая версия алгоритма применяется к уже собранным страницам.
//
// Запуск: node tools/rebuild_from_debug.js <папка yaarchive_debug/дата_время> [result.xlsx] [--format confession|revision] [--scans <папка Archive_Scans>]
//   --format — вид результата в Excel (по умолчанию как тип обработки запуска).
// Сканы: если в папке сканов (по умолчанию /Volumes/DATA/Archive_Scans/, параметр --scans <папка>) есть <файл>.jpg,
// в Excel «Локальная Ссылка на страницу» = локальный путь + имя файла (ссылка file://…).
const fs = require('fs'), path = require('path');
const X = path.join(__dirname, '..');
global.Logic = require(path.join(X, 'logic.js'));
global.ConfessionRows = require(path.join(X, 'confession-rows.js'));
global.RevisionRows = require(path.join(X, 'revision-rows.js'));
const Layout = require(path.join(X, 'layout.js'));
const XlsxWriter = require(path.join(X, 'xlsx-writer.js'));
const ExcelSheets = require(path.join(X, 'excel-sheets.js'));
const version = JSON.parse(fs.readFileSync(path.join(X, 'manifest.json'), 'utf8')).version;

const args = process.argv.slice(2);
const fi = args.indexOf('--format');
const format = fi >= 0 ? args.splice(fi, 2)[1] : '';
const si = args.indexOf('--scans');
const scansArg = si >= 0 ? args.splice(si, 2)[1] : '';
const dir = args[0];
if (!dir) { console.error('Укажите папку отладочного пакета (yaarchive_debug/<дата_время>).'); process.exit(2); }
const outFile = args[1] || path.join(dir, `result_${version.replace(/\./g, '_')}.xlsx`);
const summary = JSON.parse(fs.readFileSync(path.join(dir, 'run_summary.json'), 'utf8'));
const mode = summary.mode === 'revision' ? 'revision' : 'confession';
const outFormat = format === 'revision' || format === 'confession' ? format : mode;
// Локальный путь к папке сканов — по умолчанию /Volumes/DATA/Archive_Scans/ (параметр --scans <папка>)
const scanDir = (scansArg || '/Volumes/DATA/Archive_Scans').replace(/\/+$/, '');

// страницы по файлам _next_data.json: ключ «год|первые 8 символов fileId|страница»
const nodes = new Map();
for (const f of fs.readdirSync(dir)) {
  const m = f.match(/^(\d{4}|год)_([0-9a-f]{8})_p(\d+)_next_data\.json$/);
  if (m) nodes.set(`${m[1]}|${m[2]}|${m[3]}`, f);
}

const rowRecords = [], blockRecords = [], sheetRows = [], linkRows = [], families = [], pageMeta = {};
for (const link of summary.links) {
  const [year, url, rng] = link;
  const [lo, hi] = String(rng).split(/[–-]/).map((v) => parseInt(v, 10));
  const seen = new Set();
  const pages = summary.pages
    .filter((p) => p.year === year && url.includes(p.fileId) && p.page >= lo && p.page <= (hi || lo))
    .filter((p) => (seen.has(p.page) ? false : seen.add(p.page)))
    .sort((a, b) => a.page - b.page);
  const st = Layout.newState(), fams = [], hows = new Set(), foundAll = new Set();
  for (const pg of pages) {
    const f = nodes.get(`${year || 'год'}|${String(pg.fileId).slice(0, 8)}|${pg.page}`);
    if (!f) { sheetRows.push({ year, page: pg.page, found: '', url: pg.url, text: 'нет файла данных страницы в пакете', check: '' }); continue; }
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const node = d.props.pageProps.currentNode;
    // путь «ЦГА Москвы / Фонд / Опись / Дело / Скан» и имя файла скана (данные страницы версии 2.0+ содержат crumbs)
    if (node.crumbs && node.crumbs.length) {
      const ci = ExcelSheets.crumbInfo(node.crumbs, pg.page, node.id, new URL(pg.url).origin);
      const meta = { cga: ci.cga, cgaUrl: ci.cgaUrl, scanName: ci.scanName };
      if (fs.existsSync(path.join(scanDir, ci.scanName))) {
        Object.assign(meta, { scanFile: `Archive_Scans/${ci.scanName}`, scanLocal: `${scanDir}/${ci.scanName}`, scanHref: `file://${encodeURI(scanDir)}/${encodeURIComponent(ci.scanName)}` });
      }
      pageMeta[pg.url] = meta;
    }
    const text = node.textBlocks.map((t) => String(t.text || '').trim()).filter(Boolean).join('\n');
    const found = new Set(Logic.findSettlements(text, mode));
    st.lastRep = null;
    const how = mode === 'confession'
      ? Layout.processConfessionNode(node, { url: pg.url, page: pg.page, year }, st, mode, fams)
      : Layout.processNode(node, { url: pg.url, page: pg.page }, st, mode, fams);
    if (st.lastRep) for (const mk of st.lastRep.settlement_marks) if (!String(mk.name).startsWith('other:')) found.add(mk.name);
    found.forEach((x) => foundAll.add(x));
    sheetRows.push({ year, page: pg.page, found: [...found].sort().join('; '), url: pg.url, text, check: st.checks[pg.page] || '' });
    if (how) hows.add(how);
  }
  Layout.finish(st, fams);
  fams.forEach((f) => { f.year = year; });
  families.push(...fams);
  st.rows.forEach((r) => rowRecords.push(Object.assign({ year }, r)));
  (st.blocks || []).forEach((b) => blockRecords.push(Object.assign({ year }, b)));
  const persons = mode === 'confession'
    ? fams.reduce((acc, f) => acc + f.persons.reduce((a, p) => a + (p.rows && p.rows.length ? p.rows.length : 1), 0), 0)
    : fams.reduce((acc, f) => acc + f.persons.length, 0);
  linkRows.push([year, url, rng, pages.length, foundAll.size, [...foundAll].sort().join('; '), link[6], fams.length, persons,
    `пересобрано версией ${version} из отладочного пакета`,
    [st.skipped.length ? `страницы без таблицы: ${st.skipped.join(', ')}` : ''].filter(Boolean).join('; ')]);
}

const sheets = ExcelSheets.build({ processMode: mode, outFormat, families, rowRecords, blockRecords, sheetRows, linkRows, pageMeta },
  { ConfessionRows, Layout, STYLE: XlsxWriter.STYLE });
XlsxWriter.build(sheets).then((bytes) => {
  fs.writeFileSync(outFile, Buffer.from(bytes));
  const scans = Object.values(pageMeta).filter((m) => m.scanFile).length;
  console.log(`Готово: ${outFile} — вид «${Logic.MODES[outFormat].label}», ссылок ${linkRows.length}, страниц ${sheetRows.length}, ` +
    `дворов ${families.length}, строк людей ${rowRecords.length}, путей ЦГА ${Object.keys(pageMeta).length}, сканов ${scans}`);
});
