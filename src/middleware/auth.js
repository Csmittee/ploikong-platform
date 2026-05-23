// ============================================================================
//  src/middleware/auth.js
//  Dual authentication middleware — members AND staff use different tables.
//
//  MEMBER AUTH:
//    Token type: 'member'
//    Checks: members table (status = 'active')
//    Permission: role field (member | broker | admin)
//    Consent: pending_consent flag checked per L064
//
//  STAFF AUTH:
//    Token type: 'staff'
//    Checks: staff table (status = 'active')
//    Permission: explicit flags (can_read_chats, can_approve_brokers, etc.)
//    Consent wall: N/A — staff are not members
//
//  Usage in handlers:
//    const auth = await authenticateMemberJWT(request, env);
//    if (!auth.valid) return Response.json({ error: auth.error }, { status: 401 });
//    const { member } = auth;   // has: id, role, username, pending_consent, ...
//
//    const auth = await authenticateStaffJWT(request, env);
//    if (!auth.valid) return Response.json({ error: auth.error }, { status: 401 });
//    const { staff } = auth;    // has: id, role, can_touch_money, can_read_chats, ...
//
//  Consent wall helper (L064):
//    const block = requireConsent(auth.member);
//    if (block) return block;   // returns 403 JSON response if pending_consent = 1
// ============================================================================

import { verifyJWT, extractBearerToken } from '../utils/jwt.js';

// ── Member JWT authentication ─────────────────────────────────────────────────

/**
 * Authenticate a member JWT from Authorization: Bearer header.
 * Loads fresh member row from DB to catch suspension/ban after token issue.
 *
 * @param {Request} request
 * @param {object}  env        Cloudflare env (needs DB, JWT_SECRET)
 * @returns {Promise<{ valid: boolean, member?: object, error?: string }>}
 */
export async function authenticateMemberJWT(request, env) {
    const token = extractBearerToken(request);
    if (!token) {
        return { valid: false, error: 'Authorization header missing or malformed' };
    }

    const result = await verifyJWT(token, env.JWT_SECRET);
    if (!result.valid) {
        return { valid: false, error: result.error };
    }

    // Enforce token type — prevent staff token used on member route
    if (result.payload.type !== 'member') {
        return { valid: false, error: 'Invalid token type for this endpoint' };
    }

    // Load fresh member row — catches post-issue suspension/ban
    const member = await env.DB.prepare(`
        SELECT id, email, name, username, role, status, pending_consent,
               broker_code, seller_rating, buyer_rating,
               total_sales, total_purchases, language
        FROM members
        WHERE id = ?
    `).bind(result.payload.sub).first();

    if (!member) {
        return { valid: false, error: 'Member account not found' };
    }

    if (member.status !== 'active') {
        const messages = {
            pending:   'Your account is pending approval.',
            suspended: 'Your account has been suspended. Contact support.',
            banned:    'Your account has been banned.',
        };
        return {
            valid: false,
            error: messages[member.status] || 'Account inactive',
            status: 403,
        };
    }

    // Update last_seen (non-blocking — failure doesn't fail auth)
    env.DB.prepare('UPDATE members SET last_seen = ? WHERE id = ?')
        .bind(Math.floor(Date.now() / 1000), member.id)
        .run()
        .catch(() => {});

    return { valid: true, member };
}

// ── Staff JWT authentication ──────────────────────────────────────────────────

/**
 * Authenticate a staff JWT from Authorization: Bearer header.
 * Loads fresh staff row including all permission flags.
 *
 * @param {Request} request
 * @param {object}  env
 * @returns {Promise<{ valid: boolean, staff?: object, error?: string }>}
 */
export async function authenticateStaffJWT(request, env) {
    const token = extractBearerToken(request);
    if (!token) {
        return { valid: false, error: 'Authorization header missing or malformed' };
    }

    const result = await verifyJWT(token, env.JWT_SECRET);
    if (!result.valid) {
        return { valid: false, error: result.error };
    }

    // Enforce token type — prevent member token used on staff route
    if (result.payload.type !== 'staff') {
        return { valid: false, error: 'Invalid token type for this endpoint' };
    }

    // Load fresh staff row with all permission flags
    const staff = await env.DB.prepare(`
        SELECT id, email, name, role, status,
               can_read_chats, can_approve_brokers, can_touch_money, can_export_legal
        FROM staff
        WHERE id = ?
    `).bind(result.payload.sub).first();

    if (!staff) {
        return { valid: false, error: 'Staff account not found' };
    }

    if (staff.status !== 'active') {
        return { valid: false, error: 'Staff account is not active', status: 403 };
    }

    // Update last_seen (non-blocking)
    env.DB.prepare('UPDATE staff SET last_seen = ? WHERE id = ?')
        .bind(Math.floor(Date.now() / 1000), staff.id)
        .run()
        .catch(() => {});

    return { valid: true, staff };
}

// ── Role guards for staff routes ──────────────────────────────────────────────

/**
 * Require a specific staff role or the owner role.
 * Usage: const block = requireStaffRole(auth.staff, ['ops_manager', 'owner']);
 *        if (block) return block;
 *
 * @param {object}   staff         From authenticateStaffJWT
 * @param {string[]} allowedRoles  Array of roles that may proceed
 * @returns {Response|null}        403 Response if denied, null if allowed
 */
export function requireStaffRole(staff, allowedRoles) {
    if (staff.role === 'owner') return null;  // owner always passes
    if (allowedRoles.includes(staff.role)) return null;
    return Response.json(
        { error: `This action requires one of: ${allowedRoles.join(', ')}` },
        { status: 403 }
    );
}

/**
 * Require a specific permission flag on the staff account.
 * Usage: const block = requirePermission(auth.staff, 'can_touch_money');
 *        if (block) return block;
 *
 * @param {object} staff
 * @param {string} flag    Column name from staff table
 * @returns {Response|null}
 */
export function requirePermission(staff, flag) {
    if (staff.role === 'owner') return null;  // owner always passes
    if (staff[flag] === 1) return null;
    return Response.json(
        { error: `This action requires the '${flag}' permission` },
        { status: 403 }
    );
}

// ── Consent wall (L064) ───────────────────────────────────────────────────────

/**
 * Block transactional actions when member has unsigned legal documents.
 * Call this at the start of any buy / bid / sell / message handler.
 * DO NOT call on browsing routes (GET /listings, GET /listings/:slug).
 *
 * @param {object} member   From authenticateMemberJWT
 * @returns {Response|null} 403 Response if blocked, null if clear
 */
export function requireConsent(member) {
    if (member.pending_consent !== 1) return null;
    return Response.json(
        {
            error:    'consent_required',
            message:  'Please review and sign the updated Terms of Service to continue.',
            redirect: '/consent',
        },
        { status: 403 }
    );
}

// ── Broker-only guard ─────────────────────────────────────────────────────────

/**
 * Require member to have broker role.
 * @param {object} member
 * @returns {Response|null}
 */
export function requireBroker(member) {
    if (member.role === 'broker' || member.role === 'admin') return null;
    return Response.json(
        { error: 'This action requires Verified Broker status.' },
        { status: 403 }
    );
}
