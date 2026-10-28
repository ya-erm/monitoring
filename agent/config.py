"""Configuration without shell execution, interpolation, or implicit AWS credentials."""

from dataclasses import dataclass
import os
from pathlib import Path
import re
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent.parent


def read_env(path: Path) -> dict[str, str]:
    values = {}
    if not path.exists():
        return values
    for number, original in enumerate(path.read_text().splitlines(), 1):
        line = original.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            raise ValueError(f"Invalid .env assignment on line {number}")
        value = value.strip()
        if value.startswith(("'", '"')):
            if len(value) < 2 or value[-1] != value[0]:
                raise ValueError(f"Unclosed .env quote on line {number}")
            value = value[1:-1]
        values[key] = value
    return values


@dataclass(frozen=True)
class Config:
    enabled: bool
    sample_seconds: int
    state_dir: Path
    retention_days: int
    interfaces: tuple[str, ...]
    disk_devices: tuple[str, ...]
    disk_path: str
    endpoint: str
    region: str
    bucket: str
    prefix: str
    access_key: str
    secret_key: str
    session_token: str
    addressing_style: str
    upload_max_hours: int

    @classmethod
    def load(cls, env_file: Path = ROOT / ".env", environ=None):
        values = read_env(env_file)
        values.update(os.environ if environ is None else environ)

        def get(key, default=""):
            return values.get(key, default).strip()

        def integer(key, default, low, high):
            try:
                result = int(get(key, str(default)))
            except ValueError:
                raise ValueError(f"{key} must be an integer") from None
            if not low <= result <= high:
                raise ValueError(f"{key} must be between {low} and {high}")
            return result

        enabled = get("MONITOR_ENABLED", "false").lower()
        if enabled not in {"true", "false"}:
            raise ValueError("MONITOR_ENABLED must be true or false")
        state = Path(get("MONITOR_STATE_DIR", "./state"))
        if not state.is_absolute():
            state = env_file.resolve().parent / state
        prefix = get("S3_PREFIX", "monitoring/server-1").strip("/")
        if not re.fullmatch(r"[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*", prefix):
            raise ValueError("S3_PREFIX must contain only safe, nonempty path segments")
        endpoint = get("S3_ENDPOINT_URL")
        if endpoint:
            url = urlsplit(endpoint)
            if (url.scheme != "https" or not url.hostname or url.username
                    or url.password or url.query or url.fragment):
                raise ValueError("S3_ENDPOINT_URL must be an HTTPS URL without credentials/query")
        style = get("S3_ADDRESSING_STYLE", "auto")
        if style not in {"auto", "path", "virtual"}:
            raise ValueError("S3_ADDRESSING_STYLE must be auto, path, or virtual")

        def names(key):
            result = tuple(x.strip() for x in get(key).split(",") if x.strip())
            if any(not re.fullmatch(r"[A-Za-z0-9_.:-]+", x) for x in result):
                raise ValueError(f"Invalid device/interface name in {key}")
            return tuple(dict.fromkeys(result))

        return cls(
            enabled == "true",
            integer("MONITOR_SAMPLE_SECONDS", 15, 5, 300),
            state.resolve(),
            integer("MONITOR_LOCAL_RETENTION_DAYS", 7, 1, 90),
            names("MONITOR_INTERFACES"), names("MONITOR_DISK_DEVICES"),
            get("MONITOR_DISK_PATH", "/"), endpoint, get("S3_REGION", "us-east-1"),
            get("S3_BUCKET"), prefix, get("S3_ACCESS_KEY_ID"),
            get("S3_SECRET_ACCESS_KEY"), get("S3_SESSION_TOKEN"), style,
            integer("MONITOR_UPLOAD_MAX_HOURS", 12, 1, 168),
        )

    def validate_upload(self):
        required = {
            "S3_BUCKET": self.bucket,
            "S3_ACCESS_KEY_ID": self.access_key,
            "S3_SECRET_ACCESS_KEY": self.secret_key,
        }
        missing = [key for key, value in required.items() if not value]
        if missing:
            raise ValueError("Missing settings: " + ", ".join(missing))

    def status(self):
        return {
            "enabled": self.enabled,
            "sample_seconds": self.sample_seconds,
            "local_retention_days": self.retention_days,
            "upload_configured": bool(self.bucket and self.access_key and self.secret_key),
        }
