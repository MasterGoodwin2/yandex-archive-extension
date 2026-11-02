#!/usr/bin/env python3
"""Самопроверка слоя «люди» для ревизских сказок (scripts/revision_people.py) на стр. 165
(ЦГА Москвы, ф. 51, оп. 8, д. 588, сказка 1850 г. по имению Н. А. Бутурлина, д. Черепкова).
Эталон имён — ручная сверка со сканом (Excel «Ревизская_сказка_1850_Бутурлин_сканы_130-225»).
Запуск: python tests/test_revision_people.py"""
import json, subprocess, sys, tempfile
from pathlib import Path
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

EXPECT_FIO = [
    "Никита Григорьев Стренин", "Степан Никитин", "Федор Степанов", "Николай Степанов", "Алексей Степанов",
    "Василий Степанов", "Алексей меньшой Степанов", "Гаврила Никитин", "Василий Гаврилов", "Павел Гаврилов",
    "Прохор Гаврилов", "Петр Гаврилов", "Пимен Григорьев Стренин", "Алексей Пименов", "Иван Алексеев",
    "Афонасий Пименов", "Алексей Афонасьев", "Марья Иванова", "Вера Степанова", "Палагея Ильина",
    "Марфа Гаврилова", "Прасковья Гаврилова", "Варвара Гаврилова", "Наталья Семенова", "Александра Алексеева",
    "Матрена Алексеева", "Авдотья Павлова", "Палагея Афонасьева"]
EXPECT_SPOT = {  # id -> (отношение, ID отца/мужа, лет по прошлой рев., лет нынче, примечание)
    "165-м1-1": ("глава", "", 55, "", "умер 1847"),
    "165-м1-12": ("сын Гаврилы", "165-м1-8", "новорожд.", "½", ""),
    "165-м2-2": ("сын Пимена Григорьева", "165-м2-1", 19, "", "отдан в рекруты 1845"),
    "165-ж1-2": ("дочь Степана Никитина", "165-м1-2", "", "7½", ""),
    "165-ж5-2": ("дочь Афонасья Пименова", "165-м2-4", "", "мес.", ""),
}

def main():
    with tempfile.TemporaryDirectory() as d:
        x = Path(d) / "p165.xlsx"
        subprocess.run([sys.executable, str(ROOT / "scripts" / "revision_people.py"),
                        str(ROOT / "assets" / "page165_fixture.json"), "--out-xlsx", str(x)], check=True)
        people = json.loads(x.with_suffix(".people.json").read_text(encoding="utf-8"))
        ok = True
        fio = [p["fio"] for p in people]
        if fio != EXPECT_FIO:
            ok = False
            for a, b in zip(fio, EXPECT_FIO):
                if a != b:
                    print(f"  ФИО: {a!r} != {b!r}")
        by = {p["id"]: p for p in people}
        for pid, exp in EXPECT_SPOT.items():
            p = by.get(pid, {})
            got = (p.get("relation"), p.get("ref_id"), p.get("age_prev"), p.get("age_now"), p.get("note"))
            if got != exp:
                ok = False
                print(f"  {pid}: {got} != {exp}")
        present = {s: sum(1 for p in people if p["sex"] == s and p["status"] != "выбыл") for s in "мж"}
        if present != {"м": 14, "ж": 11}:
            ok = False
            print(f"  налицо {present} != м 14, ж 11 (итоги страницы)")
        print("revision_people: OK" if ok else "revision_people: ОШИБКИ")
        return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
