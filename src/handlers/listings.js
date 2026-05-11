// ════════════════════════════════════════════════════════════════════════════
//  PLOIKONG — Listings Handler
//  File: src/handlers/listings.js
//
//  ROUTES HANDLED:
//    PUBLIC (no auth):
//      GET  /v1/listings              — paginated feed with filters
//      GET  /v1/listings/featured     — homepage featured items
//      GET  /v1/listings/hot          — most watched + active bids
//      GET  /v1/listings/category/:cat — category browse
//      GET  /v1/listings/:slug        — single listing detail
//
//    PROTECTED (member JWT required):
//      POST   /v1/listings            — create listing
//      PUT    /v1/listings/:id        — edit my listing
//      DELETE /v1/listings/:id        — remove my listing
//
//  BROKER RULE: When broker_id is set on a listing, the seller's identity
//  is NEVER returned in public responses. Only "Private Collection" + broker info.
//
//  AMOUNTS: All in satang (THB × 100). 10000 = ฿100.
//
//  STATUS FLOW: draft → active → sold | expired | removed
//    - draft:   created but not published (seller hasn't clicked "List Item")
//    - active:  visible to buyers, accepting bids/offers/orders
//    - sold:    order completed, escrow released
//    - expired: auction ended with no winner, or listing timed out
//    - removed: admin removed, or seller deleted — hidden from all views
//
//  PENDING_CONSENT (L064): Required on POST, PUT, DELETE.
//  featured / promoted_until: Set by admin only — sellers cannot set these.
// ════════════════════════════════════════════════════════════════════════════

import { generateUniqueSlug } from '../utils/slugify.js';

// ── Allowed categories (from schema) ─────────────────────────────────────────
const VALID_CATEGORIES = ['knives', 'vintage-tools', 'plants', 'dolls', 'books', 'other'];
const VALID_CONDITIONS = ['mint', 'excellent', 'good', 'fair', 'poor'];
const VALID_SELLING_TYPES = ['fixed', 'auction', 'offer', 'buy_now'];
const VALID_SHIPPING_TYPES = ['seller_ships', 'buyer_arranges', 'meetup'];
const VALID_STATUSES = ['draft', 'active'];   // seller-settable statuses only

// Max images per listing
const MAX_IMAGES = 12;

// ════════════════════════════════════════════════════════════════════════════
//  GET /v1/listings — paginated feed
// ════════════════════════════════════════════════════════════════════════════
export async function handleGetListings(request, env) {
    const url    = new URL(request.url);
    const params = url.searchParams;

    // Pagination
    const limit  = Math.min(parseInt(params.get('limit')  || '24'), 48);
    const offset = Math.max(parseInt(params.get('offset') || '0'),  0);

    // Filters
    const category     = params.get('category');
    const condition    = params.get('condition');
    const sellingType  = params.get('type');
    const minPrice     = parseInt(params.get('min') || '0');
    const maxPrice     = parseInt(params.get('max') || '0');
    const origin       = params.get('origin');
    const featuredOnly = params.get('featured') === '1';

    // Build WHERE clause dynamically
    const conditions = ["l.status = 'active'"];
    const bindings   = [];

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
        conditions.push('l.price >= ?');
        bindings.push(minPrice);
    }
    if (maxPrice > 0) {
        conditions.push('l.price <= ?');
        bindings.push(maxPrice);
    }
    if (origin) {
        conditions.push("l.origin LIKE ?");
        bindings.push(`%${origin}%`);
    }
    if (featuredOnly) {
        conditions.push('l.featured = 1');
    }

    const whereClause = conditions.join(' AND ');

    try {
        // Main query — joins member for seller display name
        const rows = await env.DB.prepare(`
            SELECT
                l.id,
                l.title,
                l.title_th,
                l.slug,
                l.category,
                l.subcategory,
                l.condition,
                l.selling_type,
                l.price,
                l.auction_start,
                l.auction_end,
                l.buy_now_price,
                l.primary_image,
                l.shipping_type,
                l.shipping_cost,
                l.views,
                l.watchers,
                l.featured,
                l.promoted_until,
                l.created_at,
                l.broker_id,
                -- Seller identity: hidden if broker listing
                CASE
                    WHEN l.broker_id IS NOT NULL THEN NULL
                    ELSE m.username
                END AS seller_username,
                CASE
                    WHEN l.broker_id IS NOT NULL THEN 'Private Collection'
                    ELSE m.name
                END AS seller_display_name,
                CASE
                    WHEN l.broker_id IS NOT NULL THEN NULL
                    ELSE m.avatar_url
                END AS seller_avatar,
                CASE
                    WHEN l.broker_id IS NOT NULL THEN m.seller_rating
                    ELSE m.seller_rating
                END AS seller_rating,
                -- Broker display info (when applicable)
                CASE
                    WHEN l.broker_id IS NOT NULL THEN bm.name
                    ELSE NULL
                END AS broker_name,
                CASE
                    WHEN l.broker_id IS NOT NULL THEN bm.username
                    ELSE NULL
                END AS broker_username,
                CASE
                    WHEN l.broker_id IS NOT NULL THEN bm.avatar_url
                    ELSE NULL
                END AS broker_avatar,
                -- Highest bid (for auction listings)
                (SELECT MAX(b.amount) FROM bids b
                 WHERE b.listing_id = l.id AND b.status = 'active') AS highest_bid,
                -- Bid count
                (SELECT COUNT(*) FROM bids b
                 WHERE b.listing_id = l.id AND b.status IN ('active','won')) AS bid_count
            FROM listings l
            JOIN members m ON m.id = l.seller_id
            LEFT JOIN members bm ON bm.id = l.broker_id
            WHERE ${whereClause}
            ORDER BY
                l.featured DESC,
                CASE WHEN l.promoted_until > strftime('%s','now') THEN 1 ELSE 0 END DESC,
                l.created_at DESC
            LIMIT ? OFFSET ?
        `).bind(...bindings, limit, offset).all();

        // Total count for pagination
        const total = await env.DB.prepare(
            `SELECT COUNT(*) AS count FROM listings l WHERE ${whereClause}`
        ).bind(...bindings).first();

        return Response.json({
            listings: rows.results.map(formatListingCard),
            pagination: {
                total:  total?.count ?? 0,
                limit,
                offset,
                has_more: offset + limit < (total?.count ?? 0),
            }
        });

    } catch (err) {
        console.error('[listings] handleGetListings error:', err);
        return Response.json({ error: 'Failed to fetch listings' }, { status: 500 });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  GET /v1/listings/featured
// ════════════════════════════════════════════════════════════════════════════
export async function handleGetFeaturedListings(env) {
    try {
        const rows = await env.DB.prepare(`
            SELECT l.id, l.title, l.title_th, l.slug, l.category, l.condition,
                   l.selling_type, l.price, l.auction_start, l.auction_end,
                   l.primary_image, l.views, l.watchers, l.created_at, l.broker_id,
                   CASE WHEN l.broker_id IS NOT NULL THEN 'Private Collection'
                        ELSE m.name END AS seller_display_name,
                   CASE WHEN l.broker_id IS NOT NULL THEN bm.name
                        ELSE NULL END AS broker_name
            FROM listings l
            JOIN members m ON m.id = l.seller_id
            LEFT JOIN members bm ON bm.id = l.broker_id
            WHERE l.status = 'active' AND l.featured = 1
            ORDER BY l.created_at DESC
            LIMIT 12
        `).all();

        return Response.json({ listings: rows.results.map(formatListingCard) });

    } catch (err) {
        console.error('[listings] handleGetFeaturedListings error:', err);
        return Response.json({ error: 'Failed to fetch featured listings' }, { status: 500 });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  GET /v1/listings/hot — most watched + most bids
// ════════════════════════════════════════════════════════════════════════════
export async function handleGetHotListings(env) {
    try {
        const rows = await env.DB.prepare(`
            SELECT l.id, l.title, l.title_th, l.slug, l.category, l.condition,
                   l.selling_type, l.price, l.auction_start, l.auction_end, l.auction_end,
                   l.primary_image, l.views, l.watchers, l.created_at, l.broker_id,
                   CASE WHEN l.broker_id IS NOT NULL THEN 'Private Collection'
                        ELSE m.name END AS seller_display_name,
                   CASE WHEN l.broker_id IS NOT NULL THEN bm.name
                        ELSE NULL END AS broker_name,
                   (SELECT COUNT(*) FROM bids b WHERE b.listing_id = l.id
                    AND b.status IN ('active','won')) AS bid_count,
                   (SELECT MAX(b.amount) FROM bids b WHERE b.listing_id = l.id
                    AND b.status = 'active') AS highest_bid
            FROM listings l
            JOIN members m ON m.id = l.seller_id
            LEFT JOIN members bm ON bm.id = l.broker_id
            WHERE l.status = 'active'
            ORDER BY (l.watchers * 2 + COALESCE(bid_count, 0) * 3) DESC, l.created_at DESC
            LIMIT 12
        `).all();

        return Response.json({ listings: rows.results.map(formatListingCard) });

    } catch (err) {
        console.error('[listings] handleGetHotListings error:', err);
        return Response.json({ error: 'Failed to fetch hot listings' }, { status: 500 });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  GET /v1/listings/category/:cat
// ════════════════════════════════════════════════════════════════════════════
export async function handleGetListingsByCategory(category, request, env) {
    if (!VALID_CATEGORIES.includes(category)) {
        return Response.json({ error: 'Invalid category' }, { status: 400 });
    }

    const url    = new URL(request.url);
    const limit  = Math.min(parseInt(url.searchParams.get('limit')  || '24'), 48);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0'),  0);

    try {
        const rows = await env.DB.prepare(`
            SELECT l.id, l.title, l.title_th, l.slug, l.category, l.subcategory,
                   l.condition, l.selling_type, l.price, l.auction_start, l.auction_end,
                   l.primary_image, l.views, l.watchers, l.created_at, l.broker_id,
                   CASE WHEN l.broker_id IS NOT NULL THEN 'Private Collection'
                        ELSE m.name END AS seller_display_name,
                   m.seller_rating,
                   CASE WHEN l.broker_id IS NOT NULL THEN bm.name
                        ELSE NULL END AS broker_name
            FROM listings l
            JOIN members m ON m.id = l.seller_id
            LEFT JOIN members bm ON bm.id = l.broker_id
            WHERE l.status = 'active' AND l.category = ?
            ORDER BY l.featured DESC, l.created_at DESC
            LIMIT ? OFFSET ?
        `).bind(category, limit, offset).all();

        const total = await env.DB.prepare(
            `SELECT COUNT(*) AS count FROM listings WHERE status='active' AND category=?`
        ).bind(category).first();

        return Response.json({
            category,
            listings: rows.results.map(formatListingCard),
            pagination: {
                total:    total?.count ?? 0,
                limit,
                offset,
                has_more: offset + limit < (total?.count ?? 0),
            }
        });

    } catch (err) {
        console.error('[listings] handleGetListingsByCategory error:', err);
        return Response.json({ error: 'Failed to fetch category listings' }, { status: 500 });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  GET /v1/listings/:slug — single listing (public)
// ════════════════════════════════════════════════════════════════════════════
export async function handleGetListing(slug, env) {
    try {
        const row = await env.DB.prepare(`
            SELECT
                l.*,
                -- Seller identity: masked if broker listing
                CASE WHEN l.broker_id IS NOT NULL THEN NULL
                     ELSE m.username END AS seller_username,
                CASE WHEN l.broker_id IS NOT NULL THEN 'Private Collection'
                     ELSE m.name END AS seller_display_name,
                CASE WHEN l.broker_id IS NOT NULL THEN NULL
                     ELSE m.avatar_url END AS seller_avatar,
                CASE WHEN l.broker_id IS NOT NULL THEN NULL
                     ELSE m.bio END AS seller_bio,
                m.seller_rating,
                m.total_sales,
                -- Broker info (when applicable)
                CASE WHEN l.broker_id IS NOT NULL THEN bm.username
                     ELSE NULL END AS broker_username,
                CASE WHEN l.broker_id IS NOT NULL THEN bm.name
                     ELSE NULL END AS broker_name,
                CASE WHEN l.broker_id IS NOT NULL THEN bm.avatar_url
                     ELSE NULL END AS broker_avatar,
                CASE WHEN l.broker_id IS NOT NULL THEN bm.bio
                     ELSE NULL END AS broker_bio,
                CASE WHEN l.broker_id IS NOT NULL THEN bm.seller_rating
                     ELSE NULL END AS broker_rating,
                CASE WHEN l.broker_id IS NOT NULL THEN bm.total_sales
                     ELSE NULL END AS broker_total_sales,
                -- Highest bid + bid count for auctions
                (SELECT MAX(b.amount) FROM bids b
                 WHERE b.listing_id = l.id AND b.status = 'active') AS highest_bid,
                (SELECT COUNT(*) FROM bids b
                 WHERE b.listing_id = l.id AND b.status IN ('active','won')) AS bid_count
            FROM listings l
            JOIN members m ON m.id = l.seller_id
            LEFT JOIN members bm ON bm.id = l.broker_id
            WHERE l.slug = ? AND l.status IN ('active','sold')
        `).bind(slug).first();

        if (!row) {
            return Response.json({ error: 'Listing not found' }, { status: 404 });
        }

        // Increment view count — fire and forget
        env.DB.prepare(
            `UPDATE listings SET views = views + 1 WHERE id = ?`
        ).bind(row.id).run().catch(() => {});

        return Response.json({ listing: formatListingDetail(row) });

    } catch (err) {
        console.error('[listings] handleGetListing error:', err);
        return Response.json({ error: 'Failed to fetch listing' }, { status: 500 });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  POST /v1/listings — create listing (auth required)
// ════════════════════════════════════════════════════════════════════════════
export async function handleCreateListing(request, env, memberId) {
    // L064 — consent wall check
    const consentBlock = await requireConsent(memberId, env);
    if (consentBlock) return consentBlock;

    let body;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // Validate required fields
    const validation = validateListingBody(body);
    if (validation.error) {
        return Response.json({ error: validation.error }, { status: 400 });
    }

    // Validate broker_id if provided — must be a verified broker
    if (body.broker_id) {
        const broker = await env.DB.prepare(
            `SELECT id FROM members WHERE id = ? AND role = 'broker' AND status = 'active'`
        ).bind(body.broker_id).first();
        if (!broker) {
            return Response.json({ error: 'Invalid or inactive broker_id' }, { status: 400 });
        }
    }

    // Generate unique slug
    const slug = await generateUniqueSlug(body.title, env.DB);

    const now = Math.floor(Date.now() / 1000);

    // Parse and sanitize images array
    const images = sanitizeImages(body.images);
    const primaryImage = body.primary_image || images[0] || null;

    try {
        const result = await env.DB.prepare(`
            INSERT INTO listings (
                seller_id, broker_id, title, title_th, story, description,
                category, subcategory, condition, year_made, origin, provenance,
                images, primary_image, selling_type,
                price, min_offer, auction_start, auction_reserve,
                auction_end, buy_now_price, offer_expires_at,
                shipping_type, shipping_cost, shipping_providers,
                status, tags, slug, created_at, updated_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?, ?, ?
            )
        `).bind(
            memberId,
            body.broker_id || null,
            body.title.trim(),
            body.title_th?.trim() || null,
            body.story?.trim() || null,
            body.description?.trim() || null,
            body.category,
            body.subcategory?.trim() || null,
            body.condition || null,
            body.year_made?.trim() || null,
            body.origin?.trim() || null,
            body.provenance?.trim() || null,
            JSON.stringify(images),
            primaryImage,
            body.selling_type,
            body.price || null,
            body.min_offer || null,
            body.auction_start || null,
            body.auction_reserve || null,
            body.auction_end || null,
            body.buy_now_price || null,
            body.offer_expires_at || null,
            body.shipping_type || 'seller_ships',
            body.shipping_cost || 0,
            JSON.stringify(body.shipping_providers || []),
            body.status === 'active' ? 'active' : 'draft',  // only draft or active from seller
            JSON.stringify(body.tags || []),
            slug,
            now,
            now
        ).run();

        const listingId = result.meta?.last_row_id;

        return Response.json({
            success: true,
            listing: { id: listingId, slug }
        }, { status: 201 });

    } catch (err) {
        console.error('[listings] handleCreateListing error:', err);
        return Response.json({ error: 'Failed to create listing' }, { status: 500 });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  PUT /v1/listings/:id — edit listing (auth required, owner only)
// ════════════════════════════════════════════════════════════════════════════
export async function handleUpdateListing(listingId, request, env, memberId) {
    // L064 — consent wall check
    const consentBlock = await requireConsent(memberId, env);
    if (consentBlock) return consentBlock;

    // Verify ownership
    const listing = await env.DB.prepare(
        `SELECT id, seller_id, status, slug FROM listings WHERE id = ?`
    ).bind(listingId).first();

    if (!listing) {
        return Response.json({ error: 'Listing not found' }, { status: 404 });
    }
    if (listing.seller_id !== memberId) {
        return Response.json({ error: 'Forbidden — not your listing' }, { status: 403 });
    }
    // Cannot edit sold or removed listings
    if (['sold', 'removed'].includes(listing.status)) {
        return Response.json(
            { error: `Cannot edit a listing with status: ${listing.status}` },
            { status: 400 }
        );
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const now = Math.floor(Date.now() / 1000);

    // Build dynamic UPDATE — only update fields that are provided
    const updates = [];
    const bindings = [];

    const strField = (key, dbCol = key) => {
        if (body[key] !== undefined) {
            updates.push(`${dbCol} = ?`);
            bindings.push(typeof body[key] === 'string' ? body[key].trim() : body[key]);
        }
    };
    const intField = (key, dbCol = key) => {
        if (body[key] !== undefined) {
            updates.push(`${dbCol} = ?`);
            bindings.push(body[key] === null ? null : parseInt(body[key]));
        }
    };

    strField('title');
    strField('title_th');
    strField('story');
    strField('description');
    strField('subcategory');
    strField('condition');
    strField('year_made');
    strField('origin');
    strField('provenance');
    strField('primary_image');
    strField('shipping_type');

    intField('price');
    intField('min_offer');
    intField('auction_start');
    intField('auction_reserve');
    intField('auction_end');
    intField('buy_now_price');
    intField('offer_expires_at');
    intField('shipping_cost');

    // Category — validate
    if (body.category !== undefined) {
        if (!VALID_CATEGORIES.includes(body.category)) {
            return Response.json({ error: 'Invalid category' }, { status: 400 });
        }
        updates.push('category = ?');
        bindings.push(body.category);
    }

    // Selling type — validate
    if (body.selling_type !== undefined) {
        if (!VALID_SELLING_TYPES.includes(body.selling_type)) {
            return Response.json({ error: 'Invalid selling_type' }, { status: 400 });
        }
        updates.push('selling_type = ?');
        bindings.push(body.selling_type);
    }

    // Status — seller can only set draft or active
    if (body.status !== undefined) {
        if (!VALID_STATUSES.includes(body.status)) {
            return Response.json(
                { error: 'Invalid status. Seller may only set: draft, active' },
                { status: 400 }
            );
        }
        updates.push('status = ?');
        bindings.push(body.status);
    }

    // Images — sanitize and update
    if (body.images !== undefined) {
        const images = sanitizeImages(body.images);
        updates.push('images = ?');
        bindings.push(JSON.stringify(images));
    }

    // Tags — JSON array
    if (body.tags !== undefined) {
        updates.push('tags = ?');
        bindings.push(JSON.stringify(Array.isArray(body.tags) ? body.tags : []));
    }

    // Shipping providers — JSON array
    if (body.shipping_providers !== undefined) {
        updates.push('shipping_providers = ?');
        bindings.push(JSON.stringify(Array.isArray(body.shipping_providers) ? body.shipping_providers : []));
    }

    // NOTE: featured / promoted_until are NOT editable by seller
    // They are set by admin only via /v1/admin routes

    if (updates.length === 0) {
        return Response.json({ error: 'No fields to update' }, { status: 400 });
    }

    updates.push('updated_at = ?');
    bindings.push(now);
    bindings.push(listingId);

    try {
        await env.DB.prepare(
            `UPDATE listings SET ${updates.join(', ')} WHERE id = ?`
        ).bind(...bindings).run();

        return Response.json({ success: true, listing: { id: listingId, slug: listing.slug } });

    } catch (err) {
        console.error('[listings] handleUpdateListing error:', err);
        return Response.json({ error: 'Failed to update listing' }, { status: 500 });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  DELETE /v1/listings/:id — remove listing (auth required, owner only)
//  Sets status = 'removed' — never hard deletes (audit trail)
// ════════════════════════════════════════════════════════════════════════════
export async function handleDeleteListing(listingId, env, memberId) {
    // L064 — consent wall check
    const consentBlock = await requireConsent(memberId, env);
    if (consentBlock) return consentBlock;

    const listing = await env.DB.prepare(
        `SELECT id, seller_id, status FROM listings WHERE id = ?`
    ).bind(listingId).first();

    if (!listing) {
        return Response.json({ error: 'Listing not found' }, { status: 404 });
    }
    if (listing.seller_id !== memberId) {
        return Response.json({ error: 'Forbidden — not your listing' }, { status: 403 });
    }
    // Cannot remove a listing with a live order (sold status)
    if (listing.status === 'sold') {
        return Response.json(
            { error: 'Cannot remove a sold listing — order record must be preserved' },
            { status: 400 }
        );
    }

    try {
        await env.DB.prepare(
            `UPDATE listings SET status = 'removed', updated_at = ? WHERE id = ?`
        ).bind(Math.floor(Date.now() / 1000), listingId).run();

        return Response.json({ success: true });

    } catch (err) {
        console.error('[listings] handleDeleteListing error:', err);
        return Response.json({ error: 'Failed to remove listing' }, { status: 500 });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════════════════

// L064 — Consent wall check (reusable across all transactional handlers)
async function requireConsent(memberId, env) {
    const member = await env.DB.prepare(
        'SELECT pending_consent FROM members WHERE id = ?'
    ).bind(memberId).first();

    if (member?.pending_consent === 1) {
        return Response.json({
            error:    'consent_required',
            message:  'Please review and sign the updated Terms of Service to continue.',
            redirect: '/consent'
        }, { status: 403 });
    }
    return null;  // null = OK
}

// Validate required listing fields and types
function validateListingBody(body) {
    if (!body.title?.trim()) {
        return { error: 'title is required' };
    }
    if (!body.category || !VALID_CATEGORIES.includes(body.category)) {
        return { error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` };
    }
    if (!body.selling_type || !VALID_SELLING_TYPES.includes(body.selling_type)) {
        return { error: `selling_type must be one of: ${VALID_SELLING_TYPES.join(', ')}` };
    }
    if (body.condition && !VALID_CONDITIONS.includes(body.condition)) {
        return { error: `condition must be one of: ${VALID_CONDITIONS.join(', ')}` };
    }
    if (body.shipping_type && !VALID_SHIPPING_TYPES.includes(body.shipping_type)) {
        return { error: `shipping_type must be one of: ${VALID_SHIPPING_TYPES.join(', ')}` };
    }
    // Type-specific price validation
    if (body.selling_type === 'fixed' && !body.price) {
        return { error: 'price (in satang) is required for fixed listings' };
    }
    if (body.selling_type === 'auction' && (!body.auction_start || !body.auction_end)) {
        return { error: 'auction_start and auction_end are required for auction listings' };
    }
    if (body.selling_type === 'offer' && !body.min_offer && !body.price) {
        return { error: 'price or min_offer (in satang) is required for offer listings' };
    }
    // Validate auction end is in the future
    if (body.auction_end && body.auction_end <= Math.floor(Date.now() / 1000)) {
        return { error: 'auction_end must be a future timestamp' };
    }
    return {};  // no error
}

// Sanitize images array — max MAX_IMAGES, strings only
function sanitizeImages(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter(url => typeof url === 'string' && url.startsWith('http'))
        .slice(0, MAX_IMAGES);
}

// Format a listing row for list/card display (minimal fields)
function formatListingCard(row) {
    return {
        id:                  row.id,
        title:               row.title,
        title_th:            row.title_th,
        slug:                row.slug,
        category:            row.category,
        subcategory:         row.subcategory,
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
        featured:            !!row.featured,
        promoted_until:      row.promoted_until,
        created_at:          row.created_at,
        is_broker_listing:   !!row.broker_id,
        seller_display_name: row.seller_display_name,
        seller_username:     row.seller_username,
        seller_avatar:       row.seller_avatar,
        seller_rating:       row.seller_rating,
        broker_name:         row.broker_name,
        broker_username:     row.broker_username,
        broker_avatar:       row.broker_avatar,
    };
}

// Format a listing row for detail/single page display (full fields)
function formatListingDetail(row) {
    const base = formatListingCard(row);
    return {
        ...base,
        story:               row.story,
        description:         row.description,
        year_made:           row.year_made,
        origin:              row.origin,
        provenance:          row.provenance,
        images:              safeParseJSON(row.images, []),
        selling_type:        row.selling_type,
        min_offer:           row.min_offer,
        offer_expires_at:    row.offer_expires_at,
        auction_reserve:     undefined,   // NEVER expose reserve price publicly
        shipping_type:       row.shipping_type,
        shipping_cost:       row.shipping_cost,
        shipping_providers:  safeParseJSON(row.shipping_providers, []),
        tags:                safeParseJSON(row.tags, []),
        status:              row.status,
        sold_at:             row.sold_at,
        // Seller detail (masked if broker listing)
        seller_bio:          row.seller_bio,
        seller_total_sales:  row.total_sales,
        // Broker detail
        broker_bio:          row.broker_bio,
        broker_rating:       row.broker_rating,
        broker_total_sales:  row.broker_total_sales,
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
