// node tests/run_gedcom_writer.js — запись ссылок на сканы в .ged (навык «Запись в GEDCOM»)
const assert = require('assert'), path = require('path');
const L = require(path.join(__dirname, '..', 'links-tools.js'));
const W = require(path.join(__dirname, '..', 'gedcom-writer.js'));
const B = 'bfed2966-e671-4c18-bbb0-a9551ad28f8e', A = '3aa266f8-a0ed-434d-bd5d-c095d45efc1b';
const ged = ['0 HEAD', '1 CHAR ANSI', '0 @I1@ INDI', '1 NAME Иван /Ладыгин/', '1 SOUR @S1@', '0 @I2@ INDI', '1 NAME Анна /Ладыгина/',
  `1 NOTE https://ya.ru/archive/catalog/${B}/165`, '0 @F1@ FAM', '1 HUSB @I1@', '1 WIFE @I2@',
  `1 NOTE https://ya.ru/archive/catalog/${A}/866`, '0 @S1@ SOUR', `1 TITL https://ya.ru/archive/catalog/${A}/865`,
  `0 @N1@ NOTE https://ya.ru/archive/catalog/${A}/9`, '0 TRLR'].join('\r\n');
const plan = L.buildPlan(L.gedcomLinks(ged));
const byPage = (p) => plan.unique.find((u) => u.page === p);
assert.deepStrictEqual(byPage(866).xrefs, ['@I1@', '@I2@']);
assert.deepStrictEqual(byPage(865).xrefs, ['@I1@']);
assert.deepStrictEqual(byPage(9).xrefs, []);
const meta = {};
for (const [p, dt] of [[165, 'Ревизская сказка от 1850 года'], [866, 'Исповедническая ведомость 1750 года']]) {
  const u = byPage(p);
  meta[u.clean] = { cga: 'ЦГА Москвы/Фонд 51/Опись 8/Дело 588/Скан ' + p, docType: dt, scanName: `s${p}.jpg`, scanLocal: `/Volumes/DATA/Archive_Scans/s${p}.jpg`, scanFile: `Archive_Scans/s${p}.jpg`, err: '' };
}
meta[byPage(865).clean] = { err: 'нет данных' };
meta[byPage(9).clean] = { docType: 'Метрическая книга 1820 года', scanName: 's9.jpg', scanLocal: '/Volumes/DATA/Archive_Scans/s9.jpg' };   // скан есть, персоны нет

// Вариант «Источник»
const s = W.apply(ged, plan, meta, 'source');
assert.deepStrictEqual(s.stats, { variant: 'source', pages: 2, links: 3, persons: 2, noScan: 1, noPerson: 1, removed: 0, switched: 0, exists: 0, bySource: 3, byMedia: 0 });
assert.ok(s.text.includes('\r\n0 @YA_S1@ SOUR\r\n1 TITL Ревизская сказка от 1850 года\r\n'));
assert.ok(s.text.includes('1 OBJE\r\n2 FILE /Volumes/DATA/Archive_Scans/s165.jpg\r\n2 FORM jpg\r\n'));
assert.ok(s.text.includes('1 CHAR UTF-8') && !s.text.includes('ANSI'));
assert.ok(s.text.includes(`2 PAGE Скан 165, https://ya.ru/archive/catalog/${B}/165`));
assert.ok(s.text.trim().endsWith('0 TRLR'));
assert.strictEqual((s.text.match(/^1 SOUR @YA_S2@$/gm) || []).length, 2);     // страница 866 — у обоих супругов
// Вариант «Общий медиа-объект»
const m = W.apply(ged, plan, meta, 'media');
assert.strictEqual(m.stats.pages, 2);
assert.strictEqual((m.text.match(/^0 @YA_M\d+@ OBJE$/gm) || []).length, 2);     // два объекта на три ссылки персон
assert.strictEqual((m.text.match(/^1 OBJE @YA_M2@$/gm) || []).length, 2);
assert.ok(m.text.includes('1 FILE /Volumes/DATA/Archive_Scans/s866.jpg\r\n1 FORM jpg\r\n1 TITL Исповедническая ведомость 1750 года'));
assert.ok(m.text.includes('1 NOTE Архив хранения документа: ЦГА Москвы/Фонд 51/Опись 8/Дело 588/Скан 866\r\n2 CONT Страница в Яндекс Архиве:'));
// повторная запись не дублирует; смена варианта убирает прежний
const s2 = W.apply(s.text, plan, meta, 'source');
assert.strictEqual(s2.text, s.text);
assert.ok(s2.stats.removed > 0);
const sm = W.apply(s.text, plan, meta, 'media');
assert.strictEqual(sm.text, m.text);
assert.ok(!sm.text.includes('YA_S'));
// исходные записи не потеряны: после снятия наших — как был (кроме CHAR)
assert.strictEqual(W.stripOwn(W.splitRecords(s.text)).recs.map((r) => r.lines.join('\n')).join('\n').replace('1 CHAR UTF-8', '1 CHAR ANSI'), ged.replace(/\r\n/g, '\n'));
// длинные значения -> CONC, окончания строк \n сохраняются
const out = []; W.emit(out, 1, 'NOTE', 'я'.repeat(450));
assert.strictEqual(out.length, 3); assert.ok(out[1].startsWith('2 CONC '));
assert.ok(!W.apply(ged.replace(/\r\n/g, '\n'), plan, meta, 'media').text.includes('\r'));

// Уже имеющиеся записи персоны не дублируются и не правятся: пишется другой вариант
const meta2 = Object.assign({}, meta, { [byPage(865).clean]: { cga: 'ЦГА Москвы/Фонд 203/Опись 747/Дело 15/Скан 865', docType: 'Исповедническая ведомость 1739 года', scanName: 's865.jpg', scanLocal: '/Volumes/DATA/Archive_Scans/s865.jpg', err: '' } });
// у Ивана (I1) источник @S1@ с ссылкой на страницу 865 уже есть -> при «Источник» запись идёт как медиа-объект
const e1 = W.apply(ged, plan, meta2, 'source');
assert.strictEqual(e1.stats.switched, 1); assert.strictEqual(e1.stats.byMedia, 1);
assert.ok(e1.text.includes('0 @YA_M1@ OBJE\r\n1 FILE /Volumes/DATA/Archive_Scans/s865.jpg'));
assert.ok(/0 @I1@ INDI[\s\S]*?1 OBJE @YA_M1@/.test(e1.text));
assert.ok(e1.text.includes('0 @S1@ SOUR\r\n1 TITL https://ya.ru/archive/catalog/' + A + '/865\r\n'));      // существующий источник не тронут
// при «Медиа» у Ивана медиа-объекта нет -> выбранный вариант
const e2 = W.apply(ged, plan, meta2, 'media');
assert.strictEqual(e2.stats.switched, 0);
// у Анны (I2) есть OBJE с файлом скана 866 -> при «Медиа» запись идёт как источник; при обоих видах — ничего
const gedO = ged.replace('1 NAME Анна /Ладыгина/', '1 NAME Анна /Ладыгина/\r\n1 OBJE\r\n2 FILE C:\\Scans\\s866.jpg\r\n2 FORM jpg');
const e3 = W.apply(gedO, plan, meta2, 'media');
assert.ok(e3.stats.switched >= 1);
assert.ok(/0 @I2@ INDI[\s\S]*?1 SOUR @YA_S\d+@\r\n2 PAGE Скан 866/.test(e3.text));
const gedB = gedO.replace('1 OBJE\r\n2 FILE C:\\Scans\\s866.jpg', '1 SOUR @S1@\r\n1 OBJE\r\n2 FILE C:\\Scans\\s866.jpg').replace(`0 @S1@ SOUR\r\n1 TITL https://ya.ru/archive/catalog/${A}/865`, `0 @S1@ SOUR\r\n1 TITL https://ya.ru/archive/catalog/${A}/866`);
const e4 = W.apply(gedB, plan, meta2, 'media');
assert.ok(e4.stats.exists >= 1, JSON.stringify(e4.stats));
// повторный запуск по-прежнему не даёт дублей
assert.strictEqual(W.apply(e1.text, plan, meta2, 'source').text, e1.text);
console.log('gedcom-writer: OK');
