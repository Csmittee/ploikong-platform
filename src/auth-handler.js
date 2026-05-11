// ============================================================================
//  src/handlers/auth.js
//  Auth handler — three endpoints:
//
//  POST /v1/auth/register     → INSERT membership_applications row
//                               Invitation-only phase. No members row yet.
//                               Future public launch = skip this, direct to members.
//
//  POST /v1/auth/login        → checks members table, returns member JWT
//
//  POST /v1/auth/staff/login  → checks staff table, returns staff JWT
//
//  Key rules (MASTER_SEED decisions):
//  - Registration = application only. members row created only after admin approves.
//  - Member JWT payload: { sub: id, role, type: 'member' }
//  - Staff JWT payload:  { sub: id, role, type: 'staff' }
//  - Password hashing: uses bcrypt-compatible PBKDF2 via Web Crypto (no npm)
//  - Rate limiting: handled by rateLimit middleware in index.js, not here
// ============================================================================

import { generateJWT } from '../utils/jwt.js';

// ── Password helpers (PBKDF2 — Web Crypto, no npm) ───────────────────────────
// Note: bcrypt is not available in Workers. PBKDF2 with SHA-256, 100k iterations
// is the Web Crypto equivalent. Existing bcrypt hashes (staff seed) are handled
// separately — regenerate staff passwords using this function before going live.

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH       = 'SHA-256';
const PBKDF2_KEY_LEN    = 32;   // bytes

/**
 * Hash a password with PBKDF2 + random salt.
 * Returns "pbkdf2$<salt_hex>$<hash_hex>"
 */
async function hashPassword(plaintext) {
    const salt       = crypto.getRandomValues(new Uint8Array(16));
    const saltHex    = Array.from(salt).map(b => b.toString(16).padStart(2,'0')).join('');
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(plaintext),
        { name: 'PBKDF2' },
        false,
        ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
        keyMaterial,
        PBKDF2_KEY_LEN * 8
    );
    const hashHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2,'0')).join('');
    return `pbkdf2$${saltHex}$${hashHex}`;
}

/**
 * Verify a plaintext password against a stored hash.
 * Supports both "pbkdf2$..." format (Workers) and "$2a$..." bcrypt (seed data).
 * For bcrypt hashes from seed data: replace them using hashPassword() before live use.
 */
async function verifyPassword(plaintext, stored) {
    if (!stored) return false;

    // Bcrypt placeholder from seed data — always fails (forces password reset by owner)
    if (stored.startsWith('$2a$')) {
        return false;  // owner must set real password via admin dashboard
    }

    if (!stored.startsWith('pbkdf2$')) return false;

    const [, saltHex, expectedHex] = stored.split('$');
    const salt = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));

    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(plaintext),
        { name: 'PBKDF2' },
        false,
        ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
        keyMaterial,
        PBKDF2_KEY_LEN * 8
    );
    const hashHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2,'0')).join('');

    // Constant-time comparison (prevent timing attacks)
    if (hashHex.length !== expectedHex.length) return false;
    let diff = 0;
    for (let i = 0; i < hashHex.length; i++) {
        diff |= hashHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
    }
    return diff === 0;
}

// ── Validation helpers ────────────────────────────────────────────────────────

function isValidEmail(email) {
    return typeof email === 'string' &&
           email.length >= 5 &&
           email.length <= 254 &&
           /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sanitizeText(str, maxLen = 500) {
    if (!str || typeof str !== 'string') return '';
    return str.trim().slice(0, maxLen);
}

// ── POST /v1/auth/register ────────────────────────────────────────────────────

/**
 * Membership application (invitation-only phase).
 * Creates a membership_applications row. NOT a members row.
 * Admin approves → members row created later (in admin handler).
 *
 * Required body: { email, name, what_they_collect }
 * Optional body: { phone, line_id, referral_source, application_text }
 */
export async function handleRegister(request, env) {
    let body;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { email, name, phone, line_id, what_they_collect, referral_source, application_text } = body;

    // Required field validation
    if (!isValidEmail(email)) {
        return Response.json({ error: 'Valid email address is required' }, { status: 400 });
    }
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
        return Response.json({ error: 'Name is required (minimum 2 characters)' }, { status: 400 });
    }
    if (!what_they_collect || typeof what_they_collect !== 'string' || what_they_collect.trim().length < 10) {
        return Response.json({
            error: 'Please tell us what you collect (minimum 10 characters)'
        }, { status: 400 });
    }

    const now = Math.floor(Date.now() / 1000);

    // Check: already have a pending application from this email?
    const existing = await env.DB.prepare(
        'SELECT id, status FROM membership_applications WHERE email = ? ORDER BY created_at DESC LIMIT 1'
    ).bind(email.toLowerCase()).first();

    if (existing) {
        const messages = {
            pending:  'An application from this email is already under review. We will contact you within 48 hours.',
            approved: 'This email already has an approved account. Please sign in.',
            waitlist: 'This email is on our waitlist. We will contact you when a spot opens.',
        };
        if (existing.status !== 'rejected') {
            return Response.json(
                { error: messages[existing.status] || 'An application already exists for this email.' },
                { status: 409 }
            );
        }
        // Rejected applications may re-apply — fall through
    }

    // Also check if email is already a member
    const existingMember = await env.DB.prepare(
        'SELECT id FROM members WHERE email = ?'
    ).bind(email.toLowerCase()).first();

    if (existingMember) {
        return Response.json(
            { error: 'This email already has an active account. Please sign in.' },
            { status: 409 }
        );
    }

    // Insert application
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || null;

    await env.DB.prepare(`
        INSERT INTO membership_applications
            (email, name, phone, line_id, what_they_collect, referral_source,
             application_text, status, ip_address, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).bind(
        email.toLowerCase(),
        sanitizeText(name, 100),
        sanitizeText(phone, 30) || null,
        sanitizeText(line_id, 50) || null,
        sanitizeText(what_they_collect, 1000),
        sanitizeText(referral_source, 200) || null,
        sanitizeText(application_text, 3000) || null,
        ip,
        now
    ).run();

    // Queue welcome acknowledgement email (non-blocking — L067)
    env.DB.prepare(`
        INSERT INTO notification_queue
            (to_email, template, payload, status, created_at)
        VALUES (?, 'application_received', ?, 'queued', ?)
    `).bind(
        email.toLowerCase(),
        JSON.stringify({ name: sanitizeText(name, 100) }),
        now
    ).run().catch(() => {});

    return Response.json(
        {
            success: true,
            message: 'Your application has been received. Our team will review it within 48 hours and contact you personally.',
        },
        { status: 201 }
    );
}

// ── POST /v1/auth/login ───────────────────────────────────────────────────────

/**
 * Member login. Returns member JWT.
 * Only members with status='active' may log in.
 *
 * Required body: { email, password }
 * Returns: { token, member: { id, name, username, role, pending_consent } }
 */
export async function handleLogin(request, env) {
    let body;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { email, password } = body;

    if (!isValidEmail(email) || !password) {
        return Response.json({ error: 'Email and password are required' }, { status: 400 });
    }

    // Load member — always return same error regardless of what failed (security)
    const GENERIC_ERROR = 'Invalid email or password';

    const member = await env.DB.prepare(`
        SELECT id, email, name, username, password_hash, role, status,
               pending_consent, broker_code, language
        FROM members
        WHERE email = ?
    `).bind(email.toLowerCase()).first();

    if (!member) {
        return Response.json({ error: GENERIC_ERROR }, { status: 401 });
    }

    // Check account status before password check — fail fast but same error message
    if (member.status === 'banned' || member.status === 'suspended') {
        // Different message for banned/suspended (they should know why)
        const msg = member.status === 'banned'
            ? 'This account has been banned. Contact support if you believe this is an error.'
            : 'This account has been suspended. Contact support for assistance.';
        return Response.json({ error: msg }, { status: 403 });
    }

    if (member.status === 'pending') {
        return Response.json(
            { error: 'Your membership application is still under review. We will contact you within 48 hours.' },
            { status: 403 }
        );
    }

    // Verify password
    const passwordOk = await verifyPassword(password, member.password_hash);
    if (!passwordOk) {
        return Response.json({ error: GENERIC_ERROR }, { status: 401 });
    }

    // Generate member JWT
    const token = await generateJWT(
        { sub: member.id, role: member.role, type: 'member' },
        env.JWT_SECRET
    );

    // Update last_seen (non-blocking)
    env.DB.prepare('UPDATE members SET last_seen = ? WHERE id = ?')
        .bind(Math.floor(Date.now() / 1000), member.id)
        .run()
        .catch(() => {});

    return Response.json({
        success: true,
        token,
        member: {
            id:              member.id,
            name:            member.name,
            username:        member.username,
            role:            member.role,
            pending_consent: member.pending_consent,
            broker_code:     member.broker_code,
            language:        member.language,
        },
    });
}

// ── POST /v1/auth/staff/login ─────────────────────────────────────────────────

/**
 * Staff login. Returns staff JWT with 8-hour expiry.
 * Only staff with status='active' may log in.
 *
 * Required body: { email, password }
 * Returns: { token, staff: { id, name, role, permissions } }
 *
 * NOTE: Staff password hashes in seed data are bcrypt placeholders.
 *       Owner must set real passwords using the password reset endpoint
 *       (to be built in admin.js) before going live.
 *       Use hashPassword() from this file to generate correct PBKDF2 hashes.
 */
export async function handleStaffLogin(request, env) {
    let body;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { email, password } = body;

    if (!isValidEmail(email) || !password) {
        return Response.json({ error: 'Email and password are required' }, { status: 400 });
    }

    const GENERIC_ERROR = 'Invalid credentials';

    const staff = await env.DB.prepare(`
        SELECT id, email, name, password_hash, role, status,
               can_read_chats, can_approve_brokers, can_touch_money, can_export_legal
        FROM staff
        WHERE email = ?
    `).bind(email.toLowerCase()).first();

    if (!staff) {
        return Response.json({ error: GENERIC_ERROR }, { status: 401 });
    }

    if (staff.status !== 'active') {
        return Response.json(
            { error: 'This staff account is not active. Contact the platform owner.' },
            { status: 403 }
        );
    }

    // Staff seed data has bcrypt placeholder — will return false (forces setup)
    const passwordOk = await verifyPassword(password, staff.password_hash);
    if (!passwordOk) {
        return Response.json({ error: GENERIC_ERROR }, { status: 401 });
    }

    // Generate staff JWT (8-hour expiry — enforced in jwt.js)
    const token = await generateJWT(
        { sub: staff.id, role: staff.role, type: 'staff' },
        env.JWT_SECRET
    );

    // Log staff login to staff_action_log (non-blocking)
    const now = Math.floor(Date.now() / 1000);
    const ip  = request.headers.get('CF-Connecting-IP') || null;
    env.DB.prepare(`
        INSERT INTO staff_action_log (staff_id, action, details, ip_address, result, created_at)
        VALUES (?, 'login', ?, ?, 'ok', ?)
    `).bind(staff.id, JSON.stringify({ email: staff.email }), ip, now).run().catch(() => {});

    // Update last_seen (non-blocking)
    env.DB.prepare('UPDATE staff SET last_seen = ? WHERE id = ?')
        .bind(now, staff.id)
        .run()
        .catch(() => {});

    return Response.json({
        success: true,
        token,
        staff: {
            id:   staff.id,
            name: staff.name,
            role: staff.role,
            permissions: {
                can_read_chats:      staff.can_read_chats === 1,
                can_approve_brokers: staff.can_approve_brokers === 1,
                can_touch_money:     staff.can_touch_money === 1,
                can_export_legal:    staff.can_export_legal === 1,
            },
        },
    });
}

// ── Utility: hash a password (use in admin handler for password reset) ────────
// Export so admin.js can use it when setting staff passwords
export { hashPassword };
