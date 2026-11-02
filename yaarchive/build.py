"""Сборка общего скрипта в один файл: python build.py -> dist/yaarchive.pyz (+ файлы запуска двойным щелчком)."""
import json
import shutil
import stat
import zipapp
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SK = HERE.parent / "skill" / "yaarchive-revision-rows" / "scripts"
DIST = HERE / "dist"
MODULES = [HERE / "yaarchive.py", HERE / "ya_out.py", HERE / "ya_fix.py", HERE / "справочники.json",
           SK / "extract_confession.py", SK / "extract_rows.py", SK / "revision_people.py", SK / "split_names.py"]

COMMAND = """#!/bin/bash
# yaarchive — двойной щелчок (macOS): следить за этой папкой и обрабатывать новые пакеты расширения
cd "$(dirname "$0")"
PY=$(command -v python3)
if [ -z "$PY" ]; then
  echo "Не найден Python 3. Установите его с https://www.python.org/downloads/ (или: xcode-select --install) и запустите снова."
  read -p "Нажмите Enter…"; exit 1
fi
"$PY" yaarchive.pyz "$@"
"""
BAT = """@echo off
rem yaarchive — двойной щелчок (Windows): следить за этой папкой и обрабатывать новые пакеты расширения
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul && (py -3 "%~dp0yaarchive.pyz" %*) || (python "%~dp0yaarchive.pyz" %*)
pause
"""


def main():
    tmp = DIST / "_src"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    for m in MODULES:
        shutil.copy(m, tmp / m.name)
    (tmp / "__main__.py").write_text("import sys\nimport yaarchive\nsys.exit(yaarchive.main())\n", encoding="utf-8")
    out = DIST / "yaarchive.pyz"
    zipapp.create_archive(tmp, out, interpreter="/usr/bin/env python3", compressed=True)
    shutil.rmtree(tmp)
    (DIST / "yaarchive_запуск.command").write_text(COMMAND, encoding="utf-8")
    (DIST / "yaarchive_запуск.bat").write_text(BAT.replace("\n", "\r\n"), encoding="utf-8")
    for f in (out, DIST / "yaarchive_запуск.command"):
        f.chmod(f.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    print(out, out.stat().st_size, "байт")
    make_mac_kit(out)


README_MAC = """yaarchive {ver} — комплект для macOS 12 (Monterey) и новее
================================================================

В комплекте ТРИ разных вещи — ставятся в разные места:

  1_Расширение_Chrome   — расширение Chrome «Яндекс Архив» {ext} (загрузка страниц и сканов).
                          Это НЕ архив: в Chrome подключается ПАПКА yandex-archive-extension
                          (в ней лежит manifest.json), а не zip и не весь комплект.
  2_Скрипт              — общий скрипт yaarchive.pyz (обработка, Excel, GEDCOM, «Исправление ошибок»).
                          В Chrome НЕ ставится: работает в Терминале, рядом с файлом ссылок.
  3_Навык_Claude        — навык для Claude (Настройки → Возможности → Навыки), по желанию.

УСТАНОВКА — один раз
1. Правый щелчок по «Установить.command» → «Открыть» → «Открыть»
   (обычный двойной щелчок macOS заблокирует: файл скачан из интернета).
2. Установщик сам: проверит Python (если нет — предложит поставить), поставит openpyxl,
   спросит папку со ссылками (list_links.html) и положит туда скрипт, скопирует расширение
   в «Документы/yandex-archive-extension» и откроет страницу расширений Chrome.
3. В Chrome: «Режим разработчика» → «Загрузить распакованное расширение» → Cmd+Shift+G → Cmd+V → «Выбрать».

РАБОТА
• Chrome: значок расширения → тип обработки → папка со ссылками → «Начать».
• Скрипт: двойной щелчок по «yaarchive_запуск.command» в папке со ссылками (в первый раз — правый щелчок → «Открыть»).
  Окно следит за папкой: каждый новый пакет расширения обрабатывается сам, итог — в папке «Итог».
• macOS может спросить «Терминал хочет получить доступ к папке Документы/Загрузки» — разрешите.

Подробно: 2_Скрипт/Инструкция_yaarchive.md
"""


def make_mac_kit(pyz):
    import re
    ver = re.search(r'^VERSION = "([^"]+)"', (HERE / "yaarchive.py").read_text(encoding="utf-8"), re.M).group(1)
    ext_dir = HERE.parent / "yandex-archive-extension"
    ext_ver = json.loads((ext_dir / "manifest.json").read_text(encoding="utf-8"))["version"]
    name = f"yaarchive-{ver}-macOS"
    kit = DIST / name
    shutil.rmtree(kit, ignore_errors=True)
    (kit / "2_Скрипт").mkdir(parents=True)
    (kit / "3_Навык_Claude").mkdir()
    shutil.copytree(ext_dir, kit / "1_Расширение_Chrome" / "yandex-archive-extension",
                    ignore=shutil.ignore_patterns("tests", "__pycache__", "skill", ".DS_Store"))
    shutil.copy(pyz, kit / "2_Скрипт" / "yaarchive.pyz")
    shutil.copy(DIST / "yaarchive_запуск.command", kit / "2_Скрипт" / "yaarchive_запуск.command")
    shutil.copy(HERE / "README.md", kit / "2_Скрипт" / "Инструкция_yaarchive.md")
    shutil.copy(HERE / "mac" / "Установить.command", kit / "Установить.command")
    (kit / "ПРОЧТИ_МЕНЯ.txt").write_text(README_MAC.format(ver=ver, ext=ext_ver), encoding="utf-8")
    sk = HERE.parent / "skill" / "yaarchive-revision-rows"
    with zipfile.ZipFile(kit / "3_Навык_Claude" / "yaarchive-revision-rows.skill", "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(sk.rglob("*")):
            if f.is_file() and "__pycache__" not in f.parts:
                z.write(f, f.relative_to(sk.parent))
    # zip с правами на выполнение (.command, .pyz) — Архиватор macOS их сохраняет
    out = DIST / f"{name}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(kit.rglob("*")):
            arc = str(Path(name) / f.relative_to(kit))
            import time
            info = zipfile.ZipInfo(arc + ("/" if f.is_dir() else ""), date_time=time.localtime(f.stat().st_mtime)[:6])
            info.create_system = 3
            exe = f.suffix in (".command", ".pyz")
            info.external_attr = ((0o40755 if f.is_dir() else (0o100755 if exe else 0o100644)) << 16)
            if f.is_dir():
                z.writestr(info, "")
            else:
                info.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(info, f.read_bytes())
    print(out, out.stat().st_size, "байт")


if __name__ == "__main__":
    main()
