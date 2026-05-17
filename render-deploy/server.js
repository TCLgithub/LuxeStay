const express = require('express');
const path = require('path');
const app = express();

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Google Places API ───────────────────────────────────────────────────────
app.post('/api/places', async (req, res) => {
  const key = process.env.GOOGLE_PLACES_API_KEY || '';
  if (!key) return res.status(503).json({ error: 'GOOGLE_PLACES_API_KEY not configured' });

  const { city, maxResults = 15, textQuery: customQuery, nearLat, nearLng, maxKm } = req.body;

  const fieldMask = 'places.id,places.displayName,places.rating,places.userRatingCount,places.priceLevel,places.reviews,places.websiteUri,places.formattedAddress,places.location';
  const fieldMaskNoReviews = 'places.id,places.displayName,places.rating,places.userRatingCount,places.priceLevel,places.websiteUri,places.formattedAddress,places.location';

  // When reference coords available: use locationRestriction (hard boundary) so Places
  // returns hotels within the geographic circle, not just globally popular ones.
  // Without coords: fall back to locationBias on city centre.
  const geoCircle = (nearLat && nearLng)
    ? { circle: { center: { latitude: nearLat, longitude: nearLng }, radius: (maxKm || 20) * 1000 } }
    : undefined;

  async function searchPlaces(textQuery, mask) {
    const body = { textQuery, includedType: 'lodging', maxResultCount: 20, rankPreference: 'RELEVANCE' };
    if (geoCircle) body.locationRestriction = geoCircle;  // hard boundary → geographic diversity
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

  try {
    const query = customQuery || `hotels in ${city}`;
    const places = await searchPlaces(query, fieldMask);
    // Deduplicate by place ID (in case caller sends overlapping queries via two requests)
    const seen = new Set();
    const unique = places.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
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
    const body = { ...req.body, max_tokens: Math.min(req.body.max_tokens || 8000, 8000) };
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
  const model = req.body.model || 'gemini-2.0-flash';
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
  let key, baseUrl;

  if (model.startsWith('deepseek')) {
    key = process.env.DEEPSEEK_API_KEY || '';
    baseUrl = 'https://api.deepseek.com/v1/chat/completions';
  } else if (/llama|mixtral|gemma/.test(model)) {
    key = process.env.GROQ_API_KEY || '';
    baseUrl = 'https://api.groq.com/openai/v1/chat/completions';
  } else {
    key = process.env.OPENAI_API_KEY || '';
    baseUrl = 'https://api.openai.com/v1/chat/completions';
  }

  if (!key) return res.status(503).json({ error: `API key not configured for model: ${req.body.model}` });

  try {
    const body = { ...req.body, max_tokens: Math.min(req.body.max_tokens || 8000, 8000) };
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
