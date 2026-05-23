# 📚 LESSONS LEARNED — Ploikong Platform
> **CC reads this at the start of every session.**
> CC appends new lessons after every fix. Never delete. Only add.
> Current highest lesson: **L087**

---

## HOW TO USE

- CC reads this before writing any code
- Chat references lesson IDs in prompts (e.g. "follow L061, L075")
- Owner reads this to understand why decisions were made
- Format: `L[NNN]` — sequential, never reused
- After every CC session: append new lessons at bottom, update "Current highest" above

---

## PHASE 0 — Architecture & Schema (2026-05-11)

### L059 — Schema decisions belong in conversation, not in code
**Problem:** Architectural questions (membership flow, broker fees, encryption) were asked mid-build and changed the schema significantly.
**Rule:** For any new schema, answer all architectural questions BEFORE writing a single table. A wrong schema costs days. A conversation costs minutes.
**Tag:** #schema #architecture

---

### L060 — D1 encrypts at rest but NOT at column level — Worker must encrypt sensitive values
**Problem:** PDPA compliance requires column-level protection for `members.payout_account` and `broker_documents.r2_key`. D1/SQLite disk encryption is not sufficient.
**Rule:** Encrypt sensitive column VALUES in the Worker using Web Crypto API (AES-256-GCM) before INSERT. Decrypt after SELECT. See `src/utils/crypto.js`.
**Pattern:**
```javascript
// Thai ID = SHA-256 one-way hash only (never reversible)
// payout_account = AES-256-GCM encrypt/decrypt via crypto.js
// broker_documents.r2_key = AES-256-GCM encrypted path
```
**Tag:** #security #pdpa #encryption

---

### L061 — Never hardcode business rules — all rates live in platform_config table
**Problem:** Fee percentages hardcoded in Worker require a code deploy to change.
**Rule:** All commercial variables (fee %, hold days, limits) live in `platform_config`. Read at runtime. Admin changes via dashboard — no deploy needed.
**Pattern:**
```javascript
async function getPlatformConfig(env) {
  const rows = await env.DB.prepare('SELECT key, value FROM platform_config').all();
  return Object.fromEntries(rows.results.map(r => [r.key, r.value]));
}
const config = await getPlatformConfig(env);
const fee = Math.floor(amount * parseFloat(config.platform_fee_pct) / 100);
```
**Tag:** #config #architecture

---

### L062 — Member JWT and Staff JWT are completely separate — never mix
**Problem:** Two user types (members, staff) with different permissions, tables, password stores.
**Rule:** Two separate auth flows, two separate JWT payloads. Middleware checks `type` first.
**Pattern:**
```javascript
// Member JWT: { sub: member.id, role: 'member'|'broker'|'admin', type: 'member' }
// Staff JWT:  { sub: staff.id,  role: 'owner'|'ops_manager'|...,  type: 'staff' }
```
**Tag:** #auth #security

---

### L063 — Payment firewall is hardcoded — never make it configurable
**Problem:** Risk of broker routing payment outside the platform.
**Rule:** ALL money flows Omise → Ploikong escrow → seller. Broker never touches money. This is NOT a platform_config setting. Hardcoded in orders.js. No admin toggle exists.
```javascript
// broker_id in orders = commission tracking ONLY, not payment routing
```
**Tag:** #payment #security #hardcoded

---

### L064 — requireConsent() on every transactional POST handler
**Problem:** Members with unsigned legal docs can bypass the consent wall if handlers don't check.
**Rule:** Every handler that creates/modifies data must check `pending_consent` first. Browse-only GETs are exempt.
**Pattern:**
```javascript
async function requireConsent(memberId, env) {
  const member = await env.DB.prepare(
    'SELECT pending_consent FROM members WHERE id = ?'
  ).bind(memberId).first();
  if (member?.pending_consent === 1) {
    return Response.json({ error: 'consent_required', redirect: '/consent' }, { status: 403 });
  }
  return null; // null = OK, proceed
}
// Usage: const block = await requireConsent(memberId, env); if (block) return block;
```
**Tag:** #legal #consent #auth

---

### L065 — Broker code format: PKB-FIRSTNAME — human-readable trust signal
**Problem:** Numeric broker IDs (BKR-001) are not memorable or trust-building.
**Rule:** Broker code = `PKB-` + firstName.toUpperCase(). Collision: append number (PKB-SOMCHAI-2). Generated at approval time. Stored in `members.broker_code` (UNIQUE).
**Tag:** #broker #identity

---

### L066 — Broker compliance: Option C — owner AND lawyer get every report
**Problem:** Single-recipient compliance reports create accountability gaps.
**Rule:** Every `broker_compliance_checks` row gets `lawyer_notified = 1`. Every compliance event queues TWO emails: owner + current legal_officer.
**Pattern:**
```javascript
await queueNotification(env, 'csmittee@gmail.com', 'compliance_report', { checkId });
const legal = await env.DB.prepare(
  "SELECT email FROM staff WHERE role='legal_officer' AND status='active' LIMIT 1"
).first();
if (legal) await queueNotification(env, legal.email, 'compliance_report', { checkId });
```
**Tag:** #broker #compliance #legal

---

### L067 — Never send email inline — always queue to notification_queue
**Problem:** Inline Zoho API calls fail silently when Zoho is down. Email is lost forever.
**Rule:** INSERT into `notification_queue` only. Cron job processes with retry (max 3 attempts).
**Pattern:**
```javascript
async function queueNotification(env, toEmail, template, payload, memberId = null, staffId = null) {
  await env.DB.prepare(`
    INSERT INTO notification_queue (member_id, staff_id, to_email, template, payload, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'queued', ?)
  `).bind(memberId, staffId, toEmail, template, JSON.stringify(payload), Math.floor(Date.now()/1000)).run();
}
```
**Tag:** #email #notifications #reliability

---

### L068 — Three-file system: masterseed / lessons_learned / WORKFLOW_SKILL
**Problem:** Context was scattered across upload files between chats.
**Rule:** masterseed.md = project memory (CC updates). lessons_learned.md = universal rules (CC updates). WORKFLOW_SKILL.md = operating model (permanent). All live in repo root.
**Tag:** #workflow #context

---

### L069 — One CC session = one responsibility. Never overlap files.
**Problem:** Multi-file sessions lose context and create collisions.
**Rule:** Each CC prompt targets one handler file or one HTML page. CC reads, writes, commits, archives. Owner QAs. Next prompt only after QA passes.
**Tag:** #workflow #cc

---

### L070 — SQL seed data: always INSERT OR IGNORE, never plain INSERT
**Problem:** Re-running schema.sql on existing DB fails on duplicate seed rows.
**Rule:** All seed data uses `INSERT OR IGNORE`. Schema file is safe to re-run.
**Tag:** #sql #schema

---

### L071 — R2 key encryption: private docs only — legal docs are public
**Problem:** Encrypting public document paths (ToS, Privacy Policy) blocks member access.
**Rule:** `broker_documents.r2_key` → AES-256-GCM encrypted. `legal_documents.r2_key` → plain text (public URL). `payment_outside_platform_reports.evidence_r2_keys` → encrypted.
**Tag:** #encryption #r2 #legal

---

### L072 — Airtable sync is one-way: D1 → Airtable only
**Problem:** Risk of Airtable edits accidentally overwriting D1 source of truth.
**Rule:** D1 is source of truth. Airtable is operations VIEW only. Never write back from Airtable to D1 automatically. If Airtable → D1 is ever needed, build a specific validated webhook endpoint.
**Tag:** #airtable #sync #data

---

## PHASE 1 — Backend Build (2026-05-11 to 2026-05-24)

### L073 — rateLimit middleware must exist in repo before routes call it
**Problem:** Calling `rateLimit()` before `rateLimit.js` exists crashes the Worker on every request.
**Rule:** Never uncomment a middleware call in index.js until the file is physically in the repo. Leave the call commented with a note until the file is built.
**Tag:** #middleware #deploy

---

### L074 — D1 Console SQL must be comment-free and split into blocks under 50 rows
**Problem:** D1 Console times out on long single statements and chokes on inline SQL comments.
**Rule:** Strip all comments from SQL before pasting into D1 Console. Split large INSERTs into blocks of 7 rows max. End with a verification `SELECT COUNT(*)` as a separate block.
**Tag:** #sql #d1 #deployment

---

### L075 — Public GET routes must be registered ABOVE the authenticateMemberJWT call
**Problem:** Listing GET routes placed inside the auth block require login to browse — breaks the public marketplace.
**Rule:** Public GETs (listings feed, single listing, search, member profiles) go above the `authenticateMemberJWT` call. POST/PUT/DELETE go inside it.
**Tag:** #routing #auth #index

---

### L076 — Utility imports belong in the handler file, not in index.js
**Problem:** Importing utilities (slugify, crypto) in index.js clutters the router and creates unused dependencies.
**Rule:** Utility imports go in the handler file that uses them. index.js imports handlers and middleware only.
**Tag:** #architecture #imports

---

### L077 — Leave commented stub lines in index.js above active lines
**Problem:** No record of what changed without git blame.
**Rule:** Leave the original commented stub above the active line as a before/after record. Delete only when the file is fully stable and tested.
**Tag:** #index #documentation

---

### L078 — Phase 1 search is LIKE query only — not full-text search
**Problem:** D1/SQLite has no full-text index built for Phase 1.
**Rule:** Search uses `LIKE %keyword%` across title, story, tags, origin, provenance. Correct under ~1000 listings. At ~5000 listings, upgrade to Cloudflare Vectorize. Mark with `// TODO: upgrade to Vectorize at scale` comment.
**Tag:** #search #performance #todo

---

### L079 — Exact string routes must be registered BEFORE regex routes in index.js
**Problem:** Generic regex like `/v1/bids/\d+` could shadow exact paths like `/v1/bids/auto` if registered first.
**Rule:** Within any route group: (1) exact string paths first, (2) action sub-paths, (3) numeric ID regex last.
**Pattern:**
```javascript
// CORRECT:
if (path === '/v1/bids/auto' && method === 'POST') { ... }        // exact first
if (path.match(/^\/v1\/bids\/\d+$/) && method === 'GET') { ... } // regex after
```
**Tag:** #routing #index

---

### L080 — Fake payment mode must call confirmOrderPayment() to queue notifications
**Problem:** In fake mode, Omise webhook never fires, so buyer/seller notifications are skipped.
**Rule:** Fake mode handler must call `confirmOrderPayment()` directly after DB update. Same DB changes, same notification queue inserts as live mode. Only the Omise API call is skipped.
**Tag:** #payment #testing

---

### L081 — Order ID regex must match the generation format exactly
**Problem:** Generic `/:id` route collides with numeric listing IDs on the same `/v1/` prefix.
**Rule:** Order IDs are `PLK-YYYYMMDD-XXXX`. Route regex must be `/PLK-\d{8}-[A-Z0-9]{4}/`. Never use generic `:id` for typed IDs.
**Tag:** #routing #orders

---

### L082 — /v1/bids/auto must be routed BEFORE /v1/bids/:listingId
**Problem:** If regex ever broadens, "auto" could be swallowed by the numeric ID pattern.
**Rule:** Always: exact paths first, regex paths after. This is a permanent rule, not just for bids.
**Tag:** #routing #index

---

### L083 — GET /v1/bids/:listingId is public but currently sits inside the JWT block
**Problem:** Bid history is logically public but wired inside member auth.
**Decision:** Acceptable for Phase 1 (invitation-only platform). When public browsing opens, move to public routes section. TODO comment exists in index.js.
**Tag:** #routing #auth #todo

---

### L084 — max_auto_bid must never appear in public bid responses
**Problem:** Exposing max_auto_bid reveals bidder strategy.
**Rule:** Public bid endpoints: explicit column list, never `SELECT *`. `max_auto_bid` only visible in `handleGetMyBids` (own bids) and admin view.
**Pattern:**
```javascript
// Public: SELECT b.id, b.amount, b.is_auto_bid, b.status, b.created_at, m.username
// Never: SELECT * FROM bids
```
**Tag:** #privacy #bids

---

### L085 — staff object must be destructured as staffAuth.staff before passing to handlers
**Problem:** Passing the full `staffAuth` object (not `.staff`) to handlers breaks all role/permission checks.
**Rule:** In index.js, after staff JWT check: `const staff = staffAuth.staff;`. Pass `staff` (the object) to every handler. Never pass `staffAuth` itself.
**Pattern:**
```javascript
const staffAuth = await authenticateStaffJWT(request, env);
if (!staffAuth.valid) return respond({ error: 'Unauthorized' }, { status: 401 });
const staff = staffAuth.staff; // { id, role, can_approve_brokers, ... }
```
**Tag:** #auth #staff #index

---

### L086 — Broker pipeline routes: exact-string paths before numeric-ID regex paths
**Problem:** `/v1/admin/brokers/reports` and `/v1/admin/brokers/flags/:id/resolve` must not be caught by `/v1/admin/brokers/:id`.
**Rule:** Within the broker staff route group: `reports` and `flags` exact paths first, then numeric ID regex paths. Same rule as L079 applied to nested admin routes.
**Tag:** #routing #broker #index

---

### L087 — File names in repo must exactly match import paths in index.js
**Problem:** `auth-handler.js` and `auth-middleware.js` were committed but index.js imports `auth.js`. Build failed with "Could not resolve" errors.
**Rule:** Convention for this project: no dashes in handler/middleware filenames. `auth.js` not `auth-handler.js`. Verify filename matches import path before every commit.
**Tag:** #deploy #naming #index

---

## HOW TO ADD A NEW LESSON

CC appends at the bottom after every session:

```markdown
### L[NNN] — One-line title
**Problem:** What went wrong or what was discovered.
**Rule:** What to do going forward. Clear and actionable.
**Pattern:** Code snippet if applicable. (optional)
**Tag:** #category #phase
```

Then update the "Current highest lesson" at the top of this file.
