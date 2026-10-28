"""Generate public Pages configuration from repository variables, without .env."""

import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlsplit


def configuration(data_url="", title="Сервер"):
    data_url = data_url.strip().rstrip("/")
    if data_url:
        parsed = urlsplit(data_url)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username
                or parsed.password or parsed.query or parsed.fragment):
            raise ValueError("MONITORING_DATA_URL must be a public HTTPS URL without credentials/query")
    return {"enabled": bool(data_url), "title": title.strip() or "Сервер",
            "dataBaseUrl": data_url, "refreshSeconds": 60, "staleAfterSeconds": 150}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path,
                        default=Path(__file__).resolve().parent.parent / "web/config.js")
    args = parser.parse_args()
    settings = configuration(os.environ.get("MONITORING_DATA_URL", ""),
                             os.environ.get("MONITORING_TITLE", "Сервер"))
    args.output.write_text("// Generated public configuration. No write credentials.\n"
                           "window.MONITORING_CONFIG = Object.freeze("
                           + json.dumps(settings, ensure_ascii=False, indent=2) + ");\n",
                           encoding="utf-8")


if __name__ == "__main__":
    main()
