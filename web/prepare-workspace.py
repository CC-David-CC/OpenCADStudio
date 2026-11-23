"""Prepare the existing Trunk app for WebOS's same-origin iframe."""

import os
import re
from pathlib import Path


staging = Path(os.environ["TRUNK_STAGING_DIR"])
index = staging / "index.html"
markup = index.read_text(encoding="utf-8")
scripts = re.compile(r"<script\b([^>]*)>(.*?)</script>", re.DOTALL)
module = ""
splash = ""


def prepare_script(match):
    global module, splash
    attributes, source = match.groups()
    if "TrunkApplicationStarted" in source:
        loader = re.search(r"""from ['"](\./[^'"]+\.js)['"]""", source)
        if loader is None:
            raise ValueError("Cannot find the Trunk-generated WASM loader.")
        module = loader[1]
        return '<script type="module" src="./workspace-start.mjs"></script>'
    if "locale-labels.json" in source:
        splash = source
        return '<script type="module" src="./workspace-splash.mjs"></script>'
    if (
        "navigator.serviceWorker" in source
        or "openaec-analytics-loader" in attributes
        or 'src="ocs-control.js"' in attributes
    ):
        return ""
    return match[0]


markup = scripts.sub(prepare_script, markup)
if not module or not splash:
    raise SystemExit("Trunk did not generate the expected app and splash scripts.")
markup = re.sub(r'<link\s+rel="manifest"\s+href="app\.webmanifest"\s*/?>', "", markup)
index.write_text(markup, encoding="utf-8")
(staging / "workspace-start.mjs").write_text(
    f'import init from "{module}";\n'
    'try {\n'
    '  await init();\n'
    '} catch (error) {\n'
    '  document.querySelector("#loading .sub").textContent = "The CAD editor could not start.";\n'
    '  throw error;\n'
    '}\n',
    encoding="utf-8",
)
(staging / "workspace-splash.mjs").write_text(splash, encoding="utf-8")
for name in ("sw.js", "app.webmanifest", "ocs-control.js"):
    (staging / name).unlink(missing_ok=True)
