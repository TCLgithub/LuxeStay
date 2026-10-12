const express = require('express');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const app = express();
app.set('trust proxy', 1);   // Render sits behind a proxy: needed for the real client IP and https URLs

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Access control ──────────────────────────────────────────────────────────
// ACCESS_CODE  : code you give friends; every /api call that spends money needs it (header x-access-code)
// OWNER_CODE   : optional second code for you, exempt from the daily search limit
// DAILY_SEARCH_LIMIT : searches per IP per day for ACCESS_CODE holders (default 20)
// With neither code set the app stays open exactly as before.
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const OWNER_CODE = process.env.OWNER_CODE || '';
const DAILY_SEARCH_LIMIT = parseInt(process.env.DAILY_SEARCH_LIMIT) || 20;
const sha = v => crypto.createHash('sha256').update(String(v)).digest();
const same = (a, b) => !!b && crypto.timingSafeEqual(sha(a), sha(b));
const codeOf = req => String(req.get('x-access-code') || '');
const isOwner = req => !!OWNER_CODE && same(codeOf(req), OWNER_CODE);
const accessEnabled = !!(ACCESS_CODE || OWNER_CODE);
const authorized = req => !accessEnabled || (ACCESS_CODE && same(codeOf(req), ACCESS_CODE)) || isOwner(req);

app.use('/api', (req, res, next) => {
  const open =
    (req.method === 'GET' && (req.path === '/config' || /^\/share\/[A-Za-z0-9_-]{6,64}$/.test(req.path))) ||
    (req.method === 'POST' && req.path === '/auth');
  if (open || authorized(req)) return next();
  res.status(401).json({ error: 'access code required' });
});

const authTries = new Map();
function tooManyTries(ip) {
  const now = Date.now(), e = authTries.get(ip) || { n: 0, t: now };
  if (now - e.t > 10 * 60 * 1000) { e.n = 0; e.t = now; }
  e.n++; authTries.set(ip, e);
  return e.n > 10;   // 10 wrong guesses per 10 minutes per IP
}

app.post('/api/auth', (req, res) => {
  if (!accessEnabled) return res.json({ ok: true, open: true });
  if (tooManyTries(req.ip)) return res.status(429).json({ error: 'too many attempts, try again later' });
  const code = String(req.body?.code || '');
  const ok = (ACCESS_CODE && same(code, ACCESS_CODE)) || (OWNER_CODE && same(code, OWNER_CODE));
  if (!ok) return res.status(401).json({ error: 'wrong code' });
  res.json({ ok: true, owner: !!(OWNER_CODE && same(code, OWNER_CODE)) });
});

// Each search calls this once: counts it against the caller's daily allowance
const searchCounts = new Map();
app.post('/api/search-start', (req, res) => {
  if (!ACCESS_CODE || isOwner(req)) return res.json({ ok: true, unlimited: true });
  const day = new Date().toISOString().slice(0, 10);
  for (const k of searchCounts.keys()) if (!k.endsWith('|' + day)) searchCounts.delete(k);
  const key = `${req.ip}|${day}`, n = (searchCounts.get(key) || 0) + 1;
  if (n > DAILY_SEARCH_LIMIT) return res.status(429).json({ error: `Daily search limit (${DAILY_SEARCH_LIMIT}) reached. Try again tomorrow.` });
  searchCounts.set(key, n);
  res.json({ ok: true, remaining: DAILY_SEARCH_LIMIT - n });
});

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
// Each result page (20 hotels, 1 credit) is cached separately for 6h, so asking for
// more pages later only pays for the new ones.
const pageCache = new Map();
const RATE_TTL_MS = 6 * 60 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;   // an empty room list is usually a glitch, so don't pin it for hours
const MAX_LIST_PAGES = 5;

app.post('/api/hotel-rates', async (req, res) => {
  const key = process.env.SERPAPI_KEY || '';
  if (!key) return res.status(503).json({ error: 'SERPAPI_KEY not configured' });

  const { q, checkIn, checkOut, currency = 'USD', adults = 2 } = req.body || {};
  const pages = Math.min(Math.max(parseInt(req.body?.pages) || 2, 1), MAX_LIST_PAGES);
  const dateOk = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  if (typeof q !== 'string' || !q || q.length > 200 || !dateOk(checkIn) || !dateOk(checkOut)) {
    return res.status(400).json({ error: 'q, checkIn and checkOut (YYYY-MM-DD) are required' });
  }
  const cur = String(currency).toUpperCase().slice(0, 3);
  const nAdults = Math.min(Math.max(parseInt(adults) || 2, 1), 8);
  const base = [q.toLowerCase(), checkIn, checkOut, cur, nAdults].join('|');

  try {
    let token = null, properties = [], fetchedPages = 0;
    for (let i = 0; i < pages; i++) {
      let page = pageCache.get(base + '|' + i);
      if (!page || Date.now() - page.ts > RATE_TTL_MS) {
        if (i > 0 && !token) break;               // previous page had no next-page token: no more results
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
        page = {
          ts: Date.now(),
          next: data.serpapi_pagination?.next_page_token || null,
          properties: (data.properties || []).filter(p => p.name).map(p => ({
            name: p.name,
            lat: p.gps_coordinates?.latitude ?? null,
            lng: p.gps_coordinates?.longitude ?? null,
            rate: p.rate_per_night?.extracted_lowest ?? null,
            rateBeforeTax: p.rate_per_night?.extracted_before_taxes_fees ?? null,
            totalRate: p.total_rate?.extracted_lowest ?? null,
            rating: p.overall_rating ?? null,
            reviews: p.reviews ?? null,
            locationRating: p.location_rating ?? null,
            token: p.property_token || null,
            offers: (p.prices || []).slice(0, 5).map(o => ({
              source: o.source, rate: o.rate_per_night?.extracted_lowest ?? null, freeCancel: !!o.free_cancellation
            }))
          }))
        };
        pageCache.set(base + '|' + i, page);
      }
      properties.push(...page.properties);
      fetchedPages++;
      token = page.next;
      if (!token) break;
    }
    res.json({ properties, pages: fetchedPages });
  } catch (e) {
    res.status(502).json({ error: 'Upstream error', detail: String(e.message).split(key).join('***') });
  }
});

// Flatten SerpApi featured_prices (source → room → rate plan) into one list of plans
function flattenPlans(data) {
  const plans = [];
  for (const src of data.featured_prices || []) {
    for (const room of src.rooms || []) {
      const rates = Array.isArray(room.rates) && room.rates.length ? room.rates : [room];
      for (const rt of rates) {
        plans.push({
          source: src.source, official: !!src.official, room: room.name,
          breakfast: !!rt.breakfast_included,
          freeCancel: !!rt.free_cancellation, freeCancelUntil: rt.free_cancellation_until_date || null,
          perNight: rt.rate_per_night?.extracted_lowest ?? null,
          perNightPreTax: rt.rate_per_night?.extracted_before_taxes_fees ?? null,
          total: rt.total_rate?.extracted_lowest ?? null,
          totalPreTax: rt.total_rate?.extracted_before_taxes_fees ?? null,
          beds: (rt.beds || room.beds || []).map(b => `${b.count || 1} ${b.type}`).join(', ') || null
        });
      }
    }
  }
  return plans.filter(p => p.room && (p.total > 0 || p.totalPreTax > 0 || p.perNight > 0));
}

// Ratings/review counts that Google shows from other sites (Trip.com, Tripadvisor): a popularity signal that
// Chinese-market hotels have far more of than Google reviews
function compactOtherReviews(data) {
  return (data.other_reviews || []).map(o => ({
    source: o.source, rating: o.source_rating?.score ?? null, max: o.source_rating?.max_score ?? 5, reviews: o.reviews ?? null
  })).filter(o => o.source && o.reviews > 0);
}

// Flat per-site offers (SerpApi 'prices'): no room types, but live prices — used when featured_prices is empty
function flattenPrices(data) {
  return (data.prices || []).map(o => ({
    source: o.source, official: !!o.official,
    perNight: o.rate_per_night?.extracted_lowest ?? null, perNightPreTax: o.rate_per_night?.extracted_before_taxes_fees ?? null,
    total: o.total_rate?.extracted_lowest ?? null, totalPreTax: o.total_rate?.extracted_before_taxes_fees ?? null,
    freeCancel: !!o.free_cancellation, freeCancelUntil: o.free_cancellation_until_date || null
  })).filter(p => p.total > 0 || p.totalPreTax > 0 || p.perNight > 0);
}

// ── Room-level rates for one hotel (SerpApi Google Hotels property details) ─
// 1 SerpApi credit per call; cached 6h per property/dates/currency.
const roomCache = new Map();

app.post('/api/hotel-rooms', async (req, res) => {
  const key = process.env.SERPAPI_KEY || '';
  if (!key) return res.status(503).json({ error: 'SERPAPI_KEY not configured' });

  const { token, checkIn, checkOut, currency = 'USD', adults = 2, fresh = false } = req.body || {};
  const dateOk = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  if (typeof token !== 'string' || !token || token.length > 400 || !dateOk(checkIn) || !dateOk(checkOut)) {
    return res.status(400).json({ error: 'token, checkIn and checkOut (YYYY-MM-DD) are required' });
  }
  const cur = String(currency).toUpperCase().slice(0, 3);
  const nAdults = Math.min(Math.max(parseInt(adults) || 2, 1), 8);

  const cacheKey = [token, checkIn, checkOut, cur, nAdults].join('|');
  const hit = roomCache.get(cacheKey);
  if (!fresh && hit && Date.now() - hit.ts < (hit.data.plans.length || hit.data.prices?.length ? RATE_TTL_MS : EMPTY_TTL_MS)) return res.json({ ...hit.data, cached: true });

  try {
    const params = new URLSearchParams({
      engine: 'google_hotels', property_token: token, q: 'hotel', check_in_date: checkIn, check_out_date: checkOut,
      adults: String(nAdults), currency: cur, hl: 'en', api_key: key
    });
    const r = await fetch('https://serpapi.com/search.json?' + params);
    const data = await r.json();
    if (!r.ok || data.error) {
      return res.status(502).json({ error: 'SerpApi error', detail: String(data.error || r.status).split(key).join('***').slice(0, 200) });
    }
    const plans = flattenPlans(data);
    const out = {
      name: data.name || null,
      hotelClass: data.extracted_hotel_class ?? null,
      locationRating: data.location_rating ?? null,
      plans,
      prices: plans.length ? [] : flattenPrices(data),   // only needed when there are no room-level plans
      otherReviews: compactOtherReviews(data)
    };
    roomCache.set(cacheKey, { ts: Date.now(), data: out });
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: 'Upstream error', detail: String(e.message).split(key).join('***') });
  }
});

// ── Look up one named hotel (for hotels missing from the city-wide result list) ──
// 1 SerpApi credit. If Google resolves the name straight to the property page it also
// carries the room rates, so no second credit is needed. Cached 6h.
const findCache = new Map();
const _normName = s => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\b(hotel|the|resort|and|by)\b/g, ' ').replace(/\s+/g, ' ').trim();
const _sameName = (a, b) => {
  const x = _normName(a), y = _normName(b);
  return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 6 && (x.includes(y) || y.includes(x))));
};
const _km = (la1, lo1, la2, lo2) => {
  const R = 6371, d = Math.PI / 180, dLa = (la2 - la1) * d, dLo = (lo2 - lo1) * d;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * d) * Math.cos(la2 * d) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

app.post('/api/hotel-find', async (req, res) => {
  const key = process.env.SERPAPI_KEY || '';
  if (!key) return res.status(503).json({ error: 'SERPAPI_KEY not configured' });

  const { name, city, checkIn, checkOut, currency = 'USD', adults = 2, lat, lng } = req.body || {};
  const dateOk = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  if (typeof name !== 'string' || !name || name.length > 120 || typeof city !== 'string' || city.length > 80 || !dateOk(checkIn) || !dateOk(checkOut)) {
    return res.status(400).json({ error: 'name, city, checkIn and checkOut (YYYY-MM-DD) are required' });
  }
  const cur = String(currency).toUpperCase().slice(0, 3);
  const nAdults = Math.min(Math.max(parseInt(adults) || 2, 1), 8);
  const cacheKey = [name.toLowerCase(), city.toLowerCase(), checkIn, checkOut, cur, nAdults].join('|');
  const hit = findCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < RATE_TTL_MS) return res.json({ ...hit.data, cached: true });

  const finish = out => { findCache.set(cacheKey, { ts: Date.now(), data: out }); return res.json(out); };
  try {
    const params = new URLSearchParams({
      engine: 'google_hotels', q: `${name} ${city}`, check_in_date: checkIn, check_out_date: checkOut,
      adults: String(nAdults), currency: cur, hl: 'en', api_key: key
    });
    const r = await fetch('https://serpapi.com/search.json?' + params);
    const data = await r.json();
    if (data.error) {
      if (/hasn.t returned any results|no results/i.test(String(data.error))) return finish({ found: false });
      return res.status(502).json({ error: 'SerpApi error', detail: String(data.error).split(key).join('***').slice(0, 200) });
    }
    if (!r.ok) return res.status(502).json({ error: 'SerpApi error', detail: `HTTP ${r.status}` });

    // Only accept the same hotel: matching name, or (nearly) the same coordinates
    const matches = p => _sameName(p.name, name) ||
      (typeof lat === 'number' && typeof lng === 'number' && p.gps_coordinates &&
       _km(lat, lng, p.gps_coordinates.latitude, p.gps_coordinates.longitude) < 0.15);
    const toCand = p => ({
      name: p.name, token: p.property_token || null,
      lat: p.gps_coordinates?.latitude ?? null, lng: p.gps_coordinates?.longitude ?? null,
      rate: p.rate_per_night?.extracted_lowest ?? null, rateBeforeTax: p.rate_per_night?.extracted_before_taxes_fees ?? null,
      totalRate: p.total_rate?.extracted_lowest ?? null, locationRating: p.location_rating ?? null,
      rating: p.overall_rating ?? null, reviews: p.reviews ?? null
    });

    let cand = null, plans = null, prices = null, otherReviews = null, shape = null;
    if (Array.isArray(data.properties)) {                       // a result list: take the matching entry
      const m = data.properties.find(matches);
      if (m) { cand = toCand(m); shape = 'list'; }
    }
    if (!cand && data.name && (data.property_token || data.featured_prices) && matches(data)) {   // resolved straight to the property
      cand = toCand(data); plans = flattenPlans(data); shape = 'property'; otherReviews = compactOtherReviews(data);
      if (!plans.length) prices = flattenPrices(data);
    }
    if (!cand) return finish({ found: false });
    finish({ found: true, shape, ...cand, ...(plans && plans.length ? { plans } : {}), ...(prices && prices.length ? { prices } : {}), ...(otherReviews && otherReviews.length ? { otherReviews } : {}) });
  } catch (e) {
    res.status(502).json({ error: 'Upstream error', detail: String(e.message).split(key).join('***') });
  }
});

// ── Config (exposes non-secret browser keys) ────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({ googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || '', accessRequired: accessEnabled, shareDurable: !!process.env.GITHUB_TOKEN });
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

// ── Share links: read-only snapshots of a result set ────────────────────────
// Durable storage: a secret GitHub Gist when GITHUB_TOKEN is set (classic token with the "gist" scope).
// Otherwise files on local disk, which Render's free tier loses whenever the server sleeps or redeploys.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const SHARE_DIR = process.env.SHARE_DIR || path.join(__dirname, 'data', 'shares');
const SHARE_DESC = 'LuxeStay shared results';
const SHARE_FILE = 'luxestay-share.json';
const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const gh = (url, opts = {}) => fetch('https://api.github.com' + url, {
  ...opts,
  headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'LuxeStay',
             'X-GitHub-Api-Version': '2022-11-28', 'content-type': 'application/json', ...(opts.headers || {}) }
});

// Strip angle brackets from every string so a shared snapshot can't carry markup into the viewer's page
function cleanDeep(v, depth = 0) {
  if (depth > 14) return null;
  if (typeof v === 'string') return v.replace(/</g, '‹').replace(/>/g, '›').slice(0, 4000);
  if (Array.isArray(v)) return v.slice(0, 500).map(x => cleanDeep(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v).slice(0, 300)) o[k.slice(0, 60)] = cleanDeep(x, depth + 1);
    return o;
  }
  return typeof v === 'number' || typeof v === 'boolean' ? v : null;
}
const pack = obj => zlib.gzipSync(JSON.stringify(obj)).toString('base64');
const unpack = str => JSON.parse(zlib.gunzipSync(Buffer.from(str, 'base64')).toString('utf8'));

async function saveShare(obj) {
  const packed = pack(obj);
  if (GITHUB_TOKEN) {
    const r = await gh('/gists', { method: 'POST', body: JSON.stringify({ description: SHARE_DESC, public: false, files: { [SHARE_FILE]: { content: packed } } }) });
    const d = await r.json();
    if (!r.ok) throw new Error(`GitHub: ${d.message || r.status}`);
    return d.id;
  }
  fs.mkdirSync(SHARE_DIR, { recursive: true });
  for (const f of fs.readdirSync(SHARE_DIR)) {   // drop expired files
    try { if (Date.now() - fs.statSync(path.join(SHARE_DIR, f)).mtimeMs > SHARE_TTL_MS) fs.unlinkSync(path.join(SHARE_DIR, f)); } catch {}
  }
  const id = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(path.join(SHARE_DIR, id + '.json.gz.b64'), packed);
  return id;
}

async function loadShare(id) {
  if (GITHUB_TOKEN && /^[0-9a-f]{20,40}$/.test(id)) {
    const r = await gh('/gists/' + id);
    if (!r.ok) return null;
    const d = await r.json();
    const f = d.files?.[SHARE_FILE];
    if (!f || d.description !== SHARE_DESC) return null;   // only ever serve our own snapshots, never arbitrary gists
    const text = f.truncated ? await (await fetch(f.raw_url)).text() : f.content;
    return unpack(text);
  }
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return null;
  const file = path.join(SHARE_DIR, id + '.json.gz.b64');
  if (!fs.existsSync(file) || Date.now() - fs.statSync(file).mtimeMs > SHARE_TTL_MS) return null;
  return unpack(fs.readFileSync(file, 'utf8'));
}

app.post('/api/share', async (req, res) => {
  const snap = req.body?.snapshot;
  if (!snap || !Array.isArray(snap.results) || !snap.results.length || snap.results.length > 60) {
    return res.status(400).json({ error: 'snapshot with 1-60 results required' });
  }
  try {
    const clean = cleanDeep({ v: 1, createdAt: new Date().toISOString(), title: String(req.body.title || '').slice(0, 120), snapshot: snap });
    const id = await saveShare(clean);
    res.json({ id, url: `${req.protocol}://${req.get('host')}/s/${id}`, durable: !!GITHUB_TOKEN });
  } catch (e) {
    res.status(502).json({ error: 'Could not store the share', detail: String(e.message).split(GITHUB_TOKEN || '\u0000').join('***').slice(0, 200) });
  }
});

app.get('/api/share/:id', async (req, res) => {
  try {
    const data = await loadShare(req.params.id);
    if (!data) return res.status(404).json({ error: 'This share link was not found or has expired' });
    res.set('Cache-Control', 'public, max-age=300').json(data);
  } catch (e) { res.status(502).json({ error: 'Could not load the share' }); }
});

// Shared results page: the same app in read-only mode
app.get('/s/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LuxeStay server running on port ${PORT}`));
