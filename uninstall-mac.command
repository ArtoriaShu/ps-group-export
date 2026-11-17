#!/bin/bash
set -euo pipefail
if pgrep -x 'Adobe Photoshop' >/dev/null || pgrep -f '/Adobe Photoshop[^/]*/Adobe Photoshop[^/]*\.app/Contents/MacOS/' >/dev/null; then
  echo 'Close Photoshop before uninstalling.'; exit 1
fi
task_dest="$HOME/Library/Application Support/Adobe/CEP/extensions/com.shu.groupexport"
rm -rf "$task_dest"
echo 'Group Export removed. Exported PNGs and other plugins were kept.'
