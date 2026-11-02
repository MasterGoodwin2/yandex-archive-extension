"""
yaarchive: навык «Исправление ошибок».

После обработки и вывода результатов анализирует ошибки и противоречия и предлагает конкретные действия.
Ничего не меняет без вашего подтверждения: в окне скрипта (д/н) или в листе «Исправления» Excel («да»/«нет»).
Принятые исправления хранятся в «Итог/исправления.json» и применяются при КАЖДОМ пересчёте (новые пакеты,
новая версия алгоритма) — на своём шаге конвейера: значения (НП, двор, пол, номер, возраст, текст) — до родства
и года рождения, родство и год рождения — после.

Что анализируется:
  • Номер человека      — в сквозной нумерации мужчин/женщин номер выпадает из ряда (… 12, 15, 14 …) или пуст
  • Номер двора         — двор «скачет» между соседними (4, 7, 6 → 4, 5, 6)
  • Населённый пункт    — люди до первого заголовка НП: по порядку НП прихода это предыдущий НП
  • Имя и пол           — тексты двух соседних людей перепутаны (женское имя у мужского номера и наоборот)
  • Имя не найдено      — в тексте семьи осталось одно неиспользованное имя подходящего пола
  • Сдвиг возрастов     — пропущенная цифра сдвинула возрасты по семье: «ребёнок» старше родителя
  • Родство             — «сын/дочь» почти ровесник родителя, а сдвиг возрастов не помогает
  • Возраст             — неправдоподобный (больше 110): лишняя цифра распознавания
  • Возраст по ревизиям — нынешний возраст не согласуется с возрастом по прошлой ревизии
  • Дозагрузка страниц  — страницы диапазона не загрузились: файл ссылок для расширения
  • Ваша правка в Excel — значение, изменённое вами в листе «Люди»
"""
import datetime
import hashlib
import json
import queue
import re
import sys
import threading
import time
from collections import Counter, OrderedDict
from pathlib import Path

LIMITS = {"разница_возраста_родитель_ребёнок": 14, "макс_возраст": 110, "допуск_возраста_между_ревизиями": 2}
FILE = "исправления.json"
MANUAL = ".ручные_правки.json"
SNAP, PROPS = ".снимок.json", ".предложения.json"
STAGE1 = {"settlement", "yard", "sex", "no", "age", "age_prev", "raw"}
STAGE2 = {"first", "patr", "surname", "relation", "rel", "ref_id", "birth"}
FIELD_RU = {"settlement": "НП", "yard": "двор", "sex": "пол", "no": "номер", "age": "возраст",
            "age_prev": "возраст по прошлой ревизии", "raw": "текст", "first": "имя", "patr": "отчество",
            "surname": "фамилия", "relation": "родство", "rel": "родство", "ref_id": "ID отца/мужа", "birth": "год рождения"}
REL_WORDS = {"глава", "глава семьи", "жена", "сын", "дочь", "брат", "сестра", "вдова", "вдова, глава", "?", "внук", "внучка",
             "сноха", "зять", "мать", "отец", "племянник", "племянница"}


def now():
    return datetime.datetime.now().strftime("%d.%m.%Y %H:%M")


def typed(field, v):
    s = "" if v is None else str(v).strip()
    if field in ("yard", "no", "birth") and re.fullmatch(r"\d+", s):
        return int(s)
    return s


# =============================================================================== хранилище
class Corrections:
    def __init__(self, od):
        self.od = Path(od)
        self.f = self.od / FILE
        try:
            self.data = json.loads(self.f.read_text(encoding="utf-8"))
        except Exception:
            self.data = {}
        self.data.setdefault("_описание", "Принятые исправления yaarchive: применяются при каждом пересчёте. "
                                          "Снять решение — «отменить» в листе «Исправления» или удалить запись здесь.")
        self.data.setdefault("правки", {})
        self.data.setdefault("решения", {})

    def save(self):
        self.od.mkdir(parents=True, exist_ok=True)
        self.f.write_text(json.dumps(self.data, ensure_ascii=False, indent=1), encoding="utf-8")

    def decided(self, pid):
        return pid in self.data["решения"]

    def count(self):
        return sum(len(v) for v in self.data["правки"].values())

    def apply(self, rows, stage):
        fields = STAGE1 if stage == 1 else STAGE2
        for p in rows:
            c = self.data["правки"].get(p["key"])
            if not c:
                continue
            for f, rec in c.items():
                if f not in fields:
                    continue
                old, new = p.get(f, ""), typed(f, rec["new"])
                p[f] = new
                p["locked"].add(f)
                if f == "yard":
                    p["yard_calc"] = False
                if f == "relation":
                    w = str(new).split(" ")[0].strip(",")
                    p["rel"] = new if new in REL_WORDS else (w if w in REL_WORDS else p.get("rel", ""))
                    p["locked"].add("rel")
                if str(old) != str(new):
                    p["fixed"].append(f"{FIELD_RU.get(f, f)}: {old if old not in ('', None) else '—'} → "
                                      f"{new if new not in ('', None) else '—'} ({rec.get('kind', '')})")

    def decide(self, pr, decision, source, roots=None):
        pid = pr["id"]
        self.data["решения"][pid] = {"decision": decision, "when": now(), "source": source, "type": pr["type"],
                                     "where": pr["where"], "now": pr["now"], "new": pr["new"]}
        if decision == "да":
            for key, field, old, new in pr.get("changes", []):
                self.data["правки"].setdefault(key, {})[field] = {
                    "new": new, "old": old, "kind": "ваша правка" if pr["type"] == "Ваша правка в Excel" else "исправление",
                    "pid": pid, "when": now()}
            act = pr.get("action")
            if act and act.get("kind") == "file" and roots:
                target = Path(roots[0]) / act["name"]
                target.write_text(act["content"], encoding="utf-8")
                self.data["решения"][pid]["file"] = str(target)
        self.save()

    def undo(self, pid):
        self.data["решения"].pop(pid, None)
        for key in list(self.data["правки"]):
            for f in list(self.data["правки"][key]):
                if self.data["правки"][key][f].get("pid") == pid:
                    del self.data["правки"][key][f]
            if not self.data["правки"][key]:
                del self.data["правки"][key]
        self.save()

    def history(self):
        return [{"id": pid, "type": d["type"], "where": d["where"], "now": d["now"], "new": d["new"],
                 "when": f"{d['when']}, {d['source']}" + (f"; файл {Path(d['file']).name}" if d.get("file") else ""),
                 "decision": {"да": "применено", "нет": "отклонено"}.get(d["decision"], d["decision"])}
                for pid, d in self.data["решения"].items()]


# =============================================================================== анализ
def who(p):
    s = f"{p['year'] or ''} г., стр. {p['page']}: {p.get('fio') or p['raw'] or '(без имени)'}"
    if p["no"] not in ("", None):
        s += f", {p['sex']} № {p['no']}"
    if p["yard"] not in ("", None):
        s += f", двор {p['yard']}"
    return s


def mk(ptype, people, changes, reason, now_txt, new_txt, action=None):
    base = json.dumps([ptype, changes, action and action.get("content", "")[:2000]], ensure_ascii=False, default=str)
    p0 = people[0] if people else {}
    where = who(p0) if p0 else ""
    if len(people) > 1:
        where += f" (+ ещё {len(people) - 1})"
    return {"id": hashlib.sha1(base.encode("utf-8")).hexdigest()[:10], "type": ptype, "where": where,
            "now": now_txt, "new": new_txt, "reason": reason, "changes": [list(c) for c in changes],
            "url": p0.get("url", ""), "page": p0.get("page"), "doc": p0.get("doc", ""), "action": action}


def _int(v):
    return int(v) if re.fullmatch(r"\d+", str(v if v is not None else "")) else None


def _age(v):
    m = re.match(r"^\s*(\d{1,3})", str(v if v is not None else ""))
    return int(m.group(1)) if m else None


def by_doc(people):
    d = OrderedDict()
    for p in people:
        d.setdefault(p["doc"], []).append(p)
    return d


def an_numbers(pp):
    out = []
    for sex in ("м", "ж"):
        seq = [p for p in pp if p["sex"] == sex and p["kind"] == "confession"]
        for i in range(1, len(seq) - 1):
            p, a, b = seq[i], _int(seq[i - 1]["no"]), _int(seq[i + 1]["no"])
            if "no" in p["locked"] or a is None or b is None or b - a != 2:
                continue
            x = _int(p["no"])
            if x != a + 1:
                out.append(mk("Номер человека", [p], [(p["key"], "no", p["no"], a + 1)],
                              f"соседние номера {'мужчин' if sex == 'м' else 'женщин'}: {a} и {b} — между ними должен быть {a + 1}"
                              + ("" if x is not None else " (номер не распознан)"), str(p["no"] or "пусто"), str(a + 1)))
    return out


def runs_of(pp, key):
    out = []
    for p in pp:
        if out and key(out[-1][0]) == key(p):
            out[-1].append(p)
        else:
            out.append([p])
    return out


def an_yards(pp):
    out = []
    rr = runs_of([p for p in pp if p["kind"] == "confession"], lambda p: (p["settlement"], p["yard"]))
    for i in range(1, len(rr) - 1):
        r, u, w = rr[i], rr[i - 1], rr[i + 1]
        if not (r[0]["settlement"] == u[0]["settlement"] == w[0]["settlement"]):
            continue
        v, a, b = _int(r[0]["yard"]), _int(u[0]["yard"]), _int(w[0]["yard"])
        if v is None or a is None or b is None or any("yard" in p["locked"] for p in r):
            continue
        if b - a == 2 and v != a + 1:
            out.append(mk("Номер двора", r, [(p["key"], "yard", p["yard"], a + 1) for p in r],
                          f"двор между {a} и {b}: распознан как {v} — по порядку должен быть {a + 1} "
                          f"({len(r)} чел.)", str(v), str(a + 1)))
    return out


def an_settlement(pp, orders):
    out = []
    head = []
    for p in pp:
        if str(p["settlement"]).startswith("не определён"):
            head.append(p)
        else:
            break
    if not head or len(head) == len(pp) or any("settlement" in p["locked"] for p in head):
        return out
    s = pp[len(head)]["settlement"]
    order = orders(head[0]["year"])
    if s in order and order.index(s) > 0:
        prev = order[order.index(s) - 1]
        out.append(mk("Населённый пункт", head, [(p["key"], "settlement", p["settlement"], prev) for p in head],
                      f"{len(head)} чел. стоят до первого заголовка «{s}»; по порядку НП прихода ({head[0]['year']} г.) "
                      f"перед ним идёт «{prev}». Если это хвост другой ведомости — ответьте «нет».",
                      "не определён", prev))
    return out


def an_swap(pp, name_sex_of):
    out = []
    flag = "пол по имени не совпал со столбцом"
    for i in range(len(pp) - 1):
        a, b = pp[i], pp[i + 1]
        if a["block"] != b["block"] or not (any(flag in f for f in a["flags"]) and any(flag in f for f in b["flags"])):
            continue
        sa, sb = name_sex_of(a["raw"]), name_sex_of(b["raw"])
        if sa and sb and sa != a["sex"] and sb != b["sex"] and sa == b["sex"] and sb == a["sex"]:
            out.append(mk("Имя и пол", [a, b], [(a["key"], "raw", a["raw"], b["raw"]), (b["key"], "raw", b["raw"], a["raw"])],
                          f"у {a['sex']} № {a['no']} имя «{a['raw']}», у {b['sex']} № {b['no']} — «{b['raw']}»: тексты соседей перепутаны",
                          f"{a['raw']} | {b['raw']}", f"{b['raw']} | {a['raw']}"))
    return out


PATR_RX = re.compile(r"(ов|ев|ин|ова|ева|ина|ыхъ|ых)ъ?$", re.I)


def an_missing_name(pp, name_sex_of_token):
    out = []
    blocks = OrderedDict()
    for p in pp:
        blocks.setdefault(p["block"], []).append(p)
    for mem in blocks.values():
        empty = [p for p in mem if not p["raw"] and p["kind"] == "confession" and "raw" not in p["locked"]]
        if len(empty) != 1 or not mem[0]["block_text"]:
            continue
        p = empty[0]
        used = Counter(t for q in mem for t in q["raw"].split())
        left = []
        for t in mem[0]["block_text"].split():
            if used[t]:
                used[t] -= 1
            else:
                left.append(t)
        cands = [i for i, t in enumerate(left) if name_sex_of_token(t) == p["sex"]]
        if len(cands) == 1:
            i = cands[0]
            txt = left[i] + (" " + left[i + 1] if i + 1 < len(left) and PATR_RX.search(left[i + 1]) else "")
            out.append(mk("Имя не найдено", [p], [(p["key"], "raw", "", txt)],
                          f"в тексте семьи осталось одно неиспользованное имя подходящего пола: «{txt}»", "пусто", txt))
    return out


def _conflicts(members, ages, by_id, gap):
    bad = []
    for i, p in enumerate(members):
        if p["rel"] in ("сын", "дочь") and p["ref_id"] in by_id:
            par = by_id[p["ref_id"]]
            ac = ages.get(p["key"])
            ap = ages.get(par["key"]) if par["key"] in ages else _age(par["age"])
            if ac is not None and ap is not None and ap - ac < gap:
                bad.append((p, par, ap - ac))
    return bad


def an_ages(pp, gap):
    out = []
    by_id = {p["id"]: p for p in pp}
    groups = runs_of(pp, lambda p: (p["settlement"], p["yard"]) if p["kind"] == "confession" else p["block"])
    for mem in groups:
        ages = {p["key"]: _age(p["age"]) for p in mem}
        bad = _conflicts(mem, ages, by_id, gap)
        if not bad:
            continue
        best = None
        if not any("age" in p["locked"] for p in mem):
            for e, pe in enumerate(mem):
                if ages[pe["key"]] is not None:
                    continue
                vals = [p["age"] for p in mem]
                for mode in ("up", "down"):
                    nv = list(vals)
                    if mode == "up":
                        nv[e:-1], nv[-1] = vals[e + 1:], ""
                    else:
                        nv[1:e + 1], nv[0] = vals[0:e], ""
                    na = {p["key"]: _age(v) for p, v in zip(mem, nv)}
                    if not _conflicts(mem, na, by_id, gap):
                        ch = [(p["key"], "age", p["age"], v) for p, v in zip(mem, nv) if str(p["age"]) != str(v)]
                        if best is None or len(ch) < len(best[1]):
                            best = (mode, ch, e)
        if best:
            mode, ch, e = best
            ppl = [p for p in mem if any(c[0] == p["key"] for c in ch)]
            out.append(mk("Сдвиг возрастов", ppl, ch,
                          f"у «{mem[e]['fio'] or mem[e]['raw'] or '?'}» возраст не распознан, и возрасты ниже/выше сдвинуты: "
                          + "; ".join(f"{c.get('fio') or c['raw']} ({c['age']}) — {par.get('fio') or par['raw']} ({par['age']})"
                                      for c, par, _ in bad[:3])
                          + f". Сдвиг на строку {'вверх' if mode == 'up' else 'вниз'} убирает противоречие.",
                          ", ".join(str(c[2] or "—") for c in ch), ", ".join(str(c[3] or "—") for c in ch)))
            continue
        for c, par, d in bad:
            if "relation" in c["locked"]:
                continue
            out.append(mk("Родство", [c], [(c["key"], "relation", c["relation"], "?"), (c["key"], "ref_id", c["ref_id"], "")],
                          f"«{c['rel']}», но разница возраста с {par.get('fio') or par['raw']} всего {d} лет "
                          f"(нужно не меньше {gap}); сдвиг возрастов не помогает — снять родство (останется в семье без связи)",
                          c["relation"], "? (родство не определено)"))
    return out


def an_big_age(pp, mx):
    out = []
    for p in pp:
        for f in ("age", "age_prev"):
            a = _age(p[f])
            if a is None or a <= mx or f in p["locked"]:
                continue
            s = str(a)
            cand = int(s[1:]) if len(s) > 1 and s[1:] and int(s[1:]) > 0 else None
            if cand and cand <= mx:
                out.append(mk("Возраст", [p], [(p["key"], f, p[f], cand)],
                              f"{FIELD_RU[f]} {a} неправдоподобен — вероятно, лишняя цифра распознавания", str(p[f]), str(cand)))
    return out


def an_revision_ages(pp, revisions, tol):
    out = []
    for p in pp:
        if p["kind"] != "revision" or p["status"] != "налицо" or "age" in p["locked"]:
            continue
        y = p["year"]
        prev_year = revisions.get(max((k for k, v in revisions.items() if y and v < y), default=0))
        an, ap = _age(p["age"]), _age(p["age_prev"])
        if not prev_year or an is None or ap is None or "?" in str(p["age"]):
            continue
        exp = y - prev_year
        if abs((an - ap) - exp) > tol:
            out.append(mk("Возраст по ревизиям", [p], [(p["key"], "age", p["age"], ap + exp)],
                          f"по прошлой ревизии ({prev_year}) {ap}, сейчас ({y}) {an}: разница {an - ap}, а должна быть ~{exp}. "
                          f"Если ошибка в прошлом возрасте — ответьте «нет» и поправьте его в листе «Люди».",
                          str(p["age"]), str(ap + exp)))
    return out


def an_pages(ctx):
    rows, miss_all = [], []
    for d in ctx.docs:
        loaded = {p.page for p in d["pages"]}
        miss = sorted((set(d.get("requested") or ()) - loaded) | {f.get("page") for f in d["failed"] if f.get("page") is not None})
        fid = str(d["file_id"])
        if not miss:
            continue
        if len(fid) < 30:
            continue
        i = 0
        while i < len(miss):
            j = i
            while j + 1 < len(miss) and miss[j + 1] == miss[j] + 1:
                j += 1
            a, b = miss[i], miss[j]
            url = (f"https://ya.ru/archive/search?text={d['year']}&sheet_page_from={a}&sheet_page_to={b}"
                   f"&index=archive&fileId={fid}")
            rows.append(f'<p>{d["year"]} г. <a href="{url}">{d["year"]}: стр. {a}–{b}</a></p>')
            i = j + 1
        miss_all.append(f"{d['year']}: {len(miss)} стр.")
    if not rows:
        return []
    html = "<html><head><meta charset=\"utf-8\"><title>Дозагрузка страниц</title></head><body>\n" + "\n".join(rows) + "\n</body></html>\n"
    name = "Дозагрузка_страниц.html"
    return [mk("Дозагрузка страниц", [], [], "страницы из запрошенных диапазонов не загрузились (ошибка, остановка, "
               "пропуск). Будет создан файл ссылок для расширения — выберите его в разделе 2 и нажмите «Начать».",
               "; ".join(miss_all), f"файл «{name}» в папке ссылок", action={"kind": "file", "name": name, "content": html})]


def analyze(ctx):
    import extract_confession as EC
    import revision_people as RP
    import split_names as SN

    def name_sex_of(raw):
        ps = RP.parse_segment(raw or "", False)
        r = SN.name_sex(ps["name"]) if ps["name"] else None
        return ({"M": "м", "F": "ж"}[r[0]]) if r else None

    def name_sex_tok(t):
        r = SN.name_sex(t)
        return ({"M": "м", "F": "ж"}[r[0]]) if r and not r[1] else None

    def orders(year):
        return EC.ORDER_BEFORE_1750 if (year and year < 1750) else EC.ORDER_FROM_1750
    props = []
    for _doc, pp in by_doc(ctx.people).items():
        # НП «не определён» теперь заполняется сам (следующий определённый) — предложение не нужно
        props += an_yards(pp)
        props += an_numbers(pp)
        props += an_swap(pp, name_sex_of)
        props += an_missing_name(pp, name_sex_tok)
        props += an_big_age(pp, LIMITS["макс_возраст"])
        props += an_ages(pp, LIMITS["разница_возраста_родитель_ребёнок"])
        props += an_revision_ages(pp, RP.REVISIONS, LIMITS["допуск_возраста_между_ревизиями"])
    props += an_pages(ctx)
    for pr in load_manual(ctx.out_dir).values():
        props.append(pr)
    seen, out = set(), []
    for pr in props:
        if pr["id"] in seen or ctx.corr.decided(pr["id"]):
            continue
        seen.add(pr["id"])
        out.append(pr)
    return out


# =============================================================================== ручные правки и решения из Excel
def load_manual(od):
    try:
        return json.loads((Path(od) / MANUAL).read_text(encoding="utf-8"))
    except Exception:
        return {}


def _norm_cell(v):
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).strip()


def read_excel_feedback(od):
    od = Path(od)
    try:
        snap = json.loads((od / SNAP).read_text(encoding="utf-8"))
        props = json.loads((od / PROPS).read_text(encoding="utf-8"))
    except Exception:
        return None
    x = Path(snap.get("xlsx", ""))
    if not x.is_file():
        return None
    mt = x.stat().st_mtime
    if mt <= snap["written"] + 2 or mt <= snap.get("read", 0):
        return None
    if time.time() - mt < 3:                    # Excel ещё сохраняет
        return None
    try:
        from openpyxl import load_workbook
        wb = load_workbook(x)
    except Exception:
        return None
    corr = Corrections(od)
    n_dec = n_undo = n_man = 0
    if "Исправления" in wb.sheetnames:
        for row in wb["Исправления"].iter_rows(min_row=3, values_only=True):
            if not row or len(row) < 8 or not row[1]:
                continue
            pid, ans = str(row[1]).strip(), _norm_cell(row[7]).lower()
            if ans in ("отменить", "отмена") and corr.decided(pid):
                corr.undo(pid)
                n_undo += 1
            elif ans in ("да", "нет", "д", "н") and pid in props and not corr.decided(pid):
                corr.decide(props[pid], "да" if ans.startswith("д") else "нет", "Excel", roots=[snap.get("root")] if snap.get("root") else None)
                n_dec += 1
                man = load_manual(od)
                if pid in man:
                    del man[pid]
                    (od / MANUAL).write_text(json.dumps(man, ensure_ascii=False), encoding="utf-8")
    if "Люди" in wb.sheetnames:
        ws = wb["Люди"]
        head = [_norm_cell(c.value) for c in ws[1]]
        from ya_out import COLS
        col = {f: head.index(h) + 1 for h, f, _w, ed in COLS if h in head}
        if "key" in col:
            fill = {}
            for rng in ws.merged_cells.ranges:          # объединённые НП/двор: значение верхней ячейки на все строки
                v = ws.cell(rng.min_row, rng.min_col).value
                for r in range(rng.min_row, rng.max_row + 1):
                    fill[(r, rng.min_col)] = v
            man = load_manual(od)
            values = snap["values"]
            from ya_out import EDITABLE
            for r in range(2, ws.max_row + 1):
                key = _norm_cell(ws.cell(r, col["key"]).value)
                if key not in values:
                    continue
                for f in EDITABLE:
                    if f not in col:
                        continue
                    c = col[f]
                    v = _norm_cell(fill.get((r, c), ws.cell(r, c).value))
                    if f == "url":
                        continue
                    old = values[key].get(f, "")
                    if v != old:
                        who_ = f"{key.split('|')[0]}, {key.split('|')[1]}: " + (_norm_cell(ws.cell(r, col.get('raw', 1)).value) or "(без имени)")
                        pr = mk("Ваша правка в Excel", [], [(key, f, old, v)],
                                f"вы изменили «{FIELD_RU.get(f, f)}» в листе «Люди»; подтвердите, чтобы правка сохранялась при пересчётах",
                                old or "пусто", v or "пусто")
                        pr["where"] = who_
                        if not corr.decided(pr["id"]) and pr["id"] not in man:
                            man[pr["id"]] = pr
                            n_man += 1
            (od / MANUAL).write_text(json.dumps(man, ensure_ascii=False), encoding="utf-8")
    snap["read"] = mt
    (od / SNAP).write_text(json.dumps(snap, ensure_ascii=False), encoding="utf-8")
    if not (n_dec or n_undo or n_man):
        return None
    return ", ".join(x for x in (f"решений {n_dec}" if n_dec else "", f"отмен {n_undo}" if n_undo else "",
                                 f"ваших правок {n_man} (ждут подтверждения)" if n_man else "") if x)


# =============================================================================== диалог в окне
_q, _thr = queue.Queue(), None


def _reader():
    for line in sys.stdin:
        _q.put(line.strip())
    _q.put(None)


def ask(prompt, timeout):
    global _thr
    if _thr is None:
        _thr = threading.Thread(target=_reader, daemon=True)
        _thr.start()
    print(prompt, end="", flush=True)
    try:
        return _q.get(timeout=timeout)
    except queue.Empty:
        return None


def dialog(ctx, timeout=600):
    """-> (что-то применено, отложено «позже»/нет ответа)"""
    props = ctx.proposals
    print("\n" + "=" * 78)
    print(f"Навык «Исправление ошибок»: предложений {len(props)}.")
    print("Ответы: д — применить, н — не применять, дв — да всем такого вида, нв — нет всем такого вида,")
    print("        п — решу позже (останутся в листе «Исправления» Excel), ? — подробнее")
    print("=" * 78)
    auto, changed = {}, False
    for i, pr in enumerate(props, 1):
        ans = auto.get(pr["type"])
        if ans is None:
            print(f"\n[{i}/{len(props)}] {pr['type']} — {pr['where']}")
            print(f"    сейчас: {pr['now']}\n    предлагается: {pr['new']}\n    почему: {pr['reason']}")
            while True:
                a = ask("    Применить? [д/н/дв/нв/п/?] ", timeout)
                if a is None:
                    print("\n    Нет ответа — остальные предложения ждут в листе «Исправления».")
                    return changed, True
                a = a.lower().strip()
                if a == "?":
                    for c in pr.get("changes", []):
                        print(f"      {c[0]}: {FIELD_RU.get(c[1], c[1])} {c[2]!s} → {c[3]!s}")
                    if pr.get("url"):
                        print(f"      страница: {pr['url']}")
                    continue
                if a in ("д", "н", "дв", "нв", "п", "y", "n"):
                    break
            if a == "п":
                print("    Хорошо — остальные в листе «Исправления».")
                return changed, True
            if a in ("дв", "нв"):
                auto[pr["type"]] = "д" if a == "дв" else "н"
            ans = {"y": "д", "n": "н", "дв": "д", "нв": "н"}.get(a, a)
        ctx.corr.decide(pr, "да" if ans == "д" else "нет", "окно", roots=ctx.roots)
        changed = changed or ans == "д"
        man = load_manual(ctx.out_dir)
        if pr["id"] in man:
            del man[pr["id"]]
            (Path(ctx.out_dir) / MANUAL).write_text(json.dumps(man, ensure_ascii=False), encoding="utf-8")
    return changed, False
