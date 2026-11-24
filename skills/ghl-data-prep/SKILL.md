---
name: ghl-data-prep
description: Prepare contact CSVs for GoHighLevel — merge, clean, dedupe, tag, precheck, split, rebrand and fill message templates using the GHL Data Prep Kit in this repo (ghl-data-prep-kit/). Use whenever contact lists are being imported into GoHighLevel or cleaned for a Client.
---

# GHL Data Prep

Turns messy contact exports into clean, de-duplicated, tagged files that import into GoHighLevel the first time. The kit lives in `ghl-data-prep-kit/`: a browser one-file app (`web/ghl-data-prep-kit.html`, no server, data never leaves the computer) and a command-line engine (`engine/ghl_prepkit.py`, Python 3.8+, no installs).

## Standard workflow

1. Put CSV files in `ghl-data-prep-kit/inbox/`.
2. Run `start.sh` / `start.bat`, or call the engine directly.
3. Results land in `outbox/<date_time>/`: import files, a `*_NEEDS_REVIEW.csv` if any rows were held back, and `report.md`.

## Engine commands

```
python engine/ghl_prepkit.py run a.csv b.csv --outdir out --tags "nov-import,fb-ads" --source "Facebook Ads" --max-mb 50 [--rows 10000] [--by State] [--cc 1]
python engine/ghl_prepkit.py map      in.csv -o out.csv [--map extra_mappings.json]
python engine/ghl_prepkit.py clean    in.csv -o out.csv [--cc 44]
python engine/ghl_prepkit.py dedupe   in.csv -o out.csv [--keys Email,Phone]
python engine/ghl_prepkit.py stamp    in.csv -o out.csv --tags vip --source Referral --set "Pipeline=New Lead"
python engine/ghl_prepkit.py merge    a.csv b.csv -o merged.csv
python engine/ghl_prepkit.py precheck in.csv [--json]          # exit code 2 = FAIL
python engine/ghl_prepkit.py split    in.csv --outdir parts --max-mb 50 [--rows 10000] [--by Tags]
python engine/ghl_prepkit.py rebrand  ./app --out ./client-app --from "SynCloud Connect" --to "Acme CRM" --color "#ea00ea=#0055ff" [--dry-run]
python engine/ghl_prepkit.py templates --out pack [--fill vars.json] [--list-vars]
```

`extra_mappings.json` example: `{"Mobile #2": "Phone", "Biz": "Company Name"}`

## Row handling rules

- **Ready**: has a valid email or phone → import files.
- **Ready with a note**: one field was bad (e.g. phone with no area code) but another contact method is fine → bad value cleared, explained in a `Prep Notes` column.
- **Held for review**: no valid email or phone → `*_NEEDS_REVIEW.csv` with an `Issues` column.
- **TYRQ score** = automatic fixes ÷ (automatic fixes + items left for a person) × 100. Report it with every run.

## Rules and gotchas

1. Always run `precheck` before telling anyone a file is import-ready; exit code 2 means FAIL.
2. Files split by **size** first. Default 30 MB (GoHighLevel's documented limit); cut at 97% for safety. Raise with `--max-mb 50` only if the account accepts it. `--rows 10000` exists if an import is rejected on row count.
3. Phone cleanup assumes +1 unless another default country code is given; numbers already carrying a `+` country code are kept.
4. The browser kit and the engine mirror each other — change `web/app_src.html` and `engine/ghl_prepkit.py` together, then run `python build.py`.
5. Templates live in `templates/templates.json` (14 SMS/email/workflow templates); edit the JSON, then rebuild.
6. GoHighLevel is a trademark of HighLevel Inc.; the kit is independent. Never imply affiliation.
7. Use house-style terms (Client, Location, Customer) in all output files and reports — read the syncloud-house-style skill first.
