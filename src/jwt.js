// ============================================================================
//  src/utils/jwt.js
//  JWT utility — generate and verify tokens for members AND staff
//
//  Member JWT payload: { sub: id, role: 'member'|'broker'|'admin', type: 'member' }
//  Staff JWT  payload: { sub: id, role: 'owner'|'ops_manager'|..., type: 'staff' }
//
//  Uses Web Crypto API (built into Cloudflare Workers — no library needed).
//  Algorithm: HS256 (HMAC-SHA256)
//  Secret: env.JWT_SECRET (set in Cloudflare Worker secrets)
//  Expiry: members = 7 days, staff = 8 hours (stricter for staff)
// ============================================================================

const MEMBER_EXPIRY_SECONDS = 60 * 60 * 24 * 7;   //  7 days
const STAFF_EXPIRY_SECONDS  = 60 * 60 * 8;          //  8 hours

// ── Encode helpers ────────────────────────────────────────────────────────────

function base64url(str) {
    return btoa(str)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g,  '');
}

function base64urlFromBuffer(buf) {
    return base64url(String.fromCharCode(...new Uint8Array(buf)));
}

function base64urlDecode(str) {
    const padded = str.replace(/-/g, '+').replace(/_/g, '/');
    const padding = (4 - padded.length % 4) % 4;
    return atob(padded + '='.repeat(padding));
}

// ── HMAC-SHA256 sign ──────────────────────────────────────────────────────────

async function hmacSign(secret, data) {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
    return base64urlFromBuffer(sig);
}

async function hmacVerify(secret, data, signature) {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify']
    );
    const sigBuffer = Uint8Array.from(base64urlDecode(signature), c => c.charCodeAt(0));
    return crypto.subtle.verify('HMAC', key, sigBuffer, new TextEncoder().encode(data));
}

// ── Generate JWT ──────────────────────────────────────────────────────────────

/**
 * Generate a signed JWT.
 * @param {object} payload   Must include: sub, role, type ('member' | 'staff')
 * @param {string} secret    env.JWT_SECRET
 * @returns {Promise<string>} Signed JWT string
 */
export async function generateJWT(payload, secret) {
    const now     = Math.floor(Date.now() / 1000);
    const expiry  = payload.type === 'staff' ? STAFF_EXPIRY_SECONDS : MEMBER_EXPIRY_SECONDS;

    const header  = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const claims  = base64url(JSON.stringify({
        ...payload,
        iat: now,
        exp: now + expiry,
    }));

    const signature = await hmacSign(secret, `${header}.${claims}`);
    return `${header}.${claims}.${signature}`;
}

// ── Verify JWT ────────────────────────────────────────────────────────────────

/**
 * Verify and decode a JWT.
 * @param {string} token   The JWT string
 * @param {string} secret  env.JWT_SECRET
 * @returns {Promise<{ valid: boolean, payload?: object, error?: string }>}
 */
export async function verifyJWT(token, secret) {
    try {
        if (!token || typeof token !== 'string') {
            return { valid: false, error: 'No token provided' };
        }

        const parts = token.split('.');
        if (parts.length !== 3) {
            return { valid: false, error: 'Malformed token' };
        }

        const [header, claims, signature] = parts;

        // Verify signature
        const ok = await hmacVerify(secret, `${header}.${claims}`, signature);
        if (!ok) {
            return { valid: false, error: 'Invalid signature' };
        }

        // Decode payload
        const payload = JSON.parse(base64urlDecode(claims));

        // Check expiry
        const now = Math.floor(Date.now() / 1000);
        if (payload.exp && payload.exp < now) {
            return { valid: false, error: 'Token expired' };
        }

        // Require type field (security: prevent member token used on staff route)
        if (!payload.type || !['member', 'staff'].includes(payload.type)) {
            return { valid: false, error: 'Invalid token type' };
        }

        return { valid: true, payload };

    } catch (err) {
        return { valid: false, error: 'Token decode failed: ' + err.message };
    }
}

// ── Extract Bearer token from request ────────────────────────────────────────

/**
 * Pull the Bearer token from the Authorization header.
 * @param {Request} request
 * @returns {string|null}
 */
export function extractBearerToken(request) {
    const authHeader = request.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) return null;
    return authHeader.slice(7).trim() || null;
}
