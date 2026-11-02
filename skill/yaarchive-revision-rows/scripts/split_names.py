"""
Деление текста Основного блока (список людей семьи, одна строка распознавания на всех) на людей.

Координат отдельных строк в данных нет, поэтому текст делится по именам: имя в именительном падеже
из словаря (assets/names_ru.json) начинает нового человека. Какие имена — люди, а какие — ссылки
(«Степана Никитина жена…» — Степана не человек этой строки), решает сверка с полом строк таблицы
(м№ / ж№ по порядку сверху вниз): выравнивание с сохранением порядка.
Слова между именами: отчество / фамилия сразу после имени — к предыдущему человеку,
слова родства («жена его», «дѣти ихъ», «сынъ», «вдова»…) — к следующему.
Текст не исправляется: каждое слово остаётся ровно таким, как распознано.
"""
import json
import re
from pathlib import Path

_MAP = str.maketrans({"ѣ": "е", "і": "и", "i": "и", "ѳ": "ф", "ѵ": "и", "ё": "е", "ѡ": "о", "ꙋ": "у"})
RELATION = {"сн", "снъ", "дщ", "дщерь", "жена", "муж", "сын", "сына", "сыновья", "сыновя", "сынов", "дочь", "дочери", "дочерь", "дети", "детей", "дочи",
            "брат", "братья", "брата", "сестра", "сестры", "мать", "мачеха", "отец", "отчим", "вдова", "вдовец", "вдов",
            "зять", "сноха", "невестка", "внук", "внуки", "внучка", "внучки", "племянник", "племянница", "племянники",
            "пасынок", "пасынки", "падчерица", "падчерицы", "приемыш", "приемышь", "приемышъ", "теща", "тесть", "деверь",
            "свекровь", "свекор", "тетка", "дядя", "шурин", "свояк", "золовка", "крестник", "крестница", "работник",
            "работница", "солдатка", "салдатка", "солдат", "бобыль", "бобылка", "девка", "свойственник", "питомец",
            "воспитанник", "воспитанница", "кума", "кум", "сирота", "двоюродной", "двоюродный", "родной", "сводной"}
_names = None


def nk(w):
    w = (w or "").lower().replace("ѯ", "кс").translate(_MAP)
    w = re.sub(r"[^а-я]", "", w)
    return re.sub(r"ъ$", "", w)


def names():
    global _names
    if _names is None:
        p = Path(__file__).resolve().parent.parent / "assets" / "names_ru.json"
        d = json.loads(p.read_text(encoding="utf-8"))
        _names = {"M": set(d["M"]), "F": set(d["F"])}
    return _names


def _edit1(a, b):
    if a == b:
        return True
    if abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b)) == 1
    if len(a) > len(b):
        a, b = b, a
    i = 0
    while i < len(a) and a[i] == b[i]:
        i += 1
    return a[i:] == b[i + 1:]


PRON = {"его", "ево", "ея", "ее", "её", "их", "ихь", "ихъ", "же", "жъ", "ж", "него", "ней", "нея", "оного", "оной"}


def name_sex(tok, nxt=(), prv=()):
    """(пол, ссылка?) для имени в именительном падеже или None.
    ссылка=True — имя может быть ссылкой в родительном падеже («Ѳедосья Евдокимова жена» / «Степана … жена»):
    решает сверка с полом строк таблицы."""
    N = names()
    k = nk(tok)
    if len(k) < 3:
        return None
    nx = [nk(t) for t in nxt[:2]]
    rel_after = bool(nx) and (nx[0] in RELATION or (len(nx) > 1 and nx[1] in RELATION
                                                     and re.search(r"(ова|ева|ина|ына|а|я)$", nx[0])))
    gen_form = (k.endswith(("а", "я")) and (k[:-1] in N["M"] or k[:-1] + "й" in N["M"] or k[:-2] + "ий" in N["M"])) \
        or (k.endswith(("ы", "и")) and (k[:-1] + "а" in N["M"] | N["F"] or k[:-1] + "я" in N["M"] | N["F"]))
    # «жена его Ульяна», «дочь их Дарья» — после слова родства это сам человек, а не ссылка
    after_rel = any(nk(t) in RELATION for t in prv[-2:])
    ref = bool(gen_form and rel_after and not after_rel)
    if k in N["M"]:
        return "M", ref
    if k in N["F"]:
        return "F", ref
    if gen_form or re.search(r"(ов|ев|ин|ова|ева|ина|ича|вна|овы|евы)$", k):
        return None
    if len(k) >= 5:
        hits = {s for s in ("M", "F") for n in N[s] if abs(len(n) - len(k)) <= 1 and n[:1] == k[:1] and _edit1(k, n)}
        if len(hits) == 1:
            return hits.pop(), False
    return None


def is_ref(tok, seen, nxt=()):
    """слово-ссылка на другого человека: имя в родительном падеже («Никиты», «Степана», «Гаврилы»)
    или отчество от имени, уже названного в блоке («Евдокимова» после «Евдокимъ»)"""
    N = names()
    k = nk(tok)
    if len(k) < 4:
        return False
    if k.endswith(("а", "я")) and (k[:-1] in N["M"] or k[:-1] + "й" in N["M"] or k[:-2] + "ий" in N["M"]):
        return True
    if k.endswith(("ы", "и")) and (k[:-1] + "а" in N["M"] or k[:-1] + "я" in N["M"]):
        return True
    m = re.match(r"(.+?)(ова|ева|ина|ына|ов|ев|ин|ын)$", k)
    nx = [nk(t) for t in nxt[:2]]
    # «Евдокимова жена Пелагея» — ссылка; «Анна Петрова дѣти их Петръ» — отчество Анны (после родства идёт «их»)
    if m and nx and nx[0] in RELATION and not (len(nx) > 1 and nx[1] in PRON):
        base = m.group(1)
        for v in (base, base + "а", base + "я", base + "й", base[:-1] + "ий" if base.endswith("ь") else base + "ий"):
            if v in seen:
                return True
    return False


def _align(cands, sexes):
    """выбор имён-людей: cands [(idx, sex)], sexes ['M'|'F'] строк. Порядок сохраняется."""
    n, m = len(cands), len(sexes)
    NEG = -1e9
    D = [[NEG] * (m + 1) for _ in range(n + 1)]
    B = [[None] * (m + 1) for _ in range(n + 1)]
    D[0][0] = 0.0
    for i in range(n + 1):
        for j in range(m + 1):
            if i == 0 and j == 0:
                continue
            best, bk = NEG, None
            skip = 0.0 if (i and cands[i - 1][2]) else 0.6
            if i and D[i - 1][j] - skip > best:
                best, bk = D[i - 1][j] - skip, (i - 1, j, False)        # имя — не человек строки (ссылка)
            if j and D[i][j - 1] - 1.5 > best:
                best, bk = D[i][j - 1] - 1.5, (i, j - 1, False)        # строка без имени в тексте
            if i and j:
                sc = (1.2 if cands[i - 1][2] else 2.0) if cands[i - 1][1] == sexes[j - 1] else -0.4
                if D[i - 1][j - 1] + sc > best:
                    best, bk = D[i - 1][j - 1] + sc, (i - 1, j - 1, True)
            D[i][j], B[i][j] = best, bk
    out, i, j = {}, n, m
    while (i, j) != (0, 0):
        pi, pj, mt = B[i][j]
        if mt:
            out[j - 1] = i - 1
        i, j = pi, pj
    return out           # строка -> номер кандидата


def split_block(text, sexes):
    """text — текст блока; sexes — пол строк блока сверху вниз. -> [(текст_человека, флаг)] той же длины, что sexes"""
    toks = (text or "").split()
    if not sexes:
        return []
    if len(sexes) == 1:
        return [(text.strip(), "")]
    cands = []
    for i, t in enumerate(toks):
        r = name_sex(t, toks[i + 1:i + 3], toks[max(0, i - 2):i])
        if r:
            cands.append((i, r[0], r[1]))
    match = _align(cands, sexes)
    starts = sorted((cands[c][0], j) for j, c in match.items())
    # граница между людьми: слова родства и всё после них — к следующему человеку
    seg_start = {}
    prev_name = None
    seen = set()
    for pos, j in starts:
        if prev_name is None:
            seg_start[j] = 0
        else:
            k = pos
            gap = list(range(prev_name + 1, pos))
            rel = [g for g in gap if nk(toks[g]) in RELATION]
            if rel:
                k = rel[0]
                while k - 1 > prev_name and nk(toks[k - 1]) in PRON:     # «Его же дочь Вѣра»
                    k -= 1
                # ссылка на другого члена семьи перед словом родства идёт к следующему человеку:
                # «Никиты Григорьева сынъ Степанъ», «Евдокимова жена Пелагея» (Евдоким уже назван выше)
                refs = [g for g in gap if g < k and is_ref(toks[g], seen, toks[g + 1:g + 3])]
                if refs:
                    k = refs[0]
                elif k - 1 > prev_name + 1 and not re.search(r"(ов|ев|ин|овъ|евъ|инъ)$", nk(toks[k - 1])):
                    k -= 1
            seg_start[j] = k
        prev_name = pos
        seen.add(nk(toks[pos]))
    order = sorted(seg_start.items(), key=lambda t: t[1])
    res = [("", "имя в тексте блока не найдено") for _ in sexes]
    for n, (j, st) in enumerate(order):
        en = order[n + 1][1] if n + 1 < len(order) else len(toks)
        seg = " ".join(toks[st:en])
        flag = "" if cands[match[j]][1] == sexes[j] else "пол по имени не совпал со столбцом"
        res[j] = (seg, flag)
    if order and order[0][1] > 0:
        pass
    return res
