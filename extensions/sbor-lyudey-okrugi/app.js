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
    MAX_MISSES: 3,           // подряд страниц без окна текста — остановка
  };
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const NEEDS_USER = /captcha|passport\.yandex|\/auth/i;

  let linksDoc = null;       // разобранный HTML со ссылками
  let items = [];            // ссылки
  let linksText = '';        // содержимое выбранного файла ссылок
  let running = false;
  let stopRequested = false;
  let resumeResolver = null;
  let workTabId = null;
  let appTabId = null;
  let fileHandle = null;
  let debugSaved = false;
  let debugStamp = '';        // папка текущего запуска: yaarchive_debug/<время>
  let linksDir = null;        // папка, где лежит файл ссылок (FileSystemDirectoryHandle); туда пишется yaarchive_debug/
  let runDir = null;          // yaarchive_debug/<время>/ внутри linksDir
  let writeChain = Promise.resolve();   // записи в папку идут по очереди
  let debugIndex = [];        // сводка по страницам для run_summary.json
  let busyPicking = false;

  // outFormat — вид результата в Excel ('confession' | 'revision'), не зависит от типа обработки;
  // saveScans — сохранять оригиналы сканов в «Archive_Scans»
  let settings = { mode: Logic.DEFAULT_MODE, textSel: '', dateSel: '', outFormat: '', saveScans: false };
  let srcFile = null;        // выбранный файл со ссылок (FileSystemFileHandle) — «Выбрать файл со ссылками»
  let outPicked = null;      // выбранная папка результата («Выбрать куда сохранить результат»)
  let scanPicked = null;     // выбранная папка сканов («Archive_Scans»); без выбора — /Volumes/DATA/Archive_Scans
  let scanRel = undefined;   // путь от result.xlsx к папке сканов (для «Локальная Ссылка на страницу»); null — не вычислить

  let families = [];         // семьи-дворы: {settlement, yard, persons[], notes[], url, year}
  let sheetRows = [];
  let linkRows = [];
  let blockRecords = [];     // блоки текста (исповедные ведомости) — для проверки деления на людей
  let rowRecords = [];       // строки таблицы внутри блоков «Крестьяне/Крестьянки» (режим «Ревизские сказки»)
  let pageMeta = {};         // адрес страницы -> {cga, cgaUrl, scanName, scanFile, scanLocal, scanHref} для столбцов ссылок
  const SCAN_DIR = 'Archive_Scans';
  const SCAN_QUALITY = 0.4;  // JPG 40%, как в Scrpt_YA_Orig_Scan (для сканов в типах «Исповедные ведомости» / «Ревизские сказки»)
  const DEFAULT_SCANS_PATH = '/Volumes/DATA/Archive_Scans';
  const curQuality = SCAN_QUALITY;
  let scanDir = null;        // FileSystemDirectoryHandle «Archive_Scans» (в папке результатов или в папке со ссылками)
  let outDir = null;         // папка, выбранная кнопкой «Выбрать куда сохранять Excel, и начать»: result.xlsx + Archive_Scans/
  let scanStats = { saved: 0, existed: 0, failed: 0, bytes: 0 };

  // ---------------------------------------------------------------- UI
  function log(msg) {
    const t = new Date().toTimeString().slice(0, 8);
    const el = $('log');
    el.textContent += `[${t}] ${msg}\n`;
    el.scrollTop = el.scrollHeight;
  }
  function setStatus(s) { $('status').textContent = s; }

  // шкала времени до окончания: всего страниц по всем ссылкам (без повторов), сделано, среднее время страницы
  const progress = { total: 0, done: 0, t0: 0, times: [] };
  const fmtDur = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ' ч ' : '') + (h || m ? m + ' мин ' : '') + (h ? '' : sec + ' с');
  };
  function progressStart(total) {
    Object.assign(progress, { total, done: 0, t0: Date.now(), times: [] });
    $('progressBox').style.display = 'block';
    $('progressBar').max = Math.max(total, 1);
    progressShow();
  }
  function progressStep(ms) {
    progress.done++;
    if (ms !== undefined) { progress.times.push(ms); if (progress.times.length > 30) progress.times.shift(); }
    progressShow();
  }
  function progressShow(final) {
    const { total, done, t0, times } = progress;
    $('progressBar').value = Math.min(done, total);
    const spent = Date.now() - t0;
    const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
    const left = Math.max(0, total - done) * avg;
    const pct = total ? Math.round(done / total * 100) : 0;
    let t = `Страниц ${done} из ${total} (${pct}%) · прошло ${fmtDur(spent)}`;
    if (final) t += ' · готово';
    else if (avg) {
      const end = new Date(Date.now() + left);
      t += ` · осталось ≈ ${fmtDur(left)} · окончание ≈ ${end.toTimeString().slice(0, 5)}`;
    } else t += ' · оценка времени — после первых страниц';
    $('progressText').textContent = t;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = ([a, b]) => a + Math.random() * (b - a);
  const mode = () => Logic.getMode(settings.mode);

  function setRunningUi(on) {
    $('startBtn').disabled = on;
    ['pickFileBtn', 'pickOutBtn', 'pickScanBtn', 'useDefaults', 'scanPath'].forEach((id) => { $(id).disabled = on; });
    document.querySelectorAll('input[name="mode"]').forEach((r) => { r.disabled = on; });
    $('outFormat').disabled = on;
    $('saveScans').disabled = on;
    $('pickTextBtn').disabled = on;
    $('pickDateBtn').disabled = on;
    $('resetSelBtn').disabled = on;
    $('saveBtn').disabled = !on;
    $('stopBtn').disabled = !on;
  }

  function showSelectors() {
    $('textSelInfo').textContent = settings.textSel || 'автоопределение (справа от окна со сканом)';
    $('dateSelInfo').textContent = settings.dateSel || 'автоопределение (выше панели инструментов окна со сканом)';
  }

  // ---------------------------------------------------------------- настройки
  async function loadSettings() {
    try {
      const got = await chrome.storage.local.get(['mode', 'textSel', 'dateSel', 'outFormat']);
      if (got.mode && Logic.MODES[got.mode]) settings.mode = got.mode;
      settings.textSel = got.textSel || '';
      settings.dateSel = got.dateSel || '';
      settings.outFormat = Logic.MODES[got.outFormat] ? got.outFormat : '';
      settings.saveScans = false;      // флажки при запуске расширения сбрасываются
    } catch (e) { /* без сохранения — не критично */ }
  }
  async function saveSettings() {
    try { await chrome.storage.local.set(settings); } catch (e) { /* ignore */ }
  }

  const kindNow = () => settings.mode;
  // форма диалога следует за типом обработки: элементы с data-only показываются только для своих типов
  function applyModeUi() {
    $('descConfession').textContent = Logic.MODES.confession.description;
    $('descRevision').textContent = Logic.MODES.revision.description;
    const cur = kindNow();
    document.querySelectorAll('input[name="mode"]').forEach((r) => { r.checked = r.value === cur; });
    document.querySelectorAll('[data-only]').forEach((el) => { el.hidden = !el.dataset.only.split(' ').includes(cur); });
    $('startBtn').textContent = 'Начать';
    applyOutUi();
  }
  // вид результата: по умолчанию как тип обработки, переключатель задаёт его явно
  const outFormat = () => settings.outFormat || settings.mode;
  function applyOutUi() {
    $('outFormat').checked = outFormat() === 'revision';
    $('saveScans').checked = settings.saveScans;
    $('scanWrap').hidden = !settings.saveScans;
    $('outFormatInfo').textContent = outFormat() === settings.mode
      ? `Excel будет в виде «${Logic.MODES[outFormat()].label}» — как тип обработки.`
      : `Excel будет в виде «${Logic.MODES[outFormat()].label}», хотя данные обрабатываются как «${Logic.MODES[settings.mode].label}».`;
  }
  $('outFormat').addEventListener('change', async () => {
    settings.outFormat = $('outFormat').checked ? 'revision' : 'confession';
    await saveSettings();
    applyOutUi();
    log(`Вид результата в Excel: ${Logic.MODES[outFormat()].label}.`);
  });
  $('saveScans').addEventListener('change', async () => {
    settings.saveScans = $('saveScans').checked;
    $('scanWrap').hidden = !settings.saveScans;
    await saveSettings();
    log(settings.saveScans ? `Сканы будут сохраняться в папку «${SCAN_DIR}».` : 'Сканы сохраняться не будут.');
  });
  // ---- выбор файла и папок: всегда конкретное место; с флажком «Использовать умолчания» берётся запомненное
  const note = (id, text) => { $(id).textContent = text; };
  function showNotes() {
    note('srcNote', srcFile ? `Файл со ссылками: «${srcFile.name}»` : 'Файл не выбран');
    note('outNote', outPicked ? `Результат сохраняется в папку: «${outPicked.name}»` : 'Папка результата не выбрана');
    note('scanNote', scanPicked
      ? `Сканы сохраняются в: «${scanPicked.name === SCAN_DIR ? scanPicked.name : scanPicked.name + '/' + SCAN_DIR}»`
      : `Папка сканов не выбрана — по умолчанию ${DEFAULT_SCANS_PATH}`);
  }
  async function pickDir(id, key) {
    if (!window.showDirectoryPicker) { setStatus('Этот Chrome не умеет выбирать папку.'); return null; }
    try {
      const h = await window.showDirectoryPicker({ id, mode: 'readwrite' });
      await idb((st) => st.put(h, key)).catch(() => {});
      return h;
    } catch (e) {
      if (!(e && e.name === 'AbortError')) setStatus('Папку выбрать не удалось: ' + (e && e.message) +
        ' (Chrome не даёт доступ к корню диска и системным папкам — выберите вложенную папку).');
      return null;
    }
  }
  $('pickOutBtn').addEventListener('click', async () => {
    const h = await pickDir('yaarchive-out', 'outPicked');
    if (h) { outPicked = h; log(`Результат будет сохраняться в «${h.name}».`); }
    showNotes();
  });
  $('pickScanBtn').addEventListener('click', async () => {
    const h = await pickDir('yaarchive-scans', 'scanPicked');
    if (h) { scanPicked = h; log(`Сканы будут сохраняться в «${h.name === SCAN_DIR ? h.name : h.name + '/' + SCAN_DIR}».`); }
    showNotes();
  });
  // «Использовать умолчания»: запомненные файл и папки (подтверждение доступа — прямо по щелчку по флажку)
  $('useDefaults').addEventListener('change', async () => {
    if (!$('useDefaults').checked) { log('Умолчания отключены: файл и папки выбираются вручную.'); return; }
    let got = 0;
    try {
      const f = await idb((st) => st.get('srcFile'));
      if (f && (await filePermission(f, true))) { srcFile = f; await loadSource(f); got++; }
      const o = await idb((st) => st.get('outPicked'));
      if (o && (await dirPermission(o, true))) { outPicked = o; got++; }
      const sc = await idb((st) => st.get('scanPicked'));
      if (sc && (await dirPermission(sc, true))) { scanPicked = sc; got++; }
    } catch (e) { /* нет запомненного */ }
    showNotes();
    log(got ? 'Умолчания: подставлены запомненные файл и папки.' : 'Умолчаний пока нет: выберите файл и папки один раз — они запомнятся.');
  });

  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      settings.mode = r.value; settings.outFormat = '';   // вид результата снова следует за типом
      await saveSettings();
      applyModeUi();
      refreshSource();
      log(`Тип обработки: ${mode().label}.`);
    });
  });

  // ------------------------------------------------------------- ожидание пользователя
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
  $('saveBtn').addEventListener('click', async () => { await saveResult(true); });
  window.addEventListener('beforeunload', (e) => {
    if (running) { e.preventDefault(); e.returnValue = ''; }
  });

  // ------------------------------------------------------ список ссылок
  // Тип файла определяет обработку: .ged — только образы страниц; .html — список ссылок для выбранного типа
  function sourceInfo(text) { $('linksInfo').textContent = text; }
  function refreshSource() {
    items = []; linksDoc = null;
    if (!linksText) return;
    const name = srcFile ? srcFile.name : 'файл';
    linksDoc = new DOMParser().parseFromString(linksText, 'text/html');
    reparseLinks();
    $('linksInfo').textContent = `${name}: ` + $('linksInfo').textContent;
  }
  function reparseLinks() {
    items = linksDoc ? Logic.parseLinks(linksDoc, settings.mode) : [];
    if (!linksDoc) return;
    const ok = items.filter((i) => i.fileId && i.pFrom !== null).length;
    $('linksInfo').textContent = items.length
      ? `Найдено ссылок Яндекс Архива: ${items.length} (с номером документа и диапазоном: ${ok})`
      : 'В файле не найдено ссылок Яндекс Архива.';
  }

  // ---- папка с файлом ссылок: в неё же сохраняются результаты (yaarchive_debug/<время запуска>/)
  const IDB = { db: 'yaarchive', store: 'handles' };
  function idb(fn) {
    return new Promise((resolve, reject) => {
      const rq = indexedDB.open(IDB.db, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(IDB.store);
      rq.onerror = () => reject(rq.error);
      rq.onsuccess = () => {
        const tx = rq.result.transaction(IDB.store, 'readwrite');
        const r = fn(tx.objectStore(IDB.store));
        tx.oncomplete = () => resolve(r && r.result);
        tx.onerror = () => reject(tx.error);
      };
    });
  }
  const outLabel = () => (linksDir ? `«${linksDir.name}/yaarchive_debug/${debugStamp || '<время запуска>'}/»`
    : `«Загрузки/yaarchive_debug/${debugStamp || '<время запуска>'}/»`);

  async function dirPermission(handle, ask) {
    const o = { mode: 'readwrite' };
    if ((await handle.queryPermission(o)) === 'granted') return true;
    return ask ? (await handle.requestPermission(o)) === 'granted' : false;
  }

  async function filePermission(handle, ask) {
    const o = { mode: 'read' };
    if ((await handle.queryPermission(o)) === 'granted') return true;
    return ask ? (await handle.requestPermission(o)) === 'granted' : false;
  }
  async function loadSource(handle) {
    const name = handle.name;
    try {
      const f = await handle.getFile();
      linksText = LinksTools.decodeBytes(new Uint8Array(await f.arrayBuffer()));
      refreshSource();
    } catch (err) {
      linksText = ''; refreshSource();
      $('linksInfo').textContent = `Не удалось прочитать ${name}: ${err.message}`;
    }
    showNotes();
  }

  $('pickFileBtn').addEventListener('click', async () => {
    if (!window.showOpenFilePicker) { $('linksInfo').textContent = 'Этот Chrome не умеет выбирать файл.'; return; }
    try {
      const [h] = await window.showOpenFilePicker({ id: 'yaarchive-links', multiple: false,
        types: [{ description: 'Список ссылок (.html)', accept: { 'text/html': ['.html', '.htm'] } }] });
      srcFile = h;
      await idb((st) => st.put(h, 'srcFile')).catch(() => {});
      await loadSource(h);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      $('linksInfo').textContent = 'Файл выбрать не удалось: ' + (e && e.message);
    }
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
        clearInterval(poll);
        chrome.tabs.onUpdated.removeListener(onUpd);
        err ? reject(err) : resolve();
      };
      const timer = setTimeout(() => done(new Error('таймаут загрузки страницы')), timeoutMs);
      // подстраховка: событие «загрузка» может прийти раньше подписки — проверяем вкладку раз в секунду
      const want = String(url).replace(/#.*$/, '');
      const started = Date.now();
      let kicks = 0;
      const poll = setInterval(async () => {
        if (finished) { clearInterval(poll); return; }
        try {
          const t = await chrome.tabs.get(tabId);
          if (Date.now() - started > 1500 && t.status === 'complete' && String(t.url || '').replace(/#.*$/, '') === want) done();
          // фоновая вкладка иногда не начинает загрузку («unloaded») — повторяем переход (до двух раз)
          else if (!sawLoading && kicks < 2 && Date.now() - started > 8000 * (kicks + 1) && (t.status === 'unloaded' || t.url !== want)) {
            kicks++;
            chrome.tabs.update(tabId, { url }).catch(() => {});
          } else if (kicks >= 2 && Date.now() - started > 24000 && t.status === 'unloaded') {
            // вкладка так и не загрузилась — закрываем её, следующая попытка откроет новую
            if (tabId === workTabId) workTabId = null;
            chrome.tabs.remove(tabId).catch(() => {});
            done(new Error('рабочая вкладка не загружается — открываю новую'));
          }
        } catch (e) { /* вкладка закрыта — сработает таймаут */ }
      }, 1000);
      const onUpd = (id, info) => {
        if (id !== tabId) return;
        if (info.status === 'loading') sawLoading = true;
        if (info.status === 'complete' && sawLoading) done();
      };
      chrome.tabs.onUpdated.addListener(onUpd);
      chrome.tabs.update(tabId, { url }).catch((e) => done(e));
    });
  }

  async function fetchSheet(fileId, n) {
    const url = CFG.PAGE_URL(fileId, n);
    let lastErr = '';
    for (let attempt = 0; attempt <= CFG.MAX_RETRIES; attempt++) {
      if (stopRequested) return { url, text: '', date: '', found: false, err: 'остановлено пользователем' };
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
          func: PageScripts.pageExtractor,
          args: [{ textSel: settings.textSel, dateSel: settings.dateSel, maxWait: CFG.RENDER_WAIT, wantHtml,
                  useNext: true, nextOnly: false }],
        });
        const res = (inj && inj.result) || { found: false, text: '', date: '' };
        if (!res.found && !res.nextNode && attempt < CFG.MAX_RETRIES) {      // страница не успела отдать данные — пробуем ещё раз
          lastErr = 'окно распознанного текста не найдено';
          log(`  страница ${n}: данных нет, повтор ${attempt + 2}/${CFG.MAX_RETRIES + 1}`);
          await sleep(3000);
          continue;
        }
        if (wantHtml && res.html) {
          saveOut('first_page.html', new Blob([res.html], { type: 'text/html;charset=utf-8' }));
          if (res.debug) saveOut('first_page_debug.json', new Blob([JSON.stringify(res.debug)], { type: 'application/json' }));
          if (res.nextNode) saveOut('first_page_next_data.json', new Blob([JSON.stringify(res.nextNode)], { type: 'application/json' }));
          debugSaved = true;
          log(`Отладочные файлы первой страницы: ${outLabel()} first_page.html, first_page_debug.json / first_page_next_data.json.`);
        }
        if (n !== undefined && res.nextNode) {
          log(`  стр. ${n}: данные страницы (${res.nextHow}), блоков: ${res.nextNode.joinedTextBlocks.length}`);
        } else if (n !== undefined && res.found) {
          log(`  стр. ${n}: окно текста — ${res.textHow}, знаков: ${res.text.length}; ` +
              `блоков с координатами: в окне текста ${(res.textBlocks || []).length}, на скане ${(res.overlayBlocks || []).length}`);
        }
        return {
          url, text: res.text || '', date: res.date || '', found: !!res.found, nextNode: res.nextNode || null, tabId,
          origin: res.origin || 'https://ya.ru',
          candidates: [
            { name: 'окно текста', blocks: res.textBlocks || [] },
            { name: 'скан', blocks: res.overlayBlocks || [] },
          ],
          err: res.found ? '' : 'окно распознанного текста не найдено',
        };
      } catch (e) {
        lastErr = e && e.message ? e.message : String(e);
        log(`  страница ${n}: ошибка «${lastErr}», попытка ${attempt + 1}/${CFG.MAX_RETRIES + 1}`);
        await sleep(2000);
      }
    }
    return { url, text: '', date: '', found: false, err: lastErr || 'ошибка' };
  }

  // ------------------------------------------------------ сканы (Scrpt_YA_Orig_Scan)
  // Путь «Главная/Каталог/ЦГА Москвы/Фонд/Опись/Дело/Скан» и имя файла — по данным страницы (без лишних запросов).
  // Скан: в папку «Archive_Scans» рядом с файлом ссылок (уже сохранённые не скачиваются повторно);
  // если выбран только файл ссылок — в «Загрузки/Archive_Scans/». Ссылка из result.xlsx (yaarchive_debug/<время>/) —
  // относительная: ../../Archive_Scans/<файл>.
  function noteMeta(r, n) {
    if (!r || !r.nextNode) return;
    const ci = ExcelSheets.crumbInfo(r.nextNode.crumbs, n, r.nextNode.id, r.origin);
    pageMeta[r.url] = Object.assign(pageMeta[r.url] || {}, { cga: ci.cga, cgaUrl: ci.cgaUrl, scanName: ci.scanName, docType: ci.docType });
  }
  // Папка сканов: выбранная флажком «Выбрать куда сохранить» (сама «Archive_Scans» или «Archive_Scans» внутри неё),
  // иначе «Archive_Scans» в папке результатов (outDir), иначе — в папке со ссылками.
  async function getScanDir() {
    if (scanDir) return scanDir;
    if (scanPicked) {
      try {
        scanDir = scanPicked.name === SCAN_DIR ? scanPicked : await scanPicked.getDirectoryHandle(SCAN_DIR, { create: true });
      } catch (e) { log(`Не удалось открыть выбранную папку сканов «${scanPicked.name}» (${e.message}).`); }
    }
    const base = outDir || linksDir;
    if (!scanDir && base) {
      try { scanDir = await base.getDirectoryHandle(SCAN_DIR, { create: true }); } catch (e) {
        log(`Не удалось создать папку «${SCAN_DIR}» в ${base.name} (${e.message}) — сканы пойдут в «Загрузки/${SCAN_DIR}/».`);
      }
    }
    if (scanDir && scanRel === undefined) {
      // путь от файла result.xlsx до папки сканов: result.xlsx в outDir или в <папка ссылок>/yaarchive_debug/<запуск>/
      scanRel = null;
      try {
        if (outDir) { const p = await outDir.resolve(scanDir); if (p) scanRel = p.join('/'); }
        else if (linksDir) { const p = await linksDir.resolve(scanDir); if (p) scanRel = ['..', '..'].concat(p).join('/'); }
      } catch (e) { /* не вычислить */ }
    }
    return scanDir;
  }
  // Файл уже есть в Archive_Scans — не скачиваем его повторно и переходим к следующему.
  async function scanExists(name) {
    const d = await getScanDir();
    if (!d) return false;
    try { await d.getFileHandle(name); return true; } catch (e) { return false; }
  }
  // Ссылка из Excel на скан: result.xlsx в папке результатов -> «Archive_Scans/…»,
  // result.xlsx в yaarchive_debug/<время>/ -> «../../Archive_Scans/…».
  // Локальный путь к папке «Archive_Scans» — всегда абсолютный (по умолчанию /Volumes/DATA/Archive_Scans/); столбец
  // «Локальная Ссылка на страницу» = этот путь + имя файла графического образа, ссылка — file://…
  const scanAbs = () => ($('scanPath').value.trim() || DEFAULT_SCANS_PATH).replace(/\/+$/, '');
  const scanLocalFor = (name) => `${scanAbs()}/${name}`;
  function scanHrefFor(name) { return `file://${encodeURI(scanAbs())}/${encodeURIComponent(name)}`; }
  // -> время, потраченное на скан (мс), чтобы сократить паузу между страницами
  async function saveScan(r, n) {
    const t0 = Date.now();
    const m = pageMeta[r.url];
    if (!m || !r.nextNode || !r.nextNode.id) return 0;
    const setFile = () => Object.assign(m, { scanFile: `${SCAN_DIR}/${m.scanName}`, scanLocal: scanLocalFor(m.scanName), scanHref: scanHrefFor(m.scanName) });
    if (await scanExists(m.scanName)) {
      scanStats.existed++; setFile();
      log(`  стр. ${n}: скан ${m.scanName} уже есть — пропущен.`);
      return 0;
    }
    let res = null;
    try {
      const [inj] = await chrome.scripting.executeScript({ target: { tabId: r.tabId }, func: PageScripts.scanFetcher, args: [r.nextNode.id, curQuality] });
      res = inj && inj.result;
    } catch (e) { res = { ok: false, err: e.message }; }
    if (!res || !res.ok) {
      scanStats.failed++;
      m.scanErr = (res && res.err) || 'нет ответа';
      log(`  стр. ${n}: скан не сохранён — ${m.scanErr}`);
      return Date.now() - t0;
    }
    const bin = atob(res.b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const d = await getScanDir();
    try {
      if (d) {
        const w = await (await d.getFileHandle(m.scanName, { create: true })).createWritable();
        await w.write(blob); await w.close();
      } else {
        const url = URL.createObjectURL(blob);
        await new Promise((ok) => chrome.downloads.download({ url, filename: `${SCAN_DIR}/${m.scanName}`, conflictAction: 'overwrite', saveAs: false }, () => ok()));
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
      setFile();
      scanStats.saved++; scanStats.bytes += res.size;
      log(`  стр. ${n}: скан ${m.scanName} (${res.w}×${res.h}, ${Math.round(res.origSize / 1024)} КБ → ${Math.round(res.size / 1024)} КБ)`);
    } catch (e) {
      scanStats.failed++;
      m.scanErr = 'не записан: ' + e.message;
      log(`  стр. ${n}: скан не записан — ${e.message}`);
    }
    return Date.now() - t0;
  }

  async function ensureLogin() {
    let tabId = await getWorkTab();
    log('Проверяю вход в Яндекс...');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await navigate(tabId, 'https://ya.ru/archive', 60000);
        break;
      } catch (e) {
        log('Страница ya.ru/archive открылась с ошибкой: ' + e.message);
        tabId = await getWorkTab();          // если вкладка была закрыта как незагружающаяся — новая
      }
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

  // ------------------------------------------------------ ручная калибровка
  async function calibrate(kind) {
    if (running || busyPicking) return;
    const it = items.find((i) => i.fileId && i.pFrom !== null);
    if (!it) { setStatus('Сначала выберите HTML-файл со ссылками: расширение откроет первую из них.'); return; }
    busyPicking = true;
    const label = kind === 'text' ? 'окно расшифрованного текста (справа от скана)' : 'строку с датой документа (над панелью инструментов скана)';
    try {
      if (appTabId === null) { const cur = await chrome.tabs.getCurrent(); appTabId = cur ? cur.id : null; }
      const tabId = await getWorkTab();
      await chrome.tabs.update(tabId, { active: true });
      log(`Калибровка: открываю страницу ${it.pFrom} документа ${it.fileId}...`);
      try { await navigate(tabId, CFG.PAGE_URL(it.fileId, it.pFrom), CFG.PAGE_TIMEOUT); }
      catch (e) { log('Страница открылась с ошибкой: ' + e.message); }
      const tab = await chrome.tabs.get(tabId);
      if (NEEDS_USER.test(tab.url || '')) {
        log('Нужен вход или капча: выполните их в открытой вкладке и нажмите кнопку калибровки ещё раз.');
        return;
      }
      await sleep(3500);   // дать странице дорисоваться
      log(`В рабочей вкладке наведите мышь на ${label} и кликните. Esc — отмена.`);
      const [inj] = await chrome.scripting.executeScript({
        target: { tabId }, func: PageScripts.pickerRun, args: [label],
      });
      const res = inj && inj.result;
      if (!res) { log('Выбор отменён.'); return; }
      if (kind === 'text') settings.textSel = res.selector; else settings.dateSel = res.selector;
      await saveSettings();
      showSelectors();
      log(`Выбрано: ${res.selector} (совпадений: ${res.count}).`);
      log(`Начало содержимого: «${res.sample.replace(/\s+/g, ' ').slice(0, 160)}»`);
      if (res.count !== 1) log('Внимание: селектор подходит не к одному элементу — проверьте результат.');
    } catch (e) {
      log('Калибровка не удалась: ' + (e && e.message ? e.message : e));
    } finally {
      busyPicking = false;
      if (appTabId !== null) chrome.tabs.update(appTabId, { active: true }).catch(() => {});
    }
  }
  $('pickTextBtn').addEventListener('click', () => calibrate('text'));
  $('pickDateBtn').addEventListener('click', () => calibrate('date'));
  $('resetSelBtn').addEventListener('click', async () => {
    settings.textSel = '';
    settings.dateSel = '';
    await saveSettings();
    showSelectors();
    log('Сброшено на автоопределение.');
  });

  // ------------------------------------------------------------- Excel
  function buildSheets() {
    return ExcelSheets.build({ processMode: settings.mode, outFormat: outFormat(), families, rowRecords, blockRecords,
      sheetRows, linkRows, pageMeta }, { ConfessionRows, Layout, STYLE: XlsxWriter.STYLE });
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

  // Все результаты и отладочные файлы запуска — в одну папку yaarchive_debug/<время запуска>/:
  //  выбрана папка со ссылками -> прямо в неё (File System Access API);
  //  выбран только файл        -> «Загрузки/yaarchive_debug/<время>/» (chrome.downloads), иначе обычное скачивание.
  async function writeToRunDir(name, blob) {
    if (!runDir) {
      const dbg = await linksDir.getDirectoryHandle('yaarchive_debug', { create: true });
      runDir = await dbg.getDirectoryHandle(debugStamp, { create: true });
    }
    const w = await (await runDir.getFileHandle(name, { create: true })).createWritable();
    await w.write(blob);
    await w.close();
  }
  function downloadToFolder(name, blob) {
    const fname = `yaarchive_debug/${debugStamp}/${name}`;
    try {
      if (chrome.downloads && chrome.downloads.download) {
        const url = URL.createObjectURL(blob);
        chrome.downloads.download({ url, filename: fname, conflictAction: 'overwrite', saveAs: false }, () => {
          setTimeout(() => URL.revokeObjectURL(url), 30000);
        });
        return;
      }
    } catch (e) { /* запасной путь ниже */ }
    downloadBlob(blob, fname.replace(/\//g, '_'));
  }
  // папка запуска: <дата_время>_v<версия расширения> — видно, какой версией собраны отладочные файлы
  function runStamp() { return `${localStamp()}_v${chrome.runtime.getManifest().version}`; }
  function localStamp() {      // местное время: 2026-10-27_10-52-03
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`;
  }
  function saveOut(name, blob) {
    if (!debugStamp) debugStamp = runStamp();
    writeChain = writeChain.then(async () => {
      if (linksDir) {
        try { await writeToRunDir(name, blob); return; } catch (e) {
          log(`Не удалось записать ${name} в папку ${linksDir.name} (${e.message}) — сохраняю в «Загрузки».`);
        }
      }
      downloadToFolder(name, blob);
    });
    return writeChain;
  }
  // обязательные данные для общего скрипта yaarchive — независимо от галочки отладки
  function saveData(name, obj) {
    saveOut(name, new Blob([JSON.stringify(obj)], { type: 'application/json' }));
  }
  function saveDebug(name, obj) {
    if (!$('debugAll').checked) return;
    saveOut(name, new Blob([typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1)], { type: 'application/json' }));
  }

  // Excel всегда сохраняется в папку запуска (result.xlsx, перезаписывается по ходу работы);
  // если выбран «спросить, куда сохранить» — ещё и копия в выбранный файл.
  async function saveResult(final) {
    const bytes = await XlsxWriter.build(buildSheets());
    if (outDir) {
      // папка, выбранная кнопкой «Выбрать куда сохранять Excel, и начать»: result.xlsx рядом с Archive_Scans/
      writeChain = writeChain.then(async () => {
        try {
          const w = await (await outDir.getFileHandle('result.xlsx', { create: true })).createWritable();
          await w.write(bytes); await w.close();
        } catch (e) {
          log(`Не удалось записать result.xlsx в ${outDir.name} (${e.message}) — сохраняю в папку запуска.`);
          downloadToFolder('result.xlsx', new Blob([bytes], { type: XLSX_MIME }));
        }
      });
      await writeChain;
    } else {
      await saveOut('result.xlsx', new Blob([bytes], { type: XLSX_MIME }));
    }
    if (fileHandle) {
      try {
        const w = await fileHandle.createWritable();
        await w.write(bytes);
        await w.close();
      } catch (e) {
        log('Не удалось записать в выбранный файл (' + e.message + ').');
      }
    }
    if (final) log(`Excel сохранён: ${outDir ? `«${outDir.name}/»` : outLabel()} result.xlsx (дворов ${families.length}, страниц ${sheetRows.length}).`);
    return true;
  }

  // ------------------------------------------------------------ основной цикл
  async function run() {
    running = true;
    stopRequested = false;
    debugSaved = false;
    debugIndex = [];
    debugStamp = runStamp();
    runDir = null;
    families = [];
    sheetRows = [];
    linkRows = [];
    rowRecords = [];
    blockRecords = [];
    pageMeta = {};
    scanDir = null;
    scanRel = undefined;
    scanStats = { saved: 0, existed: 0, failed: 0, bytes: 0 };
    const m = mode();
    const pageCache = new Map();     // `${fileId}:${page}` -> {url,text,date,found,err}
    let misses = 0;
    setRunningUi(true);
    log(`Тип обработки: ${m.label}. Вид Excel: ${Logic.MODES[outFormat()].label}. Сканы: ${settings.saveScans ? `сохранять в «${SCAN_DIR}»` : 'нет'}. ` +
        `Окно текста: ${settings.textSel || 'авто'}; дата: ${settings.dateSel || 'авто'}.`);
    // всего страниц для шкалы времени (одна страница в нескольких ссылках считается один раз)
    const allPages = new Set();
    for (const it of items) if (it.fileId && it.pFrom !== null) for (let n = it.pFrom; n <= it.pTo; n++) allPages.add(`${it.fileId}:${n}`);
    progressStart(allPages.size);

    try {
      const cur = await chrome.tabs.getCurrent();
      appTabId = cur ? cur.id : null;
      await ensureLogin();

      for (let idx = 0; idx < items.length && !stopRequested; idx++) {
        const it = items[idx];
        const tag = `[${idx + 1}/${items.length}] ${it.year ?? '—'}`;
        const rng = it.pFrom !== null ? `${it.pFrom}–${it.pTo}` : '—';

        if (!it.fileId || it.pFrom === null) {
          linkRows.push([it.year, it.url, rng, 0, 0, '', 'пропущена: нет fileId или диапазона', 0, 0, '', it.note]);
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
            const tPage = Date.now();
            const r = await fetchSheet(it.fileId, n);
            pageCache.set(key, r);
            noteMeta(r, n);
            if (r.err && !stopRequested) log(`  ВНИМАНИЕ: страница ${n} (${it.year ?? '—'}) не загружена: ${r.err}`);
            // скан сохраняется, пока рабочая вкладка ещё на этой странице; время скана идёт в счёт паузы
            let scanMs = 0;
            if (settings.saveScans && r.nextNode && !stopRequested) scanMs = await saveScan(r, n);
            if (!r.found && !stopRequested) {
              if (++misses >= CFG.MAX_MISSES) {
                stopRequested = true;
                log(`Окно распознанного текста не найдено на ${CFG.MAX_MISSES} страницах подряд — останавливаюсь, ` +
                    'чтобы не собирать лишнее. Нажмите «Указать окно текста вручную» и запустите снова.');
              }
            } else if (r.found) {
              misses = 0;
            }
            if (n < hi) await sleep(Math.max(0, rand(CFG.DELAY) - scanMs));
            progressStep(Date.now() - tPage);
          }
          texts.set(n, pageCache.get(key));
        }

        // 2. сбор людей
        const foundAll = new Set();
        const perPage = new Map();
        for (const [n, r] of texts) {
          const f = Logic.findSettlements(r.text, m.id);
          perPage.set(n, f);
          f.forEach((x) => foundAll.add(x));
        }

        const state = Layout.newState();
        const fams = [];
        const hows = new Set();
        const yrOf = (v) => { const mm = String(v || '').match(/(?<!\d)(1[5-9]\d\d)(?!\d)/); return mm ? parseInt(mm[1], 10) : null; };
        if (!it.year) {         // в файле ссылок года нет — по названию дела («… 6 ревизия …» → 1811)
          const first = [...texts.values()].find((x) => x.nextNode && x.nextNode.crumbs);
          const file = first ? (first.nextNode.crumbs.find((c) => c.type === 'File') || {}).name : '';
          it.year = Logic.yearFromText(file) || null;
          if (it.year) it.note = (it.note ? it.note + '; ' : '') + `год ${it.year} — по названию дела`;
        }
        for (const n of [...texts.keys()].sort((a, b) => a - b)) {
          const r = texts.get(n);
          const sr = {
            year: it.year, page: n,
            found: [...perPage.get(n)].sort().join('; '),
            url: r.url, text: r.err ? `ОШИБКА: ${r.err}` : r.text, check: '',
          };
          sheetRows.push(sr);
          if (r.err) {      // страница не загрузилась — общий скрипт предложит дозагрузку
            debugIndex.push({ year: it.year, fileId: it.fileId, page: n, url: r.url, how: 'ошибка загрузки', error: r.err, flags: [], halves: [], check: '' });
            continue;
          }
          let how = null;
          const tag8 = String(it.fileId).slice(0, 8);
          // данные страницы — вход общего скрипта yaarchive: сохраняются всегда, в обоих режимах
          if (r.nextNode) saveData(`${it.year || 'год'}_${tag8}_p${n}_next_data.json`, { props: { pageProps: { url: r.url, docNumber: n, year: it.year, fileId: it.fileId, mode: m.id, currentNode: r.nextNode } } });
          if (r.nextNode && m.id === 'revision') {
            how = Layout.processNode(r.nextNode, { url: r.url, page: n }, state, m.id, fams);
            debugIndex.push({ year: it.year, fileId: it.fileId, page: n, url: r.url, how, flags: [], halves: [], check: state.checks[n] || '' });
          }
          if (r.nextNode && m.id === 'confession') {
            state.lastRep = null;
            how = Layout.processConfessionNode(r.nextNode, { url: r.url, page: n, year: it.year }, state, m.id, fams);
            if (state.lastRep) {
              for (const mk of state.lastRep.settlement_marks) if (!String(mk.name).startsWith('other:')) { perPage.get(n).add(mk.name); foundAll.add(mk.name); }
              sr.found = [...perPage.get(n)].sort().join('; ');
            }
            if (state.lastRep) saveDebug(`${it.year || 'год'}_${tag8}_p${n}_confession.json`, state.lastRep);
            debugIndex.push({ year: it.year, fileId: it.fileId, page: n, url: r.url, how,
              flags: state.lastRep ? state.lastRep.flags : [], halves: state.lastRep ? state.lastRep.halves.map((h) => ({ no: h.no, columns: h.columns, people: h.people })) : [],
              check: state.checks[n] || '' });
          }
          if (!how) how = Layout.processPage({ candidates: r.candidates, text: r.text, url: r.url, page: n }, state, m.id, fams);
          sr.check = state.checks[n] || '';
          hows.add(how);
        }
        Layout.finish(state, fams);
        const docYear = it.year || yrOf(it.url) || '';
        fams.forEach((f) => { f.year = docYear; });
        families.push(...fams);
        const kindWarn = Logic.kindWarning([...texts.values()].map((x) => Logic.pageKindByText(x.text)), m.id);
        if (kindWarn) { log(`${tag}: ${kindWarn}`); if (state.rows.length) state.rows[0].notes.push(kindWarn); }
        state.rows.forEach((r) => rowRecords.push(Object.assign({ year: docYear }, r)));
        (state.blocks || []).forEach((b) => blockRecords.push(Object.assign({ year: docYear }, b)));
        const persons = m.id === 'confession'
          ? fams.reduce((acc, f) => acc + f.persons.reduce((a, p) => a + (p.rows && p.rows.length ? p.rows.length : 1), 0), 0)
          : fams.reduce((acc, f) => acc + f.persons.length, 0);

        const total = hi - lo + 1;
        const verdict = texts.size < total
          ? `ПРЕРВАНА (страниц ${texts.size} из ${total})`
          : 'ОБРАБОТАНА';
        linkRows.push([it.year, it.url, rng, texts.size, foundAll.size,
          [...foundAll].sort().join('; '), verdict, fams.length, persons, [...hows].join('; '),
          [kindWarn, it.note, state.dropped ? `отброшено служебных строк: ${state.dropped}` : '',
            state.orphans ? `несопоставленных ячеек: ${state.orphans}` : '',
            state.skipped.length ? `страницы без таблицы: ${state.skipped.join(', ')}` : ''].filter(Boolean).join('; ')]);
        log(`${tag}: диапазон ${rng} — НП ${foundAll.size}, дворов: ${fams.length}, людей: ${persons} (${[...hows].join('; ')})`);
        await saveResult(false);
      }
    } catch (e) {
      log('ОШИБКА: ' + (e && e.stack ? e.stack : e));
    } finally {
      progressShow(true);
      if (settings.saveScans) {
        log(`Сканы: сохранено ${scanStats.saved} (${Math.round(scanStats.bytes / 1048576)} МБ), уже были ${scanStats.existed}, ` +
            `не удалось ${scanStats.failed}. Папка: ${outDir ? `«${outDir.name}/${SCAN_DIR}/»` : linksDir ? `«${linksDir.name}/${SCAN_DIR}/»` : `«Загрузки/${SCAN_DIR}/»`}.`);
      }
      const failedPages = debugIndex.filter((x) => x.how === 'ошибка загрузки');
      if (failedPages.length) {
        log(`ВНИМАНИЕ: не загружено страниц — ${failedPages.length}: ${failedPages.map((x) => `${x.year ?? '—'} стр. ${x.page}`).join('; ')}. ` +
            'Данных и сканов по ним нет — запустите их отдельным диапазоном (или повторно через раздел 6).');
      }
      try { await saveResult(true); } catch (e) { log('Не удалось сохранить: ' + e.message); }
      if (debugIndex.length) {
        // run_summary.json пишется последним — признак «пакет готов» для общего скрипта (yaarchive --watch)
        saveData('run_summary.json', { version: chrome.runtime.getManifest().version, mode: settings.mode, complete: !stopRequested,
          finished: new Date().toISOString(), outDir: outDir ? outDir.name : '', linksDir: linksDir ? linksDir.name : '',
          scansDir: settings.saveScans ? SCAN_DIR : '', pages: debugIndex, links: linkRows });
        log(`Отладочный пакет: ${outLabel()} (страниц: ${debugIndex.length}). Пришлите эту папку на анализ.`);
      }
      if (workTabId !== null) { chrome.tabs.remove(workTabId).catch(() => {}); workTabId = null; }
      running = false;
      setRunningUi(false);
      setStatus(`Готово. Дворов: ${families.length}. Результаты: ${outLabel()}`);
      log(`Готово. Дворов: ${families.length}. Результаты: ${outLabel()}`);
      saveOut('run_log.txt', new Blob([$('log').textContent], { type: 'text/plain;charset=utf-8' }));
      try { await writeChain; } catch (e) { /* ошибки уже в журнале */ }
      if ($('engAuto').checked && debugIndex.length && (outDir || linksDir)) await engineRun(outDir || linksDir, false);
    }
  }

  // Папка сканов: выбранная вручную, иначе запомненная по умолчанию /Volumes/DATA/Archive_Scans (Chrome не пишет по строке пути —
  // папку нужно один раз указать в окне выбора, дальше она запоминается).
  async function ensureScansDir() {
    if (scanPicked) {
      if (await dirPermission(scanPicked, true)) return true;
      log(`Нет доступа к папке сканов «${scanPicked.name}».`);
      scanPicked = null;
    }
    try {
      const h = await idb((st) => st.get('scansDefault'));
      if (h && (await dirPermission(h, true))) { scanPicked = h; showNotes(); log(`Папка сканов не выбрана — использую умолчание ${DEFAULT_SCANS_PATH} («${h.name}»).`); return true; }
    } catch (e) { /* нет запомненной */ }
    log(`Папка «Archive_Scans» не выбрана: по умолчанию ${DEFAULT_SCANS_PATH}. Укажите её в окне выбора (запомнится).`);
    const h = await pickDir('yaarchive-scans-default', 'scansDefault');
    if (h) { scanPicked = h; showNotes(); return true; }
    log('Папка сканов не указана — сканы пойдут в «Archive_Scans» внутри папки результата.');
    return false;
  }
  // «Начать»: файл и папки выбраны вручную (или подставлены умолчания)
  async function startRun() {
    if (running || busyPicking) return;
    if (!items.length) { setStatus('Сначала выберите файл со ссылками (.html).'); return; }
    if (!outPicked) { setStatus('Выберите, куда сохранить результат («Выбрать куда сохранить результат»).'); return; }
    if (settings.saveScans) await ensureScansDir();
    linksDir = null; outDir = null;
    if (await dirPermission(outPicked, true)) linksDir = outDir = outPicked;
    else { setStatus(`Нет доступа к папке «${outPicked.name}» — выберите её заново.`); return; }
    fileHandle = null;
    scanDir = null;
    scanRel = undefined;
    log(`Папка результата: «${outDir.name}» — result.xlsx и yaarchive_debug/.`);
    await run();
  }
  $('startBtn').addEventListener('click', () => startRun());

  // ------------------------------------------------------------- итоговая обработка (общий скрипт yaarchive, встроен в расширение)
  let engWorker = null, engSeq = 0, engBusy = false, engProps = [];
  const engPending = new Map();
  function engineCall(msg, transfer) {
    return new Promise((resolve, reject) => {
      if (!engWorker) {
        engWorker = new Worker('engine-worker.js');
        engWorker.onmessage = (ev) => {
          const m = ev.data;
          if (m.type === 'log') { log('  ' + m.text); return; }
          const p = engPending.get(m.id);
          if (!p) return;
          engPending.delete(m.id);
          if (m.type === 'error') p.reject(new Error(m.message)); else p.resolve(m);
        };
        engWorker.onerror = (e) => { for (const p of engPending.values()) p.reject(new Error(e.message || 'ошибка воркера')); engPending.clear(); };
      }
      const id = ++engSeq;
      engPending.set(id, { resolve, reject });
      engWorker.postMessage({ ...msg, id }, transfer || []);
    });
  }
  async function readAll(dirH, rel, out, pick) {
    for await (const [name, h] of dirH.entries()) {
      const r = rel ? rel + '/' + name : name;
      if (h.kind === 'directory') await readAll(h, r, out, pick);
      else if (pick(r)) out.push({ path: r, data: await (await h.getFile()).arrayBuffer() });
    }
  }
  // что нужно движку из папки результата: данные страниц пакетов, итоговые файлы прошлого запуска и свои справочники
  async function engineInputs(dir) {
    const files = [];
    try { const f = await (await dir.getFileHandle('справочники.json')).getFile(); files.push({ path: 'справочники.json', data: await f.arrayBuffer() }); } catch (e) { /* нет */ }
    try {
      const dbg = await dir.getDirectoryHandle('yaarchive_debug');
      await readAll(dbg, 'yaarchive_debug', files, (r) => /_next_data\.json$|\/run_summary\.json$/.test(r));
    } catch (e) { /* пакетов нет */ }
    try { await readAll(await dir.getDirectoryHandle('Итог'), 'Итог', files, () => true); } catch (e) { /* первый запуск */ }
    return files;
  }
  async function writeFileAt(dir, path, data) {
    const parts = path.split('/');
    let d = dir;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
    await w.write(data);
    await w.close();
  }
  // имена сканов из «Archive_Scans» (для ссылок на сканы в итоге); без папки — ссылок на сканы нет
  async function engineScanNames(ask) {
    let h = scanDir || null;
    if (!h && scanPicked && (await dirPermission(scanPicked, ask))) {
      h = scanPicked.name === SCAN_DIR ? scanPicked : await scanPicked.getDirectoryHandle(SCAN_DIR).catch(() => scanPicked);
    }
    if (!h) { try { const d = await idb((st) => st.get('scansDefault')); if (d && (await dirPermission(d, ask))) h = d; } catch (e) { /* нет */ } }
    if (!h) return null;
    const base = scanAbs(), names = {};
    for await (const [name, e] of h.entries()) if (e.kind === 'file' && /\.jpe?g$/i.test(name)) names[name] = base + '/' + name;
    return names;
  }
  async function engineRun(dir, ask) {
    if (engBusy) return;
    engBusy = true;
    $('engBtn').disabled = true;
    $('engNote').textContent = 'Итоговая обработка… (первый запуск загружает движок, до минуты)';
    try {
      log('Итоговая обработка (общий скрипт yaarchive, встроен в расширение)…');
      const files = await engineInputs(dir);
      const scanNames = await engineScanNames(ask);
      const m = await engineCall({ cmd: 'run', files, scanNames, scansPublic: scanAbs() }, files.map((f) => f.data));
      await engineFinish(dir, m);
    } catch (e) {
      log('ОШИБКА итоговой обработки: ' + (e && e.message ? e.message : e));
      $('engNote').textContent = 'Итоговая обработка не выполнена: ' + (e && e.message ? e.message : e);
    } finally { engBusy = false; $('engBtn').disabled = false; }
  }
  async function engineFinish(dir, m) {
    for (const f of m.files) await writeFileAt(dir, f.path, f.data);
    const r = m.result;
    engProps = r.proposals || [];
    $('engNote').textContent = r.pages ? `Готово: людей ${r.people}, документов ${r.docs}, семей в GEDCOM ${r.fams}. Файлы — в «${dir.name}/Итог/».`
      : 'Пакетов с данными страниц в этой папке нет — сначала выполните обработку.';
    log(r.pages ? `Итог записан в «${dir.name}/Итог/»: ${r.files.join(', ')}.` : 'Итоговая обработка: пакетов с данными нет.');
    showProposals();
  }
  function showProposals() {
    const list = $('fixList');
    list.textContent = '';
    $('fixBox').hidden = !engProps.length;
    $('fixCount').textContent = engProps.length ? `— ${engProps.length}` : '';
    for (const p of engProps) {
      const d = document.createElement('div');
      d.className = 'fix'; d.dataset.id = p.id;
      const t = document.createElement('div'); t.className = 't'; t.textContent = `${p.type} — ${p.where || ''}`;
      const c = document.createElement('div'); c.textContent = `${p.now == null ? '' : p.now} → ${p.new == null ? '' : p.new}${p.reason ? ' · ' + p.reason : ''}`;
      const s = document.createElement('select');
      [['', 'пропустить'], ['да', 'да — исправить'], ['нет', 'нет — больше не предлагать']].forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; s.appendChild(o); });
      d.append(t, c);
      if (p.url) { const a = document.createElement('a'); a.href = p.url; a.target = '_blank'; a.rel = 'noreferrer'; a.textContent = 'страница в Яндекс Архиве'; d.append(a, document.createElement('br')); }
      d.append(s);
      list.appendChild(d);
    }
  }
  async function engineApply() {
    const dir = outDir || outPicked;
    const decisions = [...document.querySelectorAll('#fixList .fix')].map((d) => ({ id: d.dataset.id, decision: d.querySelector('select').value })).filter((x) => x.decision);
    if (!decisions.length) { $('engNote').textContent = 'Выберите «да» или «нет» хотя бы для одного предложения.'; return; }
    if (!dir || engBusy) return;
    engBusy = true; $('fixApply').disabled = true;
    try {
      const m = await engineCall({ cmd: 'decide', decisions, scanNames: await engineScanNames(true), scansPublic: scanAbs() });
      await engineFinish(dir, m);
    } catch (e) { log('ОШИБКА применения решений: ' + (e && e.message ? e.message : e)); $('engNote').textContent = 'Решения не применены: ' + e.message; }
    finally { engBusy = false; $('fixApply').disabled = false; }
  }
  $('engBtn').addEventListener('click', async () => {
    if (running) return;
    if (!outPicked) { $('engNote').textContent = 'Выберите, куда сохранить результат («Выбрать куда сохранить результат»).'; return; }
    if (!(await dirPermission(outPicked, true))) { $('engNote').textContent = `Нет доступа к папке «${outPicked.name}».`; return; }
    await engineRun(outPicked, true);
  });
  $('fixApply').addEventListener('click', engineApply);
  const fixAll = (v) => document.querySelectorAll('#fixList select').forEach((s) => { s.value = v; });
  $('fixYes').addEventListener('click', () => fixAll('да'));
  $('fixNo').addEventListener('click', () => fixAll('нет'));
  $('fixSkip').addEventListener('click', () => fixAll(''));

  // ------------------------------------------------------------- старт
  (async () => {
    await loadSettings();
    applyModeUi();
    showSelectors();
    ['useDefaults', 'qOrig', 'qMid', 'qLow', 'saveScans', 'showTab', 'gedWrite', 'gedOrig'].forEach((id) => { $(id).checked = false; });
    try { const cur = await chrome.tabs.getCurrent(); appTabId = cur ? cur.id : null; } catch (e) { /* ignore */ }
    // флажки и выбор файла/папок при запуске сброшены: всё выбирается вручную (или флажком «Использовать умолчания»)
    showNotes();
  })();
})();
