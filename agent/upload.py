"""S3 publishing is optional and never runs in the collector process."""

import fcntl
import gzip

from .store import Store, aggregate, encode


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
            pending = store.pending(config.upload_max_hours)
            if not pending:
                return 0
            client = client_factory(config)

            def put(key, document):
                client.put_object(
                    Bucket=config.bucket, Key=f"{config.prefix}/{key}",
                    Body=gzip.compress(encode(document), mtime=0),
                    ContentType="application/json", ContentEncoding="gzip",
                    CacheControl="public, max-age=30, must-revalidate",
                )

            # Upload before acknowledging. Any failed PUT leaves the spool retryable.
            for hour, _ in pending:
                put(f"hours/{hour}.json", {"schema": 1, "resolution_s": config.sample_seconds,
                                          "samples": store.hour(hour)})
            for day in sorted({hour[:10] for hour, _ in pending}):
                put(f"days/{day}.json", {"schema": 1, "resolution_s": 300,
                                       "samples": aggregate(store.day(day))})
            put("latest.json", {"schema": 1, "sample_interval_s": config.sample_seconds,
                                "sample": store.latest()})
            for hour, revision in pending:
                store.acknowledge(hour, revision)
            return len(pending)
        finally:
            store.close()
