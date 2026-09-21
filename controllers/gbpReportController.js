const { query } = require('../config/db');

// Google Places Autocomplete — server-side proxy so GOOGLE_PLACES_API_KEY
// never reaches the browser. Requires the "Places API" enabled + billing on
// the Google Cloud project that issued the key.
const PLACES_AUTOCOMPLETE_URL = 'https://maps.googleapis.com/maps/api/place/autocomplete/json';

// GET /api/gbp-leads/search-business?query=... — public, used by the
// "Find your business on Google" field on the landing page.
const searchBusiness = async (req, res) => {
  try {
    const q = String(req.query.query || '').trim();
    if (!q) return res.json({ results: [] });

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Business search is not configured on the server.' });
    }

    const url = `${PLACES_AUTOCOMPLETE_URL}?input=${encodeURIComponent(q)}&types=establishment&key=${apiKey}`;
    const placesRes = await fetch(url);
    const data = await placesRes.json();

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      throw new Error(data.error_message || data.status);
    }

    // "description" is Google's full label, e.g. "Aditya Mall, Sector 62,
    // Noida, Uttar Pradesh, India" — split off the business name, keep the
    // rest as the address line show below it.
    const results = (data.predictions || []).slice(0, 6).map((p) => {
      const [name, ...rest] = p.description.split(',');
      return { place_id: p.place_id, name: name.trim(), address: rest.join(',').trim() };
    });

    res.json({ results });
  } catch (err) {
    console.error('searchBusiness error:', err.message);
    res.status(500).json({ error: 'Search failed. Please try again.' });
  }
};

const DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';
const NEARBY_URL = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';
const DETAILS_FIELDS = 'name,rating,user_ratings_total,formatted_address,formatted_phone_number,website,opening_hours,photos,types,geometry';

// GET /api/gbp-leads/business-report?place_id=... — public. Builds an honest
// profile-completeness checklist and a real nearby-competitor comparison
// using the selected business's actual Google Places data. Deliberately does
// NOT show a search-rank position or map — Google doesn't expose local-pack
// rank through any public API; the tools that claim to are scraping Maps,
// which violates Google's Terms of Service.
const getBusinessReport = async (req, res) => {
  try {
    const placeId = req.query.place_id;
    if (!placeId) return res.status(400).json({ error: 'place_id is required.' });

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Business search is not configured on the server.' });

    const detailsRes = await fetch(`${DETAILS_URL}?place_id=${encodeURIComponent(placeId)}&fields=${DETAILS_FIELDS}&key=${apiKey}`);
    const detailsData = await detailsRes.json();
    if (detailsData.status !== 'OK') throw new Error(detailsData.error_message || detailsData.status);
    const place = detailsData.result;

    // Only fields the public Places API actually exposes — deliberately
    // excludes GBP-only concepts (description, logo, service area, listing
    // attributes, appointment links) that aren't checkable this way. Don't
    // add items here without a real field backing them.
    const realTypes = (place.types || []).filter((t) => !['point_of_interest', 'establishment'].includes(t));
    const issues = [
      { label: 'Title', ok: !!place.name },
      { label: 'Primary category', ok: realTypes.length > 0 },
      { label: 'Additional categories', ok: realTypes.length > 1 },
      { label: 'Address', ok: !!place.formatted_address },
      { label: 'Phone number', ok: !!place.formatted_phone_number },
      { label: 'Business hours', ok: !!place.opening_hours },
      { label: 'Photos', ok: (place.photos || []).length > 0 },
      { label: 'Website', ok: !!place.website },
      { label: '10+ reviews', ok: (place.user_ratings_total || 0) >= 10 },
    ];

    let competitors = [];
    if (place.geometry?.location && (place.types || []).length) {
      const primaryType = place.types.find((t) => !['point_of_interest', 'establishment'].includes(t)) || place.types[0];
      const { lat, lng } = place.geometry.location;
      const nearbyRes = await fetch(`${NEARBY_URL}?location=${lat},${lng}&radius=3000&type=${primaryType}&key=${apiKey}`);
      const nearbyData = await nearbyRes.json();
      if (nearbyData.status === 'OK') {
        competitors = (nearbyData.results || [])
          .filter((r) => r.place_id !== placeId)
          .map((r) => ({ name: r.name, rating: r.rating || null, review_count: r.user_ratings_total || 0 }))
          .sort((a, b) => (b.rating || 0) - (a.rating || 0))
          .slice(0, 5);
      }
    }

    res.json({
      business: {
        name: place.name,
        address: place.formatted_address,
        rating: place.rating || null,
        review_count: place.user_ratings_total || 0,
      },
      issues,
      competitors,
    });
  } catch (err) {
    console.error('getBusinessReport error:', err.message);
    res.status(500).json({ error: 'Could not build the report right now.' });
  }
};

// Matches the step list rendered on the frontend's /gbp-report scanning
// screen. There's still no real Google Business Profile lookup — this just
// gives the "scan" a server-tracked progress state instead of a purely
// client-side timer, so it survives refreshes and multiple tabs agree.
const TOTAL_SCAN_STEPS = 6;
const SCAN_STEP_INTERVAL_MS = 1300;

// Advances scan_step on a timer after insert, one DB write per tick, until
// it reaches the last step and scan_completed flips true. Fire-and-forget —
// nothing awaits this; the frontend polls /status instead.
const runSimulatedScan = (leadId) => {
  let step = 0;
  const interval = setInterval(async () => {
    step += 1;
    const completed = step >= TOTAL_SCAN_STEPS - 1;
    try {
      await query(
        `UPDATE gbp_report_leads SET scan_step = $1, scan_completed = $2 WHERE id = $3`,
        [step, completed, leadId]
      );
    } catch (err) {
      console.error('runSimulatedScan update error:', err.message);
    }
    if (completed) clearInterval(interval);
  }, SCAN_STEP_INTERVAL_MS);
};

// POST /api/gbp-leads — public, no auth. Captures the business name + WhatsApp
// number from the /gbp-report marketing landing page widget.
const submitLead = async (req, res) => {
  try {
    const { business, phone, countryDial } = req.body || {};

    if (!business || typeof business !== 'string' || !business.trim()) {
      return res.status(400).json({ error: 'Business name is required.' });
    }
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 6) {
      return res.status(400).json({ error: 'A valid WhatsApp number is required.' });
    }

    const result = await query(
      `INSERT INTO gbp_report_leads (business, phone, country_dial)
       VALUES ($1, $2, $3)
       RETURNING id, business, phone, country_dial, source, scan_step, scan_completed, created_at`,
      [business.trim(), digits, countryDial || '+91']
    );

    const lead = result.rows[0];
    runSimulatedScan(lead.id);

    res.status(201).json({ lead });
  } catch (err) {
    console.error('submitLead error:', err.message);
    res.status(500).json({ error: 'Failed to submit. Please try again.' });
  }
};

// GET /api/gbp-leads/:id/status — public, polled by the scanning screen.
const getLeadStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(
      `SELECT scan_step, scan_completed FROM gbp_report_leads WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found.' });
    }
    const { scan_step, scan_completed } = result.rows[0];
    res.json({ scan_step, scan_completed, total_steps: TOTAL_SCAN_STEPS });
  } catch (err) {
    console.error('getLeadStatus error:', err.message);
    res.status(500).json({ error: 'Failed to load status.' });
  }
};

// GET /api/gbp-leads — super-admin only, for CurveLead's own team to follow
// up on captured leads.
const listLeads = async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    const [result, countResult] = await Promise.all([
      query(
        `SELECT id, business, phone, country_dial, source, created_at
         FROM gbp_report_leads
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      query('SELECT COUNT(*) FROM gbp_report_leads'),
    ]);

    res.json({
      leads: result.rows,
      total: parseInt(countResult.rows[0].count, 10),
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
    });
  } catch (err) {
    console.error('listLeads error:', err.message);
    res.status(500).json({ error: 'Failed to load leads.' });
  }
};

module.exports = { submitLead, listLeads, getLeadStatus, searchBusiness, getBusinessReport };
