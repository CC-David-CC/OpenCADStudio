"""Prepare the existing Trunk app for WebOS's same-origin iframe."""

import base64
import gzip
import hashlib
import os
import re
import shutil
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
        module = source
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


def compress(path):
    packed = path.with_suffix(".wasm.gz")
    with path.open("rb") as raw, packed.open("wb") as output:
        with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0) as stream:
            shutil.copyfileobj(raw, stream)
    with packed.open("rb") as output:
        digest = hashlib.file_digest(output, "sha384").digest()
    path.unlink()
    return "sha384-" + base64.b64encode(digest).decode("ascii")


wasm = re.search(r"""module_or_path:\s*['"](\./[^'"]+\.wasm)['"]""", module)
if wasm is None:
    raise SystemExit("Trunk did not generate the expected WASM path.")
main_integrity = compress(staging / wasm[1])
worker_wasm = "worker_pkg/ocs_web_worker_bg.wasm"
worker_integrity = compress(staging / worker_wasm)
main_argument = f'await workspaceWasm("{wasm[1]}.gz", "{main_integrity}")'
module = 'import { workspaceWasm } from "./workspace-wasm.mjs";\n' + module.replace(
    wasm[0], "module_or_path: " + main_argument, 1
)

worker_path = staging / "ocs-parse-worker.js"
worker_script = worker_path.read_text(encoding="utf-8")
worker_start = re.search(r"const ready = init\(.*?\);", worker_script, re.DOTALL)
if worker_start is None:
    raise SystemExit("The drawing worker did not contain its expected WASM initialization.")
worker_argument = f'workspaceWasm("./{worker_wasm}.gz", "{worker_integrity}")'
worker_path.write_text(
    'import { workspaceWasm } from "./workspace-wasm.mjs";\n'
    + worker_script.replace(
        worker_start[0],
        f"const ready = {worker_argument}.then(module_or_path => init({{module_or_path}}));",
        1,
    ),
    encoding="utf-8",
)
shutil.copyfile(Path(__file__).with_name("workspace-wasm.mjs"), staging / "workspace-wasm.mjs")

markup = re.sub(r'<link\s+rel="manifest"\s+href="app\.webmanifest"\s*/?>', "", markup)
markup = re.sub(r'<link\b[^>]*type="application/wasm"[^>]*>', "", markup)
index.write_text(markup, encoding="utf-8")
(staging / "workspace-start.mjs").write_text(module, encoding="utf-8")
(staging / "workspace-splash.mjs").write_text(splash, encoding="utf-8")
# The standalone site generates these feeds and video thumbnails in CI.
# Keep this package self-contained and retain the app's built-in credits.
for name in ("supporters.json", "videos.json"):
    (staging / name).write_text("[]\n", encoding="utf-8")
for name in ("sw.js", "app.webmanifest", "ocs-control.js"):
    (staging / name).unlink(missing_ok=True)
