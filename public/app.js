const STATE_URL = '/plugins/signalk-sailtracker/state'
const TRACK_URL = (mmsi) => `/plugins/signalk-sailtracker/boats/${mmsi}/track`
const REFRESH_MS = 30000
const PLAY_STEP_MS = 800
// Default view. The plugin keeps retentionDays (14) of history, but showing
// all of it at once buries the current picture under stale tracks.
const RECENT_DAYS = 2

const boatListEl = document.querySelector('#boat-list')
const boatCountEl = document.querySelector('#boat-count')
const intervalInfoEl = document.querySelector('#interval-info')
const showAllBtn = document.querySelector('#show-all')
const emptyHintEl = document.querySelector('#empty-hint')
const timelineBarEl = document.querySelector('#timeline-bar')
const tlSliderEl = document.querySelector('#tl-slider')
const tlTimeEl = document.querySelector('#tl-time')
const tlPlayEl = document.querySelector('#tl-play')
const rangeSelectEl = document.querySelector('#range-select')
const sheetHandleEl = document.querySelector('#sheet-handle')
const sheetCountEl = document.querySelector('#sheet-count')
const sheetIntervalEl = document.querySelector('#sheet-interval')
const recenterEl = document.querySelector('#recenter')

// Pure helpers live in helpers.js so the test suite can drive them without
// a DOM; index.html loads that file before this one.
const {
  colorFor,
  fmtAge,
  fmtDateTime,
  dayLabel,
  windowQuery: buildWindowQuery,
  daysInRange,
  escapeHtml,
  pointPopupHtml,
  pickTiles
} = window.SailtrackerHelpers

// Auf einem Telefon liegt die Bootsliste als Bottom-Sheet über der Karte,
// und alles Antippbare braucht mehr Fläche als ein Mauszeiger. Beides wird
// getrennt abgefragt: ein Touch-Display am Kartentisch ist breit, ein
// Browserfenster am Rand des Schreibtischs schmal.
const TOUCH = window.matchMedia('(pointer: coarse)').matches
const sheetLayout = () => window.matchMedia('(max-width: 720px)').matches
const TRACK_WEIGHT = TOUCH ? 3 : 2
const DOT_RADIUS = TOUCH ? 8 : 6
const SCRUB_RADIUS = TOUCH ? 9 : 7

let map
let selfMarker
let selfPos = null
let selfCentered = false
const trackLayers = new Map() // mmsi -> {polyline, marker}  (used in "Alle" mode)
let selectedMmsi = null // null = show all
let lastBoats = []

// Which slice of history is on screen:
//   { mode: 'recent' }              last RECENT_DAYS days (default)
//   { mode: 'day', day: 'Y-M-D' }   one calendar day, browser-local
//   { mode: 'all' }                 everything still in retention
let range = { mode: 'recent' }
// Rebuilding the <select> on every 30s refresh would fight the user's
// selection, so options are only rebuilt when the available days change.
let dayOptionsKey = null

// Single-boat scrub state
let scrubTrack = null // current boat's track array while one boat is selected
let scrubPolyline = null
let scrubMarker = null
let scrubColor = null
let scrubName = null
let playTimer = null

// Ein Popup darf auf 360 px Bildschirmbreite nicht über den Rand ragen,
// und beim Aufklappen muss die Karte weit genug nachrücken, dass es nicht
// unter der Kopfzeile klebt.
const POPUP_OPTS = { maxWidth: 260, autoPanPadding: [20, 20] }

// Kachelquellen. Direkt angefragt sind das zwei fremde Hosts pro Gerät und
// Ansicht -- das reizt die freien Server aus und ist genau das, was ein
// Inhaltsblocker auf dem Telefon wegfiltert.
const CHARTS_URL = '/signalk/v1/api/resources/charts'
const DIRECT_TILES = {
  base: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors'
  },
  seamark: {
    url: 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
    attribution: '&copy; OpenSeaMap contributors'
  }
}

// Kacheln, die der Signal-K-Charts-Plugin durchreicht und zwischenspeichert.
// Sie liegen dann auf derselben Herkunft wie diese Seite, und der fremde
// Server sieht eine Anfrage pro Kachel statt eine pro Gerät und Ansicht.
// Ohne dieses Plugin bleibt alles wie zuvor.
async function proxiedTiles() {
  try {
    const res = await fetch(CHARTS_URL, { signal: AbortSignal.timeout(2500) })
    if (!res.ok) return {}
    return pickTiles(await res.json())
  } catch (err) {
    console.warn('sailtracker: no Signal K chart provider, using public tiles', err)
    return {}
  }
}

function addTileLayer(proxied, direct) {
  // Die Namensnennung gilt der Quelle der Daten, nicht dem Weg, den die
  // Bytes genommen haben -- sie bleibt also in beiden Fällen stehen.
  const url = proxied ? proxied.tilemapUrl || proxied.url : direct.url
  L.tileLayer(url, {
    attribution: direct.attribution,
    maxZoom: proxied && proxied.maxzoom ? proxied.maxzoom : 18
  }).addTo(map)
  return Boolean(proxied)
}

async function initMap() {
  map = L.map('map', { zoomControl: true }).setView([54.5, 16.5], 9)
  // Ein Tipper auf die Karte heißt "ich will die Karte sehen".
  map.on('click', () => {
    if (sheetLayout()) setSheet(false)
  })

  const proxied = await proxiedTiles()
  const viaBase = addTileLayer(proxied.base, DIRECT_TILES.base)
  const viaSeamark = addTileLayer(proxied.seamark, DIRECT_TILES.seamark)
  console.info(
    `sailtracker: Grundkarte ${viaBase ? 'über Signal K' : 'direkt'}, ` +
      `Seezeichen ${viaSeamark ? 'über Signal K' : 'direkt'}`
  )
}

// Local calendar key, e.g. "2026-09-08". Deliberately not toISOString(),
// which would shift the day boundary to UTC and put late-evening fixes on
// the wrong day.
// The pure helper takes the range explicitly; this binds it to the
// module-level state the rest of the app mutates.
function windowQuery() {
  return buildWindowQuery(range, RECENT_DAYS)
}

function buildRangeOptions(dataRange) {
  const days = daysInRange(dataRange)
  const key = days.join(',')
  if (key === dayOptionsKey) return
  dayOptionsKey = key

  const previous = rangeSelectEl.value
  rangeSelectEl.innerHTML = ''
  const add = (value, label) => {
    const opt = document.createElement('option')
    opt.value = value
    opt.textContent = label
    rangeSelectEl.appendChild(opt)
  }
  add('recent', `Letzte ${RECENT_DAYS} Tage`)
  for (const d of days) add(`day:${d}`, dayLabel(d))
  add('all', 'Gesamter Zeitraum')

  // Keep the user's pick across rebuilds; fall back to the default if the
  // day they were looking at has aged out of retention.
  rangeSelectEl.value =
    previous && [...rangeSelectEl.options].some((o) => o.value === previous) ? previous : 'recent'
  if (rangeSelectEl.value === 'recent' && range.mode === 'day') {
    range = { mode: 'recent' }
  }
}

rangeSelectEl.addEventListener('change', () => {
  const value = rangeSelectEl.value
  if (value === 'all') range = { mode: 'all' }
  else if (value.startsWith('day:')) range = { mode: 'day', day: value.slice(4) }
  else range = { mode: 'recent' }
  stopScrub()
  clearLayers()
  refresh()
})

function renderList(boats) {
  const label = `${boats.length} Boot${boats.length === 1 ? '' : 'e'}`
  boatCountEl.textContent = label
  sheetCountEl.textContent = label
  boatListEl.innerHTML = ''
  emptyHintEl.hidden = boats.length > 0

  for (const b of boats) {
    const row = document.createElement('button')
    row.className = 'boat-row' + (selectedMmsi === b.mmsi ? ' active' : '')
    row.innerHTML = `
      <span class="dot" style="background:${colorFor(b.mmsi)}"></span>
      <span class="boat-name">${escapeHtml(b.name || b.mmsi)}<span class="boat-sub" title="${fmtDateTime(b.lastSeen)}">${b.points} Punkte · zuletzt ${fmtAge(b.lastSeen)}</span></span>
    `
    row.addEventListener('click', () => selectBoat(b.mmsi))
    boatListEl.appendChild(row)
  }
}

function clearLayers() {
  for (const { polyline, marker } of trackLayers.values()) {
    map.removeLayer(polyline)
    map.removeLayer(marker)
  }
  trackLayers.clear()
  stopScrub()
}

// "Alle" mode: one static polyline + marker at the latest point per boat,
// no interactivity - a quick overview.
function drawTrack(mmsi, name, track) {
  if (!track.length) return
  const color = colorFor(mmsi)
  const latlngs = track.map((p) => [p.lat, p.lon])
  const polyline = L.polyline(latlngs, { color, weight: TRACK_WEIGHT, opacity: 0.85 }).addTo(map)
  const last = track[track.length - 1]
  const marker = L.circleMarker([last.lat, last.lon], {
    radius: DOT_RADIUS,
    color,
    fillColor: color,
    fillOpacity: 0.9,
    weight: 2
  }).addTo(map)
  marker.bindPopup(pointPopupHtml(name || mmsi, last), POPUP_OPTS)
  trackLayers.set(mmsi, { polyline, marker })
}

function stopScrub() {
  if (playTimer) {
    clearInterval(playTimer)
    playTimer = null
    tlPlayEl.textContent = '▶'
  }
  if (scrubPolyline) map.removeLayer(scrubPolyline)
  if (scrubMarker) map.removeLayer(scrubMarker)
  scrubPolyline = null
  scrubMarker = null
  scrubTrack = null
  timelineBarEl.hidden = true
}

// Single-boat mode: the full track stays visible as a polyline for
// context, but the marker sits at whichever point the timeline slider
// points to - "das Schiff an den entsprechenden Stellen zeigen".
function showSingleBoatTrack(mmsi, name, track) {
  stopScrub()
  if (!track.length) return

  scrubTrack = track
  scrubColor = colorFor(mmsi)
  scrubName = name || mmsi

  const latlngs = track.map((p) => [p.lat, p.lon])
  scrubPolyline = L.polyline(latlngs, {
    color: scrubColor,
    weight: TRACK_WEIGHT,
    opacity: 0.85
  }).addTo(map)

  const lastIndex = track.length - 1
  scrubMarker = L.circleMarker(latlngs[lastIndex], {
    radius: SCRUB_RADIUS,
    color: scrubColor,
    fillColor: scrubColor,
    fillOpacity: 0.95,
    weight: 2
  }).addTo(map)
  scrubMarker.bindPopup(pointPopupHtml(scrubName, track[lastIndex]), POPUP_OPTS).openPopup()

  if (track.length >= 2) {
    tlSliderEl.min = 0
    tlSliderEl.max = lastIndex
    tlSliderEl.value = lastIndex
    tlTimeEl.textContent = fmtDateTime(track[lastIndex].t)
    timelineBarEl.hidden = false
  }
}

function scrubTo(index) {
  if (!scrubTrack || !scrubTrack[index]) return
  const p = scrubTrack[index]
  scrubMarker.setLatLng([p.lat, p.lon])
  scrubMarker.setPopupContent(pointPopupHtml(scrubName, p))
  tlTimeEl.textContent = fmtDateTime(p.t)
}

tlSliderEl.addEventListener('input', () => scrubTo(Number(tlSliderEl.value)))

tlPlayEl.addEventListener('click', () => {
  if (playTimer) {
    clearInterval(playTimer)
    playTimer = null
    tlPlayEl.textContent = '▶'
    return
  }
  if (!scrubTrack) return
  // Replay from the start if already parked at the end.
  if (Number(tlSliderEl.value) >= Number(tlSliderEl.max)) {
    tlSliderEl.value = 0
    scrubTo(0)
  }
  tlPlayEl.textContent = '⏸'
  playTimer = setInterval(() => {
    const next = Number(tlSliderEl.value) + 1
    if (next > Number(tlSliderEl.max)) {
      clearInterval(playTimer)
      playTimer = null
      tlPlayEl.textContent = '▶'
      return
    }
    tlSliderEl.value = next
    scrubTo(next)
  }, PLAY_STEP_MS)
})

async function loadTrack(mmsi, name) {
  try {
    const res = await fetch(TRACK_URL(mmsi) + windowQuery())
    if (!res.ok) return
    const data = await res.json()
    if (selectedMmsi === null) {
      drawTrack(mmsi, name, data.track || [])
    } else {
      showSingleBoatTrack(mmsi, name, data.track || [])
    }
  } catch (err) {
    console.error('sailtracker: failed to load track', mmsi, err)
  }
}

function selectBoat(mmsi) {
  selectedMmsi = mmsi
  showAllBtn.classList.toggle('active', mmsi === null)
  if (sheetLayout()) setSheet(false)
  renderList(lastBoats)
  clearLayers()
  if (mmsi === null) {
    for (const b of lastBoats) loadTrack(b.mmsi, b.name)
  } else {
    const b = lastBoats.find((x) => x.mmsi === mmsi)
    loadTrack(mmsi, b && b.name)
  }
}

showAllBtn.addEventListener('click', () => selectBoat(null))

// Das Sheet verdeckt aufgeklappt den unteren Teil der Karte. Nach der Wahl
// eines Bootes will man genau dorthin sehen, also klappt es dann selbst
// wieder ein.
function setSheet(open) {
  document.body.classList.toggle('sheet-open', open)
  sheetHandleEl.setAttribute('aria-expanded', String(open))
}

sheetHandleEl.addEventListener('click', () =>
  setSheet(!document.body.classList.contains('sheet-open'))
)

function updateSelf(self) {
  if (!self) return
  selfPos = [self.lat, self.lon]
  if (!selfMarker) {
    selfMarker = L.marker(selfPos, {
      icon: L.divIcon({ className: 'self-marker', html: '⛵', iconSize: [24, 24] })
    }).addTo(map)
    selfMarker.bindPopup('Noomi', POPUP_OPTS)
  } else {
    selfMarker.setLatLng(selfPos)
  }
  recenterEl.hidden = false
  if (!selfCentered) {
    map.setView(selfPos, 11)
    selfCentered = true
  }
}

// Mit dem Daumen ist die Karte schnell verschoben und der Weg zurück zum
// eigenen Boot sonst Handarbeit.
recenterEl.addEventListener('click', () => {
  if (selfPos) map.setView(selfPos, Math.max(map.getZoom(), 11))
})

async function refresh() {
  try {
    const res = await fetch(STATE_URL + windowQuery())
    const data = await res.json()
    lastBoats = data.boats || []
    buildRangeOptions(data.dataRange)
    const c = data.config
    const parts = c ? [`Scan alle ${c.intervalMinutes} min`, `Class ${c.aisClass}`] : []
    // Mit der Weitfang-Option hängt es an der eigenen Fahrt, was überhaupt
    // geloggt wird. Ohne diese Zeile bliebe unerklärlich, warum plötzlich
    // Frachter in der Liste stehen -- oder eben nicht mehr.
    if (c && c.underwayLogsAll) {
      parts.push(
        data.selfUnderway ? 'in Fahrt: alle fahrenden Schiffe' : 'im Stand: nur gewählte Typen'
      )
    }
    const interval = parts.join(' · ')
    intervalInfoEl.textContent = interval
    sheetIntervalEl.textContent = interval
    updateSelf(data.self)
    renderList(lastBoats)
    // Refresh the currently visible track(s) too, so positions keep
    // moving between full list refreshes. Skip this while the user is
    // actively scrubbing/playing a boat's history, so a background
    // refresh doesn't yank the slider back to "now".
    if (playTimer) return
    // Dasselbe gilt fürs Ziehen von Hand: mit dem Finger dauert das länger
    // als 30 s, und ein Neuzeichnen würde den Regler ans Ende reißen.
    if (scrubTrack && Number(tlSliderEl.value) < Number(tlSliderEl.max)) return
    if (selectedMmsi === null) {
      clearLayers()
      for (const b of lastBoats) loadTrack(b.mmsi, b.name)
    } else if (lastBoats.some((b) => b.mmsi === selectedMmsi)) {
      clearLayers()
      const b = lastBoats.find((x) => x.mmsi === selectedMmsi)
      loadTrack(selectedMmsi, b.name)
    } else {
      // selected boat aged out of the list entirely - fall back to all
      selectBoat(null)
    }
  } catch (err) {
    console.error('sailtracker: refresh failed', err)
  }
}

// Beim Drehen des Telefons und beim Ein-/Ausfahren der Adressleiste ändert
// sich die Kartenhöhe, ohne dass Leaflet davon erfährt -- ohne das bleiben
// graue Streifen am Rand stehen.
let resizeTimer = null
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => map.invalidateSize(), 150)
})

initMap().catch((err) => console.error('sailtracker: map init failed', err))
refresh()
setInterval(refresh, REFRESH_MS)
