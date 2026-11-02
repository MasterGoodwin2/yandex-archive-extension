// Самопроверка листов Excel (excel-sheets.js): node tests/run_excel_sheets.js
// - слияние одинаковых подряд идущих ссылок (с другими не смешиваются), гиперссылки;
// - «Локальная Ссылка на страницу» и «Архив хранения документа»;
// - вид результата не зависит от типа обработки (исповедные <-> ревизские).
const path = require('path');
const X = path.join(__dirname, '..');
global.Logic = require(path.join(X, 'logic.js'));
const ConfessionRows = require(path.join(X, 'confession-rows.js'));
global.ConfessionRows = ConfessionRows;
const Layout = require(path.join(X, 'layout.js'));
const { STYLE } = require(path.join(X, 'xlsx-writer.js'));
const E = require(path.join(X, 'excel-sheets.js'));

let ok = true;
const check = (cond, msg) => { console.log(`${cond ? 'OK ' : 'ОШИБКА'} ${msg}`); ok = ok && !!cond; };

const crumbs = [{ type: 'Archive', id: 'a1', code: 'ЦГА МОСКВЫ', name: 'ЦГА Москвы' }, { type: 'Fund', id: 'f1', code: '203' },
  { type: 'Inventory', id: 'i1', code: '747' }, { type: 'File', id: 'd15', code: '15' }];
const ci = E.crumbInfo(crumbs, 865, 'node', 'https://ya.ru');
check(ci.cga === 'ЦГА Москвы/Фонд 203/Опись 747/Дело 15/Скан 865', 'путь из шапки (текст, без «Главная/Каталог»): ' + ci.cga);
check(ci.scanName === 'ЦГА_Москвы_[ЯА]_203-747-15-0865.jpg', 'имя скана как в Scrpt_YA_Orig_Scan: ' + ci.scanName);
check(ci.cgaUrl === 'https://ya.ru/archive/catalog/d15', 'ссылка ЦГА ведёт на дело');

const u1 = 'https://ya.ru/archive/catalog/d15/865', u2 = 'https://ya.ru/archive/catalog/d15/866';
const pageMeta = {
  [u1]: Object.assign({}, ci, { scanFile: 'Archive_Scans/' + ci.scanName, scanHref: '../../Archive_Scans/' + ci.scanName }),
  [u2]: Object.assign({}, E.crumbInfo(crumbs, 866, 'node2', 'https://ya.ru')),
};
const conf = [u1, u1, u1, u2, u2, u1].map((url, i) => ({ year: 1739, settlement: 'село Троицкое', yard: 1, sex: i % 2 ? 'ж' : 'м',
  no: String(i + 1), age: '30', person: 'человек ' + i, names: 'блок', notes: [], url }));
const sh = E.build({ processMode: 'confession', outFormat: 'confession', families: [], rowRecords: conf, blockRecords: [], sheetRows: [], linkRows: [], pageMeta },
  { ConfessionRows, Layout, STYLE });
const people = sh[0];
check(people.rows[0].slice(-3).join('|') === 'Ссылка на страницу|Локальная Ссылка на страницу|Архив хранения документа', 'столбцы ссылок в конце листа «Люди»');
const linkMerges = people.merges.filter((m) => m[1] === 9).map((m) => `${m[0]}-${m[2]}`);
check(JSON.stringify(linkMerges) === JSON.stringify(['1-3', '4-5']), 'слияние только подряд одинаковых ссылок: ' + linkMerges);
check(people.rows[6][9] === u1, 'та же ссылка после другой — отдельная ячейка, не сливается с первой группой');
check(people.rows[2][9] === '' && people.rows[1][9] === u1, 'ссылка вписана один раз на группу');
const targets = people.links.map((l) => `${l[0]}:${l[1]}:${l[2]}`);
check(targets.includes(`1:10:../../Archive_Scans/${ci.scanName}`), 'локальная ссылка на скан — относительная');
check(!targets.some((t) => t.startsWith('4:10:')), 'нет скана — нет локальной ссылки');
check(!targets.some((t) => t.split(':')[1] === '11'), 'ссылка на ЦГА Москвы — текст, без гиперссылки');

// исповедные -> вид «Ревизские сказки»
const fam = { year: 1739, settlement: 'село Троицкое', yard: 1, persons: [{ gender: '', no: '', text: 'блок', age: '', rows: ['м№1'] }], notes: [], url: u1 };
const asRev = E.build({ processMode: 'confession', outFormat: 'revision', families: [fam], rowRecords: conf, blockRecords: [], sheetRows: [], linkRows: [], pageMeta },
  { ConfessionRows, Layout, STYLE });
check(asRev.map((s) => s.name).join(',') === 'Люди,Строки,Страницы,Ссылки', 'исповедные в виде ревизских: листы ' + asRev.map((s) => s.name));
check(asRev[1].rows.length === conf.length + 1, 'строки людей перенесены на лист «Строки»');

// ревизские -> вид «Исповедные ведомости»: текст блока делится по людям, возраст по прошлой ревизии — от её года
const rev = [{ year: 1850, url: u1, settlement: 'деревня Черепкова', yard: 23, sex: 'м', blockNo: 1, rowNo: 1, rowsInBlock: 2,
  names: 'Никита Григорьевъ Стрѣнинъ Никиты Григорьева сынъ Степанъ', agePrev: '55.', ageNow: '', departed: 'умеръ въ 1847.', absent: '' },
{ year: 1850, url: u1, settlement: 'деревня Черепкова', yard: 23, sex: 'м', blockNo: 1, rowNo: 2, rowsInBlock: 2,
  names: 'Никита Григорьевъ Стрѣнинъ Никиты Григорьева сынъ Степанъ', agePrev: '29.', ageNow: '45.', departed: '', absent: '' }];
const asConf = E.build({ processMode: 'revision', outFormat: 'confession', families: [], rowRecords: rev, blockRecords: [], sheetRows: [], linkRows: [], pageMeta },
  { ConfessionRows, Layout, STYLE });
const r1 = asConf[0].rows[1], r2 = asConf[0].rows[2];
check(r1[4] === 'Никита Григорьевъ Стрѣнинъ' && r2[4] === 'Никиты Григорьева сынъ Степанъ', 'текст блока поделён по людям');
check(r1[6] === 55 && r1[7] === 1779 && /1834/.test(r1[8]), 'возраст по прошлой ревизии: год рождения от 1834 г. (' + r1[7] + ')');
check(r2[6] === 45 && r2[7] === 1805, 'нынешний возраст: год рождения от 1850 г.');


// ---- 2.3.0: порядок столбцов, постраничное слияние «Год», цвета, НП
check(people.rows[0][3] === 'Номер' && people.rows[0][4] === 'Человек (как распознано)', '«Номер» перед «Человек»');
const ym = (people.merges || []).filter((m) => m[1] === 0 && m[3] === 0).map((m) => `${m[0]}-${m[2]}`).join(',');
check(ym === '1-3,4-5', '«Год» слит по странице: ' + ym);
const stM = people.styleAt(1, 5), stF = people.styleAt(2, 5);
check(stM.fill === E.COLORS.male && stF.fill === E.COLORS.female, 'строки мужчин голубые, женщин розовые');
check(people.styleAt(1, 1).fill === E.COLORS.settlement['село Троицкое'] && people.styleAt(1, 1).rotate === 90, 'цвет НП закреплён за названием');
check(people.styleAt(1, 0).fill !== people.styleAt(4, 0).fill, 'слитые блоки соседних страниц — разные цвета');
const und = [['не определён (начало диапазона)', u1], ['деревня Черепкова', u1], ['село Троицкое', u2], ['деревня Черепкова', u2]]
  .map(([st, url], i) => ({ year: 1786, settlement: st, yard: i + 1, sex: 'м', no: String(i + 1), age: '30', person: 'п' + i, names: 'б', notes: [], url }));
const sh2 = E.build({ processMode: 'confession', outFormat: 'confession', families: [], rowRecords: und, blockRecords: [], sheetRows: [], linkRows: [], pageMeta },
  { ConfessionRows, Layout, STYLE })[0];
const np = sh2.rows.slice(1).map((r) => r[1] || '·').join(',');
check(sh2.rows[1][1] === 'деревня Черепкова', '«не определён» → следующий определённый НП');
check(sh2.rows.slice(1).map((r) => r[4]).join(',') === 'п0,п1,п3,п2', 'повторный НП перенесён к первичному: ' + sh2.rows.slice(1).map((r) => r[4]).join(','));
const errRow = E.build({ processMode: 'confession', outFormat: 'confession', families: [], rowRecords: [Object.assign({}, conf[0], { no: '', notes: ['нет номера человека'] })],
  blockRecords: [], sheetRows: [], linkRows: [], pageMeta }, { ConfessionRows, Layout, STYLE })[0];
check(errRow.styleAt(1, 3).fill === E.COLORS.error && errRow.styleAt(1, 8).fill === E.COLORS.error, 'ячейки с ошибкой — светло-красные');

const dt = (n) => E.docType([{ type: 'File', name: n }]);
check(dt('9 ревизия, 1850 г.') === 'Ревизская сказка от 1850 года', 'тип: ревизская сказка с годом');
check(dt('Ревизские сказки 8 ревизии') === 'Ревизская сказка от 1834 года', 'тип: ревизия по номеру');
check(dt('Исповедные ведомости за 1750 год') === 'Исповедническая ведомость 1750 года', 'тип: исповедная ведомость');
check(dt('Исповедная записная книга') === 'Исповедническая записная книга', 'тип: записная книга');
check(dt('Метрическая книга за 1820 год') === 'Метрическая книга 1820 года', 'тип: метрическая книга');
check(dt('') === '', 'тип: нет названия');

console.log('ИТОГ:', ok ? 'OK' : 'ЕСТЬ ОШИБКИ');
process.exit(ok ? 0 : 1);
