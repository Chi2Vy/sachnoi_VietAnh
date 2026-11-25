import argparse
import base64
import json
from pathlib import Path


source = Path(__file__).resolve().parent
modules = {
    "app": "js/app.js",
    "importer": "js/importer.js",
    "reader": "js/reader.js",
    "voice": "js/voice.js",
    "upload-plan": "js/upload-plan.js",
    "db": "js/db.js",
    "pdf": "vendor/pdf.min.mjs",
    "worker": "vendor/worker.min.mjs"
}
parser = argparse.ArgumentParser(description="Đóng gói Sách Nói thành một file HTML5.")
parser.add_argument("--output", type=Path, default=Path("SachNoi.html"))
destination = parser.parse_args().output.resolve()

html = (source / "index.template.html").read_text(encoding="utf-8")
embedded = {
    name: base64.b64encode((source / path).read_bytes()).decode("ascii")
    for name, path in modules.items()
}
replacements = {
    "{{STYLE}}": (source / "style.css").read_text(encoding="utf-8"),
    "{{PAGE_FLIP}}": (source / "vendor" / "page-flip.js").read_text(encoding="utf-8"),
    "{{MODULES}}": json.dumps(embedded, separators=(",", ":")),
}
for marker, content in replacements.items():
    if html.count(marker) != 1:
        raise ValueError(f"Thiếu hoặc trùng vị trí chèn {marker}")
    html = html.replace(marker, content)
destination.write_text(html, encoding="utf-8", newline="\n")
print(destination)
