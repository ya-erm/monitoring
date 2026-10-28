"""Read only host-wide counters; never inspect process directories or identity."""

from dataclasses import dataclass
import math
import os
from pathlib import Path
import time


# This allowlist is also enforced immediately before persistence and upload.
METRICS = frozenset({
    "interval_s", "cpu_busy_pct", "cpu_user_pct", "cpu_system_pct",
    "cpu_iowait_pct", "cpu_steal_pct", "load1", "load5", "load15",
    "mem_total_bytes", "mem_available_bytes", "swap_total_bytes", "swap_used_bytes",
    "net_rx_bytes_s", "net_tx_bytes_s", "disk_read_bytes_s", "disk_write_bytes_s",
    "disk_total_bytes", "disk_available_bytes",
})


def public_sample(sample):
    """Reject unknown fields, strings, booleans, NaN, and Infinity before publishing."""
    if set(sample) != METRICS | {"ts"}:
        raise ValueError("Sample fields do not match the public schema")
    if type(sample["ts"]) is not int or sample["ts"] <= 0:
        raise ValueError("Invalid sample timestamp")
    if type(sample["interval_s"]) not in {int, float} or sample["interval_s"] <= 0:
        raise ValueError("Invalid measurement interval")
    for key in METRICS:
        value = sample[key]
        if value is not None and (type(value) not in {int, float} or not math.isfinite(value)):
            raise ValueError(f"Non-numeric public metric: {key}")
    return dict(sample)


def cpu_times(text):
    # guest / guest_nice are already included in user / nice: never count twice.
    values = [int(value) for value in text.splitlines()[0].split()[1:9]]
    if len(values) != 8:
        raise ValueError("Unsupported /proc/stat CPU counters")
    return tuple(values)


def memory_values(text):
    values = {}
    for line in text.splitlines():
        key, _, rest = line.partition(":")
        if key in {"MemTotal", "MemAvailable", "SwapTotal", "SwapFree"}:
            values[key] = int(rest.split()[0]) * 1024
    return values


def network_counters(text):
    result = {}
    for line in text.splitlines()[2:]:
        name, _, rest = line.partition(":")
        values = rest.split()
        if len(values) >= 16:
            result[name.strip()] = (int(values[0]), int(values[8]))
    return result


def disk_counters(text):
    result = {}
    for line in text.splitlines():
        fields = line.split()
        if len(fields) >= 14:
            # diskstats sectors are always 512 bytes, regardless of physical sector size.
            result[fields[2]] = (int(fields[5]) * 512, int(fields[9]) * 512)
    return result


def default_interfaces(proc):
    names = set()
    try:
        for line in (proc / "net/route").read_text().splitlines()[1:]:
            fields = line.split()
            if len(fields) >= 4 and fields[1] == "00000000" and int(fields[3], 16) & 1:
                names.add(fields[0])
    except FileNotFoundError:
        pass
    try:
        for line in (proc / "net/ipv6_route").read_text().splitlines():
            fields = line.split()
            if (len(fields) >= 10 and fields[0] == "0" * 32 and fields[1] == "00"
                    and int(fields[8], 16) & 1):
                names.add(fields[-1])
    except FileNotFoundError:
        pass
    return tuple(sorted(names - {"lo"}))


def root_disk(path, sys_path=Path("/sys")):
    device = os.stat(path).st_dev
    link = sys_path / "dev/block" / f"{os.major(device)}:{os.minor(device)}"
    if not link.exists():
        return ()
    block = link.resolve()
    if (block / "partition").exists():
        block = block.parent
    return (block.name,)


def rates(before, after, elapsed):
    # A reset or change of interfaces/devices must produce a gap, never a spike.
    if elapsed <= 0 or not after or before.keys() != after.keys():
        return None, None
    totals = [0, 0]
    for name, counters in after.items():
        for index, value in enumerate(counters):
            delta = value - before[name][index]
            if delta < 0:
                return None, None
            totals[index] += delta
    return tuple(round(value / elapsed, 2) for value in totals)


@dataclass
class Snapshot:
    ts: int
    monotonic: float
    cpu: tuple
    memory: dict
    load: tuple
    network: dict
    disk: dict
    capacity: tuple


class Collector:
    def __init__(self, config, proc=Path("/proc"), sys_path=Path("/sys")):
        self.config = config
        self.proc = proc
        self.devices = config.disk_devices or root_disk(config.disk_path, sys_path)

    def snapshot(self):
        read = lambda name: (self.proc / name).read_text()
        interfaces = self.config.interfaces or default_interfaces(self.proc)
        network = network_counters(read("net/dev"))
        disk = disk_counters(read("diskstats"))
        fs = os.statvfs(self.config.disk_path)
        return Snapshot(
            int(time.time()), time.monotonic(), cpu_times(read("stat")),
            memory_values(read("meminfo")),
            tuple(float(x) for x in read("loadavg").split()[:3]),
            {name: network[name] for name in interfaces if name in network},
            {name: disk[name] for name in self.devices if name in disk},
            (fs.f_blocks * fs.f_frsize, fs.f_bavail * fs.f_frsize),
        )

    @staticmethod
    def sample(before, after):
        elapsed = after.monotonic - before.monotonic
        if elapsed <= 0:
            raise ValueError("Non-positive measurement interval")
        sample = dict.fromkeys(METRICS)
        sample.update(ts=after.ts, interval_s=round(elapsed, 3))
        delta = [new - old for old, new in zip(before.cpu, after.cpu)]
        total = sum(delta)
        # Linux iowait can decrease. Treat such intervals as unknown.
        if total > 0 and all(value >= 0 for value in delta):
            pct = lambda value: round(value * 100 / total, 3)
            sample.update(
                cpu_user_pct=pct(delta[0] + delta[1]),
                cpu_system_pct=pct(delta[2] + delta[5] + delta[6]),
                cpu_busy_pct=pct(sum(delta[index] for index in (0, 1, 2, 5, 6))),
                cpu_iowait_pct=pct(delta[4]), cpu_steal_pct=pct(delta[7]),
            )
        memory = after.memory
        sample.update(
            load1=after.load[0], load5=after.load[1], load15=after.load[2],
            mem_total_bytes=memory["MemTotal"], mem_available_bytes=memory["MemAvailable"],
            swap_total_bytes=memory["SwapTotal"],
            swap_used_bytes=memory["SwapTotal"] - memory["SwapFree"],
            disk_total_bytes=after.capacity[0], disk_available_bytes=after.capacity[1],
        )
        sample["net_rx_bytes_s"], sample["net_tx_bytes_s"] = rates(
            before.network, after.network, elapsed)
        sample["disk_read_bytes_s"], sample["disk_write_bytes_s"] = rates(
            before.disk, after.disk, elapsed)
        return public_sample(sample)
