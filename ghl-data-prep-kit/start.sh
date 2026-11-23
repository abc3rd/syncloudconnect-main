#!/usr/bin/env bash
# GHL Data Prep Kit launcher (Mac/Linux)
# Drop CSV files into ./inbox, run this script, collect results from ./outbox/<timestamp>
# Optional: ./start.sh "tag1,tag2" "Lead Source" 50     (last value = max MB per file, default 30)
cd "$(dirname "$0")"
shopt -s nullglob
files=(inbox/*.csv inbox/*.tsv inbox/*.txt)
if [ ${#files[@]} -eq 0 ]; then
  echo "No files in ./inbox. Opening the browser kit instead."
  (command -v xdg-open >/dev/null && xdg-open web/ghl-data-prep-kit.html) || open web/ghl-data-prep-kit.html
  exit 0
fi
out="outbox/$(date +%Y%m%d_%H%M%S)"
python3 engine/ghl_prepkit.py run "${files[@]}" --outdir "$out" --tags "${1:-}" --source "${2:-}" --max-mb "${3:-30}"
echo; echo "Done. Files are in $out"
