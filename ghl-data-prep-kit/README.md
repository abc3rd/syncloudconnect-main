# GHL Data Prep Kit — SynCloud Connect / Omega UI, LLC

Turns messy contact exports into clean, de-duplicated, tagged files that import into GoHighLevel the first time.

## What's in the box

| Folder / file | What it is | Sell it as |
|---|---|---|
| `web/ghl-data-prep-kit.html` | The whole kit in one file that runs in any browser. Prep tab + Templates tab. No server; data never leaves the computer. | Starter ($29) |
| `engine/ghl_prepkit.py` | Command-line engine with every tool, for bulk or scheduled jobs. Python 3.8+, no installs. | Agency Kit ($99) |
| `templates/templates.json` | 14 fill-in-the-blank SMS, email and workflow templates | Agency Kit |
| `rebrand` command | White-labels any project folder (names, file names, colors) into a new copy | Agency Kit |
| `landing/index.html` | One-page sales page for testing demand before building more | — |
| `start.sh` / `start.bat` | One-click launchers | — |
| `samples/` | Messy test files | — |

## Fastest start

1. Put CSV files in `inbox/`.
2. Double-click `start.bat` (Windows) or run `./start.sh` (Mac/Linux).
3. Results land in `outbox/<date_time>/`: import files, a `NEEDS_REVIEW` file if any rows were held back, and `report.md`.

With no files in `inbox/`, the launcher opens the browser kit instead.

## Commands

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

## How rows are handled

- **Ready**: has a valid email or phone. Goes into the import files.
- **Ready with a note**: one field was bad (for example a phone with no area code) but another contact method is fine. The bad value is cleared and explained in a `Prep Notes` column.
- **Held for review**: no valid email or phone. Goes to `*_NEEDS_REVIEW.csv` with an `Issues` column.

**TYRQ score** = automatic fixes ÷ (automatic fixes + items left for a person) × 100.

## Editing

- Templates: edit `templates/templates.json`, then run `python build.py` to rebuild the browser file.
- Browser app source: `web/app_src.html` (the engine logic mirrors `ghl_prepkit.py`; change both together).
- Sales page: put checkout links in the `CONFIG` block at the top of `landing/index.html`. Until then, buy buttons open an email to reserve the founder price.

## Notes

- Files split by **size** first. Default is 30 MB, the limit GoHighLevel's current help articles document. If your account accepts larger uploads, raise it with `--max-mb 50` (or the size field in the browser kit, or the third launcher value: `start.bat "tags" "source" 50`). Each file is cut at 97% of the limit for a safety margin.
- `--rows` is an optional row cap per file. One older GoHighLevel help article mentions 10,000 rows; if an import gets rejected for row count, add `--rows 10000`.
- Large files with QR code and photo link columns are fine: a 116 MB, 300,000-row test file split into 3 files at 50 MB in about 8 seconds.
- Phone cleanup assumes +1 unless you pick another default country code. Numbers that already have a `+` country code are kept.
- GoHighLevel is a trademark of HighLevel Inc. This kit is independent and not affiliated with it.
