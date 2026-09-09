// signalk-sailtracker
//
// A small, playful logger: every few minutes it looks at every AIS target
// Noomi currently sees, keeps the ones that are Class B transponders on
// sailboats (AIS ship type 36 - "Sailing"), and appends one track point
// per boat to a local JSON file. A bundled webapp shows the logged boats
// in a list and on an OpenStreetMap + OpenSeaMap chart, either all tracks
// at once or just the one selected in the list.
//
// Deliberately dependency-free on the backend (just Node's fs/http via
// the router signalk-server hands us) - the only "big" dependency is the
// vendored Leaflet build shipped in public/leaflet/.
//
// The decision logic lives in pure module-level functions below the
// plugin factory so it can be exercised directly by the test suite
// without spinning up timers or a server; the factory wires them to
// Signal K's app object and to disk.

const fs = require('fs')
const path = require('path')

const EARTH_RADIUS_M = 6371000
const METERS_PER_NM = 1852
const MS_PER_MINUTE = 60 * 1000
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE
const MS_TO_KN = 19.438444924574 // m/s -> tenths of a knot

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a))
}

// Time window for the read API. `from`/`to` arrive as ISO timestamps that
// the webapp computes in the *browser's* timezone, so "one day" means the
// day the user sees on the clock rather than a UTC day boundary. Both are
// optional; omitting them returns everything still in retention.
// Unparseable values are ignored rather than rejected -- a bad query
// string should degrade to "show more", never to an error page.
function parseWindow(query) {
  const toMs = (value) => {
    if (typeof value !== 'string' || value === '') return undefined
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : undefined
  }
  const q = query || {}
  return { from: toMs(q.from), to: toMs(q.to) }
}

// Half-open interval [from, to): consecutive days never both claim a point
// that sits exactly on midnight.
function trackInWindow(track, win) {
  if (!Array.isArray(track)) return []
  if (!win || (win.from === undefined && win.to === undefined)) return track
  return track.filter((p) => {
    const t = Date.parse(p && p.t)
    if (!Number.isFinite(t)) return false
    if (win.from !== undefined && t < win.from) return false
    if (win.to !== undefined && t >= win.to) return false
    return true
  })
}

// Retention first, then the hard cap: dropping stale points before
// counting means a boat seen continuously for weeks keeps maxPoints of
// *recent* history rather than maxPoints ending at the retention edge.
function pruneTrack(track, { retentionDays, maxPoints, now = Date.now() }) {
  const cutoff = now - retentionDays * MS_PER_DAY
  let pruned = track.filter((p) => Date.parse(p.t) >= cutoff)
  if (pruned.length > maxPoints) {
    pruned = pruned.slice(pruned.length - maxPoints)
  }
  return pruned
}

// Everything that decides whether one vessel from the Signal K model
// belongs in the log, in one place. Returns null when the vessel is not a
// match, otherwise the values that go into a track point -- so the caller
// does no filtering of its own and the rules stay testable in isolation.
function matchVessel(vessel, cfg, { now, selfPosition } = {}) {
  if (!vessel) return null

  const shipTypeValue =
    vessel.design && vessel.design.aisShipType && vessel.design.aisShipType.value
  const shipTypeId = shipTypeValue && shipTypeValue.id
  if (!cfg.shipTypeIds.includes(shipTypeId)) return null

  const aisClass =
    vessel.sensors &&
    vessel.sensors.ais &&
    vessel.sensors.ais.class &&
    vessel.sensors.ais.class.value
  if (cfg.aisClass !== 'both' && aisClass !== cfg.aisClass) return null

  const posNode = vessel.navigation && vessel.navigation.position
  const pos = posNode && posNode.value
  if (!pos || typeof pos.latitude !== 'number' || typeof pos.longitude !== 'number') {
    return null
  }
  // A position without a timestamp is taken at face value: the model has
  // no better information, and dropping it would silently lose targets
  // from sources that don't stamp their deltas.
  if (posNode.timestamp) {
    const age = now - Date.parse(posNode.timestamp)
    if (Number.isFinite(age) && age > cfg.positionMaxAgeMinutes * MS_PER_MINUTE) {
      return null
    }
  }

  // Range filtering needs our own position; without a fix we log
  // everything rather than nothing, since "no fix" is not evidence that a
  // target is far away.
  if (cfg.maxRangeNm > 0 && selfPosition) {
    const meters = haversineMeters(
      selfPosition.latitude,
      selfPosition.longitude,
      pos.latitude,
      pos.longitude
    )
    if (meters / METERS_PER_NM > cfg.maxRangeNm) return null
  }

  const sog = vessel.navigation.speedOverGround && vessel.navigation.speedOverGround.value
  const cog = vessel.navigation.courseOverGroundTrue && vessel.navigation.courseOverGroundTrue.value

  return {
    name: (vessel.name && String(vessel.name)) || undefined,
    shipType: (shipTypeValue && shipTypeValue.name) || 'Sailing',
    lat: pos.latitude,
    lon: pos.longitude,
    sog: typeof sog === 'number' ? Math.round(sog * MS_TO_KN) / 10 : null, // -> kn, 1 decimal
    cog: typeof cog === 'number' ? Math.round((cog * 180) / Math.PI) : null // -> deg
  }
}

function normalizeConfig(options = {}) {
  return {
    intervalMinutes: options.intervalMinutes || 5,
    shipTypeIds:
      Array.isArray(options.shipTypeIds) && options.shipTypeIds.length
        ? options.shipTypeIds
        : [36, 37],
    aisClass: options.aisClass || 'B',
    maxRangeNm: typeof options.maxRangeNm === 'number' ? options.maxRangeNm : 0,
    positionMaxAgeMinutes: options.positionMaxAgeMinutes || 10,
    maxPoints: options.maxPoints || 2000,
    retentionDays: options.retentionDays || 14
  }
}

// MMSI from the vessel object, falling back to the context key
// ("vessels.urn:mrn:imo:mmsi:211653340" -> "211653340").
function mmsiFor(vessel, contextKey) {
  return (vessel && vessel.mmsi) || String(contextKey).replace(/^.*mmsi:/, '')
}

// Earliest and latest point across all boats, so the webapp can offer a
// day picker covering exactly the days that actually hold data.
function dataRangeOf(boats) {
  let earliest
  let latest
  for (const boat of Object.values(boats)) {
    for (const p of boat.track) {
      const t = Date.parse(p.t)
      if (!Number.isFinite(t)) continue
      if (earliest === undefined || t < earliest) earliest = t
      if (latest === undefined || t > latest) latest = t
    }
  }
  return {
    from: earliest !== undefined ? new Date(earliest).toISOString() : null,
    to: latest !== undefined ? new Date(latest).toISOString() : null
  }
}

// The boat list for a given window. Boats with nothing inside the window
// are left out entirely rather than shown as empty rows, and every
// timestamp reported refers to the window, so the sidebar never claims
// something different from what the map draws.
function boatsInWindow(boats, win) {
  const list = []
  for (const boat of Object.values(boats)) {
    const track = trackInWindow(boat.track, win)
    if (!track.length) continue
    const last = track[track.length - 1]
    list.push({
      mmsi: boat.mmsi,
      name: boat.name || null,
      shipType: boat.shipType,
      firstSeen: track[0].t,
      lastSeen: last.t,
      points: track.length,
      lastPosition: { lat: last.lat, lon: last.lon }
    })
  }
  return list.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1))
}

const createPlugin = function (app) {
  const plugin = {}
  plugin.id = 'signalk-sailtracker'
  plugin.name = '⛵ Sailtracker'
  plugin.description =
    'Logs AIS Class B sailboats seen by Noomi every few minutes and shows them on an OpenSeaMap chart'

  let timer
  let saveTimer
  let cfg
  // In-memory store, mirrored to disk. Keyed by MMSI (string).
  // { [mmsi]: { mmsi, name, shipType, firstSeen, lastSeen, track: [{t,lat,lon,sog,cog}] } }
  let boats = {}
  let dirty = false
  let dataFile

  function log(...args) {
    app.debug('[sailtracker]', ...args)
  }

  function loadFromDisk() {
    try {
      const raw = fs.readFileSync(dataFile, 'utf8')
      const parsed = JSON.parse(raw)
      // A truncated or hand-edited file must not take the plugin down;
      // starting empty loses history but keeps logging alive.
      boats = parsed && typeof parsed === 'object' ? parsed : {}
      log(`loaded ${Object.keys(boats).length} boat(s) from ${dataFile}`)
    } catch (err) {
      if (err.code !== 'ENOENT') {
        app.error(`sailtracker: failed to read ${dataFile}: ${err.message}`)
      }
      boats = {}
    }
  }

  // Atomic-ish save: write to a temp file then rename over the real one,
  // so a crash/restart mid-write never leaves a truncated/corrupt file.
  function saveToDisk() {
    if (!dirty) return
    const tmp = dataFile + '.tmp'
    try {
      fs.writeFileSync(tmp, JSON.stringify(boats))
      fs.renameSync(tmp, dataFile)
      dirty = false
    } catch (err) {
      app.error(`sailtracker: failed to save ${dataFile}: ${err.message}`)
    }
  }

  function scanAndLog() {
    const selfPosition = app.getPath(`vessels.${app.selfId}.navigation.position.value`)
    const vesselList = app.getPath('vessels') || {}
    const now = Date.now()
    let matched = 0

    for (const key in vesselList) {
      if (key === app.selfId) continue
      const hit = matchVessel(vesselList[key], cfg, { now, selfPosition })
      if (!hit) continue

      const mmsi = mmsiFor(vesselList[key], key)
      const stamp = new Date(now).toISOString()
      if (!boats[mmsi]) {
        boats[mmsi] = {
          mmsi,
          name: hit.name,
          shipType: hit.shipType,
          firstSeen: stamp,
          lastSeen: null,
          track: []
        }
      }
      const boat = boats[mmsi]
      if (hit.name) boat.name = hit.name
      boat.shipType = hit.shipType
      boat.lastSeen = stamp
      boat.track.push({ t: stamp, lat: hit.lat, lon: hit.lon, sog: hit.sog, cog: hit.cog })
      boat.track = pruneTrack(boat.track, { ...cfg, now })
      matched++
    }

    dirty = matched > 0 || dirty
    log(`scan complete: ${matched} sailboat(s) logged, ${Object.keys(boats).length} tracked total`)
    saveToDisk()
  }

  function scheduleNext() {
    timer = setTimeout(() => {
      try {
        scanAndLog()
      } catch (err) {
        app.error(`sailtracker: scan failed: ${err.message}`)
      }
      scheduleNext()
    }, cfg.intervalMinutes * MS_PER_MINUTE)
  }

  plugin.start = function (options) {
    cfg = normalizeConfig(options)
    dataFile = path.join(app.getDataDirPath(), 'sailboats.json')
    loadFromDisk()
    // First scan shortly after start (so the UI has something to show
    // right away), then on the configured interval from then on.
    timer = setTimeout(() => {
      try {
        scanAndLog()
      } catch (err) {
        app.error(`sailtracker: initial scan failed: ${err.message}`)
      }
      scheduleNext()
    }, 5000)
    // Belt-and-braces periodic save even on quiet scans (e.g. only
    // pruning happened), so a long-running process doesn't hold unsaved
    // pruning in memory indefinitely.
    saveTimer = setInterval(saveToDisk, 10 * MS_PER_MINUTE)
    log(
      `started: every ${cfg.intervalMinutes} min, shipTypeIds=${cfg.shipTypeIds}, aisClass=${cfg.aisClass}`
    )
  }

  plugin.stop = function () {
    if (timer) clearTimeout(timer)
    if (saveTimer) clearInterval(saveTimer)
    timer = undefined
    saveTimer = undefined
    saveToDisk()
  }

  plugin.registerWithRouter = function (router) {
    // Mirrors the defensive access-scoping pattern used by
    // signalk-ais-forwarder on this server build: router.access() is
    // declared in @signalk/server-api's types but not implemented by
    // every server build, so this must never throw either way.
    let target = router
    if (typeof router.access === 'function') {
      try {
        target = router.access('readonly')
      } catch (err) {
        app.error(`sailtracker: router.access threw, registering routes unscoped: ${err.message}`)
      }
    }

    target.get('/state', (req, res) => {
      const selfPos = app.getPath(`vessels.${app.selfId}.navigation.position.value`)
      res.json({
        self: selfPos ? { lat: selfPos.latitude, lon: selfPos.longitude } : null,
        config: {
          intervalMinutes: cfg.intervalMinutes,
          aisClass: cfg.aisClass,
          maxRangeNm: cfg.maxRangeNm,
          retentionDays: cfg.retentionDays
        },
        dataRange: dataRangeOf(boats),
        boats: boatsInWindow(boats, parseWindow(req.query))
      })
    })

    target.get('/boats/:mmsi/track', (req, res) => {
      const boat = boats[req.params.mmsi]
      if (!boat) {
        res.status(404).json({ error: 'unknown mmsi' })
        return
      }
      res.json({
        mmsi: boat.mmsi,
        name: boat.name,
        shipType: boat.shipType,
        track: trackInWindow(boat.track, parseWindow(req.query))
      })
    })
  }

  plugin.schema = {
    type: 'object',
    properties: {
      intervalMinutes: {
        type: 'number',
        title: 'Log interval (minutes)',
        default: 5
      },
      shipTypeIds: {
        type: 'array',
        title: 'AIS ship types to log',
        description: '36 = Sailing, 37 = Pleasure craft',
        items: { type: 'number' },
        default: [36, 37]
      },
      aisClass: {
        type: 'string',
        title: 'AIS transponder class to log',
        enum: ['A', 'B', 'both'],
        default: 'B'
      },
      maxRangeNm: {
        type: 'number',
        title: 'Maximum range from own vessel (nm, 0 = unlimited)',
        default: 0
      },
      positionMaxAgeMinutes: {
        type: 'number',
        title: 'Ignore targets whose position is older than (minutes)',
        default: 10
      },
      maxPoints: {
        type: 'number',
        title: 'Maximum track points per boat',
        default: 2000
      },
      retentionDays: {
        type: 'number',
        title: 'Keep track points for (days)',
        default: 14
      }
    }
  }

  return plugin
}

module.exports = createPlugin
// Pure helpers, exported for the test suite. Not part of the Signal K
// plugin contract -- the server only ever calls the factory above.
module.exports.internals = {
  haversineMeters,
  parseWindow,
  trackInWindow,
  pruneTrack,
  matchVessel,
  normalizeConfig,
  mmsiFor,
  dataRangeOf,
  boatsInWindow
}
