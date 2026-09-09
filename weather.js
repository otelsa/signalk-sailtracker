// Weather enrichment for logged track points: wind direction, wind speed
// and significant wave height at the position and time of each fix.
//
// Two sources, in this order:
//
//   1. Signal K's Weather API (app.weatherApi). Whatever the boat's own
//      weather provider serves -- a GRIB provider reading local GRIB2
//      files, for instance -- so this path works offshore with no
//      internet, and needs no code change once such a provider is
//      installed.
//   2. Open-Meteo, over HTTPS. Same numerical models a GRIB file carries
//      (ICON/GFS/ECMWF), served as JSON, no API key. Needs internet.
//
// Weather is never allowed to break logging: every failure path returns
// nulls and the track point is written regardless.

// Model data is hourly on a grid coarser than the spread of boats in a
// bay, so one lookup per cell per hour is the honest resolution -- and it
// keeps a 5-minute scan of 15 boats from making 4000 requests a day.
const GRID_DEG = 0.1
const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_MAX_ENTRIES = 200
const REQUEST_TIMEOUT_MS = 8000

const OPEN_METEO_MARINE = 'https://marine-api.open-meteo.com/v1/marine'
const OPEN_METEO_FORECAST = 'https://api.open-meteo.com/v1/forecast'

const MS_TO_KN = 1.9438444924574
const RAD_TO_DEG = 180 / Math.PI

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// Normalise a compass bearing into [0, 360). Rounding happens first:
// wrapping before rounding lets 359.6 round back up to 360, which is not
// a valid bearing.
function normalizeDegrees(deg) {
  if (deg === null) return null
  const rounded = Math.round(deg)
  return ((rounded % 360) + 360) % 360
}

function roundTo(value, digits) {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

// One cache slot per grid cell per hour. Snapping multiplies rather than
// dividing by GRID_DEG: 18.65 / 0.1 is 186.49999... in binary floating
// point and rounds *down*, so two positions 0.01 deg apart would land in
// different cells and defeat the cache.
const GRID_STEPS_PER_DEG = Math.round(1 / GRID_DEG)
function cacheKey(lat, lon, timeMs) {
  const snap = (v) => (Math.round(v * GRID_STEPS_PER_DEG) / GRID_STEPS_PER_DEG).toFixed(1)
  return `${snap(lat)},${snap(lon)},${Math.floor(timeMs / CACHE_TTL_MS)}`
}

// Signal K speaks SI throughout: m/s, radians, metres. The track points
// store knots and degrees (matching sog/cog), so convert once here rather
// than leaving mixed units in the log.
function fromSignalK(observation) {
  if (!observation || typeof observation !== 'object') return null
  const wind = observation.wind || {}
  const water = observation.water || {}

  const speed = numberOrNull(wind.speedTrue)
  const direction = numberOrNull(wind.directionTrue)
  const wave = numberOrNull(water.waveSignificantHeight)

  const result = {
    windDir: direction === null ? null : normalizeDegrees(direction * RAD_TO_DEG),
    windKn: speed === null ? null : roundTo(speed * MS_TO_KN, 1),
    waveM: wave === null ? null : roundTo(wave, 2)
  }
  // An observation that carries none of the three is not worth caching as
  // a hit -- fall through to the next source instead.
  return result.windDir === null && result.windKn === null && result.waveM === null ? null : result
}

// Pick the hourly row closest to the fix. Open-Meteo returns whole hours;
// a point logged at 08:47 belongs to 09:00, not 08:00.
function nearestHourIndex(times, timeMs) {
  if (!Array.isArray(times) || !times.length) return -1
  const target = timeMs / 1000
  let best = -1
  let bestDelta = Infinity
  for (let i = 0; i < times.length; i++) {
    const delta = Math.abs(times[i] - target)
    if (delta < bestDelta) {
      bestDelta = delta
      best = i
    }
  }
  // Beyond half an hour the model row describes a different situation;
  // reporting it as the conditions at this fix would be a guess.
  return bestDelta <= 30 * 60 ? best : -1
}

function fromOpenMeteo(forecast, marine, timeMs) {
  const result = { windDir: null, windKn: null, waveM: null }

  const fHourly = forecast && forecast.hourly
  if (fHourly) {
    const i = nearestHourIndex(fHourly.time, timeMs)
    if (i >= 0) {
      const speed = numberOrNull(fHourly.wind_speed_10m && fHourly.wind_speed_10m[i])
      const dir = numberOrNull(fHourly.wind_direction_10m && fHourly.wind_direction_10m[i])
      result.windKn = speed === null ? null : roundTo(speed, 1)
      result.windDir = normalizeDegrees(dir)
    }
  }

  const mHourly = marine && marine.hourly
  if (mHourly) {
    const i = nearestHourIndex(mHourly.time, timeMs)
    if (i >= 0) {
      const wave = numberOrNull(mHourly.wave_height && mHourly.wave_height[i])
      result.waveM = wave === null ? null : roundTo(wave, 2)
    }
  }

  return result.windDir === null && result.windKn === null && result.waveM === null ? null : result
}

function openMeteoUrls(lat, lon) {
  const common = `latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&timeformat=unixtime&past_days=1&forecast_days=1`
  return {
    // wind_speed_unit=kn so the API does the conversion and the plugin
    // never has to guess which unit a field arrived in.
    forecast: `${OPEN_METEO_FORECAST}?${common}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn`,
    marine: `${OPEN_METEO_MARINE}?${common}&hourly=wave_height`
  }
}

// A weather lookup that caches by grid cell and hour, tries the boat's own
// provider first, and degrades to nulls rather than throwing.
function createWeatherSource({ app, source = 'auto', fetchImpl, now = () => Date.now() }) {
  const cache = new Map()
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null)

  function evictIfNeeded() {
    // Insertion-ordered Map: the oldest key is the first one.
    while (cache.size > CACHE_MAX_ENTRIES) {
      cache.delete(cache.keys().next().value)
    }
  }

  async function fromWeatherApi(lat, lon) {
    if (source !== 'auto' && source !== 'signalk') return null
    const api = app && app.weatherApi
    if (!api || typeof api.getObservations !== 'function') return null
    try {
      const observations = await api.getObservations(
        { latitude: lat, longitude: lon },
        { maxCount: 1 }
      )
      const first = Array.isArray(observations) ? observations[0] : observations
      return fromSignalK(first)
    } catch (err) {
      // A provider that errors is not a reason to skip the fallback.
      if (app && app.debug) app.debug(`weather: signalk provider failed: ${err.message}`)
      return null
    }
  }

  async function fromOnline(lat, lon, timeMs) {
    if (source !== 'auto' && source !== 'open-meteo') return null
    if (!doFetch) return null
    const urls = openMeteoUrls(lat, lon)
    const get = async (url) => {
      const res = await doFetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }
    try {
      // One failing endpoint must not cost the other's data: wave height
      // is useful without wind and vice versa.
      const [forecast, marine] = await Promise.all([
        get(urls.forecast).catch(() => null),
        get(urls.marine).catch(() => null)
      ])
      return fromOpenMeteo(forecast, marine, timeMs)
    } catch (err) {
      if (app && app.debug) app.debug(`weather: open-meteo failed: ${err.message}`)
      return null
    }
  }

  return {
    async at(lat, lon, timeMs) {
      if (typeof lat !== 'number' || typeof lon !== 'number') return null
      const key = cacheKey(lat, lon, timeMs)
      if (cache.has(key)) return cache.get(key)

      let weather = null
      try {
        weather = (await fromWeatherApi(lat, lon)) || (await fromOnline(lat, lon, timeMs))
      } catch (err) {
        if (app && app.error) app.error(`sailtracker: weather lookup failed: ${err.message}`)
        weather = null
      }

      // Negative results are cached too, so a scan without internet makes
      // one attempt per cell per hour instead of one per boat per scan.
      cache.set(key, weather)
      evictIfNeeded()
      return weather
    },

    // Exposed for the status route, so the webapp can say where the
    // numbers came from instead of leaving the user guessing.
    stats() {
      let hits = 0
      for (const value of cache.values()) if (value) hits++
      return { cached: cache.size, withData: hits, source, now: now() }
    }
  }
}

module.exports = {
  createWeatherSource,
  internals: {
    cacheKey,
    fromSignalK,
    fromOpenMeteo,
    nearestHourIndex,
    openMeteoUrls,
    normalizeDegrees,
    roundTo
  }
}
