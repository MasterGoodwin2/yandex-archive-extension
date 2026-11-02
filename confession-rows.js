// Исповедные ведомости: перепривязка соседних столбцов к Основному блоку (список людей).
// Перенос на JS скрипта навыка yaarchive-revision-rows (scripts/extract_confession.py) — результаты совпадают
// (проверка: node tests/run_confession.js). Работает по готовым данным страницы (__NEXT_DATA__ -> currentNode):
//   joinedTextBlocks[i] = {id, points[4]} (координаты на скане), textBlocks[i] = {id, text} — в одном порядке.
// Слева от Основного блока: № двора | № мужчины | № женщины; справа: лѣта мужеска | лѣта женска.
// Столбцы «Показанія дѣйства» не собираются. Все допуски — в долях скана или размера числа (не в пикселях),
// поэтому сканы разного разрешения обрабатываются одинаково. Текст НЕ разбирается и НЕ меняется.
(function (root) {
  'use strict';

  const DEFAULTS = { mainMinW: 0.08, leftZone: 0.14, rightZone: 0.09, colGap: 0.35, maxHalves: 2, ageTol: 0.8 };
  const MAP = { 'ѣ': 'е', 'і': 'и', 'i': 'и', 'ѳ': 'ф', 'ѵ': 'и', 'ё': 'е', 'ѡ': 'о', 'ꙋ': 'у', 'ѯ': 'кс' };

  const NUM_RE = /^\s*(?:№|N)?\s*(\d{1,4})\s*[.,:;]?\s*$/u;
  const MULTI_RE = /^\s*\d{1,4}(?:\s*[.,]?\s+\d{1,4})+\s*[.,]?\s*$/u;
  const AGE_RE = /^\s*(\d{1,3})?\s*(\d\s*\/\s*\d)?\s*[.,]?\s*$/u;
  const HEADER_WORDS = /(числ|двор|домов|людей|мужеск|женск|лет(?![\p{L}\p{N}_])|лет |рожден|показан|исповед|причаст|не были|пола)/u;
  const SKIP_HEAD = /(показан|исповед|причаст|не были)/u;
  const W_ = '[\\p{L}\\p{N}_]';
  const B_ = `(?<!${W_})`;                     // \b начала слова (в JS \b не знает кириллицы)

  const SETTLEMENTS = {
    'село Троицкое': 'троицк',
    'деревня Острогина': 'острогин',
    'деревня Черепкова': 'черепков',
    'деревня Рублева': 'рублев',
    'деревня Луки': `лук(?:и|ъ)?(?!${W_})`,
    'деревня Мякинина': '(?:м[яе]кинин|мемин)',
    'деревня Екатериненская': `екатерин${W_}*ск`,
  };
  const SETTLE_PREFIX = `(?:${B_}сел${W_}*\\.?|${B_}дер${W_}*\\.?|${B_}дрв${W_}*|${B_}д\\.|${B_}с\\.)\\s*[\\[(«"]?\\s*`;
  const SETTLE_RX = Object.fromEntries(Object.entries(SETTLEMENTS).map(([k, v]) => [k, new RegExp(SETTLE_PREFIX + v, 'u')]));
  const SAME_VILLAGE = new RegExp(`${B_}того\\s+сел`, 'u');
  const OTHER_RX = new RegExp(`(?:${B_}сел${W_}*|${B_}дер${W_}*|${B_}дрв${W_}*|${B_}дрвн${W_}*)\\.?\\s+([а-я]{4,})`, 'u');
  const SETTLE_STEMS = { 'село Троицкое': 'троицк', 'деревня Острогина': 'острогин', 'деревня Черепкова': 'черепков',
    'деревня Рублева': 'рублев', 'деревня Мякинина': 'мякинин',
    'деревня Екатериненская': 'екатерин' };
  const ORDER_BEFORE_1750 = ['село Троицкое', 'деревня Черепкова', 'деревня Острогина', 'деревня Рублева', 'деревня Луки', 'деревня Мякинина'];
  const ORDER_FROM_1750 = ['село Троицкое', 'деревня Острогина', 'деревня Черепкова', 'деревня Рублева', 'деревня Луки'];

  const norm = (t) => String(t || '').toLowerCase().replace(/[ѣіiѳѵёѡꙋѯ]/g, (c) => MAP[c])
    .replace(/[ъь]/g, '').replace(/[^\p{L}\p{N}_\s/]/gu, ' ').replace(/\s+/g, ' ').trim();
  const letters = (s) => (String(s).match(/\p{L}/gu) || []).length;
  // заголовок НП начинается с «Деревни/Села/д./с.» и может быть длинным («Деревни Мякининой Генералъ-Лейтенанта…»)
  const HEAD_START = /^[^\p{L}]*(?:дер\p{L}*|дрв\p{L}*|сел\p{L}*|д\.|с\.|того\s+сел)/u;
  // итоговые и служебные фразы ведомости («Сверхъ вышеписаннаго… утаенныхъ дворовъ…», «…руку приложилъ») — не список семьи
  const BOILER_RX = /(вышеписан|исповедал|причасти|показан[ыо]|приложил|по указу|сказк|утаен|прописн|обретает|всего при|подлинно|руку|мужеска пола|женска пола)/;
  function boilerplate(text) {
    if (!BOILER_RX.test(norm(text))) return false;
    return String(text).split(/\s+/).filter((t) => t && nameSex(t, [], [])).length <= 1;
  }
  function settlementHeader(text, nLetters) {
    const n = norm(text);
    const [name, how] = settlementOf(text);
    if (name && (nLetters < 45 || (HEAD_START.test(n) && nLetters < 140))) return [name, how];
    return [null, null];
  }

  function lev(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)));
      prev = cur;
    }
    return prev[b.length];
  }

  function settlementOf(text) {
    const n = norm(text);
    if (SAME_VILLAGE.test(n)) return ['село Троицкое', 'того села'];
    for (const [name, rx] of Object.entries(SETTLE_RX)) if (rx.test(n)) return [name, 'заголовок'];
    const m = n.match(OTHER_RX);
    if (m && n.length < 60) {
      const w = m[1];
      for (const [name, stem] of Object.entries(SETTLE_STEMS)) {
        if (lev(w.slice(0, stem.length), stem) <= Math.max(1, Math.floor(stem.length / 4))) return [name, 'похоже на «' + w + '»'];
      }
      return ['other:' + w, 'заголовок'];
    }
    return [null, null];
  }

  const median = (arr) => {
    if (!arr.length) return 0;
    const s = arr.slice().sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const mean = (arr) => arr.reduce((p, q) => p + q, 0) / arr.length;
  function pct(vals, q) {
    const s = vals.slice().sort((x, y) => x - y);
    if (!s.length) return 0;
    const k = (s.length - 1) * q, lo = Math.floor(k), hi = Math.min(lo + 1, s.length - 1);
    return s[lo] + (s[hi] - s[lo]) * (k - lo);
  }

  function mkBlk(i, j, t) {
    const pts = j.points || [];
    if (!pts.length) throw new Error('пустой polygon у блока ' + j.id);
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys);
    const b = { i, id: j.id, tid: t.id, text: String(t.text || '').trim(), x0, y0, x1, y1,
      w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, kind: 'text', vals: [] };
    let m = b.text.match(NUM_RE);
    if (m) { b.kind = 'num'; b.vals = [m[1]]; return b; }
    if (MULTI_RE.test(b.text)) { b.kind = 'multi'; b.vals = b.text.match(/\d{1,4}/g); return b; }
    m = b.text.match(AGE_RE);
    if (m && (m[1] || m[2])) { b.kind = 'frac'; b.vals = [b.text.trim().replace(/^[ .,]+|[ .,]+$/g, '').replace(/\s+/g, ' ')]; }
    return b;
  }

  // ----------------------------------------------------------------- столбцы
  function deskewSlope(blocks, sigma, ymid) {
    if (blocks.length < 6) return 0;
    const pts = blocks.map((b) => [b.cx, b.cy - ymid]);
    let best = -1, bestS = 0;
    for (let k = -40; k <= 40; k++) {
      const s = k * 0.0015;
      const xs = pts.map(([x, y]) => x - s * y).sort((p, q) => p - q);
      let score = 0;
      for (let i = 0; i < xs.length; i++) {
        for (let j = i + 1; j < xs.length; j++) {
          const d = (xs[j] - xs[i]) / sigma;
          if (d > 3) break;
          score += Math.exp(-d * d);
        }
      }
      if (score > best + 1e-9 || (Math.abs(score - best) <= 1e-9 && Math.abs(s) < Math.abs(bestS))) { best = score; bestS = s; }
    }
    return bestS;
  }

  function clusterColumns(blocks, gap, ymid, slope) {
    if (!blocks.length) return [];
    const xs = blocks.map((b) => [b.cx - slope * (b.cy - ymid), b]).sort((p, q) => p[0] - q[0]);
    const groups = [[xs[0]]];
    for (const it of xs.slice(1)) {
      const g = groups[groups.length - 1];
      if (it[0] - g[g.length - 1][0] > gap) groups.push([it]); else g.push(it);
    }
    return groups.map((g) => ({ blocks: g.map((t) => t[1]).sort((p, q) => p.cy - q.cy), b: slope,
      center: median(g.map((t) => t[0])) })).sort((p, q) => p.center - q.center);
  }

  // один столбец возраста при двух столбцах номеров: «лѣта мужеска / женска» слиплись — делим по x' (2-средних)
  // сколько раз номера сверху вниз идут не подряд (0 < шаг <= 3)
  function increasingBreaks(blocks) {
    const vals = blocks.slice().sort((p, q) => p.cy - q.cy).flatMap((b) => b.vals).filter((v) => /^\d+$/.test(String(v))).map(Number);
    let br = 0; for (let i = 1; i < vals.length; i++) { const d = vals[i] - vals[i - 1]; if (!(d > 0 && d <= 3)) br++; }
    return [br, vals.length];
  }
  // номера мужчин и женщин в двух узких столбцах вплотную слиплись: делим по x и проверяем, что в каждой части
  // номера идут подряд, а вместе — нет
  function splitNumberColumn(col, slope, ymid, medW) {
    const sp = splitAgeColumn(col, slope, ymid, medW, 0.15);
    if (!sp) return null;
    const [b1, n1] = increasingBreaks(sp[0].blocks), [b2, n2] = increasingBreaks(sp[1].blocks), [ba, na] = increasingBreaks(col.blocks);
    return n1 >= 3 && n2 >= 3 && b1 <= 0.25 * n1 && b2 <= 0.25 * n2 && ba > 0.3 * na ? sp : null;
  }
  function splitAgeColumn(col, slope, ymid, medW, minSep = 0.8) {
    const xs = col.blocks.map((b) => [b.cx - slope * (b.cy - ymid), b]);
    if (xs.length < 6) return null;
    let lo = Math.min(...xs.map((t) => t[0])), hi = Math.max(...xs.map((t) => t[0]));
    const mean = (v) => v.reduce((p, q) => p + q, 0) / v.length;
    for (let it = 0; it < 25; it++) {
      const a = xs.filter((t) => Math.abs(t[0] - lo) <= Math.abs(t[0] - hi)).map((t) => t[0]);
      const b = xs.filter((t) => Math.abs(t[0] - lo) > Math.abs(t[0] - hi)).map((t) => t[0]);
      if (!a.length || !b.length) return null;
      const nlo = mean(a), nhi = mean(b);
      if (nlo === lo && nhi === hi) break;
      lo = nlo; hi = nhi;
    }
    let left = xs.filter((t) => Math.abs(t[0] - lo) <= Math.abs(t[0] - hi)).map((t) => t[1]);
    let right = xs.filter((t) => Math.abs(t[0] - lo) > Math.abs(t[0] - hi)).map((t) => t[1]);
    // уточнение: у каждого столбца свой наклон — прямая x = a + k·y по группе, число к ближайшей прямой
    const fit = (bl) => {
      const my = mean(bl.map((b) => b.cy)), mx = mean(bl.map((b) => b.cx));
      const syy = bl.reduce((p, b) => p + (b.cy - my) ** 2, 0);
      const k = syy ? bl.reduce((p, b) => p + (b.cy - my) * (b.cx - mx), 0) / syy : 0;
      return [mx - k * my, k];
    };
    for (let it = 0; it < 10 && left.length >= 3 && right.length >= 3; it++) {
      const [a1, k1] = fit(left), [a2, k2] = fit(right);
      const near1 = (b) => Math.abs(b.cx - (a1 + k1 * b.cy)) <= Math.abs(b.cx - (a2 + k2 * b.cy));
      const nl = col.blocks.filter(near1), nr = col.blocks.filter((b) => !near1(b));
      const same = nl.length === left.length && nl.every((b) => left.includes(b));
      left = nl; right = nr;
      if (same) break;
    }
    if (left.length >= 3 && right.length >= 3) {
      const [a1, k1] = fit(left), [a2, k2] = fit(right);
      lo = a1 + k1 * ymid; hi = a2 + k2 * ymid;
    }
    if (hi - lo < minSep * medW || Math.min(left.length, right.length) < 0.2 * xs.length) return null;
    const mk = (bl, c) => ({ blocks: bl.sort((p, q) => p.cy - q.cy), b: slope, center: c });
    return [mk(left, lo), mk(right, hi)];
  }

  function stableByY(blocks, eps) {
    const bs = blocks.slice().sort((p, q) => p.cy - q.cy);
    const out = []; let grp = [];
    const flushG = () => { out.push(...grp.sort((p, q) => (p.cx - q.cx) || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0))); grp = []; };
    for (const b of bs) {
      if (grp.length && b.cy - grp[0].cy >= eps) flushG();
      grp.push(b);
    }
    flushG();
    return out;
  }

  function shiftLine(pairs, medH) {
    if (!pairs.length) return [0, 0];
    let pts = pairs.slice(), c0 = 0, c1 = 0;
    for (let it = 0; it < 3; it++) {
      if (pts.length < 4) return [median(pts.map((p) => p[1])), 0];
      const my = mean(pts.map((p) => p[0])), md = mean(pts.map((p) => p[1]));
      const syy = pts.reduce((a, p) => a + (p[0] - my) ** 2, 0);
      c1 = syy ? pts.reduce((a, p) => a + (p[0] - my) * (p[1] - md), 0) / syy : 0;
      c0 = md - c1 * my;
      const keep = pts.filter(([y, d]) => Math.abs(d - (c0 + c1 * y)) <= 0.5 * medH);
      if (keep.length === pts.length || keep.length < 4) break;
      pts = keep;
    }
    return [c0, c1];
  }

  function align(av, pv, tol) {
    const n = av.length, m = pv.length, gap = 0.6 * tol;
    const D = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(Infinity));
    const B = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));
    D[0][0] = 0;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= m; j++) {
        if (!i && !j) continue;
        let best = Infinity, bk = null;
        if (i && D[i - 1][j] + gap < best) { best = D[i - 1][j] + gap; bk = [i - 1, j, false]; }
        if (j && D[i][j - 1] + gap < best) { best = D[i][j - 1] + gap; bk = [i, j - 1, false]; }
        if (i && j) {
          const d = Math.abs(av[i - 1] - pv[j - 1]);
          if (d <= tol && D[i - 1][j - 1] + d < best) { best = D[i - 1][j - 1] + d; bk = [i - 1, j - 1, true]; }
        }
        D[i][j] = best; B[i][j] = bk;
      }
    }
    const out = []; let i = n, j = m;
    while (i || j) { const [pi, pj, mt] = B[i][j]; if (mt) out.push([i - 1, j - 1]); i = pi; j = pj; }
    return out.reverse();
  }


  // ----------------------------------------------------------------- деление текста блока на людей
  // Перенос skill/.../scripts/split_names.py. Координат строк внутри блока нет, поэтому текст делится по именам
  // (словарь NamesRu); какие имена — люди, а какие — ссылки в родительном падеже, решает сверка с полом строк
  // таблицы (м№ / ж№ сверху вниз). Слова не исправляются.
  const NamesRu = root.NamesRu || (typeof require !== 'undefined' ? require('./names-ru.js') : { M: [], F: [] });
  const NM = new Set(NamesRu.M), NF = new Set(NamesRu.F);
  const NMF = new Set([...NamesRu.M, ...NamesRu.F]);
  const RELATION = new Set(['сн', 'снъ', 'дщ', 'дщерь', 'жена', 'муж', 'сын', 'сына', 'сыновья', 'сыновя', 'сынов', 'дочь', 'дочери', 'дочерь', 'дети', 'детей', 'дочи',
    'брат', 'братья', 'брата', 'сестра', 'сестры', 'мать', 'мачеха', 'отец', 'отчим', 'вдова', 'вдовец', 'вдов',
    'зять', 'сноха', 'невестка', 'внук', 'внуки', 'внучка', 'внучки', 'племянник', 'племянница', 'племянники',
    'пасынок', 'пасынки', 'падчерица', 'падчерицы', 'приемыш', 'приемышь', 'приемышъ', 'теща', 'тесть', 'деверь',
    'свекровь', 'свекор', 'тетка', 'дядя', 'шурин', 'свояк', 'золовка', 'крестник', 'крестница', 'работник',
    'работница', 'солдатка', 'салдатка', 'солдат', 'бобыль', 'бобылка', 'девка', 'свойственник', 'питомец',
    'воспитанник', 'воспитанница', 'кума', 'кум', 'сирота', 'двоюродной', 'двоюродный', 'родной', 'сводной']);
  const PRON = new Set(['его', 'ево', 'ея', 'ее', 'её', 'их', 'ихь', 'ихъ', 'же', 'жъ', 'ж', 'него', 'ней', 'нея', 'оного', 'оной']);
  const NKMAP = { 'ѣ': 'е', 'і': 'и', 'i': 'и', 'ѳ': 'ф', 'ѵ': 'и', 'ё': 'е', 'ѡ': 'о', 'ꙋ': 'у' };
  const nk = (w) => String(w || '').toLowerCase().replace(/ѯ/g, 'кс').replace(/[ѣіiѳѵёѡꙋ]/g, (c) => NKMAP[c])
    .replace(/[^а-я]/g, '').replace(/ъ$/, '');
  function edit1(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    if (a.length === b.length) { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d === 1; }
    if (a.length > b.length) [a, b] = [b, a];
    let i = 0; while (i < a.length && a[i] === b[i]) i++;
    return a.slice(i) === b.slice(i + 1);
  }
  // ключ для старых и народных написаний: о→а, е→и, без ь, й→и, без удвоений («огрофена» = «аграфена», «серьгеи» = «сергей»)
  const loose = (k) => k.replace(/ь/g, '').replace(/о/g, 'а').replace(/е/g, 'и').replace(/й/g, 'и').replace(/(.)\1+/g, '$1');
  const LOOSE = new Map();
  for (const [sx, list] of [['M', NamesRu.M], ['F', NamesRu.F]]) for (const n of list) {
    const k = loose(n); if (!LOOSE.has(k)) LOOSE.set(k, new Set()); LOOSE.get(k).add(sx);
  }
  const looseSex = (k) => { const h = LOOSE.get(loose(k)); return h && h.size === 1 ? [...h][0] : null; };
  const genForm = (k) => ((/[ая]$/.test(k) && (NM.has(k.slice(0, -1)) || NM.has(k.slice(0, -1) + 'й') || NM.has(k.slice(0, -2) + 'ий')))
    || (/[ыи]$/.test(k) && (NMF.has(k.slice(0, -1) + 'а') || NMF.has(k.slice(0, -1) + 'я'))));
  function nameSex(tok, nxt, prv) {
    const k = nk(tok);
    if (k.length < 3) return null;
    const nx = nxt.slice(0, 2).map(nk);
    const relAfter = nx.length > 0 && (RELATION.has(nx[0]) || (nx.length > 1 && RELATION.has(nx[1]) && /(ова|ева|ина|ына|а|я)$/.test(nx[0])));
    const g = genForm(k);
    const afterRel = prv.slice(-2).some((t) => RELATION.has(nk(t)));
    const ref = !!(g && relAfter && !afterRel);
    if (NM.has(k)) return ['M', ref];
    if (NF.has(k)) return ['F', ref];
    if (g || /(ов|ев|ин|ова|ева|ина|ича|вна|овы|евы)$/.test(k)) return null;
    // «депетр», «дефеодор»: сокращение «де(ти)», приклеенное распознаванием к имени
    if (k.startsWith('де') && k.length >= 6 && !NMF.has(k)) {
      const r = k.slice(2);
      const sx = NM.has(r) ? 'M' : NF.has(r) ? 'F' : looseSex(r);
      if (sx) return [sx, false];
    }
    if (k.length >= 4) { const sx = looseSex(k); if (sx) return [sx, false]; }
    if (k.length >= 5) {
      const hits = new Set();
      for (const [sx, set] of [['M', NamesRu.M], ['F', NamesRu.F]]) {
        for (const n of set) if (Math.abs(n.length - k.length) <= 1 && n[0] === k[0] && edit1(k, n)) { hits.add(sx); break; }
      }
      if (hits.size === 1) return [[...hits][0], false];
    }
    return null;
  }
  function isRef(tok, seen, nxt) {
    const k = nk(tok);
    if (k.length < 4) return false;
    if (/[ая]$/.test(k) && (NM.has(k.slice(0, -1)) || NM.has(k.slice(0, -1) + 'й') || NM.has(k.slice(0, -2) + 'ий'))) return true;
    if (/[ыи]$/.test(k) && (NM.has(k.slice(0, -1) + 'а') || NM.has(k.slice(0, -1) + 'я'))) return true;
    const m = k.match(/^(.+?)(ова|ева|ина|ына|ов|ев|ин|ын)$/);
    const nx = nxt.slice(0, 2).map(nk);
    if (m && nx.length && RELATION.has(nx[0]) && !(nx.length > 1 && PRON.has(nx[1]))) {
      const base = m[1];
      for (const v of [base, base + 'а', base + 'я', base + 'й', base.endsWith('ь') ? base.slice(0, -1) + 'ий' : base + 'ий']) if (seen.has(v)) return true;
    }
    return false;
  }
  function alignNames(cands, sexes) {
    const n = cands.length, m = sexes.length, NEG = -1e9;
    const D = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(NEG));
    const B = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));
    D[0][0] = 0;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= m; j++) {
        if (!i && !j) continue;
        let best = NEG, bk = null;
        const skip = i && cands[i - 1][2] ? 0 : 0.6;
        if (i && D[i - 1][j] - skip > best) { best = D[i - 1][j] - skip; bk = [i - 1, j, false]; }
        if (j && D[i][j - 1] - 1.5 > best) { best = D[i][j - 1] - 1.5; bk = [i, j - 1, false]; }
        if (i && j) {
          const sc = cands[i - 1][1] === sexes[j - 1] ? (cands[i - 1][2] ? 1.2 : 2.0) : -0.4;
          if (D[i - 1][j - 1] + sc > best) { best = D[i - 1][j - 1] + sc; bk = [i - 1, j - 1, true]; }
        }
        D[i][j] = best; B[i][j] = bk;
      }
    }
    const out = new Map(); let i = n, j = m;
    while (i || j) { const [pi, pj, mt] = B[i][j]; if (mt) out.set(j - 1, i - 1); i = pi; j = pj; }
    return out;
  }
  function splitBlock(text, sexes) {
    const toks = String(text || '').split(/\s+/).filter(Boolean);
    if (!sexes.length) return [];
    if (sexes.length === 1) return [[String(text || '').trim(), '']];
    const cands = [];
    toks.forEach((t, i) => { const r = nameSex(t, toks.slice(i + 1, i + 3), toks.slice(Math.max(0, i - 2), i)); if (r) cands.push([i, r[0], r[1]]); });
    const match = alignNames(cands, sexes);
    const starts = [...match.entries()].map(([j, c]) => [cands[c][0], j]).sort((p, q) => p[0] - q[0]);
    const segStart = new Map(); let prevName = null; const seen = new Set();
    for (const [pos, j] of starts) {
      if (prevName === null) segStart.set(j, 0);
      else {
        let k = pos;
        const gap = []; for (let g = prevName + 1; g < pos; g++) gap.push(g);
        const rel = gap.filter((g) => RELATION.has(nk(toks[g])));
        if (rel.length) {
          k = rel[0];
          while (k - 1 > prevName && PRON.has(nk(toks[k - 1]))) k--;
          const refs = gap.filter((g) => g < k && isRef(toks[g], seen, toks.slice(g + 1, g + 3)));
          if (refs.length) k = refs[0];
          else if (k - 1 > prevName + 1 && !/(ов|ев|ин)$/.test(nk(toks[k - 1]))) k--;
        }
        segStart.set(j, k);
      }
      prevName = pos;
      seen.add(nk(toks[pos]));
    }
    const order = [...segStart.entries()].sort((p, q) => p[1] - q[1]);
    const res = sexes.map(() => ['', 'имя в тексте блока не найдено']);
    order.forEach(([j, st], n) => {
      const en = n + 1 < order.length ? order[n + 1][1] : toks.length;
      res[j] = [toks.slice(st, en).join(' '), cands[match.get(j)][1] === sexes[j] ? '' : 'пол по имени не совпал со столбцом'];
    });
    return res;
  }

  // ----------------------------------------------------------------- страница
  // числа похожи как ошибка распознавания одной цифры: 151/51, 130/140, 2310/231
  function ocrLike(x, y) {
    const a = String(x), b = String(y);
    if (a.length === b.length) { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d === 1; }
    if (Math.abs(a.length - b.length) === 1) {
      const [lo, hi] = a.length < b.length ? [a, b] : [b, a];
      for (let k = 0; k < hi.length; k++) if (hi.slice(0, k) + hi.slice(k + 1) === lo) return true;
    }
    return false;
  }
  const isNum = (v) => /^\d+$/.test(String(v));

  // Ячейка «2 11»: номер 211 разбит распознаванием на два числа — склеить, если склеенное продолжает соседей
  // того же пола (до трёх с каждой стороны), а первое число — нет. См. _join_cells в Python-навыке.
  function joinCells(people) {
    const byCell = new Map();
    for (const p of people) {
      if (p.flags.includes('split_cell') && p.num_id && !p._drop) { if (!byCell.has(p.num_id)) byCell.set(p.num_id, []); byCell.get(p.num_id).push(p); }
    }
    for (const cell of byCell.values()) {
      if (cell.length !== 2 || cell[0].sex !== cell[1].sex) continue;
      cell.sort((p, q) => p.cy - q.cy);
      const sex = cell[0].sex;
      const others = people.filter((p) => p.sex === sex && !p._drop && isNum(p.no) && !cell.includes(p)).sort((p, q) => p.cy - q.cy);
      const prev = others.filter((p) => p.cy < cell[0].cy).map((p) => +p.no).slice(-3);
      const nxt = others.filter((p) => p.cy > cell[1].cy).map((p) => +p.no).slice(0, 3);
      const joined = parseInt(String(cell[0].no) + String(cell[1].no), 10);
      const fits = (val) => prev.some((q) => q + 1 <= val && val <= q + 4) || nxt.some((q) => q - 4 <= val && val <= q - 1);
      if (fits(joined) && !fits(+cell[0].no)) {
        const [keep, gone] = cell;
        const raw = `${keep.no} ${gone.no}`;
        keep.no = String(joined);
        keep.cy = (keep.cy + gone.cy) / 2;
        keep.flags = keep.flags.filter((f) => f !== 'split_cell').concat([`joined_cell:${raw}`]);
        if ((keep.age === '' || keep.age == null) && !(gone.age === '' || gone.age == null)) { keep.age = gone.age; keep.age_id = gone.age_id; }
        gone._drop = true;
      }
    }
  }

  // Соседи согласованы (a и a+2) — средний a+1; ошибка одной цифры — по предыдущему; первый — по двум следующим.
  function fixSequence(people, sex) {
    const seq = people.filter((p) => p.sex === sex && !p._drop && isNum(p.no)).sort((p, q) => p.cy - q.cy);
    const n = seq.length;
    if (n < 3) return;
    const v = seq.map((p) => +p.no);
    for (let i = 0; i < n; i++) {
      const a = i > 0 ? v[i - 1] : null, b = i + 1 < n ? v[i + 1] : null, x = v[i];
      let fix = null;
      if (a !== null && b !== null && b - a === 2 && x !== a + 1) fix = a + 1;
      else if (a !== null && Math.abs(x - (a + 1)) > 3 && ocrLike(x, a + 1) && (b === null || b === a + 2 || ocrLike(b, a + 2))) fix = a + 1;
      else if (a === null && b !== null && i + 2 < n && v[i + 2] === b + 1 && Math.abs(x - (b - 1)) > 3 && ocrLike(x, b - 1)) fix = b - 1;
      if (fix !== null) { seq[i].flags.push(`no_fixed:${x}`); seq[i].no = String(fix); v[i] = fix; }
    }
  }

  // Номера мужчин и женщин сквозные: на листе сверху вниз идут подряд (см. repair_numbers в Python-навыке).
  function repairNumbers(people) {
    for (let round = 0; round < 2; round++) {
      joinCells(people);
      for (const sex of ['M', 'F']) fixSequence(people, sex);
    }
    const extra = [];
    for (const sex of ['M', 'F']) {
      let seq = people.filter((p) => p.sex === sex && !p._drop && isNum(p.no)).sort((p, q) => p.cy - q.cy);
      const v = seq.map((p) => +p.no);
      for (let i = 1; i + 1 < seq.length; i++) {
        const a = v[i - 1], x = v[i], b = v[i + 1];
        if (b - a === 1 && x !== a && x !== b) {
          const p = seq[i];
          if (p.age === '' || p.age == null) { extra.push([p.cy, p.no, p.num_id]); p._drop = true; }
          else { p.flags.push(`extra_number:${p.no}`); p.no = ''; }
        }
      }
      seq = seq.filter((p) => !p._drop && isNum(p.no));
      const loose = people.filter((p) => p.sex === sex && !p._drop && !isNum(p.no));
      for (let i = 0; i + 1 < seq.length; i++) {
        const p1 = seq[i], p2 = seq[i + 1];
        if (+p2.no - +p1.no === 2) {
          const mid = loose.filter((q) => p1.cy < q.cy && q.cy < p2.cy);
          if (mid.length === 1) {
            mid[0].no = String(+p1.no + 1);
            mid[0].flags = mid[0].flags.filter((f) => f !== 'age_without_number').concat(['no_restored']);
          }
        }
      }
    }
    return [people.filter((p) => !p._drop), extra];
  }

  function process(node, opts) {
    const a = Object.assign({}, DEFAULTS, opts || {});
    const size = node.originalImageSize || {};
    const W = size.width, H = size.height;
    const jb = node.joinedTextBlocks || [], tb = node.textBlocks || [];
    const rep = { page: node.sheetPageNumber ?? null, node_id: node.id ?? null, image: [W, H], flags: [], halves: [],
      persons: [], settlement_marks: [], skipped: { show_columns: 0, noise: 0 }, orphans: [], header: [] };
    if (!(W && H) || !jb.length || jb.length !== tb.length) {
      rep.flags.push(`count_mismatch:joined=${jb.length},text=${tb.length}`);
      return rep;
    }
    const blks = jb.map((j, i) => mkBlk(i, j, tb[i]));
    const nums = blks.filter((b) => b.kind === 'num' || b.kind === 'frac');
    if (nums.length < 4) { rep.flags.push('no_numbers'); return rep; }
    const medH = median(nums.map((b) => b.h)), medW = median(nums.map((b) => b.w));

    // 1. шапка
    const heads = blks.filter((b) => b.kind === 'text' && b.cy < 0.35 * H && !/\d/.test(b.text) && HEADER_WORDS.test(norm(b.text)));
    const hdrBottom = Math.max(0, ...heads.filter((b) => !SKIP_HEAD.test(norm(b.text))).map((b) => b.y1));
    rep.header = heads.slice().sort((p, q) => (p.cy - q.cy) || (p.cx - q.cx)).map((b) => b.text);

    // 2. Основной блок и заголовки НП
    const body = blks.filter((b) => b.cy > hdrBottom || (b.kind !== 'text' && b.cy > hdrBottom - medH)
      || (b.kind === 'text' && b.y1 > hdrBottom + 0.3 * medH && !HEADER_WORDS.test(norm(b.text))));
    const settle = [], cand = [];
    for (const b of body) {
      if (b.kind !== 'text') continue;
      const [name, how] = settlementHeader(b.text, letters(b.text));
      if (name) {
        settle.push([b, name, how]);
        // распознавание склеило заголовок с первой семьёй — блок и заголовок НП, и текст людей
        if (letters(b.text) < 45) continue;
      }
      if (b.w >= a.mainMinW * W && letters(b.text) >= 10 && !boilerplate(b.text)) cand.push(b);
    }
    for (const b of heads.concat(blks.filter((x) => x.cy <= hdrBottom && x.kind === 'text'))) {
      const [name, how] = settlementHeader(b.text, 0);
      // заголовок всей ведомости («Вѣдомость духовная… въ селѣ Троицкомъ») тоже задаёт НП: после него — духовенство села
      if (name && settle.every((s) => s[0] !== b)) settle.push([b, name, how]);
    }
    let groups = [];
    for (const b of cand.slice().sort((p, q) => p.cx - q.cx)) {
      let placed = false;
      for (const g of groups) {
        const gx0 = pct(g.map((x) => x.x0), 0.5), gx1 = pct(g.map((x) => x.x1), 0.5);
        const ov = Math.min(b.x1, gx1) - Math.max(b.x0, gx0);
        if (ov > 0.5 * Math.min(b.w, gx1 - gx0)) { g.push(b); placed = true; break; }
      }
      if (!placed) groups.push([b]);
    }
    const sumH = (g) => g.reduce((s, x) => s + x.h, 0);
    groups = groups.filter((g) => g.length >= 2 || sumH(g) > 0.12 * H);
    groups = groups.map((g, i) => [g, i]).sort((p, q) => (sumH(q[0]) - sumH(p[0])) || (p[1] - q[1])).map((t) => t[0]);
    groups = groups.slice(0, a.maxHalves).sort((p, q) => pct(p.map((x) => x.x0), 0.5) - pct(q.map((x) => x.x0), 0.5));
    if (!groups.length) { rep.flags.push('no_main_block'); return rep; }

    // 3. числа данных
    const dataNums = [];
    for (const b of body) {
      if (!['num', 'frac', 'multi'].includes(b.kind)) continue;
      if (b.kind !== 'multi' && (b.h > 2.2 * medH || b.w > 2.6 * medW)) { rep.skipped.noise++; continue; }
      dataNums.push(b);
    }
    const ymid = dataNums.length ? median(dataNums.map((b) => b.cy)) : H / 2;
    const halves = groups.map((g, gi) => ({ no: gi + 1, main: g, x0: pct(g.map((x) => x.x0), 0.25), x1: pct(g.map((x) => x.x1), 0.75) }));
    halves.forEach((hf, k) => {
      const prevX1 = k ? halves[k - 1].x1 : 0;
      const nxtX0 = k + 1 < halves.length ? halves[k + 1].x0 : W;
      hf.leftZone = [Math.max(prevX1 + 0.02 * W, hf.x0 - a.leftZone * W), hf.x0 + 0.03 * W];
      hf.rightZone = [hf.x1 - 0.04 * W, Math.min(hf.x1 + a.rightZone * W, k + 1 < halves.length ? nxtX0 - a.leftZone * W : W)];
    });

    const gap = a.colGap * medW;
    for (const hf of halves) {
      const [l0, l1] = hf.leftZone, [r0, r1] = hf.rightZone;
      const left = dataNums.filter((b) => l0 <= b.cx && b.cx <= l1 && (b.kind === 'num' || b.kind === 'multi'));
      const right = dataNums.filter((b) => r0 <= b.cx && b.cx <= r1 && (b.kind === 'num' || b.kind === 'frac'));
      const slope = deskewSlope(left.concat(right), 0.15 * medW, ymid);
      const lcols = clusterColumns(left, gap, ymid, slope);
      let rcols = clusterColumns(right, gap, ymid, slope);
      if (rcols.filter((c) => c.blocks.length >= 3).length < 2) {
        // столбцы возраста дальше обычного (форма 1826 г.): зона справа до левых столбцов следующего листа
        const k = halves.indexOf(hf);
        const lim = k + 1 < halves.length ? halves[k + 1].x0 - 1.2 * a.leftZone * W : W;
        const rz2 = [r0, Math.max(r1, Math.min(hf.x1 + 2.8 * a.rightZone * W, lim))];
        const right2 = dataNums.filter((b) => rz2[0] <= b.cx && b.cx <= rz2[1] && (b.kind === 'num' || b.kind === 'frac'));
        const rcols2 = clusterColumns(right2, gap, ymid, slope).filter((c) => c.blocks.length >= 3);
        if (rcols2.length >= 2) { rcols = rcols2; rep.flags.push(`half${hf.no}:age_zone_wide`); }
      }
      const roles = {};
      let pick = lcols.slice(-3);
      let names = ['yard', 'm_no', 'f_no'].slice(3 - pick.length);
      if (pick.length === 2) {
        if (pick[0].blocks.length < 0.45 * pick[1].blocks.length) {
          const sp = splitNumberColumn(pick[1], slope, ymid, medW);
          if (sp) { pick = [pick[0], sp[0], sp[1]]; names = ['yard', 'm_no', 'f_no']; rep.flags.push(`half${hf.no}:number_column_split`); }
          else { names = ['yard', 'm_no']; rep.flags.push(`half${hf.no}:left_columns_2_sex_unknown`); }
        }
        else { names = ['m_no', 'f_no']; rep.flags.push(`half${hf.no}:yard_column_not_found`); }
      }
      pick.forEach((c, i) => { roles[names[i]] = c; });
      for (const c of lcols.slice(0, Math.max(0, lcols.length - 3))) rep.skipped.noise += c.blocks.length;
      const rpick = rcols.slice(0, 2);
      rpick.forEach((c, i) => { roles[['age_m', 'age_f'][i]] = c; });
      for (const c of rcols.slice(2)) rep.skipped.show_columns += c.blocks.length;
      if (rpick.length === 1 && roles.m_no && roles.f_no) {
        const sp = splitAgeColumn(rpick[0], slope, ymid, medW);
        if (sp) { [roles.age_m, roles.age_f] = sp; rep.flags.push(`half${hf.no}:age_column_split`); }
        else { roles.age_any = roles.age_m; delete roles.age_m; rep.flags.push(`half${hf.no}:age_by_row`); }
      } else if (rpick.length < 2) rep.flags.push(`half${hf.no}:age_columns_${rpick.length}`);
      hf.columns = {};
      for (const [nm, c] of Object.entries(roles)) {
        hf.columns[nm] = { center_x: Math.round(c.center), center_x_rel: Math.round(c.center / W * 1e4) / 1e4, slope: Math.round(c.b * 1e4) / 1e4, cells: c.blocks.length };
      }
      const colBlocks = (r) => (roles[r] ? roles[r].blocks : []);

      // 4. люди
      let people = [];
      for (const [sex, role] of [['M', 'm_no'], ['F', 'f_no']]) {
        for (const b of colBlocks(role)) {
          b.vals.forEach((v, k) => {
            const hk = b.h / b.vals.length;
            people.push({ sex, no: v, age: '', cy: b.y0 + hk * (k + 0.5), num_id: b.id, flags: b.vals.length > 1 ? ['split_cell'] : [] });
          });
        }
      }
      for (const [sex, role] of [['M', 'age_m'], ['F', 'age_f'], [null, 'age_any']]) {
        const ages = stableByY(colBlocks(role), 0.15 * medH);
        const cands = people.filter((p) => sex === null || p.sex === sex).sort((p, q) => p.cy - q.cy);
        const pairs = [];
        ages.forEach((ag, i) => cands.forEach((p, j) => pairs.push([Math.abs(ag.cy - p.cy), i, j])));
        pairs.sort((p, q) => p[0] - q[0]);
        const ua = new Set(), up = new Set(), first = [];
        for (const [d, i, j] of pairs) {
          if (d > medH || ua.has(i) || up.has(j)) continue;
          ua.add(i); up.add(j); first.push([ages[i].cy, ages[i].cy - cands[j].cy]);
        }
        const [c0, c1] = shiftLine(first, medH);
        const sh = (y) => c0 + c1 * y;
        const match = align(ages.map((ag) => ag.cy - sh(ag.cy)), cands.map((p) => p.cy), a.ageTol * medH);
        const used = new Set();
        for (const [i, j] of match) {
          used.add(i);
          cands[j].age = ages[i].vals.length ? ages[i].vals[0] : ages[i].text;
          cands[j].age_id = ages[i].id;
        }
        ages.forEach((ag, i) => {
          if (!used.has(i)) people.push({ sex: sex || 'M', no: '', age: ag.vals.length ? ag.vals[0] : ag.text, cy: ag.cy - sh(ag.cy), age_id: ag.id,
            flags: ['age_without_number'].concat(sex ? [] : ['sex_unknown']) });
        });
      }
      people.sort((p, q) => p.cy - q.cy);
      // возраст на последней строке многострочной записи: возраст без номера — ближайшему выше человеку того же пола
      // с номером, но без возраста (до 2,5 строк, без чужих между)
      for (const q of people.filter((x) => x.flags.includes('age_without_number'))) {
        const up = people.filter((x) => x !== q && x.no !== '' && x.age === '' && x.cy < q.cy && q.cy - x.cy <= 2.5 * medH
          && (q.flags.includes('sex_unknown') || x.sex === q.sex));
        if (!up.length) continue;
        const best = up.reduce((a, b) => (b.cy > a.cy ? b : a));
        if (people.some((x) => x !== q && x !== best && best.cy < x.cy && x.cy < q.cy && x.sex === best.sex && x.no !== '')) continue;
        best.age = q.age; best.age_id = q.age_id;
        best.flags.push('age_next_line');
        people.splice(people.indexOf(q), 1);
      }
      // форма без номеров людей (1795 г.: только дворы) — «возраст без номера» здесь не ошибка
      {
        const numbered = people.filter((p) => String(p.no) !== '').length;
        if (people.length >= 5 && numbered < 0.2 * people.length) {
          people.forEach((p) => { p.flags = p.flags.filter((f) => f !== 'age_without_number'); });
          rep.flags.push(`half${hf.no}:no_person_numbers`);
        }
      }
      // 4а. номера по соседям: ошибки распознавания, лишние числа, пропуски
      let extra;
      [people, extra] = repairNumbers(people);
      // 5. двор
      const yards = [];
      for (const yb of colBlocks('yard')) for (const v of yb.vals) yards.push([yb.cy, v, yb.text, yb.id]);
      for (const [cy, v, id] of extra) yards.push([cy, v, v, id]);
      yards.sort((p, q) => p[0] - q[0]);
      for (const [ycy, v, ytext, yid] of yards) {
        let best = null;
        for (const p of people) if (!best || Math.abs(p.cy - ycy) < Math.abs(best.cy - ycy)) best = p;
        if (!best || Math.abs(best.cy - ycy) > 1.2 * medH) { rep.orphans.push({ text: ytext, id: yid, why: 'yard_without_person' }); continue; }
        if (best.yard_mark) best.flags.push('two_yard_numbers');
        best.yard_mark = v;
      }
      // 6. Основной блок
      const mains = hf.main.slice().sort((p, q) => p.y0 - q.y0);
      const dist = (p, m) => Math.min(Math.abs(p.cy - m.y0), Math.abs(p.cy - m.y1));
      for (const p of people) {
        const depth = (m) => Math.min(p.cy - m.y0, m.y1 - p.cy);
        const inside = mains.filter((m) => depth(m) > 0.15 * medH);
        const edge = mains.filter((m) => depth(m) > -0.3 * medH);
        let m = null;
        if (inside.length) {
          m = inside.reduce((x, y) => (y.h < x.h ? y : x));
          if (inside.length > 1) p.flags.push('nested_block');
        } else if (edge.length) {
          m = edge.reduce((x, y) => (depth(y) > depth(x) ? y : x));
          p.flags.push('block_edge');
        } else {
          const near = mains.slice().sort((x, y) => dist(p, x) - dist(p, y));
          if (near.length && dist(p, near[0]) <= 1.2 * medH) { m = near[0]; p.flags.push('y_near'); }
          else p.flags.push('no_main_block');
        }
        p.block_id = m ? m.id : null;
        p.names_text = m ? m.text : '';
      }
      // 6а. текст блока -> по людям
      const byBlock = new Map();
      for (const p of people) if (p.block_id) { if (!byBlock.has(p.block_id)) byBlock.set(p.block_id, []); byBlock.get(p.block_id).push(p); }
      for (const ps of byBlock.values()) {
        const parts = splitBlock(ps[0].names_text, ps.map((p) => p.sex));
        ps.forEach((p, i) => { p.person_text = parts[i][0]; if (parts[i][1]) p.flags.push('split:' + parts[i][1]); });
      }
      for (const p of people) if (p.person_text === undefined) p.person_text = '';
      const cnt = new Map();
      for (const p of people) {
        if (p.block_id) { cnt.set(p.block_id, (cnt.get(p.block_id) || 0) + 1); p.person_in_block = cnt.get(p.block_id); }
        else p.person_in_block = '';
      }
      // 7. номера подряд
      for (const sex of ['M', 'F']) {
        const seq = people.filter((p) => p.sex === sex && p.no).map((p) => parseInt(p.no, 10));
        let br = 0;
        for (let i = 1; i < seq.length; i++) if (!(seq[i] - seq[i - 1] > 0 && seq[i] - seq[i - 1] <= 3)) br++;
        if (seq.length && br) rep.flags.push(`half${hf.no}:seq_breaks_${sex}=${br}/${seq.length}`);
      }
      hf.people = people;
      hf.settlements = settle.filter(([b]) => b.x1 > hf.x0 - 0.05 * W && b.x0 < hf.x1 + 0.02 * W)
        .map(([b, name, how]) => [b.cy, name, how, b.text]).sort((p, q) => p[0] - q[0]);
      hf.blocks = mains.map((m) => ({ block_id: m.id, text_block_id: m.tid, bbox: [m.x0, m.y0, m.x1, m.y1], names_text: m.text, persons: cnt.get(m.id) || 0 }));
    }

    // 8. порядок людей страницы и отметки НП
    for (const hf of halves) {
      const marks = hf.settlements.slice();
      for (const p of hf.people) {
        p.settlement_here = null;
        while (marks.length && marks[0][0] <= p.cy) {
          const [, name, how, text] = marks.shift();
          rep.settlement_marks.push({ half: hf.no, name, how, text });
          p.settlement_here = name;
          p.settlement_how = how;
        }
        p.half = hf.no;
        rep.persons.push(p);
      }
      for (const [, name, how, text] of marks) rep.settlement_marks.push({ half: hf.no, name, how, text, after_last: true });
      rep.halves.push({ no: hf.no, main_x: [Math.round(hf.x0), Math.round(hf.x1)], main_x_rel: [Math.round(hf.x0 / W * 1e4) / 1e4, Math.round(hf.x1 / W * 1e4) / 1e4],
        columns: hf.columns, blocks: hf.blocks, people: hf.people.length });
    }
    for (const p of rep.persons) p.cy = Math.round(p.cy);
    rep.median_number_h = medH;
    if (rep.orphans.length) rep.flags.push(`orphans:${rep.orphans.length}`);
    return rep;
  }

  // заголовок НП не распознан (other:…) — следующий по порядку НП округи
  function resolveSettlement(name, cur, year) {
    if (!String(name).startsWith('other:')) return [name, ''];
    const order = year && year < 1750 ? ORDER_BEFORE_1750 : ORDER_FROM_1750;
    const i = order.indexOf(cur);
    if (i >= 0 && i + 1 < order.length) return [order[i + 1], `НП определён по порядку (заголовок «${name.slice(6)}» не распознан)`];
    return ['чужой НП: ' + name.slice(6), ''];
  }

  // Человек i начинает ведомость прихода: № 1–2 его пола, а следующие номера того же пола — малые и растут
  // (сквозная нумерация начинается заново с первого двора первого НП). См. numbering_restart в Python-навыке.
  function numberingRestart(persons, i) {
    const p = persons[i];
    if (!/^\d+$/.test(String(p.no || '')) || +p.no > 2) return false;
    const nxt = persons.slice(i + 1).filter((q) => q.sex === p.sex && /^\d+$/.test(String(q.no || ''))).map((q) => +q.no).slice(0, 2);
    return nxt.length === 2 && +p.no < nxt[0] && nxt[0] < nxt[1] && nxt[1] <= 12;
  }

  // Пустой «Двор №»: вычисляется по ближайшим дворам с номером того же документа (года).
  // rows: [{year, yard}] по порядку; -> [{yard, calc}] (calc=true — номер вычислен).
  //  перед первым номером N            -> N − 1 (продолжение двора с прошлой страницы);
  //  между P и N (N − P > 1)            -> P + 1 (пропущенный номер), иначе P (продолжение двора P);
  //  после последнего номера P          -> P + 1.
  function fillYards(rows) {
    const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
    const out = rows.map((r) => ({ yard: r.yard, calc: false }));
    let i = 0;
    while (i < rows.length) {
      if (num(rows[i].yard) !== null) { i++; continue; }
      const y = rows[i].year;
      let j = i;
      while (j < rows.length && num(rows[j].yard) === null && rows[j].year === y) j++;
      const P = i > 0 && rows[i - 1].year === y ? num(out[i - 1].yard) : null;
      const N = j < rows.length && rows[j].year === y ? num(rows[j].yard) : null;
      let v = null;
      if (P !== null && N !== null) v = N - P > 1 ? P + 1 : P;
      else if (N !== null) v = Math.max(1, N - 1);
      else if (P !== null) v = P + 1;
      if (v !== null) for (let k = i; k < j; k++) out[k] = { yard: v, calc: true };
      i = j;
    }
    return out;
  }

  const api = { process, splitBlock, fillYards, settlementOf, resolveSettlement, numberingRestart, norm, DEFAULTS, ORDER_BEFORE_1750, ORDER_FROM_1750 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ConfessionRows = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
