// ════════════════════════════════════════════════════════════════════════════
//  PLOIKONG — Search Handler
//  File: src/handlers/search.js
//
//  ROUTES HANDLED:
//    PUBLIC:
//      GET  /v1/search                — full-text + filter search
//
//    PROTECTED (member JWT required):
//      POST   /v1/search/save         — save search with alert
//      GET    /v1/search/saved        — my saved searches
//      DELETE /v1/search/saved/:id    — delete saved search
//      PUT    /v1/search/saved/:id/alert — toggle alert on/off
//
//  SEARCH ARCHITECTURE:
//    D1 (SQLite) has no full-text search index built here yet.
//    We use LIKE queries on title + story + tags + origin + provenance.
//    This is correct for Phase 1 (under 1000 listings).
//    When listings reach ~5000, replace with Cloudflare Vectorize or
//    a dedicated search Worker with keyword index table.
//
//  SAVED SEARCH ALERTS:
//    Cron job (every 6h) scans new listings against saved_searches.
//    Match logic: same query + category/price filters applied.
//    On match: INSERT into notification_queue, update last_alerted.
// ════════════════════════════════════════════════════════════════════════════

const VALID_CATEGORIES   = ['knives', 'vintage-tools', 'plants', 'dolls', 'books', 'other'];
const VALID_CONDITIONS   = ['mint', 'excellent', 'good', 'fair', 'poor'];
const VALID_SELLING_TYPES = ['fixed', 'auction', 'offer', 'buy_now'];

// ════════════════════════════════════════════════════════════════════════════
//  GET /v1/search
//  Query params:
//    q          — free text (searches title, story, tags, origin)
//    category   — filter by category
//    condition  — filter by condition
//    type       — selling_type filter
//    min        — minimum price in satang
//    max        — maximum price in satang
//    origin     — origin country/region (partial match)
//    sort       — newest | price_asc | price_desc | most_watched
//    limit      — default 24, max 48
//    offset     — default 0
// ════════════════════════════════════════════════════════════════════════════
export async function handleSearch(request, env) {
    const url    = new URL(request.url);
    const params = url.searchParams;

    const q           = params.get('q')?.trim() || '';
    const category    = params.get('category');
    const condition   = params.get('condition');
    const sellingType = params.get('type');
    const origin      = params.get('origin')?.trim();
    const sort        = params.get('sort') || 'newest';
    const limit       = Math.min(parseInt(params.get('limit')  || '24'), 48);
    const offset      = Math.max(parseInt(params.get('offset') || '0'),  0);
    const minPrice    = parseInt(params.get('min') || '0');
    const maxPrice    = parseInt(params.get('max') || '0');

    // Build WHERE clause
    const conditions = ["l.status = 'active'"];
    const bindings   = [];

    // Free text — searches title, story, tags, origin, provenance
    if (q) {
        const like = `%${q}%`;
        conditions.push(`(
            l.title      LIKE ? OR
            l.title_th   LIKE ? OR
            l.story      LIKE ? OR
            l.tags       LIKE ? OR
            l.origin     LIKE ? OR
            l.provenance LIKE ? OR
            l.description LIKE ?
        )`);
        bindings.push(like, like, like, like, like, like, like);
    }

    if (category && VALID_CATEGORIES.includes(category)) {
        conditions.push('l.category = ?');
        bindings.push(category);
    }
    if (condition && VALID_CONDITIONS.includes(condition)) {
        conditions.push('l.condition = ?');
        bindings.push(condition);
    }
    if (sellingType && VALID_SELLING_TYPES.includes(sellingType)) {
        conditions.push('l.selling_type = ?');
        bindings.push(sellingType);
    }
    if (minPrice > 0) {
        conditions.push('COALESCE(l.price, l.auction_start, l.buy_now_price) >= ?');
        bindings.push(minPrice);
    }
    if (maxPrice > 0) {
        conditions.push('COALESCE(l.price, l.auction_start, l.buy_now_price) <= ?');
        bindings.push(maxPrice);
    }
    if (origin) {
        conditions.push('l.origin LIKE ?');
        bindings.push(`%${origin}%`);
    }

    const whereClause = conditions.join(' AND ');

    // Sort order
    const orderClause = {
        newest:       'l.created_at DESC',
        price_asc:    'COALESCE(l.price, l.auction_start, l.buy_now_price) ASC NULLS LAST',
        price_desc:   'COALESCE(l.price, l.auction_start, l.buy_now_price) DESC NULLS LAST',
        most_watched: 'l.watchers DESC, l.created_at DESC',
    }[sort] || 'l.created_at DESC';

    try {
        const rows = await env.DB.prepare(`
            SELECT
                l.id, l.title, l.title_th, l.slug, l.category, l.condition,
                l.selling_type, l.price, l.auction_start, l.auction_end,
                l.buy_now_price, l.primary_image, l.views, l.watchers,
                l.featured, l.created_at, l.broker_id, l.origin,
                CASE WHEN l.broker_id IS NOT NULL THEN 'Private Collection'
                     ELSE m.name END AS seller_display_name,
                CASE WHEN l.broker_id IS NOT NULL THEN NULL
                     ELSE m.username END AS seller_username,
                m.seller_rating,
                CASE WHEN l.broker_id IS NOT NULL THEN bm.name
                     ELSE NULL END AS broker_name,
                (SELECT MAX(b.amount) FROM bids b
                 WHERE b.listing_id = l.id AND b.status = 'active') AS highest_bid,
                (SELECT COUNT(*) FROM bids b
                 WHERE b.listing_id = l.id AND b.status IN ('active','won')) AS bid_count
            FROM listings l
            JOIN members m ON m.id = l.seller_id
            LEFT JOIN members bm ON bm.id = l.broker_id
            WHERE ${whereClause}
            ORDER BY
                l.featured DESC,
                CASE WHEN l.promoted_until > strftime('%s','now') THEN 1 ELSE 0 END DESC,
                ${orderClause}
            LIMIT ? OFFSET ?
        `).bind(...bindings, limit, offset).all();

        const total = await env.DB.prepare(
            `SELECT COUNT(*) AS count FROM listings l WHERE ${whereClause}`
        ).bind(...bindings).first();

        return Response.json({
            query:    q,
            filters:  { category, condition, sellingType, minPrice, maxPrice, origin, sort },
            results:  rows.results.map(formatSearchResult),
            pagination: {
                total:    total?.count ?? 0,
                limit,
                offset,
                has_more: offset + limit < (total?.count ?? 0),
            }
        });

    } catch (err) {
        console.error('[search] handleSearch error:', err);
        return Response.json({ error: 'Search failed' }, { status: 500 });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  POST /v1/search/save — save search with optional alert
//  Body: { query, filters: { category, condition, type, min, max, origin }, alert_enabled }
// ════════════════════════════════════════════════════════════════════════════
export async function handleSaveSearch(request, env, memberId) {
    let body;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const query   = body.query?.trim() || '';
    const filters = sanitizeFilters(body.filters || {});
    const alertEnabled = body.alert_enabled !== false ? 1 : 0;  // default on

    // Require at least a query or one filter
    if (!query && Object.keys(filters).length === 0) {
        return Response.json({ error: 'Provide at least a search query or one filter' }, { status: 400 });
    }

    // Prevent duplicate saved searches for the same member
    const existing = await env.DB.prepare(`
        SELECT id FROM saved_searches
        WHERE member_id = ? AND query = ? AND filters = ?
    `).bind(memberId, query, JSON.stringify(filters)).first();

    if (existing) {
        return Response.json({ error: 'This search is already saved', id: existing.id }, { status: 409 });
    }

    // Limit: max 20 saved searches per member
    const count = await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM saved_searches WHERE member_id = ?`
    ).bind(memberId).first();

    if ((count?.count ?? 0) >= 20) {
        return Response.json(
            { error: 'Maximum 20 saved searches allowed. Delete one to save another.' },
            { status: 400 }
        );
    }

    try {
        const result = await env.DB.prepare(`
            INSERT INTO saved_searches (member_id, query, filters, alert_enabled, created_at)
            VALUES (?, ?, ?, ?, ?)
        `).bind(
            memberId,
            query,
            JSON.stringify(filters),
            alertEnabled,
            Math.floor(Date.now() / 1000)
        ).run();

        return Response.json({
            success: true,
            saved_search: {
                id:            result.meta?.last_row_id,
                query,
                filters,
                alert_enabled: !!alertEnabled,
            }
        }, { status: 201 });

    } catch (err) {
        console.error('[search] handleSaveSearch error:', err);
        return Response.json({ error: 'Failed to save search' }, { status: 500 });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  GET /v1/search/saved — my saved searches
// ════════════════════════════════════════════════════════════════════════════
export async function handleGetSavedSearches(env, memberId) {
    try {
        const rows = await env.DB.prepare(`
            SELECT id, query, filters, alert_enabled, last_alerted, created_at
            FROM saved_searches
            WHERE member_id = ?
            ORDER BY created_at DESC
        `).bind(memberId).all();

        return Response.json({
            saved_searches: rows.results.map(row => ({
                id:            row.id,
                query:         row.query,
                filters:       safeParseJSON(row.filters, {}),
                alert_enabled: !!row.alert_enabled,
                last_alerted:  row.last_alerted,
                created_at:    row.created_at,
                // Convenience: URL to run this search again
                search_url:    buildSearchURL(row.query, safeParseJSON(row.filters, {})),
            }))
        });

    } catch (err) {
        console.error('[search] handleGetSavedSearches error:', err);
        return Response.json({ error: 'Failed to fetch saved searches' }, { status: 500 });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  DELETE /v1/search/saved/:id — delete a saved search
// ════════════════════════════════════════════════════════════════════════════
export async function handleDeleteSavedSearch(searchId, env, memberId) {
    const search = await env.DB.prepare(
        `SELECT id, member_id FROM saved_searches WHERE id = ?`
    ).bind(searchId).first();

    if (!search) {
        return Response.json({ error: 'Saved search not found' }, { status: 404 });
    }
    if (search.member_id !== memberId) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    try {
        await env.DB.prepare(`DELETE FROM saved_searches WHERE id = ?`).bind(searchId).run();
        return Response.json({ success: true });
    } catch (err) {
        console.error('[search] handleDeleteSavedSearch error:', err);
        return Response.json({ error: 'Failed to delete saved search' }, { status: 500 });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  PUT /v1/search/saved/:id/alert — toggle alert on/off
// ════════════════════════════════════════════════════════════════════════════
export async function handleToggleSavedSearchAlert(searchId, env, memberId) {
    const search = await env.DB.prepare(
        `SELECT id, member_id, alert_enabled FROM saved_searches WHERE id = ?`
    ).bind(searchId).first();

    if (!search) {
        return Response.json({ error: 'Saved search not found' }, { status: 404 });
    }
    if (search.member_id !== memberId) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const newValue = search.alert_enabled ? 0 : 1;  // toggle

    try {
        await env.DB.prepare(
            `UPDATE saved_searches SET alert_enabled = ? WHERE id = ?`
        ).bind(newValue, searchId).run();

        return Response.json({ success: true, alert_enabled: !!newValue });
    } catch (err) {
        console.error('[search] handleToggleSavedSearchAlert error:', err);
        return Response.json({ error: 'Failed to update alert' }, { status: 500 });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  SAVED SEARCH MATCHER — called by cron job (job 4 in index.js)
//  Finds new listings (created in last `windowSeconds`) that match any
//  active saved search. Queues notification emails for matched members.
//
//  Called from: src/handlers/cron.js (replaces the stub in index.js)
// ════════════════════════════════════════════════════════════════════════════
export async function matchSavedSearches(env, now, windowSeconds = 21600) {
    const since = now - windowSeconds;

    // Get all active saved searches with alerts enabled
    const searches = await env.DB.prepare(`
        SELECT ss.id, ss.member_id, ss.query, ss.filters, m.email
        FROM saved_searches ss
        JOIN members m ON m.id = ss.member_id
        WHERE ss.alert_enabled = 1
        AND m.status = 'active'
        AND (ss.last_alerted IS NULL OR ss.last_alerted < ?)
    `).bind(since).all();

    if (!searches.results?.length) return 0;

    // Get new listings in the window
    const newListings = await env.DB.prepare(`
        SELECT id, title, slug, category, condition, price, auction_start,
               buy_now_price, selling_type, primary_image, tags, origin, story
        FROM listings
        WHERE status = 'active' AND created_at >= ?
        LIMIT 200
    `).bind(since).all();

    if (!newListings.results?.length) return 0;

    let notified = 0;

    for (const search of searches.results) {
        const filters  = safeParseJSON(search.filters, {});
        const matched  = newListings.results.filter(l => matchesSearch(l, search.query, filters));

        if (matched.length === 0) continue;

        // Queue one email per member (batch — not one per listing match)
        await env.DB.prepare(`
            INSERT INTO notification_queue
            (member_id, to_email, template, payload, status, created_at)
            VALUES (?, ?, 'saved_search_alert', ?, 'queued', ?)
        `).bind(
            search.member_id,
            search.email,
            JSON.stringify({
                query:        search.query,
                filters,
                match_count:  matched.length,
                top_matches:  matched.slice(0, 3).map(l => ({
                    title:  l.title,
                    slug:   l.slug,
                    price:  l.price || l.auction_start || l.buy_now_price,
                    image:  l.primary_image,
                })),
            }),
            now
        ).run();

        // Update last_alerted
        await env.DB.prepare(
            `UPDATE saved_searches SET last_alerted = ? WHERE id = ?`
        ).bind(now, search.id).run();

        notified++;
    }

    return notified;
}

// ════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════════════════

// Match a listing against a saved search (pure function — no DB)
function matchesSearch(listing, query, filters) {
    // Category filter
    if (filters.category && listing.category !== filters.category) return false;

    // Condition filter
    if (filters.condition && listing.condition !== filters.condition) return false;

    // Selling type filter
    if (filters.type && listing.selling_type !== filters.type) return false;

    // Price filter
    const price = listing.price || listing.auction_start || listing.buy_now_price || 0;
    if (filters.min && price < parseInt(filters.min)) return false;
    if (filters.max && price > parseInt(filters.max)) return false;

    // Origin filter
    if (filters.origin && !listing.origin?.toLowerCase().includes(filters.origin.toLowerCase())) {
        return false;
    }

    // Free text match
    if (query) {
        const q   = query.toLowerCase();
        const hay = [
            listing.title,
            listing.story,
            listing.tags,
            listing.origin,
        ].join(' ').toLowerCase();

        if (!hay.includes(q)) return false;
    }

    return true;
}

// Sanitize filter object — only keep known safe keys
function sanitizeFilters(raw) {
    const clean = {};
    if (raw.category && VALID_CATEGORIES.includes(raw.category)) clean.category = raw.category;
    if (raw.condition && VALID_CONDITIONS.includes(raw.condition)) clean.condition = raw.condition;
    if (raw.type && VALID_SELLING_TYPES.includes(raw.type)) clean.type = raw.type;
    if (raw.min && !isNaN(parseInt(raw.min))) clean.min = parseInt(raw.min);
    if (raw.max && !isNaN(parseInt(raw.max))) clean.max = parseInt(raw.max);
    if (raw.origin && typeof raw.origin === 'string') clean.origin = raw.origin.trim().substring(0, 50);
    return clean;
}

// Build a search URL from saved query + filters
function buildSearchURL(query, filters) {
    const p = new URLSearchParams();
    if (query)           p.set('q',        query);
    if (filters.category) p.set('category', filters.category);
    if (filters.condition) p.set('condition', filters.condition);
    if (filters.type)    p.set('type',     filters.type);
    if (filters.min)     p.set('min',      filters.min);
    if (filters.max)     p.set('max',      filters.max);
    if (filters.origin)  p.set('origin',   filters.origin);
    return `/search?${p.toString()}`;
}

// Format a listing row for search results (minimal fields)
function formatSearchResult(row) {
    return {
        id:                  row.id,
        title:               row.title,
        title_th:            row.title_th,
        slug:                row.slug,
        category:            row.category,
        condition:           row.condition,
        selling_type:        row.selling_type,
        price:               row.price,
        auction_start:       row.auction_start,
        auction_end:         row.auction_end,
        buy_now_price:       row.buy_now_price,
        highest_bid:         row.highest_bid,
        bid_count:           row.bid_count,
        primary_image:       row.primary_image,
        views:               row.views,
        watchers:            row.watchers,
        origin:              row.origin,
        featured:            !!row.featured,
        created_at:          row.created_at,
        is_broker_listing:   !!row.broker_id,
        seller_display_name: row.seller_display_name,
        seller_username:     row.seller_username,
        seller_rating:       row.seller_rating,
        broker_name:         row.broker_name,
    };
}

// Safe JSON parse with fallback
function safeParseJSON(str, fallback) {
    try {
        return JSON.parse(str) ?? fallback;
    } catch {
        return fallback;
    }
}
