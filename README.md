# signalk-sailtracker

A small Signal K plugin that keeps a local logbook of the **sailboats around
you**. Every few minutes it looks at every AIS target the server currently
sees, keeps the ones that match your filters (by default: Class B
transponders on sailing and pleasure craft), and appends one track point per
boat to a JSON file. A bundled webapp draws the result on an OpenStreetMap +
OpenSeaMap chart.

Nothing leaves the boat — the log is a plain file in the plugin's data
directory, and the webapp is served by your own Signal K server.

## What it shows

- A sidebar listing every logged boat, newest sighting first
- All tracks at once, or a single boat's track in isolation
- A timeline scrubber for the selected boat: drag or press play to walk its
  track point by point, with speed, course and timestamp at each fix
- A range picker: the **last 2 days** by default, any single day, or the
  whole retained history

## Installation

Available through the Signal K app store, or manually:

```bash
cd ~/.signalk
npm install signalk-sailtracker
```

Then enable it under **Server → Plugin Config → ⛵ Sailtracker** and open it
from the Webapps menu.

## Configuration

| Setting          | Default       | What it does                                                                                                 |
| ---------------- | ------------- | ------------------------------------------------------------------------------------------------------------ |
| Log interval     | 5 min         | How often the vessel model is scanned                                                                        |
| AIS ship types   | `36, 37`      | Which AIS ship types to log (36 = Sailing, 37 = Pleasure craft)                                              |
| AIS class        | `B`           | `A`, `B`, or `both`. Larger cruising yachts often carry Class A — widen this if boats you expect are missing |
| Maximum range    | 0 (unlimited) | Ignore targets further than this many nautical miles from own vessel                                         |
| Position max age | 10 min        | Ignore targets whose last fix is older than this                                                             |
| Max track points | 2000          | Per-boat cap, newest kept                                                                                    |
| Retention        | 14 days       | Points older than this are dropped                                                                           |

Two filters explain most "why is boat X missing" questions: **AIS class** and
**ship type**. A yacht whose transponder is configured as type 99 ("Other")
will not match the defaults, and a Class A yacht will not match `B`.

## Weather

Each track point also records the conditions at that position and time:
wind direction (degrees true, the direction the wind comes _from_), wind
speed in knots, and significant wave height in metres. `null` means no
source could answer — never "calm".

Two sources are tried, in order:

1. **This server's own weather provider**, via Signal K's Weather API. A
   GRIB provider serving local GRIB2 files lands here, so this path works
   offshore with no internet and needs no configuration change once such
   a provider is installed.
2. **Open-Meteo** over HTTPS — the same numerical models a GRIB file
   carries (ICON/GFS/ECMWF), served as JSON, no API key. Needs internet.

Set `weatherSource` to `signalk` to use only the local provider (never
touching the internet), or `open-meteo` to always go online. `auto`
prefers the local provider and falls back.

> **Check your provider before trusting `auto`.** Not every provider
> honours the position it is handed on the in-process API. With
> `@signalk/open-meteo-provider` 1.3.0 the HTTP route
> (`/signalk/v2/api/weather/observations?lat=..&lon=..`) returns correct
> per-position data, while `app.weatherApi.getObservations(position)`
> returned one fixed, stale observation for every position tested — which
> would stamp every boat with the same conditions. Compare a couple of
> logged points against the HTTP route after switching; if they disagree,
> use `open-meteo`.

Lookups are cached per 0.1° grid cell per hour — the resolution the
models actually have. Boats anchored in the same bay therefore cost one
lookup between them, not one each per scan. Failures are cached too, so a
scan without internet makes one attempt per cell per hour rather than one
per boat.

Weather is never allowed to cost a track point: if every source fails,
the fix is logged with null conditions.

## Requirements

The plugin reads `design.aisShipType`, `sensors.ais.class` and
`navigation.position` from the Signal K data model. Those are populated by
the server's AIS handling; a target that only ever sends position reports
(no static data) has no ship type or class and is therefore never logged.

## Data

Track points are stored in the plugin's data directory as `sailboats.json`:

```json
{
  "261183840": {
    "mmsi": "261183840",
    "name": "EXCELLENT",
    "shipType": "Sailing",
    "firstSeen": "2026-09-06T10:00:00.000Z",
    "lastSeen": "2026-09-08T13:10:32.068Z",
    "track": [
      {
        "t": "...",
        "lat": 54.35,
        "lon": 18.65,
        "sog": 4.2,
        "cog": 187,
        "windDir": 254,
        "windKn": 15.9,
        "waveM": 0.86
      }
    ]
  }
}
```

Speeds are knots, courses degrees true, positions WGS84 — converted once on
write so anything reading the file needs no unit knowledge. Writes go through
a temp file and a rename, so a crash mid-write can't leave a truncated log.

## HTTP API

Both routes accept an optional half-open time window, `[from, to)`, as ISO
timestamps. The webapp computes them in the **browser's** timezone so "one
day" means the day you see on the clock, not a UTC day.

```
GET /plugins/signalk-sailtracker/state?from=...&to=...
GET /plugins/signalk-sailtracker/boats/:mmsi/track?from=...&to=...
```

`/state` reports `dataRange` (the full extent of retained data, so a UI can
build a day picker) alongside the boats inside the window. Boats with no fix
in the window are omitted rather than returned empty, and the timestamps of
those returned describe the window — so a list never claims something
different from what the map draws.

## Development

```bash
npm install
npm test              # node:test, no test framework dependency
npm run coverage
npm run prettier:check
```

CI runs the [official SignalK plugin
pipeline](https://github.com/SignalK/signalk-server/blob/master/.github/workflows/plugin-ci.yml):
Linux x64/arm64, macOS and Windows on Node 22 and 24, armv7 (Venus OS) on
Node 20, plus a format check, coverage, and an integration test that installs
the plugin into a real Signal K server.

## License

MIT
