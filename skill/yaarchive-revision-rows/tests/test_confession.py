#!/usr/bin/env python3
"""Самопроверка навыка на исповедных ведомостях: 4 страницы (1739, 1750, 1786, 1845)
и устойчивость к разрешению скана (координаты масштабируются 1.0 / 0.6 / 0.35 / 1.7).
Запуск: python tests/test_confession.py"""
import copy, json, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
import extract_confession as E

class A:
    main_min_w = 0.08; left_zone = 0.14; right_zone = 0.09; col_gap = 0.35; max_halves = 2; age_tol = 0.8

EXPECT = json.loads((HERE / "expected_confession.json").read_text(encoding="utf-8")) if (HERE / "expected_confession.json").exists() else {}

def scaled(node, k):
    n = copy.deepcopy(node)
    n["originalImageSize"] = {"width": round(n["originalImageSize"]["width"] * k), "height": round(n["originalImageSize"]["height"] * k)}
    for j in n["joinedTextBlocks"]:
        j["points"] = [{"x": round(p["x"] * k), "y": round(p["y"] * k)} for p in j["points"]]
    return n

def key(rep):
    return [(p["half"], p["sex"], p["no"], p["age"], p.get("yard_mark", ""), p["block_id"]) for p in rep["persons"]]

def main():
    ok = True
    out = {}
    for f in sorted((HERE.parent / "assets").glob("confession_*_fixture.json")):
        node = E.load_node(f)
        base = E.process(node, A)
        E.assign_running([base])
        P = base["persons"]
        summ = {"persons": len(P), "with_no": sum(1 for p in P if p["no"]), "with_age": sum(1 for p in P if p["age"]),
                "with_block": sum(1 for p in P if p["block_id"]), "with_yard": sum(1 for p in P if p.get("yard")),
                "settlements": [m["name"] for m in base["settlement_marks"]]}
        out[f.name] = summ
        line = f"{f.name}: людей {summ['persons']}, с № {summ['with_no']}, с возрастом {summ['with_age']}, с блоком {summ['with_block']}, с двором {summ['with_yard']}, НП {summ['settlements']}"
        if EXPECT.get(f.name) and EXPECT[f.name] != summ:
            ok = False; line += f"  !!! ожидалось {EXPECT[f.name]}"
        print(line)
        for k in (0.5, 0.75, 1.5, 2.0, 0.35):
            r = E.process(scaled(node, k), A)
            ka, kb = key(base), key(r)
            same = sum(1 for x in kb if x in ka) / max(len(ka), 1)
            need = 1.0 if k >= 0.5 else 0.90   # x0.35 — скан ~1800 px, погрешность округления сопоставима с цифрой
            good = same >= need and abs(len(ka) - len(kb)) <= (0 if k >= 0.5 else 2)
            ok &= good
            print(f"    масштаб x{k}: совпадает {same:.0%} ({len(kb)} чел.) {'OK' if good else 'ОШИБКА'}")
    if "--save" in sys.argv:
        (HERE / "expected_confession.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("ИТОГ:", "OK" if ok else "ЕСТЬ РАСХОЖДЕНИЯ")
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
