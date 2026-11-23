#!/usr/bin/env python3
"""
GHL Data Prep Kit — SynCloud Connect / Omega UI, LLC
=====================================================
One engine, every tool for getting contact lists ready for GoHighLevel:

  map       Rename messy columns to GoHighLevel field names
  clean     Fix phones (E.164), emails, names, states, ZIPs, websites
  dedupe    Merge duplicate contacts (by email, then phone)
  stamp     Add tags, lead source, or any fixed field to every row
  merge     Combine several CSV exports into one file
  precheck  Pass/fail report before you upload, plus a needs-review file
  split     Split a file into import-sized parts (by row count or by column)
  run       GLYTCH assembly line: merge > map > clean > dedupe > stamp > precheck > split
  rebrand   White-label a project folder (names, files, colors) into a new copy
  templates Write the fill-in-the-blank SMS / email / workflow pack, or fill it in

Standard library only (Python 3.8+). No installs needed.

Examples
  python ghl_prepkit.py run leads.csv more_leads.csv --outdir out --tags "fb-ads,nov" --source "Facebook"
  python ghl_prepkit.py split big.csv --max-mb 50 --outdir parts
  python ghl_prepkit.py precheck ready.csv
  python ghl_prepkit.py rebrand ./my-app --out ./client-app --from "SynCloud Connect" --to "Acme CRM" --color "#ea00ea=#0055ff"
  python ghl_prepkit.py templates --out pack --fill vars.json
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import shutil
import sys
import unicodedata
from datetime import datetime
from pathlib import Path

__version__ = "1.0.0"
BRAND = "GHL Data Prep Kit by SynCloud Connect"

# --------------------------------------------------------------------------------------
# GoHighLevel field dictionary: target field -> header spellings we recognize
# --------------------------------------------------------------------------------------
GHL_FIELDS: dict[str, list[str]] = {
    "First Name": ["primer nombre", "first name", "first", "fname", "firstname", "given name", "first_name", "forename"],
    "Last Name": ["apellido", "apellidos", "last name", "last", "lname", "lastname", "surname", "family name", "last_name"],
    "Email": ["correo", "correo electronico", "email personal", "email", "e-mail", "email address", "e-mail address", "mail", "email_address", "primary email"],
    "Phone": ["telefono", "celular", "movil", "numero de telefono", "whatsapp", "phone", "phone #", "phone number", "phone no", "mobile", "mobile phone", "mobile number",
              "cell", "cell phone", "cellphone", "telephone", "tel", "primary phone", "contact number", "phone_number"],
    "Company Name": ["empresa", "negocio", "compania", "company", "company name", "business", "business name", "organization", "organisation",
                     "org", "employer", "account name"],
    "Address": ["direccion", "calle", "address", "address1", "address 1", "address line 1", "street", "street address", "mailing address"],
    "City": ["ciudad", "municipio", "city", "town", "locality"],
    "State": ["estado", "provincia", "state", "province", "region", "st", "state/province"],
    "Postal Code": ["codigo postal", "cp", "postal code", "zip", "zip code", "zipcode", "postcode", "postal", "zip/postal code"],
    "Country": ["pais", "country", "country code", "nation"],
    "Website": ["sitio web", "pagina web", "website", "web site", "url", "site", "web", "homepage", "web address"],
    "Tags": ["etiquetas", "etiqueta", "tags", "tag", "labels", "label", "segments"],
    "Source": ["fuente", "origen del lead", "source", "lead source", "leadsource", "origin", "channel", "utm source"],
    "Date of Birth": ["fecha de nacimiento", "cumpleanos", "date of birth", "dob", "birthday", "birth date", "birthdate"],
}
FULL_NAME_HEADERS = {"nombre", "nombre completo", "cliente", "name", "full name", "fullname", "contact name", "contact", "customer name", "client name"}

US_STATES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA", "colorado": "CO",
    "connecticut": "CT", "delaware": "DE", "district of columbia": "DC", "florida": "FL", "georgia": "GA",
    "hawaii": "HI", "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
    "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD", "massachusetts": "MA",
    "michigan": "MI", "minnesota": "MN", "mississippi": "MS", "missouri": "MO", "montana": "MT",
    "nebraska": "NE", "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
    "new york": "NY", "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
    "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA",
    "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY", "puerto rico": "PR",
}
US_ABBRS = set(US_STATES.values())

EMAIL_TYPOS = {
    "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gmal.com": "gmail.com", "gamil.com": "gmail.com",
    "gmail.co": "gmail.com", "gmail.con": "gmail.com", "gnail.com": "gmail.com",
    "hotmial.com": "hotmail.com", "hotmal.com": "hotmail.com", "hotmail.con": "hotmail.com",
    "yaho.com": "yahoo.com", "yahooo.com": "yahoo.com", "yahoo.con": "yahoo.com",
    "outlok.com": "outlook.com", "outlook.con": "outlook.com", "iclod.com": "icloud.com",
    "aol.con": "aol.com",
}
EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")

ISSUES = "_issues"   # per-row list of human-review problems
FIXES = "_fixes"     # per-row count of automatic fixes
WARNS = "_warns"     # per-row non-blocking notes (row still imports)


def norm_key(header: str) -> str:
    header = "".join(c for c in unicodedata.normalize("NFKD", header) if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9#/ ]", "", header.strip().lower().replace("_", " ")).strip()


# --------------------------------------------------------------------------------------
# CSV I/O
# --------------------------------------------------------------------------------------
def read_csv(path: str | Path) -> tuple[list[str], list[dict]]:
    raw = Path(path).read_bytes()
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    sample = text[:20000]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    reader = csv.reader(io.StringIO(text), dialect)
    rows = list(reader)
    if not rows:
        return [], []
    headers, seen = [], {}
    for h in rows[0]:
        h = (h or "").strip() or "Column"
        if h in seen:
            seen[h] += 1
            h = f"{h} ({seen[h]})"
        else:
            seen[h] = 1
        headers.append(h)
    out = []
    for r in rows[1:]:
        if not any((c or "").strip() for c in r):
            continue  # drop blank rows
        r = list(r) + [""] * (len(headers) - len(r))
        out.append({h: (r[i] if i < len(r) else "") for i, h in enumerate(headers)})
    return headers, out


def write_csv(path: str | Path, headers: list[str], rows: list[dict]) -> None:
    headers = [h for h in headers if not h.startswith("_")]
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=headers, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({h: r.get(h, "") for h in headers})


def _issue(row: dict, msg: str) -> None:
    row.setdefault(ISSUES, []).append(msg)


def _warn(row: dict, msg: str) -> None:
    row.setdefault(WARNS, []).append(msg)


def _fix(row: dict, n: int = 1) -> None:
    row[FIXES] = row.get(FIXES, 0) + n


# --------------------------------------------------------------------------------------
# 1. MAP
# --------------------------------------------------------------------------------------
def build_mapping(headers: list[str], custom: dict | None = None) -> dict[str, str]:
    lookup = {}
    for target, aliases in GHL_FIELDS.items():
        lookup[norm_key(target)] = target
        for a in aliases:
            lookup[norm_key(a)] = target
    for src, target in (custom or {}).items():
        lookup[norm_key(src)] = target
    mapping, used = {}, set()
    for h in headers:
        t = lookup.get(norm_key(h))
        if t and t not in used:
            mapping[h] = t
            used.add(t)
        else:
            mapping[h] = h  # unknown columns stay as-is (become custom fields in GHL)
    return mapping


def map_fields(headers: list[str], rows: list[dict], custom: dict | None = None):
    mapping = build_mapping(headers, custom)
    changes = {k: v for k, v in mapping.items() if k != v}
    new_headers = []
    for h in headers:
        if mapping[h] not in new_headers:
            new_headers.append(mapping[h])
    full_name_col = next((h for h in headers if norm_key(h) in FULL_NAME_HEADERS and mapping[h] == h), None)
    has_first = "First Name" in new_headers
    out = []
    for r in rows:
        nr = {k: v for k, v in r.items() if k.startswith("_")}
        for h in headers:
            tgt = mapping[h]
            if tgt in nr and nr[tgt] and not r.get(h):
                continue
            nr[tgt] = r.get(h, "")
        if full_name_col and not (nr.get("First Name") or "").strip():
            parts = (r.get(full_name_col) or "").strip().split()
            if parts:
                nr["First Name"] = parts[0]
                nr["Last Name"] = " ".join(parts[1:])
                _fix(nr)
        out.append(nr)
    if full_name_col:
        idx = new_headers.index(full_name_col)
        new_headers[idx:idx + 1] = [f for f in ("First Name", "Last Name") if f not in new_headers]
        for r in out:
            r.pop(full_name_col, None)
        changes[full_name_col] = "First Name + Last Name"
    # put core GHL fields first, keep others after
    core = [f for f in GHL_FIELDS if f in new_headers]
    rest = [h for h in new_headers if h not in core]
    return core + rest, out, changes


# --------------------------------------------------------------------------------------
# 2. CLEAN
# --------------------------------------------------------------------------------------
def clean_phone(value: str, default_cc: str = "1") -> tuple[str, bool, bool]:
    """Return (phone, changed, valid). Output is E.164 like +12395550123."""
    v = (value or "").strip()
    if not v:
        return "", False, True
    v2 = re.split(r"(?i)\s*(?:ext\.?|extension|x|#)\s*\d+\s*$", v)[0]
    plus = v2.strip().startswith("+") or v2.strip().startswith("00")
    digits = re.sub(r"\D", "", v2)
    if v2.strip().startswith("00"):
        digits = digits[2:]
    if plus:
        out = "+" + digits
    elif len(digits) == 10 and default_cc == "1":
        out = "+1" + digits
    elif len(digits) == 11 and digits.startswith("1") and default_cc == "1":
        out = "+" + digits
    elif default_cc != "1" and digits.startswith("0"):
        out = "+" + default_cc + digits.lstrip("0")
    elif len(digits) > 10:
        out = "+" + digits
    else:
        out = "+" + default_cc + digits
    valid = 8 <= len(out) - 1 <= 15
    if default_cc == "1" and out.startswith("+1") and len(out) != 12:
        valid = False
    if not valid:
        return v, False, False
    return out, out != v, True


def clean_email(value: str) -> tuple[str, bool, bool]:
    v = (value or "").strip().strip("<>").strip()
    if not v:
        return "", False, True
    e = v.lower().replace(" ", "").replace(",", ".")
    e = re.sub(r"^mailto:", "", e)
    if "@" in e:
        local, _, domain = e.rpartition("@")
        domain = EMAIL_TYPOS.get(domain, domain)
        domain = re.sub(r"\.con$|\.cmo$|\.ocm$", ".com", domain)
        e = f"{local}@{domain}"
    if not EMAIL_RE.match(e):
        return v, False, False
    return e, e != v, True


def clean_name(value: str) -> str:
    v = re.sub(r"\s+", " ", (value or "").strip())
    if v and (v.isupper() or v.islower()):
        v = v.title()
        v = re.sub(r"\bMc([a-z])", lambda m: "Mc" + m.group(1).upper(), v)
    return v


def clean_rows(headers: list[str], rows: list[dict], default_cc: str = "1"):
    stats = {"phones_fixed": 0, "phones_invalid": 0, "emails_fixed": 0, "emails_invalid": 0,
             "names_fixed": 0, "states_fixed": 0, "zips_fixed": 0, "websites_fixed": 0, "cells_trimmed": 0}
    for r in rows:
        for h in headers:
            v = r.get(h, "")
            if isinstance(v, str):
                t = re.sub(r"[ \t]+", " ", v.replace(" ", " ")).strip()
                if t != v:
                    r[h] = t
                    stats["cells_trimmed"] += 1
        if "Phone" in r:
            p, changed, ok = clean_phone(r["Phone"], default_cc)
            if not ok:
                stats["phones_invalid"] += 1
                _warn(r, f"Phone not valid: {r['Phone']}")
                r["Phone"] = ""
            elif changed:
                r["Phone"] = p
                stats["phones_fixed"] += 1
                _fix(r)
        if "Email" in r:
            e, changed, ok = clean_email(r["Email"])
            if not ok:
                stats["emails_invalid"] += 1
                _warn(r, f"Email not valid: {r['Email']}")
                r["Email"] = ""
            elif changed:
                r["Email"] = e
                stats["emails_fixed"] += 1
                _fix(r)
        for f in ("First Name", "Last Name", "City"):
            if f in r and r[f]:
                n = clean_name(r[f])
                if n != r[f]:
                    r[f] = n
                    stats["names_fixed"] += 1
                    _fix(r)
        country = (r.get("Country") or "").strip().lower()
        is_us = country in ("", "us", "usa", "united states", "united states of america")
        if "State" in r and r["State"]:
            s = r["State"].strip()
            if s.lower() in US_STATES:
                r["State"] = US_STATES[s.lower()]
                stats["states_fixed"] += 1
                _fix(r)
            elif s.upper() in US_ABBRS and s != s.upper():
                r["State"] = s.upper()
                stats["states_fixed"] += 1
                _fix(r)
        if "Postal Code" in r and r["Postal Code"] and is_us:
            z = r["Postal Code"].strip()
            if re.fullmatch(r"\d{3,4}", z):  # Excel dropped leading zeros
                r["Postal Code"] = z.zfill(5)
                stats["zips_fixed"] += 1
                _fix(r)
            elif re.fullmatch(r"\d{9}", z):
                r["Postal Code"] = f"{z[:5]}-{z[5:]}"
                stats["zips_fixed"] += 1
                _fix(r)
        if "Website" in r and r["Website"]:
            w = r["Website"].strip()
            if "." in w and not re.match(r"(?i)^https?://", w):
                r["Website"] = "https://" + w.lstrip("/")
                stats["websites_fixed"] += 1
                _fix(r)
    return rows, stats


# --------------------------------------------------------------------------------------
# 3. DEDUPE
# --------------------------------------------------------------------------------------
def _split_tags(v: str) -> list[str]:
    return [t.strip() for t in re.split(r"[,;|]", v or "") if t.strip()]


def dedupe_rows(headers: list[str], rows: list[dict], keys: tuple[str, ...] = ("Email", "Phone")):
    index: dict[str, dict] = {}
    out, merged = [], 0
    for r in rows:
        found = None
        for k in keys:
            val = (r.get(k) or "").strip().lower()
            if val and f"{k}:{val}" in index:
                found = index[f"{k}:{val}"]
                break
        if found is None:
            out.append(r)
            found = r
        else:
            merged += 1
            for h in headers:
                if h == "Tags":
                    tags = _split_tags(found.get("Tags", "")) + [t for t in _split_tags(r.get("Tags", ""))
                                                                  if t not in _split_tags(found.get("Tags", ""))]
                    found["Tags"] = ", ".join(tags)
                elif not (found.get(h) or "").strip() and (r.get(h) or "").strip():
                    found[h] = r[h]
            for w in r.get(WARNS, []):
                field_ok = (w.startswith("Phone") and found.get("Phone")) or (w.startswith("Email") and found.get("Email"))
                if w not in found.get(WARNS, []) and not field_ok:
                    _warn(found, w)
            _fix(found)
        for k in keys:
            val = (found.get(k) or "").strip().lower()
            if val:
                index[f"{k}:{val}"] = found
    return out, merged


# --------------------------------------------------------------------------------------
# 4. STAMP
# --------------------------------------------------------------------------------------
def stamp_rows(headers: list[str], rows: list[dict], tags: str = "", source: str = "",
               sets: list[str] | None = None, override_source: bool = False):
    headers = list(headers)
    new_tags = _split_tags(tags)
    fixed = {}
    for s in sets or []:
        if "=" in s:
            k, v = s.split("=", 1)
            fixed[k.strip()] = v.strip()
    for col, needed in (("Tags", bool(new_tags)), ("Source", bool(source))):
        if needed and col not in headers:
            headers.append(col)
    for k in fixed:
        if k not in headers:
            headers.append(k)
    for r in rows:
        if new_tags:
            cur = _split_tags(r.get("Tags", ""))
            r["Tags"] = ", ".join(cur + [t for t in new_tags if t not in cur])
        if source and (override_source or not (r.get("Source") or "").strip()):
            r["Source"] = source
        for k, v in fixed.items():
            r[k] = v
    return headers, rows


# --------------------------------------------------------------------------------------
# 5. MERGE
# --------------------------------------------------------------------------------------
def merge_files(paths: list[str]):
    headers, rows = [], []
    for p in paths:
        h, r = read_csv(p)
        for col in h:
            if col not in headers:
                headers.append(col)
        for row in r:
            row["_file"] = Path(p).name
        rows.extend(r)
    return headers, rows


# --------------------------------------------------------------------------------------
# 6. PRECHECK  (+ TYRQ score)
# --------------------------------------------------------------------------------------
def precheck_rows(headers: list[str], rows: list[dict]):
    ready, review = [], []
    warnings = {"missing_first_name": 0}
    for r in rows:
        if not (r.get("Email") or "").strip() and not (r.get("Phone") or "").strip():
            _issue(r, "No valid email or phone (GHL needs at least one)")
        if r.get(ISSUES):
            for w in r.get(WARNS, []):
                if w not in r[ISSUES]:
                    r[ISSUES].append(w)
            review.append(r)
        else:
            ready.append(r)
        if not (r.get("First Name") or "").strip():
            warnings["missing_first_name"] += 1
    auto = sum(r.get(FIXES, 0) for r in rows)
    human = sum(len(r.get(ISSUES, [])) or len(r.get(WARNS, [])) for r in rows)
    flagged = sum(1 for r in ready if r.get(WARNS))
    total = len(rows) or 1
    tyrq = round(100 * auto / (auto + human)) if (auto + human) else 100
    readiness = round(100 * len(ready) / total)
    return ready, review, {
        "rows_total": len(rows), "rows_ready": len(ready), "rows_need_review": len(review), "ready_with_notes": flagged,
        "auto_fixes": auto, "human_review_items": human,
        "tyrq_score": tyrq, "readiness_pct": readiness,
        "status": "PASS" if not review else ("PASS WITH REVIEW" if ready else "FAIL"),
        "warnings": warnings,
    }


# --------------------------------------------------------------------------------------
# 7. SPLIT
# --------------------------------------------------------------------------------------
def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", name).strip("_")[:60] or "blank"


def _row_bytes(headers: list[str], row: dict) -> int:
    buf = io.StringIO()
    csv.writer(buf).writerow([row.get(h, "") for h in headers])
    return len(buf.getvalue().encode("utf-8"))


def chunk_rows(headers: list[str], rows: list[dict], size: int = 0, max_mb: float = 30.0) -> list[list[dict]]:
    """Cut rows into chunks that stay under max_mb (with a 3% safety margin) and, if set, under `size` rows."""
    vis = [h for h in headers if not h.startswith("_")]
    head_b = _row_bytes(vis, {h: h for h in vis})
    limit = int(max_mb * 1024 * 1024 * 0.97) if max_mb else 0
    chunks, cur, cur_b = [], [], head_b
    for r in rows:
        rb = _row_bytes(vis, r)
        if cur and ((limit and cur_b + rb > limit) or (size and len(cur) >= size)):
            chunks.append(cur)
            cur, cur_b = [], head_b
        cur.append(r)
        cur_b += rb
    if cur or not chunks:
        chunks.append(cur)
    return chunks


def split_rows(headers: list[str], rows: list[dict], outdir: str | Path, stem: str,
               size: int = 0, by: str | None = None, max_mb: float = 30.0) -> list[str]:
    """Split by file size (default 30 MB) and optionally by row count and/or a column's values."""
    outdir = Path(outdir)
    groups = {"": rows}
    if by:
        groups = {}
        for r in rows:
            groups.setdefault((r.get(by) or "").strip() or "blank", []).append(r)
    files = []
    for key, grp in groups.items():
        base = f"{stem}_{_safe(key)}" if by else stem
        chunks = chunk_rows(headers, grp, size, max_mb)
        for i, ch in enumerate(chunks):
            fp = outdir / (f"{base}_part{i + 1:02d}.csv" if len(chunks) > 1 else f"{base}.csv")
            write_csv(fp, headers, ch)
            files.append(str(fp))
    return files


# --------------------------------------------------------------------------------------
# 8. RUN — the GLYTCH assembly line
# --------------------------------------------------------------------------------------
def run_pipeline(inputs: list[str], outdir: str, tags: str = "", source: str = "", sets=None,
                 size: int = 0, by: str | None = None, cc: str = "1", custom_map: dict | None = None,
                 stem: str | None = None, quiet: bool = False, max_mb: float = 30.0) -> dict:
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    log = (lambda *a: None) if quiet else (lambda *a: print(*a))
    stem = stem or _safe(Path(inputs[0]).stem) + "_ghl"

    headers, rows, changes = [], [], {}
    for p in inputs:
        h, r = read_csv(p)
        h, r, ch = map_fields(h, r, custom_map)
        changes.update(ch)
        headers += [c for c in h if c not in headers]
        rows += r
    core = [f for f in GHL_FIELDS if f in headers]
    headers = core + [c for c in headers if c not in core]
    if "Email" not in headers and "Phone" not in headers:
        log("WARNING: no email or phone column recognized. Use --map to name it, e.g. {\"Mobile #2\": \"Phone\"}")
    log(f"[1/7] merge     {len(inputs)} file(s), {len(rows)} rows")
    log(f"[2/7] map       {len(changes)} column(s) renamed")
    rows, cstats = clean_rows(headers, rows, cc)
    log(f"[3/7] clean     {cstats['phones_fixed']} phones, {cstats['emails_fixed']} emails fixed")
    rows, merged = dedupe_rows(headers, rows)
    log(f"[4/7] dedupe    {merged} duplicate(s) merged")
    headers, rows = stamp_rows(headers, rows, tags, source, sets)
    for r in rows:
        if r.get(WARNS):
            r["Prep Notes"] = "; ".join(r[WARNS])
    if any(r.get(WARNS) for r in rows):
        headers = headers + ["Prep Notes"]
    log(f"[5/7] stamp     tags='{tags}' source='{source}'")
    ready, review, check = precheck_rows(headers, rows)
    log(f"[6/7] precheck  {check['status']} - {check['rows_ready']} ready, {check['rows_need_review']} to review")
    files = split_rows(headers, ready, out, stem, size, by, max_mb)
    if review:
        rh = headers + ["Issues"]
        for r in review:
            r["Issues"] = "; ".join(r.get(ISSUES, []))
        write_csv(out / f"{stem}_NEEDS_REVIEW.csv", rh, review)
    log(f"[7/7] split     {len(files)} import file(s), each under {max_mb:g} MB" + (f" and {size} rows" if size else ""))

    report = {
        "tool": BRAND, "version": __version__, "generated": datetime.now().isoformat(timespec="seconds"),
        "inputs": [str(p) for p in inputs], "max_mb": max_mb, "max_rows": size or None, "columns_renamed": changes, "clean": cstats,
        "duplicates_merged": merged, "precheck": check, "import_files": files,
        "review_file": str(out / f"{stem}_NEEDS_REVIEW.csv") if review else None,
    }
    (out / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    (out / "report.md").write_text(render_report(report), encoding="utf-8")
    log(f"\nTYRQ {check['tyrq_score']}  |  Readiness {check['readiness_pct']}%  |  Report: {out / 'report.md'}")
    return report


def render_report(rep: dict) -> str:
    c, p = rep["clean"], rep["precheck"]
    lines = [
        f"# {BRAND} — Import Report", f"Generated {rep['generated']}", "",
        f"**Status: {p['status']}**  ·  TYRQ score **{p['tyrq_score']}**  ·  Readiness **{p['readiness_pct']}%**", "",
        "| Step | Result |", "|---|---|",
        f"| Rows in | {p['rows_total'] + rep['duplicates_merged']} |",
        f"| Columns renamed | {len(rep['columns_renamed'])} |",
        f"| Phones fixed / invalid | {c['phones_fixed']} / {c['phones_invalid']} |",
        f"| Emails fixed / invalid | {c['emails_fixed']} / {c['emails_invalid']} |",
        f"| Names, states, ZIPs, websites fixed | {c['names_fixed']}, {c['states_fixed']}, {c['zips_fixed']}, {c['websites_fixed']} |",
        f"| Duplicates merged | {rep['duplicates_merged']} |",
        f"| Ready to import | {p['rows_ready']} |",
        f"| Ready, with a note to fix later | {p['ready_with_notes']} |",
        f"| Held back for review | {p['rows_need_review']} |", "",
        "**TYRQ** = share of all problems the kit fixed on its own versus problems left for a person. Higher is better.", "",
        "## Column mapping", *([f"- `{k}` → `{v}`" for k, v in rep["columns_renamed"].items()] or ["- (none)"]), "",
        f"## Import files (each under {rep['max_mb']:g} MB" + (f", {rep['max_rows']} rows" if rep.get("max_rows") else "") + ")",
        *[f"- {Path(f).name} ({os.path.getsize(f) / 1048576:.2f} MB)" for f in rep["import_files"] if os.path.exists(f)],
    ]
    if rep.get("review_file"):
        lines += ["", f"## Needs review\n- {Path(rep['review_file']).name} (has an `Issues` column explaining each row)"]
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------------------
# 9. REBRAND — white-label a project folder into a new copy
# --------------------------------------------------------------------------------------
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "build", "dist", ".dart_tool", ".gradle"}


def _variants(name: str) -> list[str]:
    words = re.findall(r"[A-Za-z0-9]+", name)
    if not words:
        return [name]
    v = [name, name.lower(), name.upper(),
         "-".join(w.lower() for w in words), "_".join(w.lower() for w in words),
         "".join(w.capitalize() for w in words), "".join(w.lower() for w in words),
         words[0].lower() + "".join(w.capitalize() for w in words[1:])]
    seen, out = set(), []
    for x in v:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


def rebrand_tree(src: str, dst: str, old: str, new: str, colors: list[str] | None = None,
                 dry_run: bool = False) -> dict:
    srcp, dstp = Path(src).resolve(), Path(dst).resolve()
    if dstp == srcp or srcp in dstp.parents:
        raise SystemExit("Output folder must be outside the source folder.")
    pairs = list(zip(_variants(old), _variants(new)))
    pairs.sort(key=lambda p: -len(p[0]))
    color_pairs = []
    for c in colors or []:
        a, _, b = c.partition("=")
        if a and b:
            color_pairs += [(a, b), (a.lower(), b.lower()), (a.upper(), b.upper())]

    def swap(text: str) -> tuple[str, int]:
        n = 0
        for a, b in pairs + color_pairs:
            if a and a in text:
                n += text.count(a)
                text = text.replace(a, b)
        return text, n

    stats = {"files_copied": 0, "files_changed": 0, "replacements": 0, "renamed": 0, "binary_skipped": 0, "changes": []}
    for root, dirs, files in os.walk(srcp):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        rel = Path(root).relative_to(srcp)
        new_rel = Path(*[swap(part)[0] for part in rel.parts]) if rel.parts else Path()
        for fn in files:
            new_fn, rn = swap(fn)
            target = dstp / new_rel / new_fn
            data = (Path(root) / fn).read_bytes()
            if rn:
                stats["renamed"] += 1
            if b"\x00" in data[:8000]:
                stats["binary_skipped"] += 1
                out_bytes = data
            else:
                try:
                    text = data.decode("utf-8")
                except UnicodeDecodeError:
                    text = data.decode("latin-1")
                text, n = swap(text)
                if n:
                    stats["files_changed"] += 1
                    stats["replacements"] += n
                    stats["changes"].append(f"{rel / fn}: {n}")
                out_bytes = text.encode("utf-8")
            stats["files_copied"] += 1
            if not dry_run:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(out_bytes)
                shutil.copymode(Path(root) / fn, target)
    return stats


# --------------------------------------------------------------------------------------
# 10. TEMPLATES — fill-in-the-blank pack
# --------------------------------------------------------------------------------------
TEMPLATES_FILE = Path(__file__).resolve().parent.parent / "templates" / "templates.json"
VAR_RE = re.compile(r"\[([A-Z0-9_ ]+)\]")
# variables GoHighLevel fills per contact at send time
GHL_MERGE_DEFAULTS = {"FIRST_NAME": "{{contact.first_name}}", "APPOINTMENT_TIME": "{{appointment.start_time}}"}


def load_templates() -> dict:
    if TEMPLATES_FILE.exists():
        return json.loads(TEMPLATES_FILE.read_text(encoding="utf-8"))
    raise SystemExit(f"Template library not found at {TEMPLATES_FILE}")


def fill_text(text: str, values: dict) -> tuple[str, set]:
    missing = set()

    def rep(m):
        key = m.group(1).strip()
        if key in values and str(values[key]).strip():
            return str(values[key])
        missing.add(key)
        return m.group(0)
    return VAR_RE.sub(rep, text), missing


def write_templates(outdir: str, values: dict | None = None) -> dict:
    lib = load_templates()
    out = Path(outdir)
    all_missing, count = set(), 0
    if values is not None:
        values = {**GHL_MERGE_DEFAULTS, **values}
    for group, items in lib["templates"].items():
        for t in items:
            body = t["body"] if "body" in t else "\n".join(f"{i + 1}. {s}" for i, s in enumerate(t["steps"]))
            subject = t.get("subject", "")
            if values:
                body, m1 = fill_text(body, values)
                subject, m2 = fill_text(subject, values)
                all_missing |= m1 | m2
            text = f"# {t['name']}\n# Use: {t['use']}\n\n" + (f"Subject: {subject}\n\n" if subject else "") + body + "\n"
            fp = out / group / f"{_safe(t['id'])}.txt"
            fp.parent.mkdir(parents=True, exist_ok=True)
            fp.write_text(text, encoding="utf-8")
            count += 1
    return {"written": count, "outdir": str(out), "still_blank": sorted(all_missing)}


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------
def _load_map(path: str | None) -> dict | None:
    return json.loads(Path(path).read_text(encoding="utf-8")) if path else None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="ghl_prepkit", description=f"{BRAND} v{__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def io_args(p, multi=False):
        p.add_argument("inputs" if multi else "input", nargs="+" if multi else None)
        p.add_argument("-o", "--output", required=True)

    p = sub.add_parser("map", help="rename columns to GHL fields"); io_args(p)
    p.add_argument("--map", help="JSON file of extra {source header: GHL field}")
    p = sub.add_parser("clean", help="fix phones, emails, names, states, ZIPs"); io_args(p)
    p.add_argument("--cc", default="1", help="default country calling code (1 = US/Canada)")
    p = sub.add_parser("dedupe", help="merge duplicate contacts"); io_args(p)
    p.add_argument("--keys", default="Email,Phone")
    p = sub.add_parser("stamp", help="add tags/source/fixed fields"); io_args(p)
    p.add_argument("--tags", default=""); p.add_argument("--source", default="")
    p.add_argument("--set", action="append", default=[], help='Field=Value (repeatable)')
    p.add_argument("--override-source", action="store_true")
    p = sub.add_parser("merge", help="combine CSV files"); io_args(p, multi=True)
    p = sub.add_parser("precheck", help="pass/fail report before upload")
    p.add_argument("input"); p.add_argument("--json", action="store_true")
    p = sub.add_parser("split", help="split into import-sized files")
    p.add_argument("input"); p.add_argument("--outdir", required=True)
    p.add_argument("--max-mb", type=float, default=30.0, help="max file size in MB (GHL documents 30)")
    p.add_argument("--rows", type=int, default=0, help="optional row cap per file (0 = none)"); p.add_argument("--by", help="split by column value")
    p = sub.add_parser("run", help="full assembly line")
    p.add_argument("inputs", nargs="+"); p.add_argument("--outdir", required=True)
    p.add_argument("--tags", default=""); p.add_argument("--source", default="")
    p.add_argument("--set", action="append", default=[]); p.add_argument("--rows", type=int, default=0)
    p.add_argument("--max-mb", type=float, default=30.0)
    p.add_argument("--by"); p.add_argument("--cc", default="1"); p.add_argument("--map")
    p.add_argument("--name", help="output file name stem")
    p = sub.add_parser("rebrand", help="white-label a folder into a new copy")
    p.add_argument("src"); p.add_argument("--out", required=True)
    p.add_argument("--from", dest="old", required=True); p.add_argument("--to", dest="new", required=True)
    p.add_argument("--color", action="append", default=[], help="#old=#new (repeatable)")
    p.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("templates", help="write or fill the template pack")
    p.add_argument("--out", required=True); p.add_argument("--fill", help="JSON of {VARIABLE: value}")
    p.add_argument("--list-vars", action="store_true")

    a = ap.parse_args(argv)

    if a.cmd == "run":
        rep = run_pipeline(a.inputs, a.outdir, a.tags, a.source, a.set, a.rows, a.by, a.cc,
                           _load_map(a.map), a.name, max_mb=a.max_mb)
        return 0 if rep["precheck"]["status"] != "FAIL" else 2
    if a.cmd == "merge":
        h, r = merge_files(a.inputs)
        write_csv(a.output, h, r); print(f"Merged {len(r)} rows from {len(a.inputs)} files -> {a.output}"); return 0
    if a.cmd == "rebrand":
        s = rebrand_tree(a.src, a.out, a.old, a.new, a.color, a.dry_run)
        print(json.dumps({k: v for k, v in s.items() if k != "changes"}, indent=2))
        for c in s["changes"][:50]:
            print("  ", c)
        return 0
    if a.cmd == "templates":
        if a.list_vars:
            lib = load_templates()
            print("\n".join(f"[{k}]  {v}" for k, v in lib["variables"].items())); return 0
        vals = json.loads(Path(a.fill).read_text(encoding="utf-8")) if a.fill else None
        res = write_templates(a.out, vals)
        print(f"Wrote {res['written']} templates to {res['outdir']}")
        if vals and res["still_blank"]:
            print("Still blank:", ", ".join(res["still_blank"]))
        return 0

    headers, rows = read_csv(a.input)
    if a.cmd == "map":
        headers, rows, ch = map_fields(headers, rows, _load_map(a.map))
        write_csv(a.output, headers, rows)
        for k, v in ch.items():
            print(f"  {k} -> {v}")
    elif a.cmd == "clean":
        rows, st = clean_rows(headers, rows, a.cc)
        write_csv(a.output, headers, rows); print(json.dumps(st, indent=2))
    elif a.cmd == "dedupe":
        rows, m = dedupe_rows(headers, rows, tuple(k.strip() for k in a.keys.split(",")))
        write_csv(a.output, headers, rows); print(f"{m} duplicates merged, {len(rows)} rows left")
    elif a.cmd == "stamp":
        headers, rows = stamp_rows(headers, rows, a.tags, a.source, a.set, a.override_source)
        write_csv(a.output, headers, rows); print(f"Stamped {len(rows)} rows")
    elif a.cmd == "precheck":
        rows, _ = clean_rows(headers, [dict(r) for r in rows])
        ready, review, chk = precheck_rows(headers, rows)
        if a.json:
            print(json.dumps(chk, indent=2))
        else:
            print(f"{chk['status']}: {chk['rows_ready']} ready, {chk['rows_need_review']} need review "
                  f"(TYRQ {chk['tyrq_score']}, readiness {chk['readiness_pct']}%)")
            for r in review[:20]:
                print("  -", "; ".join(r[ISSUES]))
        return 0 if chk["status"] != "FAIL" else 2
    elif a.cmd == "split":
        files = split_rows(headers, rows, a.outdir, _safe(Path(a.input).stem), a.rows, a.by, a.max_mb)
        print(f"{len(files)} file(s):"); [print("  ", f) for f in files]
    return 0


if __name__ == "__main__":
    sys.exit(main())
