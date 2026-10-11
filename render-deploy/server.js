const express = require('express');
const path = require('path');
const app = express();

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Google Places API ───────────────────────────────────────────────────────
app.post('/api/places', async (req, res) => {
  const key = process.env.GOOGLE_PLACES_API_KEY || '';
  if (!key) return res.status(503).json({ error: 'GOOGLE_PLACES_API_KEY not configured' });

  const { city, maxResults = 15, textQuery: customQuery, nearLat, nearLng, minKm, maxKm } = req.body;

  const fieldMask = 'places.id,places.displayName,places.rating,places.userRatingCount,places.priceLevel,places.reviews,places.websiteUri,places.formattedAddress,places.location';
  const fieldMaskNoReviews = 'places.id,places.displayName,places.rating,places.userRatingCount,places.priceLevel,places.websiteUri,places.formattedAddress,places.location';

  const geoCircle = (nearLat && nearLng)
    ? { circle: { center: { latitude: nearLat, longitude: nearLng }, radius: (maxKm || 20) * 1000 } }
    : undefined;

  async function searchPlaces(textQuery, mask) {
    const body = { textQuery, includedType: 'lodging', maxResultCount: 20, rankPreference: 'RELEVANCE' };
    if (geoCircle) body.locationBias = geoCircle;
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': mask, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) {
      const code = data.error?.status;
      if ((code === 'PERMISSION_DENIED' || code === 'RESOURCE_EXHAUSTED') && mask.includes('reviews')) {
        return searchPlaces(textQuery, fieldMaskNoReviews);
      }
      throw new Error(data.error?.message || `Places API error ${r.status}`);
    }
    return data.places || [];
  }

  // Directional Nearby Searches: centered at midpoint of distance band in N/S/E/W directions.
  // Each call returns 20 hotels nearest that offset center → catches hotels like Oasia Novena
  // that don't rank in top-20 from the reference point itself.
  async function searchNearbyDirectional(mask) {
    if (!nearLat || !nearLng) return [];
    const minK = minKm || 0;
    const maxK = maxKm || 20;
    const midKm = (minK + maxK) / 2;
    const searchRadius = Math.max((maxK - minK) * 600 + 2000, 4000); // band half-width + buffer

    const dLat = midKm / 111.32;
    const dLng = midKm / (111.32 * Math.cos(nearLat * Math.PI / 180));

    const centers = [
      { latitude: nearLat + dLat, longitude: nearLng },  // North
      { latitude: nearLat - dLat, longitude: nearLng },  // South
      { latitude: nearLat, longitude: nearLng + dLng },  // East
      { latitude: nearLat, longitude: nearLng - dLng },  // West
    ];

    const results = await Promise.all(centers.map(async center => {
      try {
        const r = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
          method: 'POST',
          headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': mask, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            includedTypes: ['lodging'],
            maxResultCount: 20,
            locationRestriction: { circle: { center, radius: searchRadius } }
          })
        });
        const data = await r.json();
        return r.ok ? (data.places || []) : [];
      } catch { return []; }
    }));
    return results.flat();
  }

  try {
    const query = customQuery || `hotels in ${city}`;
    const [textPlaces, nearbyPlaces] = await Promise.all([
      searchPlaces(query, fieldMask),
      searchNearbyDirectional(fieldMaskNoReviews)
    ]);
    const seen = new Set();
    const unique = [...textPlaces, ...nearbyPlaces].filter(p => {
      if (!p.id || seen.has(p.id)) return false;
      seen.add(p.id); return true;
    });
    return res.json({ places: unique });
  } catch (e) {
    return res.status(502).json({ error: 'Google Places upstream error', detail: e.message });
  }
});

// ── Anthropic / Claude ──────────────────────────────────────────────────────
app.post('/api/anthropic', async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY || '';
  if (!key) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  try {
    // Claude Sonnet 5 / Haiku 4.5 support well beyond 8K output tokens on the sync
    // Messages API (128K / 64K respectively) — 8K was truncating larger hotel batches
    const body = { ...req.body, max_tokens: Math.min(req.body.max_tokens || 32000, 32000) };
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'Upstream error', detail: e.message });
  }
});

// ── Google Gemini ───────────────────────────────────────────────────────────
app.post('/api/gemini', async (req, res) => {
  const key = process.env.GEMINI_API_KEY || '';
  if (!key) return res.status(503).json({ error: 'GEMINI_API_KEY not configured' });
  const model = req.body.model || 'gemini-flash-latest';
  const { model: _m, ...body } = req.body;
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    );
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'Upstream error', detail: e.message });
  }
});

// ── OpenAI-compatible (OpenAI, DeepSeek, Groq) ─────────────────────────────
app.post('/api/openai', async (req, res) => {
  const model = (req.body.model || '').toLowerCase();
  let key, baseUrl, isOpenAI = false, isDeepSeek = false;

  if (model.startsWith('deepseek')) {
    key = process.env.DEEPSEEK_API_KEY || '';
    baseUrl = 'https://api.deepseek.com/v1/chat/completions';
    isDeepSeek = true;
  } else if (/llama|mixtral|gemma/.test(model)) {
    key = process.env.GROQ_API_KEY || '';
    baseUrl = 'https://api.groq.com/openai/v1/chat/completions';
  } else {
    key = process.env.OPENAI_API_KEY || '';
    baseUrl = 'https://api.openai.com/v1/chat/completions';
    isOpenAI = true;
  }

  if (!key) return res.status(503).json({ error: `API key not configured for model: ${req.body.model}` });

  try {
    // Newer OpenAI models (gpt-5.x) require max_completion_tokens instead of max_tokens;
    // DeepSeek/Groq still use max_tokens. Normalize regardless of what the client sent.
    const { max_tokens, max_completion_tokens, thinking, ...rest } = req.body;
    const tokenLimit = Math.min(max_completion_tokens || max_tokens || 8000, 8000);
    const body = { ...rest, ...(isOpenAI ? { max_completion_tokens: tokenLimit } : { max_tokens: tokenLimit }) };
    // DeepSeek V4 defaults to "thinking" mode, which can consume the whole token
    // budget on chain-of-thought and leave nothing for the actual JSON answer
    if (isDeepSeek) body.thinking = thinking || { type: 'disabled' };
    const r = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'Upstream error', detail: e.message });
  }
});

// ── Live hotel rates (SerpApi → Google Hotels) ──────────────────────────────
// Cached 6h per query/dates/currency so repeat searches don't burn the monthly quota.
const rateCache = new Map();
const RATE_TTL_MS = 6 * 60 * 60 * 1000;

app.post('/api/hotel-rates', async (req, res) => {
  const key = process.env.SERPAPI_KEY || '';
  if (!key) return res.status(503).json({ error: 'SERPAPI_KEY not configured' });

  const { q, checkIn, checkOut, currency = 'USD', adults = 2 } = req.body || {};
  const pages = Math.min(Math.max(parseInt(req.body?.pages) || 2, 1), 3);
  const dateOk = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  if (typeof q !== 'string' || !q || q.length > 200 || !dateOk(checkIn) || !dateOk(checkOut)) {
    return res.status(400).json({ error: 'q, checkIn and checkOut (YYYY-MM-DD) are required' });
  }
  const cur = String(currency).toUpperCase().slice(0, 3);
  const nAdults = Math.min(Math.max(parseInt(adults) || 2, 1), 8);

  const cacheKey = [q.toLowerCase(), checkIn, checkOut, cur, nAdults, pages].join('|');
  const hit = rateCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < RATE_TTL_MS) return res.json({ properties: hit.properties, cached: true });

  try {
    let token, raw = [];
    for (let i = 0; i < pages; i++) {
      const params = new URLSearchParams({
        engine: 'google_hotels', q, check_in_date: checkIn, check_out_date: checkOut,
        adults: String(nAdults), currency: cur, hl: 'en', sort_by: '13', api_key: key
      });
      if (token) params.set('next_page_token', token);
      const r = await fetch('https://serpapi.com/search.json?' + params);
      const data = await r.json();
      if (!r.ok || data.error) {
        if (i === 0) return res.status(502).json({ error: 'SerpApi error', detail: String(data.error || r.status).split(key).join('***').slice(0, 200) });
        break;
      }
      raw.push(...(data.properties || []));
      token = data.serpapi_pagination?.next_page_token;
      if (!token) break;
    }
    const properties = raw.filter(p => p.name).map(p => ({
      name: p.name,
      lat: p.gps_coordinates?.latitude ?? null,
      lng: p.gps_coordinates?.longitude ?? null,
      rate: p.rate_per_night?.extracted_lowest ?? null,
      rateBeforeTax: p.rate_per_night?.extracted_before_taxes_fees ?? null,
      totalRate: p.total_rate?.extracted_lowest ?? null,
      rating: p.overall_rating ?? null,
      reviews: p.reviews ?? null,
      offers: (p.prices || []).slice(0, 5).map(o => ({
        source: o.source, rate: o.rate_per_night?.extracted_lowest ?? null, freeCancel: !!o.free_cancellation
      }))
    }));
    rateCache.set(cacheKey, { ts: Date.now(), properties });
    res.json({ properties });
  } catch (e) {
    res.status(502).json({ error: 'Upstream error', detail: String(e.message).split(key).join('***') });
  }
});

// ── Config (exposes non-secret browser keys) ────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({ googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || '' });
});

// ── Google Geocoding ────────────────────────────────────────────────────────
app.get('/api/geocode', async (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY || '';
  if (!key) return res.status(503).json({ error: 'GOOGLE_MAPS_API_KEY not configured' });
  const address = req.query.q || '';
  try {
    const r = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`
    );
    const data = await r.json();
    if (data.results && data.results[0]) {
      const loc = data.results[0].geometry.location;
      return res.json({ lat: loc.lat, lng: loc.lng });
    }
    res.json({});
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LuxeStay server running on port ${PORT}`));
