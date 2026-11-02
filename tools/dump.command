#!/bin/bash
set -u

REPO_URL="https://github.com/sergiofoho-del/Ladiygin-Sergey.git"
BASE_DIR="${HOME}/Desktop/Ladiygin-Sergey_project_archives"
SRC_DIR="${BASE_DIR}/src"
OUT_DIR="${BASE_DIR}/archives"

mkdir -p "$OUT_DIR"

echo "=== Подготовка архивов проектов ==="
echo "Источник: $REPO_URL"
echo "Папка выгрузки: $OUT_DIR"
echo

if [ -d "$SRC_DIR" ]; then
  rm -rf "$SRC_DIR"
fi

git clone --filter=blob:none "$REPO_URL" "$SRC_DIR"

cd "$SRC_DIR"

PROJECTS=(
  "yaarchive"
  "yandex-archive-extension"
  "extensions/obrabotka-ssylok-obrazov-gedcom"
  "extensions/sbor-lyudey-okrugi"
  "skill/yaarchive-revision-rows"
  "skill/zapis-v-gedcom"
  "skill/scrpt-ya-orig-scan"
)

for proj in "${PROJECTS[@]}"; do
  name="$(basename "$proj")"
  archive_path="${OUT_DIR}/${name}.zip"

  if [ -e "$archive_path" ]; then
    rm -f "$archive_path"
  fi

  echo "Создаю архив: $name"
  git archive \
    --format=zip \
    --prefix="${name}/" \
    --output "$archive_path" \
    HEAD -- "$proj"

  if [ -e "$archive_path" ]; then
    echo "Готово: $archive_path"
  else
    echo "Ошибка: архив не создан для $proj"
  fi

  echo
 done

echo "=== Все архивы готовы ==="
echo "$OUT_DIR"
open "$OUT_DIR"
