// ════════════════════════════════════════════════════════════════════════════
//  PLOIKONG — Bids Handler
//  File: src/handlers/bids.js
//
//  ROUTES HANDLED (all require member JWT):
//    POST /v1/bids              — place a manual bid
//    GET  /v1/bids/:listingId   — public bid history for a listing
//    POST /v1/bids/auto         — set / update auto-bid ceiling
//    GET  /v1/me/bids           — my active bids
//
//  AUCTION RULES:
//    - Only listings with selling_type='auction' accept bids
//    - Listing must be status='active' and auction_end must be in the future
//    - Bid must exceed current highest bid (or auction_start if no bids yet)
//    - Bid increment: 100 satang minimum above current high bid
//    - Seller cannot bid on own listing
//    - max_auto_bid is NEVER exposed publicly — it is private to the bidder
//    - When a new bid arrives: auto-bid engine fires for existing auto-bidders
//    - buy_now_price: if bid >= buy_now_price → auto-accept, close auction
//
//  AUTO-BID ENGINE:
//    When a new bid is placed, the system checks if any other bidder has an
//    active auto-bid with max_auto_bid > new bid amount. If yes, the system
//    places an auto-bid just above the incoming bid (up to their max).
//    If two auto-bidders compete: the higher ceiling wins at just above the
//    lower ceiling. The lower bidder is outbid and notified.
//
//  CONSENT WALL (L064): POST routes only.
//
//  NOTIFICATIONS (L067 — never inline):
//    new bid placed     → notify previous high bidder (outbid)
//    buy_now triggered  → notify seller + winner
//    auto-bid placed    → notify the bidder whose auto-bid fired
//    outbid alert       → notify outbid bidder
//
//  AMOUNTS: ALL in satang (THB × 100). 10000 = ฿100.
//  BID INCREMENT: MIN_BID_INCREMENT = 100 satang (฿1). Never configurable.
// ════════════════════════════════════════════════════════════════════════════

const MIN_BID_INCREMENT = 100; // satang — ฿1 minimum step


// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Check pending_consent for transactional routes. L064.
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
async function queueNotification(env, toEmail, template, payload, memberId = null) {
    await env.DB.prepare(`
        INSERT INTO notification_queue
            (member_id, to_email, template, payload, status, created_at)
        VALUES (?, ?, ?, ?, 'queued', ?)
    `).bind(
        memberId,
        toEmail,
        template,
        JSON.stringify(payload),
        Math.floor(Date.now() / 1000)
    ).run();
}

/**
 * Get the current highest bid amount for a listing.
 * Returns auction_start (or 0) if no bids yet.
 */
async function getCurrentHighBid(listingId, env) {
    const row = await env.DB.prepare(`
        SELECT MAX(amount) AS high_bid FROM bids
        WHERE listing_id = ? AND status IN ('active', 'won')
    `).bind(listingId).first();
    return row?.high_bid ?? null;
}

/**
 * Get the current winning bidder id for a listing.
 */
async function getCurrentWinner(listingId, env) {
    const row = await env.DB.prepare(`
        SELECT bidder_id, amount FROM bids
        WHERE listing_id = ? AND status = 'active'
        ORDER BY amount DESC LIMIT 1
    `).bind(listingId).first();
    return row;
}

/**
 * Auto-bid engine.
 * After a new manual bid lands, check if any other bidder has a
 * max_auto_bid > newBidAmount. If yes, fire an auto-bid to stay on top.
 * Returns the final winning bid info after auto-bids resolve.
 *
 * @param {number}  listingId
 * @param {number}  newBidAmount   — the amount of the just-placed bid
 * @param {number}  newBidderId    — member who just placed the bid
 * @param {object}  listing        — listing row (needs auction_reserve, buy_now_price)
 * @param {object}  env
 * @returns {{ finalAmount, finalBidderId, buyNowTriggered }}
 */
async function runAutoBidEngine(listingId, newBidAmount, newBidderId, listing, env) {
    const now = Math.floor(Date.now() / 1000);

    // Find competing auto-bidders who are NOT the new bidder
    // and whose max_auto_bid exceeds the current top bid
    const autoBidders = await env.DB.prepare(`
        SELECT bidder_id, MAX(max_auto_bid) AS max_auto_bid
        FROM bids
        WHERE listing_id = ?
          AND is_auto_bid = 0
          AND max_auto_bid IS NOT NULL
          AND max_auto_bid > ?
          AND bidder_id != ?
          AND status = 'active'
        GROUP BY bidder_id
        ORDER BY max_auto_bid DESC
        LIMIT 1
    `).bind(listingId, newBidAmount, newBidderId).first();

    if (!autoBidders) {
        // No competing auto-bidder — new manual bid stands
        return { finalAmount: newBidAmount, finalBidderId: newBidderId, buyNowTriggered: false };
    }

    // A competing auto-bidder exists — fire their auto-bid
    const autoAmount = Math.min(
        autoBidders.max_auto_bid,
        newBidAmount + MIN_BID_INCREMENT
    );

    // Check buy_now_price
    if (listing.buy_now_price && autoAmount >= listing.buy_now_price) {
        // Auto-bidder triggers buy_now — we handle auction close in the caller
        return {
            finalAmount:     listing.buy_now_price,
            finalBidderId:   autoBidders.bidder_id,
            buyNowTriggered: true
        };
    }

    // Mark the new (just-placed) bid as 'outbid'
    await env.DB.prepare(`
        UPDATE bids SET status='outbid'
        WHERE listing_id=? AND bidder_id=? AND status='active'
    `).bind(listingId, newBidderId).run();

    // Insert auto-bid row
    await env.DB.prepare(`
        INSERT INTO bids
            (listing_id, bidder_id, amount, is_auto_bid, status, created_at)
        VALUES (?, ?, ?, 1, 'active', ?)
    `).bind(listingId, autoBidders.bidder_id, autoAmount, now).run();

    // Notify the original bidder they were outbid by auto-bid
    const outbidMember = await env.DB.prepare(
        'SELECT email FROM members WHERE id=?'
    ).bind(newBidderId).first();
    if (outbidMember?.email) {
        await queueNotification(env, outbidMember.email, 'outbid_alert', {
            listingId,
            listingTitle: listing.title,
            yourBid:      newBidAmount,
            newHighBid:   autoAmount
        }, newBidderId);
    }

    return { finalAmount: autoAmount, finalBidderId: autoBidders.bidder_id, buyNowTriggered: false };
}

/**
 * Close auction as a buy_now sale.
 * Sets listing to sold, winning bid to 'won', all others to 'outbid'.
 */
async function closeBuyNow(listingId, winnerId, amount, listing, env) {
    const now = Math.floor(Date.now() / 1000);

    // Mark listing sold
    await env.DB.prepare(`
        UPDATE listings SET status='sold', sold_at=? WHERE id=?
    `).bind(now, listingId).run();

    // Mark all active bids outbid
    await env.DB.prepare(`
        UPDATE bids SET status='outbid' WHERE listing_id=? AND status='active'
    `).bind(listingId).run();

    // Insert the winning buy_now bid
    await env.DB.prepare(`
        INSERT INTO bids (listing_id, bidder_id, amount, is_auto_bid, status, created_at)
        VALUES (?, ?, ?, 0, 'won', ?)
    `).bind(listingId, winnerId, amount, now).run();

    // Notify winner
    const winner = await env.DB.prepare(
        'SELECT email FROM members WHERE id=?'
    ).bind(winnerId).first();
    if (winner?.email) {
        await queueNotification(env, winner.email, 'auction_won_buy_now', {
            listingId,
            listingTitle: listing.title,
            amount
        }, winnerId);
    }

    // Notify seller
    const seller = await env.DB.prepare(
        'SELECT email FROM members WHERE id=?'
    ).bind(listing.seller_id).first();
    if (seller?.email) {
        await queueNotification(env, seller.email, 'item_sold_buy_now', {
            listingId,
            listingTitle: listing.title,
            amount,
            buyerId: winnerId
        }, listing.seller_id);
    }
}


// ════════════════════════════════════════════════════════════════════════════
//  POST /v1/bids
//  Place a manual bid on an auction listing.
//
//  Body (JSON):
//    listing_id  {number}  required
//    amount      {number}  required — satang
//
//  Returns current bid status and whether buy_now was triggered.
// ════════════════════════════════════════════════════════════════════════════
export async function handlePlaceBid(request, env, memberId) {
    // Consent wall
    const consentBlock = await requireConsent(memberId, env);
    if (consentBlock) return consentBlock;

    let body;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { listing_id, amount } = body;

    if (!listing_id || typeof listing_id !== 'number') {
        return Response.json({ error: 'listing_id is required' }, { status: 400 });
    }
    if (!amount || typeof amount !== 'number' || amount <= 0) {
        return Response.json({ error: 'amount is required (satang)' }, { status: 400 });
    }

    // Fetch listing
    const listing = await env.DB.prepare(`
        SELECT id, seller_id, broker_id, title, status, selling_type,
               auction_start, auction_end, auction_reserve, buy_now_price
        FROM listings WHERE id = ?
    `).bind(listing_id).first();

    if (!listing) {
        return Response.json({ error: 'Listing not found' }, { status: 404 });
    }
    if (listing.selling_type !== 'auction') {
        return Response.json({ error: 'This listing is not an auction' }, { status: 400 });
    }
    if (listing.status !== 'active') {
        return Response.json({ error: 'Auction is not active' }, { status: 400 });
    }

    const now = Math.floor(Date.now() / 1000);
    if (listing.auction_end && listing.auction_end <= now) {
        return Response.json({ error: 'Auction has already ended' }, { status: 400 });
    }

    // Cannot bid on own listing
    if (memberId === listing.seller_id || memberId === listing.broker_id) {
        return Response.json({ error: 'Cannot bid on your own listing' }, { status: 403 });
    }

    // Get current high bid
    const currentHigh = await getCurrentHighBid(listing_id, env);
    const minimumBid  = currentHigh
        ? currentHigh + MIN_BID_INCREMENT
        : (listing.auction_start ?? MIN_BID_INCREMENT);

    if (amount < minimumBid) {
        return Response.json({
            error:       `Bid must be at least ฿${(minimumBid/100).toFixed(2)}`,
            minimum_bid: minimumBid,
            current_high: currentHigh
        }, { status: 400 });
    }

    // Check buy_now_price trigger
    if (listing.buy_now_price && amount >= listing.buy_now_price) {
        await closeBuyNow(listing_id, memberId, listing.buy_now_price, listing, env);
        return Response.json({
            success:          true,
            buy_now_triggered: true,
            amount:            listing.buy_now_price,
            message:           'Buy Now price reached — auction closed. Proceed to create an order.',
            next_step:         'POST /v1/orders'
        }, { status: 201 });
    }

    // Mark the previous high bidder as 'outbid'
    const previousWinner = await getCurrentWinner(listing_id, env);
    if (previousWinner && previousWinner.bidder_id !== memberId) {
        await env.DB.prepare(`
            UPDATE bids SET status='outbid'
            WHERE listing_id=? AND bidder_id=? AND status='active'
        `).bind(listing_id, previousWinner.bidder_id).run();

        // Notify outbid member
        const outbidMember = await env.DB.prepare(
            'SELECT email FROM members WHERE id=?'
        ).bind(previousWinner.bidder_id).first();
        if (outbidMember?.email) {
            await queueNotification(env, outbidMember.email, 'outbid_alert', {
                listingId: listing_id,
                listingTitle: listing.title,
                yourBid:    previousWinner.amount,
                newHighBid: amount
            }, previousWinner.bidder_id);
        }
    }

    // Insert the new bid
    await env.DB.prepare(`
        INSERT INTO bids
            (listing_id, bidder_id, amount, is_auto_bid, status, created_at)
        VALUES (?, ?, ?, 0, 'active', ?)
    `).bind(listing_id, memberId, amount, now).run();

    // Run auto-bid engine
    const { finalAmount, finalBidderId, buyNowTriggered } = await runAutoBidEngine(
        listing_id, amount, memberId, listing, env
    );

    if (buyNowTriggered) {
        await closeBuyNow(listing_id, finalBidderId, listing.buy_now_price, listing, env);
        return Response.json({
            success:           true,
            buy_now_triggered: true,
            amount:            listing.buy_now_price,
            message:           'Auto-bid triggered Buy Now. Auction closed.',
            next_step:         'POST /v1/orders'
        }, { status: 201 });
    }

    return Response.json({
        success:      true,
        bid_placed:   amount,
        current_high: finalAmount,
        you_are_winning: (finalBidderId === memberId),
        listing_id,
        auction_end:  listing.auction_end,
        message:      finalBidderId === memberId
            ? 'Bid placed — you are currently winning!'
            : 'Bid placed — but an auto-bidder has outbid you.'
    }, { status: 201 });
}


// ════════════════════════════════════════════════════════════════════════════
//  GET /v1/bids/:listingId
//  Public bid history for an auction listing.
//  max_auto_bid is NEVER included in the response — it is private.
//
//  Query params:
//    ?limit=20  (default 20, max 50)
// ════════════════════════════════════════════════════════════════════════════
export async function handleGetBids(listingId, request, env) {
    const id = parseInt(listingId);
    if (isNaN(id)) {
        return Response.json({ error: 'Invalid listing ID' }, { status: 400 });
    }

    const url   = new URL(request.url);
    const limit = Math.min(50, parseInt(url.searchParams.get('limit') || '20'));

    // Verify listing exists and is an auction
    const listing = await env.DB.prepare(`
        SELECT id, title, selling_type, status, auction_start,
               auction_end, auction_reserve
        FROM listings WHERE id = ?
    `).bind(id).first();

    if (!listing) {
        return Response.json({ error: 'Listing not found' }, { status: 404 });
    }
    if (listing.selling_type !== 'auction') {
        return Response.json({ error: 'This listing is not an auction' }, { status: 400 });
    }

    const bids = await env.DB.prepare(`
        SELECT b.id, b.amount, b.is_auto_bid, b.status, b.created_at,
               m.username AS bidder_username
        FROM bids b
        JOIN members m ON m.id = b.bidder_id
        WHERE b.listing_id = ?
        ORDER BY b.amount DESC, b.created_at DESC
        LIMIT ?
    `).bind(id, limit).all();

    // Do NOT expose max_auto_bid — it is private
    // Do NOT expose auction_reserve

    const bidRows  = bids.results ?? [];
    const highBid  = bidRows[0]?.amount ?? listing.auction_start ?? 0;

    return Response.json({
        listing_id:       id,
        listing_title:    listing.title,
        current_high_bid: highBid,
        bid_count:        bidRows.length,
        auction_end:      listing.auction_end,
        status:           listing.status,
        bids:             bidRows
    });
}


// ════════════════════════════════════════════════════════════════════════════
//  POST /v1/bids/auto
//  Set or update an auto-bid ceiling for a listing.
//  The system will automatically outbid competitors up to this ceiling.
//
//  Body (JSON):
//    listing_id    {number}  required
//    max_auto_bid  {number}  required — satang, the ceiling (never shown publicly)
//
//  Rules:
//    - max_auto_bid must be above the current high bid
//    - Cannot set auto-bid on own listing
//    - Updates existing auto-bid setting if one already exists for this bidder+listing
//    - Setting max_auto_bid = 0 or null cancels auto-bid
// ════════════════════════════════════════════════════════════════════════════
export async function handleSetAutoBid(request, env, memberId) {
    // Consent wall
    const consentBlock = await requireConsent(memberId, env);
    if (consentBlock) return consentBlock;

    let body;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { listing_id, max_auto_bid } = body;

    if (!listing_id || typeof listing_id !== 'number') {
        return Response.json({ error: 'listing_id is required' }, { status: 400 });
    }

    // Cancel auto-bid if max_auto_bid is 0 or null
    if (max_auto_bid === 0 || max_auto_bid === null) {
        await env.DB.prepare(`
            UPDATE bids SET max_auto_bid=NULL, status='cancelled'
            WHERE listing_id=? AND bidder_id=? AND status='active'
        `).bind(listing_id, memberId).run();

        return Response.json({
            success: true,
            message: 'Auto-bid cancelled for this listing.'
        });
    }

    if (typeof max_auto_bid !== 'number' || max_auto_bid <= 0) {
        return Response.json({ error: 'max_auto_bid must be a positive integer in satang' }, { status: 400 });
    }

    // Fetch listing
    const listing = await env.DB.prepare(`
        SELECT id, seller_id, broker_id, title, status, selling_type,
               auction_start, auction_end, buy_now_price
        FROM listings WHERE id = ?
    `).bind(listing_id).first();

    if (!listing) {
        return Response.json({ error: 'Listing not found' }, { status: 404 });
    }
    if (listing.selling_type !== 'auction') {
        return Response.json({ error: 'This listing is not an auction' }, { status: 400 });
    }
    if (listing.status !== 'active') {
        return Response.json({ error: 'Auction is not active' }, { status: 400 });
    }

    const now = Math.floor(Date.now() / 1000);
    if (listing.auction_end && listing.auction_end <= now) {
        return Response.json({ error: 'Auction has already ended' }, { status: 400 });
    }

    // Cannot set auto-bid on own listing
    if (memberId === listing.seller_id || memberId === listing.broker_id) {
        return Response.json({ error: 'Cannot set auto-bid on your own listing' }, { status: 403 });
    }

    // max_auto_bid must exceed current high bid
    const currentHigh = await getCurrentHighBid(listing_id, env);
    const minimumBid  = currentHigh
        ? currentHigh + MIN_BID_INCREMENT
        : (listing.auction_start ?? MIN_BID_INCREMENT);

    if (max_auto_bid < minimumBid) {
        return Response.json({
            error:       `max_auto_bid must be at least ฿${(minimumBid/100).toFixed(2)} to be competitive`,
            minimum_bid: minimumBid,
            current_high: currentHigh
        }, { status: 400 });
    }

    // Update existing active bid's max_auto_bid if member already has one
    const existingBid = await env.DB.prepare(`
        SELECT id FROM bids
        WHERE listing_id=? AND bidder_id=? AND status='active'
        ORDER BY created_at DESC LIMIT 1
    `).bind(listing_id, memberId).first();

    if (existingBid) {
        await env.DB.prepare(`
            UPDATE bids SET max_auto_bid=? WHERE id=?
        `).bind(max_auto_bid, existingBid.id).run();
    } else {
        // No existing bid — place an initial bid at minimumBid with this ceiling
        await env.DB.prepare(`
            INSERT INTO bids
                (listing_id, bidder_id, amount, is_auto_bid, max_auto_bid, status, created_at)
            VALUES (?, ?, ?, 0, ?, 'active', ?)
        `).bind(listing_id, memberId, minimumBid, max_auto_bid, now).run();
    }

    // Run auto-bid engine immediately to see if we're the new leader
    const { finalAmount, finalBidderId, buyNowTriggered } = await runAutoBidEngine(
        listing_id, minimumBid, memberId, listing, env
    );

    if (buyNowTriggered) {
        await closeBuyNow(listing_id, finalBidderId, listing.buy_now_price, listing, env);
        return Response.json({
            success:           true,
            buy_now_triggered: true,
            message:           'Your auto-bid ceiling triggered Buy Now. Auction closed.',
            next_step:         'POST /v1/orders'
        });
    }

    return Response.json({
        success:          true,
        max_auto_bid_set: max_auto_bid,
        current_high:     finalAmount,
        you_are_winning:  (finalBidderId === memberId),
        listing_id,
        message: finalBidderId === memberId
            ? 'Auto-bid activated — you are currently winning!'
            : 'Auto-bid set — another bidder is currently higher.'
    });
}


// ════════════════════════════════════════════════════════════════════════════
//  GET /v1/me/bids
//  Returns the authenticated member's active bids across all auctions.
//  max_auto_bid IS included here (only shown to the bidder themselves).
//
//  Query params:
//    ?status=active|outbid|won|cancelled  (default: active)
//    ?page=1
// ════════════════════════════════════════════════════════════════════════════
export async function handleGetMyBids(request, env, memberId) {
    const url    = new URL(request.url);
    const status = url.searchParams.get('status') || 'active';
    const page   = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const limit  = 20;
    const offset = (page - 1) * limit;

    const validStatuses = ['active', 'outbid', 'won', 'cancelled'];
    const safeStatus    = validStatuses.includes(status) ? status : 'active';

    const rows = await env.DB.prepare(`
        SELECT b.id, b.listing_id, b.amount, b.is_auto_bid, b.max_auto_bid,
               b.status, b.created_at,
               l.title       AS listing_title,
               l.primary_image AS listing_image,
               l.slug        AS listing_slug,
               l.auction_end,
               l.status      AS listing_status
        FROM bids b
        JOIN listings l ON l.id = b.listing_id
        WHERE b.bidder_id = ? AND b.status = ?
        ORDER BY b.created_at DESC
        LIMIT ? OFFSET ?
    `).bind(memberId, safeStatus, limit, offset).all();

    return Response.json({
        bids:     rows.results ?? [],
        page,
        page_size: limit,
        has_more: (rows.results?.length ?? 0) === limit
    });
}
