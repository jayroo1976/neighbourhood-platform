#!/usr/bin/env python3
"""
Two jobs, both for the outside (IQAir Palm) readings, from the hourly CSV of what the station page showed
(columns "page_time_dubai" = Dubai time, "temp_c", "humidity_pct", "ha_written"):

  --compare   Reads what Home Assistant has recorded for the sensor over the same hours and prints how closely it
              matches the station readings in the CSV. Writes nothing.
  (default)   Backfill: loads the CSV hours into Home Assistant's long-term statistics so the Fresh air monitoring
              charts (week / month / all time) have them.

--metric temperature (default) or humidity chooses the column and the sensor. Rows with no value are skipped;
several rows in one hour are averaged.

Default mode writes into the existing entity's own statistics (source "recorder", statistic id
sensor.palm_outside_temperature) and ONLY for hours earlier than its first existing statistic, so nothing
Home Assistant already holds is changed. Use --external to write a separate imported series instead
("iqair:palm_temperature" / "iqair:palm_humidity"), which REPLACES nothing in Home Assistant but starts only where
the CSV starts; then set outside.temperature / outside.humidity in HA_AIR_SENSORS to that id (the page then shows the
latest hourly average rather than the live value, and the series only grows when this script is run again with a newer CSV).

Needs:  pip install websocket-client
Usage:  HA_TOKEN=<long-lived token> python3 ha-import-statistics.py iqair-palm-readings.csv \
            --url http://192.168.107.5:8123 [--metric humidity] [--entity sensor.x] [--compare] [--external] [--dry-run]
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


def read_hours(path, column="temp_c", with_flag=False):
    sums = defaultdict(lambda: [0.0, 0])
    written = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            try:
                t = datetime.strptime(row["page_time_dubai"].strip(), "%Y-%m-%d %H:%M").replace(tzinfo=DUBAI)
                v = float(row[column])
            except (KeyError, ValueError):
                continue
            start = t.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
            sums[start][0] += v
            sums[start][1] += 1
            written[start] = written.get(start, False) or row.get("ha_written", "").strip().lower() == "yes"
    out = {k: round(s / n, 2) for k, (s, n) in sorted(sums.items())}
    return (out, written) if with_flag else out


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


METRICS = {
    "temperature": {"column": "temp_c", "entity": "sensor.palm_outside_temperature", "external": "iqair:palm_temperature", "unit": "°C", "name": "IQAir Palm outside temperature"},
    "humidity": {"column": "humidity_pct", "entity": "sensor.palm_outside_humidity", "external": "iqair:palm_humidity", "unit": "%", "name": "IQAir Palm outside humidity"},
}


def parse_start(s):
    # "start" is epoch ms (newer HA) or an ISO string (older HA)
    return datetime.fromtimestamp(s / 1000, timezone.utc) if isinstance(s, (int, float)) else datetime.fromisoformat(s.replace("Z", "+00:00"))


def compare(ha, sid, hours, written):
    rows = ha.call(type="recorder/statistics_during_period", start_time=min(hours).isoformat(), statistic_ids=[sid], period="hour", types=["mean"]).get(sid, [])
    got = {parse_start(r["start"]): r.get("mean") for r in rows if r.get("mean") is not None}
    both = [(k, v, got[k]) for k, v in hours.items() if k in got]
    missing = [k for k in hours if k not in got]
    print(f"\nStation CSV hours: {len(hours)}   Home Assistant hours with a value: {len(got)}   in both: {len(both)}")
    if not both:
        print("No overlapping hours, so nothing to compare.")
        return
    diffs = [abs(c - h) for _, c, h in both]
    same = sum(1 for d in diffs if d < 0.5)
    print(f"Within 0.5 of the station reading: {same} of {len(both)} ({100 * same // len(both)}%).  Mean difference {sum(diffs) / len(diffs):.2f}, largest {max(diffs):.1f}")
    for flag, label in ((True, "hours the collector wrote into Home Assistant"), (False, "hours it did not write")):
        sub = [(k, c, h) for k, c, h in both if written.get(k, False) == flag]
        if sub:
            ok = sum(1 for _, c, h in sub if abs(c - h) < 0.5)
            print(f"  {label}: {ok} of {len(sub)} match")
    off = [(k, c, h) for k, c, h in both if abs(c - h) >= 1]
    if off:
        print(f"Hours differing by 1 or more ({len(off)}), first 15 (Dubai time, station, Home Assistant):")
        for k, c, h in off[:15]:
            print(f"  {(k + timedelta(hours=4)):%Y-%m-%d %H:%M}  station {c:g}  HA {h:.1f}")
    if missing:
        print(f"Station hours Home Assistant has no value for: {len(missing)} (first {(min(missing) + timedelta(hours=4)):%Y-%m-%d %H:%M}, last {(max(missing) + timedelta(hours=4)):%Y-%m-%d %H:%M} Dubai)")
    latest = max(got)
    print(f"Home Assistant's newest hourly value: {(latest + timedelta(hours=4)):%Y-%m-%d %H:%M} Dubai; the CSV's newest hour: {(max(hours) + timedelta(hours=4)):%Y-%m-%d %H:%M} Dubai")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--url", required=True, help="Home Assistant address, e.g. http://192.168.107.5:8123")
    ap.add_argument("--metric", choices=sorted(METRICS), default="temperature")
    ap.add_argument("--entity", help="Home Assistant sensor (default depends on --metric)")
    ap.add_argument("--compare", action="store_true", help="only compare Home Assistant with the CSV; write nothing")
    ap.add_argument("--external", action="store_true", help="import as iqair:palm_temperature instead of into the entity")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    token = os.environ.get("HA_TOKEN")
    if not token:
        sys.exit("Set HA_TOKEN in the environment (a long-lived access token).")

    m = METRICS[a.metric]
    a.entity = a.entity or m["entity"]
    hours, written = read_hours(a.csv, m["column"], with_flag=True)
    if not hours:
        sys.exit("No usable rows in the CSV.")
    print(f"CSV: {len(hours)} hours, {min(hours):%Y-%m-%d %H:%M} to {max(hours):%Y-%m-%d %H:%M} UTC")

    ha = Ha(a.url, token)
    if a.compare:
        compare(ha, a.entity, hours, written)
        return
    if a.external:
        sid, source, name = m["external"], "iqair", m["name"]
        cutoff = None
    else:
        sid, source, name = a.entity, "recorder", None
        meta = ha.call(type="recorder/get_statistics_metadata", statistic_ids=[sid])
        if not meta:
            sys.exit(f"{sid} has no long-term statistics in Home Assistant (needs state_class: measurement). Re-run with --external.")
        name = meta[0].get("name") or sid
        existing = ha.call(type="recorder/statistics_during_period", start_time="2020-01-01T00:00:00Z", statistic_ids=[sid], period="hour", types=["mean"]).get(sid, [])
        starts = [r["start"] for r in existing]
        cutoff = min(parse_start(s) for s in starts) if starts else None
        print(f"{sid}: first existing statistic {cutoff:%Y-%m-%d %H:%M} UTC" if cutoff else f"{sid}: no existing statistics")

    rows = [{"start": k.isoformat(), "mean": v, "min": v, "max": v} for k, v in hours.items() if cutoff is None or k < cutoff]
    print(f"Importing {len(rows)} hours into {sid}" + (" (dry run, nothing written)" if a.dry_run else ""))
    if rows and not a.dry_run:
        ha.call(
            type="recorder/import_statistics",
            metadata={"has_mean": True, "has_sum": False, "name": name, "source": source, "statistic_id": sid, "unit_of_measurement": m["unit"]},
            stats=rows,
        )
        print("Done. Reload the Fresh air monitoring page and choose Week, Month or All time.")


if __name__ == "__main__":
    main()
