from contextlib import redirect_stdout
from dataclasses import replace
import gzip
import io
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from agent.__main__ import collect, main
from agent.config import Config
from agent.metrics import (METRICS, Collector, Snapshot, cpu_times, default_interfaces,
                           disk_counters, public_sample, rates)
from agent.store import Store, aggregate, hour_key
from agent.upload import publish, s3_client


def sample(ts=1761440400, **updates):
    result = dict.fromkeys(METRICS, 0)
    result.update(ts=ts, interval_s=15, mem_total_bytes=4 * 2**30,
                  mem_available_bytes=2 * 2**30)
    result.update(updates)
    return result


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = self.root / ".env"
        self.env.write_text("MONITOR_ENABLED=false\nMONITOR_STATE_DIR=state\n")
        self.config = Config.load(self.env, environ={})

    def tearDown(self):
        self.temp.cleanup()

    def configured(self):
        return replace(self.config, enabled=True, bucket="test-bucket", access_key="fake-id",
                       secret_key="fake-secret", prefix="monitoring/test")

    def test_disabled_commands_create_no_state_and_make_no_client(self):
        def forbidden(_):
            self.fail("Disabled upload attempted to create a client")

        collect(self.config)
        self.assertEqual(publish(self.config, forbidden), 0)
        for command in ("status", "once", "run", "upload"):
            with patch.dict("os.environ", {}, clear=True), redirect_stdout(io.StringIO()):
                self.assertEqual(main(["--env-file", str(self.env), command]), 0)
        self.assertFalse(self.config.state_dir.exists())

    def test_environment_override_is_explicit_and_status_never_contains_secrets(self):
        config = Config.load(self.env, environ={"MONITOR_ENABLED": "true",
                                               "S3_SECRET_ACCESS_KEY": "do-not-publish"})
        self.assertTrue(config.enabled)
        self.assertNotIn("do-not-publish", json.dumps(config.status()))

    def test_configuration_rejects_invalid_switch_path_and_insecure_endpoint(self):
        for key, value in (("MONITOR_ENABLED", "yes"), ("S3_PREFIX", "../other"),
                           ("S3_ENDPOINT_URL", "http://example.com"),
                           ("S3_ENDPOINT_URL", "https://secret@example.com"),
                           ("MONITOR_SAMPLE_SECONDS", "0")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                Config.load(self.env, environ={key: value})

    def test_missing_credentials_fail_before_state_and_network(self):
        with self.assertRaises(ValueError):
            publish(replace(self.config, enabled=True), lambda _: self.fail("Network"))
        self.assertFalse(self.config.state_dir.exists())

    def test_cpu_guest_is_not_counted_twice(self):
        self.assertEqual(sum(cpu_times("cpu 100 10 20 300 5 2 3 10 50 5\n")), 450)

    def test_cpu_and_counter_rates_use_interval_not_wall_clock(self):
        before = Snapshot(1000, 10, (100, 0, 100, 700, 0, 0, 0, 0), {}, (),
                          {"eth0": (1000, 2000)}, {"vda": (100, 200)}, ())
        after = Snapshot(900, 25, (130, 0, 120, 730, 10, 0, 0, 10),
                         {"MemTotal": 4096, "MemAvailable": 1024, "SwapTotal": 2048,
                          "SwapFree": 1536}, (1.5, 1.0, .5),
                         {"eth0": (2500, 5000)}, {"vda": (1600, 3200)}, (10000, 8000))
        result = Collector.sample(before, after)
        self.assertEqual(result["cpu_busy_pct"], 50)
        self.assertEqual(result["cpu_iowait_pct"], 10)
        self.assertEqual(result["cpu_steal_pct"], 10)
        self.assertEqual(result["net_rx_bytes_s"], 100)
        self.assertEqual(result["net_tx_bytes_s"], 200)
        self.assertEqual(result["swap_used_bytes"], 512)
        self.assertEqual(result["interval_s"], 15)

    def test_reset_interface_change_and_missing_devices_are_unknown(self):
        self.assertEqual(rates({"eth0": (100, 200)}, {"eth0": (5, 300)}, 15), (None, None))
        self.assertEqual(rates({"eth0": (100, 200)}, {"eth1": (1000, 2000)}, 15), (None, None))
        self.assertEqual(rates({}, {}, 15), (None, None))

    def test_default_routes_are_selected_without_docker_bridge(self):
        (self.root / "net").mkdir()
        (self.root / "net/route").write_text(
            "Iface Destination Gateway Flags\neth0 00000000 01010101 0003\n"
            "docker0 00001111 00000000 0001\n")
        (self.root / "net/ipv6_route").write_text(
            f"{'0' * 32} 00 {'0' * 32} 00 {'0' * 32} 00000000 00000000 00000000 00000001 eth1\n")
        self.assertEqual(default_interfaces(self.root), ("eth0", "eth1"))

    def test_disk_sectors_are_512_bytes(self):
        values = disk_counters("8 0 vda 1 0 20 0 1 0 40 0 0 0 0\n")
        self.assertEqual(values["vda"], (10240, 20480))

    def test_private_fields_strings_and_nonfinite_numbers_cannot_be_stored(self):
        for value in (sample(hostname="private"), sample(load1="private"),
                      sample(load1=float("nan")), sample(load1=float("inf")), sample(load1=True)):
            with self.subTest(value=value), self.assertRaises(ValueError):
                public_sample(value)

    def test_aggregation_preserves_peaks_and_weights_irregular_intervals(self):
        ts = 1761440400 // 300 * 300
        rows = aggregate([sample(ts, interval_s=5, cpu_busy_pct=20, mem_available_bytes=100),
                          sample(ts + 15, interval_s=15, cpu_busy_pct=100, mem_available_bytes=20)])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["cpu_busy_pct"], 80)
        self.assertEqual(rows[0]["cpu_peak_pct"], 100)
        self.assertEqual(rows[0]["mem_available_min_bytes"], 20)

    def test_store_prunes_complete_days_and_preserves_concurrent_revision(self):
        store = Store(self.config.state_dir)
        self.addCleanup(store.close)
        now = 1761440400
        store.add(sample(now - 10 * 86400))
        store.add(sample(now))
        hour, revision = store.pending(1)[0]
        store.add(sample(now + 15))
        store.acknowledge(hour, revision)
        self.assertTrue(store.pending(1))
        self.assertEqual(store.prune(now, 7), 1)
        self.assertEqual(len(store.hour(hour_key(now))), 2)

    def test_failed_upload_retains_pending_and_retry_sends_only_numeric_public_data(self):
        config = self.configured()
        store = Store(config.state_dir)
        self.addCleanup(store.close)
        store.add(sample())
        calls = []

        class BrokenClient:
            def put_object(self, **kwargs):
                raise RuntimeError("fake network failure")

        with self.assertRaises(RuntimeError):
            publish(config, lambda _: BrokenClient())
        self.assertEqual(len(store.pending(10)), 1)

        class Client:
            def put_object(self, **kwargs):
                calls.append(kwargs)

        self.assertEqual(publish(config, lambda _: Client()), 1)
        self.assertFalse(store.pending(10))
        self.assertEqual(len(calls), 3)
        self.assertTrue(calls[0]["Key"].startswith("monitoring/test/hours/"))
        self.assertTrue(calls[1]["Key"].startswith("monitoring/test/days/"))
        self.assertTrue(calls[2]["Key"].endswith("/latest.json"))
        for call in calls:
            self.assertEqual(call["ContentEncoding"], "gzip")
            self.assertNotIn("ACL", call)
            document = json.loads(gzip.decompress(call["Body"]))
            self.assertEqual(document["schema"], 1)
            for forbidden in ("fake-secret", "fake-id", "hostname", "eth0", "vda"):
                self.assertNotIn(forbidden, json.dumps(document))

    def test_sample_arriving_during_upload_is_not_acknowledged(self):
        config = self.configured()
        store = Store(config.state_dir)
        self.addCleanup(store.close)
        store.add(sample())

        class Client:
            def put_object(self, **kwargs):
                if "/hours/" in kwargs["Key"]:
                    store.add(sample(1761440415))

        publish(config, lambda _: Client())
        self.assertEqual(len(store.pending(10)), 1)

    @unittest.skipUnless(importlib.util.find_spec("boto3"), "optional boto3 is not installed")
    def test_real_s3_sdk_accepts_upload_parameters_without_network(self):
        from botocore.stub import ANY, Stubber

        config = replace(self.configured(), endpoint="https://s3.example.test")
        store = Store(config.state_dir)
        store.add(sample())
        store.close()
        client = s3_client(config)
        with Stubber(client) as stub:
            for key in (f"hours/{hour_key(1761440400)}.json",
                        f"days/{hour_key(1761440400)[:10]}.json", "latest.json"):
                stub.add_response("put_object", {}, {
                    "Bucket": config.bucket, "Key": f"{config.prefix}/{key}", "Body": ANY,
                    "ContentType": "application/json", "ContentEncoding": "gzip",
                    "CacheControl": "public, max-age=30, must-revalidate",
                })
            self.assertEqual(publish(config, lambda _: client), 1)
            stub.assert_no_pending_responses()


if __name__ == "__main__":
    unittest.main()
