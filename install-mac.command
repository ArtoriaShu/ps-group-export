#!/bin/bash
set -euo pipefail
task_dir="$(cd "$(dirname "$0")" && pwd)"
task_dest="$HOME/Library/Application Support/Adobe/CEP/extensions/com.shu.groupexport"
if pgrep -x 'Adobe Photoshop' >/dev/null || pgrep -f '/Adobe Photoshop[^/]*/Adobe Photoshop[^/]*\.app/Contents/MacOS/' >/dev/null; then
  echo 'Close Photoshop before installing.'; exit 1
fi
if [[ ! -f "$task_dir/com.shu.groupexport/CSXS/manifest.xml" ]]; then echo 'Extract the entire ZIP first.'; exit 1; fi
# Remove the previous version first so files deleted in this release do not linger.
rm -rf "$task_dest"
mkdir -p "$task_dest"
cp -R "$task_dir/com.shu.groupexport/." "$task_dest/"
# Files extracted from a downloaded ZIP carry the quarantine flag; clear it for the panel.
xattr -dr com.apple.quarantine "$task_dest" 2>/dev/null || true
for task_version in 9 10 11 12; do defaults write "com.adobe.CSXS.$task_version" PlayerDebugMode -string 1; done
echo 'Group Export installed. Restart Photoshop, then open Window > Extensions (Legacy).'
echo 'Unsigned CEP extension loading is enabled for CSXS 9-12.'
