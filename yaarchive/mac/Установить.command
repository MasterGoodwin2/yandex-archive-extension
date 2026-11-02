#!/bin/bash
# yaarchive — установка на macOS 12 (Monterey) и новее.
# Первый запуск: правый щелчок по этому файлу → «Открыть» → «Открыть» (macOS спросит один раз).
# Что делает:
#   1) снимает блокировку macOS (карантин) с файлов комплекта;
#   2) находит Python 3.8+ или помогает его установить;
#   3) ставит библиотеку openpyxl (для Excel);
#   4) кладёт общий скрипт в папку, где лежит list_links.html (выбираете вы);
#   5) копирует расширение Chrome в «Документы/yandex-archive-extension» и открывает страницу расширений;
#   6) проверяет, что скрипт запускается.
# Ничего не удаляет: прежняя папка расширения сохраняется с пометкой «_прежняя_<дата>».

KIT="$(cd "$(dirname "$0")" && pwd)"
LOG="$KIT/установка_журнал.txt"
EXT_SRC="$KIT/1_Расширение_Chrome/yandex-archive-extension"
PYZ_SRC="$KIT/2_Скрипт/yaarchive.pyz"
EXT_DST="$HOME/Documents/yandex-archive-extension"
STAMP="$(date +%Y-%m-%d_%H-%M)"

say() { echo "$*"; echo "$(date '+%H:%M:%S') $*" >> "$LOG"; }
line() { echo "------------------------------------------------------------------"; }
dialog() {   # dialog "текст" "кнопка1,кнопка2" -> нажатая кнопка
  local btns="" IFS=","
  for b in $2; do btns="$btns\"$b\","; done
  btns="${btns%,}"
  osascript -e "button returned of (display dialog \"$1\" buttons {$btns} default button 1 with title \"yaarchive — установка\")" 2>/dev/null
}
fail() { say "ОШИБКА: $*"; osascript -e "display alert \"yaarchive — установка не завершена\" message \"$*\"" >/dev/null 2>&1; echo; read -p "Нажмите Enter, чтобы закрыть окно…" _; exit 1; }

clear; line; say "yaarchive — установка ($(sw_vers -productName 2>/dev/null) $(sw_vers -productVersion 2>/dev/null), $(uname -m))"; line
[ -f "$PYZ_SRC" ] && [ -f "$EXT_SRC/manifest.json" ] || fail "Комплект неполный: запускайте «Установить.command» из распакованной папки комплекта."

# 1) карантин
xattr -dr com.apple.quarantine "$KIT" 2>/dev/null
chmod +x "$KIT"/*.command "$KIT/2_Скрипт/"*.command 2>/dev/null
say "1/6 Блокировка macOS с файлов комплекта снята."

# 2) Python 3.8+
find_python() {
  local c
  for c in /Library/Frameworks/Python.framework/Versions/3.13/bin/python3 \
           /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 \
           /Library/Frameworks/Python.framework/Versions/3.11/bin/python3 \
           /Library/Frameworks/Python.framework/Versions/3.10/bin/python3 \
           /Library/Frameworks/Python.framework/Versions/3.9/bin/python3 \
           /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
    [ -x "$c" ] || continue
    # /usr/bin/python3 без инструментов разработчика — только заглушка, которая открывает окно установки
    if [ "$c" = "/usr/bin/python3" ] && ! xcode-select -p >/dev/null 2>&1; then continue; fi
    if "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1; then
      echo "$c"; return 0
    fi
  done
  return 1
}
PY="$(find_python)"
if [ -z "$PY" ]; then
  say "2/6 Python 3 не найден."
  ans="$(dialog "Для общего скрипта нужен Python 3 (бесплатно).\n\nВариант 1 (проще): «Инструменты Apple» — macOS сама установит Python 3.8 вместе с инструментами разработчика (около 10 минут).\nВариант 2: установщик с python.org (Python 3.12).\n\nПосле установки запустите «Установить.command» ещё раз." "Инструменты Apple,python.org,Отмена")"
  case "$ans" in
    "Инструменты Apple") xcode-select --install >/dev/null 2>&1; say "Открыто окно установки инструментов Apple. После неё запустите установку снова.";;
    "python.org") open "https://www.python.org/downloads/macos/"; say "Открыт python.org. Скачайте «macOS 64-bit universal2 installer», установите и запустите установку снова.";;
  esac
  echo; read -p "Нажмите Enter, чтобы закрыть окно…" _; exit 0
fi
say "2/6 Python: $PY ($("$PY" -c 'import platform; print(platform.python_version())'))"

# 3) openpyxl
if ! "$PY" -c 'import openpyxl' >/dev/null 2>&1; then
  say "3/6 Ставлю openpyxl (нужен интернет)…"
  "$PY" -m pip --version >/dev/null 2>&1 || "$PY" -m ensurepip --user >>"$LOG" 2>&1
  "$PY" -m pip install --user --quiet openpyxl >>"$LOG" 2>&1 || "$PY" -m pip install --user --quiet --break-system-packages openpyxl >>"$LOG" 2>&1
  "$PY" -c 'import openpyxl' >/dev/null 2>&1 || fail "Не удалось установить openpyxl. Проверьте интернет и запустите установку снова (подробности — в файле установка_журнал.txt)."
fi
say "3/6 openpyxl: $("$PY" -c 'import openpyxl; print(openpyxl.__version__)')"

# 4) папка со ссылками
DEST="$(osascript -e 'POSIX path of (choose folder with prompt "Выберите папку, где лежит list_links.html (туда же расширение пишет yaarchive_debug):" default location (path to documents folder))' 2>/dev/null)"
[ -n "$DEST" ] || fail "Папка не выбрана — установка остановлена. Запустите её снова."
DEST="${DEST%/}"
if ! ls "$DEST"/*.htm* >/dev/null 2>&1; then
  ans="$(dialog "В папке «$(basename "$DEST")» нет HTML-файла со ссылками (list_links.html).\nВсё равно установить сюда?" "Да,Выбрать заново")"
  [ "$ans" = "Да" ] || { say "Запустите установку снова и выберите папку со ссылками."; exit 0; }
fi
cp -f "$PYZ_SRC" "$DEST/yaarchive.pyz" || fail "Не удалось записать в «$DEST»."
cat > "$DEST/yaarchive_запуск.command" <<EOF
#!/bin/bash
# yaarchive — следить за этой папкой: новые пакеты расширения обрабатываются сами, итог — в папке «Итог».
cd "\$(dirname "\$0")"
PY="$PY"
[ -x "\$PY" ] || PY="\$(command -v python3)"
[ -n "\$PY" ] || { echo "Python 3 не найден — запустите «Установить.command» из комплекта ещё раз."; read -p "Enter…" _; exit 1; }
"\$PY" yaarchive.pyz "\$@"
EOF
chmod +x "$DEST/yaarchive_запуск.command"
cp -f "$KIT/2_Скрипт/Инструкция_yaarchive.md" "$DEST/" 2>/dev/null
xattr -dr com.apple.quarantine "$DEST/yaarchive.pyz" "$DEST/yaarchive_запуск.command" 2>/dev/null
say "4/6 Скрипт установлен: $DEST"

# 5) расширение Chrome
if [ -d "$EXT_DST" ]; then
  OLD="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$EXT_DST/manifest.json" 2>/dev/null | head -1)"
  mv "$EXT_DST" "${EXT_DST}_прежняя_${OLD:-x}_$STAMP" || fail "Не удалось убрать прежнюю папку расширения $EXT_DST"
  say "   прежнее расширение ${OLD} сохранено: ${EXT_DST}_прежняя_${OLD:-x}_$STAMP"
fi
cp -R "$EXT_SRC" "$EXT_DST" || fail "Не удалось скопировать расширение в «Документы»."
xattr -dr com.apple.quarantine "$EXT_DST" 2>/dev/null
printf "%s" "$EXT_DST" | pbcopy
NEWV="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$EXT_DST/manifest.json" | head -1)"
say "5/6 Расширение $NEWV скопировано: $EXT_DST (путь — в буфере обмена)"

# 6) проверка скрипта
V="$("$PY" "$DEST/yaarchive.pyz" --version 2>>"$LOG")" || fail "Скрипт не запускается (подробности — в установка_журнал.txt)."
say "6/6 Проверка: yaarchive $V запускается."
line

open -a "Google Chrome" "chrome://extensions/" >/dev/null 2>&1 || open -a "Google Chrome" >/dev/null 2>&1
dialog "Осталось подключить расширение в Chrome (страница расширений уже открыта):\n\n1. Справа вверху включите «Режим разработчика».\n2. Если расширение «Яндекс Архив» уже есть — удалите старое (или нажмите у него «Обновить», если оно было из Документы/yandex-archive-extension).\n3. «Загрузить распакованное расширение» → в окне нажмите Cmd+Shift+G → Cmd+V (путь уже скопирован) → Enter → «Выбрать».\n\nДолжна появиться версия $NEWV." "Готово" >/dev/null

ans="$(dialog "Установка завершена.\n\nСкрипт: $DEST\nРасширение: $EXT_DST\n\nЗапускать скрипт: двойной щелчок по «yaarchive_запуск.command» в папке со ссылками — он будет следить за папкой и сам обрабатывать новые загрузки расширения.\n\nЗапустить сейчас?" "Запустить,Позже")"
say "Установка завершена."
if [ "$ans" = "Запустить" ]; then open "$DEST/yaarchive_запуск.command"; fi
open "$DEST"
echo; read -p "Нажмите Enter, чтобы закрыть окно…" _
