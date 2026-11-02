// Движок итоговой обработки внутри расширения: общий скрипт yaarchive (Python) работает в Pyodide (WebAssembly),
// установка Python и Терминал не нужны. Воркер получает файлы пакетов из папки результата, отдаёт готовые файлы «Итог/».
/* global loadPyodide, importScripts */
'use strict';
importScripts('engine/pyodide.js');

let py = null;
const post = (m, tr) => self.postMessage(m, tr || []);

async function boot() {
  if (py) return py;
  py = await loadPyodide({ indexURL: 'engine/' });
  const zip = new Uint8Array(await (await fetch('engine/engine.zip')).arrayBuffer());
  py.unpackArchive(zip, 'zip', { extractDir: '/engine' });
  py.runPython("import sys, json\nsys.path.insert(0, '/engine')\nimport yaarchive as Y");
  py.FS.mkdirTree('/res');
  return py;
}

function wipe(path) {
  for (const n of py.FS.readdir(path)) {
    if (n === '.' || n === '..') continue;
    const p = path + '/' + n;
    if (py.FS.isDir(py.FS.stat(p).mode)) { wipe(p); py.FS.rmdir(p); } else py.FS.unlink(p);
  }
}

function collect(path, rel, out) {
  for (const n of py.FS.readdir(path)) {
    if (n === '.' || n === '..') continue;
    const p = path + '/' + n, r = rel ? rel + '/' + n : n;
    if (py.FS.isDir(py.FS.stat(p).mode)) collect(p, r, out);
    else out.push({ path: r, data: py.FS.readFile(p).buffer });
  }
}

function result(id, res) {
  const files = [];
  collect('/res/Итог', 'Итог', files);
  try { py.FS.stat('/res/Дозагрузка_страниц.html'); files.push({ path: 'Дозагрузка_страниц.html', data: py.FS.readFile('/res/Дозагрузка_страниц.html').buffer }); } catch (e) { /* нет файла дозагрузки */ }
  post({ type: 'done', id, result: res, files }, files.map((f) => f.data));
}

function runEngine(scanNames, scansPublic) {
  py.globals.set('_scan_names', JSON.stringify(scanNames || null));
  py.globals.set('_scans_public', scansPublic || '/Volumes/DATA/Archive_Scans');
  py.globals.set('_sink', (s) => post({ type: 'log', text: String(s) }));
  return JSON.parse(py.runPython("Y.engine_run('/res', _scan_names, _scans_public, sink=_sink)"));
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    await boot();
    if (m.cmd === 'run') {
      wipe('/res');
      for (const f of m.files) {
        const dir = ('/res/' + f.path).split('/').slice(0, -1).join('/');
        py.FS.mkdirTree(dir);
        py.FS.writeFile('/res/' + f.path, new Uint8Array(f.data));
      }
      result(m.id, runEngine(m.scanNames, m.scansPublic));
    } else if (m.cmd === 'decide') {
      py.globals.set('_decisions', JSON.stringify(m.decisions));
      py.globals.set('_sink', (s) => post({ type: 'log', text: String(s) }));
      py.runPython("Y.Log.sink = _sink; Y.engine_decide(_decisions)");
      result(m.id, runEngine(m.scanNames, m.scansPublic));
    } else if (m.cmd === 'ping') {
      post({ type: 'ready', id: m.id });
    }
  } catch (e) {
    post({ type: 'error', id: m.id, message: String((e && e.message) || e) });
  }
};
