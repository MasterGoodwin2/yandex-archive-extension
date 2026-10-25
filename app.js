// Страница приложения: загружает страницы Яндекс Архива в рабочей вкладке Chrome
// (где вы уже вошли в Яндекс), разбирает текст и сохраняет результат в Excel.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const CFG = {
    PAGE_URL: (fileId, n) => `https://ya.ru/archive/catalog/${fileId}/${n}`,
    DELAY: [1000, 2500],     // пауза между страницами, мс
    PAGE_TIMEOUT: 45000,     // ожидание загрузки страницы, мс
    MAX_RETRIES: 2,
    RENDER_WAIT: 15000,      // сколько ждать появления распознанного текста, мс
    BIG_RANGE: 300,          // предупреждение о слишком большом диапазоне
  };
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  let items = [];            // разобранные ссылки
  let running = false;
  let stopRequested = false;
  let resumeResolver = null;
  let workTabId = null;
  let appTabId = null;
  let fileHandle = null;
  let debugSaved = false;

  let people = [];
  let sheetRows = [];
  let linkRows = [];

  // ---------------------------------------------------------------- UI
  function log(msg) {
    const t = new Date().toTimeString().slice(0, 8);
    const el = $('log');
    el.textContent += `[${t}] ${msg}\n`;
    el.scrollTop = el.scrollHeight;
  }
  function setStatus(s) { $('status').textContent = s; }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = ([a, b]) => a + Math.random() * (b - a);

  function setRunningUi(on) {
    $('startBtn').disabled = on;
    $('linksFile').disabled = on;
    $('saveBtn').disabled = !on;
    $('stopBtn').disabled = !on;
  }

  function waitForUser(text, showWorkTab) {
    $('bannerText').textContent = text;
    $('banner').style.display = 'block';
    if (showWorkTab && workTabId !== null) chrome.tabs.update(workTabId, { active: true }).catch(() => {});
    return new Promise((resolve) => {
      resumeResolver = () => {
        $('banner').style.display = 'none';
        resumeResolver = null;
        if (showWorkTab && appTabId !== null && !$('showTab').checked) {
          chrome.tabs.update(appTabId, { active: true }).catch(() => {});
        }
        resolve();
      };
    });
  }
  $('continueBtn').addEventListener('click', () => resumeResolver && resumeResolver());
  $('stopBtn').addEventListener('click', () => {
    stopRequested = true;
    log('Остановка запрошена — дорабатываю текущую страницу и сохраняю результат...');
    if (resumeResolver) resumeResolver();
  });
  $('saveBtn').addEventListener('click', async () => {
    await saveResult(true);
  });
  window.addEventListener('beforeunload', (e) => {
    if (running) { e.preventDefault(); e.returnValue = ''; }
  });

  // ------------------------------------------------------ список ссылок
  $('linksFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    items = [];
    if (!f) { $('linksInfo').textContent = 'Файл не выбран'; return; }
    try {
      const html = await f.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      items = Logic.parseLinks(doc);
    } catch (err) {
      $('linksInfo').textContent = 'Не удалось прочитать файл: ' + err.message;
      return;
    }
    const ok = items.filter((i) => i.fileId && i.pFrom !== null).length;
    $('linksInfo').textContent = items.length
      ? `Найдено ссылок Яндекс Архива: ${items.length} (с номером документа и диапазоном: ${ok})`
      : 'В файле не найдено ссылок Яндекс Архива.';
  });

  // ------------------------------------------------------ рабочая вкладка
  async function getWorkTab() {
    if (workTabId !== null) {
      try { await chrome.tabs.get(workTabId); return workTabId; } catch (e) { workTabId = null; }
    }
    const t = await chrome.tabs.create({ url: 'about:blank', active: $('showTab').checked });
    workTabId = t.id;
    return workTabId;
  }

  function navigate(tabId, url, timeoutMs) {
    return new Promise((resolve, reject) => {
      let finished = false;
      let sawLoading = false;
      const done = (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpd);
        err ? reject(err) : resolve();
      };
      const timer = setTimeout(() => done(new Error('таймаут загрузки страницы')), timeoutMs);
      const onUpd = (id, info) => {
        if (id !== tabId) return;
        if (info.status === 'loading') sawLoading = true;
        if (info.status === 'complete' && sawLoading) done();
      };
      chrome.tabs.onUpdated.addListener(onUpd);
      chrome.tabs.update(tabId, { url }).catch((e) => done(e));
    });
  }

  // Выполняется ВНУТРИ страницы архива. Должна быть самодостаточной (без внешних переменных).
  async function pageExtractor(selectors, maxWait, wantHtml) {
    const get = () => {
      for (const sel of selectors) {
        let els;
        try { els = [...document.querySelectorAll(sel)]; } catch (e) { continue; }
        // убираем вложенные дубли: если элемент лежит внутри другого найденного — пропускаем
        els = els.filter((e) => !els.some((o) => o !== e && o.contains(e)));
        const txt = els.map((e) => e.innerText || '').filter((s) => s.trim()).join('\n');
        if (txt.length > 200) return txt;
      }
      return document.body ? document.body.innerText : '';
    };
    const t0 = Date.now();
    let last = -1, stable = 0, text = '';
    while (Date.now() - t0 < maxWait) {
      text = get();
      if (text.length > 200 && text.length === last) {
        stable += 1;
        if (stable >= 2) break;
      } else {
        stable = 0;
      }
      last = text.length;
      await new Promise((r) => setTimeout(r, 600));
    }
    return { text, html: wantHtml ? document.documentElement.outerHTML : null };
  }

  const NEEDS_USER = /captcha|passport\.yandex|\/auth/i;

  async function fetchSheet(fileId, n) {
    const url = CFG.PAGE_URL(fileId, n);
    let lastErr = '';
    for (let attempt = 0; attempt <= CFG.MAX_RETRIES; attempt++) {
      if (stopRequested) return { url, text: '', err: 'остановлено пользователем' };
      try {
        const tabId = await getWorkTab();
        await navigate(tabId, url, CFG.PAGE_TIMEOUT);
        let tab = await chrome.tabs.get(tabId);
        let guard = 0;
        while (NEEDS_USER.test(tab.url || '') && guard++ < 3 && !stopRequested) {
          const captcha = /captcha/i.test(tab.url);
          await waitForUser(
            captcha
              ? 'Яндекс просит капчу. Решите её в рабочей вкладке и нажмите «Продолжить».'
              : 'Сессия Яндекса сбросилась. Войдите заново в рабочей вкладке и нажмите «Продолжить».',
            true
          );
          await navigate(tabId, url, CFG.PAGE_TIMEOUT);
          tab = await chrome.tabs.get(tabId);
        }
        if ((tab.url || '').startsWith('chrome-error')) throw new Error('страница не загрузилась (ошибка сети)');

        const wantHtml = $('debugHtml').checked && !debugSaved;
        const [inj] = await chrome.scripting.executeScript({
          target: { tabId },
          func: pageExtractor,
          args: [Logic.TEXT_SELECTORS, CFG.RENDER_WAIT, wantHtml],
        });
        const res = (inj && inj.result) || { text: '', html: null };
        if (wantHtml && res.html) {
          downloadBlob(new Blob([res.html], { type: 'text/html;charset=utf-8' }), 'first_page.html');
          debugSaved = true;
          log('Сохранён отладочный файл first_page.html (папка «Загрузки»).');
        }
        return { url, text: res.text || '', err: '' };
      } catch (e) {
        lastErr = e && e.message ? e.message : String(e);
        log(`  страница ${n}: ошибка «${lastErr}», попытка ${attempt + 1}/${CFG.MAX_RETRIES + 1}`);
        await sleep(2000);
      }
    }
    return { url, text: '', err: lastErr || 'ошибка' };
  }

  async function ensureLogin() {
    const tabId = await getWorkTab();
    log('Проверяю вход в Яндекс...');
    try {
      await navigate(tabId, 'https://ya.ru/archive', 60000);
    } catch (e) {
      log('Страница ya.ru/archive открылась с ошибкой: ' + e.message);
    }
    const tab = await chrome.tabs.get(tabId);
    const onArchive = /^https:\/\/(ya\.ru|yandex\.ru)\/archive/.test(tab.url || '');
    if (!onArchive || NEEDS_USER.test(tab.url || '')) {
      await waitForUser(
        'Войдите в Яндекс в рабочей вкладке (она сейчас открыта; убедитесь, что там открыт ya.ru/archive), ' +
        'затем вернитесь на эту вкладку и нажмите «Продолжить».',
        true
      );
      if (stopRequested) return;
    }
    // прогреваем сессию на втором домене (yandex.ru) — на случай ссылок с ним
    try {
      await navigate(tabId, 'https://yandex.ru/archive', 30000);
      await navigate(tabId, 'https://ya.ru/archive', 30000);
    } catch (e) { /* не критично */ }
    log('Вход проверен.');
  }

  // ------------------------------------------------------------- Excel
  const trunc = (v) => (typeof v === 'string' ? v.slice(0, 32000) : v === null || v === undefined ? '' : v);

  function widthsFor(rows) {
    const cols = Math.max(...rows.map((r) => r.length));
    const out = [];
    for (let c = 0; c < cols; c++) {
      let w = 8;
      rows.slice(0, 200).forEach((r) => {
        const v = r[c];
        if (v !== '' && v !== null && v !== undefined) w = Math.max(w, String(v).length);
      });
      out.push(Math.min(Math.max(w + 2, 10), 70));
    }
    return out;
  }

  function buildSheets() {
    const peopleRows = [['Год', 'Населённый пункт', 'Страница', 'Строка на странице',
      'Числа-возрасты (черновик)', 'Распознанная строка', 'Ссылка на страницу']];
    people.forEach((r) => peopleRows.push(
      [r.year, r.settlement, r.page, r.lineNo, r.ages, r.text, r.url].map(trunc)));

    const pageRows = [['Год', 'Страница', 'Найденные НП округи', 'Ссылка', 'Распознанный текст страницы']];
    sheetRows.forEach((r) => pageRows.push([r.year, r.page, r.found, r.url, r.text].map(trunc)));

    const linkOut = [['Год', 'Исходная ссылка', 'Диапазон из ссылки', 'Просмотрено страниц',
      'Найдено НП (шт.)', 'Какие НП', 'Решение', 'Людей собрано', 'Примечание']];
    linkRows.forEach((r) => linkOut.push(r.map(trunc)));

    return [
      { name: 'Люди', rows: peopleRows, widths: widthsFor(peopleRows) },
      { name: 'Страницы', rows: pageRows, widths: widthsFor(pageRows) },
      { name: 'Ссылки', rows: linkOut, widths: widthsFor(linkOut) },
    ];
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // download=true — если файл не выбран заранее, скачать копию в «Загрузки»
  async function saveResult(download) {
    const bytes = await XlsxWriter.build(buildSheets());
    if (fileHandle) {
      try {
        const w = await fileHandle.createWritable();
        await w.write(bytes);
        await w.close();
        log(`Сохранено: людей ${people.length}, страниц ${sheetRows.length}.`);
        return true;
      } catch (e) {
        log('Не удалось записать в выбранный файл (' + e.message + '). Скачиваю копию в «Загрузки».');
        download = true;
      }
    }
    if (download) {
      downloadBlob(new Blob([bytes], { type: XLSX_MIME }), 'result.xlsx');
      log('Файл result.xlsx скачан в папку «Загрузки».');
    }
    return true;
  }

  // ------------------------------------------------------------ основной цикл
  async function run() {
    running = true;
    stopRequested = false;
    debugSaved = false;
    people = [];
    sheetRows = [];
    linkRows = [];
    const pageCache = new Map();     // `${fileId}:${page}` -> {url,text,err}
    const seenPeople = new Set();
    setRunningUi(true);

    try {
      const cur = await chrome.tabs.getCurrent();
      appTabId = cur ? cur.id : null;
      await ensureLogin();

      for (let idx = 0; idx < items.length && !stopRequested; idx++) {
        const it = items[idx];
        const tag = `[${idx + 1}/${items.length}] ${it.year ?? '—'}`;
        const rng = it.pFrom !== null ? `${it.pFrom}–${it.pTo}` : '—';

        if (!it.fileId || it.pFrom === null) {
          linkRows.push([it.year, it.url, rng, 0, 0, '', 'пропущена: нет fileId или диапазона', 0, it.note]);
          log(`${tag}: пропущена (нет fileId/диапазона)`);
          continue;
        }

        const lo = it.pFrom;
        const hi = it.pTo;
        if (hi - lo + 1 > CFG.BIG_RANGE) log(`${tag}: внимание, диапазон очень большой (${hi - lo + 1} страниц)`);

        // 1. загрузка страниц диапазона из ссылки
        const texts = new Map();
        for (let n = lo; n <= hi && !stopRequested; n++) {
          const key = `${it.fileId}:${n}`;
          if (!pageCache.has(key)) {
            setStatus(`${tag}: страница ${n} (диапазон ${lo}–${hi})`);
            log(`${tag}: загружаю страницу ${n} (диапазон ${lo}–${hi})...`);
            pageCache.set(key, await fetchSheet(it.fileId, n));
            if (n < hi) await sleep(rand(CFG.DELAY));
          }
          texts.set(n, pageCache.get(key));
        }

        // 2. сбор людей
        const foundAll = new Set();
        const perPage = new Map();
        for (const [n, r] of texts) {
          const f = Logic.findSettlements(r.text);
          perPage.set(n, f);
          f.forEach((x) => foundAll.add(x));
        }

        const state = { current: null, other: null, started: true };
        let collected = 0;
        for (const n of [...texts.keys()].sort((a, b) => a - b)) {
          const r = texts.get(n);
          sheetRows.push({
            year: it.year, page: n,
            found: [...perPage.get(n)].sort().join('; '),
            url: r.url, text: r.err ? `ОШИБКА: ${r.err}` : r.text,
          });
          for (const p of Logic.extractPeople(r.text, state, true)) {
            const key = `${it.fileId}|${n}|${p.lineNo}|${p.text}`;
            if (seenPeople.has(key)) continue;
            seenPeople.add(key);
            people.push({ ...p, year: it.year, page: n, url: r.url });
            collected++;
          }
        }

        const total = hi - lo + 1;
        const verdict = texts.size < total
          ? `ПРЕРВАНА (страниц ${texts.size} из ${total})`
          : 'ОБРАБОТАНА';
        linkRows.push([it.year, it.url, rng, texts.size, foundAll.size,
          [...foundAll].sort().join('; '), verdict, collected, it.note]);
        log(`${tag}: диапазон ${rng} — НП ${foundAll.size}, людей: ${collected}`);
        await saveResult(false);
      }
    } catch (e) {
      log('ОШИБКА: ' + (e && e.stack ? e.stack : e));
    } finally {
      try { await saveResult(true); } catch (e) { log('Не удалось сохранить: ' + e.message); }
      if (workTabId !== null) { chrome.tabs.remove(workTabId).catch(() => {}); workTabId = null; }
      running = false;
      setRunningUi(false);
      setStatus(`Готово. Людей: ${people.length}.`);
      log(`Готово. Людей: ${people.length}.`);
    }
  }

  $('startBtn').addEventListener('click', async () => {
    if (running) return;
    if (!items.length) { setStatus('Сначала выберите HTML-файл со ссылками.'); return; }
    // окно выбора файла должно открываться прямо по клику
    fileHandle = null;
    if (window.showSaveFilePicker) {
      try {
        fileHandle = await window.showSaveFilePicker({
          suggestedName: 'result.xlsx',
          types: [{ description: 'Excel', accept: { [XLSX_MIME]: ['.xlsx'] } }],
        });
      } catch (e) {
        if (e && e.name === 'AbortError') { setStatus('Место сохранения не выбрано.'); return; }
        log('Окно выбора файла недоступно (' + (e && e.message) + '). Результат будет скачан в «Загрузки».');
      }
    }
    await run();
  });
})();
