// Сопоставление распознанных блоков по их положению на странице:
//   № двора  ↔  № мужчины / женщины  ↔  текст записи  ↔  возраст.
// Текст записи НЕ разбирается, не исправляется и не достраивается — сохраняется ровно так, как распознан.
// Блок = {t: текст, x, y, w, h} — прямоугольник на странице (в пикселях).
(function (root) {
  const Logic = root.Logic || (typeof require !== 'undefined' ? require('./logic.js') : null);
  const RevisionRows = root.RevisionRows || (typeof require !== 'undefined' ? require('./revision-rows.js') : null);
  const ConfessionRows = root.ConfessionRows || (typeof require !== 'undefined' ? require('./confession-rows.js') : null);

  const NUM_RX = /^(?:№|N|n)?\s*(\d{1,3})\s*[.,)]?$/u;            // «5», «5.», «№5»
  const LEAD_NUM_RX = /^(\d{1,3})\s*[.)]\s*(\D.*)$/u;               // «5. Иван Петров»
  const TRAIL_AGE_RX = /^(.*[^\d\s№])\s+(\d{1,3})$/u;               // «Иван Петров 45»
  const MAX_AGE = 110;

  // служебные строки шапки и итогов (применяются только к строкам БЕЗ чисел-возрастов, кроме «итого»)
  const ARTIFACT = new RegExp('^(?:' + [
    'лета', 'семьи', 'семья', 'ныне', 'нине', 'на лицо', 'налицо', 'крестьян', 'мужеск', 'женск', 'мужск', 'итого', 'по последне',
    'по после', 'ис того', 'из того', 'во временно', 'с которого', 'скоторого', 'скоторо', 'когда', 'кто были', 'которые',
    'кто же', 'ктож', 'показани', 'числа', 'состояли', 'состояло', 'выбыли', 'подано', 'ревизск', 'ревизия', 'сказка',
    'оборот', 'попов$', 'исповедь', 'у исповеди', 'и святого', 'исповедались', 'токмо', 'причастились', 'домов', 'двор$',
    'число$', 'людеи', 'людей', 'мужеска', 'женска', 'всего', 'прибыло', 'убыло', 'выбыло', 'в том числе', 'с прибылыми',
    'по ревизии', 'во время', 'родилось', 'умерло', 'имена', 'и отчества', 'пол$', 'номер', 'возраст', 'лет$',
  ].join('|') + ')');
  const ALWAYS_ARTIFACT = /^(?:итого|всего|по ревизии|в том числе)/;
  const TITLE_NOISE = /(?:ревизск|исповедн|ведомост|сказк|уезд|губерн|волост|приход)/;
  const kline = (s) => Logic.norm(s).replace(/[^а-яa-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

  const median = (arr, dflt) => {
    if (!arr.length) return dflt;
    const a = arr.slice().sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  };

  function newState() {
    return { current: null, other: null, fam: null, cols: { m: null, f: null, yard: null }, dropped: 0, pages: 0, blockPages: 0, linePages: 0,
      rows: [], blocks: [], checks: {}, orphans: 0, skipped: [] };
  }

  // ---------------------------------------------------------------- семьи
  function flush(st, out) {
    if (st.fam && st.fam.persons.length) out.push(st.fam);
    st.fam = null;
  }
  function startFamily(st, out, yard, ctx) {
    flush(st, out);
    st.fam = { settlement: ctx.settlement, yard: yard === null ? '' : yard, persons: [], notes: [], url: ctx.url, page: ctx.page };
  }
  function ensureFamily(st, out, ctx) {
    if (!st.fam || st.fam.settlement !== ctx.settlement) {
      startFamily(st, out, null, ctx);
      st.fam.noYard = true;
    }
    return st.fam;
  }
  const addNote = (fam, msg) => { if (!fam.notes.includes(msg)) fam.notes.push(msg); };

  // подходит ли строка под «населённый пункт округи / чужой / нет»; обновляет состояние
  function applyHeader(st, out, h) {
    flush(st, out);
    const [kind, name] = h;
    st.current = kind === 'own' ? name : null;
    st.other = kind === 'other' ? name : null;
  }
  function settlementOf(st) {
    if (st.current) return st.current;
    if (st.other) return null;                       // чужой населённый пункт — не собираем
    return 'не определён (начало диапазона)';
  }

  // ------------------------------------------------------------ блоки → атомы
  // Блок делится на «число» и «текст», если число стоит в начале/в конце одной распознанной строки.
  function atomize(b) {
    const t = String(b.t || '').replace(/\s+/g, ' ').trim();
    if (!t) return [];
    const base = { y: b.y, h: b.h };
    const mk = (kind, text, x, w, v) => Object.assign({ kind, t: text, x, w, cx: x + w / 2, v }, base);
    let m = t.match(NUM_RX);
    if (m) return [mk('num', t, b.x, b.w, parseInt(m[1], 10))];
    m = t.match(LEAD_NUM_RX);
    if (m) {
      const k = m[1].length / t.length, wn = b.w * k;
      return [mk('num', m[1], b.x, wn, parseInt(m[1], 10)), mk('text', m[2].trim(), b.x + wn, b.w - wn)];
    }
    m = t.match(TRAIL_AGE_RX);
    if (m && parseInt(m[2], 10) > 0 && parseInt(m[2], 10) <= MAX_AGE) {
      const k = m[2].length / t.length, wn = b.w * k;
      return [mk('text', m[1].trim(), b.x, b.w - wn), mk('num', m[2], b.x + b.w - wn, wn, parseInt(m[2], 10))];
    }
    return [mk('text', t, b.x, b.w)];
  }

  function clusterRows(atoms) {
    const bs = atoms.slice().sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
    const tol = Math.max(3, median(bs.map((a) => a.h), 10) * 0.5);
    const rows = [];
    for (const a of bs) {
      const cy = a.y + a.h / 2;
      const last = rows[rows.length - 1];
      if (last && Math.abs(cy - last.cy) <= tol) {
        last.atoms.push(a);
        last.cy = (last.cy * (last.atoms.length - 1) + cy) / last.atoms.length;
      } else rows.push({ cy, atoms: [a] });
    }
    rows.forEach((r) => r.atoms.sort((a, b) => a.x - b.x));
    return rows;
  }

  // ----------------------------------------------------------- сбор по блокам
  function processBlocks(blocks, st, ctx, modeId, out) {
    const atoms = [];
    for (const b of blocks) atoms.push(...atomize(b));
    if (!atoms.length) return;
    const rows = clusterRows(atoms);

    const minX = Math.min(...atoms.map((a) => a.x));
    const maxX = Math.max(...atoms.map((a) => a.x + a.w));
    const colTol = Math.max(20, (maxX - minX) * 0.04);

    // 1. шапки колонок страницы → центры колонок (запоминаются для следующих страниц)
    for (const r of rows) for (const a of r.atoms) {
      if (a.kind !== 'text') continue;
      const k = kline(a.t);
      if (/^(?:мужеск|мужск)/.test(k)) st.cols.m = a.cx;
      else if (/^женск/.test(k)) st.cols.f = a.cx;
      else if (/^(?:номер\s+)?(?:двор\w*|дом\w*)$/.test(k)) st.cols.yard = a.cx;
    }
    const textXs = atoms.filter((a) => a.kind === 'text' && !/^(?:мужеск|женск|мужск)/.test(kline(a.t))).map((a) => a.x).sort((p, q) => p - q);
    const textLeft = textXs.length ? textXs[Math.floor(textXs.length * 0.1)] : Infinity;

    const genderFor = (cx) => {
      const { m, f } = st.cols;
      if (m !== null && f !== null) return Math.abs(cx - m) <= Math.abs(cx - f) ? 'м' : 'ж';
      return '';
    };

    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      let ats = row.atoms.slice();
      const joined = ats.map((a) => a.t).join(' ');
      const nextJoined = ri + 1 < rows.length ? rows[ri + 1].atoms.map((a) => a.t).join(' ') : '';

      // населённый пункт
      const h = Logic.matchHeader(joined, nextJoined, modeId);
      if (h) {
        applyHeader(st, out, h);
        if (Logic.isPrefixOnly(joined, modeId)) ri++;      // вторая половина разорванного заголовка
        continue;
      }
      const hasNum = ats.some((a) => a.kind === 'num');
      const k = kline(joined);
      const allHeads = ats.every((a) => { const ka = kline(a.t); return ARTIFACT.test(ka) || TITLE_NOISE.test(ka); });
      if (!hasNum && (ARTIFACT.test(k) || TITLE_NOISE.test(k) || allHeads)) { st.dropped++; continue; }
      if (ALWAYS_ARTIFACT.test(k)) { st.dropped++; continue; }
      // одиночные слова-шапки колонок («Двор», «Мужеск. пол») внутри строки с данными не удаляем
      const cur = settlementOf(st);
      if (cur === null) continue;
      ctx.settlement = cur;

      // 2. номер двора
      let yardNo = null;
      for (const a of ats) {
        if (a.kind !== 'text') continue;
        const y = Logic.matchYard(a.t, modeId);
        if (y) { yardNo = y.no; if (y.rest) { a.t = y.rest; } else a.dead = true; break; }
      }
      ats = ats.filter((a) => !a.dead);
      const nums = () => ats.filter((a) => a.kind === 'num' && !a.used);
      if (yardNo === null) {
        let cand = null;
        if (st.cols.yard !== null) cand = nums().find((a) => Math.abs(a.cx - st.cols.yard) <= colTol) || null;
        else {
          const texts = ats.filter((a) => a.kind === 'text');
          const firstText = texts.length ? texts[0].x : Infinity;
          const left = nums().filter((a) => a.cx < firstText);
          if (left.length >= 2) cand = left[0];
          else if (!texts.length && left.length === 1 && left[0].x < textLeft - colTol) cand = left[0];
        }
        if (cand) { yardNo = cand.v; cand.used = true; }
      } else {
        // номер двора найден по тексту «Двор № N» — число рядом с ним в той же строке не трогаем
      }
      if (yardNo !== null) startFamily(st, out, yardNo, ctx);

      // 3. люди строки
      const texts = ats.filter((a) => a.kind === 'text');
      if (!texts.length) {
        const lone = nums();
        if (lone.length && yardNo === null) {
          const fam = ensureFamily(st, out, ctx);
          addNote(fam, 'число без записи рядом (стр. ' + ctx.page + '): ' + lone.map((a) => a.v).join(', '));
        }
        continue;
      }
      const fam = ensureFamily(st, out, ctx);
      const people = texts.map((a) => ({ gender: genderFor(a.cx), no: '', text: a.t, age: '', atom: a }));

      // числа, лежащие между соседними записями (и до первой / после последней)
      const free = ats.filter((a) => a.kind === 'num' && !a.used);
      const gaps = people.map(() => []);               // gaps[i] — числа между записью i-1 и i (индекс 0 — до первой)
      const tail = [];
      for (const n of free) {
        let i = people.findIndex((p) => n.cx < p.atom.cx);
        if (i === -1) tail.push(n); else gaps[i].push(n);
      }
      const unmatched = [];
      const setAge = (p, n) => { if (n.v > 0 && n.v <= MAX_AGE) { p.age = n.v; return true; } return false; };
      people.forEach((p, i) => {
        const g = gaps[i];
        // слева от записи i: числа между записью i-1 и i
        const prev = i > 0 ? people[i - 1] : null;
        let own = [];                                  // числа, которые берёт запись i как свой номер
        let prevAge = null;                            // число, которое берёт запись i-1 как возраст
        if (!prev) own = g.slice(-1), unmatched.push(...g.slice(0, -1));
        else if (g.length === 1) {
          const n = g[0];
          const dPrev = n.cx - (prev.atom.x + prev.atom.w), dNext = p.atom.x - n.cx;
          if (prev.age === '' && dPrev <= dNext) prevAge = n; else own = [n];
        } else if (g.length >= 2) {
          prevAge = g[0]; own = [g[g.length - 1]]; unmatched.push(...g.slice(1, -1));
        }
        if (prevAge && !setAge(prev, prevAge)) unmatched.push(prevAge);
        if (own.length) { p.no = own[0].v; }
      });
      if (tail.length) {
        const last = people[people.length - 1];
        if (last.age === '' && setAge(last, tail[0])) unmatched.push(...tail.slice(1));
        else unmatched.push(...tail);
      }
      for (const p of people) {
        fam.persons.push({ gender: p.gender, no: p.no, text: p.text, age: p.age });
        if (!p.gender) addNote(fam, 'пол не определён: нет шапок «Мужеск.»/«Женск.» (стр. ' + ctx.page + ')');
      }
      if (unmatched.length) addNote(fam, 'несопоставленные числа (стр. ' + ctx.page + '): ' + unmatched.map((a) => a.v).join(', '));
    }
  }

  // ------------------------------------------------- запасной режим: только строки
  // Применяется, когда координат блоков получить не удалось: записи берутся строками как есть,
  // номер двора — по маркерам «Двор № N» / «№ N». Номер мужчины/женщины и возраст НЕ сопоставляются.
  function processLines(text, st, ctx, modeId, out) {
    const mode = Logic.getMode(modeId);
    const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const nxt = i + 1 < lines.length ? lines[i + 1] : '';
      const h = Logic.matchHeader(ln, nxt, modeId);
      if (h) { applyHeader(st, out, h); if (Logic.isPrefixOnly(ln, modeId)) i++; continue; }
      const y = Logic.matchYard(ln, modeId);
      const cur = settlementOf(st);
      if (cur === null) continue;
      ctx.settlement = cur;
      if (y) {
        startFamily(st, out, y.no, ctx);
        if (!y.rest) continue;
      }
      const body = y ? y.rest : ln;
      if (body.length < mode.minLineLen) continue;
      const k = kline(body);
      const hasNum = /\d/.test(body);
      if ((!hasNum && (ARTIFACT.test(k) || TITLE_NOISE.test(k))) || ALWAYS_ARTIFACT.test(k)) { st.dropped++; continue; }
      const fam = ensureFamily(st, out, ctx);
      addNote(fam, 'координаты блоков не получены: № и возраст не сопоставлены, записи даны строками как есть');
      fam.persons.push({ gender: '', no: '', text: body, age: '' });
    }
  }

  // «табличность» набора блоков: достаточно строк и не меньше 3 колонок (по x), в каждой не меньше 2 блоков
  function isTable(blocks, relaxed) {
    if (relaxed) return blocks.length >= 4 && new Set(blocks.map((b) => Math.round((b.y + b.h / 2) / 8))).size >= 2;
    if (blocks.length < 8) return false;
    if (new Set(blocks.map((b) => Math.round((b.y + b.h / 2) / 8))).size < 3) return false;
    const xs = blocks.map((b) => b.x).sort((a, b) => a - b);
    const gap = Math.max(20, (xs[xs.length - 1] - xs[0] + 1) * 0.04);
    let cols = 0, run = 1;
    for (let i = 1; i <= xs.length; i++) {
      if (i < xs.length && xs[i] - xs[i - 1] <= gap) run++;
      else { if (run >= 2) cols++; run = 1; }
    }
    return cols >= 3;
  }

  // page = {candidates: [{name, blocks}], text, url, page}. Берётся первый источник блоков, похожий на таблицу;
  // если такого нет — запасной режим по строкам текста.
  function processPage(page, st, modeId, out) {
    const ctx = { url: page.url, page: page.page, settlement: null };
    st.pages++;
    const cands = page.candidates || [{ name: 'блоки', blocks: page.blocks || [] }];
    for (const c of cands) {
      const blocks = (c.blocks || []).filter((b) => b && String(b.t || '').trim());
      // короткая страница (конец раздела) допускается, если прошлые страницы уже разобраны по этому же источнику блоков
      if (isTable(blocks, st.src === c.name)) {
        st.src = c.name;
        st.blockPages++;
        processBlocks(blocks, st, ctx, modeId, out);
        return 'блоки: ' + c.name;
      }
    }
    st.linePages++;
    processLines(page.text, st, ctx, modeId, out);
    return 'строки (координат нет)';
  }


  // ----------------------------------------- данные страницы (__NEXT_DATA__), ревизские сказки
  // Блок «Крестьяне/Крестьянки» целиком (текст НЕ делится на людей), строки таблицы вокруг него —
  // из соседних столбцов. Блоки с одним номером двора (мужские и женские) попадают в одну семью-двор.
  const FLAG_NOTE = {
    family_missing: 'номер двора у блока не найден',
    family_changes_inside_block: 'внутри блока меняется номер двора — проверить',
  };
  const SUSPECT = /^(?:span_conflict|multi_cell|weak_col|y_near)/;
  const ROLE_LABEL = { age_prev: 'по ревизии', age_mid: 'лѣта', departed_when: 'выбыл', absent_since: 'в отлучке с', age_now: 'нынѣ' };

  function rowText(r) {
    const parts = [];
    for (const role of RevisionRows.ROLES) if (r.cells[role]) parts.push(ROLE_LABEL[role] + ': ' + r.cells[role].text);
    return parts.join(' | ');
  }

  function totalsText(rep) {
    const names = { M: 'Муж.', F: 'Жен.' };
    const parts = Object.keys(rep.totals_check).map((sx) => {
      const c = rep.totals_check[sx];
      return `${names[sx]}: итого ${c.expected}, строк без выбытия ${c.rows_present} — ${c.ok ? 'сошлось' : 'НЕ СОШЛОСЬ'}`;
    });
    return parts.length ? parts.join('; ') : 'итоги внизу страницы не найдены';
  }

  // node = currentNode страницы; возвращает метку режима или null (тогда нужен запасной разбор)
  function processNode(node, page, st, modeId, out) {
    st.pages++;
    let rep;
    try { rep = RevisionRows.process(node); } catch (e) { return null; }
    if (rep.flags.some((f) => f.startsWith('count_mismatch'))) return null;
    const ctx = { url: page.url, page: page.page, settlement: null };
    if (!rep.blocks.length) {
      st.skipped.push(page.page);
      return 'данные страницы: нет таблицы «Крестьяне/Крестьянки» — страница пропущена';
    }

    // населённый пункт — по шапке страницы; повтор того же НП на следующей странице двор не разрывает
    const t = rep.titles;
    for (let i = 0; i < t.length; i++) {
      const h = Logic.matchHeader(t[i], t[i + 1] || '', modeId);
      if (!h) continue;
      const same = (h[0] === 'own' && st.current === h[1]) || (h[0] === 'other' && st.other === h[1]);
      if (!same) applyHeader(st, out, h);
      break;
    }
    const cur = settlementOf(st);
    if (cur === null) return 'данные страницы: чужой населённый пункт — пропущено';
    ctx.settlement = cur;

    // семьи-дворы страницы: по номеру двора, по порядку сверху вниз
    const groups = [];
    const byNo = new Map();
    let curG = null;
    for (const b of rep.blocks.slice().sort((p, q) => p.bbox[1] - q.bbox[1])) {
      if (b.family_no !== null && b.family_no !== undefined) {
        if (!byNo.has(b.family_no)) { const g = { no: b.family_no, blocks: [] }; byNo.set(b.family_no, g); groups.push(g); }
        curG = byNo.get(b.family_no);
      } else if (!curG) {
        curG = { no: null, blocks: [] };
        groups.push(curG);
      }
      curG.blocks.push(b);
    }

    let firstFam = null;
    for (const g of groups) {
      let fam;
      if (g.no === null) {
        const cont = st.fam && st.fam.settlement === cur;
        fam = ensureFamily(st, out, ctx);                 // продолжение двора с прошлой страницы
        if (!cont) addNote(fam, 'номер двора не найден (стр. ' + ctx.page + ')');
      } else if (st.fam && st.fam.settlement === cur && st.fam.yard === g.no) {
        fam = st.fam;                                     // тот же двор продолжается на странице
      } else {
        startFamily(st, out, g.no, ctx);
        fam = st.fam;
      }
      if (!firstFam) firstFam = fam;
      g.blocks.sort((p, q) => (p.sex === q.sex ? p.bbox[1] - q.bbox[1] : (p.sex === 'M' ? -1 : 1)));
      for (const b of g.blocks) {
        fam.persons.push({ gender: b.sex === 'M' ? 'м' : 'ж', no: '', text: b.names_text, age: '', rows: b.rows.map(rowText) });
        const rowFlags = b.rows.flatMap((r) => r.flags).filter((f) => SUSPECT.test(f));
        for (const f of b.flags) if (FLAG_NOTE[f]) addNote(fam, FLAG_NOTE[f] + ' (стр. ' + ctx.page + ')');
        if (rowFlags.length) addNote(fam, 'проверить строки блока ' + (b.sex === 'M' ? 'м' : 'ж') + b.block_no + ' (стр. ' + ctx.page + '): ' + [...new Set(rowFlags)].join(', '));
        for (const r of b.rows) {
          const c = (role) => (r.cells[role] ? r.cells[role].text : '');
          st.rows.push({ page: ctx.page, url: ctx.url, settlement: cur, yard: fam.yard, sex: b.sex === 'M' ? 'м' : 'ж',
            blockNo: b.block_no, rowNo: r.row_no, rowsInBlock: b.rows_in_block, names: b.names_text,
            agePrev: c('age_prev'), departed: c('departed_when'), absent: c('absent_since'), ageNow: c('age_now'),
            flags: b.flags.concat(r.flags).join(';') });
        }
      }
    }
    if (rep.orphans.length) {
      st.orphans += rep.orphans.length;
      if (firstFam) addNote(firstFam, 'несопоставленные ячейки (стр. ' + ctx.page + '): ' + rep.orphans.map((o) => o.text).join(' | '));
    }
    st.checks[ctx.page] = totalsText(rep);
    for (const f of rep.flags) if (f.startsWith('totals_mismatch') && firstFam) addNote(firstFam, 'итоги страницы не сошлись (стр. ' + ctx.page + '): ' + totalsText(rep));
    st.blockPages++;
    return 'данные страницы (__NEXT_DATA__): блоков ' + rep.blocks.length + ', строк ' + rep.blocks.reduce((a, b) => a + b.rows_in_block, 0);
  }

  // ----------------------------------------- данные страницы (__NEXT_DATA__), исповедные ведомости
  // Основной блок (список людей) — текст как распознан, НЕ делится на людей. К нему привязаны соседние столбцы:
  // слева № двора, № мужчины, № женщины; справа лѣта мужеска / женска. «Показанія дѣйства» не собираются.
  // Один человек = одна строка таблицы (номер и возраст на одной высоте). Двор действует вниз до следующего номера.
  const CONF_FLAG_NOTE = {
    age_without_number: 'возраст без номера человека',
    no_main_block: 'строка не попала ни в один блок текста',
    two_yard_numbers: 'два номера двора у одной строки',
    split_cell: 'два номера в одной ячейке разделены по высоте',
    sex_unknown: 'пол не определён (возраст из общего столбца) — проверить',
  };
  // пояснения к людям (не ошибки)
  const CONF_INFO_NOTE = {
    age_next_line: 'ⓘ возраст записан строкой ниже номера',
  };
  // пояснения к странице (не ошибки): что алгоритм сделал со столбцами
  const CONF_PAGE_INFO = {
    age_column_split: 'столбцы возраста мужчин и женщин слиты — разделены по положению',
    number_column_split: 'столбцы номеров мужчин и женщин слиты — разделены по положению',
    age_by_row: 'один столбец возраста — пол взят по номеру в строке',
    no_person_numbers: 'форма ведомости без нумерации людей',
  };

  // флаги страницы — по-русски
  function humanFlag(f) {
    let m;
    if ((m = f.match(/^half(\d+):(.*)$/))) return 'лист ' + m[1] + ': ' + humanFlag(m[2]);
    if ((m = f.match(/^seq_breaks_([MF])=(\d+)\/(\d+)/))) return `номера ${m[1] === 'M' ? 'мужчин' : 'женщин'} не подряд в ${m[2]} местах из ${m[3]} (пропуск или ошибка распознавания)`;
    if ((m = f.match(/^age_columns_(\d)/))) return `найдено столбцов возраста: ${m[1]} из 2`;
    if (f === 'yard_column_not_found') return 'столбец № двора не найден';
    if (f === 'age_zone_wide') return 'столбцы возраста найдены дальше обычного от списка';
    if (CONF_PAGE_INFO[f]) return CONF_PAGE_INFO[f];
    if (f === 'left_columns_2_sex_unknown') return 'слева найдено 2 столбца из 3 — пол по номеру не определён';
    if ((m = f.match(/^orphans:(\d+)/))) return `номеров двора без строки: ${m[1]}`;
    return f;
  }

  function processConfessionNode(node, page, st, modeId, out) {
    st.pages++;
    let rep;
    try { rep = ConfessionRows.process(node); } catch (e) { return null; }
    if (rep.flags.some((f) => f.startsWith('count_mismatch'))) return null;
    st.lastRep = rep;
    const ctx = { url: page.url, page: page.page, settlement: null };
    if (!rep.persons.length) {
      st.skipped.push(page.page);
      st.checks[page.page] = 'таблица не найдена: ' + rep.flags.join(', ');
      return 'данные страницы: таблица людей не найдена — страница пропущена (' + rep.flags.join(', ') + ')';
    }
    let lastBlockKey = null, curPerson = null, firstFam = null;
    let kept = 0;
    const rowsStart = st.rows.length;
    if (!st.blocks) st.blocks = [];
    for (const [pi, p] of rep.persons.entries()) {
      if (!st.current && !st.other && !p.settlement_here && ConfessionRows.numberingRestart(rep.persons, pi)) {
        // до первого заголовка НП нумерация людей началась с 1 — отсюда ведомость прихода, её первый НП по порядку
        const order = page.year && page.year < 1750 ? ConfessionRows.ORDER_BEFORE_1750 : ConfessionRows.ORDER_FROM_1750;
        applyHeader(st, out, ['own', order[0]]);
        st.pendingNote = 'НП по порядку: начало ведомости, нумерация людей с 1 (стр. ' + page.page + ')';
        lastBlockKey = null;
      }
      if (p.settlement_here) {
        const [name, note] = ConfessionRows.resolveSettlement(p.settlement_here, st.current, page.year);
        const own = !String(name).startsWith('чужой НП');
        const same = own && st.current === name;
        if (!same) applyHeader(st, out, own ? ['own', name] : ['other', name]);
        if (note) st.pendingNote = note + ' (стр. ' + page.page + ')';
        lastBlockKey = null;
      }
      const cur = settlementOf(st);
      if (cur === null) continue;                       // чужой населённый пункт — не собираем
      ctx.settlement = cur;
      if (p.yard_mark) {
        if (!(st.fam && st.fam.settlement === cur && String(st.fam.yard) === String(p.yard_mark))) {
          startFamily(st, out, parseInt(p.yard_mark, 10), ctx);
        }
        lastBlockKey = null;
      }
      const fam = ensureFamily(st, out, ctx);
      if (!firstFam) firstFam = fam;
      const notes = [];                                   // примечание к строке человека
      if (st.pendingNote) { addNote(fam, st.pendingNote); notes.push(st.pendingNote); st.pendingNote = null; }
      if (fam.noYard && !fam.noYardNoted) { const t = 'номер двора не найден (стр. ' + page.page + ')'; addNote(fam, t); notes.push(t); fam.noYardNoted = true; }
      const blockKey = page.page + ':' + (p.block_id || 'нет');
      if (blockKey !== lastBlockKey || !curPerson || fam.persons[fam.persons.length - 1] !== curPerson) {
        curPerson = { gender: '', no: '', text: p.names_text || '(текст блока не найден)', age: '', rows: [] };
        fam.persons.push(curPerson);
        lastBlockKey = blockKey;
        st.blocks.push({ page: page.page, url: page.url, settlement: cur, yard: fam.yard, text: p.names_text || '', persons: 0 });
      }
      st.blocks[st.blocks.length - 1].persons++;
      const sx = p.sex === 'M' ? 'м' : 'ж';
      curPerson.rows.push(sx + (p.no ? '№' + p.no : '№?') + (p.age ? ', возр. ' + p.age : ''));
      for (const f of p.flags) {
        if (CONF_FLAG_NOTE[f]) { addNote(fam, CONF_FLAG_NOTE[f] + ' (стр. ' + page.page + ')'); notes.push(CONF_FLAG_NOTE[f]); }
        if (CONF_INFO_NOTE[f]) notes.push(CONF_INFO_NOTE[f]);
        if (f.startsWith('split:')) notes.push(f.slice(6));
        // номера, исправленные по соседям (сквозная нумерация): только в строку человека
        let fm;
        if ((fm = f.match(/^no_fixed:(.*)$/))) notes.push(`номер исправлен по соседям (распознано «${fm[1]}»)`);
        if ((fm = f.match(/^joined_cell:(.*)$/))) notes.push(`номер склеен из «${fm[1]}»`);
        if ((fm = f.match(/^extra_number:(.*)$/))) notes.push(`число «${fm[1]}» в столбце номеров — не номер человека`);
        if (f === 'no_restored') notes.push('номер не распознан, восстановлен по соседям');
      }
      st.rows.push({ page: page.page, url: page.url, settlement: cur, yard: fam.yard, half: p.half, sex: sx, no: p.no,
        age: p.age, inBlock: p.person_in_block, person: p.person_text || '', names: p.names_text, notes, flags: p.flags.join(';') });
      kept++;
    }
    const pageFlags = rep.flags.filter((f) => /seq_breaks|age_columns|yard_column|left_columns|orphans/.test(f));
    if (pageFlags.length && firstFam) addNote(firstFam, 'проверить страницу ' + page.page + ': ' + pageFlags.map(humanFlag).join('; '));
    if (pageFlags.length && st.rows.length > rowsStart) st.rows[rowsStart].notes.push('проверить страницу ' + page.page + ': ' + pageFlags.map(humanFlag).join('; '));
    const infoFlags = rep.flags.filter((f) => CONF_PAGE_INFO[f.replace(/^half\d+:/, '')]);
    if (infoFlags.length && st.rows.length > rowsStart) st.rows[rowsStart].notes.push('ⓘ стр. ' + page.page + ': ' + infoFlags.map(humanFlag).join('; '));
    st.checks[page.page] = rep.halves.map((h) => 'лист ' + h.no + ': ' +
      ['yard', 'm_no', 'f_no', 'age_m', 'age_f'].map((k) => ({ yard: 'двор', m_no: '№м', f_no: '№ж', age_m: 'возр.м', age_f: 'возр.ж' }[k]) + '=' + (h.columns[k] ? h.columns[k].cells : 0)).join(' ') +
      ', людей ' + h.people).join('; ') + (rep.flags.length ? ' | ' + rep.flags.map(humanFlag).join('; ') : '');
    st.blockPages++;
    return 'данные страницы (__NEXT_DATA__): листов ' + rep.halves.length + ', людей ' + rep.persons.length + (kept !== rep.persons.length ? ` (в округе ${kept})` : '');
  }

  function finish(st, out) { flush(st, out); }

  // ------------------------------------------------------------ вывод в ячейку
  function formatPerson(p) {
    const label = (p.gender || '') + (p.no !== '' && p.no !== undefined ? '№' + p.no : '');
    const head = (label ? label + ' ' : '') + p.text + (p.age !== '' && p.age !== undefined ? ', возр. ' + p.age : '');
    if (!p.rows || !p.rows.length) return head;
    return head + '\n' + p.rows.map((r, i) => '   ' + (i + 1) + ') ' + (r || '—')).join('\n');
  }
  const familyCell = (fam) => fam.persons.map(formatPerson).join('\n');

  const api = { newState, processPage, processNode, processConfessionNode, finish, formatPerson, familyCell, atomize, clusterRows, isTable };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Layout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
