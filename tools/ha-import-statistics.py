#!/usr/bin/env python3
"""
One-off backfill: load hourly outside-temperature history into Home Assistant's long-term statistics,
so the Fresh air monitoring charts (week / month / all time) show the outside line from before the sensor
was recorded.

Input is a CSV with a "page_time_dubai" column (YYYY-MM-DD HH:MM, Dubai time) and a "temp_c" column
(the IQAir Palm readings file). Rows with no temperature are skipped; several rows in one hour are averaged.

Default mode writes into the existing entity's own statistics (source "recorder", statistic id
sensor.palm_outside_temperature) and ONLY for hours earlier than its first existing statistic, so nothing
Home Assistant already holds is changed. Use --external to write a separate imported series instead
("iqair:palm_temperature"); then set outside.temperature in HA_AIR_SENSORS to that id (the page then
shows the latest hourly average rather than the live value).

Needs:  pip install websocket-client
Usage:  HA_TOKEN=<long-lived token> python3 ha-import-statistics.py iqair-palm-readings.csv \
            --url http://192.168.107.5:8123 [--entity sensor.palm_outside_temperature] [--external] [--dry-run]
The token is read from the environment only. Run it once; running it again is harmless (same hours, same values).
"""
import argparse, csv, json, os, sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

try:
    import websocket  # type: ignore
except ImportError:
    sys.exit("Install the WebSocket client first:  pip install websocket-client")

DUBAI = timezone(timedelta(hours=4))


def read_hours(path):
    sums = defaultdict(lambda: [0.0, 0])
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            try:
                t = datetime.strptime(row["page_time_dubai"].strip(), "%Y-%m-%d %H:%M").replace(tzinfo=DUBAI)
                v = float(row["temp_c"])
            except (KeyError, ValueError):
                continue
            start = t.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
            sums[start][0] += v
            sums[start][1] += 1
    return {k: round(s / n, 2) for k, (s, n) in sorted(sums.items())}


class Ha:
    def __init__(self, url, token):
        self.ws = websocket.create_connection(url.replace("http", "ws", 1).rstrip("/") + "/api/websocket", timeout=30)
        self.n = 0
        self.recv()  # auth_required
        self.ws.send(json.dumps({"type": "auth", "access_token": token}))
        if self.recv().get("type") != "auth_ok":
            sys.exit("Home Assistant rejected the token.")

    def recv(self):
        return json.loads(self.ws.recv())

    def call(self, **msg):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, **msg}))
        while True:
            r = self.recv()
            if r.get("id") == self.n:
                if not r.get("success"):
                    sys.exit(f"Home Assistant refused {msg['type']}: {r.get('error')}")
                return r.get("result")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--url", required=True, help="Home Assistant address, e.g. http://192.168.107.5:8123")
    ap.add_argument("--entity", default="sensor.palm_outside_temperature")
    ap.add_argument("--external", action="store_true", help="import as iqair:palm_temperature instead of into the entity")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    token = os.environ.get("HA_TOKEN")
    if not token:
        sys.exit("Set HA_TOKEN in the environment (a long-lived access token).")

    hours = read_hours(a.csv)
    if not hours:
        sys.exit("No usable rows in the CSV.")
    print(f"CSV: {len(hours)} hours, {min(hours):%Y-%m-%d %H:%M} to {max(hours):%Y-%m-%d %H:%M} UTC")

    ha = Ha(a.url, token)
    if a.external:
        sid, source, name = "iqair:palm_temperature", "iqair", "IQAir Palm outside temperature"
        cutoff = None
    else:
        sid, source, name = a.entity, "recorder", None
        meta = ha.call(type="recorder/get_statistics_metadata", statistic_ids=[sid])
        if not meta:
            sys.exit(f"{sid} has no long-term statistics in Home Assistant (needs state_class: measurement). Re-run with --external.")
        name = meta[0].get("name") or sid
        existing = ha.call(type="recorder/statistics_during_period", start_time="2020-01-01T00:00:00Z", statistic_ids=[sid], period="hour", types=["mean"]).get(sid, [])
        starts = [r["start"] for r in existing]
        # "start" is epoch ms (newer HA) or an ISO string (older HA)
        parse = lambda s: datetime.fromtimestamp(s / 1000, timezone.utc) if isinstance(s, (int, float)) else datetime.fromisoformat(s.replace("Z", "+00:00"))
        cutoff = min(parse(s) for s in starts) if starts else None
        print(f"{sid}: first existing statistic {cutoff:%Y-%m-%d %H:%M} UTC" if cutoff else f"{sid}: no existing statistics")

    rows = [{"start": k.isoformat(), "mean": v, "min": v, "max": v} for k, v in hours.items() if cutoff is None or k < cutoff]
    print(f"Importing {len(rows)} hours into {sid}" + (" (dry run, nothing written)" if a.dry_run else ""))
    if rows and not a.dry_run:
        ha.call(
            type="recorder/import_statistics",
            metadata={"has_mean": True, "has_sum": False, "name": name, "source": source, "statistic_id": sid, "unit_of_measurement": "°C"},
            stats=rows,
        )
        print("Done. Reload the Fresh air monitoring page and choose Week, Month or All time.")


if __name__ == "__main__":
    main()
