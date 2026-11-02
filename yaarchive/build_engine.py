"""Сборка движка итоговой обработки для расширения Chrome: python build_engine.py -> yandex-archive-extension/engine/engine.zip
Внутри: общий скрипт yaarchive (yaarchive.py, ya_out.py, ya_fix.py, справочники.json), навык «Строки таблицы» (скрипты skill/yaarchive-revision-rows)
и библиотека openpyxl (чистый Python) — всё это запускается внутри расширения (Pyodide), Терминал и установка Python не нужны."""
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SK = ROOT / "skill" / "yaarchive-revision-rows" / "scripts"
OUT = ROOT / "yandex-archive-extension" / "engine" / "engine.zip"
FILES = [HERE / "yaarchive.py", HERE / "ya_out.py", HERE / "ya_fix.py", HERE / "справочники.json",
         SK / "extract_confession.py", SK / "extract_rows.py", SK / "revision_people.py", SK / "split_names.py"]


def main():
    import et_xmlfile
    import openpyxl
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in FILES:
            z.write(f, f.name)
        for pkg in (Path(openpyxl.__file__).parent, Path(et_xmlfile.__file__).parent):
            for f in sorted(pkg.rglob("*.py")):
                if "tests" in f.parts or "__pycache__" in f.parts:
                    continue
                z.write(f, str(Path(pkg.name) / f.relative_to(pkg)))
    print(OUT, OUT.stat().st_size, "байт")


if __name__ == "__main__":
    main()
