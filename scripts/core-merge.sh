#!/usr/bin/env bash
# Принимает правки ядра, пришедшие из репозитория-потребителя через `git subtree push`.
#
#   scripts/core-merge.sh <remote-url> <branch>
#
# Ветка <branch> содержит историю ядра с файлами в корне (как ветка `core`).
# Скрипт вливает её в packages/core текущей ветки; дальше — обычный PR в main.
set -euo pipefail
url="${1:?укажите URL репозитория}"
branch="${2:?укажите ветку}"
git subtree pull --prefix=packages/core "$url" "$branch" -m "merge core from $url $branch"
