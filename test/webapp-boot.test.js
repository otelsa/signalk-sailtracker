// Boot test for the webapp's wiring.
//
// internals.test.js and webapp.test.js cover pure functions; nothing
// covered app.js itself, and that is where a refactor broke it: three
// constants were cut out with the helpers they sat next to. The file
// still parsed, the helpers still passed, the server still served it --
// and the page came up with no chart and no boats, because every
// reference error was swallowed by a catch further out.
//
// So this runs the real app.js in a browser-shaped sandbox with stub
// Leaflet, DOM and fetch, drives it with realistic payloads, and insists
// that nothing was thrown, logged as an error, or left unhandled.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const PUBLIC = path.join(__dirname, '..', 'public')

const STATE = {
  self: { lat: 54.437, lon: 16.387 },
  config: {
    intervalMinutes: 5,
    aisClass: 'B',
    maxRangeNm: 0,
    retentionDays: 14,
    underwayLogsAll: true
  },
  selfUnderway: false,
  dataRange: { from: '2026-09-06T10:00:00.000Z', to: '2026-09-08T10:00:00.000Z' },
  boats: [
    {
      mmsi: '261183840',
      name: '<script>EXCELLENT</script>',
      shipType: 'Sailing',
      firstSeen: '2026-09-06T10:00:00.000Z',
      lastSeen: '2026-09-08T10:00:00.000Z',
      points: 2,
      lastPosition: { lat: 54.35, lon: 18.65 }
    }
  ]
}

const TRACK = {
  mmsi: '261183840',
  name: '<script>EXCELLENT</script>',
  shipType: 'Sailing',
  track: [
    {
      t: '2026-09-06T10:00:00.000Z',
      lat: 54.35,
      lon: 18.65,
      sog: 5.1,
      cog: 90,
      windDir: 270,
      windKn: 19.4,
      waveM: 1.5
    },
    {
      t: '2026-09-08T10:00:00.000Z',
      lat: 54.36,
      lon: 18.66,
      sog: null,
      cog: null,
      windDir: null,
      windKn: null,
      waveM: null
    }
  ]
}

const PROXIED_CHARTS = {
  osm: {
    identifier: 'osm',
    name: 'osm',
    proxy: true,
    maxzoom: 18,
    tilemapUrl: '/signalk/chart-tiles/osm/{z}/{x}/{y}'
  },
  seamark: {
    identifier: 'seamark',
    name: 'seamark',
    proxy: true,
    maxzoom: 18,
    tilemapUrl: '/signalk/chart-tiles/seamark/{z}/{x}/{y}'
  }
}

// Runs helpers.js then app.js in one sandbox and reports everything the
// page did, plus anything it complained about.
function boot({ charts = PROXIED_CHARTS, chartsOk = true } = {}) {
  const record = { tileUrls: [], popups: [], fetched: [], errors: [], html: [] }

  const element = () => {
    const node = {
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      style: {},
      options: [],
      value: '',
      hidden: false,
      addEventListener() {},
      setAttribute() {},
      appendChild() {},
      set innerHTML(v) {
        record.html.push(v)
      },
      get innerHTML() {
        return ''
      },
      set textContent(v) {
        record.html.push(v)
      },
      get textContent() {
        return ''
      }
    }
    return node
  }

  const layer = {
    addTo: () => layer,
    bindPopup: (html) => {
      record.popups.push(html)
      return layer
    },
    openPopup: () => layer,
    setLatLng() {},
    setPopupContent: (html) => record.popups.push(html)
  }
  const map = {
    setView: () => map,
    on: () => map,
    removeLayer() {},
    invalidateSize() {},
    getZoom: () => 11
  }

  const sandbox = {
    console: {
      ...console,
      error: (...a) => record.errors.push(a.map(String).join(' ')),
      warn() {},
      info() {}
    },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    Date,
    Math,
    JSON,
    URLSearchParams,
    Number,
    String,
    Object,
    Array,
    Promise,
    Map,
    Set,
    RegExp,
    Error,
    Boolean,
    AbortSignal: { timeout: () => undefined },
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    document: {
      querySelector: element,
      createElement: element,
      body: { classList: { toggle() {}, contains: () => false } }
    },
    fetch: async (url) => {
      const u = String(url)
      record.fetched.push(u.split('?')[0])
      if (u.includes('/resources/charts')) {
        return { ok: chartsOk, json: async () => charts }
      }
      return { ok: true, json: async () => (u.includes('/track') ? TRACK : STATE) }
    },
    L: {
      map: () => map,
      tileLayer: (url) => {
        record.tileUrls.push(url)
        return layer
      },
      polyline: () => layer,
      circleMarker: () => layer,
      marker: () => layer,
      divIcon: () => ({}),
      point: (a, b) => [a, b]
    }
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox

  const context = vm.createContext(sandbox)
  const onRejection = (err) => record.errors.push(`unhandled rejection: ${err && err.message}`)
  process.on('unhandledRejection', onRejection)
  try {
    for (const file of ['helpers.js', 'app.js']) {
      vm.runInContext(fs.readFileSync(path.join(PUBLIC, file), 'utf8'), context, { filename: file })
    }
  } finally {
    // Let initMap() and refresh() settle before anyone inspects the record.
    record.settled = new Promise((resolve) =>
      setTimeout(() => {
        process.off('unhandledRejection', onRejection)
        resolve(record)
      }, 60)
    )
  }
  return record
}

describe('webapp boot', () => {
  it('runs start to finish without a reference error', async () => {
    const record = boot()
    await record.settled
    assert.deepEqual(record.errors, [])
  })

  it('asks the server for its state and for the selected track', async () => {
    const record = boot()
    await record.settled
    assert.ok(record.fetched.includes('/plugins/signalk-sailtracker/state'))
    assert.ok(record.fetched.some((u) => u.endsWith('/track')))
  })

  it('adds both chart layers', async () => {
    const record = boot()
    await record.settled
    assert.equal(record.tileUrls.length, 2)
  })

  it('routes both layers through Signal K when it proxies them', async () => {
    const record = boot()
    await record.settled
    assert.deepEqual(record.tileUrls, [
      '/signalk/chart-tiles/osm/{z}/{x}/{y}',
      '/signalk/chart-tiles/seamark/{z}/{x}/{y}'
    ])
  })

  it('falls back to the public tile servers with no chart provider', async () => {
    const record = boot({ chartsOk: false })
    await record.settled
    assert.deepEqual(record.tileUrls, [
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'
    ])
    assert.deepEqual(record.errors, [])
  })

  it('takes whichever half Signal K proxies and gets the rest publicly', async () => {
    const record = boot({ charts: { seamark: PROXIED_CHARTS.seamark } })
    await record.settled
    assert.deepEqual(record.tileUrls, [
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      '/signalk/chart-tiles/seamark/{z}/{x}/{y}'
    ])
  })

  it('builds a track popup, and escapes the vessel name in it', async () => {
    const record = boot()
    await record.settled
    const popup = record.popups.find((p) => p.includes('EXCELLENT'))
    assert.ok(popup, 'a popup was built for the logged boat')
    assert.ok(popup.includes('&lt;script&gt;'), 'the name is escaped')
    assert.equal(popup.includes('<script>EXCELLENT'), false)
  })

  it('renders the boat list without letting a name become markup', async () => {
    const record = boot()
    await record.settled
    const row = record.html.find((h) => h.includes('EXCELLENT'))
    assert.ok(row, 'the boat reached the list')
    assert.equal(row.includes('<script>EXCELLENT'), false)
  })
})
