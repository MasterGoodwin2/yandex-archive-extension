// Листы Excel результата — общий модуль для расширения (app.js) и пересборки из отладочного пакета
// (tools/rebuild_from_debug.js), чтобы оба давали один и тот же файл.
//
// Вид результата выбирается отдельно от типа обработки (outFormat):
//   'confession' — «Исповедные ведомости»: одна строка = один человек (Год | НП | Двор | Человек | Пол | Номер |
//                  Возраст | Год рождения | Примечание | ссылки);
//   'revision'   — «Ревизские сказки»: одна строка = семья-двор, люди двора в одной ячейке, плюс лист «Строки».
// Данные, собранные в режиме ревизских сказок, можно выдать в виде исповедных ведомостей и наоборот:
// строки приводятся к виду «один человек» (текст блока делится по людям) или «строка таблицы».
//
// Постранично (2.3.0): у всех людей одной обработанной страницы одна ячейка «Год», «Ссылка на страницу»,
// «Локальная Ссылка на страницу» (скан) и «Архив хранения документа» — слитые; «Архив хранения документа» — текст
// «ЦГА Москвы/Фонд 203/Опись 747/Дело 15/Скан 865» без ссылки.
// Населённые пункты: «не определён (начало диапазона)» получает название следующего определённого НП того же года;
// повторный НП в документе одного года переносится сразу после первичного (порядок первых упоминаний).
// Цвета (светлые, кроме красного): НП — свой цвет, закреплённый за названием; двор и слитые ячейки — чередуются;
// строки мужчин — голубые, женщин — розовые; ячейки с ошибками — светло-красные.
(function (root) {
  'use strict';

  const trunc = (v) => (typeof v === 'string' ? v.slice(0, 32000) : v === null || v === undefined ? '' : v);

  function widthsFor(rows) {
    const cols = Math.max(...rows.map((r) => r.length));
    const out = [];
    for (let c = 0; c < cols; c++) {
      let w = 8;
      rows.slice(0, 200).forEach((r) => { const v = r[c]; if (v !== '' && v !== null && v !== undefined) w = Math.max(w, String(v).length); });
      out.push(Math.min(Math.max(w + 2, 10), 70));
    }
    return out;
  }

  // «45» -> 45; «7 1/2» -> 7.5; «1/2» -> 0.5
  function ageValue(age) {
    const m = String(age || '').match(/^\s*(\d{1,3})?\s*(?:(\d)\s*\/\s*(\d))?/);
    if (!m || !(m[1] || m[2])) return null;
    return parseInt(m[1] || '0', 10) + (m[2] ? parseInt(m[2], 10) / parseInt(m[3], 10) : 0);
  }
  // год рождения = год документа − полных лет (±1 год)
  function birthYear(year, age) {
    const v = ageValue(age), y = parseInt(year, 10);
    return v === null || !y ? '' : y - Math.floor(v);
  }
  const cleanAge = (a) => String(a || '').replace(/[.,\s]+$/, '').trim();
  // годы ревизий: возраст «по прошлой ревизии» отсчитывается от года предыдущей ревизии
  const REVISION_YEARS = [1719, 1744, 1762, 1782, 1795, 1811, 1815, 1834, 1850, 1858];
  const prevRevision = (year) => { const y = parseInt(year, 10); return REVISION_YEARS.filter((v) => v < y).pop() || null; };

  // ---------------------------------------------------------------- приведение строк
  // Строки ревизской сказки (строка таблицы блока) -> люди: текст блока делится по людям по полу строк.
  function revisionToPersons(rows, splitBlock) {
    const out = [];
    let i = 0;
    while (i < rows.length) {
      const r0 = rows[i];
      let j = i;
      while (j < rows.length && rows[j].url === r0.url && rows[j].sex === r0.sex && rows[j].blockNo === r0.blockNo && rows[j].names === r0.names) j++;
      const grp = rows.slice(i, j);
      const parts = splitBlock ? splitBlock(r0.names || '', grp.map((r) => (r.sex === 'ж' ? 'F' : 'M'))) : grp.map(() => ['', '']);
      grp.forEach((r, k) => {
        const notes = (r.notes || []).slice();
        const now = cleanAge(r.ageNow), prev = cleanAge(r.agePrev);
        let age = now, ageYear = r.year;
        if (!age && prev) {
          age = prev; ageYear = prevRevision(r.year) || r.year;
          notes.push(`возраст по прошлой ревизии${ageYear !== r.year ? ` (${ageYear} г.)` : ''}`);
        }
        if (r.departed) notes.push('выбыл: ' + cleanAge(r.departed));
        if (r.absent) notes.push('в отлучке: ' + cleanAge(r.absent));
        if (parts[k] && parts[k][1]) notes.push(parts[k][1]);
        out.push({ year: r.year, page: r.page, url: r.url, settlement: r.settlement, yard: r.yard, sex: r.sex, no: '',
          age, ageYear, person: (parts[k] && parts[k][0]) || '', names: r.names, notes, flags: r.flags || '' });
      });
      i = j;
    }
    return out;
  }

  // Люди исповедной ведомости -> строки вида «Строки» ревизской сказки
  function personsToRevisionRows(rows) {
    return rows.map((r) => ({ year: r.year, settlement: r.settlement, yard: r.yard, sex: r.sex, blockNo: r.half || '',
      rowNo: r.no, rowsInBlock: r.inBlock, names: r.person || r.names, agePrev: '', departed: '', absent: '', ageNow: r.age,
      flags: [r.flags, (r.notes || []).join('; ')].filter(Boolean).join('; '), url: r.url, page: r.page }));
  }

  // ---------------------------------------------------------------- цвета
  const COLORS = {
    male: 'DDEBF7', female: 'F6E1F5', error: 'FFC7CE', undef: 'EDEDED',
    // закреплены за НП (как в справочнике yaarchive «цвета_НП»)
    settlement: { 'село Троицкое': 'E2EFDA', 'деревня Острогина': 'FFF2CC', 'деревня Черепкова': 'E4DFEC',
      'деревня Рублева': 'D0ECE7', 'деревня Луки': 'FBE5D6', 'деревня Мякинина': 'EBF1DE', 'деревня Екатериненская': 'F2E8D5' },
    extra: ['E8F6EF', 'F3EEDB', 'EDE7F6', 'E0F2F1', 'FFF8E1', 'F1F8E9', 'E3F2FD', 'FBE9E7'],
    yards: ['FFF9E5', 'EAF4DD', 'F1ECF7', 'E6F3F6', 'FBF0E4', 'EEF0F3'],
    merged: ['F2F2F2', 'E9EFF7', 'EEF5E9', 'F7F0E8'],
  };
  function settlementColor(name) {
    const n = String(name || '');
    if (!n || /^не определён/.test(n)) return COLORS.undef;
    const base = n.replace(/^чужой НП:\s*/, '');
    if (COLORS.settlement[base]) return COLORS.settlement[base];
    let h = 0;
    for (const ch of base) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return COLORS.extra[h % COLORS.extra.length];
  }
  // текст замечания — ошибка (красная ячейка), а не пояснение
  const ERR_RX = /(не найден|не совпал|не подряд|неоднознач|проверить|без номера|не распозн|ошибк|^нет |неправдоподоб|под вопросом|не определено|лишнее|два номера|не сошл|неполн)/i;
  // в какой столбец указывает замечание
  function errorCols(notes) {
    const cols = new Set();
    for (const t of notes) {
      if (!ERR_RX.test(t)) continue;
      cols.add('note');
      if (/двор/i.test(t)) cols.add('yard');
      else if (/номер/i.test(t)) cols.add('no');
      if (/без номера/i.test(t)) continue;           // «возраст без номера человека» — ошибка в номере
      if (/возраст|лет\b/i.test(t)) cols.add('age');
      if (/имя|пол по имени|текст|блок/i.test(t)) cols.add('person');
    }
    return cols;
  }

  // «не определён (начало диапазона)» -> следующий определённый НП того же года (иначе предыдущий);
  // повторный НП в документе одного года — сразу после первичного (по первым упоминаниям, порядок внутри сохраняется)
  function arrangeSettlements(rows) {
    const undef = (r) => /^не определён/.test(String(r.settlement || ''));
    const years = new Map();
    rows.forEach((r) => { const k = String(r.year); if (!years.has(k)) years.set(k, []); years.get(k).push(r); });
    const out = [];
    for (const grp of years.values()) {
      for (let i = 0; i < grp.length; i++) {
        if (!undef(grp[i])) continue;
        let j = i + 1;
        while (j < grp.length && undef(grp[j])) j++;
        let name = j < grp.length ? grp[j].settlement : null, how = 'следующего';
        if (!name) { let k = i - 1; while (k >= 0 && undef(grp[k])) k--; name = k >= 0 ? grp[k].settlement : null; how = 'предыдущего'; }
        if (!name) continue;
        for (let k = i; k < j; k++) {
          grp[k] = Object.assign({}, grp[k], { settlement: name, notes: (grp[k].notes || []).concat(`НП взят из ${how} определённого («${name}»)`) });
        }
        i = j - 1;
      }
      // участки подряд идущих строк одного НП; участок НП, уже встречавшегося раньше, — перенос к первичному
      const first = new Map();
      const seg = [];
      grp.forEach((r, i) => {
        if (!first.has(r.settlement)) first.set(r.settlement, i);
        const isNew = i === 0 || grp[i - 1].settlement !== r.settlement;
        seg.push(isNew ? (seg.length ? seg[seg.length - 1] + 1 : 0) : seg[seg.length - 1]);
      });
      const segStartPage = new Map();
      grp.forEach((r, i) => { if (!segStartPage.has(seg[i])) segStartPage.set(seg[i], r.page); });
      grp.map((r, i) => [first.get(r.settlement), i, r]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).forEach(([f, i, r]) => {
        const repeated = first.get(r.settlement) !== i && seg[i] !== seg[f];
        out.push(repeated && (i === 0 || seg[i] !== seg[i - 1])
          ? Object.assign({}, r, { notes: (r.notes || []).concat(`повторный НП «${r.settlement}» перенесён к первичному (было со стр. ${segStartPage.get(seg[i])})`) })
          : r);
      });
    }
    return out;
  }

  // номера «прогонов» подряд идущих одинаковых ключей: для чередования цветов и слияния
  function runIndex(n, key) {
    const idx = new Array(n).fill(0);
    let k = -1;
    for (let i = 0; i < n; i++) { if (i === 0 || key(i) !== key(i - 1)) k++; idx[i] = k; }
    return idx;
  }

  // ---------------------------------------------------------------- ссылки
  const LINK_HEAD = ['Ссылка на страницу', 'Локальная Ссылка на страницу', 'Архив хранения документа'];

  // три ячейки ссылок строки по адресу страницы
  function linkCells(url, meta) {
    const m = (meta && url && meta[url]) || {};
    return [url || '', m.scanFile ? m.scanLocal || m.scanName || m.scanFile : '', m.cga || ''];
  }

  // Постранично: строки одной обработанной страницы (год + ссылка) — одна слитая ячейка «Год» и три ячейки ссылок.
  // «Архив хранения документа» — текст без ссылки. -> merges, links, pageRun (номер блока страницы по строкам)
  function pageLayout(rows, firstCol, meta, yearCol) {
    const merges = [], links = [];
    const n = rows.length;
    const key = (r) => `${rows[r][yearCol]}|${rows[r][firstCol]}`;
    const pageRun = new Array(n).fill(-1);
    let st = 1, k = 0;
    const flush = (a, b) => {
      for (let r = a; r <= b; r++) pageRun[r] = k;
      k++;
      const url = rows[a][firstCol];
      const cols = [yearCol, firstCol, firstCol + 1, firstCol + 2];
      if (b > a) cols.forEach((c) => merges.push([a, c, b, c]));
      for (let r = a + 1; r <= b; r++) cols.forEach((c) => { rows[r][c] = ''; });
      if (!url) return;
      const m = meta[url] || {};
      if (/^https?:/.test(url)) links.push([a, firstCol, url]);
      if (m.scanFile) links.push([a, firstCol + 1, m.scanHref || m.scanFile]);
    };
    for (let r = 2; r <= n; r++) {
      if (r === n || key(r) !== key(st)) { flush(st, r - 1); st = r; }
    }
    const linkCols = new Set([firstCol, firstCol + 1, firstCol + 2]);
    return { merges, links, linkCols, pageRun };
  }

  // ---------------------------------------------------------------- листы
  function build(d, deps) {
    const { ConfessionRows, Layout, STYLE } = deps;
    const meta = d.pageMeta || {};
    const outFormat = d.outFormat || d.processMode;

    const pageRows = [['Год', 'Найденные НП округи', ...LINK_HEAD, 'Распознанный текст страницы', 'Проверка страницы']];
    (d.sheetRows || []).forEach((r) => pageRows.push([r.year, r.found, ...linkCells(r.url, meta), r.text, r.check || ''].map(trunc)));
    const pageLinks = [];
    pageRows.forEach((row, i) => {
      if (!i) return;
      const m = meta[row[2]] || {};
      if (/^https?:/.test(row[2])) pageLinks.push([i, 2, row[2]]);
      if (m.scanFile) pageLinks.push([i, 3, m.scanHref || m.scanFile]);
    });
    const pgw = widthsFor(pageRows); pgw[5] = 60;
    const linkOut = [['Год', 'Исходная ссылка', 'Диапазон из ссылки', 'Просмотрено страниц', 'Найдено НП (шт.)', 'Какие НП', 'Решение',
      'Дворов (семей)', 'Людей', 'Как собрано', 'Примечание']];
    (d.linkRows || []).forEach((r) => linkOut.push(r.map(trunc)));
    const tail = [
      { name: 'Страницы', rows: pageRows, widths: pgw, links: pageLinks },
      { name: 'Ссылки', rows: linkOut, widths: widthsFor(linkOut) },
    ];

    if (outFormat === 'confession') {
      const recs0 = d.processMode === 'revision' ? revisionToPersons(d.rowRecords || [], ConfessionRows.splitBlock) : (d.rowRecords || []);
      const recs = arrangeSettlements(recs0);
      // столбцы: 0 Год | 1 НП | 2 Двор | 3 Номер | 4 Человек | 5 Пол | 6 Возраст | 7 Год рождения | 8 Примечание | 9–11 ссылки
      const head = ['Год', 'Населённый пункт', 'Двор №', 'Номер', 'Человек (как распознано)', 'Пол', 'Возраст', 'Год рождения',
        'Примечание', ...LINK_HEAD];
      const people = [head];
      const yards = ConfessionRows.fillYards(recs);
      const errs = [null];
      recs.forEach((r, i) => {
        const yd = yards[i];
        let notes = (r.notes || []).slice();
        if (yd.calc) {
          notes = notes.filter((n) => !/^номер двора не найден/.test(n));
          if (i === 0 || !yards[i - 1].calc || yards[i - 1].yard !== yd.yard) notes.unshift(`номер двора ${yd.yard} вычислен по соседним дворам`);
        }
        errs.push(errorCols(notes));
        people.push([r.year, r.settlement, yd.yard, r.no === '' ? '' : (parseInt(r.no, 10) || r.no), r.person, r.sex,
          r.age === '' ? '' : (/^\d+$/.test(String(r.age)) ? parseInt(r.age, 10) : r.age),
          birthYear(r.ageYear || r.year, r.age), notes.join('; '), ...linkCells(r.url, meta)].map(trunc));
      });
      const n = people.length;
      const merges = [];
      const npKey = (r) => `${people[r][0]}|${people[r][1]}`;
      const yardKey = (r) => ((people[r][2] === '' || people[r][2] == null) ? `empty${r}` : `${npKey(r)}|${people[r][2]}|${yards[r - 1].calc}`);
      const runs = (col, key) => {
        let s0 = 1;
        for (let r = 2; r <= n; r++) {
          if (r === n || key(r) !== key(s0)) { if (r - 1 > s0) merges.push([s0, col, r - 1, col]); s0 = r; }
        }
      };
      const npV = people.map((row) => row[1]);
      const sexV = people.map((row) => row[5]);
      runs(1, npKey);
      runs(2, yardKey);
      const yardRun = runIndex(n, (r) => (r ? yardKey(r) : 'h'));
      const L = pageLayout(people, 9, meta, 0);
      const colOf = { yard: 2, no: 3, person: 4, age: 6, note: 8 };
      const styleAt = (r, c) => {
        if (c === 1) return { fill: settlementColor(npV[r]), bold: true, border: true, h: 'center', v: 'center', rotate: 90, wrap: true };
        const e = errs[r];
        const isErr = e && [...e].some((k) => colOf[k] === c);
        if (c === 2) return { fill: isErr ? COLORS.error : COLORS.yards[yardRun[r] % COLORS.yards.length], bold: true, border: true,
          h: 'center', v: 'center', italic: !!(yards[r - 1] && yards[r - 1].calc) };
        if (c === 0 || L.linkCols.has(c)) return { fill: COLORS.merged[Math.max(0, L.pageRun[r]) % COLORS.merged.length], border: true,
          v: 'center', wrap: true, link: (c === 9 || c === 10) && !!people[r][c], h: c === 0 ? 'center' : undefined };
        const fill = isErr ? COLORS.error : (sexV[r] === 'ж' ? COLORS.female : sexV[r] === 'м' ? COLORS.male : undefined);
        return { fill, border: true, v: 'center', h: (c === 4 || c === 8) ? undefined : 'center', wrap: c === 4 || c === 8 };
      };
      const pw = widthsFor(people); pw[0] = 7; pw[1] = 9; pw[2] = 7; pw[3] = 7; pw[4] = 45; pw[8] = 40; pw[9] = 40; pw[10] = 30; pw[11] = 40;
      const blocks = [['Год', 'Населённый пункт', 'Двор №', 'Текст блока целиком (как распознан)', 'Людей в блоке', 'Ссылка на страницу']];
      (d.blockRecords || []).forEach((b) => blocks.push([b.year, b.settlement, b.yard, b.text, b.persons, b.url].map(trunc)));
      const bw = widthsFor(blocks); bw[3] = 70;
      return [
        { name: 'Люди', rows: people, widths: pw, styleAt, merges: merges.concat(L.merges), links: L.links },
        { name: 'Блоки текста', rows: blocks, widths: bw },
        ...tail,
      ];
    }

    // вид «Ревизские сказки»: одна строка = семья-двор
    const fams = arrangeSettlements(d.families || []);
    const peopleRows = [['Год', 'Населённый пункт', 'Двор №', 'Люди двора (№ м/ж, как распознано, возраст)', 'Примечание', ...LINK_HEAD]];
    const ferr = [false];
    fams.forEach((f) => {
      ferr.push((f.notes || []).some((t) => ERR_RX.test(t)));
      peopleRows.push([f.year, f.settlement, f.yard, Layout.familyCell(f), (f.notes || []).join('; '), ...linkCells(f.url, meta)].map(trunc));
    });
    const fn = peopleRows.length;
    const fnp = peopleRows.map((row) => row[1]);
    const fMerges = [];
    { let s0 = 1; for (let r = 2; r <= fn; r++) { if (r === fn || `${peopleRows[r][0]}|${fnp[r]}` !== `${peopleRows[s0][0]}|${fnp[s0]}`) { if (r - 1 > s0) fMerges.push([s0, 1, r - 1, 1]); s0 = r; } } }
    const fYard = runIndex(fn, (r) => `${fnp[r]}|${peopleRows[r][2]}`);
    const L = pageLayout(peopleRows, 5, meta, 0);
    const pw = widthsFor(peopleRows); pw[3] = 60; pw[5] = 40; pw[6] = 30; pw[7] = 40;
    const rr = d.processMode === 'confession' ? personsToRevisionRows(d.rowRecords || []) : (d.rowRecords || []);
    const detail = [['Год', 'Населённый пункт', 'Двор №', 'Пол', 'Блок №', 'Строка №', 'Строк в блоке', 'Текст блока (список людей)',
      'Лѣта по ревизии', 'Когда выбыл', 'В отлучке с', 'Лѣта нынѣ', 'Проверка', 'Ссылка на страницу']];
    rr.forEach((r) => detail.push([r.year, r.settlement, r.yard, r.sex, r.blockNo, r.rowNo, r.rowsInBlock, r.names,
      r.agePrev, r.departed, r.absent, r.ageNow, r.flags, r.url].map(trunc)));
    const sheets = [{ name: 'Люди', rows: peopleRows, widths: pw, merges: fMerges.concat(L.merges), links: L.links,
      styleAt: (r, c) => {
        if (c === 1) return { fill: settlementColor(fnp[r]), bold: true, border: true, h: 'center', v: 'center', rotate: 90, wrap: true };
        if (c === 2) return { fill: COLORS.yards[fYard[r] % COLORS.yards.length], bold: true, border: true, h: 'center', v: 'center' };
        if (c === 0 || L.linkCols.has(c)) return { fill: COLORS.merged[Math.max(0, L.pageRun[r]) % COLORS.merged.length], border: true,
          v: 'center', wrap: true, link: (c === 5 || c === 6) && !!peopleRows[r][c], h: c === 0 ? 'center' : undefined };
        if (c === 4 && ferr[r]) return { fill: COLORS.error, border: true, v: 'top', wrap: true };
        return { border: true, v: 'top', wrap: c === 3 || c === 4 };
      } }];
    if (rr.length) { const dw = widthsFor(detail); dw[7] = 50; sheets.push({ name: 'Строки', rows: detail, widths: dw }); }
    return sheets.concat(tail);
  }

  // ---------------------------------------------------------------- сведения о странице
  // Путь из шапки страницы и имя файла скана — по breadcrumbs данных страницы (как в Scrpt_YA_Orig_Scan).
  const sanitize = (v) => String(v || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  // Тип документа по названию дела: «Ревизская сказка от 1850 года», «Исповедническая ведомость 1750 года»,
  // «Исповедническая записная книга», «Метрическая книга 1820 года». Год — из названия; для ревизий без года — по номеру ревизии.
  function docType(crumbs) {
    const list = crumbs || [];
    const file = list.find((c) => c.type === 'File');
    const name = file ? String(file.name || '').replace(/\s+/g, ' ').trim() : '';
    if (!name) return '';
    const yearIn = (t) => { const m = String(t || '').match(/(?:^|\D)(1[5-9]\d\d)(?!\d)/); return m ? m[1] : ''; };
    let year = yearIn(name);
    if (!year) for (const c of list) { if (c.type !== 'File') { year = yearIn(c.name); if (year) break; } }
    if (/ревиз/i.test(name)) {
      const rv = name.match(/(\d{1,2})\s*-?\s*(?:я|ая|й)?\s*ревиз/i);
      if (!year && rv && REVISION_YEARS[+rv[1] - 1]) year = String(REVISION_YEARS[+rv[1] - 1]);
      return 'Ревизская сказка' + (year ? ` от ${year} года` : '');
    }
    if (/метрич/i.test(name)) return 'Метрическая книга' + (year ? ` ${year} года` : '');
    if (/исповед/i.test(name)) {
      return (/записн|книг/i.test(name) && !/ведомост/i.test(name) ? 'Исповедническая записная книга' : 'Исповедническая ведомость') + (year ? ` ${year} года` : '');
    }
    return name + (year && !name.includes(year) ? ` ${year} года` : '');
  }
  function crumbInfo(crumbs, page, nodeId, origin) {
    const find = (t) => (crumbs || []).find((c) => c.type === t) || null;
    const archive = find('Archive'), fund = find('Fund'), inv = find('Inventory'), file = find('File');
    const num = (c) => { const m = c && String(c.code || '').match(/\d+[а-яА-Яa-zA-Z]?/); return m ? m[0] : ''; };
    const parts = [];          // «ЦГА Москвы/Фонд 203/Опись 747/Дело 15/Скан 865» (без «Главная/Каталог»)
    if (archive) parts.push(archive.name || archive.code);
    if (fund) parts.push('Фонд ' + (fund.code || ''));
    if (inv) parts.push('Опись ' + num(inv));
    if (file) parts.push('Дело ' + (file.code || ''));
    if (page !== undefined && page !== null) parts.push('Скан ' + page);
    const base = origin || 'https://ya.ru';
    const cgaUrl = file ? `${base}/archive/catalog/${file.id}` : archive ? `${base}/archive/catalog/${archive.id}` : '';
    const padded = String(page).padStart(4, '0');
    const codes = [fund && fund.code ? String(fund.code).trim() : '', num(inv), file && file.code ? String(file.code).trim() : ''].filter(Boolean);
    const scanName = codes.length >= 2
      ? (archive && archive.name ? sanitize(archive.name) + '_[ЯА]_' : '') + sanitize(codes.join('-') + '-' + padded) + '.jpg'
      : 'YA_archive_' + sanitize(nodeId) + '_' + padded + '.jpg';
    return { cga: (crumbs && crumbs.length) ? parts.join('/') : '', cgaUrl, scanName, docType: docType(crumbs) };
  }

  const api = { build, crumbInfo, docType, arrangeSettlements, settlementColor, COLORS, revisionToPersons, personsToRevisionRows, birthYear, widthsFor, LINK_HEAD };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ExcelSheets = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
