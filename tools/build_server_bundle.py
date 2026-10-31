"""Build a PHP-only deployment tree; never publish the retired desktop HTML.

The destination must be empty. Secrets and existing server data are configured
on the server after upload, rather than copied from a developer's checkout.
"""
from pathlib import Path
import argparse
import hashlib
import json
import shutil

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "MoonYa-Backend"
SKIP_DIRS = {"tests", "node_modules", ".git", "logs", "temp", "uploads", "downloads", "community", "office"}
RETIRED = {"index.php", "harness_api.php", "model_api.php", "statistics.php", "context_usage.php"}
# The retired entries answer through Services/LegacyEntryRedirect.php. Page-only
# entries (index.php, office/index.php) redirect every visitor; the API-shaped
# ones redirect browser navigation only, and keep the 410 JSON for fetch/XHR.
STUB = '''<?php
require_once __DIR__ . '/Services/LegacyEntryRedirect.php';
moonyaLegacyEntryRespond();
'''
STUB_INDEX = '''<?php
require_once __DIR__ . '/Services/LegacyEntryRedirect.php';
moonyaLegacyEntryRespond(true);
'''
STUB_OFFICE = '''<?php
require_once dirname(__DIR__) . '/Services/LegacyEntryRedirect.php';
moonyaLegacyEntryRespond(true);
'''

def build(destination: Path):
    destination = destination.resolve()
    if destination == SOURCE or SOURCE in destination.parents or destination == ROOT:
        raise ValueError("Deployment output cannot overwrite project sources")
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("Choose an empty deployment output directory")
    destination.mkdir(parents=True, exist_ok=True)
    for source in SOURCE.rglob("*"):
        relative = source.relative_to(SOURCE)
        if not source.is_file() or source.is_symlink() or any(part in SKIP_DIRS for part in relative.parts):
            continue
        if relative.as_posix().startswith(("script/MoonYa-index/", "assets/office/")):
            continue
        if relative.parts[0] == "vendor" and any(part in {"test", "tests", "java", "csharp", "examples"} for part in relative.parts):
            continue
        if source.name.startswith(".env") and source.name != ".env.server.example":
            continue
        if source.name != "payment_keyring_upgrade.sql" and any(marker in source.name.lower() for marker in ("keyring", "payment-master", "master-key")):
            continue
        if source.suffix.lower() in {".zip", ".log", ".bak", ".dat", ".pem", ".key", ".crt", ".pfx", ".p12", ".cer", ".der"} or relative.as_posix() in RETIRED:
            continue
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    for name in (*RETIRED, "office/index.php"):
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if name.startswith("office/"):
            stub = STUB_OFFICE
        elif name == "index.php":
            stub = STUB_INDEX
        else:
            stub = STUB
        target.write_text(stub, encoding="utf-8")
    manifest = {file.relative_to(destination).as_posix(): hashlib.sha256(file.read_bytes()).hexdigest()
                for file in sorted(destination.rglob("*")) if file.is_file()}
    (destination / "server-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"PHP deployment bundle: {destination} ({len(manifest)} files; no desktop HTML or credentials)")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    build(parser.parse_args().output)
