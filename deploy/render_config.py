"""Generate public Pages configuration from repository variables, without .env."""

import argparse
import json
import os
from pathlib import Path
import re
from urllib.parse import urlsplit


def public_url(data_url):
    if not isinstance(data_url, str):
        raise ValueError("Public data URL must be a string")
    data_url = data_url.strip().rstrip("/")
    if data_url:
        parsed = urlsplit(data_url)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username
                or parsed.password or parsed.query or parsed.fragment):
            raise ValueError("MONITORING_DATA_URL must be a public HTTPS URL without credentials/query")
    return data_url


def configuration(data_url="", title="Сервер", servers_json=""):
    servers = []
    if servers_json.strip():
        entries = json.loads(servers_json)
        if not isinstance(entries, list) or not 1 <= len(entries) <= 50:
            raise ValueError("MONITORING_SERVERS must be a nonempty JSON array (up to 50 servers)")
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {"id", "title", "dataBaseUrl"}:
                raise ValueError("Each server must contain only id, title and dataBaseUrl")
            identity, label = entry["id"], entry["title"]
            if not isinstance(identity, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", identity):
                raise ValueError("Invalid public server id")
            if not isinstance(label, str) or not label.strip():
                raise ValueError("Server title must be a nonempty string")
            url = public_url(entry["dataBaseUrl"])
            if not url or any(server["id"] == identity for server in servers):
                raise ValueError("Server URLs must be nonempty and ids unique")
            servers.append({"id": identity, "title": label.strip(), "dataBaseUrl": url})
    data_url = public_url(data_url)
    result = {"enabled": bool(data_url or servers), "title": title.strip() or "Сервер",
              "dataBaseUrl": data_url, "refreshSeconds": 60, "staleAfterSeconds": 420}
    if servers:
        result.update(title=servers[0]["title"], dataBaseUrl=servers[0]["dataBaseUrl"], servers=servers)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path,
                        default=Path(__file__).resolve().parent.parent / "web/config.js")
    args = parser.parse_args()
    settings = configuration(os.environ.get("MONITORING_DATA_URL", ""),
                             os.environ.get("MONITORING_TITLE", "Сервер"),
                             os.environ.get("MONITORING_SERVERS", ""))
    args.output.write_text("// Generated public configuration. No write credentials.\n"
                           "window.MONITORING_CONFIG = Object.freeze("
                           + json.dumps(settings, ensure_ascii=False, indent=2) + ");\n",
                           encoding="utf-8")


if __name__ == "__main__":
    main()
