"""Usage: python3 -m agent [--env-file PATH] status|run|once|upload."""

import argparse
import fcntl
import json
import logging
from pathlib import Path
import signal
import sys
import threading
import time

from .config import Config, ROOT


LOG = logging.getLogger("monitoring")


def collect(config, once=False):
    if not config.enabled:
        return
    if sys.platform != "linux":
        raise ValueError("Collection requires Linux; status and demo work on other systems")
    from .metrics import Collector
    from .store import Store

    config.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (config.state_dir / "collect.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another collector is already running") from None
        stop = threading.Event()
        for name in (signal.SIGTERM, signal.SIGINT):
            signal.signal(name, lambda *_: stop.set())
        collector = Collector(config)
        store = Store(config.state_dir)
        try:
            previous = collector.snapshot()
            next_sample = time.monotonic() + config.sample_seconds
            next_prune = 0
            while not stop.wait(max(0, next_sample - time.monotonic())):
                current = collector.snapshot()
                store.add(collector.sample(previous, current))
                previous = current
                if current.ts >= next_prune:
                    store.prune(current.ts, config.retention_days)
                    next_prune = current.ts + 3600
                if once:
                    break
                # Skip missed deadlines after overload rather than collecting a burst.
                next_sample = max(next_sample + config.sample_seconds,
                                  time.monotonic() + config.sample_seconds)
        finally:
            store.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=ROOT / ".env")
    parser.add_argument("command", choices=("status", "run", "once", "upload"))
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        config = Config.load(args.env_file)
        if args.command == "status":
            print(json.dumps(config.status(), indent=2))
            return 0
        if not config.enabled:
            print("Monitoring disabled (MONITOR_ENABLED=false); no collection or upload.")
            return 0
        if args.command == "upload":
            from .upload import publish
            count = publish(config)
            LOG.info("Uploaded %d hour(s)", count)
        else:
            collect(config, once=args.command == "once")
        return 0
    except (ValueError, OSError, ImportError):
        # Avoid exception text from HTTP clients/OS leaking endpoints or credentials.
        LOG.error("Configuration or local I/O error; check .env fields and permissions")
        return 1
    except Exception:
        LOG.error("Operation failed; pending local data retained for retry")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
