// ════════════════════════════════════════════════════════════════════════════
//  PLOIKONG — Slug Utility
//  File: src/utils/slugify.js
//
//  Generates URL-safe, unique slugs for listing pages.
//  Format: ploikong.com/item/seki-japan-chef-knife-1987
//
//  RULES:
//  - Lowercase, hyphens only, no special chars
//  - Max 80 characters (SEO + readability)
//  - Transliterate Thai characters to Latin approximation
//  - Append short random suffix to guarantee uniqueness in D1
//  - Collision retry: if slug exists, append a new suffix (up to 5 tries)
//
//  USAGE:
//    import { generateUniqueSlug } from '../utils/slugify.js';
//    const slug = await generateUniqueSlug(title, env.DB);
// ════════════════════════════════════════════════════════════════════════════

// ── Thai character transliteration map ───────────────────────────────────────
// Covers common Thai consonants and vowels — approximates pronunciation.
// Not a full phonetic system — good enough for URL slugs.
const THAI_MAP = {
    'ก': 'k', 'ข': 'kh', 'ค': 'kh', 'ง': 'ng',
    'จ': 'j', 'ช': 'ch', 'ซ': 's',  'ญ': 'y',
    'ด': 'd', 'ต': 't',  'ถ': 'th', 'ท': 'th',
    'น': 'n', 'บ': 'b',  'ป': 'p',  'ผ': 'ph',
    'พ': 'ph','ฝ': 'f',  'ฟ': 'f',  'ม': 'm',
    'ย': 'y', 'ร': 'r',  'ล': 'l',  'ว': 'w',
    'ส': 's', 'ห': 'h',  'อ': 'o',  'ฮ': 'h',
    'ะ': 'a', 'า': 'a',  'ิ': 'i',  'ี': 'i',
    'ึ': 'ue','ื': 'ue', 'ุ': 'u',  'ู': 'u',
    'เ': 'e', 'แ': 'ae', 'โ': 'o',  'ใ': 'ai',
    'ไ': 'ai','็': '',   '่': '',   '้': '',
    '๊': '', '๋': '',   'ั': 'a',  'ำ': 'am',
    'ๆ': '',  '์': '',   'ฯ': '',
};

// ── Core slugify function (pure — no DB) ──────────────────────────────────────
/**
 * slugify — converts any string into a URL-safe slug.
 * Handles English, Thai, and mixed input.
 *
 * @param {string} text — raw title, e.g. "Seki Japan Chef's Knife (1987)"
 * @returns {string}    — e.g. "seki-japan-chefs-knife-1987"
 */
export function slugify(text) {
    if (!text || typeof text !== 'string') return 'item';

    let result = text;

    // Step 1: Transliterate Thai characters
    for (const [thai, latin] of Object.entries(THAI_MAP)) {
        result = result.replaceAll(thai, latin);
    }

    // Step 2: Normalize unicode (é → e, ü → u, etc.)
    result = result
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');   // strip diacritics

    // Step 3: Lowercase
    result = result.toLowerCase();

    // Step 4: Replace non-alphanumeric chars with hyphen
    result = result
        .replace(/[^a-z0-9\s-]/g, ' ')   // special chars → space
        .trim()
        .replace(/[\s_]+/g, '-')          // whitespace/underscore → hyphen
        .replace(/-+/g, '-')              // collapse multiple hyphens
        .replace(/^-+|-+$/g, '');         // trim leading/trailing hyphens

    // Step 5: Enforce max length (80 chars — keeps URLs clean in sharing)
    if (result.length > 80) {
        result = result.substring(0, 80).replace(/-[^-]*$/, '');  // cut at last hyphen
    }

    return result || 'item';
}

// ── Random suffix generator ───────────────────────────────────────────────────
/**
 * randomSuffix — generates a short random alphanumeric string.
 * Used to guarantee slug uniqueness without sequential numbering.
 *
 * @param {number} length — default 6
 * @returns {string}       — e.g. "x7k3mq"
 */
function randomSuffix(length = 6) {
    const chars = 'abcdefghijkmnpqrstuvwxyz23456789';  // no ambiguous chars (0/o/1/l)
    let suffix = '';
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    for (const byte of bytes) {
        suffix += chars[byte % chars.length];
    }
    return suffix;
}

// ── Unique slug generator (DB-aware) ─────────────────────────────────────────
/**
 * generateUniqueSlug — creates a slug and verifies it doesn't exist in D1.
 * Retries up to 5 times with new suffixes if collision is found.
 *
 * @param {string}   title    — raw listing title
 * @param {D1Database} db     — env.DB
 * @param {string}   [excludeId] — listing id to exclude (for edit/update)
 * @returns {Promise<string>}    — unique slug ready for INSERT
 */
export async function generateUniqueSlug(title, db, excludeId = null) {
    const base = slugify(title);
    const MAX_ATTEMPTS = 5;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        // First attempt uses base + short suffix
        // Subsequent attempts use base + longer suffix
        const suffix  = randomSuffix(attempt === 0 ? 5 : 7);
        const candidate = `${base}-${suffix}`;

        // Check D1 for collision
        let query = 'SELECT id FROM listings WHERE slug = ?';
        const bindings = [candidate];

        if (excludeId) {
            query += ' AND id != ?';
            bindings.push(excludeId);
        }

        const existing = await db.prepare(query).bind(...bindings).first();

        if (!existing) {
            return candidate;  // unique — use it
        }

        console.warn(`[slugify] Collision on attempt ${attempt + 1}: ${candidate}`);
    }

    // Last resort — timestamp-based slug (guaranteed unique)
    const ts = Date.now().toString(36);
    return `${base}-${ts}`;
}

// ── Validate slug format ──────────────────────────────────────────────────────
/**
 * isValidSlug — checks if a user-provided slug is safe to use.
 * Used if we ever allow sellers to customise their listing slug.
 *
 * @param {string} slug
 * @returns {boolean}
 */
export function isValidSlug(slug) {
    if (!slug || typeof slug !== 'string') return false;
    if (slug.length < 3 || slug.length > 100) return false;
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}
