"""Shared local data root; explicitly supplied project output paths stay intact."""
import os
import tempfile
from pathlib import Path

DATA_ROOT = Path(os.environ.get('MOONYA_DATA_ROOT') or Path.home() / '.MoonYa').resolve()

def initialize():
    temporary = DATA_ROOT / 'temp'
    temporary.mkdir(parents=True, exist_ok=True)
    os.environ['TEMP'] = os.environ['TMP'] = str(temporary)
    tempfile.tempdir = str(temporary)
    os.environ['PLAYWRIGHT_BROWSERS_PATH'] = str(DATA_ROOT / 'tools' / 'playwright')
    os.environ['CRAWL4_AI_BASE_DIRECTORY'] = str(DATA_ROOT / 'crawler-cache')

initialize()
