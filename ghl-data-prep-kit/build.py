#!/usr/bin/env python3
"""Builds web/ghl-data-prep-kit.html (single self-contained file) from web/app_src.html + templates/templates.json."""
import json, pathlib
root = pathlib.Path(__file__).resolve().parent
src = (root / "web" / "app_src.html").read_text(encoding="utf-8")
tpl = json.dumps(json.loads((root / "templates" / "templates.json").read_text(encoding="utf-8")), ensure_ascii=False)
out = root / "web" / "ghl-data-prep-kit.html"
out.write_text(src.replace("/*__TEMPLATES__*/null", tpl.replace("</", "<\\/")), encoding="utf-8")
print("built", out)
