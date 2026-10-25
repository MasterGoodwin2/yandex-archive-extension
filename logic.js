// Логика разбора (перенос из yandex_archive_scraper.py).
// В JS \b и \w не понимают кириллицу, поэтому границы слов заданы через Unicode-классы.
(function (root) {
  const ARCHIVE_HOSTS = ['ya.ru', 'yandex.ru'];
  const DEFAULT_SPAN = 15;     // если в ссылке нет sheet_page_to: from .. from+DEFAULT_SPAN
  const HEADER_MAX_LEN = 70;   // строка короче этого может быть заголовком населённого пункта

  const L = '\\p{L}\\p{N}_';
  const WB = `(?<![${L}])`;    // начало слова
  const WE = `(?![${L}])`;     // конец слова

  // Обязателен префикс "сел/дер" (в т.ч. "дер." / "д." / "с.")
  const PREFIX = `(?:${WB}(?:сел|дер)[${L}]*\\.?|${WB}[дс]\\.)\\s*[\\[\\(«"]?\\s*`;
  const mk = (tail) => new RegExp(PREFIX + tail, 'u');
  const SETTLEMENTS = {
    'село Троицкое':     mk('троицк'),
    'деревня Острогина': mk('острогин'),
    'деревня Черепкова': mk('черепков'),
    'деревня Рублева':   mk('рублев'),
    'деревня Луки':      mk('лук(?:и)?' + WE),
    'деревня Мякинина':  mk('м[яе]кинин'),
  };
  // "Деревня"/"Дер." с любой буквы; сокращения "д."/"с." только строчные,
  // чтобы не принять за заголовок инициалы ("Д. Иванов").
  const OTHER_HEADER = new RegExp(
    `(?:${WB}(?:[Сс][Ее][Лл]|[Дд][Ее][Рр])[${L}]*\\.?|${WB}[дс]\\.)\\s*[\\[\\(«"]?\\s*([А-ЯЁІѢ][а-яёіѣъь]{3,})`,
    'u'
  );
  // строка, состоящая только из слова-префикса ("Деревня" / "Село" / "д.")
  const PREFIX_ONLY = new RegExp(
    `^\\s*(?:(?:[Сс][Ее][Лл]|[Дд][Ее][Рр])[${L}]*|[дсДС])\\.?\\s*$`,
    'u'
  );

  // CSS-селекторы блока распознанного текста (по очереди; запасной — весь body)
  const TEXT_SELECTORS = [
    "[class*='ranscript']", "[class*='ecognized']", "[class*='ocr']",
    "[class*='structured']", "[class*='Structured']",
  ];

  function norm(s) {
    s = s.toLowerCase();
    for (const [a, b] of [['ё', 'е'], ['ѣ', 'е'], ['і', 'и'], ['ѵ', 'и'], ['ѳ', 'ф']]) {
      s = s.split(a).join(b);
    }
    return s.split('ъ').join('').split('ь').join('');
  }

  function toInt(s) {
    if (s === null || s === undefined || s === '') return null;
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? null : n;
  }

  // Текст элемента как в BeautifulSoup get_text("", strip=True):
  // куски текста обрезаются и склеиваются без пробелов (для "разорванных" ссылок <a>186</a>4)
  function strippedText(node) {
    let out = '';
    const walk = (n) => {
      for (const ch of n.childNodes || []) {
        if (ch.nodeType === 3) out += (ch.nodeValue || '').trim();
        else if (ch.nodeType === 1) walk(ch);
      }
    };
    walk(node);
    return out;
  }

  // doc — Document (DOMParser) со списком ссылок
  function parseLinks(doc) {
    const items = [];
    const seen = new Set();
    for (const a of doc.querySelectorAll('a[href]')) {
      const url = (a.getAttribute('href') || '').trim();
      let u;
      try { u = new URL(url); } catch (e) { continue; }
      if (!ARCHIVE_HOSTS.includes(u.hostname) || !u.pathname.startsWith('/archive')) continue;
      if (seen.has(url)) continue;
      seen.add(url);

      const holder = a.closest('p') || a;
      const m = strippedText(holder).match(/(?<!\d)(1[5-9]\d\d)(?!\d)/);
      const year = m ? parseInt(m[1], 10) : null;

      let note = '';
      let fileId = null, pFrom = null, pTo = null;

      if (u.pathname.startsWith('/archive/search')) {
        fileId = u.searchParams.get('fileId');
        pFrom = toInt(u.searchParams.get('sheet_page_from'));
        pTo = toInt(u.searchParams.get('sheet_page_to'));
      } else if (u.pathname.startsWith('/archive/catalog/')) {
        const parts = u.pathname.split('/').filter(Boolean); // archive / catalog / <id> / <page>
        if (parts.length >= 4) {
          fileId = parts[2];
          pFrom = pTo = toInt(parts[3]);
          note = 'ссылка на одну страницу каталога, диапазона в ссылке нет';
        }
      }

      if (pFrom !== null && pTo === null) {
        pTo = pFrom + DEFAULT_SPAN;
        note = `нет sheet_page_to — взято from+${DEFAULT_SPAN}`;
      }
      if (pFrom !== null && pTo !== null && pFrom > pTo) [pFrom, pTo] = [pTo, pFrom];

      items.push({ url, year, fileId, pFrom, pTo, note });
    }
    return items;
  }

  function findSettlements(text) {
    const t = norm(text);
    return new Set(Object.keys(SETTLEMENTS).filter((name) => SETTLEMENTS[name].test(t)));
  }

  // Если строка — заголовок населённого пункта: ['own', имя] / ['other', имя] / null
  function matchHeader(line, nxt = '') {
    const cand = [line];
    // заголовок мог разорваться на две строки: "Деревня" / "Острогина".
    // Склеиваем ТОЛЬКО если текущая строка — одно слово-префикс.
    if (nxt && PREFIX_ONLY.test(line)) cand.push(line + ' ' + nxt);
    for (const c of cand) {
      if (c.length > HEADER_MAX_LEN) continue;
      const n = norm(c);
      for (const [name, rx] of Object.entries(SETTLEMENTS)) {
        if (rx.test(n)) return ['own', name];
      }
      const m = c.match(OTHER_HEADER);
      if (m) return ['other', m[1]];
    }
    return null;
  }

  // state: {current, other, started} — переносится между страницами
  function extractPeople(sheetText, state, strictlyInside = true) {
    const lines = sheetText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const people = [];
    let skipNext = false;
    for (let i = 0; i < lines.length; i++) {
      if (skipNext) { skipNext = false; continue; } // вторая половина разорванного заголовка
      const ln = lines[i];
      const nxt = i + 1 < lines.length ? lines[i + 1] : '';
      const h = matchHeader(ln, nxt);
      if (h) {
        const [kind, name] = h;
        state.current = kind === 'own' ? name : null;
        state.other = kind === 'other' ? name : null;
        skipNext = PREFIX_ONLY.test(ln);
        continue;
      }
      if (ln.length < 6 || !/[А-ЯЁІѢ][а-яёіѣъь]+/.test(ln)) continue;
      let cur = state.current;
      if (cur === null || cur === undefined) {
        // заголовка своего НП ещё не было: берём только внутри диапазона
        // и только если не встретился чужой НП
        if (state.other || !strictlyInside || !state.started) continue;
        cur = 'не определён (начало диапазона)';
      }
      const ages = [...ln.matchAll(/(?<![\p{L}\p{N}_])(\d{1,3})(?![\p{L}\p{N}_])/gu)]
        .map((x) => parseInt(x[1], 10))
        .filter((x) => x > 0 && x < 111);
      people.push({ settlement: cur, lineNo: i + 1, ages: ages.join(', '), text: ln });
    }
    return people;
  }

  const api = {
    ARCHIVE_HOSTS, DEFAULT_SPAN, TEXT_SELECTORS, SETTLEMENTS,
    norm, parseLinks, findSettlements, matchHeader, extractPeople,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Logic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
