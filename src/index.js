// ════════════════════════════════════════════════════════════════════════════
//  PLOIKONG API — Main Router
//  File: src/index.js
//  Domain: api.ploikong.com
//
//  ROUTE MAP:
//    Public:          GET  /health, GET /
//    Auth:            POST /v1/auth/register, /login, /staff/login
//    Listings:        GET/POST /v1/listings, GET /v1/listings/:slug
//    Search:          GET  /v1/search
//    Members:         GET  /v1/members/:username (public showroom)
//    Stories:         GET  /v1/stories, GET /v1/stories/:id
//    Webhook:         POST /v1/webhook/omise
//    JWT-protected:   /v1/me/*, /v1/orders/*, /v1/bids/*, /v1/offers/*
//                     /v1/chat/*, /v1/watchlist/*, /v1/search/saved
//    Staff JWT:       /v1/staff/*, /v1/admin/*
//    Admin dashboard: GET  /admin (X-Admin-Token header)
//
//  HANDLER FILES (build one per chat session):
//    src/handlers/auth.js        — register, login, staff login
//    src/handlers/listings.js    — CRUD, slug, broker listing
//    src/handlers/search.js      — search, filter, saved searches
//    src/handlers/members.js     — profile, showroom, watchlist
//    src/handlers/orders.js      — create order, escrow, confirm delivery
//    src/handlers/payment.js     — Omise charge creation
//    src/handlers/webhook.js     — Omise webhook handler
//    src/handlers/bids.js        — auction engine, auto-bid
//    src/handlers/offers.js      — direct, counter, mass offer
//    src/handlers/chat.js        — DM, flagging, broker monitoring
//    src/handlers/stories.js     — collector blog CRUD
//    src/handlers/broker.js      — application pipeline, compliance
//    src/handlers/legal.js       — document deploy, consent wall, export
//    src/handlers/admin.js       — member approval, config dashboard, DB viewer
//    src/handlers/cron.js        — all 8 scheduled job functions
//
//  MIDDLEWARE FILES:
//    src/middleware/auth.js       — JWT verify for members + staff (dual auth)
//    src/middleware/rateLimit.js  — D1-backed rate limiter (copy from Satu)
//    src/middleware/logging.js    — audit trail logger (copy from Satu)
//
//  UTILITY FILES:
//    src/utils/jwt.js            — generate/verify JWT (copy from Satu)
//    src/utils/crypto.js         — AES-256-GCM encrypt/decrypt
//    src/utils/slugify.js        — URL-safe listing slugs
//    src/utils/email.js          — Zoho OAuth email queue helper
// ════════════════════════════════════════════════════════════════════════════

// ── Handlers (uncomment as each file is built) ───────────────────────────────
 import { handleRegister, handleLogin, handleStaffLogin } from './handlers/auth.js';
 import { handleGetListings, handleGetListing, handleCreateListing, handleUpdateListing, handleDeleteListing } from './handlers/listings.js';
 import { handleSearch } from './handlers/search.js';
// import { handleGetMemberProfile } from './handlers/members.js';
// import { handleGetStories, handleGetStory } from './handlers/stories.js';
 import { handleOmiseWebhook } from './handlers/webhook.js';
 import { handleCreateOrder, handleGetOrder, handleConfirmDelivery } from './handlers/orders.js';
// import { handlePlaceBid, handleGetBids } from './handlers/bids.js';
// import { handleCreateOffer, handleRespondOffer, handleMassOffer } from './handlers/offers.js';
// import { handleGetInbox, handleGetConversation, handleSendMessage } from './handlers/chat.js';
// import { handleAdminDashboard, handleAdminTableData, handleAdminConfig } from './handlers/admin.js';

// ── Middleware ────────────────────────────────────────────────────────────────
 import { authenticateMemberJWT, authenticateStaffJWT, requireStaffRole } from './middleware/auth.js';
 import { rateLimit } from './middleware/rateLimit.js';
// import { logRequest } from './middleware/logging.js';

export default {

    // ════════════════════════════════════════════════════════════════════════
    //  HTTP HANDLER
    // ════════════════════════════════════════════════════════════════════════
    async fetch(request, env, ctx) {
        const url    = new URL(request.url);
        const path   = url.pathname;
        const method = request.method;

        // ── CORS headers — allow ploikong.com frontend ───────────────────────
        const corsHeaders = {
            'Access-Control-Allow-Origin':  env.ENVIRONMENT === 'development' ? '*' : 'https://ploikong.com',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token',
        };

        if (method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        // Wrap all responses with CORS headers
        const respond = (body, init = {}) => {
            const res = body instanceof Response ? body : Response.json(body, init);
            Object.entries(corsHeaders).forEach(([k, v]) => res.headers.set(k, v));
            return res;
        };

        // Non-blocking audit log — never delays or breaks requests
        // ctx.waitUntil(logRequest(request, env)); // uncomment when logging.js is built

        // ════════════════════════════════════════════════════════════════════
        //  PUBLIC ROUTES — no auth required
        // ════════════════════════════════════════════════════════════════════

        // ── Health check ─────────────────────────────────────────────────────
        if (path === '/health' && method === 'GET') {
            return respond({
                status:          'ok',
                service:         'Ploikong API',
                timestamp:       Date.now(),
                environment:     env.ENVIRONMENT    || 'development',
                payment_mode:    env.PAYMENT_MODE   || 'fake',
                version:         '1.0.0'
            });
        }

        // ── Root ─────────────────────────────────────────────────────────────
        if (path === '/' && method === 'GET') {
            return respond({
                service:  'Ploikong API',
                status:   'running',
                docs:     'https://ploikong.com/api-docs',
                endpoints: [
                    'GET  /health',
                    'POST /v1/auth/register',
                    'POST /v1/auth/login',
                    'GET  /v1/listings',
                    'GET  /v1/listings/:slug',
                    'GET  /v1/search',
                    'GET  /v1/members/:username',
                    'GET  /v1/stories',
                ]
            });
        }

        // ── Omise webhook (public — signature verified inside handler) ────────
        if (path === '/v1/webhook/omise' && method === 'POST') {
            // return handleOmiseWebhook(request, env);
            return handleOmiseWebhook(request, env);
        }

     // ════════════════════════════════════════════════════════════════════
        //  AUTH ROUTES — rate limited when rateLimit.js is built
        // ════════════════════════════════════════════════════════════════════

        if (path === '/v1/auth/register' && method === 'POST') {
            // return rateLimit(request, env, () => handleRegister(request, env));
            return handleRegister(request, env);
        }

        if (path === '/v1/auth/login' && method === 'POST') {
            // return rateLimit(request, env, () => handleLogin(request, env));
            return handleLogin(request, env);
        }

        if (path === '/v1/auth/staff/login' && method === 'POST') {
            // return rateLimit(request, env, () => handleStaffLogin(request, env));
            return handleStaffLogin(request, env);
        }

        // ════════════════════════════════════════════════════════════════════
        //  PUBLIC LISTING ROUTES — browsing allowed without login
        // ════════════════════════════════════════════════════════════════════

        if (path === '/v1/listings' && method === 'GET') {
            // return handleGetListings(request, env);
            return handleGetListings(request, env);
        }

        if (path.match(/^\/v1\/listings\/[^/]+$/) && method === 'GET') {
            const slug = path.split('/')[3];
            // return handleGetListing(slug, env);
            return handleGetListing(slug, env);
        }

        if (path === '/v1/search' && method === 'GET') {
            // return handleSearch(request, env);
            return handleSearch(request, env);
        }

        if (path.match(/^\/v1\/members\/[^/]+$/) && method === 'GET') {
            const username = path.split('/')[3];
            // return handleGetMemberProfile(username, env);
            return respond({ error: 'Members handler not yet built' }, { status: 503 });
        }

        if (path === '/v1/stories' && method === 'GET') {
            // return handleGetStories(request, env);
            return respond({ error: 'Stories handler not yet built' }, { status: 503 });
        }

        if (path.match(/^\/v1\/stories\/\d+$/) && method === 'GET') {
            const storyId = path.split('/')[3];
            // return handleGetStory(storyId, env);
            return respond({ error: 'Stories handler not yet built' }, { status: 503 });
        }

        // ════════════════════════════════════════════════════════════════════
        //  ADMIN DASHBOARD — X-Admin-Token header required
        //  Access: browser → api.ploikong.com/admin
        //          enter token when prompted
        // ════════════════════════════════════════════════════════════════════
        const ADMIN_PATH = env.ADMIN_PATH || '/admin';

        if (path === ADMIN_PATH || path.startsWith(ADMIN_PATH + '/api/')) {
            const token = request.headers.get('X-Admin-Token');
            if (!env.ADMIN_SECRET || !token || token !== env.ADMIN_SECRET) {
                return new Response('Forbidden', { status: 403 });
            }

            if (method === 'GET' && path === ADMIN_PATH) {
                // return handleAdminDashboard(env, ADMIN_PATH);
                return new Response('<h1>Ploikong Admin — handler not yet built</h1>', {
                    headers: { 'Content-Type': 'text/html' }
                });
            }

            if (method === 'GET' && path.startsWith(ADMIN_PATH + '/api/')) {
                const tableName = path.split('/').pop();
                // return handleAdminTableData(tableName, env);
                return respond({ error: 'Admin table handler not yet built' }, { status: 503 });
            }

            if (method === 'POST' && path === ADMIN_PATH + '/api/config') {
                // return handleAdminConfig(request, env);
                return respond({ error: 'Config handler not yet built' }, { status: 503 });
            }
        }

        // ════════════════════════════════════════════════════════════════════
        //  STAFF JWT ROUTES — requires staff token (separate from member JWT)
        //  Staff login: POST /v1/auth/staff/login → returns staff JWT
        //  Header: Authorization: Bearer <staff_jwt>
        // ════════════════════════════════════════════════════════════════════

        if (path.startsWith('/v1/staff/') || path.startsWith('/v1/admin/')) {
            // const staffAuth = await authenticateStaffJWT(request, env);
            // if (!staffAuth.valid) return respond({ error: 'Unauthorized' }, { status: 401 });

            // ── Member management ──────────────────────────────────────────
            // GET  /v1/admin/members          — list all members + filter
            // POST /v1/admin/members/:id/approve
            // POST /v1/admin/members/:id/suspend
            // POST /v1/admin/members/:id/ban

            // ── Broker management ──────────────────────────────────────────
            // GET  /v1/admin/brokers          — vetting pipeline
            // POST /v1/admin/brokers/:id/advance — move to next phase
            // POST /v1/admin/brokers/:id/approve
            // POST /v1/admin/brokers/:id/reject
            // POST /v1/admin/brokers/:id/suspend
            // GET  /v1/admin/brokers/:id/compliance
            // POST /v1/admin/brokers/:id/flag

            // ── Legal management ───────────────────────────────────────────
            // GET  /v1/admin/legal            — all document versions
            // POST /v1/admin/legal            — upload new version
            // POST /v1/admin/legal/:id/publish — deploy + trigger consent wall
            // GET  /v1/admin/legal/export/:memberId — lawyer consent export

            // ── Platform config ────────────────────────────────────────────
            // GET  /v1/admin/config           — all platform_config rows
            // PUT  /v1/admin/config/:key      — update a config value

            // ── Dispute management ─────────────────────────────────────────
            // GET  /v1/admin/disputes         — open disputes
            // POST /v1/admin/disputes/:orderId/resolve

            return respond({ error: 'Staff routes — handlers not yet built' }, { status: 503 });
        }

        // ════════════════════════════════════════════════════════════════════
        //  MEMBER JWT ROUTES — requires member token
        //  Login: POST /v1/auth/login → returns member JWT
        //  Header: Authorization: Bearer <member_jwt>
        //
        //  NOTE: Check pending_consent=1 in every transactional route below.
        //  Browsing routes above do NOT require consent check.
        //  See LESSON_LEARN.md L064 for the pattern.
        // ════════════════════════════════════════════════════════════════════

        // Authenticate all routes below this point
        // const auth = await authenticateMemberJWT(request, env);
        // if (!auth.valid) return respond({ error: 'Unauthorized' }, { status: 401 });

        // ── My profile ────────────────────────────────────────────────────
        // GET  /v1/me              — my profile
        // PUT  /v1/me              — update profile
        // GET  /v1/me/watchlist    — my watchlist
        // GET  /v1/me/orders       — my purchases
        // GET  /v1/me/listings     — my listings
        // GET  /v1/me/bids         — my active bids
        // GET  /v1/me/offers       — my offers sent/received
        // GET  /v1/me/notifications — unread count + list

        // ── Listing actions (authenticated) ───────────────────────────────
        // POST /v1/listings             — create listing
        // PUT  /v1/listings/:id         — edit my listing
        // DELETE /v1/listings/:id       — remove my listing
        // POST /v1/listings/:id/watch   — add to watchlist
        // DELETE /v1/listings/:id/watch — remove from watchlist

        // ── Search ────────────────────────────────────────────────────────
        // POST /v1/search/save         — save search with alert
        // GET  /v1/search/saved        — my saved searches
        // DELETE /v1/search/saved/:id  — delete saved search

        // ── Orders ────────────────────────────────────────────────────────
        // POST /v1/orders              — create order (buy now)
        // GET  /v1/orders/:id          — order detail
        // POST /v1/orders/:id/confirm  — buyer confirms delivery
        // POST /v1/orders/:id/dispute  — raise dispute

        // ── Bids ──────────────────────────────────────────────────────────
        // POST /v1/bids                — place bid on auction listing
        // GET  /v1/bids/:listingId     — bid history for listing
        // POST /v1/bids/auto           — set auto-bid ceiling

        // ── Offers ────────────────────────────────────────────────────────
        // POST /v1/offers              — buyer sends offer
        // POST /v1/offers/:id/respond  — seller accepts/rejects/counters
        // POST /v1/offers/mass         — seller sends mass offer to watchers

        // ── Chat ─────────────────────────────────────────────────────────
        // GET  /v1/chat                — inbox
        // GET  /v1/chat/:memberId      — conversation thread
        // POST /v1/chat/:memberId      — send message

        // ── Stories ───────────────────────────────────────────────────────
        // POST /v1/stories             — create story
        // PUT  /v1/stories/:id         — edit my story

        // ── Consent ───────────────────────────────────────────────────────
        // GET  /v1/consent/pending     — get unsigned documents
        // POST /v1/consent/sign        — sign a document version

        // All member routes return 503 until handlers are built
        return respond({ error: 'Not found' }, { status: 404 });
    },

    // ════════════════════════════════════════════════════════════════════════
    //  CRON HANDLER — fires every 6 hours
    //  Defined in wrangler.toml: crons = ["0 */6 * * *"]
    //  All 8 jobs run in parallel — one failure never blocks the others
    // ════════════════════════════════════════════════════════════════════════
    async scheduled(event, env, ctx) {
        ctx.waitUntil(runScheduledJobs(event, env));
    }
};

// ════════════════════════════════════════════════════════════════════════════
//  SCHEDULED JOB RUNNER
//  Each job is wrapped in Promise.allSettled — runs all 8 regardless of errors
// ════════════════════════════════════════════════════════════════════════════
async function runScheduledJobs(event, env) {
    const now = Math.floor(Date.now() / 1000);
    console.log(`[cron] Ploikong scheduled trigger at ${now} (${event.cron})`);

    await Promise.allSettled([
        cronJob(env, now, 'expire_listings',       () => expireListings(env, now)),
        cronJob(env, now, 'release_payouts',        () => releasePayouts(env, now)),
        cronJob(env, now, 'process_notifications',  () => processNotifications(env, now)),
        cronJob(env, now, 'check_saved_searches',   () => checkSavedSearches(env, now)),
        cronJob(env, now, 'broker_compliance_due',  () => brokerComplianceDue(env, now)),
        cronJob(env, now, 'check_insurance_expiry', () => checkInsuranceExpiry(env, now)),
        cronJob(env, now, 'cleanup_rate_limits',    () => cleanupRateLimits(env, now)),
        cronJob(env, now, 'expire_offers',          () => expireOffers(env, now)),
    ]);
}

// ── Cron job wrapper — logs start/finish to cron_log table ───────────────────
async function cronJob(env, now, jobName, fn) {
    let logId = null;
    try {
        const result = await env.DB.prepare(
            `INSERT INTO cron_log (job_name, started_at, status) VALUES (?, ?, 'running')`
        ).bind(jobName, now).run();
        logId = result.meta?.last_row_id ?? null;

        const rowsAffected = await fn();

        if (logId) {
            await env.DB.prepare(
                `UPDATE cron_log SET finished_at=?, status='ok', rows_affected=? WHERE id=?`
            ).bind(Math.floor(Date.now()/1000), rowsAffected ?? 0, logId).run();
        }
        console.log(`[cron] ${jobName}: ok (${rowsAffected ?? 0} rows)`);
    } catch (err) {
        console.error(`[cron] ${jobName} failed:`, err.message);
        if (logId) {
            await env.DB.prepare(
                `UPDATE cron_log SET finished_at=?, status='error', error_msg=? WHERE id=?`
            ).bind(Math.floor(Date.now()/1000), err.message, logId).run().catch(() => {});
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  CRON JOB IMPLEMENTATIONS
//  These are self-contained — no external handler files needed.
//  Complex jobs (notifications, saved searches) move to cron.js when grown.
// ════════════════════════════════════════════════════════════════════════════

// JOB 1 — Expire auctions past their end time
async function expireListings(env, now) {
    const r = await env.DB.prepare(`
        UPDATE listings SET status='expired'
        WHERE status='active' AND selling_type IN ('auction','buy_now')
        AND auction_end IS NOT NULL AND auction_end < ?
    `).bind(now).run();
    return r.meta?.changes ?? 0;
}

// JOB 2 — Release seller payouts when payout_due_at has passed
async function releasePayouts(env, now) {
    const r = await env.DB.prepare(`
        UPDATE orders SET escrow_status='released', payout_released_at=?
        WHERE escrow_status='holding'
        AND payout_due_at IS NOT NULL AND payout_due_at < ?
        AND status='delivered'
    `).bind(now, now).run();
    // TODO: queue payout_released notification for each affected seller
    return r.meta?.changes ?? 0;
}

// JOB 3 — Send queued notification emails via Zoho (max 3 attempts)
async function processNotifications(env, now) {
    const pending = await env.DB.prepare(`
        SELECT * FROM notification_queue
        WHERE status='queued' AND attempts < 3
        ORDER BY created_at ASC LIMIT 50
    `).all();

    let sent = 0;
    for (const notif of pending.results ?? []) {
        try {
            // TODO: call Zoho OAuth email sender (src/utils/email.js)
            // await sendEmail(env, notif.to_email, notif.template, JSON.parse(notif.payload || '{}'));
            await env.DB.prepare(
                `UPDATE notification_queue SET status='sent', sent_at=?, attempts=attempts+1 WHERE id=?`
            ).bind(now, notif.id).run();
            sent++;
        } catch (err) {
            await env.DB.prepare(
                `UPDATE notification_queue SET attempts=attempts+1, last_attempt_at=?, error_msg=?,
                 status=CASE WHEN attempts+1 >= 3 THEN 'failed' ELSE 'queued' END WHERE id=?`
            ).bind(now, err.message, notif.id).run();
        }
    }
    return sent;
}

// JOB 4 — Match new listings to saved searches and queue alert emails
async function checkSavedSearches(env, now) {
    // Simplified: flag saved searches that have never been alerted
    // Full implementation in src/handlers/cron.js when search handler is built
    const searches = await env.DB.prepare(`
        SELECT id, member_id, query FROM saved_searches
        WHERE alert_enabled=1 AND (last_alerted IS NULL OR last_alerted < ?)
    `).bind(now - 21600).all(); // last 6 hours
    // TODO: match against new listings, queue notification_queue rows
    return searches.results?.length ?? 0;
}

// JOB 5 — Flag brokers whose 14-day compliance check is overdue
async function brokerComplianceDue(env, now) {
    const config = await env.DB.prepare(
        `SELECT value FROM platform_config WHERE key='compliance_check_days'`
    ).first();
    const days = parseInt(config?.value ?? '14');
    const cutoff = now - (days * 86400);

    const brokers = await env.DB.prepare(`
        SELECT m.id, m.email FROM members m
        WHERE m.role='broker' AND m.status='active'
        AND NOT EXISTS (
            SELECT 1 FROM broker_compliance_checks bcc
            WHERE bcc.broker_member_id = m.id AND bcc.scheduled_at > ?
        )
    `).bind(cutoff).all();

    for (const broker of brokers.results ?? []) {
        await env.DB.prepare(`
            INSERT INTO broker_compliance_checks
            (broker_member_id, check_type, scheduled_at, result, lawyer_notified, created_at)
            VALUES (?, 'scheduled_14day', ?, 'pending', 1, ?)
        `).bind(broker.id, now, now).run();
        // TODO: queue notification to compliance_auditor and owner
    }
    return brokers.results?.length ?? 0;
}

// JOB 6 — Warn brokers 30 days before insurance expiry, suspend on expiry day
async function checkInsuranceExpiry(env, now) {
    const config = await env.DB.prepare(
        `SELECT value FROM platform_config WHERE key='insurance_warn_days'`
    ).first();
    const warnDays = parseInt(config?.value ?? '30');
    const warnCutoff = now + (warnDays * 86400);

    // Suspend brokers whose insurance has already expired
    const expired = await env.DB.prepare(`
        UPDATE members SET status='suspended'
        WHERE role='broker' AND status='active'
        AND id IN (
            SELECT member_id FROM broker_applications
            WHERE phase='approved' AND insurance_expiry_date < ?
        )
    `).bind(now).run();

    // Queue warning emails for brokers expiring within warn window
    const expiring = await env.DB.prepare(`
        SELECT m.id, m.email FROM members m
        JOIN broker_applications ba ON ba.member_id = m.id
        WHERE m.role='broker' AND m.status='active'
        AND ba.insurance_expiry_date BETWEEN ? AND ?
    `).bind(now, warnCutoff).all();

    for (const broker of expiring.results ?? []) {
        await env.DB.prepare(`
            INSERT OR IGNORE INTO notification_queue
            (member_id, to_email, template, status, created_at)
            VALUES (?, ?, 'insurance_expiring', 'queued', ?)
        `).bind(broker.id, broker.email, now).run();
    }
    return (expired.meta?.changes ?? 0) + (expiring.results?.length ?? 0);
}

// JOB 7 — Delete stale rate limit counter rows (older than 5 minutes)
async function cleanupRateLimits(env, now) {
    const cutoffWindow = Math.floor(now / 60) - 5;
    const r = await env.DB.prepare(
        `DELETE FROM rate_limit_counters WHERE window_key < ?`
    ).bind(cutoffWindow).run();
    return r.meta?.changes ?? 0;
}

// JOB 8 — Expire offers past their expires_at timestamp
async function expireOffers(env, now) {
    const r = await env.DB.prepare(`
        UPDATE offers SET status='expired'
        WHERE status='pending' AND expires_at IS NOT NULL AND expires_at < ?
    `).bind(now).run();
    return r.meta?.changes ?? 0;
}
