// Unit tests for the webapp's pure logic: colours, date and window
// handling, HTML escaping and the chart-source choice. These ran without
// any coverage until now -- the browser side was the one part of the
// plugin the suite never touched.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const {
  PALETTE,
  colorFor,
  pad,
  fmtAge,
  fmtDateTime,
  dayKey,
  dayLabel,
  windowQuery,
  daysInRange,
  escapeHtml,
  wxHtml,
  pointPopupHtml,
  pickTiles
} = require('../public/helpers')

describe('colorFor', () => {
  it('is stable for the same MMSI', () => {
    assert.equal(colorFor('261183840'), colorFor('261183840'))
  })

  it('always lands inside the palette', () => {
    for (let i = 0; i < 500; i++) {
      assert.ok(PALETTE.includes(colorFor(`2610000${i}`)))
    }
  })

  it('spreads a realistic fleet over more than one colour', () => {
    const mmsis = Array.from({ length: 40 }, (_, i) => String(261000000 + i * 137))
    assert.ok(new Set(mmsis.map(colorFor)).size > 1)
  })

  it('tolerates a non-string MMSI', () => {
    assert.ok(PALETTE.includes(colorFor(261183840)))
  })
})

describe('pad and fmtDateTime', () => {
  it('pads to two digits', () => {
    assert.equal(pad(3), '03')
    assert.equal(pad(30), '30')
  })

  it('formats a local date and time', () => {
    // Built from local parts, so the expectation holds in any timezone.
    const d = new Date(2026, 8, 8, 15, 53, 9)
    assert.equal(fmtDateTime(d.toISOString()), '08.09.2026 15:53:09')
  })

  it('shows a dash for a missing or unparseable timestamp', () => {
    assert.equal(fmtDateTime(null), '–')
    assert.equal(fmtDateTime(''), '–')
    assert.equal(fmtDateTime('not a date'), '–')
  })
})

describe('fmtAge', () => {
  const now = Date.parse('2026-09-08T12:00:00.000Z')
  const ago = (ms) => new Date(now - ms).toISOString()

  it('counts seconds, then minutes, then hours, then days', () => {
    assert.equal(fmtAge(ago(30 * 1000), now), 'vor 30s')
    assert.equal(fmtAge(ago(5 * 60 * 1000), now), 'vor 5m')
    assert.equal(fmtAge(ago(3 * 3600 * 1000), now), 'vor 3h')
    assert.equal(fmtAge(ago(5 * 24 * 3600 * 1000), now), 'vor 5d')
  })

  // 48h is the switch to days: an age of "vor 47h" is still more useful
  // than "vor 2d", but beyond that the hour count stops telling you much.
  it('stays in hours up to two days', () => {
    assert.equal(fmtAge(ago(47 * 3600 * 1000), now), 'vor 47h')
    assert.equal(fmtAge(ago(49 * 3600 * 1000), now), 'vor 2d')
  })

  it('shows a dash for a missing timestamp', () => {
    assert.equal(fmtAge(null, now), '–')
  })
})

describe('dayKey and dayLabel', () => {
  it('keys by the local calendar day, not the UTC one', () => {
    // 23:30 local on the 8th: toISOString would call this the 9th in any
    // timezone east of UTC, putting an evening fix on the wrong day.
    const lateEvening = new Date(2026, 8, 8, 23, 30, 0)
    assert.equal(dayKey(lateEvening), '2026-09-08')
  })

  it('names today and yesterday', () => {
    const now = new Date(2026, 8, 8, 12, 0, 0)
    assert.equal(dayLabel('2026-09-08', now), 'Heute')
    assert.equal(dayLabel('2026-09-07', now), 'Gestern')
  })

  it('crosses a month boundary when naming yesterday', () => {
    const now = new Date(2026, 8, 1, 12, 0, 0)
    assert.equal(dayLabel('2026-08-31', now), 'Gestern')
  })

  it('falls back to a plain date', () => {
    const now = new Date(2026, 8, 8, 12, 0, 0)
    assert.equal(dayLabel('2026-09-01', now), '01.09.2026')
  })
})

describe('windowQuery', () => {
  it('is empty for the whole retained history', () => {
    assert.equal(windowQuery({ mode: 'all' }, 2), '')
    assert.equal(windowQuery(null, 2), '')
  })

  it('brackets a single local day as a half-open interval', () => {
    const q = windowQuery({ mode: 'day', day: '2026-09-08' }, 2)
    const params = new URLSearchParams(q.slice(1))
    const from = new Date(params.get('from'))
    const to = new Date(params.get('to'))
    assert.equal(dayKey(from), '2026-09-08')
    assert.equal(from.getHours(), 0)
    assert.equal(dayKey(to), '2026-09-09')
    assert.equal(to.getHours(), 0)
  })

  // The reason the day is built through the Date constructor rather than
  // adding 24h: on a DST switch a day is 23 or 25 hours long, and a fixed
  // offset would clip or overrun it.
  it('spans a real day across a DST switch', () => {
    const q = windowQuery({ mode: 'day', day: '2026-03-29' }, 2)
    const params = new URLSearchParams(q.slice(1))
    const from = new Date(params.get('from'))
    const to = new Date(params.get('to'))
    assert.equal(dayKey(from), '2026-03-29')
    assert.equal(dayKey(to), '2026-03-30')
    assert.equal(from.getHours(), 0)
    assert.equal(to.getHours(), 0)
  })

  it('reaches back the configured number of days for the default view', () => {
    const now = new Date(2026, 8, 8, 15, 0, 0)
    const q = windowQuery({ mode: 'recent' }, 2, now)
    const from = new Date(new URLSearchParams(q.slice(1)).get('from'))
    assert.equal(dayKey(from), '2026-09-06')
    assert.equal(q.includes('to='), false, 'the recent view is open-ended')
  })

  it('reaches back across a month boundary', () => {
    const now = new Date(2026, 8, 1, 15, 0, 0)
    const from = new Date(
      new URLSearchParams(windowQuery({ mode: 'recent' }, 2, now).slice(1)).get('from')
    )
    assert.equal(dayKey(from), '2026-08-30')
  })
})

describe('daysInRange', () => {
  it('lists every covered day, newest first', () => {
    const days = daysInRange({
      from: new Date(2026, 8, 6, 10, 0, 0).toISOString(),
      to: new Date(2026, 8, 8, 10, 0, 0).toISOString()
    })
    assert.deepEqual(days, ['2026-09-08', '2026-09-07', '2026-09-06'])
  })

  it('is a single day when everything landed on one', () => {
    const t = new Date(2026, 8, 8, 10, 0, 0).toISOString()
    assert.deepEqual(daysInRange({ from: t, to: t }), ['2026-09-08'])
  })

  it('is empty without data', () => {
    assert.deepEqual(daysInRange(null), [])
    assert.deepEqual(daysInRange({ from: null, to: null }), [])
  })

  // A corrupt timestamp must not spin the browser's main thread.
  it('does not loop forever on an unparseable range', () => {
    assert.deepEqual(daysInRange({ from: 'rubbish', to: 'rubbish' }), [])
  })

  it('caps a very long range', () => {
    const days = daysInRange({
      from: new Date(2020, 0, 1).toISOString(),
      to: new Date(2026, 8, 8).toISOString()
    })
    assert.equal(days.length, 60)
  })
})

// Vessel names come over the air from strangers' transponders and are
// written into innerHTML.
describe('escapeHtml', () => {
  it('neutralises a name carrying markup', () => {
    assert.equal(
      escapeHtml('<img src=x onerror="alert(1)">'),
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
    )
  })

  it('escapes ampersands and single quotes', () => {
    assert.equal(escapeHtml("Fish & Chips'"), 'Fish &amp; Chips&#39;')
  })

  it('leaves an ordinary name alone', () => {
    assert.equal(escapeHtml('M/Y ELEONORA 1'), 'M/Y ELEONORA 1')
  })

  it('survives a non-string value', () => {
    assert.equal(escapeHtml(261183840), '261183840')
    assert.equal(escapeHtml(null), 'null')
  })
})

describe('wxHtml', () => {
  it('renders wind and wave together', () => {
    const html = wxHtml({ windDir: 270, windKn: 19.4, waveM: 1.5 })
    assert.match(html, /Wind 270° \/ 19\.4 kn · Welle 1\.5 m/)
  })

  // null means "no source could answer", not "calm" -- so the line is
  // left out rather than printed as a row of dashes.
  it('is empty when nothing is known', () => {
    assert.equal(wxHtml({ windDir: null, windKn: null, waveM: null }), '')
    assert.equal(wxHtml({}), '')
  })

  it('renders whichever half is known', () => {
    assert.match(wxHtml({ windDir: 270, windKn: null, waveM: null }), /Wind 270°/)
    assert.match(wxHtml({ windDir: null, windKn: null, waveM: 0.7 }), /Welle 0\.7 m/)
  })

  it('keeps a genuine zero', () => {
    assert.match(wxHtml({ windDir: 0, windKn: 0, waveM: 0 }), /Wind 0° \/ 0 kn · Welle 0 m/)
  })
})

describe('pointPopupHtml', () => {
  it('escapes the name it is given', () => {
    const html = pointPopupHtml('<b>BAD</b>', { sog: 5, cog: 90, t: null })
    assert.match(html, /&lt;b&gt;BAD&lt;\/b&gt;/)
    assert.equal(html.includes('<b>BAD</b>'), false)
  })

  it('shows a dash for a missing speed or course but keeps a zero', () => {
    const html = pointPopupHtml('X', { sog: null, cog: 0, t: null })
    assert.match(html, /– kn · 0°/)
  })
})

describe('pickTiles', () => {
  const proxied = (identifier, name) => ({
    identifier,
    name,
    proxy: true,
    tilemapUrl: `/signalk/chart-tiles/${identifier}/{z}/{x}/{y}`,
    maxzoom: 18
  })

  it('picks a base map and a seamark overlay', () => {
    const found = pickTiles({ osm: proxied('osm', 'osm'), seamark: proxied('seamark', 'seamark') })
    assert.equal(found.base.identifier, 'osm')
    assert.equal(found.seamark.identifier, 'seamark')
  })

  it('matches the longer spellings too', () => {
    const found = pickTiles({
      a: proxied('open-street-map', 'OpenStreetMap'),
      b: proxied('open-sea-map', 'OpenSeaMap Seamarks')
    })
    assert.equal(found.base.identifier, 'open-street-map')
    assert.equal(found.seamark.identifier, 'open-sea-map')
  })

  // "openseamap" must not be mistaken for the base map, and the seamark
  // overlay must not be mistaken for the base layer.
  it('does not file the seamark overlay as the base map', () => {
    const found = pickTiles({ b: proxied('open-sea-map', 'OpenSeaMap') })
    assert.equal(found.seamark.identifier, 'open-sea-map')
    assert.equal(found.base, undefined)
  })

  // A chart the server does not proxy carries the foreign URL itself, so
  // using it would hit the public tile server anyway.
  it('ignores a chart that is not proxied', () => {
    assert.deepEqual(
      pickTiles({
        osm: {
          identifier: 'osm',
          name: 'osm',
          proxy: false,
          tilemapUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
        }
      }),
      {}
    )
  })

  it('ignores an entry whose URL is not a tile template', () => {
    assert.deepEqual(
      pickTiles({
        osm: { identifier: 'osm', name: 'osm', proxy: true, url: 'https://example/a.json' }
      }),
      {}
    )
  })

  it('ignores charts it cannot place, and empty input', () => {
    assert.deepEqual(pickTiles({ x: proxied('noaa-enc', 'NOAA ENC') }), {})
    assert.deepEqual(pickTiles({}), {})
    assert.deepEqual(pickTiles(null), {})
  })

  it('keeps the first match when several charts qualify', () => {
    const found = pickTiles({ a: proxied('osm', 'osm'), b: proxied('osm-2', 'osm 2') })
    assert.equal(found.base.identifier, 'osm')
  })
})
