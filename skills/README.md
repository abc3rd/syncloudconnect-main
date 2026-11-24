# Shared skills — one source for every AI

**Home:** `skills/` in GitHub repo `abc3rd/syncloudconnect-main` (branch `shared-skills` until merged to `main`).
Edit a skill there once; every agent picks up the change.

| Skill | Use it when |
|---|---|
| syncloud-house-style | Any Omega UI / SynCloud Connect work: names, terms, brand, guardrails |
| ghl-data-prep | Contact CSVs going into GoHighLevel (merge, clean, dedupe, tag, precheck, split, rebrand, templates) |
| glytch-ghl-bridge | Reading or proposing changes to live GoHighLevel data through GLYTCH |

## How each AI gets them
- **Agents inside the repo** (Claude Code, Codex, Cursor, Gemini CLI): automatic via `AGENTS.md` and `.claude/skills`.
- **Claude Code everywhere:** `scripts/install-skills.sh` (or pass another agent's skills folder as the argument).
- **Claude.ai / desktop:** upload a zipped skill folder in Settings → Capabilities → Skills.
- **Custom GPTs (GLYTCH-GPT), Gemini Gems, Open WebUI (Pablo), AI Router:** paste the SKILL.md into the bot's instructions or knowledge.

## Paste-in prompt for any agent
```
Clone https://github.com/abc3rd/syncloudconnect-main (or git pull if you have it).
Read AGENTS.md and skills/README.md. For each skill folder in skills/, install it
into your native skills directory if you have one (Claude Code: run
scripts/install-skills.sh); otherwise add the skills table from skills/README.md
to your instructions and read the matching SKILL.md before each task.
List what you installed. Don't overwrite existing skills or run any other
scripts without asking me.
```
