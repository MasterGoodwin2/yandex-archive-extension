// node tests/run_links.js — проверка разбора ссылок (HTML, GEDCOM), очистки «?center=» и удаления дубликатов
const assert = require('assert');
const L = require('../links-tools.js');
const A = '3aa266f8-a0ed-434d-bd5d-c095d45efc1b', B = 'bfed2966-e671-4c18-bbb0-a9551ad28f8e';

// 1. одна страница, ?center=, yandex.ru и ya.ru — одна и та же страница
let p = L.parseArchiveUrl(`https://ya.ru/archive/catalog/${A}/866?center=0.52,0.31&zoom=3`);
assert.deepStrictEqual([p.status, p.fileId, p.pages], ['ok', A, [866]]);
p = L.parseArchiveUrl(`https://yandex.ru/archive/catalog/${A}/866/`);
assert.deepStrictEqual(p.pages, [866]);
// 2. диапазон в ссылке поиска
p = L.parseArchiveUrl(`https://ya.ru/archive/search?query=x&fileId=${B}&sheet_page_from=163&sheet_page_to=165`, { expandRange: true });
assert.deepStrictEqual(p.pages, [163, 164, 165]);
p = L.parseArchiveUrl(`https://ya.ru/archive/search?fileId=${B}&sheet_page_from=7`);
assert.deepStrictEqual(p.pages, [7]);
p = L.parseArchiveUrl(`https://ya.ru/archive/search?fileId=${B}&sheet_page_from=9&sheet_page_to=7`, { expandRange: true });
assert.deepStrictEqual(p.pages, [7, 8, 9]);
// 3. пропускаемые
assert.strictEqual(L.parseArchiveUrl(`https://ya.ru/archive/catalog/${A}`).status, 'skip');
assert.strictEqual(L.parseArchiveUrl('https://ya.ru/maps').status, 'skip');
assert.strictEqual(L.parseArchiveUrl('https://example.com/archive/catalog/x/1').status, 'skip');

// 4. HTML: href + текст, &amp;, дубликаты
const html = `<p>1850 <a href="https://ya.ru/archive/catalog/${B}/165?center=1,2&amp;zoom=2">стр</a></p>
<p><a href="https://ya.ru/archive/catalog/${B}/165">та же</a></p>
<p><a href="https://yandex.ru/archive/catalog/${B}/166?center=3">другая</a> текст https://ya.ru/archive/catalog/${A}/1.</p>
<p><a href="https://ya.ru/archive/search?fileId=${B}&amp;sheet_page_from=165&amp;sheet_page_to=167">диапазон</a></p>
<p><a href="https://ya.ru/archive/catalog/${A}">дело</a></p>`;
const src = L.htmlLinks(html);
assert.strictEqual(src.length, 6);   // 5 href + 1 в тексте
const plan = L.buildPlan(src, { expandRange: true });
assert.deepStrictEqual(plan.unique.map((u) => u.key), [`${B}:165`, `${B}:166`, `${A}:1`, `${B}:167`]);
assert.strictEqual(plan.unique[0].origs.length, 3);   // две ссылки на страницу + диапазон, в который она входит
assert.ok(plan.unique[0].origs[0].includes('center=1,2&zoom=2'), 'исходная ссылка сохраняется как есть, &amp; раскодирован');
assert.deepStrictEqual(plan.entries.map((e) => e.status.split(';')[0]),
  ['страница', 'дубликат (страница уже в списке)', 'страница', 'страница', 'диапазон: 3 стр.', 'пропущена: в ссылке нет номера страницы (это дело/опись целиком)']);
assert.ok(!L.fixedHtml(plan).includes('center'));
assert.strictEqual((L.fixedHtml(plan).match(/<a /g) || []).length, 4);

// 5. GEDCOM: CONC разрывает ссылку, CONT, @-записи, кириллица в имени, чужие домены игнорируются
const ged = [
  '0 HEAD', '1 CHAR UTF-8',
  '0 @I1@ INDI', '1 NAME Иван /Ладыгин/', '1 NOTE Ревизская сказка https://ya.ru/archive/catalog/' + B + '/16',
  '2 CONC 5?center=0.1,0.2 и ещё', '2 CONT см. https://example.com/x и https://www.yandex.ru/archive/catalog/' + A + '/9).',
  '0 @S1@ SOUR', '1 WWW https://ya.ru/archive/catalog/' + B + '/165', '0 TRLR'].join('\r\n');
const gl = L.gedcomLinks(ged);
assert.deepStrictEqual(gl.map((x) => x.url), [`https://ya.ru/archive/catalog/${B}/165?center=0.1,0.2`, `https://www.yandex.ru/archive/catalog/${A}/9`, `https://ya.ru/archive/catalog/${B}/165`]);
assert.ok(gl[0].where.includes('@I1@') && gl[0].where.includes('Иван Ладыгин') && gl[0].where.includes('NOTE'), gl[0].where);
const gp = L.buildPlan(gl);
assert.strictEqual(gp.unique.length, 2);
assert.strictEqual(gp.unique[0].origs.length, 2);

// 6. кодировки
const enc = (s, e) => e === 'u16' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]) : Buffer.from(s, 'utf8');
assert.strictEqual(L.decodeBytes(enc('0 HEAD\nИван', 'u16')), '0 HEAD\nИван');
assert.strictEqual(L.decodeBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), enc('Иван')])), 'Иван');
assert.strictEqual(L.decodeBytes(new TextEncoder().encode('0 HEAD')), '0 HEAD');
assert.strictEqual(L.decodeBytes(Buffer.from([0xc8, 0xe2, 0xe0, 0xed])), 'Иван');   // windows-1251

// 7. листы Excel
const meta = { [plan.unique[0].clean]: { cga: 'ЦГА Москвы/Фонд 51/Опись 8/Дело 588/Скан 165', docType: 'Ревизская сказка от 1850 года', scanName: 'a.jpg', scanFile: 'Archive_Scans/a.jpg', scanLocal: '/Volumes/DATA/Archive_Scans/a.jpg', scanHref: 'file:///Volumes/DATA/Archive_Scans/a.jpg' },
  [plan.unique[1].clean]: { err: 'нет данных' } };
const sh = L.sheets(plan, meta);
const H = ['Ссылка на страницу', 'Очищенная ссылка', 'Локальная Ссылка на страницу', 'Архив хранения документа', 'Тип документа', 'Статус скана'];
assert.deepStrictEqual(sh[0].rows[0], H);
assert.deepStrictEqual(sh[0].rows[1].slice(1), [plan.unique[0].clean, '/Volumes/DATA/Archive_Scans/a.jpg', 'ЦГА Москвы/Фонд 51/Опись 8/Дело 588/Скан 165', 'Ревизская сказка от 1850 года', 'сохранён']);
assert.deepStrictEqual([sh[0].rows[2][2], sh[0].rows[2][5]], ['', 'не скачан: нет данных']);
assert.strictEqual(sh[0].rows.length, 5);
assert.strictEqual(sh[1].rows.length, 1 + 6);
// CSV: UTF-8 с BOM, «;», кавычки, CRLF
const cs = L.csv([['a;b', 'в "кавычках"', 'Иван'], ['x', '', 'y\nz']]);
assert.strictEqual(cs, '﻿"a;b";"в ""кавычках""";Иван\r\nx;;"y\nz"\r\n');
assert.ok(L.csvFiles(plan, meta).main.startsWith('﻿Ссылка на страницу;Очищенная ссылка;'));
// 8. GEDCOM: «Имя персоны» (INDI — имя; FAM — супруги; SOUR — кто ссылается)
const gedP = ['0 HEAD', '0 @I1@ INDI', '1 NAME Иван /Ладыгин/', '1 SOUR @S1@', '0 @I2@ INDI', '1 NAME Анна /Ладыгина/',
  '1 NOTE https://ya.ru/archive/catalog/bfed2966-e671-4c18-bbb0-a9551ad28f8e/165', '0 @F1@ FAM', '1 HUSB @I1@', '1 WIFE @I2@',
  '1 NOTE https://ya.ru/archive/catalog/3aa266f8-a0ed-434d-bd5d-c095d45efc1b/866', '0 @S1@ SOUR',
  '1 TITL https://ya.ru/archive/catalog/3aa266f8-a0ed-434d-bd5d-c095d45efc1b/865', '0 TRLR'].join('\n');
const glP = L.gedcomLinks(gedP);
assert.deepStrictEqual(glP.map((x) => x.person), ['Анна Ладыгина', 'Иван Ладыгин и Анна Ладыгина', 'Иван Ладыгин']);
const gpP = L.buildPlan(glP);
assert.ok(gpP.gedcom);
const gsP = L.sheets(gpP, {});
assert.deepStrictEqual(gsP[0].rows[0], ['ID персоны (INDI)', 'Имя персоны'].concat(H));
assert.deepStrictEqual(gsP[0].rows[1].slice(0, 2), ['@I2@', 'Анна Ладыгина']);
assert.deepStrictEqual(gsP[0].rows[2].slice(0, 2), ['@I1@; @I2@', 'Иван Ладыгин и Анна Ладыгина']);   // ссылка в семье FAM — оба супруга
assert.deepStrictEqual(gsP[1].rows[0].slice(0, 2), ['ID персоны (INDI)', 'Имя персоны']);
assert.deepStrictEqual(gsP[1].rows[1].slice(0, 2), ['@I2@', 'Анна Ладыгина']);
assert.strictEqual(L.sheets(L.buildPlan(L.htmlLinks('<a href="https://ya.ru/archive/catalog/3aa266f8-a0ed-434d-bd5d-c095d45efc1b/865">x</a>')), {})[0].rows[0][0], 'Ссылка на страницу');
// 9. по умолчанию диапазон из ссылки поиска не разворачивается: берётся страница, на которую указывает ссылка
const rg = L.parseArchiveUrl(`https://ya.ru/archive/search?query=x&fileId=${B}&sheet_page_from=163&sheet_page_to=165`);
assert.deepStrictEqual(rg.pages, [163]); assert.ok(rg.note.includes('163–165'), rg.note);
assert.strictEqual(L.buildPlan([{ url: `https://ya.ru/archive/search?fileId=${B}&sheet_page_from=163&sheet_page_to=165` }]).unique.length, 1);
assert.strictEqual(L.parseArchiveUrl(`https://ya.ru/archive/catalog/${B}/7`, { expandRange: true }).pages.length, 1);   // обычная ссылка — всегда одна страница
// 10. слипшиеся ссылки делятся; каждая записывается той же персоне
const C = '16bdb517-fd1b-48ef-ae9d-849b589108f5', u = (i, n) => `https://ya.ru/archive/catalog/${i}/${n}`;
for (const val of [`${u(A, 7)}; ${u(B, 278)}; ${u(C, 242)}; `, `${u(A, 7)};${u(B, 278)};${u(C, 242)};`, `${u(A, 7)}${u(B, 278)}${u(C, 242)}`,
  `${u(A, 7)}?center=0.5,0.4;${u(B, 278)}?center=0.1,0.2&zoom=3;${u(C, 242)}`, `${u(A, 7)},${u(B, 278)} https://example.com/x;${u(C, 242)}`]) {
  const g = L.gedcomLinks(['0 @I1@ INDI', '1 NAME Иван /Ладыгин/', '1 NOTE ' + val, '0 TRLR'].join('\n'));
  assert.strictEqual(g.length, 3, val);
  const pl = L.buildPlan(g);
  assert.deepStrictEqual(pl.unique.map((x) => x.page), [7, 278, 242], val);
  assert.ok(pl.unique.every((x) => x.persons[0] === 'Иван Ладыгин' && x.xrefs[0] === '@I1@'));
}
// слипание через CONC без пробела
assert.strictEqual(L.gedcomLinks(['0 @I1@ INDI', '1 NOTE ' + u(A, 7) + ';', '2 CONC ' + u(B, 278) + ';', '0 TRLR'].join('\n')).length, 2);
assert.strictEqual(L.htmlLinks(`<p>${u(A, 7)};${u(B, 278)}</p>`).length, 2);
console.log('links: OK');
