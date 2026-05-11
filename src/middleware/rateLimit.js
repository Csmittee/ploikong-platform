// ════════════════════════════════════════════════════════════════════════════
//  PLOIKONG — Rate Limit Middleware
//  File: src/middleware/rateLimit.js
//
//  D1-backed sliding window rate limiter.
//  Identical pattern to Satu — adapted for Ploikong route tiers.
//
//  TIERS (requests per window):
//    auth      — 10 / 60s   (register, login)
//    write     — 30 / 60s   (POST/PUT/DELETE listings, bids, orders, offers)
//    read      — 120 / 60s  (GET listings, search, profile)
//    global    — 200 / 60s  (catch-all fallback)
//
//  Window key: floor(unix_seconds / 60) — one row per IP per minute.
//  Cleanup cron (job 7 in index.js) deletes rows older than 5 minutes.
//
//  USAGE — in index.js, wrap any handler:
//    import { rateLimit } from './middleware/rateLimit.js';
//
//    // Auth route:
//    return rateLimit(request, env, () => handleLogin(request, env), 'auth');
//
//    // Write route (default tier = 'write'):
//    return rateLimit(request, env, () => handleCreateListing(request, env), 'write');
//
//    // Read route:
//    return rateLimit(request, env, () => handleGetListings(request, env), 'read');
//
//  NOTE (L073): Do not uncomment rateLimit calls in index.js until this file
//  is physically deployed. Swap in one route at a time after confirming health.
// ════════════════════════════════════════════════════════════════════════════

// ── Limits per tier ───────────────────────────────────────────────────────────
const TIER_LIMITS = {
    auth:   10,   // login / register — most restrictive
    write:  30,   // create/edit/delete — moderate
    read:   120,  // browse/search — generous
    global: 200,  // fallback
};

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * rateLimit — wraps a handler with D1-backed rate limiting.
 *
 * @param {Request}  request  — the incoming Cloudflare Request
 * @param {Env}      env      — Cloudflare Worker env (needs env.DB)
 * @param {Function} handler  — async () => Response
 * @param {string}   tier     — 'auth' | 'write' | 'read' | 'global'
 * @returns {Promise<Response>}
 */
export async function rateLimit(request, env, handler, tier = 'global') {
    const ip    = getClientIP(request);
    const limit = TIER_LIMITS[tier] ?? TIER_LIMITS.global;

    const allowed = await checkAndIncrement(env, ip, tier, limit);

    if (!allowed) {
        return Response.json(
            {
                error:   'rate_limit_exceeded',
                message: 'Too many requests. Please wait a moment and try again.',
                tier,
                limit,
            },
            {
                status: 429,
                headers: { 'Retry-After': '60' },
            }
        );
    }

    return handler();
}

// ── Check current count and increment atomically ──────────────────────────────
/**
 * Returns true if the request is allowed, false if it exceeds the limit.
 * Uses a single UPSERT for atomic increment — safe under concurrent requests.
 *
 * Window key: floor(unix_seconds / 60) — one row per IP per minute.
 * Key format: "{tier}:{ip}" so the same IP can have separate counters per tier.
 */
async function checkAndIncrement(env, ip, tier, limit) {
    const now       = Math.floor(Date.now() / 1000);
    const windowKey = Math.floor(now / 60);
    const rowKey    = `${tier}:${ip}`;   // distinguishes auth vs write vs read limits

    try {
        // Read current count first (fast path — avoids write on every request)
        const existing = await env.DB.prepare(
            `SELECT count FROM rate_limit_counters WHERE ip = ? AND window_key = ?`
        ).bind(rowKey, windowKey).first();

        if (existing && existing.count >= limit) {
            return false;  // already over limit — reject before incrementing
        }

        // Atomic UPSERT: insert if new window, increment if exists
        await env.DB.prepare(`
            INSERT INTO rate_limit_counters (ip, window_key, count)
            VALUES (?, ?, 1)
            ON CONFLICT(ip, window_key) DO UPDATE SET count = count + 1
        `).bind(rowKey, windowKey).run();

        return true;

    } catch (err) {
        // If D1 is unavailable, fail open — never block legitimate traffic on DB error
        console.error('[rateLimit] D1 error — failing open:', err.message);
        return true;
    }
}

// ── Extract client IP ─────────────────────────────────────────────────────────
/**
 * Cloudflare Workers expose the real client IP in CF-Connecting-IP header.
 * Falls back to X-Forwarded-For, then 'unknown'.
 */
function getClientIP(request) {
    return (
        request.headers.get('CF-Connecting-IP') ||
        request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
        'unknown'
    );
}

// ── Rate limit status helper (for admin dashboard / debugging) ─────────────────
/**
 * getRateLimitStatus — returns current hit counts for a given IP.
 * Used by admin dashboard to inspect or clear limits.
 * Not exported to public routes — admin-only.
 *
 * @param {Env}    env
 * @param {string} ip
 * @returns {Promise<Array>}
 */
export async function getRateLimitStatus(env, ip) {
    const windowKey = Math.floor(Date.now() / 1000 / 60);

    const rows = await env.DB.prepare(`
        SELECT ip, window_key, count
        FROM rate_limit_counters
        WHERE ip LIKE ? AND window_key >= ?
        ORDER BY window_key DESC
        LIMIT 20
    `).bind(`%:${ip}`, windowKey - 5).all();

    return rows.results ?? [];
}

/**
 * clearRateLimit — removes all current window rows for an IP.
 * Admin use only — when a legitimate user gets blocked by mistake.
 *
 * @param {Env}    env
 * @param {string} ip
 * @returns {Promise<number>} rows deleted
 */
export async function clearRateLimit(env, ip) {
    const result = await env.DB.prepare(
        `DELETE FROM rate_limit_counters WHERE ip LIKE ?`
    ).bind(`%:${ip}`).run();

    return result.meta?.changes ?? 0;
}
