# AGENTS.md

## Agent skills

### Shared skills

Portable skills for every AI live in `skills/` — see `skills/README.md`. Before any task that touches Omega UI / SynCloud Connect naming, GoHighLevel contact data, or the GLYTCH bridge, read the matching `skills/<name>/SKILL.md` first. Install into a native skills directory with `scripts/install-skills.sh [target-dir]` (never overwrites existing skills without `--force`).

### Issue tracker

Issues are tracked in this repo's GitHub Issues (abc3rd/syncloudconnect-main) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
