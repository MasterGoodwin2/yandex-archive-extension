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

  let dlPlan = null;         // тип «Скачать графические образы»: {unique, entries} после удаления дубликатов
  let linksText = '';        // содержимое выбранного файла ссылок
  let linksKind = '';        // 'html' | 'ged' — определяется по расширению файла
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
  const settings = { textSel: '', dateSel: '' };    // окна текста не нужны: образы страниц берутся по коду скана
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
  // уровни качества — как в навыке «Сохранить Скан» (Scrpt_YA_Orig_Scan, YaOrigScan.QUALITY)
  const QUALITY = { qOrig: { label: 'Оригинальное', percent: 100, value: 1 }, qMid: { label: 'Среднее', percent: 50, value: 0.5 },
    qLow: { label: 'Низкое', percent: 20, value: 0.2 } };
  let curQuality = SCAN_QUALITY;
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

  function setRunningUi(on) {
    $('startBtn').disabled = on;
    ['pickFileBtn', 'pickOutBtn', 'pickScanBtn', 'useDefaults', 'scanPath', 'qOrig', 'qMid', 'qLow', 'gedWrite', 'gedSource', 'gedMedia', 'gedCopy', 'gedOrig'].forEach((id) => { $(id).disabled = on; });
    document.querySelectorAll('input[name="mode"]').forEach((r) => { r.disabled = on; });
    $('saveBtn').disabled = !on;
    $('stopBtn').disabled = !on;
  }

  const imagesMode = () => true;     // в этом расширении единственный тип обработки
  const kindNow = () => 'images';
  // форма диалога следует за типом обработки: элементы с data-only показываются только для своих типов
  function applyModeUi() {
    $('descImages').textContent = 'Только сканы страниц и Excel со ссылками. Источник — файл .ged (генеалогический проект) или .html (список ссылок); ' +
      'ссылки очищаются от «?center=», дубликаты удаляются. Диапазоны не раскрываются: берётся только страница, указанная в ссылке.';
    const cur = kindNow();
    document.querySelectorAll('input[name="mode"]').forEach((r) => { r.checked = r.value === cur; });
    document.querySelectorAll('[data-only]').forEach((el) => { el.hidden = !el.dataset.only.split(' ').includes(cur); });
    $('startBtn').textContent = 'Начать';
  }
  // ---- выбор файла и папок: всегда конкретное место; с флажком «Использовать умолчания» берётся запомненное
  const note = (id, text) => { $(id).textContent = text; };
  function showNotes() {
    note('srcNote', srcFile ? `Файл со ссылками: «${srcFile.name}»` : 'Файл не выбран');
    note('outNote', outPicked ? `Результат сохраняется в папку: «${outPicked.name}»` : 'Папка результата не выбрана');
    note('scanNote', scanPicked
      ? `Сканы сохраняются в: «${scanPicked.name === SCAN_DIR ? scanPicked.name : scanPicked.name + '/' + SCAN_DIR}»`
      : `Папка сканов не выбрана — по умолчанию ${DEFAULT_SCANS_PATH}`);
    const isGed = linksKind === 'ged' && imagesMode();
    $('gedBox').hidden = !isGed;
    if (isGed) {
      $('gedOpts').style.display = $('gedWrite').checked ? '' : 'none';
      note('gedNote', $('gedWrite').checked
        ? `После скачивания: ${$('gedMedia').checked ? 'общий медиа-объект' : 'источник'}; ${$('gedOrig').checked ? 'в исходный файл (копия до сканов — рядом)' : 'в копию _со_сканами.ged'}`
        : 'Запись в GEDCOM не включена — файл .ged останется как есть');
    }
    const q = scanQualityId();
    note('qNote', q ? `Качество скана: «${QUALITY[q].label}» — ${QUALITY[q].percent}%` : 'Качество не выбрано');
  }
  ['gedWrite', 'gedSource', 'gedMedia', 'gedCopy', 'gedOrig'].forEach((id) => $(id).addEventListener('change', showNotes));
  function scanQualityId() { return Object.keys(QUALITY).find((id) => $(id).checked) || null; }
  ['qOrig', 'qMid', 'qLow'].forEach((id) => $(id).addEventListener('change', () => {
    if ($(id).checked) Object.keys(QUALITY).forEach((o) => { if (o !== id) $(o).checked = false; });   // один из трёх
    showNotes();
  }));
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
  $('saveBtn').addEventListener('click', async () => { await saveLinksResult(true); });
  window.addEventListener('beforeunload', (e) => {
    if (running) { e.preventDefault(); e.returnValue = ''; }
  });

  // ------------------------------------------------------ список ссылок
  // Тип файла определяет обработку: .ged — только образы страниц; .html — список ссылок для выбранного типа
  function sourceInfo(text) { $('linksInfo').textContent = text; }
  function refreshSource() {
    dlPlan = null;
    if (!linksText) return;
    const name = srcFile ? srcFile.name : 'файл';
    const src = linksKind === 'ged' ? LinksTools.gedcomLinks(linksText) : LinksTools.htmlLinks(linksText);
    dlPlan = src.length ? LinksTools.buildPlan(src, { expandRange: false }) : null;
    if (!dlPlan) sourceInfo(`${name}: ссылок ya.ru / yandex.ru не найдено.`);
    else {
      const st = (re) => dlPlan.entries.filter((e) => re.test(e.status)).length;
      sourceInfo(`${name}: найдено ссылок ${src.length}; уникальных страниц ${dlPlan.unique.length}; дубликатов ${st(/^дубликат/)}; ` +
        `пропущено (нет номера страницы или не архив) ${st(/^пропущена/)}.`);
    }
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
      linksKind = /\.ged$/i.test(name) ? 'ged' : 'html';
      refreshSource();
    } catch (err) {
      linksText = ''; linksKind = ''; refreshSource();
      $('linksInfo').textContent = `Не удалось прочитать ${name}: ${err.message}`;
    }
    showNotes();
  }

  $('pickFileBtn').addEventListener('click', async () => {
    if (!window.showOpenFilePicker) { $('linksInfo').textContent = 'Этот Chrome не умеет выбирать файл.'; return; }
    try {
      const [h] = await window.showOpenFilePicker({ id: 'yaarchive-links', multiple: false,
        types: [{ description: 'Список ссылок (.html) или проект (.ged)', accept: { 'text/html': ['.html', '.htm'], 'text/plain': ['.ged'] } }] });
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

        const wantHtml = false;
        const [inj] = await chrome.scripting.executeScript({
          target: { tabId },
          func: PageScripts.pageExtractor,
          args: [{ textSel: settings.textSel, dateSel: settings.dateSel, maxWait: CFG.RENDER_WAIT, wantHtml,
                  useNext: true, nextOnly: true }],
        });
        const res = (inj && inj.result) || { found: false, text: '', date: '' };
        if (!res.found && !res.nextNode && attempt < CFG.MAX_RETRIES) {      // страница не успела отдать данные — пробуем ещё раз
          lastErr = 'окно распознанного текста не найдено';
          log(`  страница ${n}: данных нет, повтор ${attempt + 2}/${CFG.MAX_RETRIES + 1}`);
          await sleep(3000);
          continue;
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
  $('startBtn').addEventListener('click', () => startImages());

  // «Начать» для образов страниц: результат — в выбранную папку, сканы — в «Archive_Scans», качество — по флажкам
  async function startImages() {
    if (!dlPlan || !dlPlan.unique.length) { setStatus('Сначала выберите файл со ссылками (.ged или .html).'); return; }
    if (!outPicked) { setStatus('Выберите, куда сохранить результат («Выбрать куда сохранить результат»).'); return; }
    const q = scanQualityId();
    if (!q) { setStatus('Отметьте качество скана: Оригинальное, Среднее или Низкое.'); return; }
    curQuality = QUALITY[q].value;
    await ensureScansDir();
    if (!(await dirPermission(outPicked, true))) { setStatus(`Нет доступа к папке «${outPicked.name}» — выберите её заново.`); return; }
    linksDir = null;
    gedRun = null;
    if (linksKind === 'ged' && $('gedWrite').checked) {
      gedRun = { variant: $('gedMedia').checked ? 'media' : 'source', toOrig: $('gedOrig').checked };
      if (gedRun.toOrig) {
        let ok = false;
        try { ok = (await srcFile.queryPermission({ mode: 'readwrite' })) === 'granted' || (await srcFile.requestPermission({ mode: 'readwrite' })) === 'granted'; } catch (e) { /* нет права */ }
        if (!ok) { setStatus('Нет права записи в исходный .ged — выберите «В копию» или разрешите запись.'); return; }
      }
    }
    await runDownload(outPicked);
  }


  // ------------------------------------------------------ тип «Скачать графические образы страниц»
  // Источник: файл .ged или .html (тип определяется по расширению). Все ссылки приводятся к ya.ru/archive/catalog/<дело>/<страница>,
  // дубликаты удаляются, для каждой страницы сохраняется скан (тот же модуль, что «Сохранить Графические сканы?»).
  let dlRunPlan = null;      // план текущего запуска
  let gedRun = null;         // запись в GEDCOM: {variant:'source'|'media', toOrig}
  let dlMeta = {};           // ссылка страницы -> {cga, scanName, scanFile, scanHref, err}

  async function writeDl(name, blob) {
    writeChain = writeChain.then(async () => {
      try {
        const w = await (await outDir.getFileHandle(name, { create: true })).createWritable();
        await w.write(blob); await w.close();
      } catch (e) { log(`Не удалось записать ${name} в «${outDir.name}» (${e.message}).`); }
    });
    return writeChain;
  }
  async function saveLinksResult(final) {
    if (!dlRunPlan || !outDir) return;
    const f = LinksTools.csvFiles(dlRunPlan, dlMeta);
    await writeDl('result_links.csv', new Blob([f.main], { type: 'text/csv;charset=utf-8' }));
    await writeDl('result_links_all.csv', new Blob([f.all], { type: 'text/csv;charset=utf-8' }));
    if (final) log(`Таблица сохранена: «${outDir.name}/» result_links.csv (страниц ${dlRunPlan.unique.length}) и result_links_all.csv (все найденные ссылки). Кодировка UTF-8, разделитель «;».`);
  }

  // одна страница: скан уже есть -> пропуск без открытия страницы (имя файла известно по пути дела из первой страницы этого дела)
  async function dlOne(u, crumbsByFile) {
    const tPage = Date.now();
    const known = crumbsByFile.get(u.fileId);
    if (known) {
      const ci = ExcelSheets.crumbInfo(known, u.page, null, 'https://ya.ru');
      if (!ci.scanName.startsWith('YA_archive_') && await scanExists(ci.scanName)) {
        scanStats.existed++;
        dlMeta[u.clean] = { cga: ci.cga, docType: ci.docType, scanName: ci.scanName, scanFile: `${SCAN_DIR}/${ci.scanName}`, scanLocal: scanLocalFor(ci.scanName), scanHref: scanHrefFor(ci.scanName), err: '' };
        log(`${u.clean}: скан ${ci.scanName} уже есть — пропущен.`);
        progressStep(Date.now() - tPage);
        return false;
      }
    }
    log(`${u.clean}: загружаю страницу...`);
    const r = await fetchSheet(u.fileId, u.page);
    if (!r.nextNode || !r.nextNode.id) {
      dlMeta[u.clean] = { err: r.err || 'нет данных страницы (не найден код скана)' };
      log(`  ВНИМАНИЕ: ${u.clean} не загружена: ${dlMeta[u.clean].err}`);
      progressStep(Date.now() - tPage);
      return true;
    }
    crumbsByFile.set(u.fileId, r.nextNode.crumbs);
    noteMeta(r, u.page);
    const scanMs = await saveScan(r, u.page);
    const m = pageMeta[r.url] || {};
    dlMeta[u.clean] = { cga: m.cga || '', docType: m.docType || '', scanName: m.scanName || '', scanFile: m.scanFile || '', scanLocal: m.scanLocal || '', scanHref: m.scanHref || '',
      err: m.scanFile ? '' : (m.scanErr || 'скан не сохранён') };
    progressStep(Date.now() - tPage);
    await sleep(Math.max(0, rand(CFG.DELAY) - scanMs));
    return true;
  }

  // навык «Запись в GEDCOM»: ссылки на сохранённые сканы -> в .ged (копия или исходный файл с копией «до сканов»)
  async function writeGedcom(dir, plan) {
    const name = srcFile.name.replace(/\.ged$/i, '');
    try {
      const r = GedcomWriter.apply(linksText, plan, dlMeta, gedRun.variant);
      const st = r.stats;
      if (!st.pages) { log(`GEDCOM: записывать нечего — сканов с персонами нет (без скана ${st.noScan}, без персоны ${st.noPerson}).`); return; }
      const put = async (handle, blob) => { const w = await handle.createWritable(); await w.write(blob); await w.close(); };
      const bytes = new TextEncoder().encode(r.text);
      if (gedRun.toOrig) {
        const f = await srcFile.getFile();
        await put(await dir.getFileHandle(`${name}_до_сканов.ged`, { create: true }), f);
        await put(srcFile, new Blob([bytes], { type: 'text/plain' }));
        log(`GEDCOM: записано в исходный файл «${srcFile.name}»; прежний сохранён: «${dir.name}/${name}_до_сканов.ged».`);
      } else {
        await put(await dir.getFileHandle(`${name}_со_сканами.ged`, { create: true }), new Blob([bytes], { type: 'text/plain' }));
        log(`GEDCOM: записано в «${dir.name}/${name}_со_сканами.ged».`);
      }
      log(`GEDCOM (${gedRun.variant === 'media' ? 'общий медиа-объект' : 'источник'}): страниц ${st.pages}, ссылок у персон ${st.links}, персон ${st.persons}; ` +
        `без скана ${st.noScan}, без персоны ${st.noPerson}; записей этой страницы уже было у персоны: другим вариантом записано ${st.switched}, пропущено ${st.exists}${st.removed ? `; прежних записей навыка заменено ${st.removed}` : ''}. Кодировка файла — UTF-8.`);
    } catch (e) { log('GEDCOM: не удалось записать — ' + (e && e.message)); }
  }

  async function runDownload(dir) {
    running = true; stopRequested = false;
    outDir = dir; fileHandle = null; debugSaved = true;
    pageMeta = {}; dlMeta = {}; scanDir = null; scanRel = undefined;
    scanStats = { saved: 0, existed: 0, failed: 0, bytes: 0 };
    const plan = dlRunPlan = dlPlan;
    setRunningUi(true);
    progressStart(plan.unique.length);
    log(`Образы страниц: уникальных страниц ${plan.unique.length} из ссылок ${plan.entries.length}. Папка: «${dir.name}». Качество скана: ${QUALITY[scanQualityId()] ? QUALITY[scanQualityId()].label + ' ' + QUALITY[scanQualityId()].percent + '%' : '—'}.`);
    try {
      const cur = await chrome.tabs.getCurrent();
      appTabId = cur ? cur.id : null;
      await writeDl('list_links_fixed.html', new Blob([LinksTools.fixedHtml(plan)], { type: 'text/html;charset=utf-8' }));
      await saveLinksResult(false);                       // таблица всех найденных ссылок готова сразу
      await ensureLogin();
      const crumbs = new Map();
      let n = 0;
      for (const u of plan.unique) {
        if (stopRequested) break;
        setStatus(`Образы страниц: ${++n} из ${plan.unique.length}`);
        if (await dlOne(u, crumbs) && n % 10 === 0) await saveLinksResult(false);
      }
      // второй проход по страницам, которые не загрузились
      const bad = plan.unique.filter((u) => dlMeta[u.clean] && dlMeta[u.clean].err);
      if (bad.length && !stopRequested) {
        log(`Повторная попытка для страниц, которые не удалось скачать: ${bad.length}.`);
        progress.total += bad.length; progressShow();
        for (const u of bad) { if (stopRequested) break; await sleep(2000); await dlOne(u, crumbs); }
      }
    } catch (e) {
      log('ОШИБКА: ' + (e && e.stack ? e.stack : e));
    } finally {
      progressShow(true);
      const bad = plan.unique.filter((u) => !dlMeta[u.clean] || dlMeta[u.clean].err);
      log(`Сканы: сохранено ${scanStats.saved} (${Math.round(scanStats.bytes / 1048576)} МБ), уже были ${scanStats.existed}, не удалось ${scanStats.failed}. Папка: «${scanDir ? scanDir.name : dir.name + '/' + SCAN_DIR}».`);
      if (bad.length) log(`ВНИМАНИЕ: без скана осталось ${bad.length}: ${bad.map((u) => u.clean).join('; ')}`);
      try { await saveLinksResult(true); } catch (e) { log('Не удалось сохранить Excel: ' + e.message); }
      if (gedRun) await writeGedcom(dir, plan);
      if (workTabId !== null) { chrome.tabs.remove(workTabId).catch(() => {}); workTabId = null; }
      const done = plan.unique.length - bad.length;
      running = false;
      setRunningUi(false);
      setStatus(`Готово. Образов страниц: ${done} из ${plan.unique.length}${stopRequested ? ' (остановлено)' : ''}. Папка: «${dir.name}».`);
      log(`Готово. Образов страниц: ${done} из ${plan.unique.length}.`);
      await writeDl('links_run_log.txt', new Blob([$('log').textContent], { type: 'text/plain;charset=utf-8' }));
      try { await writeChain; } catch (e) { /* ошибки уже в журнале */ }
    }
  }

  // ------------------------------------------------------------- старт
  (async () => {
    applyModeUi();
    ['useDefaults', 'qOrig', 'qMid', 'qLow', 'showTab', 'gedWrite', 'gedOrig'].forEach((id) => { $(id).checked = false; });
    try { const cur = await chrome.tabs.getCurrent(); appTabId = cur ? cur.id : null; } catch (e) { /* ignore */ }
    // флажки и выбор файла/папок при запуске сброшены: всё выбирается вручную (или флажком «Использовать умолчания»)
    showNotes();
  })();
})();
