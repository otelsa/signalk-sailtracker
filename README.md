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
    "track": [{ "t": "...", "lat": 54.35, "lon": 18.65, "sog": 4.2, "cog": 187 }]
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
