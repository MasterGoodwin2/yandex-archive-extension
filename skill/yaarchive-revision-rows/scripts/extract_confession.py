#!/usr/bin/env python3
"""
Яндекс Архив, ИСПОВЕДНЫЕ ВЕДОМОСТИ: перепривязка соседних столбцов к Основному блоку (список людей).

Вход : данные страницы (__NEXT_DATA__) в .json, HTML-страница с этим <script>, либо папка с такими файлами.
Выход: JSON (по странице: половины разворота -> столбцы -> люди) и плоский CSV
       (одна строка = один человек: № двора, пол, № м/ж, возраст, текст блока как распознан).

Форма (1739-1864, с изменениями): слева от Основного блока три столбца
   «Домовъ / дворовъ» (№ двора) | «людей: мужеска пола» (№ мужчины) | «женска пола» (№ женщины),
справа два столбца «Лѣта отъ рожденія»: мужеска | женска.
Столбцы «Показанія дѣйства» (кто был у исповеди…) НЕ собираются и пропускаются.

Распознавание НЕ выполняется: используются только готовые тексты и координаты страницы.
Все допуски заданы в долях размера скана или медианного размера числа, поэтому
сканы разного разрешения обрабатываются одинаково.
"""
import argparse
import math
import csv
import json
import re
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from split_names import split_block  # noqa: E402

NEXT_RE = re.compile(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)
_MAP = str.maketrans({"ѣ": "е", "і": "и", "i": "и", "ѳ": "ф", "ѵ": "и", "ё": "е", "ѡ": "о", "ꙋ": "у", "ѯ": "кс"})

NUM_RE = re.compile(r"^\s*(?:№|N)?\s*(\d{1,4})\s*[.,:;]?\s*$")
MULTI_RE = re.compile(r"^\s*\d{1,4}(?:\s*[.,]?\s+\d{1,4})+\s*[.,]?\s*$")
AGE_RE = re.compile(r"^\s*(\d{1,3})?\s*(\d\s*/\s*\d)?\s*[.,]?\s*$")          # «45», «7 1/2», «1/2.»
HEADER_WORDS = re.compile(r"(числ|двор|домов|людей|мужеск|женск|лет\b|лет |рожден|показан|исповед|причаст|не были|пола)")
SKIP_HEAD = re.compile(r"(показан|исповед|причаст|не были)")

# Населённые пункты округи (как в logic.js расширения): название -> основа после нормализации
SETTLEMENTS = {
    "село Троицкое": r"троицк",
    "деревня Острогина": r"острогин",
    "деревня Черепкова": r"черепков",
    "деревня Рублева": r"рублев",
    "деревня Луки": r"лук(?:и|ъ)?\b",
    "деревня Мякинина": r"(?:м[яе]кинин|мемин)",
}
SETTLE_PREFIX = r"(?:\bсел\w*\.?|\bдер\w*\.?|\bдрв\w*|\bд\.|\bс\.)\s*[\[(«\"]?\s*"
SAME_VILLAGE = re.compile(r"\bтого\s+сел")        # «Того Села крестьянство» = село прихода
# порядок НП в ведомостях (из описания пользователя) — для подсказки, если заголовок не распознан
ORDER_BEFORE_1750 = ["село Троицкое", "деревня Черепкова", "деревня Острогина", "деревня Рублева", "деревня Луки", "деревня Мякинина"]
ORDER_FROM_1750 = ["село Троицкое", "деревня Острогина", "деревня Черепкова", "деревня Рублева", "деревня Луки"]

CSV_COLS = ["year", "page", "half", "settlement", "yard", "person_text", "sex", "no", "age", "birth_year",
            "person_in_block", "block_id", "names_text", "flags"]


def age_value(age):
    """«45» -> 45; «7 1/2» -> 7.5; «1/2» -> 0.5; иначе None"""
    m = re.match(r"^\s*(\d{1,3})?\s*(?:(\d)\s*/\s*(\d))?", str(age or ""))
    if not m or not (m.group(1) or m.group(2)):
        return None
    v = int(m.group(1) or 0)
    if m.group(2):
        v += int(m.group(2)) / int(m.group(3))
    return v


def birth_year(year, age):
    """год рождения = год ведомости − полных лет (± 1 год: ведомость составлялась в течение года)"""
    v = age_value(age)
    if not year or v is None:
        return ""
    return int(year) - int(math.floor(v))


def norm(t):
    t = (t or "").lower().translate(_MAP).replace("ъ", "").replace("ь", "")
    t = re.sub(r"[^\w\s/]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def load_node(path):
    raw = Path(path).read_text(encoding="utf-8")
    m = NEXT_RE.search(raw)
    data = json.loads(m.group(1) if m else raw)
    url = None
    if "props" in data:
        data = data["props"]["pageProps"]
    if isinstance(data, dict) and "currentNode" in data:
        url = data.get("url")
        data = data["currentNode"]
    data = dict(data)
    data.setdefault("_url", url)
    return data


class Blk:
    __slots__ = ("i", "id", "tid", "text", "x0", "y0", "x1", "y1", "w", "h", "cx", "cy", "kind", "vals")

    def __init__(self, i, j, t):
        pts = j["points"]
        xs, ys = [p["x"] for p in pts], [p["y"] for p in pts]
        self.i, self.id, self.tid = i, j["id"], t["id"]
        self.text = (t.get("text") or "").strip()
        self.x0, self.y0, self.x1, self.y1 = min(xs), min(ys), max(xs), max(ys)
        self.w, self.h = self.x1 - self.x0, self.y1 - self.y0
        self.cx, self.cy = (self.x0 + self.x1) / 2, (self.y0 + self.y1) / 2
        self.kind, self.vals = "text", []

    def bb(self):
        return [self.x0, self.y0, self.x1, self.y1]


def classify(b):
    t = b.text
    m = NUM_RE.match(t)
    if m:
        b.kind, b.vals = "num", [m.group(1)]
        return
    if MULTI_RE.match(t):
        b.kind, b.vals = "multi", re.findall(r"\d{1,4}", t)
        return
    m = AGE_RE.match(t)
    if m and (m.group(1) or m.group(2)):
        b.kind, b.vals = "frac", [re.sub(r"\s+", " ", t.strip(" .,"))]
        return
    b.kind = "text"


def settlement_of(text):
    n = norm(text)
    if SAME_VILLAGE.search(n):
        return "село Троицкое", "того села"
    for name, tail in SETTLEMENTS.items():
        if re.search(SETTLE_PREFIX + tail, n):
            return name, "заголовок"
    m = re.search(r"(?:\bсел\w*|\bдер\w*|\bдрв\w*|\bдрвн\w*)\.?\s+([а-я]{4,})", n)
    if m and len(n) < 60:
        w = m.group(1)
        for name, stem in SETTLE_STEMS.items():      # распознано с ошибкой: «Черепкава», «Острагина»
            if lev(w[: len(stem)], stem) <= max(1, len(stem) // 4):
                return name, "похоже на «" + w + "»"
        return "other:" + w, "заголовок"
    return None, None


SETTLE_STEMS = {"село Троицкое": "троицк", "деревня Острогина": "острогин", "деревня Черепкова": "черепков",
                "деревня Рублева": "рублев", "деревня Мякинина": "мякинин"}


def lev(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def pct(vals, q):
    s = sorted(vals)
    if not s:
        return 0
    k = (len(s) - 1) * q
    lo = int(k)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


# ----------------------------------------------------------------------------- столбцы
def deskew_slope(blocks, sigma, ymid):
    """Наклон столбцов (скан повёрнут): подбирается s, при котором центры x' = cx - s*(cy - ymid)
    собираются плотнее всего (сумма гауссовых сближений пар). sigma — доля ширины числа, поэтому
    результат не зависит от разрешения скана (нет корзин гистограммы в пикселях)."""
    if len(blocks) < 6:
        return 0.0
    import math
    pts = [(b.cx, b.cy - ymid) for b in blocks]
    best, best_s = -1.0, 0.0
    for k in range(-40, 41):
        s = k * 0.0015
        xs = sorted(x - s * y for x, y in pts)
        score = 0.0
        for i in range(len(xs)):
            for j in range(i + 1, len(xs)):
                d = (xs[j] - xs[i]) / sigma
                if d > 3:
                    break
                score += math.exp(-d * d)
        if score > best + 1e-9 or (abs(score - best) <= 1e-9 and abs(s) < abs(best_s)):
            best, best_s = score, s
    return best_s


def cluster_columns(blocks, gap, ymid, slope):
    """1-D кластеризация по x' (с поправкой на наклон). gap — в пикселях."""
    if not blocks:
        return []
    xs = sorted((((b.cx - slope * (b.cy - ymid)), b) for b in blocks), key=lambda t: t[0])
    groups = [[xs[0]]]
    for x, b in xs[1:]:
        if x - groups[-1][-1][0] > gap:
            groups.append([(x, b)])
        else:
            groups[-1].append((x, b))
    cols = []
    for g in groups:
        cols.append({"blocks": sorted((b for _, b in g), key=lambda b: b.cy), "b": slope,
                     "center": statistics.median(x for x, _ in g)})
    return sorted(cols, key=lambda c: c["center"])


def stable_by_y(blocks, eps):
    """сортировка по y; блоки почти на одной высоте (|dy| < eps) — по x, чтобы порядок не зависел от округления"""
    bs = sorted(blocks, key=lambda b: b.cy)
    out, grp = [], []
    for b in bs:
        if grp and b.cy - grp[0].cy >= eps:
            out += sorted(grp, key=lambda b: (b.cx, b.id)); grp = []
        grp.append(b)
    out += sorted(grp, key=lambda b: (b.cx, b.id))
    return out


def shift_line(pairs, med_h):
    """shift(y) = c0 + c1*y по парам (y, dy); выбросы (> 0.5 высоты числа от прямой) отбрасываются"""
    if not pairs:
        return 0.0, 0.0
    pts = list(pairs)
    for _ in range(3):
        if len(pts) < 4:
            return statistics.median(d for _, d in pts), 0.0
        my = statistics.mean(y for y, _ in pts); md = statistics.mean(d for _, d in pts)
        syy = sum((y - my) ** 2 for y, _ in pts)
        c1 = sum((y - my) * (d - md) for y, d in pts) / syy if syy else 0.0
        c0 = md - c1 * my
        keep = [(y, d) for y, d in pts if abs(d - (c0 + c1 * y)) <= 0.5 * med_h]
        if len(keep) == len(pts) or len(keep) < 4:
            break
        pts = keep
    return c0, c1


def align(av, pv, tol):
    """выравнивание двух возрастающих последовательностей y с сохранением порядка (динамическое программирование);
    пара допустима, если |разница| <= tol; пропуск стоит 0.6 tol"""
    n, m = len(av), len(pv)
    INF = float("inf")
    gap = 0.6 * tol
    D = [[INF] * (m + 1) for _ in range(n + 1)]
    B = [[None] * (m + 1) for _ in range(n + 1)]
    D[0][0] = 0.0
    for i in range(n + 1):
        for j in range(m + 1):
            if i == 0 and j == 0:
                continue
            best, bk = INF, None
            if i and D[i - 1][j] + gap < best:
                best, bk = D[i - 1][j] + gap, (i - 1, j, False)
            if j and D[i][j - 1] + gap < best:
                best, bk = D[i][j - 1] + gap, (i, j - 1, False)
            if i and j:
                d = abs(av[i - 1] - pv[j - 1])
                if d <= tol and D[i - 1][j - 1] + d < best:
                    best, bk = D[i - 1][j - 1] + d, (i - 1, j - 1, True)
            D[i][j], B[i][j] = best, bk
    out, i, j = [], n, m
    while (i, j) != (0, 0):
        pi, pj, mt = B[i][j]
        if mt:
            out.append((i - 1, j - 1))
        i, j = pi, pj
    return out[::-1]



def _ocr_like(x, y):
    """числа похожи как ошибка распознавания одной цифры: 151/51, 130/140, 2310/231"""
    a, b = str(x), str(y)
    if len(a) == len(b):
        return sum(c1 != c2 for c1, c2 in zip(a, b)) == 1
    if abs(len(a) - len(b)) == 1:
        lo, hi = (a, b) if len(a) < len(b) else (b, a)
        return any(hi[:k] + hi[k + 1:] == lo for k in range(len(hi)))
    return False


def _join_cells(people):
    """ячейка «2 11»: распознавание разбило номер 211 на два числа — склеиваем, если склеенное продолжает
    соседей того же пола (до трёх с каждой стороны: они сами могут быть с ошибкой), а первое число — нет"""
    by_cell = {}
    for p in people:
        if "split_cell" in p["flags"] and p.get("num_id") and not p.get("_drop"):
            by_cell.setdefault(p["num_id"], []).append(p)
    for cell in by_cell.values():
        if len(cell) != 2 or cell[0]["sex"] != cell[1]["sex"]:
            continue
        cell.sort(key=lambda p: p["cy"])
        sex = cell[0]["sex"]
        others = sorted([p for p in people if p["sex"] == sex and not p.get("_drop") and str(p["no"]).isdigit()
                         and all(p is not c for c in cell)], key=lambda p: p["cy"])
        prev = [int(p["no"]) for p in others if p["cy"] < cell[0]["cy"]][-3:]
        nxt = [int(p["no"]) for p in others if p["cy"] > cell[1]["cy"]][:3]
        joined = int(cell[0]["no"] + cell[1]["no"])

        def fits(val):
            return any(q + 1 <= val <= q + 4 for q in prev) or any(q - 4 <= val <= q - 1 for q in nxt)
        if fits(joined) and not fits(int(cell[0]["no"])):
            keep, gone = cell
            raw = f"{keep['no']} {gone['no']}"
            keep["no"] = str(joined)
            keep["cy"] = (keep["cy"] + gone["cy"]) / 2
            keep["flags"] = [f for f in keep["flags"] if f != "split_cell"] + [f"joined_cell:{raw}"]
            if keep.get("age") in ("", None) and gone.get("age") not in ("", None):
                keep["age"], keep["age_id"] = gone["age"], gone.get("age_id")
            gone["_drop"] = True


def _fix_sequence(people, sex):
    """соседи сверху и снизу согласованы (a и a+2) — средний a+1; ошибка одной цифры («2013» после 212,
    «151» вместо 51) — по предыдущему; первый номер — по двум следующим. Только номера, без удаления."""
    seq = sorted([p for p in people if p["sex"] == sex and not p.get("_drop") and str(p["no"]).isdigit()],
                 key=lambda p: p["cy"])
    n = len(seq)
    if n < 3:
        return seq
    v = [int(p["no"]) for p in seq]
    for i in range(n):
        a = v[i - 1] if i > 0 else None
        b = v[i + 1] if i + 1 < n else None
        x = v[i]
        fix = None
        if a is not None and b is not None and b - a == 2 and x != a + 1:
            fix = a + 1
        elif a is not None and abs(x - (a + 1)) > 3 and _ocr_like(x, a + 1) and (b is None or b == a + 2 or _ocr_like(b, a + 2)):
            fix = a + 1
        elif a is None and b is not None and i + 2 < n and v[i + 2] == b + 1 and abs(x - (b - 1)) > 3 and _ocr_like(x, b - 1):
            fix = b - 1
        if fix is not None:
            seq[i]["flags"].append(f"no_fixed:{x}")
            seq[i]["no"] = str(fix)
            v[i] = fix
    return seq


def repair_numbers(people):
    """Номера мужчин и женщин сквозные: на листе сверху вниз идут подряд. По соседям чинятся
    ошибки распознавания (флаги no_fixed:<как распознано>, joined_cell:<как распознано>) — два прохода,
    потому что исправленные соседи помогают следующим. Лишнее число между согласованными соседями
    (a, X, a+1) — не номер человека (чаще № двора, слипшийся с номером): человек без возраста убирается,
    число уходит в кандидаты № двора; с возрастом — остаётся без номера (extra_number). Пропуск (a, a+2)
    заполняется единственным человеком того же пола без номера между ними (no_restored).
    -> (люди, лишние числа [(cy, значение, id блока)])"""
    for _ in range(2):
        _join_cells(people)
        for sex in ("M", "F"):
            _fix_sequence(people, sex)
    extra = []
    for sex in ("M", "F"):
        seq = sorted([p for p in people if p["sex"] == sex and not p.get("_drop") and str(p["no"]).isdigit()],
                     key=lambda p: p["cy"])
        v = [int(p["no"]) for p in seq]
        for i in range(1, len(seq) - 1):
            a, x, b = v[i - 1], v[i], v[i + 1]
            if b - a == 1 and x not in (a, b):
                p = seq[i]
                if p.get("age") in ("", None):
                    extra.append((p["cy"], p["no"], p.get("num_id")))
                    p["_drop"] = True
                else:
                    p["flags"].append(f"extra_number:{p['no']}")
                    p["no"] = ""
        seq = [p for p in seq if not p.get("_drop") and str(p["no"]).isdigit()]
        loose = [p for p in people if p["sex"] == sex and not p.get("_drop") and not str(p["no"]).isdigit()]
        for p1, p2 in zip(seq, seq[1:]):
            if int(p2["no"]) - int(p1["no"]) == 2:
                mid = [q for q in loose if p1["cy"] < q["cy"] < p2["cy"]]
                if len(mid) == 1:
                    mid[0]["no"] = str(int(p1["no"]) + 1)
                    mid[0]["flags"] = [f for f in mid[0]["flags"] if f != "age_without_number"] + ["no_restored"]
    return [p for p in people if not p.get("_drop")], extra


# ----------------------------------------------------------------------------- страница
def process(node, a):
    size = node.get("originalImageSize") or {}
    W, H = size.get("width"), size.get("height")
    jb = node.get("joinedTextBlocks") or []
    tb = node.get("textBlocks") or []
    rep = {"page": node.get("sheetPageNumber"), "node_id": node.get("id"), "url": node.get("_url"),
           "image": [W, H], "flags": [], "halves": [], "persons": [], "settlement_marks": [],
           "skipped": {"show_columns": 0, "noise": 0}, "orphans": []}
    if not (W and H) or not jb or len(jb) != len(tb):
        rep["flags"].append(f"count_mismatch:joined={len(jb)},text={len(tb)}")
        return rep
    blks = [Blk(i, j, t) for i, (j, t) in enumerate(zip(jb, tb))]
    for b in blks:
        classify(b)

    nums = [b for b in blks if b.kind in ("num", "frac")]
    if len(nums) < 4:
        rep["flags"].append("no_numbers")
        return rep
    med_h = statistics.median(b.h for b in nums)
    med_w = statistics.median(b.w for b in nums)

    # 1. шапка таблицы (если есть на странице): нижняя граница по словам заголовков
    heads = [b for b in blks if b.kind == "text" and b.cy < 0.35 * H and not re.search(r"\d", b.text)
             and HEADER_WORDS.search(norm(b.text))]
    # низ шапки — по заголовкам столбцов данных (столбцы «Показанія дѣйства» выше и длиннее, их не берём)
    hdr_bottom = max((b.y1 for b in heads if not SKIP_HEAD.search(norm(b.text))), default=0)
    rep["header"] = [b.text for b in sorted(heads, key=lambda b: (b.cy, b.cx))]

    # 2. Основной блок: широкие текстовые блоки со списками людей, сгруппированные по x
    # блок со списком людей может начинаться внутри шапки (верх выше её низа) — берём по нижнему краю
    body = [b for b in blks if (b.cy > hdr_bottom) or (b.kind != "text" and b.cy > hdr_bottom - med_h) or (b.kind == "text" and b.y1 > hdr_bottom + 0.3 * med_h and not HEADER_WORDS.search(norm(b.text)))]
    def letters(s):
        return len(re.findall(r"[^\W\d_]", s))
    settle_blocks = []
    cand = []
    for b in body:
        if b.kind != "text":
            continue
        name, how = settlement_of(b.text)
        if name and letters(b.text) < 45:
            settle_blocks.append((b, name, how))
            continue
        if b.w >= a.main_min_w * W and letters(b.text) >= 10:
            cand.append(b)
    # заголовок НП может стоять и в шапке страницы
    for b in heads + [x for x in blks if x.cy <= hdr_bottom and x.kind == "text"]:
        name, how = settlement_of(b.text)
        if name and all(b is not s[0] for s in settle_blocks):
            settle_blocks.append((b, name, how))
    groups = []
    for b in sorted(cand, key=lambda b: b.cx):
        for g in groups:
            gx0, gx1 = pct([x.x0 for x in g], 0.5), pct([x.x1 for x in g], 0.5)
            ov = min(b.x1, gx1) - max(b.x0, gx0)
            if ov > 0.5 * min(b.w, gx1 - gx0):
                g.append(b)
                break
        else:
            groups.append([b])
    groups = [g for g in groups if len(g) >= 2 or sum(x.h for x in g) > 0.12 * H]
    groups.sort(key=lambda g: -sum(x.h for x in g))
    groups = sorted(groups[: a.max_halves], key=lambda g: pct([x.x0 for x in g], 0.5))
    if not groups:
        rep["flags"].append("no_main_block")
        return rep

    # 3. числа данных (без шапки и шума: номер листа, слишком крупные блоки)
    data_nums = []
    for b in body:
        if b.kind not in ("num", "frac", "multi"):
            continue
        if b.kind != "multi" and (b.h > 2.2 * med_h or b.w > 2.6 * med_w):
            rep["skipped"]["noise"] += 1
            continue
        data_nums.append(b)
    ymid = statistics.median(b.cy for b in data_nums) if data_nums else H / 2

    halves = []
    for gi, g in enumerate(groups):
        mx0 = pct([x.x0 for x in g], 0.25)
        mx1 = pct([x.x1 for x in g], 0.75)
        halves.append({"no": gi + 1, "main": g, "x0": mx0, "x1": mx1})
    # границы зон: слева — до правой границы предыдущей половины; справа — до левой зоны следующей
    for k, hf in enumerate(halves):
        prev_x1 = halves[k - 1]["x1"] if k else 0
        nxt_x0 = halves[k + 1]["x0"] if k + 1 < len(halves) else W
        hf["left_zone"] = (max(prev_x1 + 0.02 * W, hf["x0"] - a.left_zone * W), hf["x0"] + 0.03 * W)
        hf["right_zone"] = (hf["x1"] - 0.04 * W, min(hf["x1"] + a.right_zone * W, nxt_x0 - a.left_zone * W + 0.0 * W if k + 1 < len(halves) else W))

    gap = a.col_gap * med_w
    persons_all = []
    for hf in halves:
        lz, rz = hf["left_zone"], hf["right_zone"]
        left = [b for b in data_nums if lz[0] <= b.cx <= lz[1] and b.kind in ("num", "multi")]
        right = [b for b in data_nums if rz[0] <= b.cx <= rz[1] and b.kind in ("num", "frac")]
        slope = deskew_slope(left + right, 0.15 * med_w, ymid)
        hf["slope"] = slope
        lcols = cluster_columns(left, gap, ymid, slope)
        rcols = cluster_columns(right, gap, ymid, slope)
        if len([c for c in rcols if len(c["blocks"]) >= 3]) < 2:
            # столбцы возраста дальше обычного (узкий текст Основного блока, форма 1826 г. с широкими
            # полями): зона справа расширяется до левых столбцов следующего листа
            k = halves.index(hf)
            lim = halves[k + 1]["x0"] - 1.2 * a.left_zone * W if k + 1 < len(halves) else W
            rz2 = (rz[0], max(rz[1], min(hf["x1"] + 2.8 * a.right_zone * W, lim)))
            right2 = [b for b in data_nums if rz2[0] <= b.cx <= rz2[1] and b.kind in ("num", "frac")]
            rcols2 = [c for c in cluster_columns(right2, gap, ymid, slope) if len(c["blocks"]) >= 3]
            if len(rcols2) >= 2:
                right, rcols = right2, rcols2
                rep["flags"].append(f"half{hf['no']}:age_zone_wide")
        # роли слева: ближайшие к Основному блоку три столбца, справа налево: женщины, мужчины, двор
        lcols = [c for c in lcols if len(c["blocks"]) >= 1]
        roles = {}
        pick = lcols[-3:]
        names = ["yard", "m_no", "f_no"][-len(pick):] if pick else []
        if len(pick) == 2:
            # два столбца: редкий левый — это двор (номер стоит только у первого в семье)
            if len(pick[0]["blocks"]) < 0.45 * len(pick[1]["blocks"]):
                names = ["yard", "m_no"]
                rep["flags"].append(f"half{hf['no']}:left_columns_2_sex_unknown")
            else:
                names = ["m_no", "f_no"]
                rep["flags"].append(f"half{hf['no']}:yard_column_not_found")
        for c, nm in zip(pick, names):
            roles[nm] = c
        for c in lcols[:-3]:
            rep["skipped"]["noise"] += len(c["blocks"])
        rpick = rcols[:2]
        rnames = ["age_m", "age_f"][: len(rpick)]
        for c, nm in zip(rpick, rnames):
            roles[nm] = c
        for c in rcols[2:]:
            rep["skipped"]["show_columns"] += len(c["blocks"])
        if len(rpick) < 2:
            rep["flags"].append(f"half{hf['no']}:age_columns_{len(rpick)}")
        hf["columns"] = {nm: {"center_x": round(c["center"]), "center_x_rel": round(c["center"] / W, 4),
                              "slope": round(c["b"], 4), "cells": len(c["blocks"])} for nm, c in roles.items()}

        # 4. люди: номера мужчин и женщин (составной блок «358 359» делится по высоте)
        people = []
        for sex, role in (("M", "m_no"), ("F", "f_no")):
            for b in roles.get(role, {"blocks": []})["blocks"]:
                vals = b.vals
                for k, v in enumerate(vals):
                    hk = b.h / len(vals)
                    cy = b.y0 + hk * (k + 0.5)
                    people.append({"sex": sex, "no": v, "age": "", "cy": cy, "num_id": b.id,
                                   "flags": ["split_cell"] if len(vals) > 1 else []})
        # возраст: пара «номер — возраст» по y. Сдвиг строки между левыми и правыми столбцами зависит от y
        # (поворот и изгиб листа у корешка), поэтому он оценивается прямой shift(y) по надёжным парам,
        # а затем последовательности выравниваются с сохранением порядка (без перекрёстных пар).
        for sex, role in (("M", "age_m"), ("F", "age_f")):
            ages = stable_by_y(roles.get(role, {"blocks": []})["blocks"], 0.15 * med_h)
            cands = sorted([p for p in people if p["sex"] == sex], key=lambda p: p["cy"])
            pairs = sorted(((abs(ag.cy - p["cy"]), i, j) for i, ag in enumerate(ages)
                            for j, p in enumerate(cands)), key=lambda t: t[0])
            used_a, used_p, first = set(), set(), []
            for d, i, j in pairs:
                if d > 1.0 * med_h or i in used_a or j in used_p:
                    continue
                used_a.add(i); used_p.add(j); first.append((ages[i].cy, ages[i].cy - cands[j]["cy"]))
            c0, c1 = shift_line(first, med_h)
            sh = lambda y: c0 + c1 * y
            match = align([ag.cy - sh(ag.cy) for ag in ages], [p["cy"] for p in cands], a.age_tol * med_h)
            used_a = set()
            for i, j in match:
                used_a.add(i)
                cands[j]["age"] = ages[i].vals[0] if ages[i].vals else ages[i].text
                cands[j]["age_id"] = ages[i].id
            for i, ag in enumerate(ages):
                if i not in used_a:
                    people.append({"sex": sex, "no": "", "age": ag.vals[0] if ag.vals else ag.text,
                                   "cy": ag.cy - sh(ag.cy), "age_id": ag.id, "flags": ["age_without_number"]})
        people.sort(key=lambda p: p["cy"])
        # 4а. номера по соседям: ошибки распознавания, лишние числа, пропуски
        people, extra = repair_numbers(people)
        # 5. номер двора: к первому человеку двора (ближайший по y), дальше действует вниз
        yards = sorted([(yb.cy, v, yb.text, yb.id) for yb in roles.get("yard", {"blocks": []})["blocks"] for v in yb.vals]
                       + [(cy, v, v, bid) for cy, v, bid in extra], key=lambda t: t[0])
        for ycy, v, ytext, yid in yards:
            best = min(people, key=lambda p: abs(p["cy"] - ycy), default=None)
            if best is None or abs(best["cy"] - ycy) > 1.2 * med_h:
                rep["orphans"].append({"text": ytext, "id": yid, "why": "yard_without_person"})
                continue
            if best.get("yard_mark"):
                best["flags"].append("two_yard_numbers")
            best["yard_mark"] = v
        # 6. Основной блок: человек -> блок по y (самый низкий из содержащих)
        mains = sorted(hf["main"], key=lambda b: b.y0)
        for p in people:
            # глубина: насколько центр строки внутри блока (у края блока решение неустойчиво к округлению)
            depth = {m.id: min(p["cy"] - m.y0, m.y1 - p["cy"]) for m in mains}
            inside = [m for m in mains if depth[m.id] > 0.15 * med_h]
            edge = [m for m in mains if depth[m.id] > -0.3 * med_h]
            if inside:
                m = min(inside, key=lambda m: m.h)
                if len(inside) > 1:
                    p["flags"].append("nested_block")
            elif edge:
                m = max(edge, key=lambda m: depth[m.id])
                p["flags"].append("block_edge")
            else:
                near = sorted(mains, key=lambda m: min(abs(p["cy"] - m.y0), abs(p["cy"] - m.y1)))
                if near and min(abs(p["cy"] - near[0].y0), abs(p["cy"] - near[0].y1)) <= 1.2 * med_h:
                    m = near[0]
                    p["flags"].append("y_near")
                else:
                    m = None
                    p["flags"].append("no_main_block")
            p["block_id"] = m.id if m else None
            p["names_text"] = m.text if m else ""
        # 6а. текст блока -> по людям (по именам в тексте и полу строк), каждый человек — своя строка
        by_block = {}
        for p in people:
            if p["block_id"]:
                by_block.setdefault(p["block_id"], []).append(p)
        for bid, ps in by_block.items():
            parts = split_block(ps[0]["names_text"], [p["sex"] for p in ps])
            for p, (txt, fl) in zip(ps, parts):
                p["person_text"] = txt
                if fl:
                    p["flags"].append("split:" + fl)
        for p in people:
            p.setdefault("person_text", "")
        cnt = {}
        for p in people:
            if p["block_id"]:
                cnt[p["block_id"]] = cnt.get(p["block_id"], 0) + 1
                p["person_in_block"] = cnt[p["block_id"]]
            else:
                p["person_in_block"] = ""
        # 7. проверка: номера мужчин и женщин идут подряд
        for sex in ("M", "F"):
            seq = [int(p["no"]) for p in people if p["sex"] == sex and p["no"]]
            breaks = sum(1 for x, y in zip(seq, seq[1:]) if not (0 < y - x <= 3))
            if seq and breaks:
                rep["flags"].append(f"half{hf['no']}:seq_breaks_{sex}={breaks}/{len(seq)}")
        hf["people"] = people
        hf["settlements"] = sorted(
            [(b.cy, name, how, b.text) for b, name, how in settle_blocks
             if b.x1 > hf["x0"] - 0.05 * W and b.x0 < hf["x1"] + 0.02 * W], key=lambda t: t[0])
        hf["blocks"] = [{"block_id": m.id, "text_block_id": m.tid, "bbox": m.bb(), "names_text": m.text,
                         "persons": cnt.get(m.id, 0)} for m in mains]
        persons_all.append(hf)

    # 8. порядок людей страницы, НП и двор (двор — вниз до следующего номера)
    for hf in persons_all:
        marks = list(hf["settlements"])
        for p in hf["people"]:
            p["settlement_here"] = None
            while marks and marks[0][0] <= p["cy"]:
                _, name, how, text = marks.pop(0)
                rep["settlement_marks"].append({"half": hf["no"], "name": name, "how": how, "text": text})
                p["settlement_here"] = name
            p["half"] = hf["no"]
            rep["persons"].append(p)
        for _, name, how, text in marks:   # заголовок НП ниже последнего человека половины
            rep["settlement_marks"].append({"half": hf["no"], "name": name, "how": how, "text": text, "after_last": True})
        rep["halves"].append({"no": hf["no"], "main_x": [round(hf["x0"]), round(hf["x1"])],
                              "main_x_rel": [round(hf["x0"] / W, 4), round(hf["x1"] / W, 4)],
                              "columns": hf["columns"], "blocks": hf["blocks"], "people": len(hf["people"])})
    for p in rep["persons"]:
        p["cy"] = round(p["cy"])
    rep["median_number_h"] = med_h
    if rep["orphans"]:
        rep["flags"].append(f"orphans:{len(rep['orphans'])}")
    return rep


def resolve_settlement(name, cur, year):
    """заголовок НП не распознан (other:…) — следующий по порядку НП округи (порядок зависит от года)"""
    if not name.startswith("other:"):
        return name, ""
    order = ORDER_BEFORE_1750 if (year and year < 1750) else ORDER_FROM_1750
    if cur in order and order.index(cur) + 1 < len(order):
        return order[order.index(cur) + 1], f"НП определён по порядку (заголовок «{name[6:]}» не распознан)"
    return "чужой НП: " + name[6:], ""


def numbering_restart(persons, i):
    """человек i начинает ведомость прихода: № 1–2 его пола, а следующие номера того же пола — малые и
    растут (сквозная нумерация мужчин и женщин начинается заново с первого двора первого НП)"""
    p = persons[i]
    if not str(p.get("no", "")).isdigit() or int(p["no"]) > 2:
        return False
    nxt = [int(q["no"]) for q in persons[i + 1:] if q["sex"] == p["sex"] and str(q.get("no", "")).isdigit()][:2]
    return len(nxt) == 2 and int(p["no"]) < nxt[0] < nxt[1] <= 12


def assign_running(pages, year=None):
    """двор и населённый пункт по порядку страниц (двор и НП действуют, пока не встретится следующий).
    До первого заголовка НП: если нумерация людей начинается заново с 1, с этого человека начинается
    ведомость прихода — её первый НП по порядку (село Троицкое); люди выше — хвост предыдущей ведомости
    в том же деле (остаются «не определён»)."""
    cur_s, cur_y = None, ""
    order = ORDER_BEFORE_1750 if (year and year < 1750) else ORDER_FROM_1750
    for rep in pages:
        persons = rep.get("persons", [])
        for i, p in enumerate(persons):
            if cur_s is None and not p.get("settlement_here") and numbering_restart(persons, i):
                cur_s, cur_y = order[0], ""
                p["flags"].append("НП по порядку: начало ведомости (нумерация людей с 1)")
            if p.get("settlement_here"):
                cur_s, note = resolve_settlement(p["settlement_here"], cur_s, year)
                if note:
                    p["flags"].append(note)
                cur_y = ""
            if p.get("yard_mark"):
                cur_y = p["yard_mark"]
            p["settlement"] = cur_s or "не определён (начало диапазона)"
            p["yard"] = cur_y
        for m in rep.get("settlement_marks", []):
            if m.get("after_last"):
                cur_s, cur_y = resolve_settlement(m["name"], cur_s, year)[0], ""


def csv_rows(rep, year=None):
    for p in rep.get("persons", []):
        yield {"year": year or "", "page": rep.get("page"), "half": p.get("half"), "settlement": p.get("settlement", ""),
               "yard": p.get("yard", ""), "person_text": p.get("person_text", ""),
               "sex": "м" if p["sex"] == "M" else "ж", "no": p.get("no", ""),
               "age": p.get("age", ""), "birth_year": birth_year(year, p.get("age")),
               "person_in_block": p.get("person_in_block", ""),
               "block_id": p.get("block_id") or "", "names_text": p.get("names_text", ""),
               "flags": ";".join(p.get("flags", []))}




def fill_yards(rows):
    """Пустой «Двор №» — по ближайшим дворам с номером того же года (как в расширении, ConfessionRows.fillYards):
    перед первым номером N -> N-1; между P и N -> P+1, если N-P > 1, иначе P; после последнего P -> P+1.
    rows: [{"year", "yard"}] по порядку -> [(yard, calc)]"""
    def num(v):
        try:
            return int(str(v).strip())
        except (TypeError, ValueError):
            return None
    out = [(r.get("yard"), False) for r in rows]
    i = 0
    while i < len(rows):
        if num(rows[i].get("yard")) is not None:
            i += 1
            continue
        y = rows[i].get("year")
        j = i
        while j < len(rows) and num(rows[j].get("yard")) is None and rows[j].get("year") == y:
            j += 1
        P = num(out[i - 1][0]) if i > 0 and rows[i - 1].get("year") == y else None
        N = num(rows[j].get("yard")) if j < len(rows) and rows[j].get("year") == y else None
        v = None
        if P is not None and N is not None:
            v = P + 1 if N - P > 1 else P
        elif N is not None:
            v = max(1, N - 1)
        elif P is not None:
            v = P + 1
        if v is not None:
            for k in range(i, j):
                out[k] = (v, True)
        i = j
    return out

DEBUG_DIR = "yaarchive_debug"


def default_out_dir(inputs):
    """папка результатов по умолчанию: <папка входных данных>/yaarchive_debug/<время запуска>/"""
    import datetime
    p = Path(inputs[0]).resolve()
    base = p if p.is_dir() else p.parent
    if DEBUG_DIR in base.parts:          # вход уже внутри yaarchive_debug — пишем в её корень
        base = Path(*base.parts[:base.parts.index(DEBUG_DIR)])
    d = base / DEBUG_DIR / datetime.datetime.now().strftime("%Y-%m-%d-%H-%M-%S")
    d.mkdir(parents=True, exist_ok=True)
    return d


def collect_inputs(inputs):
    files = []
    for p in inputs:
        p = Path(p)
        if p.is_dir():   # прошлые результаты в yaarchive_debug/ не считаются входными страницами
            files += sorted(f for f in p.rglob("*") if f.suffix in (".json", ".html")
                            and DEBUG_DIR not in f.relative_to(p).parts)
        else:
            files.append(p)
    return files

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", help="файлы .json/.html или папки")
    ap.add_argument("--out-json", default=None, help="по умолчанию <папка входа>/yaarchive_debug/<время>/confession_pages.json")
    ap.add_argument("--out-csv", default=None, help="по умолчанию <папка входа>/yaarchive_debug/<время>/confession_people.csv")
    ap.add_argument("--main-min-w", type=float, default=0.08, help="мин. ширина блока Основного столбца, доля ширины скана")
    ap.add_argument("--left-zone", type=float, default=0.14, help="ширина зоны трёх левых столбцов, доля ширины скана")
    ap.add_argument("--right-zone", type=float, default=0.09, help="ширина зоны двух столбцов возраста, доля ширины скана")
    ap.add_argument("--col-gap", type=float, default=0.35, help="разрыв между столбцами, доля медианной ширины числа")
    ap.add_argument("--age-tol", type=float, default=0.8, help="допуск по y для пары номер-возраст, доля высоты числа")
    ap.add_argument("--year", type=int, default=None, help="год документа (порядок НП: до 1750 / с 1750)")
    ap.add_argument("--max-halves", type=int, default=2, help="сколько листов на скане (разворот = 2)")
    a = ap.parse_args()

    files = collect_inputs(a.inputs)
    if not a.out_json or not a.out_csv:
        od = default_out_dir(a.inputs)
        a.out_json = a.out_json or str(od / "confession_pages.json")
        a.out_csv = a.out_csv or str(od / "confession_people.csv")
    pages = []
    for f in files:
        try:
            rep = process(load_node(f), a)
        except Exception as e:  # одна битая страница не останавливает пакет
            rep = {"page": None, "flags": [f"error:{type(e).__name__}:{e}"], "persons": [], "halves": []}
        rep["source"] = str(f)
        pages.append(rep)
    assign_running(pages, a.year)
    n = 0
    with open(a.out_csv, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=CSV_COLS)
        w.writeheader()
        all_rows = [row for rep in pages for row in csv_rows(rep, a.year)]
        for row, (yard, calc) in zip(all_rows, fill_yards(all_rows)):
            if calc:
                row["yard"] = yard
                row["flags"] = ";".join(x for x in ["yard_calc", row.get("flags") or ""] if x)
            w.writerow(row); n += 1
        for rep in pages:
            cols = "; ".join(f"лист {h['no']}: " + ", ".join(f"{k}={v['cells']}" for k, v in h["columns"].items())
                             for h in rep.get("halves", []))
            print(f"стр. {rep.get('page')}: людей {len(rep.get('persons', []))} | {cols} | флаги: {rep['flags'] or '-'}")
    Path(a.out_json).write_text(json.dumps(pages, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(f"готово: {len(pages)} стр., {n} человек -> {a.out_csv}, {a.out_json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
