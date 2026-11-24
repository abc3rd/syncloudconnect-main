#!/usr/bin/env bash
# install-skills.sh — install the shared skills into an agent's native skills directory.
# Usage:  scripts/install-skills.sh [target-skills-dir] [--force]
# Default target: ~/.claude/skills  (pass another agent's skills folder to install elsewhere)
# Existing skills are never overwritten unless --force is given.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="$SCRIPT_DIR/../skills"
TARGET="$HOME/.claude/skills"
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) TARGET="$arg" ;;
  esac
done

if [ ! -d "$SKILLS_SRC" ]; then
  echo "error: skills/ folder not found next to this script ($SKILLS_SRC)" >&2
  exit 1
fi

mkdir -p "$TARGET"
installed=(); skipped=()

for skill_dir in "$SKILLS_SRC"/*/; do
  name="$(basename "$skill_dir")"
  dest="$TARGET/$name"
  if [ -d "$dest" ] && [ "$FORCE" -eq 0 ]; then
    skipped+=("$name")
    continue
  fi
  rm -rf "$dest"
  cp -R "$skill_dir" "$dest"
  installed+=("$name")
done

echo "Installed into $TARGET:"
for s in ${installed[@]+"${installed[@]}"}; do echo "  + $s"; done
if [ "${#skipped[@]}" -gt 0 ]; then
  echo "Skipped (already exist, use --force to overwrite):"
  for s in "${skipped[@]}"; do echo "  = $s"; done
fi
