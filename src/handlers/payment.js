// ════════════════════════════════════════════════════════════════════════════
//  PLOIKONG — Payment Handler
//  File: src/handlers/payment.js
//
//  ROUTE HANDLED (requires member JWT):
//    POST /v1/payment/charge   — create Omise charge for a pending order
//
//  PAYMENT FIREWALL (L063):
//    Money flows: Omise → Ploikong escrow → seller
//    Broker NEVER touched. broker_id = commission log ONLY.
//
//  PAYMENT_MODE env var:
//    'fake' — skip real Omise call, set omise_charge_id='FAKE-TEST', return success
//    'live' — call Omise API with OMISE_SECRET_KEY
//
//  OMISE CHARGE FLOW:
//    1. Buyer calls POST /v1/payment/charge with { order_id, omise_token }
//    2. This handler creates the Omise charge
//    3. Omise calls back POST /v1/webhook/omise when payment is confirmed
//    4. webhook.js calls confirmOrderPayment() from orders.js
//
//  AMOUNTS: ALL in satang (THB × 100). Omise natively uses satang for THB.
//
//  CONSENT WALL (L064): checked before any charge is attempted.
// ════════════════════════════════════════════════════════════════════════════


// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Check pending_consent — L064.
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
 * Call Omise API to create a charge.
 * Returns { success, charge_id, status, error? }
 *
 * Omise docs: https://www.omise.co/charges-api
 * - amount    : satang (THB × 100) — Omise uses satang natively
 * - currency  : always 'thb'
 * - card / source: the omise_token from the frontend (OmiseJS)
 *
 * PAYMENT FIREWALL (L063):
 *   recipient = Ploikong platform account only.
 *   Broker is NEVER set as a recipient here.
 */
async function createOmiseCharge(env, { amount, omiseToken, paymentMethod, orderId, description }) {
    const secretKey  = env.OMISE_SECRET_KEY;
    const authHeader = 'Basic ' + btoa(secretKey + ':');

    // Build form body for Omise API
    const formBody = new URLSearchParams({
        amount:      String(amount),
        currency:    'thb',
        description: description || `Ploikong Order ${orderId}`,
        metadata:    JSON.stringify({ order_id: orderId, platform: 'ploikong' }),
    });

    if (paymentMethod === 'promptpay') {
        // PromptPay uses a source token with type=promptpay
        formBody.set('source[type]', 'promptpay');
    } else {
        // Credit card — omise_token is a one-time card token from OmiseJS
        formBody.set('card', omiseToken);
    }

    const response = await fetch('https://api.omise.co/charges', {
        method:  'POST',
        headers: {
            Authorization:  authHeader,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formBody.toString(),
    });

    const data = await response.json();

    if (!response.ok || data.object === 'error') {
        return {
            success:  false,
            error:    data.message || 'Omise charge failed',
            code:     data.code    || 'unknown',
            charge_id: null,
        };
    }

    return {
        success:   true,
        charge_id: data.id,
        status:    data.status,         // pending | successful | failed
        authorize_uri: data.authorize_uri ?? null, // for 3DS / PromptPay QR
    };
}


// ════════════════════════════════════════════════════════════════════════════
//  POST /v1/payment/charge
//  Body: { order_id, omise_token }
//
//  omise_token: the token returned by OmiseJS from the frontend.
//    For credit card: token from OmiseJS card tokenisation.
//    For PromptPay  : not required — source is built server-side.
// ════════════════════════════════════════════════════════════════════════════
export async function handleCreateCharge(request, env, memberId) {
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

    const { order_id, omise_token } = body;

    if (!order_id) {
        return Response.json({ error: 'order_id is required' }, { status: 400 });
    }

    // ── Load order ───────────────────────────────────────────────────────────
    const order = await env.DB.prepare(
        'SELECT * FROM orders WHERE id = ?'
    ).bind(order_id).first();

    if (!order) {
        return Response.json({ error: 'Order not found' }, { status: 404 });
    }
    if (order.buyer_id !== memberId) {
        return Response.json({ error: 'You are not the buyer on this order' }, { status: 403 });
    }
    if (order.payment_status === 'paid') {
        return Response.json(
            { error: 'Payment already confirmed for this order', order_id },
            { status: 409 }
        );
    }
    if (order.payment_status === 'failed') {
        return Response.json(
            { error: 'Previous payment failed. Please contact support or create a new order.' },
            { status: 409 }
        );
    }
    if (order.payment_status !== 'pending') {
        return Response.json(
            { error: `Unexpected payment_status: ${order.payment_status}` },
            { status: 409 }
        );
    }

    // Credit card requires an omise_token
    if (order.payment_method === 'credit_card' && !omise_token) {
        return Response.json(
            { error: 'omise_token is required for credit_card payment' },
            { status: 400 }
        );
    }

    // ── Determine payment mode ────────────────────────────────────────────────
    const paymentMode = env.PAYMENT_MODE || 'fake';

    // ════════════════════════════════════════════════════════════════════════
    //  FAKE MODE — skip Omise, return simulated success
    //  Used for all development and staging testing.
    //  Change PAYMENT_MODE secret to 'live' to activate real Omise.
    // ════════════════════════════════════════════════════════════════════════
    if (paymentMode === 'fake') {
        const fakeChargeId = 'FAKE-TEST';

        // In fake mode, confirm payment immediately (no webhook needed)
        await env.DB.prepare(`
            UPDATE orders
            SET omise_charge_id=?, payment_status='paid', paid_at=?,
                status='confirmed', updated_at=?
            WHERE id=?
        `).bind(fakeChargeId, now, now, order_id).run();

        // Queue notifications the same way webhook would (L067)
        const { confirmOrderPayment } = await import('./orders.js');
        // NOTE: we call the internal helper directly in fake mode
        // In live mode, webhook.js calls this after Omise POSTs back.
        // We pass the fake charge ID so the function marks the order paid.
        //
        // Avoid double-processing by calling the function that is idempotent.
        await confirmOrderPayment(order_id, fakeChargeId, env);

        return Response.json({
            mode:         'fake',
            order_id,
            charge_id:    fakeChargeId,
            payment_status: 'paid',
            status:       'confirmed',
            message:      '[FAKE MODE] Payment simulated. Order confirmed. Notifications queued.'
        });
    }

    // ════════════════════════════════════════════════════════════════════════
    //  LIVE MODE — real Omise API call
    // ════════════════════════════════════════════════════════════════════════
    let chargeResult;
    try {
        chargeResult = await createOmiseCharge(env, {
            amount:        order.amount,
            omiseToken:    omise_token ?? null,
            paymentMethod: order.payment_method,
            orderId:       order_id,
            description:   `Ploikong purchase — ${order_id}`,
        });
    } catch (err) {
        console.error('[payment] Omise API error:', err.message);
        return Response.json(
            { error: 'Payment gateway unavailable. Please retry.', detail: err.message },
            { status: 502 }
        );
    }

    if (!chargeResult.success) {
        // Mark payment as failed — buyer will need to retry
        await env.DB.prepare(`
            UPDATE orders SET payment_status='failed', updated_at=? WHERE id=?
        `).bind(now, order_id).run();

        return Response.json({
            error:      'Payment failed',
            omise_code: chargeResult.code,
            message:    chargeResult.error,
            order_id
        }, { status: 402 });
    }

    // ── Save Omise charge_id immediately ──────────────────────────────────────
    // payment_status stays 'pending' until webhook confirms.
    // For PromptPay, Omise returns a QR/authorize_uri for buyer to scan.
    await env.DB.prepare(`
        UPDATE orders SET omise_charge_id=?, updated_at=? WHERE id=?
    `).bind(chargeResult.charge_id, now, order_id).run();

    // ── Return to frontend ────────────────────────────────────────────────────
    const response = {
        order_id,
        charge_id:      chargeResult.charge_id,
        charge_status:  chargeResult.status,
        payment_method: order.payment_method,
        amount:         order.amount,
        message:        chargeResult.status === 'successful'
                            ? 'Payment successful. Waiting for webhook confirmation.'
                            : 'Charge created. Complete payment to confirm your order.',
    };

    if (chargeResult.authorize_uri) {
        response.authorize_uri = chargeResult.authorize_uri;
        response.message = 'Scan the QR code or follow the link to complete PromptPay payment.';
    }

    return Response.json(response, { status: 202 });
}
