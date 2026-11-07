"""S3 publishing is optional and never runs in the collector process."""

import fcntl
import gzip
from hashlib import sha256
import time

from .store import Store, aggregate, encode, hour_key


def s3_client(config):
    # Import only after the feature switch and explicit credential checks.
    import boto3
    from botocore.config import Config as S3Config

    return boto3.client(
        "s3", endpoint_url=config.endpoint or None, region_name=config.region,
        aws_access_key_id=config.access_key, aws_secret_access_key=config.secret_key,
        aws_session_token=config.session_token or None,
        config=S3Config(
            signature_version="s3v4", connect_timeout=5, read_timeout=10,
            retries={"mode": "standard", "total_max_attempts": 2},
            s3={"addressing_style": config.addressing_style},
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        ),
    )


def publish(config, client_factory=s3_client):
    if not config.enabled:
        return 0
    config.validate_upload()
    config.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (config.state_dir / "upload.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        store = Store(config.state_dir)
        try:
            cutoff = hour_key(int(time.time()))
            client = None
            count = 0

            def put(key, body):
                nonlocal client, count
                if client is None:
                    client = client_factory(config)
                client.put_object(
                    Bucket=config.bucket, Key=f"{config.prefix}/{key}",
                    Body=gzip.compress(body, mtime=0),
                    ContentType="application/json", ContentEncoding="gzip",
                    CacheControl="public, max-age=30, must-revalidate",
                )
                count += 1

            # Archive first: readers switching to a new live hour/day can then
            # use the completed archive. Acknowledge each successful PUT on its own.
            for hour, revision in store.pending(config.upload_max_hours, cutoff):
                rows = store.hour(hour)
                if rows:  # The collector may have pruned the batch since selection.
                    put(f"hours/{hour}.json", encode({"schema": 1, "resolution_s": config.sample_seconds,
                                                     "samples": rows}))
                store.acknowledge(hour, revision)
            for day, revision in store.pending_days(config.upload_max_hours, cutoff[:10]):
                rows = store.day(day)
                if rows:
                    put(f"days/{day}.json", encode({"schema": 1, "resolution_s": 300,
                                                    "samples": aggregate(rows)}))
                store.acknowledge_day(day, revision)

            # Read the latest sample and its day from one SQLite snapshot.
            with store.db:
                store.db.execute("BEGIN")
                latest = store.latest()
                if not latest:
                    return count
                hour = hour_key(latest["ts"])
                day = hour[:10]
                rows = store.day(day)
            hour_start = latest["ts"] // 3600 * 3600
            body = encode({"schema": 1, "sample_interval_s": config.sample_seconds, "sample": latest,
                           "live_hour": {"key": f"hours/{hour}.json", "resolution_s": config.sample_seconds,
                                         "samples": [row for row in rows if row["ts"] >= hour_start]},
                           "live_day": {"key": f"days/{day}.json", "resolution_s": 300,
                                        "samples": aggregate(rows)}})
            digest = sha256(body).hexdigest()
            if store.live_digest() != digest:
                put("latest.json", body)
                store.acknowledge_live(digest)
            return count
        finally:
            store.close()
