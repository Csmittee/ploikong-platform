// ════════════════════════════════════════════════════════════════════════════
//  PLOIKONG — Orders Handler
//  File: src/handlers/orders.js
//
//  ROUTES HANDLED (all require member JWT):
//    POST   /v1/orders                    — create order (buy now / accepted offer)
//    GET    /v1/orders/:orderId           — get order detail (buyer or seller only)
//    GET    /v1/me/orders                 — my orders (as buyer or seller)
//    POST   /v1/orders/:orderId/confirm   — buyer confirms delivery
//    POST   /v1/orders/:orderId/dispute   — buyer opens dispute
//
//  PAYMENT FIREWALL (L063 — HARDCODED, never configurable):
//    ALL money: Omise → Ploikong escrow → seller
//    broker_id = commission tracking ONLY — never payment routing
//
//  CONSENT WALL (L064):
//    pending_consent check on every POST route
//
//  AMOUNTS: ALL in satang (THB × 100). 10000 = ฿100.
//
//  ORDER ID FORMAT: PLK-YYYYMMDD-XXXX (4 random alphanumeric chars)
//
//  ESCROW FLOW:
//    Order created    → payment_status=pending, escrow_status=holding
//    Omise confirms   → payment_status=paid, status=confirmed
//    Buyer confirms   → delivered_at set, payout_due_at = delivered_at + 7d
//    Cron             → escrow_status=released, payout_released_at set
//
//  FEE CALCULATION (all rates from platform_config — L061):
//    platform_fee = amount × platform_fee_pct / 100
//    broker_fee   = amount × broker_fee_pct / 100 (only if broker_id present)
//    seller_payout = amount - platform_fee - broker_fee
//
//  NOTIFICATIONS (L067 — never inline, always queue):
//    On payment confirm (webhook): buyer=payment_received, seller=item_sold
//    On delivery confirm: seller=delivery_confirmed
//    On dispute: owner alert via notification_queue
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
 * L064: returns a 403 Response if consent is required, null if OK.
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
 * Generate a PLK-YYYYMMDD-XXXX order ID.
 * XXXX = 4 random uppercase alphanumeric chars.
 */
function generateOrderId() {
    const now  = new Date();
    const yyyy = now.getUTCFullYear();
    const mm   = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd   = String(now.getUTCDate()).padStart(2, '0');
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O,0,I,1 — easy to read aloud
    let suffix = '';
    for (let i = 0; i < 4; i++) {
        suffix += chars[Math.floor(Math.random() * chars.length)];
    }
    return `PLK-${yyyy}${mm}${dd}-${suffix}`;
}

/**
 * Log broker commission — L063: commission tracking only, no payment routing.
 */
async function logBrokerCommission(env, orderId, order, config) {
    const brokerFeePct       = parseFloat(config.broker_fee_pct)        || 3.0;
    const platformBrokerSplit = parseFloat(config.platform_broker_split) || 50.0;
    const brokerBrokerSplit   = parseFloat(config.broker_broker_split)   || 50.0;

    const brokerFeeTotal = Math.floor(order.amount * brokerFeePct / 100);
    const platformShare  = Math.floor(brokerFeeTotal * platformBrokerSplit / 100);
    const brokerShare    = brokerFeeTotal - platformShare; // avoid rounding gap

    await env.DB.prepare(`
        INSERT INTO broker_commission_log
            (order_id, broker_id, gross_amount, broker_fee_pct,
             broker_fee_total, platform_share_pct, broker_share_pct,
             platform_share, broker_share, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).bind(
        orderId,
        order.broker_id,
        order.amount,
        brokerFeePct,
        brokerFeeTotal,
        platformBrokerSplit,
        brokerBrokerSplit,
        platformShare,
        brokerShare,
        Math.floor(Date.now() / 1000)
    ).run();
}

/**
 * Ensure the authenticated member is the buyer or seller on this order.
 */
function canViewOrder(order, memberId) {
    return order.buyer_id === memberId || order.seller_id === memberId;
}


// ════════════════════════════════════════════════════════════════════════════
//  POST /v1/orders — Create order
//  Body: { listing_id, payment_method }
//  Optional body: { offer_id } if buying via accepted offer price
// ════════════════════════════════════════════════════════════════════════════
export async function handleCreateOrder(request, env, memberId) {
    const now = Math.floor(Date.now() / 1000);

    // ── Consent wall (L064) ──────────────────────────────────────────────────
    const consentBlock = await requireConsent(memberId, env);
    if (consentBlock) return consentBlock;

    // ── Parse body ───────────────────────────────────────────────────────────
    let body;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { listing_id, payment_method, offer_id } = body;

    if (!listing_id || !payment_method) {
        return Response.json(
            { error: 'listing_id and payment_method are required' },
            { status: 400 }
        );
    }
    if (!['promptpay', 'credit_card'].includes(payment_method)) {
        return Response.json(
            { error: 'payment_method must be promptpay or credit_card' },
            { status: 400 }
        );
    }

    // ── Load listing ─────────────────────────────────────────────────────────
    const listing = await env.DB.prepare(`
        SELECT id, seller_id, broker_id, selling_type, price, buy_now_price, status
        FROM listings WHERE id = ?
    `).bind(listing_id).first();

    if (!listing) {
        return Response.json({ error: 'Listing not found' }, { status: 404 });
    }
    if (listing.status !== 'active') {
        return Response.json(
            { error: 'Listing is not available for purchase', listing_status: listing.status },
            { status: 409 }
        );
    }
    if (listing.seller_id === memberId) {
        return Response.json(
            { error: 'You cannot buy your own listing' },
            { status: 400 }
        );
    }

    // ── Determine amount ─────────────────────────────────────────────────────
    let amount;

    if (offer_id) {
        // Buying via a previously accepted offer
        const offer = await env.DB.prepare(`
            SELECT id, listing_id, to_member_id, amount, status
            FROM offers WHERE id = ?
        `).bind(offer_id).first();

        if (!offer || offer.listing_id !== listing_id) {
            return Response.json({ error: 'Offer not found for this listing' }, { status: 404 });
        }
        if (offer.status !== 'accepted') {
            return Response.json({ error: 'Offer is not in accepted status' }, { status: 409 });
        }
        if (offer.to_member_id !== memberId && offer.to_member_id !== listing.seller_id) {
            // Validate offer belongs to this buyer or was made to the seller
            return Response.json({ error: 'Offer does not belong to this transaction' }, { status: 403 });
        }
        amount = offer.amount;
    } else {
        // Direct buy — fixed price or buy_now
        if (listing.selling_type === 'fixed' || listing.selling_type === 'buy_now') {
            amount = listing.price ?? listing.buy_now_price;
        } else if (listing.selling_type === 'auction' && listing.buy_now_price) {
            amount = listing.buy_now_price;
        } else {
            return Response.json(
                { error: 'This listing requires an offer or bid — use POST /v1/offers or POST /v1/bids' },
                { status: 400 }
            );
        }
    }

    if (!amount || amount <= 0) {
        return Response.json({ error: 'Invalid listing price' }, { status: 400 });
    }

    // ── Read platform config (L061) ──────────────────────────────────────────
    const config = await getPlatformConfig(env);

    const platformFeePct = parseFloat(config.platform_fee_pct) || 6.0;
    const platformFee    = Math.floor(amount * platformFeePct / 100);

    // ── PAYMENT FIREWALL (L063) ──────────────────────────────────────────────
    // broker_id is for commission tracking ONLY — never changes payment routing.
    const brokerId    = listing.broker_id ?? null;
    let brokerFee     = 0;
    if (brokerId) {
        const brokerFeePct = parseFloat(config.broker_fee_pct) || 3.0;
        brokerFee = Math.floor(amount * brokerFeePct / 100);
    }

    const sellerPayout = amount - platformFee - brokerFee;

    // ── Generate order ID ────────────────────────────────────────────────────
    // Retry up to 3 times on the rare collision of a 4-char suffix
    let orderId;
    for (let attempt = 0; attempt < 3; attempt++) {
        const candidate = generateOrderId();
        const existing  = await env.DB.prepare(
            'SELECT id FROM orders WHERE id = ?'
        ).bind(candidate).first();
        if (!existing) { orderId = candidate; break; }
    }
    if (!orderId) {
        return Response.json({ error: 'Could not generate unique order ID. Please retry.' }, { status: 500 });
    }

    // ── INSERT order ─────────────────────────────────────────────────────────
    await env.DB.prepare(`
        INSERT INTO orders
            (id, listing_id, buyer_id, seller_id, broker_id,
             amount, platform_fee, broker_fee, seller_payout,
             payment_method, payment_status, escrow_status,
             status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, 'pending', 'holding',
                'pending', ?, ?)
    `).bind(
        orderId,
        listing_id,
        memberId,
        listing.seller_id,
        brokerId,
        amount,
        platformFee,
        brokerFee,
        sellerPayout,
        payment_method,
        now,
        now
    ).run();

    // ── Mark listing as sold (prevent double-buy) ────────────────────────────
    await env.DB.prepare(`
        UPDATE listings SET status='sold', sold_at=?, updated_at=? WHERE id=?
    `).bind(now, now, listing_id).run();

    // ── Log broker commission if broker is involved (L063) ───────────────────
    if (brokerId) {
        await logBrokerCommission(env, orderId, { amount, broker_id: brokerId }, config);
    }

    // ── Return created order (payment step follows via POST /v1/payment) ─────
    return Response.json({
        order_id:       orderId,
        amount,
        platform_fee:   platformFee,
        broker_fee:     brokerFee,
        seller_payout:  sellerPayout,
        payment_method,
        payment_status: 'pending',
        escrow_status:  'holding',
        status:         'pending',
        message:        'Order created. Proceed to payment.'
    }, { status: 201 });
}


// ════════════════════════════════════════════════════════════════════════════
//  GET /v1/orders/:orderId — Get order detail
//  Only buyer or seller may view.
// ════════════════════════════════════════════════════════════════════════════
export async function handleGetOrder(orderId, env, memberId) {
    const order = await env.DB.prepare(`
        SELECT
            o.*,
            l.title, l.slug, l.primary_image,
            buyer.name  AS buyer_name,
            buyer.username AS buyer_username,
            seller.name AS seller_name,
            seller.username AS seller_username
        FROM orders o
        LEFT JOIN listings l   ON l.id  = o.listing_id
        LEFT JOIN members buyer  ON buyer.id  = o.buyer_id
        LEFT JOIN members seller ON seller.id = o.seller_id
        WHERE o.id = ?
    `).bind(orderId).first();

    if (!order) {
        return Response.json({ error: 'Order not found' }, { status: 404 });
    }
    if (!canViewOrder(order, memberId)) {
        return Response.json({ error: 'Access denied' }, { status: 403 });
    }

    // Redact internal fields from buyer — seller_payout is seller's eyes only
    const isBuyer  = order.buyer_id  === memberId;
    const isSeller = order.seller_id === memberId;

    const response = { ...order };
    if (isBuyer) {
        delete response.seller_payout;
        delete response.platform_fee;
        delete response.broker_fee;
    }
    // Sellers don't see buyer personal details beyond name/username
    if (isSeller) {
        delete response.buyer_username; // username visible, that's fine
    }

    return Response.json(response);
}


// ════════════════════════════════════════════════════════════════════════════
//  GET /v1/me/orders — My orders (as buyer + seller)
// ════════════════════════════════════════════════════════════════════════════
export async function handleGetMyOrders(request, env, memberId) {
    const url    = new URL(request.url);
    const params = url.searchParams;

    const role   = params.get('role')   || 'all';   // buyer | seller | all
    const status = params.get('status');             // optional filter
    const limit  = Math.min(parseInt(params.get('limit')  || '20'), 50);
    const offset = Math.max(parseInt(params.get('offset') || '0'), 0);

    let whereClauses = [];
    let bindings     = [];

    if (role === 'buyer') {
        whereClauses.push('o.buyer_id = ?');
        bindings.push(memberId);
    } else if (role === 'seller') {
        whereClauses.push('o.seller_id = ?');
        bindings.push(memberId);
    } else {
        whereClauses.push('(o.buyer_id = ? OR o.seller_id = ?)');
        bindings.push(memberId, memberId);
    }

    if (status) {
        whereClauses.push('o.status = ?');
        bindings.push(status);
    }

    const where = whereClauses.join(' AND ');

    const rows = await env.DB.prepare(`
        SELECT
            o.id, o.amount, o.payment_status, o.escrow_status, o.status,
            o.payment_method, o.created_at, o.delivered_at, o.payout_due_at,
            o.buyer_id, o.seller_id,
            l.title, l.slug, l.primary_image,
            buyer.name  AS buyer_name,
            seller.name AS seller_name
        FROM orders o
        LEFT JOIN listings l     ON l.id  = o.listing_id
        LEFT JOIN members buyer  ON buyer.id  = o.buyer_id
        LEFT JOIN members seller ON seller.id = o.seller_id
        WHERE ${where}
        ORDER BY o.created_at DESC
        LIMIT ? OFFSET ?
    `).bind(...bindings, limit, offset).all();

    return Response.json({
        orders: rows.results ?? [],
        limit,
        offset,
        count:  (rows.results ?? []).length
    });
}


// ════════════════════════════════════════════════════════════════════════════
//  POST /v1/orders/:orderId/confirm — Buyer confirms delivery
// ════════════════════════════════════════════════════════════════════════════
export async function handleConfirmDelivery(orderId, env, memberId) {
    const now = Math.floor(Date.now() / 1000);

    // ── Consent wall ─────────────────────────────────────────────────────────
    const consentBlock = await requireConsent(memberId, env);
    if (consentBlock) return consentBlock;

    const order = await env.DB.prepare(
        'SELECT * FROM orders WHERE id = ?'
    ).bind(orderId).first();

    if (!order)                       return Response.json({ error: 'Order not found' }, { status: 404 });
    if (order.buyer_id !== memberId)  return Response.json({ error: 'Only the buyer can confirm delivery' }, { status: 403 });
    if (order.payment_status !== 'paid') {
        return Response.json({ error: 'Payment has not been confirmed yet' }, { status: 409 });
    }
    if (['delivered', 'complete', 'disputed'].includes(order.status)) {
        return Response.json({ error: `Order is already in status: ${order.status}` }, { status: 409 });
    }

    // ── Read escrow_hold_days from config (L061) ──────────────────────────────
    const config       = await getPlatformConfig(env);
    const holdDays     = parseInt(config.escrow_hold_days) || 7;
    const deliveredAt  = now;
    const payoutDueAt  = deliveredAt + (holdDays * 86400);

    await env.DB.prepare(`
        UPDATE orders
        SET status='delivered', delivered_at=?, payout_due_at=?, updated_at=?
        WHERE id=?
    `).bind(deliveredAt, payoutDueAt, now, orderId).run();

    // ── Queue notification to seller (L067) ──────────────────────────────────
    const seller = await env.DB.prepare(
        'SELECT id, email, name FROM members WHERE id = ?'
    ).bind(order.seller_id).first();

    if (seller) {
        await queueNotification(
            env,
            seller.email,
            'delivery_confirmed',
            { order_id: orderId, payout_due_at: payoutDueAt },
            seller.id
        );
    }

    return Response.json({
        order_id:      orderId,
        status:        'delivered',
        delivered_at:  deliveredAt,
        payout_due_at: payoutDueAt,
        message:       `Delivery confirmed. Seller payout scheduled in ${holdDays} days.`
    });
}


// ════════════════════════════════════════════════════════════════════════════
//  POST /v1/orders/:orderId/dispute — Buyer opens a dispute
//  Body: { reason }
// ════════════════════════════════════════════════════════════════════════════
export async function handleOpenDispute(orderId, request, env, memberId) {
    const now = Math.floor(Date.now() / 1000);

    // ── Consent wall ─────────────────────────────────────────────────────────
    const consentBlock = await requireConsent(memberId, env);
    if (consentBlock) return consentBlock;

    let body;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { reason } = body;
    if (!reason || reason.trim().length < 10) {
        return Response.json(
            { error: 'A dispute reason of at least 10 characters is required' },
            { status: 400 }
        );
    }

    const order = await env.DB.prepare(
        'SELECT * FROM orders WHERE id = ?'
    ).bind(orderId).first();

    if (!order)                      return Response.json({ error: 'Order not found' }, { status: 404 });
    if (order.buyer_id !== memberId) return Response.json({ error: 'Only the buyer can open a dispute' }, { status: 403 });
    if (order.payment_status !== 'paid') {
        return Response.json({ error: 'Cannot dispute an unpaid order' }, { status: 409 });
    }
    if (order.escrow_status === 'disputed') {
        return Response.json({ error: 'Dispute already open on this order' }, { status: 409 });
    }
    if (order.escrow_status === 'released') {
        return Response.json({ error: 'Cannot dispute — escrow already released' }, { status: 409 });
    }

    // ── Set disputed ─────────────────────────────────────────────────────────
    await env.DB.prepare(`
        UPDATE orders
        SET escrow_status='disputed', status='disputed',
            dispute_reason=?, dispute_opened_at=?, updated_at=?
        WHERE id=?
    `).bind(reason.trim(), now, now, orderId).run();

    // ── Alert owner via notification_queue (L067) ─────────────────────────────
    const owner = await env.DB.prepare(
        "SELECT id, email FROM staff WHERE role='owner' AND status='active' LIMIT 1"
    ).first();

    if (owner) {
        await queueNotification(
            env,
            owner.email,
            'dispute_opened',
            {
                order_id:   orderId,
                buyer_id:   memberId,
                seller_id:  order.seller_id,
                amount:     order.amount,
                reason:     reason.trim()
            },
            null,
            owner.id
        );
    }

    return Response.json({
        order_id:          orderId,
        escrow_status:     'disputed',
        status:            'disputed',
        dispute_opened_at: now,
        message:           'Dispute opened. The Ploikong team has been notified and will contact you within 1 business day.'
    });
}


// ════════════════════════════════════════════════════════════════════════════
//  INTERNAL — Called by webhook.js after Omise payment is confirmed
//  Not exported as an HTTP route. Called directly from webhook handler.
//
//  On payment confirmed:
//    - Set payment_status=paid, paid_at, status=confirmed
//    - Queue buyer notification: payment_received
//    - Queue seller notification: item_sold
// ════════════════════════════════════════════════════════════════════════════
export async function confirmOrderPayment(orderId, omiseChargeId, env) {
    const now = Math.floor(Date.now() / 1000);

    const order = await env.DB.prepare(
        'SELECT * FROM orders WHERE id = ?'
    ).bind(orderId).first();

    if (!order) {
        console.error(`[confirmOrderPayment] Order not found: ${orderId}`);
        return false;
    }
    if (order.payment_status === 'paid') {
        // Idempotent — already processed (Omise can send duplicate webhooks)
        return true;
    }

    await env.DB.prepare(`
        UPDATE orders
        SET payment_status='paid', omise_charge_id=?, paid_at=?,
            status='confirmed', updated_at=?
        WHERE id=?
    `).bind(omiseChargeId, now, now, orderId).run();

    // ── Queue buyer: payment_received (L067) ─────────────────────────────────
    const buyer = await env.DB.prepare(
        'SELECT id, email, name FROM members WHERE id = ?'
    ).bind(order.buyer_id).first();

    if (buyer) {
        await queueNotification(
            env,
            buyer.email,
            'payment_received',
            { order_id: orderId, amount: order.amount },
            buyer.id
        );
    }

    // ── Queue seller: item_sold (L067) ────────────────────────────────────────
    const seller = await env.DB.prepare(
        'SELECT id, email, name FROM members WHERE id = ?'
    ).bind(order.seller_id).first();

    if (seller) {
        await queueNotification(
            env,
            seller.email,
            'item_sold',
            {
                order_id:      orderId,
                amount:        order.amount,
                seller_payout: order.seller_payout,
                platform_fee:  order.platform_fee,
                broker_fee:    order.broker_fee
            },
            seller.id
        );
    }

    return true;
}
