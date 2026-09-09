"""Build two portable single-file demos; only Python's standard library is needed."""
import argparse
import base64
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    font = base64.b64encode((ROOT / "shared/PretendardVariable.woff2").read_bytes()).decode("ascii")
    for variant in ("spec", "proposal"):
        base = ROOT / variant
        html = (base / "index.html").read_text(encoding="utf-8")
        css = (base / "style.css").read_text(encoding="utf-8").replace(
            "../shared/PretendardVariable.woff2", "data:font/woff2;base64," + font)
        html = html.replace('<link rel="stylesheet" href="style.css">', "<style>" + css + "</style>")
        scripts = []
        def inline(match):
            code = (base / match[1]).resolve().read_text(encoding="utf-8")
            scripts.append("<script>" + code.replace("</script", "<\\/script") + "</script>")
            return ""
        html = re.sub(r'<script src="([^"]+)" defer></script>', inline, html)
        # Inline scripts have no defer semantics; run them after the DOM exists.
        html = html.replace("</body>", "\n".join(scripts) + "\n</body>")
        licenses = ["Pretendard-LICENSE.txt"] + (["tesswcs-LICENSE.txt"] if variant == "proposal" else [])
        for license_name in licenses:
            notice = (ROOT / "shared" / license_name).read_text(encoding="utf-8").replace("--", "—")
            html += "\n<!-- " + license_name + "\n" + notice + "\n-->\n"
        target = args.output_dir / f"planetory-{variant}.html"
        target.write_text(html, encoding="utf-8")
        print(f"Built {target.name}: {target.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
