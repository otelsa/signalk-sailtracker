// Unit tests for the pure decision logic: which vessels get logged, how
// tracks are pruned, and how the read API's time window is applied.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const {
  haversineMeters,
  knotsFrom,
  isUnderway,
  parseWindow,
  trackInWindow,
  pruneTrack,
  matchVessel,
  normalizeConfig,
  mmsiFor,
  dataRangeOf,
  boatsInWindow
} = require('../index').internals

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

// A Class B sailing yacht with a fresh fix -- the shape every filter test
// starts from, so each test only varies the one field it is about.
function vessel(overrides = {}) {
  const base = {
    mmsi: '261183840',
    name: 'EXCELLENT',
    design: { aisShipType: { value: { id: 36, name: 'Sailing' } } },
    sensors: { ais: { class: { value: 'B' } } },
    navigation: {
      position: {
        value: { latitude: 54.35, longitude: 18.65 },
        timestamp: new Date().toISOString()
      },
      speedOverGround: { value: 5 },
      courseOverGroundTrue: { value: Math.PI }
    }
  }
  return { ...base, ...overrides }
}

const cfg = normalizeConfig({})

describe('haversineMeters', () => {
  it('is zero for identical points', () => {
    assert.equal(haversineMeters(54.35, 18.65, 54.35, 18.65), 0)
  })

  it('matches a known distance', () => {
    // One degree of latitude is ~111.2 km anywhere on the globe.
    const m = haversineMeters(54, 18, 55, 18)
    assert.ok(Math.abs(m - 111195) < 500, `expected ~111195 m, got ${m}`)
  })

  it('is symmetric', () => {
    const a = haversineMeters(54.35, 18.65, 54.4, 18.7)
    const b = haversineMeters(54.4, 18.7, 54.35, 18.65)
    assert.ok(Math.abs(a - b) < 1e-6)
  })
})

describe('parseWindow', () => {
  it('parses both bounds', () => {
    const w = parseWindow({ from: '2026-09-06T00:00:00.000Z', to: '2026-09-07T00:00:00.000Z' })
    assert.equal(w.from, Date.parse('2026-09-06T00:00:00.000Z'))
    assert.equal(w.to, Date.parse('2026-09-07T00:00:00.000Z'))
  })

  it('leaves an omitted bound undefined', () => {
    const w = parseWindow({ from: '2026-09-06T00:00:00.000Z' })
    assert.equal(w.to, undefined)
  })

  it('returns an empty window for no query at all', () => {
    assert.deepEqual(parseWindow(undefined), { from: undefined, to: undefined })
    assert.deepEqual(parseWindow({}), { from: undefined, to: undefined })
  })

  // A malformed query string should widen the view, never break it.
  it('ignores unparseable and non-string values', () => {
    assert.deepEqual(parseWindow({ from: 'gestern', to: '' }), {
      from: undefined,
      to: undefined
    })
    assert.deepEqual(parseWindow({ from: ['a', 'b'], to: 42 }), {
      from: undefined,
      to: undefined
    })
  })
})

describe('trackInWindow', () => {
  const track = [
    { t: '2026-09-06T00:00:00.000Z', lat: 1, lon: 1 },
    { t: '2026-09-06T12:00:00.000Z', lat: 2, lon: 2 },
    { t: '2026-09-07T00:00:00.000Z', lat: 3, lon: 3 }
  ]

  it('returns the whole track when no window is given', () => {
    assert.equal(trackInWindow(track, {}).length, 3)
    assert.equal(trackInWindow(track, undefined).length, 3)
  })

  // [from, to) -- so two consecutive days never both contain midnight.
  it('treats the window as half-open', () => {
    const day = trackInWindow(track, {
      from: Date.parse('2026-09-06T00:00:00.000Z'),
      to: Date.parse('2026-09-07T00:00:00.000Z')
    })
    assert.equal(day.length, 2)
    assert.equal(day[0].t, '2026-09-06T00:00:00.000Z') // from is inclusive
    assert.equal(day[1].t, '2026-09-06T12:00:00.000Z') // to is exclusive
  })

  it('applies an open-ended lower bound', () => {
    const recent = trackInWindow(track, { from: Date.parse('2026-09-06T06:00:00.000Z') })
    assert.equal(recent.length, 2)
  })

  it('drops points with an unparseable timestamp', () => {
    const dirty = [...track, { t: 'not-a-date', lat: 9, lon: 9 }]
    const filtered = trackInWindow(dirty, { from: 0 })
    assert.equal(filtered.length, 3)
  })

  it('tolerates a missing track', () => {
    assert.deepEqual(trackInWindow(undefined, { from: 0 }), [])
  })
})

describe('pruneTrack', () => {
  const now = Date.parse('2026-09-08T12:00:00.000Z')

  it('drops points older than the retention window', () => {
    const track = [
      { t: new Date(now - 20 * DAY).toISOString() },
      { t: new Date(now - 2 * DAY).toISOString() },
      { t: new Date(now).toISOString() }
    ]
    const pruned = pruneTrack(track, { retentionDays: 14, maxPoints: 2000, now })
    assert.equal(pruned.length, 2)
  })

  it('caps at maxPoints keeping the newest', () => {
    const track = Array.from({ length: 10 }, (_, i) => ({
      t: new Date(now - (10 - i) * MINUTE).toISOString(),
      lat: i
    }))
    const pruned = pruneTrack(track, { retentionDays: 14, maxPoints: 3, now })
    assert.equal(pruned.length, 3)
    assert.equal(pruned[2].lat, 9) // newest survives
    assert.equal(pruned[0].lat, 7)
  })

  // Retention runs first, so a long-lived boat keeps maxPoints of recent
  // history rather than maxPoints ending at the retention edge.
  it('applies retention before the cap', () => {
    const track = [
      ...Array.from({ length: 5 }, (_, i) => ({
        t: new Date(now - (30 - i) * DAY).toISOString(),
        old: true
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        t: new Date(now - (5 - i) * MINUTE).toISOString(),
        old: false
      }))
    ]
    const pruned = pruneTrack(track, { retentionDays: 14, maxPoints: 4, now })
    assert.equal(pruned.length, 4)
    assert.ok(pruned.every((p) => p.old === false))
  })
})

describe('matchVessel', () => {
  const now = Date.now()
  const opts = { now, selfPosition: { latitude: 54.35, longitude: 18.65 } }

  it('accepts a Class B sailing yacht with a fresh fix', () => {
    const hit = matchVessel(vessel(), cfg, opts)
    assert.ok(hit)
    assert.equal(hit.name, 'EXCELLENT')
    assert.equal(hit.shipType, 'Sailing')
    assert.equal(hit.lat, 54.35)
  })

  it('converts SOG to knots and COG to degrees', () => {
    const hit = matchVessel(vessel(), cfg, opts)
    assert.equal(hit.sog, 9.7) // 5 m/s
    assert.equal(hit.cog, 180) // PI rad
  })

  it('reports null for missing SOG/COG instead of inventing zeros', () => {
    const v = vessel()
    delete v.navigation.speedOverGround
    delete v.navigation.courseOverGroundTrue
    const hit = matchVessel(v, cfg, opts)
    assert.equal(hit.sog, null)
    assert.equal(hit.cog, null)
  })

  it('rejects a ship type that is not configured', () => {
    const v = vessel({ design: { aisShipType: { value: { id: 70, name: 'Cargo' } } } })
    assert.equal(matchVessel(v, cfg, opts), null)
  })

  it('rejects a vessel with no ship type at all', () => {
    const v = vessel({ design: {} })
    assert.equal(matchVessel(v, cfg, opts), null)
  })

  it('rejects the wrong AIS class', () => {
    const v = vessel({ sensors: { ais: { class: { value: 'A' } } } })
    assert.equal(matchVessel(v, cfg, opts), null)
  })

  it('rejects a vessel whose AIS class is unknown', () => {
    const v = vessel({ sensors: {} })
    assert.equal(matchVessel(v, cfg, opts), null)
  })

  it("accepts either class when configured with 'both'", () => {
    const bothCfg = normalizeConfig({ aisClass: 'both' })
    const classA = vessel({ sensors: { ais: { class: { value: 'A' } } } })
    assert.ok(matchVessel(classA, bothCfg, opts))
    assert.ok(matchVessel(vessel(), bothCfg, opts))
  })

  it('rejects a missing or malformed position', () => {
    const noPos = vessel({ navigation: { position: {} } })
    assert.equal(matchVessel(noPos, cfg, opts), null)
    const badPos = vessel({
      navigation: { position: { value: { latitude: 'x', longitude: 18.65 } } }
    })
    assert.equal(matchVessel(badPos, cfg, opts), null)
  })

  it('rejects a position older than positionMaxAgeMinutes', () => {
    const v = vessel()
    v.navigation.position.timestamp = new Date(now - 30 * MINUTE).toISOString()
    assert.equal(matchVessel(v, cfg, opts), null)
  })

  it('accepts a position with no timestamp rather than losing the target', () => {
    const v = vessel()
    delete v.navigation.position.timestamp
    assert.ok(matchVessel(v, cfg, opts))
  })

  it('rejects targets beyond maxRangeNm', () => {
    const ranged = normalizeConfig({ maxRangeNm: 5 })
    const far = vessel({
      navigation: {
        position: {
          value: { latitude: 55.5, longitude: 18.65 },
          timestamp: new Date().toISOString()
        }
      }
    })
    assert.equal(matchVessel(far, ranged, opts), null)
    assert.ok(matchVessel(vessel(), ranged, opts))
  })

  it('ignores range entirely when maxRangeNm is 0', () => {
    const far = vessel({
      navigation: {
        position: { value: { latitude: 20, longitude: 100 }, timestamp: new Date().toISOString() }
      }
    })
    assert.ok(matchVessel(far, cfg, opts))
  })

  // Without our own fix, "far away" is unknowable -- log it rather than
  // silently dropping every target.
  it('skips the range check when own position is unknown', () => {
    const ranged = normalizeConfig({ maxRangeNm: 5 })
    const far = vessel({
      navigation: {
        position: { value: { latitude: 20, longitude: 100 }, timestamp: new Date().toISOString() }
      }
    })
    assert.ok(matchVessel(far, ranged, { now, selfPosition: undefined }))
  })

  it('tolerates a null vessel', () => {
    assert.equal(matchVessel(null, cfg, opts), null)
  })
})

describe('knotsFrom', () => {
  it('converts m/s to knots with one decimal', () => {
    assert.equal(knotsFrom(5), 9.7)
    assert.equal(knotsFrom(0), 0)
  })

  it('is null for a missing speed rather than zero', () => {
    assert.equal(knotsFrom(undefined), null)
    assert.equal(knotsFrom(null), null)
    assert.equal(knotsFrom('4'), null)
  })
})

describe('isUnderway', () => {
  const c = normalizeConfig({})

  it('needs more than the threshold, not exactly it', () => {
    assert.equal(isUnderway(0.2, c), true)
    assert.equal(isUnderway(0.1, c), false)
    assert.equal(isUnderway(0, c), false)
  })

  it('treats an unknown speed as not moving', () => {
    assert.equal(isUnderway(null, c), false)
  })

  it('honours a configured threshold', () => {
    const slow = normalizeConfig({ underwaySpeedKn: 2 })
    assert.equal(isUnderway(1.5, slow), false)
    assert.equal(isUnderway(2.5, slow), true)
  })
})

// The wide net: while own vessel has way on, any other moving vessel is
// logged regardless of ship type and transponder class.
describe('matchVessel with the under-way rule', () => {
  const now = Date.now()
  const here = { latitude: 54.35, longitude: 18.65 }
  const wide = normalizeConfig({ underwayLogsAll: true })
  const moving = { now, selfPosition: here, selfUnderway: true }
  const msFor = (kn) => kn / 1.9438444924574

  // Class A cargo: rejected by both the type and the class filter, so it
  // can only ever get in through the under-way rule.
  function cargo(overrides = {}) {
    return vessel({
      mmsi: '232008636',
      name: 'ATLANTIC',
      design: { aisShipType: { value: { id: 70, name: 'Cargo' } } },
      sensors: { ais: { class: { value: 'A' } } },
      ...overrides
    })
  }

  it('logs a moving cargo ship while own vessel is under way', () => {
    const hit = matchVessel(cargo(), wide, moving)
    assert.ok(hit)
    assert.equal(hit.name, 'ATLANTIC')
    assert.equal(hit.shipType, 'Cargo')
  })

  it('leaves it out again once own vessel stops', () => {
    assert.equal(matchVessel(cargo(), wide, { now, selfPosition: here, selfUnderway: false }), null)
  })

  it('treats an unknown own speed as stopped', () => {
    assert.equal(matchVessel(cargo(), wide, { now, selfPosition: here }), null)
  })

  it('leaves out a target that is not moving itself', () => {
    const anchored = cargo({
      navigation: {
        position: { value: here, timestamp: new Date().toISOString() },
        speedOverGround: { value: 0 }
      }
    })
    assert.equal(matchVessel(anchored, wide, moving), null)
  })

  it('needs the target to be faster than the threshold, not equal to it', () => {
    const at = (kn) =>
      cargo({
        navigation: {
          position: { value: here, timestamp: new Date().toISOString() },
          speedOverGround: { value: msFor(kn) }
        }
      })
    assert.equal(matchVessel(at(0.1), wide, moving), null)
    assert.ok(matchVessel(at(0.2), wide, moving))
  })

  it('does nothing at all while the option is off', () => {
    assert.equal(matchVessel(cargo(), cfg, moving), null)
  })

  it('flags a wide catch and leaves a normal match unflagged', () => {
    assert.equal(matchVessel(cargo(), wide, moving).underway, true)
    assert.equal(matchVessel(vessel(), wide, moving).underway, false)
  })

  // The class filter alone is enough to make a target a wide catch: a
  // Class A sailing yacht is not logged under the default settings.
  it('counts a target that only the class filter rejected', () => {
    const classA = vessel({ sensors: { ais: { class: { value: 'A' } } } })
    assert.equal(matchVessel(classA, cfg, moving), null)
    assert.equal(matchVessel(classA, wide, moving).underway, true)
  })

  it('still honours the range limit', () => {
    const ranged = normalizeConfig({ underwayLogsAll: true, maxRangeNm: 5 })
    const far = cargo({
      navigation: {
        position: {
          value: { latitude: 55.35, longitude: 18.65 },
          timestamp: new Date().toISOString()
        },
        speedOverGround: { value: 5 }
      }
    })
    assert.equal(matchVessel(far, ranged, moving), null)
  })

  it('still honours the position age limit', () => {
    const stale = cargo({
      navigation: {
        position: { value: here, timestamp: new Date(now - 30 * MINUTE).toISOString() },
        speedOverGround: { value: 5 }
      }
    })
    assert.equal(matchVessel(stale, wide, moving), null)
  })

  // 'Sailing' used to be the blanket fallback, which would have labelled
  // every nameless wide catch as a sailboat.
  it('does not call a nameless unknown type a sailboat', () => {
    const unknown = cargo({ design: {} })
    assert.equal(matchVessel(unknown, wide, moving).shipType, 'Vessel')
  })
})

describe('normalizeConfig', () => {
  it('fills in defaults', () => {
    const c = normalizeConfig({})
    assert.deepEqual(c.shipTypeIds, [36, 37])
    assert.equal(c.aisClass, 'B')
    assert.equal(c.intervalMinutes, 5)
    assert.equal(c.retentionDays, 14)
    assert.equal(c.maxRangeNm, 0)
    assert.equal(c.underwayLogsAll, false)
    assert.equal(c.underwaySpeedKn, 0.1)
  })

  it('only enables the under-way rule when it is explicitly true', () => {
    assert.equal(normalizeConfig({ underwayLogsAll: true }).underwayLogsAll, true)
    assert.equal(normalizeConfig({ underwayLogsAll: 'yes' }).underwayLogsAll, false)
  })

  it('rejects a negative under-way threshold, which would match everything', () => {
    assert.equal(normalizeConfig({ underwaySpeedKn: -1 }).underwaySpeedKn, 0.1)
    assert.equal(normalizeConfig({ underwaySpeedKn: 0 }).underwaySpeedKn, 0)
    assert.equal(normalizeConfig({ underwaySpeedKn: 1.5 }).underwaySpeedKn, 1.5)
  })

  it('keeps explicit values, including a meaningful zero', () => {
    const c = normalizeConfig({ maxRangeNm: 0, shipTypeIds: [36], aisClass: 'both' })
    assert.equal(c.maxRangeNm, 0)
    assert.deepEqual(c.shipTypeIds, [36])
    assert.equal(c.aisClass, 'both')
  })

  it('falls back when shipTypeIds is empty or not an array', () => {
    assert.deepEqual(normalizeConfig({ shipTypeIds: [] }).shipTypeIds, [36, 37])
    assert.deepEqual(normalizeConfig({ shipTypeIds: 'nope' }).shipTypeIds, [36, 37])
  })
})

describe('mmsiFor', () => {
  it('prefers the vessel mmsi field', () => {
    assert.equal(mmsiFor({ mmsi: '261183840' }, 'vessels.whatever'), '261183840')
  })

  it('falls back to the context key', () => {
    assert.equal(mmsiFor({}, 'urn:mrn:imo:mmsi:261183840'), '261183840')
  })
})

describe('dataRangeOf', () => {
  it('spans the earliest and latest point across all boats', () => {
    const boats = {
      a: { track: [{ t: '2026-09-01T00:00:00.000Z' }, { t: '2026-09-03T00:00:00.000Z' }] },
      b: { track: [{ t: '2026-08-28T00:00:00.000Z' }, { t: '2026-09-02T00:00:00.000Z' }] }
    }
    assert.deepEqual(dataRangeOf(boats), {
      from: '2026-08-28T00:00:00.000Z',
      to: '2026-09-03T00:00:00.000Z'
    })
  })

  it('is null/null with no data', () => {
    assert.deepEqual(dataRangeOf({}), { from: null, to: null })
    assert.deepEqual(dataRangeOf({ a: { track: [] } }), { from: null, to: null })
  })
})

describe('boatsInWindow', () => {
  const boats = {
    261000001: {
      mmsi: '261000001',
      name: 'ALPHA',
      shipType: 'Sailing',
      track: [
        { t: '2026-09-06T10:00:00.000Z', lat: 1, lon: 1 },
        { t: '2026-09-08T10:00:00.000Z', lat: 2, lon: 2 }
      ]
    },
    261000002: {
      mmsi: '261000002',
      name: null,
      shipType: 'Sailing',
      track: [{ t: '2026-09-06T11:00:00.000Z', lat: 3, lon: 3 }]
    }
  }

  it('leaves out boats with nothing inside the window', () => {
    const list = boatsInWindow(boats, { from: Date.parse('2026-09-07T00:00:00.000Z') })
    assert.equal(list.length, 1)
    assert.equal(list[0].mmsi, '261000001')
  })

  // The sidebar shows "zuletzt vor ..." from this value, so within a
  // window it has to describe that window, not the boat's whole history.
  it('reports timestamps and counts relative to the window', () => {
    const list = boatsInWindow(boats, {
      from: Date.parse('2026-09-06T00:00:00.000Z'),
      to: Date.parse('2026-09-07T00:00:00.000Z')
    })
    const alpha = list.find((b) => b.mmsi === '261000001')
    assert.equal(alpha.points, 1)
    assert.equal(alpha.lastSeen, '2026-09-06T10:00:00.000Z')
    assert.equal(alpha.firstSeen, '2026-09-06T10:00:00.000Z')
    assert.deepEqual(alpha.lastPosition, { lat: 1, lon: 1 })
  })

  it('sorts most recently seen first', () => {
    const list = boatsInWindow(boats, {})
    assert.equal(list[0].mmsi, '261000001')
  })

  it('returns everything when the window is empty', () => {
    assert.equal(boatsInWindow(boats, {}).length, 2)
  })
})
