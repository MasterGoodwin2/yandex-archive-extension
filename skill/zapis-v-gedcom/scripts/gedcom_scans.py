#!/usr/bin/env python3
"""
Запись в GEDCOM: вносит в .ged ссылки на сохранённые сканы страниц Яндекс Архива.

Берёт .ged (ссылки ya.ru/yandex.ru архива в его записях) и result_links.csv (UTF-8, «;»; подходит и прежний result_links.xlsx), который расширение
«Яндекс Архив — сбор людей округи» (тип «Скачать графические образы страниц из списка ссылок») сделало по этому же .ged.
Страницы сопоставляются по столбцу «Очищенная ссылка» (в прежних таблицах — по порядку строк).

Запуск:
  python gedcom_scans.py проект.ged result_links.csv --variant source|media [--out проект_со_сканами.ged] [--in-place]
Варианты:
  source — «Источник»: 0 @YA_S1@ SOUR (TITL документ и год, PUBL архив хранения, NOTE страница, OBJE с FILE/FORM/TITL)
           и у персоны «1 SOUR @YA_S1@ / 2 PAGE Скан N, ссылка».
  media  — «Общий медиа-объект»: 0 @YA_M1@ OBJE (FILE, FORM, TITL, NOTE) и у персоны «1 OBJE @YA_M1@».
--ranges — как отметка «Разворачивать диапазон…» в расширении (по умолчанию из ссылки поиска берётся одна страница).
--in-place пишет в сам .ged, перед этим рядом сохраняется <имя>_до_сканов.ged. Без него — копия <имя>_со_сканами.ged.
Прежние записи @YA_S…@ / @YA_M…@ перед записью убираются: повторный запуск дублей не даёт. Файл пишется в UTF-8 (в шапке CHAR UTF-8).
Результат совпадает с расширением (gedcom-writer.js).
"""
import argparse
import re
import sys
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from openpyxl import load_workbook

URL_RX = re.compile(r"https?://(?:[\w-]+\.)*(?:ya\.ru|yandex\.ru)(?![\w.-])[^\s\"'<>\\^`{}|]*", re.I)
ID_RX = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$", re.I)
OWN_RX = re.compile(r"^@YA_[SM]\d+@$")
MAX_RANGE = 500
HEAD_URL, HEAD_LOCAL, HEAD_CGA, HEAD_TYPE, HEAD_CLEAN = (
    "Ссылка на страницу", "Локальная Ссылка на страницу", "Архив хранения документа", "Тип документа", "Очищенная ссылка")


def decode(b):
    if b[:2] == b"\xff\xfe": return b[2:].decode("utf-16-le")
    if b[:2] == b"\xfe\xff": return b[2:].decode("utf-16-be")
    if len(b) >= 4 and b[0] == 0x30 and b[1] == 0 and b[2] != 0: return b.decode("utf-16-le")
    if len(b) >= 4 and b[0] == 0 and b[1] == 0x30: return b.decode("utf-16-be")
    if b[:3] == b"\xef\xbb\xbf": b = b[3:]
    try: return b.decode("utf-8")
    except UnicodeDecodeError: return b.decode("cp1251", "replace")


def clean_url(u):
    u = u.replace("&amp;", "&").replace("&#38;", "&")
    return re.sub(r"[)\].,;:!?»”…]+$", "", u)


def urls_in(value):
    """все ссылки архива из значения; слипшиеся («…/7;https://…/278;», «…/7https://…») делятся по началу следующей ссылки"""
    out = []
    for m in URL_RX.finditer(value):
        for piece in re.split(r"(?=https?://)", m[0], flags=re.I):
            mm = re.match(URL_RX.pattern, piece, re.I)
            if mm: out.append(clean_url(mm[0]))
    return out


def records(text):
    """[{xref, tag, name, lines:[{level,tag,value}]}]; CONC дописывает, CONT — с новой строки"""
    recs, rec, last = [], None, None
    for raw in re.split(r"\r\n|\n|\r", text.lstrip("﻿")):
        m = re.match(r"^\s*(\d+)\s+(?:(@[^@]+@)\s+)?([A-Za-z_0-9]+)(?:[ \t](.*))?$", raw)
        if not m:
            if last and raw.strip(): last["value"] += raw
            continue
        level, xref, tag, value = int(m[1]), m[2] or "", m[3].upper(), m[4] or ""
        if level == 0:
            rec = {"xref": xref, "tag": tag, "name": "", "lines": []}
            recs.append(rec); last = None
            if value: last = {"level": 0, "tag": tag, "value": value}; rec["lines"].append(last)
            continue
        if rec is None: continue
        if tag == "CONC" and last: last["value"] += value; continue
        if tag == "CONT" and last: last["value"] += "\n" + value; continue
        last = {"level": level, "tag": tag, "value": value}
        rec["lines"].append(last)
        if tag == "NAME" and level == 1 and not rec["name"]: rec["name"] = re.sub(r"\s+", " ", value.replace("/", " ")).strip()
    return recs


def xrefs_of(recs):
    by = {r["xref"]: r for r in recs if r["xref"]}
    cited = {}
    def own(r):
        if r["tag"] == "INDI": return [r["xref"]]
        if r["tag"] == "FAM":
            return [l["value"].strip() for l in r["lines"] if l["tag"] in ("HUSB", "WIFE") and by.get(l["value"].strip(), {}).get("tag") == "INDI"]
        return []
    for r in recs:
        if r["tag"] not in ("INDI", "FAM"): continue
        for l in r["lines"]:
            v = l["value"].strip()
            if re.match(r"^@[^@]+@$", v) and l["tag"] in ("SOUR", "NOTE", "OBJE"):
                for x in own(r):
                    if x not in cited.setdefault(v, []): cited[v].append(x)
    return lambda r: own(r) if r["tag"] in ("INDI", "FAM") else cited.get(r["xref"], [])


def parse_url(url, expand_range=False):
    """-> (fileId, [pages]) или None (не страница каталога — как parseArchiveUrl в links-tools.js)"""
    u = urlparse(url)
    if not re.search(r"(^|\.)(ya\.ru|yandex\.ru)$", (u.hostname or "").lower()): return None
    parts = [p for p in u.path.split("/") if p]
    if not parts or parts[0] != "archive": return None
    num = lambda v: int(v) if re.fullmatch(r"\d+", str(v or "").strip()) and int(v) > 0 else None
    if len(parts) > 1 and parts[1] == "catalog":
        fid = parts[2] if len(parts) > 2 else ""
        p = num(parts[3] if len(parts) > 3 else None)
        return (fid, [p]) if ID_RX.match(fid) and p else None
    if len(parts) > 1 and parts[1] == "search":
        q = parse_qs(u.query)
        fid = (q.get("fileId") or [""])[0]
        a, b = num((q.get("sheet_page_from") or [None])[0]), num((q.get("sheet_page_to") or [None])[0])
        if not ID_RX.match(fid) or a is None: return None
        lo, hi = (a, b if b is not None else a)
        if lo > hi: lo, hi = hi, lo
        if not expand_range and hi > lo: lo = hi = a
        hi = min(hi, lo + MAX_RANGE - 1)
        return fid, list(range(lo, hi + 1))
    return None


def plan_of(recs, expand_range=False):
    """уникальные страницы в порядке первого появления: [{fileId, page, clean, xrefs}]"""
    xo = xrefs_of(recs)
    unique, index = [], {}
    for rec in recs:
        xs = xo(rec)
        for l in rec["lines"]:
            for url in urls_in(l["value"]):
                p = parse_url(url, expand_range)
                if not p: continue
                for n in p[1]:
                    key = (p[0], n)
                    u = index.get(key)
                    if u is None:
                        u = index[key] = {"fileId": p[0], "page": n, "clean": f"https://ya.ru/archive/catalog/{p[0]}/{n}", "key": f"{p[0]}:{n}", "xrefs": []}
                        unique.append(u)
                    for x in xs:
                        if x not in u["xrefs"]: u["xrefs"].append(x)
    return unique


def read_meta(path):
    """result_links.csv (UTF-8, «;») или result_links.xlsx -> (список строк, столбцы). Строка: local, cga, type, clean, status"""
    path = Path(path)
    if path.suffix.lower() == ".csv":
        import csv
        with open(path, encoding="utf-8-sig", newline="") as f:
            rows = list(csv.reader(f, delimiter=";"))
    else:
        ws = load_workbook(path)["Страницы"]
        rows = [[("" if c.value is None else str(c.value)) for c in r] for r in ws.iter_rows()]
    head = rows[0]
    col = {h: i for i, h in enumerate(head)}
    if HEAD_LOCAL not in col: sys.exit(f"В таблице нет столбца «{HEAD_LOCAL}».")
    cga_col = col.get(HEAD_CGA, col.get("Ссылка на ЦГА Москвы"))      # прежнее название столбца
    get = lambda r, name: r[col[name]] if name in col and col[name] < len(r) else ""
    out = []
    for r in rows[1:]:
        if not any(r): continue
        local = get(r, HEAD_LOCAL)
        out.append({"local": "" if str(local).startswith("не скачан") else str(local),
                    "cga": (r[cga_col] if cga_col is not None and cga_col < len(r) else ""),
                    "type": get(r, HEAD_TYPE), "clean": get(r, HEAD_CLEAN)})
    return out


def emit(out, level, tag, value):
    for i, part in enumerate(re.split(r"\r\n|\n|\r", str(value))):
        out.append((f"{level + 1} CONT" if i else f"{level} {tag}") + (" " + part[:200] if part[:200] else ""))
        for p in range(200, len(part), 200): out.append(f"{level + 1} CONC {part[p:p + 200]}")


def split_records(text):
    lines = re.split(r"\r\n|\n|\r", text.lstrip("﻿"))
    while lines and not lines[-1].strip(): lines.pop()
    recs, rec = [], None
    for raw in lines:
        m = re.match(r"^\s*0\s+(?:(@[^@]+@)\s+)?([A-Za-z_0-9]+)", raw)
        if m: rec = {"xref": m[1] or "", "tag": m[2].upper(), "lines": [raw]}; recs.append(rec)
        elif rec is not None: rec["lines"].append(raw)
        else: rec = {"xref": "", "tag": "", "lines": [raw]}; recs.append(rec)
    return recs


def strip_own(recs):
    removed, kept = 0, []
    for r in recs:
        if OWN_RX.match(r["xref"]): removed += 1
        else: kept.append(r)
    for r in kept:
        out, skip = [], None
        for ln in r["lines"]:
            m = re.match(r"^\s*(\d+)\s+(?:@[^@]+@\s+)?([A-Za-z_0-9]+)(?:[ \t](.*))?$", ln)
            level = int(m[1]) if m else -1
            if skip is not None:
                if m and level > skip: continue
                skip = None
            if m and level > 0 and m[2].upper() in ("SOUR", "OBJE") and OWN_RX.match((m[3] or "").strip()):
                skip = level; removed += 1; continue
            out.append(ln)
        r["lines"] = out
    return kept, removed


def existing_of(recs):
    """что у каждой персоны уже есть (записи самого файла): страницы/файлы в источниках (srcKeys/srcFiles) и в медиа-объектах (medKeys/medFiles)"""
    parsed = records("\n".join("\n".join(r["lines"]) for r in recs))
    by = {r["xref"]: r for r in parsed if r["xref"]}
    def keys_of(v):
        out = set()
        for url in urls_in(v):
            q = parse_url(url, True)
            if q: out.update(f"{q[0]}:{n}" for n in q[1])
        return out
    is_ptr = lambda v: re.fullmatch(r"@[^@]+@", str(v).strip()) is not None
    out = {}
    for r in parsed:
        if r["tag"] != "INDI": continue
        e = {"srcKeys": set(), "srcFiles": set(), "medKeys": set(), "medFiles": set()}
        def take(lines, keys, files):
            for ln in lines:
                keys.update(keys_of(ln["value"]))
                if ln["tag"] == "FILE": files.add(re.split(r"[\\/]", ln["value"].strip())[-1])
        ls = r["lines"]
        def kids(i):
            res = []
            for j in range(i + 1, len(ls)):
                if ls[j]["level"] <= ls[i]["level"]: break
                res.append(ls[j])
            return res
        for i, ln in enumerate(ls):
            v = ln["value"].strip()
            if ln["tag"] == "SOUR" and is_ptr(v) and v in by:
                take(kids(i), e["srcKeys"], e["srcFiles"]); take(by[v]["lines"], e["srcKeys"], e["srcFiles"])
            elif ln["tag"] == "OBJE":
                if is_ptr(v) and v in by: take(by[v]["lines"], e["medKeys"], e["medFiles"])
                else: take(kids(i), e["medKeys"], e["medFiles"])
        out[r["xref"]] = e
    return out


def apply(text, unique, meta, variant):
    eol = "\r\n" if "\r\n" in text else "\n" if "\n" in text else "\r" if "\r" in text else "\r\n"
    recs, removed = strip_own(split_records(text))
    indi = {r["xref"]: r for r in recs if r["tag"] == "INDI" and r["xref"]}
    have = existing_of(recs)
    other = "media" if variant == "source" else "source"
    st = {"pages": 0, "links": 0, "persons": set(), "noScan": 0, "noPerson": 0, "removed": removed, "switched": 0, "exists": 0, "bySource": 0, "byMedia": 0}
    added, num = [], {"source": 0, "media": 0}
    prefix = {"source": "YA_S", "media": "YA_M"}
    for u, m in zip(unique, meta):
        path = m["local"]
        if not path: st["noScan"] += 1; continue
        who = [x for x in u["xrefs"] if x in indi]
        if not who: st["noPerson"] += 1; continue
        name = re.split(r"[\\/]", path)[-1]
        def has(x, v):
            e = have.get(x)
            if not e: return False
            return u["key"] in e["srcKeys" if v == "source" else "medKeys"] or name in e["srcFiles" if v == "source" else "medFiles"]
        todo = {"source": [], "media": []}
        for x in who:
            if not has(x, variant): todo[variant].append(x)
            elif not has(x, other): todo[other].append(x); st["switched"] += 1
            else: st["exists"] += 1
        doc = m["type"] or "Страница документа Яндекс Архива"
        fmt = (re.search(r"\.([A-Za-z0-9]{2,4})$", path) or [0, "jpg"])[1].lower()
        wrote = False
        for v in (variant, other):
            if not todo[v]: continue
            num[v] += 1; rid = f"@{prefix[v]}{num[v]}@"
            rec = [f"0 {rid} {'SOUR' if v == 'source' else 'OBJE'}"]
            if v == "source":
                emit(rec, 1, "TITL", doc)
                if m["cga"]: emit(rec, 1, "PUBL", f"Архив хранения документа: {m['cga']}")
                emit(rec, 1, "NOTE", f"Страница в Яндекс Архиве: {u['clean']}")
                rec.append("1 OBJE"); emit(rec, 2, "FILE", path); emit(rec, 2, "FORM", fmt); emit(rec, 2, "TITL", f"{doc}, {name}")
            else:
                emit(rec, 1, "FILE", path); emit(rec, 1, "FORM", fmt); emit(rec, 1, "TITL", doc)
                emit(rec, 1, "NOTE", (f"Архив хранения документа: {m['cga']}\n" if m["cga"] else "") + f"Страница в Яндекс Архиве: {u['clean']}")
            added.append({"lines": rec})
            for x in todo[v]:
                r = indi[x]
                if v == "source": r["lines"].append(f"1 SOUR {rid}"); emit(r["lines"], 2, "PAGE", f"Скан {u['page']}, {u['clean']}"); st["bySource"] += 1
                else: r["lines"].append(f"1 OBJE {rid}"); st["byMedia"] += 1
                st["links"] += 1; st["persons"].add(x)
            wrote = True
        if wrote: st["pages"] += 1
    head = next((r for r in recs if r["tag"] == "HEAD"), None)
    if head:
        i = next((k for k, l in enumerate(head["lines"]) if re.match(r"^\s*1\s+CHAR\b", l, re.I)), -1)
        if i >= 0: head["lines"][i] = "1 CHAR UTF-8"
        else: head["lines"].append("1 CHAR UTF-8")
    t = next((k for k, r in enumerate(recs) if r["tag"] == "TRLR"), -1)
    at = t if t >= 0 else len(recs)
    allr = recs[:at] + added + recs[at:]
    if t < 0: allr.append({"lines": ["0 TRLR"]})
    st["persons"] = len(st["persons"])
    return eol.join(eol.join(r["lines"]) for r in allr) + eol, st


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ged"); ap.add_argument("table", help="result_links.csv (или .xlsx)")
    ap.add_argument("--variant", choices=("source", "media"), required=True)
    ap.add_argument("--out"); ap.add_argument("--in-place", action="store_true")
    ap.add_argument("--ranges", action="store_true", help="разворачивать диапазоны sheet_page_from…to (как отметка в расширении)")
    a = ap.parse_args()
    src = Path(a.ged)
    raw = src.read_bytes()
    text = decode(raw)
    unique, table = plan_of(records(text), a.ranges), read_meta(a.table)
    if all(r["clean"] for r in table):             # таблица 2.9.2+: страницы сопоставляются по «Очищенная ссылка»
        by = {r["clean"]: r for r in table}
        meta = [by.get(u["clean"], {"local": "", "cga": "", "type": ""}) for u in unique]
    elif len(unique) == len(table):                # прежняя таблица: по порядку строк
        meta = table
    else:
        sys.exit(f"В .ged {len(unique)} уникальных страниц, а в таблице {len(table)} строк: таблица сделана не по этому .ged (или по-другому разобраны диапазоны — см. --ranges).")
    out, st = apply(text, unique, meta, a.variant)
    if a.in_place:
        backup = src.with_name(src.stem + "_до_сканов.ged"); backup.write_bytes(raw)
        dest = src; print(f"Копия до записи: {backup}")
    else:
        dest = Path(a.out) if a.out else src.with_name(src.stem + "_со_сканами.ged")
    dest.write_bytes(out.encode("utf-8"))
    print(f"Записано: {dest}\nСтраниц {st['pages']}, ссылок у персон {st['links']}, персон {st['persons']}; "
          f"без скана {st['noScan']}, без персоны {st['noPerson']}; уже были записи этой страницы: другим вариантом {st['switched']}, пропущено {st['exists']}; "
          f"прежних записей навыка заменено {st['removed']}.")


if __name__ == "__main__":
    main()
