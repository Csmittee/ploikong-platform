// ════════════════════════════════════════════════════════════════════════════
//  PLOIKONG — Offers Handler
//  File: src/handlers/offers.js
//
//  ROUTES HANDLED (all require member JWT):
//    POST /v1/offers              — buyer sends offer to seller
//    POST /v1/offers/:id/respond  — seller accepts, rejects, or counters
//    POST /v1/offers/mass         — seller sends mass offer to all watchers
//    GET  /v1/me/offers           — member's offer inbox (sent + received)
//
//  OFFER TYPES (offers.offer_type):
//    buyer_offer       — buyer initiates offer on a listing
//    seller_counter    — seller counters buyer's offer (creates new offer row)
//    seller_mass_offer — seller sends to all watchers simultaneously
//
//  STATUS FLOW:
//    pending → accepted | rejected | countered | expired | cancelled
//    countered: original offer is marked 'countered', new counter row created
//
//  CONSENT WALL (L064):
//    requireConsent check on all POST routes
//
//  NOTIFICATIONS (L067 — never inline, always queue):
//    New offer:    notify seller
//    Counter:      notify buyer
//    Mass offer:   notify each watcher individually
//    Accept:       notify offer sender → triggers order creation prompt
//    Reject:       notify offer sender
//
//  AMOUNTS: ALL in satang (THB × 100). 10000 = ฿100.
//
//  RULES:
//    - Cannot offer on own listing
//    - Only seller can respond to buyer_offer
//    - Only buyer can respond to seller_counter
//    - Only seller can send mass offer
//    - Listing must be status='active' and selling_type in ('offer','buy_now')
//    - min_offer from listing is enforced
//    - Mass offer: rate-limited to 1 per listing per 24 hours
// ════════════════════════════════════════════════════════════════════════════


// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Read all platform_config rows into a flat object.
 * L061: business rules always from DB, never hardcoded.
 */
async function getPlatformConfig(env) {
    const rows = await env.DB.prepare(
        'SELECT key, value FROM platform_config'
    ).all();
    return Object.fromEntries((rows.results ?? []).map(r => [r.key, r.value]));
}

/**
 * Check pending_consent for transactional routes.
 * L064: returns 403 Response if consent required, null if OK.
 */
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
    return null;
}

/**
 * Queue a notification email — L067: never send inline.
 */
async function queueNotification(env, toEmail, template, payload, memberId = null, staffId = null) {
    await env.DB.prepare(`
        INSERT INTO notification_queue
            (member_id, staff_id, to_email, template, payload, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?)
    `).bind(
        memberId,
        staffId,
        toEmail,
        template,
        JSON.stringify(payload),
        Math.floor(Date.now() / 1000)
    ).run();
}

/**
 * Validate that an offer amount meets listing min_offer.
 */
function validateOfferAmount(amount, listing) {
    if (!amount || typeof amount !== 'number' || amount <= 0) {
        return 'amount must be a positive integer in satang';
    }
    if (listing.min_offer && amount < listing.min_offer) {
        return `Offer amount ฿${(amount/100).toFixed(2)} is below the minimum ฿${(listing.min_offer/100).toFixed(2)}`;
    }
    return null;
}

/**
 * Default offer expiry: 48 hours from now (in Unix seconds).
 */
function defaultExpiresAt(hoursFromNow = 48) {
    return Math.floor(Date.now() / 1000) + (hoursFromNow * 3600);
}


// ════════════════════════════════════════════════════════════════════════════
//  POST /v1/offers
//  Buyer sends an offer to seller on a specific listing.
//
//  Body (JSON):
//    listing_id  {number}  required
//    amount      {number}  required — satang
//    message     {string}  optional
//    expires_at  {number}  optional — Unix timestamp (defaults to +48h)
//
//  Rules:
//    - Listing must be status='active'
//    - Listing selling_type must be 'offer' or 'buy_now'
//    - Buyer cannot offer on their own listing
//    - amount >= listing.min_offer (if set)
//    - No duplicate pending offer from same buyer on same listing
// ════════════════════════════════════════════════════════════════════════════
export async function handleCreateOffer(request, env, memberId) {
    // Consent wall
    const consentBlock = await requireConsent(memberId, env);
    if (consentBlock) return consentBlock;

    let body;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { listing_id, amount, message, expires_at } = body;

    if (!listing_id || typeof listing_id !== 'number') {
        return Response.json({ error: 'listing_id is required' }, { status: 400 });
    }
    if (!amount || typeof amount !== 'number') {
        return Response.json({ error: 'amount is required (satang)' }, { status: 400 });
    }

    // Fetch listing
    const listing = await env.DB.prepare(
        `SELECT id, seller_id, broker_id, title, status, selling_type,
                min_offer, price
         FROM listings WHERE id = ?`
    ).bind(listing_id).first();

    if (!listing) {
        return Response.json({ error: 'Listing not found' }, { status: 404 });
    }
    if (listing.status !== 'active') {
        return Response.json({ error: 'Listing is not active' }, { status: 400 });
    }
    if (!['offer', 'buy_now'].includes(listing.selling_type)) {
        return Response.json({ error: 'This listing does not accept offers' }, { status: 400 });
    }

    // Determine who receives the offer — broker if assigned, else seller
    const toMemberId = listing.broker_id ?? listing.seller_id;

    // Cannot offer on own listing
    if (memberId === listing.seller_id || memberId === listing.broker_id) {
        return Response.json({ error: 'Cannot send offer on your own listing' }, { status: 403 });
    }

    // Amount validation
    const amountErr = validateOfferAmount(amount, listing);
    if (amountErr) return Response.json({ error: amountErr }, { status: 400 });

    // Check for existing pending offer from same buyer
    const existing = await env.DB.prepare(`
        SELECT id FROM offers
        WHERE listing_id = ? AND from_member_id = ? AND status = 'pending'
        LIMIT 1
    `).bind(listing_id, memberId).first();

    if (existing) {
        return Response.json({
            error: 'You already have a pending offer on this listing. Cancel it before sending a new one.',
            existing_offer_id: existing.id
        }, { status: 409 });
    }

    const now        = Math.floor(Date.now() / 1000);
    const expiresAt  = (typeof expires_at === 'number' && expires_at > now)
        ? expires_at
        : defaultExpiresAt(48);

    // Insert offer
    const result = await env.DB.prepare(`
        INSERT INTO offers
            (listing_id, from_member_id, to_member_id, offer_type,
             amount, message, expires_at, status, created_at)
        VALUES (?, ?, ?, 'buyer_offer', ?, ?, ?, 'pending', ?)
    `).bind(
        listing_id,
        memberId,
        toMemberId,
        amount,
        message || null,
        expiresAt,
        now
    ).run();

    const offerId = result.meta?.last_row_id;

    // Notify recipient (seller or broker) — L067
    const recipient = await env.DB.prepare(
        'SELECT email, name FROM members WHERE id = ?'
    ).bind(toMemberId).first();

    if (recipient?.email) {
        await queueNotification(env, recipient.email, 'new_offer', {
            offerId,
            listingId: listing_id,
            listingTitle: listing.title,
            amount,
            message: message || null
        }, toMemberId);
    }

    return Response.json({
        success:    true,
        offer_id:   offerId,
        listing_id,
        amount,
        expires_at: expiresAt,
        status:     'pending',
        message:    'Offer sent successfully'
    }, { status: 201 });
}


// ════════════════════════════════════════════════════════════════════════════
//  POST /v1/offers/:id/respond
//  Seller accepts, rejects, or counters an offer.
//  Buyer can also respond to a seller_counter.
//
//  Body (JSON):
//    action         {string}  required — 'accept' | 'reject' | 'counter'
//    counter_amount {number}  required if action='counter' — satang
//    message        {string}  optional
//    expires_at     {number}  optional for counter — Unix timestamp
// ════════════════════════════════════════════════════════════════════════════
export async function handleRespondOffer(offerId, request, env, memberId) {
    // Consent wall
    const consentBlock = await requireConsent(memberId, env);
    if (consentBlock) return consentBlock;

    let body;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { action, counter_amount, message, expires_at } = body;

    if (!['accept', 'reject', 'counter'].includes(action)) {
        return Response.json({ error: 'action must be accept | reject | counter' }, { status: 400 });
    }

    // Fetch the offer + listing
    const offer = await env.DB.prepare(`
        SELECT o.*, l.seller_id, l.broker_id, l.title, l.status AS listing_status,
               l.min_offer, l.id AS list_id
        FROM offers o
        JOIN listings l ON l.id = o.listing_id
        WHERE o.id = ?
    `).bind(offerId).first();

    if (!offer) {
        return Response.json({ error: 'Offer not found' }, { status: 404 });
    }
    if (offer.status !== 'pending') {
        return Response.json({
            error: `Offer is already ${offer.status} — cannot respond`
        }, { status: 400 });
    }

    // Authorization: who can respond to what?
    //   buyer_offer    → seller or broker responds
    //   seller_counter → original buyer responds
    const responderId = memberId;
    const expectedResponder = offer.offer_type === 'seller_counter'
        ? offer.from_member_id   // buyer who received the counter
        : (offer.broker_id ?? offer.seller_id);  // seller/broker for buyer_offer

    // The 'to_member_id' on the offer IS the expected responder
    if (offer.to_member_id !== responderId) {
        return Response.json({
            error: 'You are not authorized to respond to this offer'
        }, { status: 403 });
    }

    const now = Math.floor(Date.now() / 1000);

    // Get sender email for notification
    const sender = await env.DB.prepare(
        'SELECT email, name FROM members WHERE id = ?'
    ).bind(offer.from_member_id).first();

    if (action === 'accept') {
        // Mark offer accepted
        await env.DB.prepare(`
            UPDATE offers
            SET status='accepted', responded_at=?
            WHERE id=?
        `).bind(now, offerId).run();

        // Notify original sender — they should now create an order
        if (sender?.email) {
            await queueNotification(env, sender.email, 'offer_accepted', {
                offerId,
                listingId: offer.listing_id,
                listingTitle: offer.title,
                amount: offer.amount
            }, offer.from_member_id);
        }

        return Response.json({
            success:  true,
            offer_id: offerId,
            status:   'accepted',
            message:  'Offer accepted. Buyer can now proceed to create an order.',
            amount:   offer.amount,
            next_step: 'POST /v1/orders with source_offer_id=' + offerId
        });
    }

    if (action === 'reject') {
        await env.DB.prepare(`
            UPDATE offers
            SET status='rejected', responded_at=?
            WHERE id=?
        `).bind(now, offerId).run();

        if (sender?.email) {
            await queueNotification(env, sender.email, 'offer_rejected', {
                offerId,
                listingId: offer.listing_id,
                listingTitle: offer.title,
                amount: offer.amount,
                message: message || null
            }, offer.from_member_id);
        }

        return Response.json({
            success:  true,
            offer_id: offerId,
            status:   'rejected'
        });
    }

    // action === 'counter'
    if (!counter_amount || typeof counter_amount !== 'number' || counter_amount <= 0) {
        return Response.json({ error: 'counter_amount is required in satang' }, { status: 400 });
    }
    if (offer.min_offer && counter_amount < offer.min_offer) {
        return Response.json({
            error: `Counter amount below listing minimum ฿${(offer.min_offer/100).toFixed(2)}`
        }, { status: 400 });
    }

    const counterExpiresAt = (typeof expires_at === 'number' && expires_at > now)
        ? expires_at
        : defaultExpiresAt(48);

    // Determine counter offer type and new to/from
    // If seller is countering a buyer_offer: type = seller_counter, to = buyer
    // If buyer is countering a seller_counter: type = buyer_offer, to = seller/broker
    const isSellerCountering = (offer.offer_type === 'buyer_offer');
    const counterType     = isSellerCountering ? 'seller_counter' : 'buyer_offer';
    const counterToId     = offer.from_member_id;  // always reply to who sent the last offer
    const counterFromId   = memberId;

    // Mark the current offer as 'countered'
    await env.DB.prepare(`
        UPDATE offers SET status='countered', responded_at=? WHERE id=?
    `).bind(now, offerId).run();

    // Create the counter offer row
    const counterResult = await env.DB.prepare(`
        INSERT INTO offers
            (listing_id, from_member_id, to_member_id, offer_type,
             amount, message, parent_offer_id, expires_at, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).bind(
        offer.listing_id,
        counterFromId,
        counterToId,
        counterType,
        counter_amount,
        message || null,
        offerId,
        counterExpiresAt,
        now
    ).run();

    const counterOfferId = counterResult.meta?.last_row_id;

    // Notify original sender of the counter
    if (sender?.email) {
        await queueNotification(env, sender.email, 'offer_countered', {
            originalOfferId: offerId,
            counterOfferId,
            listingId: offer.listing_id,
            listingTitle: offer.title,
            originalAmount: offer.amount,
            counterAmount: counter_amount,
            message: message || null
        }, offer.from_member_id);
    }

    return Response.json({
        success:          true,
        original_offer_id: offerId,
        counter_offer_id:  counterOfferId,
        status:            'countered',
        counter_amount,
        expires_at:        counterExpiresAt
    }, { status: 201 });
}


// ════════════════════════════════════════════════════════════════════════════
//  POST /v1/offers/mass
//  Seller (or broker on behalf of seller) sends a discounted offer to all
//  active watchers of a listing simultaneously.
//
//  Body (JSON):
//    listing_id  {number}  required
//    amount      {number}  required — satang (the offer price to all watchers)
//    message     {string}  optional
//    expires_at  {number}  optional — Unix timestamp (defaults to +48h)
//
//  Rules:
//    - Only seller or assigned broker can trigger
//    - Listing must be status='active'
//    - Only one mass offer per listing per 24 hours
//    - Each watcher gets their own offer row (from_member_id=seller, to=each watcher)
//    - amount >= listing.min_offer (if set)
// ════════════════════════════════════════════════════════════════════════════
export async function handleMassOffer(request, env, memberId) {
    // Consent wall
    const consentBlock = await requireConsent(memberId, env);
    if (consentBlock) return consentBlock;

    let body;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { listing_id, amount, message, expires_at } = body;

    if (!listing_id || typeof listing_id !== 'number') {
        return Response.json({ error: 'listing_id is required' }, { status: 400 });
    }
    if (!amount || typeof amount !== 'number' || amount <= 0) {
        return Response.json({ error: 'amount is required (satang)' }, { status: 400 });
    }

    // Fetch listing
    const listing = await env.DB.prepare(
        `SELECT id, seller_id, broker_id, title, status, selling_type, min_offer
         FROM listings WHERE id = ?`
    ).bind(listing_id).first();

    if (!listing) {
        return Response.json({ error: 'Listing not found' }, { status: 404 });
    }
    if (listing.status !== 'active') {
        return Response.json({ error: 'Listing is not active' }, { status: 400 });
    }

    // Only seller or assigned broker can send mass offer
    const isSeller = (memberId === listing.seller_id);
    const isBroker = (listing.broker_id && memberId === listing.broker_id);
    if (!isSeller && !isBroker) {
        return Response.json({
            error: 'Only the seller or assigned broker can send a mass offer'
        }, { status: 403 });
    }

    // Rate limit: max 1 mass offer per listing per 24 hours
    const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
    const recentMass = await env.DB.prepare(`
        SELECT id FROM offers
        WHERE listing_id = ? AND offer_type = 'seller_mass_offer'
        AND created_at > ? LIMIT 1
    `).bind(listing_id, oneDayAgo).first();

    if (recentMass) {
        return Response.json({
            error: 'A mass offer was already sent for this listing in the last 24 hours. Please wait before sending another.'
        }, { status: 429 });
    }

    // Amount validation
    const amountErr = validateOfferAmount(amount, listing);
    if (amountErr) return Response.json({ error: amountErr }, { status: 400 });

    // Fetch all active watchers
    const watchers = await env.DB.prepare(`
        SELECT w.member_id, m.email, m.name
        FROM watchlist w
        JOIN members m ON m.id = w.member_id
        WHERE w.listing_id = ?
        AND m.status = 'active'
        AND w.member_id != ?
    `).bind(listing_id, listing.seller_id).all();

    const watcherList = watchers.results ?? [];

    if (watcherList.length === 0) {
        return Response.json({
            success:       true,
            offers_sent:   0,
            message:       'No active watchers found for this listing.'
        });
    }

    const now        = Math.floor(Date.now() / 1000);
    const expiresAt  = (typeof expires_at === 'number' && expires_at > now)
        ? expires_at
        : defaultExpiresAt(48);

    // Insert one offer row per watcher + queue notification for each
    let sentCount = 0;
    for (const watcher of watcherList) {
        // Skip if watcher already has a pending offer on this listing
        const existing = await env.DB.prepare(`
            SELECT id FROM offers
            WHERE listing_id = ? AND to_member_id = ? AND status = 'pending'
            LIMIT 1
        `).bind(listing_id, watcher.member_id).first();

        if (existing) continue; // don't spam with duplicates

        await env.DB.prepare(`
            INSERT INTO offers
                (listing_id, from_member_id, to_member_id, offer_type,
                 amount, message, expires_at, status, created_at)
            VALUES (?, ?, ?, 'seller_mass_offer', ?, ?, ?, 'pending', ?)
        `).bind(
            listing_id,
            memberId,
            watcher.member_id,
            amount,
            message || null,
            expiresAt,
            now
        ).run();

        // Notify each watcher — L067
        if (watcher.email) {
            await queueNotification(env, watcher.email, 'mass_offer_received', {
                listingId: listing_id,
                listingTitle: listing.title,
                amount,
                message: message || null,
                expiresAt
            }, watcher.member_id);
        }

        sentCount++;
    }

    return Response.json({
        success:        true,
        offers_sent:    sentCount,
        watchers_total: watcherList.length,
        amount,
        expires_at:     expiresAt,
        listing_id,
        message:        `Mass offer sent to ${sentCount} watcher${sentCount !== 1 ? 's' : ''}.`
    }, { status: 201 });
}


// ════════════════════════════════════════════════════════════════════════════
//  GET /v1/me/offers
//  Returns all offers involving the authenticated member:
//    - Offers they sent (from_member_id = me)
//    - Offers they received (to_member_id = me)
//
//  Query params:
//    ?direction=sent|received    (default: both)
//    ?status=pending|accepted|...(default: all)
//    ?page=1                     (default: 1, page size: 20)
// ════════════════════════════════════════════════════════════════════════════
export async function handleGetMyOffers(request, env, memberId) {
    const url       = new URL(request.url);
    const direction = url.searchParams.get('direction') || 'both';
    const status    = url.searchParams.get('status') || null;
    const page      = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const limit     = 20;
    const offset    = (page - 1) * limit;

    // Build WHERE clause
    let conditions = [];
    let params     = [];

    if (direction === 'sent') {
        conditions.push('o.from_member_id = ?');
        params.push(memberId);
    } else if (direction === 'received') {
        conditions.push('o.to_member_id = ?');
        params.push(memberId);
    } else {
        conditions.push('(o.from_member_id = ? OR o.to_member_id = ?)');
        params.push(memberId, memberId);
    }

    if (status) {
        conditions.push('o.status = ?');
        params.push(status);
    }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const rows = await env.DB.prepare(`
        SELECT
            o.id, o.listing_id, o.from_member_id, o.to_member_id,
            o.offer_type, o.amount, o.message, o.parent_offer_id,
            o.expires_at, o.status, o.responded_at, o.created_at,
            l.title        AS listing_title,
            l.primary_image AS listing_image,
            l.slug         AS listing_slug,
            fm.username    AS from_username,
            tm.username    AS to_username
        FROM offers o
        JOIN listings l ON l.id = o.listing_id
        JOIN members fm ON fm.id = o.from_member_id
        JOIN members tm ON tm.id = o.to_member_id
        ${whereClause}
        ORDER BY o.created_at DESC
        LIMIT ? OFFSET ?
    `).bind(...params, limit, offset).all();

    return Response.json({
        offers: rows.results ?? [],
        page,
        page_size: limit,
        has_more: (rows.results?.length ?? 0) === limit
    });
}
