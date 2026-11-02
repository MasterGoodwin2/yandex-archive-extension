"""Сквозная проверка расширения в настоящем Chromium (Playwright): расширение загружено распакованным, страницы
Яндекс Архива подменяются записанными данными (тег __NEXT_DATA__ с breadcrumbs, image-grant, оригинал скана),
нажимается «Начать», проверяются шкала времени, сохранение сканов и Excel.
Запуск: xvfb-run -a python3 tests/e2e/run_e2e.py <сценарий> <out_dir> [--chrome <путь к chrome>] [--debug <папка yaarchive_debug/...>]
сценарии: conf (исповедные -> вид исповедные, сканы), conf_as_rev (исповедные -> вид ревизские, сканы),
          rev_as_conf (ревизские -> вид исповедные, сканы),
          Папка со ссылками и результатами — OPFS (вместо окна выбора папки); после запуска её содержимое выгружается в <out>/downloads"""
import json, re, sys, time, glob, os, shutil
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
EXT = str(HERE.parent.parent)
argv = sys.argv[1:]
def opt(name, default):
    if name in argv:
        i = argv.index(name); v = argv[i + 1]; del argv[i:i + 2]; return v
    return default
BACKGROUND = '--background' in argv
if BACKGROUND: argv.remove('--background')
CHROME = opt('--chrome', '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome')
FIX = HERE.parent / 'fixtures'
scenario, out = argv[0], Path(argv[1])
shutil.rmtree(out, ignore_errors=True); out.mkdir(parents=True)

CR_CONF = [{"type": "Archive", "id": "b3831e8d-dfcc-4221-9a3b-f4f526555411", "code": "ЦГА МОСКВЫ", "name": "ЦГА Москвы"},
           {"type": "Fund", "id": "4d6e1847-9f6a-44de-b2ae-865339bfd4c9", "code": "203", "name": "МОСКОВСКАЯ ДУХОВНАЯ КОНСИСТОРИЯ"},
           {"type": "Inventory", "id": "76a79093-ea45-462e-86a1-4a0b11ee85df", "code": "747", "name": "Опись № 747"},
           {"type": "File", "id": "3aa266f8-a0ed-434d-bd5d-c095d45efc1b", "code": "15", "name": "Исповедные ведомости"}]
CR_REV = [{"type": "Archive", "id": "b3831e8d-dfcc-4221-9a3b-f4f526555411", "code": "ЦГА МОСКВЫ", "name": "ЦГА Москвы"},
          {"type": "Fund", "id": "f-51", "code": "51", "name": "Московская казённая палата"},
          {"type": "Inventory", "id": "i-8", "code": "8", "name": "Опись № 8"},
          {"type": "File", "id": "bfed2966-e671-4c18-bbb0-a9551ad28f8e", "code": "588", "name": "Ревизские сказки"}]
PAGES = {}
for n in (865, 866, 867):
    d = json.load(open(FIX / f'e2e_1739_p{n}_next_data.json'))
    PAGES[('3aa266f8-a0ed-434d-bd5d-c095d45efc1b', n)] = (d['props']['pageProps']['currentNode'], CR_CONF)
d = json.load(open(f'{EXT}/tests/page165_fixture.json'))
node = d['props']['pageProps']['currentNode'] if 'props' in d else d
PAGES[('bfed2966-e671-4c18-bbb0-a9551ad28f8e', 165)] = (node, CR_REV)
def make_scan():
    import io
    from PIL import Image, ImageDraw
    import random
    random.seed(1)
    im = Image.new('RGB', (2400, 1900), 'white'); d = ImageDraw.Draw(im)
    for _ in range(4000):
        x, y = random.randint(0, 2390), random.randint(0, 1890)
        d.rectangle([x, y, x + 8, y + 3], fill=(random.randint(0, 120),) * 3)
    b = io.BytesIO(); im.save(b, 'JPEG', quality=95); return b.getvalue()
SCAN = make_scan()
stats = {'grant': 0, 'img': 0, 'pages': 0, 'token_ok': 0}


# Подставной ya.ru / yandex.ru: настоящий HTTPS-сервер на этой машине; Chromium направляется на него
# флагом --host-resolver-rules (без перехвата запросов Playwright — как обычная сеть для расширения).
import http.server, ssl, threading, subprocess, tempfile


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, ctype, body):
        b = body if isinstance(body, bytes) else body.encode('utf-8')
        self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(b)))
        self.end_headers(); self.wfile.write(b)

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        body = json.loads(self.rfile.read(n) or b'{}')
        if self.path.startswith('/archive/api/image-grant'):
            stats['grant'] += 1
            return self.send(200, 'application/json', json.dumps({'url': f"/archive/img/{body.get('nodeId')}.jpg", 'token': 'tok-' + str(body.get('nodeId'))}))
        self.send(404, 'text/plain', 'нет')

    def do_GET(self):
        if self.path.startswith('/archive/img/'):
            stats['img'] += 1
            if (self.headers.get('X-Archive-Image-Token') or '').startswith('tok-'):
                stats['token_ok'] += 1
            return self.send(200, 'image/jpeg', SCAN)
        m = re.match(r'/archive/catalog/([^/?#]+)/(\d+)', self.path)
        if m and (m.group(1), int(m.group(2))) in PAGES:
            stats['pages'] += 1
            node, crumbs = PAGES[(m.group(1), int(m.group(2)))]
            data = {'props': {'pageProps': {'currentNode': node, 'breadcrumbs': crumbs, 'docNumber': int(m.group(2))}},
                    'query': {'docNumber': m.group(2)}}
            html = ('<!doctype html><html><head><meta charset="utf-8"><title>Архив</title></head><body>'
                    '<nav>Главная Каталог</nav><div id="app">скан</div>'
                    f'<script id="__NEXT_DATA__" type="application/json">{json.dumps(data, ensure_ascii=False)}</script></body></html>')
            return self.send(200, 'text/html; charset=utf-8', html)
        self.send(200, 'text/html; charset=utf-8', '<html><body>archive</body></html>')


cert_dir = tempfile.mkdtemp()
subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=ya.ru',
                '-keyout', f'{cert_dir}/k.pem', '-out', f'{cert_dir}/c.pem'], check=True, capture_output=True)
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
sslctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); sslctx.load_cert_chain(f'{cert_dir}/c.pem', f'{cert_dir}/k.pem')
srv.socket = sslctx.wrap_socket(srv.socket, server_side=True)
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()


with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        str(out / 'profile'), headless=False, accept_downloads=True, downloads_path=str(out / 'dl'),
        executable_path=CHROME,
        args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--no-first-run', '--ignore-certificate-errors', '--no-proxy-server',
              f'--host-resolver-rules=MAP ya.ru:443 127.0.0.1:{PORT}, MAP yandex.ru:443 127.0.0.1:{PORT}'],
        ignore_https_errors=True)
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker', timeout=15000)
    ext_id = sw.url.split('/')[2]
    # загрузки через chrome.downloads — в папку out/downloads (как «Загрузки» пользователя)
    cdp = ctx.new_cdp_session(ctx.pages[0] if ctx.pages else ctx.new_page())
    dl_dir = out / 'downloads'; dl_dir.mkdir()
    cdp.send('Browser.setDownloadBehavior', {'behavior': 'allow', 'downloadPath': str(dl_dir), 'eventsEnabled': True})
    app = ctx.new_page()
    app.goto(f'chrome-extension://{ext_id}/app.html')
    app.wait_for_timeout(800)
    import base64
    def use_source(name, data):
        """Файл со ссылками — OPFS 'src/<name>' (окно выбора файла подменено); папка результата — OPFS 'out',
        папка сканов по умолчанию (/Volumes/DATA/Archive_Scans) — OPFS 'scans'; окна выбора папок подменены по id."""
        app.evaluate("""async ([name, b64]) => { const root = await navigator.storage.getDirectory();
            const d = await root.getDirectoryHandle('src', { create: true });
            const o = await root.getDirectoryHandle('out', { create: true });
            const sc = await root.getDirectoryHandle('scans', { create: true });
            const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
            const fh = await d.getFileHandle(name, { create: true });
            const w = await fh.createWritable(); await w.write(u); await w.close();
            window.__pickLog = [];
            window.showOpenFilePicker = async () => { window.__pickLog.push('file'); return [fh]; };
            window.showDirectoryPicker = async (opt) => { window.__pickLog.push(opt && opt.id);
              return (opt && opt.id === 'yaarchive-out') ? o : sc; }; }""", [name, base64.b64encode(data).decode()])
        app.click('#pickFileBtn'); app.wait_for_timeout(1000)
        app.click('#pickOutBtn'); app.wait_for_timeout(500)

    def dump_src(dest, DUMP='out'):
        res = app.evaluate("""async (DUMP) => { const out = {};
            const walk = async (dir, pre) => { for await (const [n, h] of dir.entries()) {
                if (h.kind === 'directory') await walk(h, pre + n + '/');
                else { const u = new Uint8Array(await (await h.getFile()).arrayBuffer()); let s = '';
                    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
                    out[pre + n] = btoa(s); } } };
            await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(DUMP), ''); return out; }""", DUMP)
        for name, b in res.items():
            f = Path(dest) / name; f.parent.mkdir(parents=True, exist_ok=True); f.write_bytes(base64.b64decode(b))
        return sorted(res)

    proc_mode = 'revision' if scenario.startswith('rev') else 'confession'
    app.check(f'input[name="mode"][value="{proc_mode}"]')
    want_rev_view = scenario in ('conf_as_rev',)
    want_view = 'revision' if (want_rev_view or scenario == 'rev') else 'confession'
    is_rev_view = app.is_checked('#outFormat')
    if is_rev_view != (want_view == 'revision'):
        app.click('label.toggle')
    app.check('#saveScans')
    if not BACKGROUND:
        app.check('#showTab')     # рабочая вкладка на виду (как при медленной загрузке страниц)
    app.wait_for_timeout(300)
    ui = {'outFormatInfo': app.inner_text('#outFormatInfo'), 'toggle_checked': app.is_checked('#outFormat')}
    lf = HERE / ('links_rev.html' if proc_mode == 'revision' else 'links_conf.html')
    use_source('list_links.html', lf.read_bytes())
    ui['linksInfo'] = app.inner_text('#linksInfo')
    app.click('#startBtn')
    prog = []
    t0 = time.time()
    while time.time() - t0 < 240:
        st = app.inner_text('#status')
        pt = app.inner_text('#progressText')
        if pt and (not prog or prog[-1] != pt):
            prog.append(pt)
        if st.startswith('Готово'):
            break

        app.wait_for_timeout(500)
    app.wait_for_timeout(3000)
    t1 = time.time()      # итоговая обработка (движок yaarchive в Pyodide) идёт после «Готово»
    while time.time() - t1 < 180 and not re.match(r'(Готово: людей|Итоговая обработка не выполнена|Пакетов с данными)', app.inner_text('#engNote')):
        app.wait_for_timeout(500)
    ui['engNote'] = app.inner_text('#engNote'); ui['fixCount'] = app.inner_text('#fixCount')
    # окно «Исправление ошибок»: решение «да» по первому предложению -> применяется, итог пересчитан
    ui['fix_before'] = app.locator('#fixList .fix').count()
    if ui['fix_before']:
        app.select_option('#fixList .fix >> nth=0 >> select', 'да')
        app.select_option('#fixList .fix >> nth=1 >> select', 'нет')
        app.evaluate("document.getElementById('engNote').textContent = ''")
        app.click('#fixApply')
        t2 = time.time()
        while time.time() - t2 < 120 and not app.inner_text('#engNote'):
            app.wait_for_timeout(500)
        ui['fix_after'] = app.locator('#fixList .fix').count(); ui['engNote2'] = app.inner_text('#engNote')
    ui['status'] = app.inner_text('#status')
    ui['progress'] = prog
    ui['log'] = app.inner_text('#log')
    ui['stats'] = stats
    (out / 'ui.json').write_text(json.dumps(ui, ensure_ascii=False, indent=1))
    dump_src(dl_dir)
    dump_src(out / 'scans_out', 'scans')
    ctx.close()
files = sorted(str(f.relative_to(out / 'downloads')) for f in (out / 'downloads').rglob('*') if f.is_file())
print(json.dumps({'files': files, 'stats': stats, 'progress': prog[-3:], 'status': ui['status'], 'outFormatInfo': ui['outFormatInfo']}, ensure_ascii=False, indent=1))

# проверки
ok = ui['status'].startswith('Готово') and stats['grant'] == stats['img'] == stats['token_ok'] > 0
xl = [f for f in (out / 'downloads').rglob('*') if f.suffix in ('.xlsx',) and 'Итог' not in f.parts]
if xl:
    from openpyxl import load_workbook
    ws = load_workbook(xl[0])['Люди']
    head = [c.value for c in ws[1]]
    ok &= head[-3:] == ['Ссылка на страницу', 'Локальная Ссылка на страницу', 'Архив хранения документа']
    links = [c.hyperlink.target for row in ws.iter_rows(min_row=2) for c in row if c.hyperlink]
    ok &= any(t.startswith('file:///Volumes/DATA/Archive_Scans/') for t in links) and any('/archive/catalog/' in t for t in links)
    want = 'Человек (как распознано)' if scenario in ('conf', 'rev_as_conf') else 'Люди двора (№ м/ж, как распознано, возраст)'
    ok &= want in head
else:
    ok = False
# встроенный движок: «Итог/» создан внутри расширения (без Терминала)
itog = out / 'downloads' / 'Итог'
need = ['Итог_люди.xlsx', 'Итог_древо.ged', 'Итог_люди.json', 'Отчёт.txt']
ok &= all((itog / n).is_file() and (itog / n).stat().st_size > 0 for n in need) and ui['engNote'].startswith('Готово: людей')
if (itog / 'Итог_древо.ged').is_file():
    ok &= (itog / 'Итог_древо.ged').read_text(encoding='utf-8').rstrip().endswith('0 TRLR')
if scenario.startswith('conf'):      # исповедные: есть предложения — окно решений работает
    ok &= (itog / 'исправления.json').is_file() and ui.get('fix_before', 0) >= 2 and ui.get('fix_after', 99) <= ui.get('fix_before', 0) - 2 and ui.get('engNote2', '').startswith('Готово: людей')
print('engine:', ui.get('engNote'), ui.get('fixCount'), 'исправления: было', ui.get('fix_before'), 'стало', ui.get('fix_after'))
print('E2E', scenario, 'OK' if ok else 'ОШИБКА')
sys.exit(0 if ok else 1)
