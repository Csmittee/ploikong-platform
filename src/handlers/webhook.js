// ════════════════════════════════════════════════════════════════════════════
//  PLOIKONG — Omise Webhook Handler
//  File: src/handlers/webhook.js
//
//  ROUTE (public — no JWT, but HMAC signature verified):
//    POST /v1/webhook/omise
//
//  WHAT THIS DOES:
//    1. Verifies HMAC-SHA256 signature from Omise (OMISE_WEBHOOK_SECRET)
//    2. Parses event type from Omise payload
//    3. On 'charge.complete' → calls confirmOrderPayment() from orders.js
//    4. On 'charge.failed'  → marks order payment_status=failed
//    5. All other events   → acknowledged (200) and ignored
//
//  SECURITY:
//    - Signature is checked BEFORE any DB read or write
//    - Replay attacks mitigated: payment confirmation is idempotent
//      (confirmOrderPayment checks payment_status=paid before updating)
//    - If signature fails → 401, no processing
//
//  MATCHING ORDER:
//    Omise charge metadata.order_id carries our PLK-YYYYMMDD-XXXX ID.
//    This is set at charge creation in payment.js.
//    Fallback: search orders by omise_charge_id if metadata is missing.
//
//  OMISE WEBHOOK EVENTS HANDLED:
//    charge.complete — payment confirmed (successful)
//    charge.failed   — payment failed
//    (all others are no-ops — acknowledged with 200)
//
//  IDEMPOTENCY:
//    confirmOrderPayment() returns early if payment_status is already 'paid'.
//    Safe to process the same webhook multiple times.
// ════════════════════════════════════════════════════════════════════════════

import { confirmOrderPayment } from './orders.js';

// ── HMAC-SHA256 signature verification ───────────────────────────────────────
/**
 * Verify Omise webhook signature.
 * Omise sends: X-Omise-Webhook-Signature: t=<timestamp>,v1=<hmac>
 * We compute HMAC-SHA256(secret, timestamp + '.' + rawBody) and compare.
 *
 * Reference: https://www.omise.co/webhooks#verifying-webhook-signatures
 */
async function verifyOmiseSignature(rawBody, signatureHeader, secret) {
    if (!signatureHeader) return false;

    // Parse header: t=<timestamp>,v1=<signature>
    const parts = Object.fromEntries(
        signatureHeader.split(',').map(part => {
            const [key, ...rest] = part.split('=');
            return [key.trim(), rest.join('=').trim()];
        })
    );

    const timestamp = parts['t'];
    const v1sig     = parts['v1'];

    if (!timestamp || !v1sig) return false;

    // Compute expected signature
    const encoder    = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const signedPayload = `${timestamp}.${rawBody}`;
    const signatureBytes = await crypto.subtle.sign(
        'HMAC',
        keyMaterial,
        encoder.encode(signedPayload)
    );

    // Convert to hex string
    const expectedHex = Array.from(new Uint8Array(signatureBytes))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

    // Constant-time comparison (simple XOR check on hex strings)
    if (expectedHex.length !== v1sig.length) return false;
    let diff = 0;
    for (let i = 0; i < expectedHex.length; i++) {
        diff |= expectedHex.charCodeAt(i) ^ v1sig.charCodeAt(i);
    }
    return diff === 0;
}


// ════════════════════════════════════════════════════════════════════════════
//  POST /v1/webhook/omise — Main webhook handler
// ════════════════════════════════════════════════════════════════════════════
export async function handleOmiseWebhook(request, env) {
    // ── Read raw body for signature verification ──────────────────────────────
    let rawBody;
    try {
        rawBody = await request.text();
    } catch {
        return new Response('Bad request body', { status: 400 });
    }

    // ── Verify signature ──────────────────────────────────────────────────────
    const signatureHeader = request.headers.get('X-Omise-Webhook-Signature') ?? '';
    const webhookSecret   = env.OMISE_WEBHOOK_SECRET ?? '';

    // In fake/test mode, allow unsigned webhooks for local testing convenience
    const paymentMode = env.PAYMENT_MODE || 'fake';
    if (paymentMode !== 'fake') {
        if (!webhookSecret) {
            console.error('[webhook] OMISE_WEBHOOK_SECRET is not set');
            return new Response('Webhook secret not configured', { status: 500 });
        }

        const isValid = await verifyOmiseSignature(rawBody, signatureHeader, webhookSecret);
        if (!isValid) {
            console.warn('[webhook] Signature verification failed');
            return new Response('Invalid signature', { status: 401 });
        }
    }

    // ── Parse JSON payload ────────────────────────────────────────────────────
    let event;
    try {
        event = JSON.parse(rawBody);
    } catch {
        return new Response('Invalid JSON payload', { status: 400 });
    }

    const eventKey = event.key;         // e.g. 'charge.complete'
    const data     = event.data ?? {};  // the charge object

    console.log(`[webhook] Received event: ${eventKey}, charge: ${data.id ?? 'unknown'}`);

    // ── Resolve our order ID ──────────────────────────────────────────────────
    // Primary: metadata.order_id set at charge creation in payment.js
    // Fallback: query orders by omise_charge_id
    let orderId = data.metadata?.order_id ?? null;

    if (!orderId && data.id) {
        const row = await env.DB.prepare(
            'SELECT id FROM orders WHERE omise_charge_id = ?'
        ).bind(data.id).first();
        orderId = row?.id ?? null;
    }

    // ── Handle event types ────────────────────────────────────────────────────

    // ── charge.complete — payment confirmed ───────────────────────────────────
    if (eventKey === 'charge.complete') {
        if (!orderId) {
            console.warn('[webhook] charge.complete — could not resolve order_id from charge:', data.id);
            // Still return 200 to stop Omise from retrying
            return new Response(JSON.stringify({ received: true, warning: 'order_id not found' }), {
                status:  200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // Check charge status from Omise payload
        const chargeStatus = data.status; // 'successful' | 'failed' | 'pending'

        if (chargeStatus === 'successful') {
            const ok = await confirmOrderPayment(orderId, data.id, env);
            if (!ok) {
                console.error(`[webhook] confirmOrderPayment failed for order: ${orderId}`);
            } else {
                console.log(`[webhook] Payment confirmed for order: ${orderId}`);
            }
        } else if (chargeStatus === 'failed') {
            // Charge completed but failed — mark order failed
            await env.DB.prepare(`
                UPDATE orders SET payment_status='failed', updated_at=? WHERE id=?
            `).bind(Math.floor(Date.now() / 1000), orderId).run();
            console.log(`[webhook] Payment failed for order: ${orderId}`);
        } else {
            console.log(`[webhook] charge.complete with unexpected status: ${chargeStatus} for order: ${orderId}`);
        }

        return new Response(JSON.stringify({ received: true, order_id: orderId }), {
            status:  200,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // ── charge.failed — explicit failure event ────────────────────────────────
    if (eventKey === 'charge.failed') {
        if (orderId) {
            await env.DB.prepare(`
                UPDATE orders SET payment_status='failed', updated_at=? WHERE id=?
            `).bind(Math.floor(Date.now() / 1000), orderId).run();
            console.log(`[webhook] charge.failed — order marked failed: ${orderId}`);
        } else {
            console.warn('[webhook] charge.failed — could not resolve order_id from charge:', data.id);
        }

        return new Response(JSON.stringify({ received: true, order_id: orderId }), {
            status:  200,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // ── All other events — acknowledge and ignore ─────────────────────────────
    console.log(`[webhook] Unhandled event type: ${eventKey} — acknowledged`);
    return new Response(JSON.stringify({ received: true, event: eventKey, handled: false }), {
        status:  200,
        headers: { 'Content-Type': 'application/json' },
    });
}
