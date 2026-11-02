#!/usr/bin/env python3
"""
yaarchive — общий скрипт обработки Яндекс Архива: от пакетов расширения до Excel и GEDCOM,
с навыком «Исправление ошибок» (предложения с вашим подтверждением).

Загрузку делает расширение Chrome (нужен вход в Яндекс). Расширение 2.2.0+ кладёт каждую страницу в
«<папка ссылок>/yaarchive_debug/<дата_время>/<год>_<док>_p<стр>_next_data.json», сканы — в «Archive_Scans»
и последним пишет run_summary.json — признак «пакет готов». Дальше всё делает этот скрипт, по порядку:

  1  ПАКЕТЫ       находит готовые пакеты; незавершённые (идёт запись) ждёт
  2  СТРАНИЦЫ     читает данные страниц, проверяет целостность; страница из нескольких пакетов — из самого нового
  3  ДОКУМЕНТЫ    группирует по документам (год + дело), сортирует по номеру страницы (числом, не текстом)
  4  ТИП          тип страницы по тексту (исповедная ведомость / ревизская сказка), решение — по документу
  5  РАЗБОР       исповедные: столбцы → номера по соседям → люди → НП и двор по порядку страниц;
                  ревизские: строки таблицы → люди, родство, возраст, выбытие
  6  НП           названия НП к одному виду по справочнику («д. Черепкова» = «деревня Черепкова»)
  7  ПРАВКИ-1     принятые исправления базовых значений: НП, двор, пол, номер, возраст, текст, имя
  8  ДВОР         пустой «Двор №» — по соседним дворам документа
  9  РОДСТВО      глава, жена, дети, братья; отчество детей от имени отца (исповедные ведомости)
 10  ПРАВКИ-2     принятые исправления родства (ID отца/мужа, родство) и года рождения
 11  ГОД РОЖДЕНИЯ год документа − возраст (ревизские — по нынешнему или прошлому возрасту)
 12  СКАНЫ        имя файла по пути «ЦГА Москвы/Фонд/Опись/Дело» (как Scrpt_YA_Orig_Scan), поиск в Archive_Scans
 13  ПРОВЕРКА     замечания по людям и страницам
 14  ИСПРАВЛЕНИЕ  навык «Исправление ошибок»: предложения + ваши ручные правки из Excel
 15  ИТОГ         «Итог/»: Итог_люди.xlsx, Итог_древо.ged, Итог_люди.json, Отчёт.txt
 16  ДИАЛОГ       подтверждение исправлений в окне (если вы рядом) или в листе «Исправления» Excel;
                  принятые сразу применяются и итог пересчитывается

Запуск:
  python yaarchive.pyz                    двойной щелчок: следить за папкой, где лежит скрипт
  python yaarchive.pyz --watch ПАПКА      следить за папкой
  python yaarchive.pyz ПАПКА              обработать один раз (с диалогом исправлений) и выйти
  python yaarchive.pyz ПАПКА --no-dialog  без диалога: предложения только в Excel
"""
import argparse
import datetime
import hashlib
import json
import math
import os
import queue
import re
import subprocess
import sys
import threading
import time
import traceback
from collections import Counter, OrderedDict
from pathlib import Path, PurePosixPath
from types import SimpleNamespace

VERSION = "3.3.0"
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# модули навыков: внутри yaarchive.pyz лежат рядом; в репозитории — в skill/*/scripts
_HERE = Path(__file__).resolve().parent
for _p in (_HERE, _HERE.parent / "skill" / "yaarchive-revision-rows" / "scripts"):
    if _p.is_dir() and str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import extract_confession as EC          # noqa: E402
import extract_rows as ER                # noqa: E402
import revision_people as RP             # noqa: E402
import split_names as SN                 # noqa: E402
import ya_fix as FX                      # noqa: E402

import functools                         # noqa: E402
SN.nk = functools.lru_cache(maxsize=200000)(SN.nk)
nk = SN.nk
_name_sex_full = SN.name_sex


def _name_sex_cached(tok, nxt=(), prv=()):
    return _name_sex_ctx(tok, tuple(nxt), tuple(prv))


@functools.lru_cache(maxsize=200000)
def _name_sex_ctx(tok, nxt, prv):
    return _name_sex_full(tok, nxt, prv)


SN.name_sex = _name_sex_cached
DEBUG_DIR, SCAN_DIR, OUT_DIR = "yaarchive_debug", "Archive_Scans", "Итог"
DEFAULT_SCANS = "/Volumes/DATA/Archive_Scans"        # папка сканов по умолчанию (как в расширении)
XLSX, GED, JSONF, REPORT = "Итог_люди.xlsx", "Итог_древо.ged", "Итог_люди.json", "Отчёт.txt"
KIND_CONF, KIND_REV = "confession", "revision"
KIND_RU = {KIND_CONF: "Исповедная ведомость", KIND_REV: "Ревизская сказка"}
CONF_ARGS = dict(main_min_w=0.08, left_zone=0.14, right_zone=0.09, col_gap=0.35, age_tol=0.8, year=None, max_halves=2)
SPR = {}          # справочники


class Log:
    fh = None

    sink = None            # расширение Chrome: функция, получающая строки журнала

    @classmethod
    def __call__(cls, msg):
        line = f"[{datetime.datetime.now():%H:%M:%S}] {msg}"
        if cls.sink:
            cls.sink(line)
        else:
            print(line, flush=True)
        if cls.fh:
            cls.fh.write(f"{datetime.date.today()} {line}\n")
            cls.fh.flush()


log = Log()


# =============================================================================== 0. запуск
def ensure_openpyxl():
    try:
        import openpyxl  # noqa: F401
        return True
    except ImportError:
        pass
    log("Нужна библиотека openpyxl — устанавливаю (один раз)…")
    if subprocess.run([sys.executable, "-m", "pip", "--version"], capture_output=True).returncode != 0:
        subprocess.run([sys.executable, "-m", "ensurepip", "--user"], capture_output=True)   # Python без pip
    for extra in ([], ["--break-system-packages"]):
        r = subprocess.run([sys.executable, "-m", "pip", "install", "--user", "--quiet", "openpyxl"] + extra)
        if r.returncode == 0:
            break
    import importlib
    import site
    try:
        site.addsitedir(site.getusersitepackages())
    except Exception:
        pass
    importlib.invalidate_caches()
    try:
        import openpyxl  # noqa: F401,F811
        return True
    except ImportError:
        log(f"Не удалось установить openpyxl (нет интернета?). Выполните в Терминале:  {sys.executable} -m pip install --user openpyxl")
        return False


def read_resource(name):
    p = _HERE / name
    if p.is_file():
        return p.read_text(encoding="utf-8")
    import pkgutil                                       # внутри yaarchive.pyz
    data = pkgutil.get_data("ya_fix", name)
    return data.decode("utf-8") if data else None


def load_spravochniki(roots):
    """встроенные справочники; копия «справочники.json» рядом со скриптом или в папке пакетов — главнее"""
    global SPR
    src, text = "встроенные", read_resource("справочники.json")
    for d in [Path(sys.argv[0]).resolve().parent] + [Path(r) for r in roots]:
        f = d / "справочники.json"
        if f.is_file() and f.resolve() != (_HERE / "справочники.json").resolve():
            text, src = f.read_text(encoding="utf-8"), str(f)
    SPR = json.loads(text)
    SN._names = {"M": set(SPR["имена"]["M"]), "F": set(SPR["имена"]["F"])}
    SN.RELATION.clear()
    SN.RELATION.update(SPR["родство"]["слова"])
    SN.PRON.clear()
    SN.PRON.update(SPR["родство"]["местоимения"])
    RP.REL_NORM.clear()
    RP.REL_NORM.update(SPR["родство"]["к_норме"])
    RP.ORDINAL.clear()
    RP.ORDINAL.update(SPR["родство"]["порядковые"])
    np_ = SPR["населённые_пункты"]
    EC.SETTLEMENTS = {k: v["шаблон"] for k, v in np_["список"].items()}
    EC.SETTLE_STEMS = {k: v["основа"] for k, v in np_["список"].items() if v.get("основа")}
    EC.ORDER_BEFORE_1750 = list(np_["порядок_до_1750"])
    EC.ORDER_FROM_1750 = list(np_["порядок_с_1750"])
    RP.REVISIONS = {int(k): v for k, v in SPR["ревизии"].items() if k.isdigit()}
    FX.LIMITS.update({k: v for k, v in SPR.get("проверки", {}).items() if not k.startswith("_")})
    import ya_out
    for k, v in SPR.get("цвета", {}).items():
        if not k.startswith("_"):
            ya_out.COLORS[k] = v
    exc = {k: v for k, v in SPR.get("отчества", {}).items() if not k.startswith("_")}
    base = getattr(RP, "_patronymic_rule", RP.patronymic)
    RP._patronymic_rule = base

    def patronymic(father, female):                      # исключения справочника, иначе общее правило
        f = nk(father)
        if f in exc:
            b = exc[f] + ("а" if female else "")
            return b[:1].upper() + b[1:]
        return base(father, female)
    RP.patronymic = patronymic
    return src


def fill_settlements(rows):
    """«не определён (начало диапазона)» → название следующего определённого НП документа (иначе предыдущего)"""
    und = lambda p: str(p["settlement"]).startswith("не определён")  # noqa: E731
    i = 0
    while i < len(rows):
        if not und(rows[i]) or "settlement" in rows[i]["locked"]:
            i += 1
            continue
        j = i
        while j < len(rows) and und(rows[j]):
            j += 1
        name, how = (rows[j]["settlement"], "следующего") if j < len(rows) else (None, "")
        if name is None:
            k = i - 1
            while k >= 0 and und(rows[k]):
                k -= 1
            name, how = (rows[k]["settlement"], "предыдущего") if k >= 0 else (None, "")
        if name:
            for k in range(i, j):
                rows[k]["settlement"] = name
                rows[k]["flags"].append(f"ⓘ НП взят из {how} определённого («{name}»)")
        i = j


def arrange_settlements(rows):
    """повторный НП в документе одного года — сразу после первичного (по первым упоминаниям, порядок внутри сохраняется)"""
    first, seg, start_page = {}, [], {}
    for i, p in enumerate(rows):
        first.setdefault(p["settlement"], i)
        seg.append(seg[-1] + 1 if seg and rows[i - 1]["settlement"] != p["settlement"] else (seg[-1] if seg else 0))
        start_page.setdefault(seg[-1], p["page"])
    order = sorted(range(len(rows)), key=lambda i: (first[rows[i]["settlement"]], i))
    for i in order:
        f = first[rows[i]["settlement"]]
        if seg[i] != seg[f] and (i == 0 or seg[i] != seg[i - 1]):
            rows[i]["flags"].append(f"ⓘ повторный НП «{rows[i]['settlement']}» перенесён к первичному (было со стр. {start_page[seg[i]]})")
    return [rows[i] for i in order]


def canon_place(name):
    """«д. Черепкова» → «деревня Черепкова» (синонимы справочника; иначе с./д. раскрываются)"""
    if not name:
        return name
    syn = SPR.get("населённые_пункты", {}).get("синонимы", {})
    if name in syn:
        return syn[name]
    m = re.match(r"^(с|д|сц|сл)\.\s+(.+)$", name)
    if m:
        full = {"с": "село", "д": "деревня", "сц": "сельцо", "сл": "слобода"}[m.group(1)] + " " + m.group(2)
        return syn.get(full, full)
    return name


# =============================================================================== 1. пакеты
def find_packages(roots):
    seen, out = set(), []
    for root in roots:
        root = Path(root)
        if not root.is_dir():
            continue
        for f in root.rglob("*_next_data.json"):
            if OUT_DIR in f.relative_to(root).parts:
                continue
            c = f.parent.resolve()
            if c not in seen:
                seen.add(c)
                out.append(c)
    return sorted(out, key=lambda p: (p.name, str(p)))     # имя пакета = дата_время запуска


def package_state(pkg, settle, take_all=False):
    """ready / waiting. take_all — разовый запуск вручную: берутся все пакеты, даже незаконченные"""
    files = [f for f in pkg.iterdir() if f.is_file()]
    sig = sorted((f.name, f.stat().st_size) for f in files if f.name.endswith(".json"))
    newest = max((f.stat().st_mtime for f in files), default=0)
    quiet = time.time() - newest
    if take_all:
        return "ready", sig
    if (pkg / "run_summary.json").exists() and quiet >= settle:
        return "ready", sig
    if not (pkg / "run_summary.json").exists() and quiet >= 3600:       # пакет до версии 2.2.0 или оборванный
        return "ready", sig
    return "waiting", sig


# =============================================================================== 2. страницы
class Page:
    __slots__ = ("year", "file_id", "page", "url", "mode", "node", "crumbs", "src", "pkg", "kind_text", "kind",
                 "doc", "flags", "ci", "scan_path", "people", "error")

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))
        self.flags = list(self.flags or [])
        self.people = []


FNAME_RE = re.compile(r"^(\d{4}|год)_([0-9a-zA-Z-]{1,36})_p(\d+)_next_data\.json$")


def load_package(pkg):
    summ = {}
    try:
        summ = json.loads((pkg / "run_summary.json").read_text(encoding="utf-8"))
    except Exception:
        pass
    info = {(str(p.get("fileId", ""))[:8], int(p.get("page") or 0)): p for p in summ.get("pages") or []}
    pages = []
    for f in sorted(pkg.glob("*_next_data.json")):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception as e:
            log(f"  {f.name}: не читается ({e}) — пропущен")
            continue
        pp = d.get("props", {}).get("pageProps", d)
        node = pp.get("currentNode") or pp
        m = FNAME_RE.match(f.name)
        page = pp.get("docNumber") if pp.get("docNumber") is not None else (int(m.group(3)) if m else None)
        page = int(page) if page is not None else None
        tag = str(pp.get("fileId") or (m.group(2) if m else ""))[:8]
        it = info.get((tag, page), {})
        year = pp.get("year") or it.get("year") or (int(m.group(1)) if m and m.group(1).isdigit() else None)
        flags = []
        jb, tb = node.get("joinedTextBlocks") or [], node.get("textBlocks") or []
        if not jb or len(jb) != len(tb):
            flags.append(f"данные страницы неполные (с координатами {len(jb)}, с текстом {len(tb)})")
        pages.append(Page(year=int(year) if year else None, file_id=str(pp.get("fileId") or it.get("fileId") or tag),
                          page=page, url=pp.get("url") or it.get("url") or "", mode=pp.get("mode") or summ.get("mode") or "",
                          node=node, crumbs=node.get("crumbs") or [], src=f, pkg=pkg, flags=flags))
    failed = [p for p in summ.get("pages") or [] if p.get("error")]
    # запрошенные диапазоны (ссылки запуска): по ним навык «Исправление ошибок» найдёт незагруженные страницы
    requested = []
    from urllib.parse import urlparse, parse_qs
    for row in summ.get("links") or []:
        try:
            year, url = row[0], row[1]
            q = parse_qs(urlparse(url).query)
            fid, a, b = q.get("fileId", [""])[0], q.get("sheet_page_from", [""])[0], q.get("sheet_page_to", [""])[0]
            if fid and a.isdigit():
                requested.append((year, fid, int(a), int(b) if b.isdigit() else int(a)))
        except Exception:
            continue
    return pages, summ, failed, requested


def merge_pages(pkg_pages):
    best, dups = OrderedDict(), 0
    for _pkg, pages in pkg_pages:                    # пакеты по возрастанию времени: новее заменяет старое
        for p in pages:
            key = (p.file_id[:8], p.page, p.year)
            dups += key in best
            best[key] = p
    return list(best.values()), dups


# =============================================================================== 4. тип страницы, документы
REV_RX = re.compile(r"(ревиз|сказк|выбыл|нынe|ныне|отлучк|прошлой|по последней)")
CONF_RX = re.compile(r"(исповед|причаст|показан|не были|дворов|мужеска|женска)")


def page_kind_by_text(node):
    t = " ".join((b.get("text") or "") for b in node.get("textBlocks") or []).lower()
    t = t.replace("ѣ", "е").replace("і", "и")
    r, c = len(set(REV_RX.findall(t))), len(set(CONF_RX.findall(t)))
    if r >= 2 and r > c:
        return KIND_REV
    if c >= 2 and c > r:
        return KIND_CONF
    return None


def group_documents(pages):
    docs = OrderedDict()
    for p in sorted(pages, key=lambda p: (p.year or 0, p.file_id, p.page if p.page is not None else -1)):
        p.kind_text = page_kind_by_text(p.node)
        docs.setdefault((p.year, p.file_id[:8]), []).append(p)
    out = []
    for (year, fid), pp in docs.items():
        votes = Counter(p.kind_text for p in pp if p.kind_text)
        modes = Counter(p.mode for p in pp if p.mode in (KIND_CONF, KIND_REV))
        if votes:
            kind, n = votes.most_common(1)[0]
            how = f"по тексту страниц ({n} из {len(pp)})"
        elif modes:
            kind, how = modes.most_common(1)[0][0], "по типу запуска расширения"
        else:
            kind, how = KIND_CONF, "не определён — обработан как исповедная ведомость"
        doc = {"year": year, "file_id": pp[0].file_id, "kind": kind, "kind_how": how, "pages": pp,
               "id": f"{year or 'год'}-{fid}", "failed": []}
        for p in pp:
            p.kind, p.doc = kind, doc
            if p.kind_text and p.kind_text != kind:
                p.flags.append(f"по тексту страница похожа на «{KIND_RU[p.kind_text]}», а документ — «{KIND_RU[kind]}»")
            if p.mode in (KIND_CONF, KIND_REV) and p.mode != kind:
                p.flags.append(f"в расширении выбран тип «{KIND_RU[p.mode]}», по тексту — «{KIND_RU[kind]}»")
        nums = [p.page for p in pp if p.page is not None]
        doc["gaps"] = sorted(set(range(min(nums), max(nums) + 1)) - set(nums)) if nums else []
        out.append(doc)
    return out


# =============================================================================== 12. сканы (= crumbInfo расширения)
def _clean(v):
    v = re.sub(r'[<>:"/\\|?*\x00-\x1F]', "", str(v))
    return re.sub(r"_+", "_", re.sub(r"\s+", "_", v)).strip("_")


def crumb_info(crumbs, page, node_id, origin="https://ya.ru"):
    find = lambda t: next((c for c in crumbs or [] if c.get("type") == t), None)  # noqa: E731
    arch, fund, inv, file = find("Archive"), find("Fund"), find("Inventory"), find("File")

    def num(c):
        m = re.search(r"\d+[а-яА-Яa-zA-Z]?", str((c or {}).get("code") or ""))
        return m.group(0) if m else ""
    parts = [arch.get("name") or arch.get("code")] if arch else []      # «ЦГА Москвы/Фонд 203/…/Скан 865» — текст
    parts += [f"Фонд {fund.get('code') or ''}"] if fund else []
    parts += [f"Опись {num(inv)}"] if inv else []
    parts += [f"Дело {file.get('code') or ''}"] if file else []
    parts += [f"Скан {page}"] if page is not None else []
    cga_url = f"{origin}/archive/catalog/{file['id']}" if file else (f"{origin}/archive/catalog/{arch['id']}" if arch else "")
    codes = [c for c in (str(fund.get("code")).strip() if fund and fund.get("code") else "", num(inv),
                         str(file.get("code")).strip() if file and file.get("code") else "") if c]
    padded = str(page).zfill(4)
    if len(codes) >= 2:
        name = (_clean(arch["name"]) + "_[ЯА]_" if arch and arch.get("name") else "") + _clean("-".join(codes) + "-" + padded) + ".jpg"
    else:
        name = "YA_archive_" + _clean(node_id or "") + "_" + padded + ".jpg"
    src = ", ".join(x for x in ((arch or {}).get("name") or "", f"ф. {fund.get('code')}" if fund else "",
                                 f"оп. {num(inv)}" if inv else "", f"д. {file.get('code')}" if file else "") if x)
    return {"cga": "/".join(parts) if crumbs else "", "cga_url": cga_url, "scan_name": name, "source": src,
            "file_title": (file or {}).get("name") or ""}


def scan_index(roots, extra, names=None):
    if names is not None:            # расширение Chrome: имена файлов сканов уже перечислены, значение — путь для ссылки в Excel
        return {k: PurePosixPath(v) for k, v in names.items()}
    dirs = [Path(d) for d in extra or []] + [Path(DEFAULT_SCANS)]     # как в расширении 2.7.0+: /Volumes/DATA/Archive_Scans
    for root in roots:
        base = Path(root)
        for d in [base] + list(base.parents)[:2]:
            if (d / SCAN_DIR).is_dir():
                dirs.append(d / SCAN_DIR)
        for depth in ("*", "*/*", "*/*/*"):
            dirs += [p for p in base.glob(f"{depth}/{SCAN_DIR}") if p.is_dir()]
    idx = {}
    for d in dirs:
        for f in d.glob("*.jpg"):
            idx.setdefault(f.name, f.resolve())
    return idx


# =============================================================================== 5. разбор
CONF_FLAG_RU = [
    (r"^half(\d+):(.*)$", lambda m: f"лист {m.group(1)}: " + conf_flag(m.group(2))),
    (r"^seq_breaks_([MF])=(\d+)/(\d+)", lambda m: f"номера {'мужчин' if m.group(1) == 'M' else 'женщин'} не подряд "
                                                  f"в {m.group(2)} местах из {m.group(3)}"),
    (r"^age_columns_(\d)", lambda m: f"найдено столбцов возраста: {m.group(1)} из 2"),
    (r"^yard_column_not_found$", lambda m: "столбец № двора не найден"),
    (r"^left_columns_2_sex_unknown$", lambda m: "слева 2 столбца из 3 — пол по номеру не определён"),
    (r"^orphans:(\d+)", lambda m: f"номеров двора без строки: {m.group(1)}"),
    (r"^age_without_number$", lambda m: "возраст без номера человека"),
    (r"^(nested_block|block_edge|y_near|no_main_block)$", lambda m: "привязка к тексту неоднозначна"),
    (r"^split_cell$", lambda m: "два номера в одной ячейке разделены по высоте"),
    (r"^split:(.*)$", lambda m: m.group(1)),
    (r"^count_mismatch.*", lambda m: "данные страницы неполные"),
    (r"^no_fixed:(.*)$", lambda m: f"ⓘ номер исправлен по соседям (распознано «{m.group(1)}»)"),
    (r"^joined_cell:(.*)$", lambda m: f"ⓘ номер собран из двух ячеек (распознано «{m.group(1)}»)"),
    (r"^no_restored$", lambda m: "ⓘ номер восстановлен по соседям (не распознан)"),
    (r"^extra_number:?(.*)$", lambda m: f"лишнее число в столбце номеров {m.group(1)}".strip()),
    (r"^two_yard_numbers$", lambda m: "два номера двора у одной строки"),
    (r"^no_numbers$", lambda m: "столбцы номеров не найдены"),
    (r"^age_zone_wide$", lambda m: "столбцы возраста дальше обычного от списка"),
]
# пояснения (что сделал алгоритм) — не ошибки: в «Примечание», не в «Проверить»
INFO_RX = re.compile(r"^(ⓘ|отчество образовано|номер семьи взят|НП по порядку|НП определён по порядку|НП взят|повторный НП)")


def conf_flag(f):
    for rx, fn in CONF_FLAG_RU:
        m = re.match(rx, f)
        if m:
            return fn(m)
    return f


def new_person(**kw):
    p = dict(doc="", kind="", year=None, page=None, url="", id="", key="", settlement="", estate="", yard="",
             yard_calc=False, raw="", block_text="", block="", sex="", no="", age="", age_prev="", birth="",
             status="", note="", dep_reason="", dep_year="", first="", patr="", surname="", fio="", rel="",
             relation="", ref_id="", flags=[], fixed=[], locked=set())
    p.update(kw)
    p["flags"], p["fixed"], p["locked"] = list(p["flags"]), list(p["fixed"]), set(p["locked"])
    return p


def process_confession(doc):
    year = doc["year"]
    reps, keep = [], []
    for p in doc["pages"]:
        if p.flags and p.flags[0].startswith("данные страницы неполные"):
            continue
        try:
            rep = EC.process(p.node, SimpleNamespace(**dict(CONF_ARGS, year=year)))
        except Exception as e:
            p.flags.append(f"ошибка разбора: {type(e).__name__}: {e}")
            continue
        if any(f.startswith("count_mismatch") for f in rep.get("flags", [])):
            p.flags.append("данные страницы неполные — пропущена")
            continue
        if rep.get("persons"):
            p.flags += [conf_flag(f) for f in rep.get("flags", [])]
        else:
            p.flags.append("таблица людей не найдена (" + ", ".join(conf_flag(f) for f in rep.get("flags", [])) + ")")
        rep["page"] = p.page
        reps.append(rep)
        keep.append(p)
    EC.assign_running(reps, year)
    out = []
    for p, rep in zip(keep, reps):
        seen = Counter()
        for k, (r, pr) in enumerate(zip(EC.csv_rows(rep, year), rep.get("persons", []))):
            sk = f"{r['sex']}{r['no'] or 'x'}"
            seen[sk] += 1
            person = new_person(
                doc=doc["id"], kind=KIND_CONF, year=year, page=p.page, url=p.url, id=f"{doc['id']}-p{p.page}-{k + 1}",
                key=f"{doc['id']}|p{p.page}|{sk}|{seen[sk]}", settlement=r["settlement"], yard=r["yard"],
                raw=(r["person_text"] or "").strip(), block_text=r["names_text"], block=f"p{p.page}-{r['block_id']}",
                sex=r["sex"], no=r["no"], age=r["age"], flags=[conf_flag(f) for f in pr.get("flags", []) if f])
            out.append(person)
            p.people.append(person)
    return out


def process_revision(doc):
    reps, by_page = [], {}
    for p in doc["pages"]:
        if p.flags and p.flags[0].startswith("данные страницы неполные"):
            continue
        try:
            rep = ER.process(p.node, RP.default_args())
        except Exception as e:
            p.flags.append(f"ошибка разбора: {type(e).__name__}: {e}")
            continue
        rep["page"] = p.page
        by_page[p.page] = p
        if not rep.get("blocks"):
            p.flags.append("таблица людей не найдена")
        reps.append(rep)
    people, _blocks, pages_out, year = RP.build(reps, SimpleNamespace(places="", year=doc["year"], url="", source=""))
    RP.family_surnames(people)
    doc["year"] = doc["year"] or year
    out = []
    for q in people:
        p = by_page.get(q["page"])
        person = new_person(
            doc=doc["id"], kind=KIND_REV, year=doc["year"], page=q["page"], url=p.url if p else "",
            id=f"{doc['id']}-{q['id']}", key=f"{doc['id']}|{q['id']}", settlement=q["place"], estate=q.get("estate", ""),
            yard=q["family"] if q["family"] is not None else "", raw=q["raw"], block_text=q["block_text"],
            block=f"p{q['page']}-{q['id'].split('-')[1] if '-' in q['id'] else ''}", sex=q["sex"],
            age=q["age_now"], age_prev=q["age_prev"], birth=q["birth"] if q["birth"] is not None else "",
            status=q["status"], note=q["note"], dep_reason=q.get("reason", ""), dep_year=q.get("dep_year", ""),
            first=q["first"], patr=q["patr"], surname=q["surname"] or q.get("fam_surname", ""), rel=q["rel"],
            relation=q["relation"], ref_id=f"{doc['id']}-{q['ref_id']}" if q["ref_id"] else "",
            flags=[RP.human(f) for f in q["flags"] if RP.human(f)])
        out.append(person)
        if p:
            p.people.append(person)
    for pg in pages_out:
        p = by_page.get(pg["page"])
        if p:
            p.flags += [RP.human(f) for f in pg.get("flags") or [] if RP.human(f)]
    return out


# =============================================================================== 9. родство (исповедные ведомости)
def age_num(v):
    if v in (None, ""):
        return None
    s = str(v).replace("?", "").replace("½", " 1/2").replace("¼", " 1/4").replace("¾", " 3/4").strip()
    if "новорожд" in s:
        return 0.0
    m = re.match(r"^(\d{1,3})?\s*(?:(\d)\s*/\s*(\d))?", s)
    if not m or (m.group(1) is None and m.group(2) is None):
        return None
    val = float(m.group(1) or 0)
    if m.group(2):
        val += int(m.group(2)) / max(1, int(m.group(3)))
    if "мес" in s:
        val = val / 12.0
    return val


def name_parts(p):
    """разбор текста человека: ссылка + родство + имя + отчество/фамилия. Имя — первое слово из справочника имён
    после слов родства («вдова У ней дѣти Василей» → родство «сын», имя Василей), иначе — как в revision_people"""
    female = p["sex"] == "ж"
    ps = RP.parse_segment(p["raw"], female)
    toks = [t for t in (p["raw"] or "").split() if re.search(r"\w", t)]
    names_at = [i for i, t in enumerate(toks) if SN.name_sex(t) and nk(t) not in SN.RELATION and len(nk(t)) >= 3]
    rel_at = [i for i, t in enumerate(toks) if nk(t) in SN.RELATION or nk(t) in RP.REL_NORM]
    if names_at and nk(ps["name"] or "") != nk(toks[names_at[0]]):
        after = [i for i in names_at if not rel_at or i > rel_at[0]] or names_at
        i = after[0]
        if not SN.name_sex(ps["name"] or "") or (rel_at and i > rel_at[-1] > 0):
            before = [j for j in rel_at if j < i]
            if before:
                ps["rel"] = RP.rel_word(toks[before[-1]], female)
            ps["name"], ps["rest"] = toks[i], toks[i + 1:]
    first = RP.word(ps["name"])
    tail = []
    for t in ps["rest"]:                     # «… Иванова дѣти их» / «… мат его»: после слова родства — уже не этот человек
        if nk(t) in SN.RELATION or nk(t) in RP.REL_NORM:
            break
        tail.append(t)
    marks = tuple(SPR.get("приметы", {}).get("слова", []))
    rest, sign = [], []
    for w in (RP.word(t) for t in tail):
        if not w or nk(w) in RP.ORDINAL or nk(w) in SN.PRON:
            continue
        (sign if marks and nk(w).startswith(marks) else rest).append(w)
    if sign and p.get("note") is not None and "примета" not in p["note"]:
        p["note"] = "; ".join(x for x in (p["note"], "примета: " + " ".join(s.lower() for s in sign)) if x)
    return ps, first, rest


PATR_LIKE = re.compile(r"(ов|ев|ин|ын|ова|ева|ина|ына|ович|евич|овна|евна|ич|ична)$")


def patr_of(rest):
    """своё отчество из текста («Гарасимов», «Никитина») или ''"""
    return rest[0] if rest and PATR_LIKE.search(nk(rest[0])) else ""


def patr_fits(patr, father):
    """«Гарасимов» подходит к отцу «Герасим»? (по основе, с ошибками распознавания в 1 букву)"""
    if not patr or not father or not father.get("first"):
        return None
    a, b = nk(patr)[:5], nk(RP.patronymic(father["first"], False))[:5]
    return a == b or (len(a) == len(b) == 5 and sum(x != y for x, y in zip(a, b)) <= 1)


def father_by_patr(patr, members):
    for m in reversed(members):
        if m["sex"] == "м" and patr_fits(patr, m):
            return m
    return None


def relate_confession(rows):
    """глава, жена его, дети их (+ продолжение списка детей), брат/сестра, вдова — внутри двора, по порядку"""
    yards = []                     # подряд идущие строки одного двора (двор с тем же номером дальше — другая семья)
    for p in rows:
        k = (p["doc"], p["settlement"], p["yard"])
        if yards and yards[-1][0] == k:
            yards[-1][1].append(p)
        else:
            yards.append((k, [p]))
    for _k, mem_all in yards:
        members, last, last_man = [], {"rel": "", "ref": None, "ref_words": ""}, None
        for p in mem_all:
            female = p["sex"] == "ж"
            ps, first, rest = name_parts(p)
            if "first" not in p["locked"]:
                p["first"] = first
            rel, ref, ref_words = ps["rel"], None, ""
            if rel:
                if ps["ref"]:
                    ref = RP.find_ref(ps["ref"], members)
                    ref_words = " ".join(RP.word(t) for t in ps["ref"])
                elif rel == "жена":
                    ref = last_man
                elif rel in RP.CHILD:
                    ref = last["ref"] if last["rel"] in ("жена", *RP.CHILD) and last["ref"] else (last_man or (members[0] if members else None))
                else:
                    ref = last["ref"] or (members[0] if members else None)
                last.update(rel=rel, ref=ref, ref_words=ref_words)
            elif p["first"] and last["rel"] in RP.CHILD:          # «дети их Петръ, Анна» — продолжение списка
                rel, ref, ref_words = ("дочь" if female else "сын"), last["ref"], last["ref_words"]
                own = patr_of(rest)
                if own and ref is not None and patr_fits(own, ref) is False:
                    alt = father_by_patr(own, members)          # «Иван Гарасимов» — не сын Сергея: отец Герасим или он не ребёнок
                    if alt is not None:
                        ref, ref_words = alt, ""
                        p["flags"].append("ⓘ отец определён по отчеству")
                    else:
                        rel, ref, ref_words = "", None, ""
                        last.update(rel="", ref=None, ref_words="")
            if rel in RP.CHILD and ps["rel"] and not ps["ref"]:
                own = patr_of(rest)                              # «сын его Никита Иванов»: отец — тот, чьё имя даёт отчество
                if own and ref is not None and patr_fits(own, ref) is False:
                    alt = father_by_patr(own, members)
                    if alt is not None:
                        ref = alt
                        p["flags"].append("ⓘ отец определён по отчеству")
            if not rel and p["first"]:
                widow = female and re.search(r"вдов", RP.modern(p["raw"]).lower())
                rel = ("вдова, глава" if widow else "глава") if not members else ("вдова" if widow else "?")
                if rel == "?":
                    p["flags"].append("родство не определено")
            if rel == "жена" and ref is not None and ref.get("sex") != "м":
                ref = None
            patr = rest[0] if rest else ""
            if not patr and rel in ("сын", "дочь") and ref is not None and ref.get("sex") == "м" and ref.get("first"):
                patr = RP.patronymic(ref["first"], female)
                p["flags"].append("отчество образовано от имени отца")
            if "patr" not in p["locked"]:
                p["patr"] = patr
            if "surname" not in p["locked"]:
                p["surname"] = " ".join(rest[1:]) if len(rest) > 1 else ""
            if "rel" not in p["locked"]:
                p["rel"] = rel
            if "ref_id" not in p["locked"]:
                p["ref_id"] = ref["id"] if ref is not None else ""
            if "relation" not in p["locked"]:
                who = ref_words or (" ".join(x for x in (ref.get("first"), ref.get("patr")) if x) if ref else "")
                p["relation"] = " ".join(x for x in (p["rel"], who) if x) if p["rel"] not in ("глава", "?", "вдова", "вдова, глава") else p["rel"]
            if p["sex"] == "м" and p["first"]:
                last_man = p
            members.append(p)
        # мужчина без слова родства, за которым «жена его», — глава отдельной семьи во дворе
        for i, p in enumerate(mem_all):
            if p["rel"] == "?" and p["sex"] == "м" and "rel" not in p["locked"] and any(
                    q["rel"] == "жена" and q["ref_id"] == p["id"] for q in mem_all[i + 1:i + 3]):
                p["rel"] = p["relation"] = "глава семьи"
                p["flags"] = [f for f in p["flags"] if f != "родство не определено"]
                p["flags"].append("ⓘ глава отдельной семьи во дворе (родство с главой двора не указано)")


def finalize_names(people):
    for p in people:
        if not p["first"] and "first" not in p["locked"]:
            p["first"] = name_parts(p)[1] if p["raw"] else ""
        p["fio"] = " ".join(x for x in (p["first"], p["patr"], p["surname"]) if x)


# =============================================================================== 11. год рождения
def compute_birth(p):
    if "birth" in p["locked"]:
        return
    y = p["year"]
    a = age_num(p["age"])
    if p["kind"] == KIND_CONF:
        p["birth"] = int(y - math.floor(a)) if (y and a is not None) else ""
        return
    if not ({"age", "age_prev"} & p["locked"]):           # без исправлений — как посчитал revision_people
        return
    if a is not None and y:
        p["birth"] = int(round(y - a))
        return
    prev_year = RP.REVISIONS.get(max((k for k, v in RP.REVISIONS.items() if y and v < y), default=0))
    ap = age_num(p["age_prev"])
    if "новорожд" in str(p["age_prev"]) and prev_year:
        p["birth"] = f"после {prev_year}"
    elif ap is not None and prev_year:
        p["birth"] = int(round(prev_year - ap))
    else:
        p["birth"] = ""


# =============================================================================== 13. проверка
def check_people(people):
    lim = FX.LIMITS
    for p in people:
        b, y = p["birth"], p["year"]
        if isinstance(b, (int, float)) and y and not (y - lim["макс_возраст"] <= b <= y):
            p["flags"].append(f"год рождения {b} неправдоподобен для {y} г.")
        if p["kind"] == KIND_CONF and p["no"] in ("", None):
            p["flags"].append("нет номера человека")
        if p["age"] in ("", None) and not (p["kind"] == KIND_REV and p["status"] == "выбыл"):
            p["flags"].append("нет возраста")
        if not p["first"] and not any("не найдено" in f for f in p["flags"]):
            p["flags"].append("имя не прочитано")
        fl = list(OrderedDict.fromkeys(f for f in p["flags"] if f))
        info = [f.lstrip("ⓘ ").strip() for f in fl if INFO_RX.match(f)]
        p["flags"] = [f for f in fl if not INFO_RX.match(f)]
        p["note"] = "; ".join(x for x in [p["note"]] + info if x)


# =============================================================================== конвейер
def build(roots, out_dir, opts):
    """этапы 1–14; -> контекст с людьми, документами, страницами и предложениями"""
    pkgs_all = find_packages(roots)
    ready, waiting, sigs = [], [], {}
    for pkg in pkgs_all:
        st, sig = package_state(pkg, opts.settle, take_all=not getattr(opts, "watching", False))
        (ready if st == "ready" else waiting).append(pkg)
        sigs[str(pkg)] = sig
    loaded, failed, requested = [], [], []
    for pkg in ready:
        pages, summ, fl, req = load_package(pkg)
        loaded.append((pkg, pages))
        failed += [dict(f, pkg=str(pkg)) for f in fl]
        requested += req
        if summ and summ.get("complete") is False:
            log(f"  пакет {pkg.name}: запуск был остановлен до конца диапазона")
    pages, dups = merge_pages(loaded)
    docs = group_documents(pages)
    corr = FX.Corrections(out_dir)
    sidx = scan_index(roots, opts.scans, getattr(opts, "scan_names", None))
    people = []
    for d in docs:
        rows = process_confession(d) if d["kind"] == KIND_CONF else process_revision(d)
        for p in rows:
            p["settlement"] = canon_place(p["settlement"])
        fill_settlements(rows)                                       # 6а: «не определён» → следующий определённый
        corr.apply(rows, stage=1)                                   # 7: базовые значения
        rows = arrange_settlements(rows)                             # 7а: повторный НП — к первичному
        if d["kind"] == KIND_CONF:
            for person, (yard, calc) in zip(rows, EC.fill_yards(rows)):   # 8: пустой двор
                if calc and "yard" not in person["locked"]:
                    person["yard"], person["yard_calc"] = yard, True
            relate_confession(rows)                                  # 9: родство
        finalize_names(rows)
        corr.apply(rows, stage=2)                                   # 10: родство, год рождения
        for p in rows:
            compute_birth(p)                                         # 11
        for pg in d["pages"]:                                        # 12: сканы
            pg.ci = crumb_info(pg.crumbs, pg.page, (pg.node or {}).get("id"))
            pg.scan_path = sidx.get(pg.ci["scan_name"])
            if not d.get("ci") or (pg.ci["source"] and not d["ci"]["source"]):
                d["ci"] = pg.ci
        d["failed"] = [f for f in failed if str(f.get("fileId", ""))[:8] == str(d["file_id"])[:8] and f.get("year") == d["year"]]
        d["requested"] = sorted({n for (y, fid, a, b) in requested if str(fid)[:8] == str(d["file_id"])[:8]
                                 and (y == d["year"] or not y) for n in range(a, b + 1)})
        if len(str(d["file_id"])) < 30:                                  # полный ID дела — из ссылок запуска
            d["file_id"] = next((fid for (y, fid, a, b) in requested if str(fid)[:8] == str(d["file_id"])[:8]), d["file_id"])
        people += rows
    check_people(people)                                             # 13
    ctx = SimpleNamespace(roots=roots, out_dir=out_dir, docs=docs, pages=pages, people=people, corr=corr,
                          packages=ready, waiting=waiting, sigs=sigs, dups=dups, failed=failed, opts=opts)
    ctx.proposals = FX.analyze(ctx)                                  # 14: навык «Исправление ошибок»
    return ctx


# =============================================================================== 15. итог
def rel_link(target, base_dir):
    if isinstance(target, PurePosixPath) and target.is_absolute():      # путь скана, как его видит пользователь: file:///Volumes/…
        return target.as_uri()
    try:
        return os.path.relpath(target, base_dir).replace("\\", "/")
    except ValueError:                  # другой диск в Windows
        return Path(target).as_uri()


def write_outputs(ctx):
    import ya_out
    od = ctx.out_dir
    od.mkdir(parents=True, exist_ok=True)
    res = ya_out.write_all(ctx, od, KIND_RU, rel_link, VERSION)
    return res


def run_once(roots, out_dir, opts, interactive, feedback=True):
    t0 = time.time()
    if feedback:
        fb = check_excel_decisions(out_dir)
        if fb:
            log(f"Из Excel: {fb}.")
    while True:
        ctx = build(roots, out_dir, opts)
        if not ctx.pages:
            log("Пакетов с данными страниц пока нет" + (f" (идёт запись: {len(ctx.waiting)})" if ctx.waiting else "") + ".")
            return ctx
        res = write_outputs(ctx)
        n_doc, n_p = len(ctx.docs), len(ctx.people)
        log(f"Итог: документов {n_doc}, страниц {len(ctx.pages)}, людей {n_p}, семей в GEDCOM {res.get('fams', 0)}, "
            f"предложений исправлений {len(ctx.proposals)} — «{out_dir}» ({time.time() - t0:.0f} с)")
        if res.get("locked"):
            log(f"  {XLSX} открыт в Excel — записан «{res['xlsx'].name}». Закройте Excel, чтобы обновлять основной файл.")
        if not (interactive and ctx.proposals):
            return ctx
        changed, later = FX.dialog(ctx, timeout=opts.dialog_timeout)
        if later:
            interactive = False                  # отложено — в этом прогоне больше не спрашиваем
        if not changed:
            return ctx
        log("Принятые исправления применены — пересчитываю итог…")
        t0 = time.time()


def check_excel_decisions(out_dir):
    """решения из листа «Исправления» и ручные правки в листе «Люди» (если файл сохранён после нашей записи)"""
    return FX.read_excel_feedback(out_dir)


# =============================================================================== слежение
class Lock:
    def __init__(self, out_dir):
        self.f = out_dir / ".yaarchive.lock"

    def acquire(self):
        self.f.parent.mkdir(parents=True, exist_ok=True)
        if self.f.exists() and time.time() - self.f.stat().st_mtime < 120:
            try:
                other = self.f.read_text()
            except Exception:
                other = ""
            if other != str(os.getpid()):
                return False
        self.touch()
        return True

    def touch(self):
        self.f.write_text(str(os.getpid()))

    def release(self):
        try:
            if self.f.read_text() == str(os.getpid()):
                self.f.unlink()
        except Exception:
            pass


def watch(roots, out_dir, opts):
    opts.watching = True
    lock = Lock(out_dir)
    if not lock.acquire():
        log(f"За папкой уже следит другой запуск yaarchive (файл {lock.f}). Закройте его окно или удалите файл.")
        return 1
    log(f"Слежу за папкой «{roots[0]}». Итог — «{out_dir}». Остановить: закрыть окно или Ctrl+C.")
    state_f = out_dir / ".yaarchive_state.json"
    try:
        state = json.loads(state_f.read_text(encoding="utf-8"))
    except Exception:
        state = {}
    told = set()
    interactive = sys.stdin is not None and sys.stdin.isatty() and not opts.no_dialog
    try:
        while True:
            lock.touch()
            try:
                pkgs = find_packages(roots)
                sigs, waiting = {}, []
                for pkg in pkgs:
                    st, sig = package_state(pkg, opts.settle)
                    if st == "ready":
                        sigs[str(pkg)] = sig
                    else:
                        waiting.append(pkg)
                for pkg in waiting:
                    if str(pkg) not in told:
                        told.add(str(pkg))
                        log(f"Новый пакет «{pkg.name}» — жду, пока расширение закончит запись…")
                fb = check_excel_decisions(out_dir)
                need = json.dumps(sigs, sort_keys=True) != json.dumps(state.get("sigs"), sort_keys=True)
                if fb:
                    log(f"В Excel найдены ваши решения/правки: {fb}. Применяю.")
                if need or fb or opts.force:
                    opts.force = False
                    if need:
                        log(f"Обрабатываю: пакетов {len(sigs)}" + (f", ждут записи {len(waiting)}" if waiting else ""))
                    ctx = run_once(roots, out_dir, opts, interactive, feedback=False)
                    state = {"sigs": sigs, "time": time.time(), "version": VERSION}
                    state_f.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
                    if ctx.proposals:
                        log(f"Ждут решения {len(ctx.proposals)} исправлений: лист «Исправления» в {XLSX} "
                            f"(«да»/«нет» в столбце «Применить?», затем сохраните файл).")
            except Exception as e:
                log(f"ОШИБКА: {e}\n{traceback.format_exc()}")
            time.sleep(opts.interval)
    except KeyboardInterrupt:
        log("Остановлено.")
    finally:
        lock.release()
    return 0


# =============================================================================== расширение Chrome (встроенный движок)
_CTX = None


def engine_run(root, scan_names_json="null", scans_public=DEFAULT_SCANS, sink=None):
    """Итоговая обработка внутри расширения Chrome (Pyodide): root — папка результата с «yaarchive_debug/», итог — «Итог/» в ней.
    scan_names_json — {имя файла скана: путь для ссылки}; sink — приёмник строк журнала. -> JSON: счётчики, файлы, предложения исправлений"""
    global _CTX
    Log.sink, Log.fh = sink, None
    roots = [Path(root)]
    out_dir = roots[0] / OUT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    names = json.loads(scan_names_json)
    log(f"yaarchive {VERSION} (встроен в расширение). Справочники: {load_spravochniki(roots)}")
    opts = SimpleNamespace(settle=0, scans=[], watching=False, dialog_timeout=0, force=True, no_dialog=True, interval=0, scan_names=names)
    t0 = time.time()
    fb = check_excel_decisions(out_dir)
    if fb:
        log(f"Из Excel: {fb}.")
    ctx = build(roots, out_dir, opts)
    if not ctx.pages:
        _CTX = None
        log("Пакетов с данными страниц нет: сначала выполните обработку (исповедные ведомости или ревизские сказки) в этой папке результата.")
        return json.dumps({"pages": 0, "people": 0, "docs": 0, "proposals": [], "files": []}, ensure_ascii=False)
    res = write_outputs(ctx)
    _CTX = ctx
    log(f"Итог: документов {len(ctx.docs)}, страниц {len(ctx.pages)}, людей {len(ctx.people)}, семей в GEDCOM {res.get('fams', 0)}, "
        f"предложений исправлений {len(ctx.proposals)} — «{OUT_DIR}/» ({time.time() - t0:.0f} с)")
    if res.get("locked"):
        log(f"  {XLSX} открыт в Excel — записан «{res['xlsx'].name}». Закройте Excel, чтобы обновлять основной файл.")
    props = [{k: pr.get(k) for k in ("id", "type", "where", "now", "new", "reason", "url", "changes")} for pr in ctx.proposals]
    return json.dumps({"pages": len(ctx.pages), "people": len(ctx.people), "docs": len(ctx.docs), "fams": res.get("fams", 0),
                       "proposals": props, "files": [Path(res["xlsx"]).name, GED, JSONF, REPORT], "packages": len(ctx.packages)},
                      ensure_ascii=False, default=str)


def engine_decide(decisions_json):
    """решения по предложениям навыка «Исправление ошибок»: [{id, decision: 'да'|'нет'}] -> применены; затем нужен новый engine_run"""
    ctx = _CTX
    if ctx is None:
        return json.dumps({"applied": 0})
    by_id = {pr["id"]: pr for pr in ctx.proposals}
    applied = 0
    man = FX.load_manual(ctx.out_dir)
    for d in json.loads(decisions_json):
        pr = by_id.get(d["id"])
        if not pr:
            continue
        ctx.corr.decide(pr, "да" if d["decision"] == "да" else "нет", "окно", roots=ctx.roots)
        applied += d["decision"] == "да"
        if pr["id"] in man:
            del man[pr["id"]]
    (Path(ctx.out_dir) / FX.MANUAL).write_text(json.dumps(man, ensure_ascii=False), encoding="utf-8")
    log(f"Решений получено: {len(json.loads(decisions_json))}, применено исправлений: {applied}.")
    return json.dumps({"applied": applied})


def main(argv=None):
    ap = argparse.ArgumentParser(prog="yaarchive", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folders", nargs="*", help="папка со ссылками/пакетами yaarchive_debug (по умолчанию — где лежит скрипт)")
    ap.add_argument("--watch", action="store_true", help="следить за папкой и обрабатывать новые пакеты")
    ap.add_argument("--once", action="store_true", help="обработать один раз и выйти (по умолчанию при указанной папке)")
    ap.add_argument("--out", default=None, help=f"папка итога (по умолчанию <папка>/{OUT_DIR})")
    ap.add_argument("--scans", action="append", default=[], help="дополнительная папка со сканами (можно несколько)")
    ap.add_argument("--settle", type=int, default=20, help="пакет готов, если файлы не менялись N секунд (20)")
    ap.add_argument("--interval", type=int, default=15, help="проверять папку каждые N секунд (15)")
    ap.add_argument("--no-dialog", action="store_true", help="не спрашивать в окне — только лист «Исправления»")
    ap.add_argument("--dialog-timeout", type=int, default=600, help="сколько ждать ответа в окне, с (600)")
    ap.add_argument("--force", action="store_true", help="пересчитать, даже если пакеты не изменились")
    ap.add_argument("--version", action="version", version=VERSION)
    opts = ap.parse_args(argv)
    double_click = not opts.folders and not opts.watch and not opts.once
    roots = [Path(f).expanduser().resolve() for f in opts.folders] or [Path(sys.argv[0]).resolve().parent]
    out_dir = Path(opts.out).expanduser().resolve() if opts.out else roots[0] / OUT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    Log.fh = open(out_dir / "yaarchive_журнал.txt", "a", encoding="utf-8")
    log(f"yaarchive {VERSION}. Справочники: {load_spravochniki(roots)}")
    if not ensure_openpyxl():
        return 2
    if opts.watch or double_click:
        code = watch(roots, out_dir, opts)
    else:
        interactive = sys.stdin is not None and sys.stdin.isatty() and not opts.no_dialog
        ctx = run_once(roots, out_dir, opts, interactive)
        code = 0 if ctx.pages else 1
    if double_click and sys.stdin is not None and sys.stdin.isatty():
        input("Нажмите Enter, чтобы закрыть окно…")
    return code


if __name__ == "__main__":
    sys.exit(main())
