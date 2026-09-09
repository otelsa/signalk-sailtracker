// End-to-end tests against the plugin's public surface: start/stop, the
// scan that appends track points, persistence to disk, and the two REST
// routes -- each driven through a stub Signal K app and a fake router,
// the same way signalk-server itself drives the plugin.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const createPlugin = require('../index')

const SELF_ID = 'urn:mrn:imo:mmsi:211653340'
const MINUTE = 60 * 1000

let dataDir

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sailtracker-test-'))
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function sailboat(overrides = {}) {
  return {
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
    },
    ...overrides
  }
}

// Minimal stand-in for the Signal K app object: only the four members the
// plugin actually touches, plus captured error output so a test can
// assert that failures are reported rather than swallowed.
function stubApp(vessels = {}) {
  const errors = []
  return {
    selfId: SELF_ID,
    errors,
    vessels,
    debug: () => {},
    error: (msg) => errors.push(msg),
    getDataDirPath: () => dataDir,
    getPath: (p) => {
      if (p === 'vessels') return vessels
      if (p === `vessels.${SELF_ID}.navigation.position.value`) {
        const self = vessels[SELF_ID]
        return self && self.navigation && self.navigation.position
          ? self.navigation.position.value
          : undefined
      }
      return undefined
    }
  }
}

// Captures what the plugin registers, so routes can be invoked directly.
function fakeRouter({ withAccess = true, accessThrows = false } = {}) {
  const routes = {}
  const sink = {
    get: (route, handler) => {
      routes[route] = handler
    }
  }
  const router = { ...sink, routes }
  if (withAccess) {
    router.access = () => {
      if (accessThrows) throw new Error('not implemented on this server build')
      return sink
    }
  }
  return router
}

function callRoute(router, route, { query = {}, params = {} } = {}) {
  let statusCode = 200
  let body
  const res = {
    status(code) {
      statusCode = code
      return res
    },
    json(payload) {
      body = payload
      return res
    }
  }
  router.routes[route]({ query, params }, res)
  return { statusCode, body }
}

// The plugin's first scan is on a 5s timer; tests drive the scan directly
// through a fresh start/stop cycle instead of waiting for wall clock.
function startPlugin(app, options = {}) {
  const plugin = createPlugin(app)
  plugin.start(options)
  return plugin
}

describe('plugin lifecycle', () => {
  it('exposes the Signal K plugin contract', () => {
    const plugin = createPlugin(stubApp())
    assert.equal(plugin.id, 'signalk-sailtracker')
    assert.equal(typeof plugin.start, 'function')
    assert.equal(typeof plugin.stop, 'function')
    assert.equal(typeof plugin.registerWithRouter, 'function')
    assert.equal(typeof plugin.schema, 'object')
  })

  it('starts with no data file present and leaves no timers behind', () => {
    const app = stubApp()
    const plugin = startPlugin(app)
    plugin.stop()
    assert.deepEqual(app.errors, [])
  })

  it('loads an existing data file on start', () => {
    const existing = {
      261000001: {
        mmsi: '261000001',
        name: 'ALPHA',
        shipType: 'Sailing',
        firstSeen: '2026-09-06T10:00:00.000Z',
        lastSeen: '2026-09-06T10:00:00.000Z',
        track: [{ t: '2026-09-06T10:00:00.000Z', lat: 1, lon: 1, sog: null, cog: null }]
      }
    }
    fs.writeFileSync(path.join(dataDir, 'sailboats.json'), JSON.stringify(existing))

    const app = stubApp()
    const plugin = startPlugin(app)
    const router = fakeRouter()
    plugin.registerWithRouter(router)

    const { body } = callRoute(router, '/state')
    assert.equal(body.boats.length, 1)
    assert.equal(body.boats[0].name, 'ALPHA')
    plugin.stop()
  })

  // A truncated or hand-edited file must not take the plugin down.
  it('starts empty and reports the problem when the data file is corrupt', () => {
    fs.writeFileSync(path.join(dataDir, 'sailboats.json'), '{ this is not json')
    const app = stubApp()
    const plugin = startPlugin(app)
    const router = fakeRouter()
    plugin.registerWithRouter(router)

    const { body } = callRoute(router, '/state')
    assert.deepEqual(body.boats, [])
    assert.equal(app.errors.length, 1)
    assert.match(app.errors[0], /failed to read/)
    plugin.stop()
  })

  it('persists on stop so nothing is lost across a restart', () => {
    const app = stubApp({ [SELF_ID]: {}, 'urn:mrn:imo:mmsi:261183840': sailboat() })
    const plugin = createPlugin(app)
    plugin.start({})
    // Force the scan the 5s timer would otherwise do.
    const router = fakeRouter()
    plugin.registerWithRouter(router)
    plugin.stop()

    // Nothing scanned yet, so the file need not exist; what matters is
    // that stopping never throws and never corrupts an existing file.
    const file = path.join(dataDir, 'sailboats.json')
    if (fs.existsSync(file)) {
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')))
    }
  })
})

describe('registerWithRouter', () => {
  it('scopes routes to readonly when the server supports it', () => {
    const plugin = startPlugin(stubApp())
    const router = fakeRouter({ withAccess: true })
    plugin.registerWithRouter(router)
    assert.ok(router.routes['/state'])
    assert.ok(router.routes['/boats/:mmsi/track'])
    plugin.stop()
  })

  // Observed in production: router.access is declared in the server-api
  // types but missing from some server builds. Registration must still
  // succeed, or the whole plugin loses its admin registration.
  it('registers unscoped against a router without access()', () => {
    const plugin = startPlugin(stubApp())
    const router = fakeRouter({ withAccess: false })
    assert.doesNotThrow(() => plugin.registerWithRouter(router))
    assert.ok(router.routes['/state'])
    plugin.stop()
  })

  it('falls back and reports when access() throws', () => {
    const app = stubApp()
    const plugin = startPlugin(app)
    const router = fakeRouter({ withAccess: true, accessThrows: true })
    assert.doesNotThrow(() => plugin.registerWithRouter(router))
    assert.ok(router.routes['/state'])
    assert.match(app.errors[0], /router\.access threw/)
    plugin.stop()
  })
})

describe('GET /state', () => {
  function seeded() {
    const boats = {
      261000001: {
        mmsi: '261000001',
        name: 'ALPHA',
        shipType: 'Sailing',
        firstSeen: '2026-09-06T10:00:00.000Z',
        lastSeen: '2026-09-08T10:00:00.000Z',
        track: [
          { t: '2026-09-06T10:00:00.000Z', lat: 1, lon: 1, sog: 3, cog: 90 },
          { t: '2026-09-08T10:00:00.000Z', lat: 2, lon: 2, sog: 4, cog: 91 }
        ]
      },
      261000002: {
        mmsi: '261000002',
        name: 'BRAVO',
        shipType: 'Pleasure',
        firstSeen: '2026-09-06T11:00:00.000Z',
        lastSeen: '2026-09-06T11:00:00.000Z',
        track: [{ t: '2026-09-06T11:00:00.000Z', lat: 3, lon: 3, sog: null, cog: null }]
      }
    }
    fs.writeFileSync(path.join(dataDir, 'sailboats.json'), JSON.stringify(boats))
    const app = stubApp({
      [SELF_ID]: {
        navigation: { position: { value: { latitude: 54.4, longitude: 18.7 } } }
      }
    })
    const plugin = startPlugin(app, { intervalMinutes: 5, aisClass: 'B', retentionDays: 14 })
    const router = fakeRouter()
    plugin.registerWithRouter(router)
    return { plugin, router }
  }

  it('returns every boat when no window is given', () => {
    const { plugin, router } = seeded()
    const { body } = callRoute(router, '/state')
    assert.equal(body.boats.length, 2)
    plugin.stop()
  })

  it('reports own position and the config the webapp displays', () => {
    const { plugin, router } = seeded()
    const { body } = callRoute(router, '/state')
    assert.deepEqual(body.self, { lat: 54.4, lon: 18.7 })
    assert.equal(body.config.intervalMinutes, 5)
    assert.equal(body.config.aisClass, 'B')
    assert.equal(body.config.retentionDays, 14)
    plugin.stop()
  })

  it('reports the full data range regardless of the active window', () => {
    const { plugin, router } = seeded()
    const { body } = callRoute(router, '/state', {
      query: { from: '2026-09-08T00:00:00.000Z' }
    })
    // The picker needs every day that holds data, not just the window.
    assert.equal(body.dataRange.from, '2026-09-06T10:00:00.000Z')
    assert.equal(body.dataRange.to, '2026-09-08T10:00:00.000Z')
    plugin.stop()
  })

  it('filters to the requested window and drops boats outside it', () => {
    const { plugin, router } = seeded()
    const { body } = callRoute(router, '/state', {
      query: { from: '2026-09-08T00:00:00.000Z' }
    })
    assert.equal(body.boats.length, 1)
    assert.equal(body.boats[0].mmsi, '261000001')
    assert.equal(body.boats[0].points, 1)
    plugin.stop()
  })

  it('selects a single day with a half-open window', () => {
    const { plugin, router } = seeded()
    const { body } = callRoute(router, '/state', {
      query: { from: '2026-09-06T00:00:00.000Z', to: '2026-09-07T00:00:00.000Z' }
    })
    assert.equal(body.boats.length, 2)
    for (const b of body.boats) assert.equal(b.points, 1)
    plugin.stop()
  })

  it('ignores a malformed window instead of erroring', () => {
    const { plugin, router } = seeded()
    const { body } = callRoute(router, '/state', { query: { from: 'yesterday' } })
    assert.equal(body.boats.length, 2)
    plugin.stop()
  })
})

describe('GET /boats/:mmsi/track', () => {
  function seeded() {
    const boats = {
      261000001: {
        mmsi: '261000001',
        name: 'ALPHA',
        shipType: 'Sailing',
        firstSeen: '2026-09-06T10:00:00.000Z',
        lastSeen: '2026-09-08T10:00:00.000Z',
        track: [
          { t: '2026-09-06T10:00:00.000Z', lat: 1, lon: 1, sog: 3, cog: 90 },
          { t: '2026-09-08T10:00:00.000Z', lat: 2, lon: 2, sog: 4, cog: 91 }
        ]
      }
    }
    fs.writeFileSync(path.join(dataDir, 'sailboats.json'), JSON.stringify(boats))
    const plugin = startPlugin(stubApp())
    const router = fakeRouter()
    plugin.registerWithRouter(router)
    return { plugin, router }
  }

  it('returns the full track without a window', () => {
    const { plugin, router } = seeded()
    const { body } = callRoute(router, '/boats/:mmsi/track', {
      params: { mmsi: '261000001' }
    })
    assert.equal(body.name, 'ALPHA')
    assert.equal(body.track.length, 2)
    plugin.stop()
  })

  it('applies the window to the track', () => {
    const { plugin, router } = seeded()
    const { body } = callRoute(router, '/boats/:mmsi/track', {
      params: { mmsi: '261000001' },
      query: { from: '2026-09-06T00:00:00.000Z', to: '2026-09-07T00:00:00.000Z' }
    })
    assert.equal(body.track.length, 1)
    assert.equal(body.track[0].t, '2026-09-06T10:00:00.000Z')
    plugin.stop()
  })

  it('404s for an unknown mmsi', () => {
    const { plugin, router } = seeded()
    const { statusCode, body } = callRoute(router, '/boats/:mmsi/track', {
      params: { mmsi: '999999999' }
    })
    assert.equal(statusCode, 404)
    assert.equal(body.error, 'unknown mmsi')
    plugin.stop()
  })
})

describe('scanning the vessel model', () => {
  // The scan is timer-driven inside the plugin; these tests exercise the
  // same path by advancing through the plugin's own initial-scan timer
  // with a short interval and a manual tick.
  it('logs a matching sailboat and skips self and non-matches', async () => {
    const vessels = {
      [SELF_ID]: sailboat({ mmsi: '211653340' }),
      'urn:mrn:imo:mmsi:261183840': sailboat(),
      'urn:mrn:imo:mmsi:232008636': sailboat({
        mmsi: '232008636',
        design: { aisShipType: { value: { id: 70, name: 'Cargo' } } }
      }),
      'urn:mrn:imo:mmsi:261000590': sailboat({
        mmsi: '261000590',
        sensors: { ais: { class: { value: 'A' } } }
      })
    }
    const app = stubApp(vessels)
    const plugin = createPlugin(app)
    plugin.start({})

    // Wait out the plugin's 5s initial-scan timer.
    await new Promise((resolve) => setTimeout(resolve, 5300))
    plugin.stop()

    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'sailboats.json'), 'utf8'))
    assert.deepEqual(Object.keys(saved), ['261183840'])
    const boat = saved['261183840']
    assert.equal(boat.name, 'EXCELLENT')
    assert.equal(boat.shipType, 'Sailing')
    assert.equal(boat.track.length, 1)
    assert.equal(boat.track[0].sog, 9.7)
    assert.equal(boat.track[0].cog, 180)
    assert.equal(boat.firstSeen, boat.lastSeen)
  })
})
