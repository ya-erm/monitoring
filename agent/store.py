"""A bounded SQLite spool shared by independent collection and upload processes."""

from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3

from .metrics import METRICS, public_sample


def hour_key(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d/%H")


def encode(value):
    return json.dumps(value, separators=(",", ":"), allow_nan=False).encode()


def aggregate(samples):
    """Five-minute time-weighted averages plus peak CPU and minimum available RAM."""
    groups = {}
    for raw in samples:
        sample = public_sample(raw)
        groups.setdefault(sample["ts"] // 300 * 300, []).append(sample)
    result = []
    for ts, group in sorted(groups.items()):
        row = {"ts": ts, "count": len(group)}
        for key in METRICS:
            known = [(s[key], min(s["interval_s"], 300)) for s in group if s[key] is not None]
            weight = sum(w for _, w in known)
            row[key] = round(sum(value * w for value, w in known) / weight, 3) if weight else None
        cpus = [s["cpu_busy_pct"] for s in group if s["cpu_busy_pct"] is not None]
        available = [s["mem_available_bytes"] for s in group if s["mem_available_bytes"] is not None]
        row["cpu_peak_pct"] = max(cpus) if cpus else None
        row["mem_available_min_bytes"] = min(available) if available else None
        result.append(row)
    return result


class Store:
    def __init__(self, directory: Path):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(directory / "metrics.sqlite3", timeout=5)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA auto_vacuum=INCREMENTAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS samples (
                ts INTEGER PRIMARY KEY, hour TEXT NOT NULL, payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS samples_hour ON samples(hour);
            CREATE TABLE IF NOT EXISTS pending (hour TEXT PRIMARY KEY, revision INTEGER NOT NULL);
        """)

    def close(self):
        self.db.close()

    def add(self, raw):
        sample = public_sample(raw)
        hour = hour_key(sample["ts"])
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO samples VALUES (?, ?, ?)",
                            (sample["ts"], hour, encode(sample).decode()))
            self.db.execute("""INSERT INTO pending VALUES (?, 1)
                ON CONFLICT(hour) DO UPDATE SET revision=revision+1""", (hour,))

    def prune(self, now, days):
        # Only complete UTC days are pruned, keeping daily aggregate uploads complete.
        cutoff = (now // 86400 - days) * 86400
        with self.db:
            deleted = self.db.execute("DELETE FROM samples WHERE ts < ?", (cutoff,)).rowcount
            self.db.execute("DELETE FROM pending WHERE hour < ?", (hour_key(cutoff),))
        return deleted

    def pending(self, limit):
        return self.db.execute("SELECT hour, revision FROM pending ORDER BY hour DESC LIMIT ?",
                               (limit,)).fetchall()

    def acknowledge(self, hour, revision):
        # A concurrent collector may have changed this hour while PUT was in progress.
        with self.db:
            self.db.execute("DELETE FROM pending WHERE hour=? AND revision=?", (hour, revision))

    def samples(self, start, end):
        rows = self.db.execute("SELECT payload FROM samples WHERE hour >= ? AND hour < ? ORDER BY ts",
                               (start, end))
        return [public_sample(json.loads(row[0])) for row in rows]

    def hour(self, key):
        return self.samples(key, key + "~")

    def day(self, key):
        return self.samples(key + "/00", key + "/99")

    def latest(self):
        row = self.db.execute("SELECT payload FROM samples ORDER BY ts DESC LIMIT 1").fetchone()
        return public_sample(json.loads(row[0])) if row else None
