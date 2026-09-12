// Pure helpers for the webapp: colours, date formatting, the read API's
// query window, HTML escaping and the chart-source choice. Nothing here
// touches the DOM, Leaflet or the network.
//
// Kept in its own file so both sides can load it: the browser pulls it in
// as a plain <script> before app.js, and `node --test` requires it
// directly. That mirrors index.js, where the decision logic also sits
// apart from the wiring so the test suite can drive it on its own.
;(function (scope) {
  'use strict'

  const PALETTE = [
    '#4fb0e8',
    '#f2a541',
    '#7fd88f',
    '#e86f9d',
    '#c99cf2',
    '#f2e04f',
    '#4fe8d4',
    '#f28a4f',
    '#9cc9f2',
    '#e84f4f'
  ]

  // Stable colour per MMSI: the same boat keeps its colour across reloads
  // and across the list and the chart, without anything being stored.
  function colorFor(mmsi) {
    let hash = 0
    const s = String(mmsi)
    for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0
    return PALETTE[hash % PALETTE.length]
  }

  function pad(n) {
    return String(n).padStart(2, '0')
  }

  function fmtAge(iso, nowMs = Date.now()) {
    if (!iso) return '–'
    const s = Math.round((nowMs - Date.parse(iso)) / 1000)
    if (s < 60) return `vor ${s}s`
    const m = Math.round(s / 60)
    if (m < 60) return `vor ${m}m`
    const h = Math.round(m / 60)
    if (h < 48) return `vor ${h}h`
    return `vor ${Math.round(h / 24)}d`
  }

  // Absolute local date + time, e.g. "28.08.2026 15:53:29" - the timeline
  // scrubs through history, where a relative "vor 3 Tagen" stops being
  // useful; this is what actually answers "wann war das Boot dort".
  function fmtDateTime(iso) {
    if (!iso) return '–'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '–'
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  // Local calendar key, e.g. "2026-09-08". Deliberately not toISOString(),
  // which would shift the day boundary to UTC and put late-evening fixes on
  // the wrong day.
  function dayKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }

  function dayLabel(key, now = new Date()) {
    if (key === dayKey(now)) return 'Heute'
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
    if (key === dayKey(yesterday)) return 'Gestern'
    const [y, m, d] = key.split('-')
    return `${d}.${m}.${y}`
  }

  // Query string for a range. Day boundaries are built via the Date
  // constructor rather than "+24h" so a DST switch doesn't clip or stretch
  // a day. The server treats the window as [from, to).
  function windowQuery(range, recentDays, now = new Date()) {
    if (!range || range.mode === 'all') return ''
    if (range.mode === 'day') {
      const [y, m, d] = String(range.day).split('-').map(Number)
      const from = new Date(y, m - 1, d)
      const to = new Date(y, m - 1, d + 1)
      return `?from=${from.toISOString()}&to=${to.toISOString()}`
    }
    const from = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - recentDays,
      now.getHours(),
      now.getMinutes(),
      now.getSeconds()
    )
    return `?from=${from.toISOString()}`
  }

  // Calendar days covered by the logged data, newest first.
  function daysInRange(dataRange) {
    const days = []
    if (!dataRange || !dataRange.from || !dataRange.to) return days
    const first = new Date(dataRange.from)
    const last = new Date(dataRange.to)
    if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return days
    let cursor = new Date(last.getFullYear(), last.getMonth(), last.getDate())
    const firstDay = new Date(first.getFullYear(), first.getMonth(), first.getDate())
    // Guard against a corrupt timestamp producing an unbounded loop.
    while (cursor >= firstDay && days.length < 60) {
      days.push(dayKey(cursor))
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 1)
    }
    return days
  }

  // Vessel names arrive over the air from strangers' transponders and go
  // into innerHTML. Anything that reaches the page this way is escaped.
  function escapeHtml(value) {
    return String(value).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    )
  }

  // Conditions are only present on points logged after weather recording
  // was added, and stay null whenever no source could answer -- so the
  // weather line is omitted rather than showing a row of dashes.
  function wxHtml(point) {
    const parts = []
    if (point.windDir !== null && point.windDir !== undefined) parts.push(`${point.windDir}°`)
    if (point.windKn !== null && point.windKn !== undefined) parts.push(`${point.windKn} kn`)
    const wind = parts.length ? `Wind ${parts.join(' / ')}` : null
    const wave = point.waveM !== null && point.waveM !== undefined ? `Welle ${point.waveM} m` : null
    const line = [wind, wave].filter(Boolean).join(' · ')
    return line ? `<br><span class="wx">${line}</span>` : ''
  }

  function pointPopupHtml(name, point) {
    return `<strong>${escapeHtml(name)}</strong><br>${point.sog ?? '–'} kn · ${point.cog ?? '–'}°${wxHtml(point)}<br>${fmtDateTime(point.t)}`
  }

  // Which entries of the Signal K charts resource list to use as the base
  // map and as the seamark overlay. Only proxied charts qualify: a chart
  // the server does not proxy carries the foreign URL itself, so using it
  // would fetch from the public tile server anyway and gain nothing.
  function pickTiles(charts) {
    const found = {}
    for (const chart of Object.values(charts || {})) {
      const url = chart && (chart.tilemapUrl || chart.url)
      if (!url || !url.includes('{z}') || chart.proxy !== true) continue
      const tag = `${chart.identifier || ''} ${chart.name || ''}`.toLowerCase()
      if (!found.seamark && /seamark|openseamap/.test(tag)) found.seamark = chart
      else if (!found.base && /osm|openstreetmap/.test(tag)) found.base = chart
    }
    return found
  }

  const api = {
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
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else scope.SailtrackerHelpers = api
})(typeof window !== 'undefined' ? window : globalThis)
