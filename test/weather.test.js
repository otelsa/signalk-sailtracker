// Tests for the weather enrichment: unit conversion from both sources,
// hour matching, caching, source selection and the failure paths. No test
// touches the network -- fetch is injected.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const { createWeatherSource, internals } = require('../weather')
const {
  cacheKey,
  fromSignalK,
  fromOpenMeteo,
  nearestHourIndex,
  openMeteoUrls,
  normalizeDegrees,
  roundTo
} = internals

const HOUR = 60 * 60 * 1000
const T = Date.parse('2026-09-09T08:47:00.000Z')

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body }
}

describe('unit helpers', () => {
  it('normalises bearings into [0, 360)', () => {
    assert.equal(normalizeDegrees(0), 0)
    assert.equal(normalizeDegrees(359.6), 0) // rounds to 360 -> wraps
    assert.equal(normalizeDegrees(-90), 270)
    assert.equal(normalizeDegrees(450), 90)
    assert.equal(normalizeDegrees(null), null)
  })

  it('rounds to the requested precision', () => {
    assert.equal(roundTo(1.2345, 1), 1.2)
    assert.equal(roundTo(1.2345, 2), 1.23)
  })
})

describe('fromSignalK', () => {
  // Signal K is SI throughout; the log stores knots/degrees to match
  // the sog/cog already on each point.
  it('converts m/s to knots and radians to degrees', () => {
    const wx = fromSignalK({
      wind: { speedTrue: 10, directionTrue: Math.PI },
      water: { waveSignificantHeight: 1.234 }
    })
    assert.equal(wx.windKn, 19.4)
    assert.equal(wx.windDir, 180)
    assert.equal(wx.waveM, 1.23)
  })

  it('keeps partial observations', () => {
    const wx = fromSignalK({ water: { waveSignificantHeight: 0.8 } })
    assert.equal(wx.waveM, 0.8)
    assert.equal(wx.windKn, null)
    assert.equal(wx.windDir, null)
  })

  // An observation with none of the three fields must not count as a hit,
  // or it would block the fallback source.
  it('returns null when nothing usable is present', () => {
    assert.equal(fromSignalK({}), null)
    assert.equal(fromSignalK({ wind: {}, water: {} }), null)
    assert.equal(fromSignalK(null), null)
    assert.equal(fromSignalK({ wind: { speedTrue: 'strong' } }), null)
  })
})

describe('nearestHourIndex', () => {
  const base = Date.parse('2026-09-09T06:00:00.000Z')
  const times = [0, 1, 2, 3].map((i) => Math.floor((base + i * HOUR) / 1000))

  it('picks the closest hour, rounding up past the half hour', () => {
    // 08:47 is closer to 09:00 than to 08:00
    assert.equal(nearestHourIndex(times, Date.parse('2026-09-09T08:47:00.000Z')), 3)
    assert.equal(nearestHourIndex(times, Date.parse('2026-09-09T08:10:00.000Z')), 2)
  })

  it('refuses a row more than half an hour away', () => {
    assert.equal(nearestHourIndex(times, Date.parse('2026-09-09T20:00:00.000Z')), -1)
  })

  it('handles an empty or missing series', () => {
    assert.equal(nearestHourIndex([], T), -1)
    assert.equal(nearestHourIndex(undefined, T), -1)
  })
})

describe('fromOpenMeteo', () => {
  const base = Date.parse('2026-09-09T08:00:00.000Z')
  const times = [Math.floor(base / 1000), Math.floor((base + HOUR) / 1000)]

  const forecast = {
    hourly: { time: times, wind_speed_10m: [12.4, 14.9], wind_direction_10m: [270, 280] }
  }
  const marine = { hourly: { time: times, wave_height: [0.85, 1.1] } }

  it('reads wind and wave from the matching hour', () => {
    const wx = fromOpenMeteo(forecast, marine, Date.parse('2026-09-09T09:05:00.000Z'))
    assert.equal(wx.windKn, 14.9)
    assert.equal(wx.windDir, 280)
    assert.equal(wx.waveM, 1.1)
  })

  // Wave height is useful without wind and vice versa, so one missing
  // endpoint must not discard the other's data.
  it('survives a missing marine response', () => {
    const wx = fromOpenMeteo(forecast, null, base)
    assert.equal(wx.windKn, 12.4)
    assert.equal(wx.waveM, null)
  })

  it('survives a missing forecast response', () => {
    const wx = fromOpenMeteo(null, marine, base)
    assert.equal(wx.waveM, 0.85)
    assert.equal(wx.windKn, null)
  })

  it('returns null when neither source answers', () => {
    assert.equal(fromOpenMeteo(null, null, base), null)
  })

  it('returns null when the time is outside the returned series', () => {
    assert.equal(fromOpenMeteo(forecast, marine, base + 12 * HOUR), null)
  })
})

describe('openMeteoUrls', () => {
  it('requests knots so no unit guessing is needed', () => {
    const urls = openMeteoUrls(54.35, 18.65)
    assert.match(urls.forecast, /wind_speed_unit=kn/)
    assert.match(urls.forecast, /hourly=wind_speed_10m,wind_direction_10m/)
    assert.match(urls.marine, /hourly=wave_height/)
  })

  it('uses unix timestamps to avoid timezone ambiguity', () => {
    const urls = openMeteoUrls(54.35, 18.65)
    assert.match(urls.forecast, /timeformat=unixtime/)
    assert.match(urls.marine, /timeformat=unixtime/)
  })

  it('includes past_days so a fix from earlier today can still be matched', () => {
    assert.match(openMeteoUrls(54.35, 18.65).forecast, /past_days=1/)
  })
})

describe('cacheKey', () => {
  it('groups positions within the same grid cell and hour', () => {
    const a = cacheKey(54.35, 18.65, T)
    const b = cacheKey(54.36, 18.66, T + 5 * 60 * 1000)
    assert.equal(a, b)
  })

  it('separates different hours', () => {
    assert.notEqual(cacheKey(54.35, 18.65, T), cacheKey(54.35, 18.65, T + 2 * HOUR))
  })

  it('separates distant positions', () => {
    assert.notEqual(cacheKey(54.35, 18.65, T), cacheKey(55.9, 18.65, T))
  })
})

describe('createWeatherSource', () => {
  function appWith(observation, { throws = false } = {}) {
    return {
      debug: () => {},
      error: () => {},
      weatherApi: {
        getObservations: async () => {
          if (throws) throw new Error('provider offline')
          return [observation]
        }
      }
    }
  }

  it('prefers the Signal K provider over the internet', async () => {
    let fetched = 0
    const src = createWeatherSource({
      app: appWith({ wind: { speedTrue: 5, directionTrue: 0 }, water: {} }),
      fetchImpl: async () => {
        fetched++
        return jsonResponse({})
      }
    })
    const wx = await src.at(54.35, 18.65, T)
    assert.equal(wx.windKn, 9.7)
    assert.equal(fetched, 0, 'must not hit the network when a provider answered')
  })

  it('falls back to Open-Meteo when no provider is registered', async () => {
    const base = Math.floor(T / HOUR) * HOUR
    const src = createWeatherSource({
      app: { debug: () => {}, error: () => {} },
      fetchImpl: async (url) =>
        jsonResponse(
          url.includes('marine')
            ? { hourly: { time: [Math.floor(base / 1000)], wave_height: [1.5] } }
            : {
                hourly: {
                  time: [Math.floor(base / 1000)],
                  wind_speed_10m: [20],
                  wind_direction_10m: [90]
                }
              }
        )
    })
    const wx = await src.at(54.35, 18.65, base)
    assert.equal(wx.windKn, 20)
    assert.equal(wx.windDir, 90)
    assert.equal(wx.waveM, 1.5)
  })

  it('falls back when the provider throws', async () => {
    let fetched = 0
    const src = createWeatherSource({
      app: appWith(null, { throws: true }),
      fetchImpl: async () => {
        fetched++
        return jsonResponse({})
      }
    })
    await src.at(54.35, 18.65, T)
    assert.equal(fetched, 2, 'both Open-Meteo endpoints tried after the provider failed')
  })

  it("source 'signalk' never reaches for the internet", async () => {
    let fetched = 0
    const src = createWeatherSource({
      app: { debug: () => {}, error: () => {} },
      source: 'signalk',
      fetchImpl: async () => {
        fetched++
        return jsonResponse({})
      }
    })
    assert.equal(await src.at(54.35, 18.65, T), null)
    assert.equal(fetched, 0)
  })

  it("source 'open-meteo' skips the local provider", async () => {
    let asked = false
    const app = {
      debug: () => {},
      error: () => {},
      weatherApi: {
        getObservations: async () => {
          asked = true
          return [{ wind: { speedTrue: 5 } }]
        }
      }
    }
    const src = createWeatherSource({
      app,
      source: 'open-meteo',
      fetchImpl: async () => jsonResponse({})
    })
    await src.at(54.35, 18.65, T)
    assert.equal(asked, false)
  })

  // Boats in one bay must cost one request between them, not one each.
  it('serves repeat lookups in the same cell and hour from cache', async () => {
    let fetched = 0
    const src = createWeatherSource({
      app: { debug: () => {}, error: () => {} },
      fetchImpl: async () => {
        fetched++
        return jsonResponse({})
      }
    })
    await src.at(54.35, 18.65, T)
    await src.at(54.36, 18.66, T)
    await src.at(54.35, 18.65, T)
    assert.equal(fetched, 2, 'one pair of endpoint calls, then cache hits')
  })

  it('caches negative results so an offline scan retries once per hour', async () => {
    let fetched = 0
    const src = createWeatherSource({
      app: { debug: () => {}, error: () => {} },
      fetchImpl: async () => {
        fetched++
        throw new Error('ENETUNREACH')
      }
    })
    assert.equal(await src.at(54.35, 18.65, T), null)
    assert.equal(await src.at(54.35, 18.65, T), null)
    assert.equal(fetched, 2, 'second lookup served from the negative cache')
  })

  it('returns null for a non-numeric position instead of building a request', async () => {
    const src = createWeatherSource({ app: {}, fetchImpl: async () => jsonResponse({}) })
    assert.equal(await src.at(undefined, 18.65, T), null)
  })

  it('reports what it is doing for the status view', async () => {
    const src = createWeatherSource({
      app: { debug: () => {}, error: () => {} },
      source: 'auto',
      fetchImpl: async () => jsonResponse({})
    })
    await src.at(54.35, 18.65, T)
    const stats = src.stats()
    assert.equal(stats.source, 'auto')
    assert.equal(stats.cached, 1)
  })
})
