# LESSON_LEARN.md
## Universal Coding Lessons — Ploikong Platform + Janis Portfolio
## Travels to every project. Grows after every chat. Never shrinks.

# HOW TO USE THIS FILE:
# - Bring this file to EVERY new chat alongside MASTER_SEED.md and PROJECT_SEED.md
# - When a bug is fixed or a pattern is discovered — add it here with next L number
# - Lessons are universal — they apply to Ploikong, Satu, Katanyu, BorrowMe, and any future project
# - Never delete lessons — even wrong decisions are recorded so we don't repeat them
# - Format: L[number] — one-line title, then what happened, then the rule, then the pattern

# LESSON NUMBERING:
# L001–L058 — imported from Janis Dashboard project (see sample above)
# L059 onwards — Ploikong / Satu / Portfolio lessons starting 2026-05-11

---

## IMPORTED LESSONS FROM JANIS DASHBOARD (L001–L058)
# These travel from the dashboard project. Key ones summarized below.
# Full text: see MASTER_SEED.md from Janis Dashboard project.

# L001–L010: Airtable fundamentals (sort format, lookup arrays, bus_id filtering)
# L011–L020: Cloudflare Pages build pipeline, config.js pattern, secrets management
# L021–L030: Frontend architecture (no framework, modular JS, nav.js injection)
# L031–L040: Cloudinary usage (images only, folder structure, not for PDFs)
# L041–L050: API call patterns (N+1 problem, session cache, finally{} on buttons)
# L051–L058: PDF generation (jsPDF browser-only, R2 for files, Thai font limitation)

# CRITICAL ONES TO REMEMBER:
# L037 — sort must be array: sort: [{ field: 'x', direction: 'asc' }] — NOT JSON.stringify
# L042 — Lookup fields return arrays — always unwrap: Array.isArray(val) ? val[0] : val
# L049 — Fetch ALL related table records once, build lookup map, attach to products. Never per-card.
# L050 — Always use finally{} on any button that changes state — prevents stuck buttons
# L053 — jsPDF cannot render Thai text — EN only for browser PDF generation
# L055 — Cloudinary for images only. R2 for PDFs and raw files.

---

## PLOIKONG LESSONS — Starting 2026-05-11

---

### L059 — Schema decisions belong in conversation, not in code
**What happened:** Before writing a single line of schema.sql, 6 clarifying questions
were asked about membership flow, broker fees, offer types, encryption, cron schedule,
and table count. Each answer changed the schema significantly.
**Rule:** For any new database schema, ask ALL architectural questions first.
A wrong schema costs days to fix. A 10-minute conversation costs nothing.
**Pattern for future schema chats:**
```
Before writing: ask about (1) staging vs direct tables, (2) fee structures,
(3) feature scope, (4) encryption needs, (5) cron frequency, (6) table count.
Only write after all 6 are answered.
```

---

### L060 — Cloudflare D1 encrypts at rest but NOT at column level
**What happened:** Owner asked about PDPA compliance for payout_account and
Thai national ID storage. D1 (SQLite) only encrypts the disk — not individual columns.
**Rule:** For any sensitive column (bank accounts, national IDs, passport numbers),
encrypt the VALUE in the Worker before INSERT, decrypt after SELECT.
Use Web Crypto API (built into Cloudflare Workers — no library needed): AES-256-GCM.
**This also applies to Satu:** donor_consent.encrypted_national_id needs the same fix.
**Pattern:**
```javascript
// src/utils/crypto.js — reuse across all projects
const key = await crypto.subtle.importKey('raw',
  hexToBytes(env.ENCRYPTION_KEY), { name: 'AES-GCM' }, false, ['encrypt','decrypt']);

export async function encrypt(plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return btoa(String.fromCharCode(...iv)) + '.' + btoa(String.fromCharCode(...new Uint8Array(enc)));
}

export async function decrypt(ciphertext) {
  const [ivB64, dataB64] = ciphertext.split('.');
  const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
  const data = Uint8Array.from(atob(dataB64), c => c.charCodeAt(0));
  const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(dec);
}
```
**Secret:** Add `ENCRYPTION_KEY` to Cloudflare secrets. Generate once with:
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` — NEVER change after data is stored.

---

### L061 — Never hardcode business rules — put them in platform_config table
**What happened:** Blueprint had 6% platform fee mentioned in multiple places.
If hardcoded in Worker code, changing the fee requires a code deploy.
**Rule:** All commercial variables (fee %, hold days, limits, thresholds) live in
the `platform_config` table. Worker reads them at runtime. Admin changes them
via dashboard. Change takes effect immediately — no deploy needed.
**Pattern:**
```javascript
// At start of any handler that needs business rules:
async function getPlatformConfig(env) {
  const rows = await env.DB.prepare('SELECT key, value FROM platform_config').all();
  return Object.fromEntries(rows.results.map(r => [r.key, r.value]));
}
// Usage:
const config = await getPlatformConfig(env);
const platformFee = Math.floor(amount * parseFloat(config.platform_fee_pct) / 100);
```

---

### L062 — Dual authentication: members and staff are completely separate
**What happened:** Ploikong has two user types — members (buyers/sellers/brokers)
and staff (owner/ops/legal/compliance). Both need JWT auth but with different
permissions, different tables, and different password stores.
**Rule:** Never mix member auth and staff auth in the same JWT or the same
middleware function. Two separate auth flows, two separate JWT payloads.
**Pattern:**
```javascript
// Member JWT payload: { sub: member.id, role: 'member'|'broker'|'admin', type: 'member' }
// Staff JWT payload:  { sub: staff.id, role: 'owner'|'ops_manager'|..., type: 'staff' }
// Middleware checks type first, then role, then permission flags
```
**Never:** issue a member token that allows staff actions, or vice versa.

---

### L063 — Payment firewall is hardcoded — never make it configurable
**What happened:** During broker system design, the rule was established:
ALL money flows Omise → Ploikong escrow → seller. Broker never touches money.
**Rule:** This is not a platform_config setting. It is hardcoded in the order
creation handler. No admin dashboard toggle. No exception. If a broker asks
for direct payment, that is a contract breach and a scam signal.
**Pattern:**
```javascript
// In orders.js — create order:
// ALWAYS set payment destination to platform escrow account.
// NEVER route to broker account even if broker_id is present.
// broker_id in orders table = commission tracking ONLY, not payment routing.
if (order.broker_id) {
  // Log commission in broker_commission_log — do NOT change payment destination
  await logBrokerCommission(order, env);
}
```

---

### L064 — Consent wall is Option B: block transactions, not browsing
**What happened:** Legal document versioning system was designed. Question arose:
what happens when a member hasn't signed the new Terms of Service?
**Decision:** Option B — member can browse listings, cannot buy/bid/sell/message
until they sign. `members.pending_consent = 1` is the flag.
**Rule:** Check `pending_consent` in EVERY transactional handler before proceeding.
Browsing handlers (GET /listings, GET /listings/:slug) do NOT check this flag.
**Pattern:**
```javascript
// Add to any transactional handler (order, bid, offer, message):
async function requireConsent(memberId, env) {
  const member = await env.DB.prepare(
    'SELECT pending_consent FROM members WHERE id = ?'
  ).bind(memberId).first();
  if (member?.pending_consent === 1) {
    return Response.json({
      error: 'consent_required',
      message: 'Please review and sign the updated Terms of Service to continue.',
      redirect: '/consent'
    }, { status: 403 });
  }
  return null; // null = consent OK, proceed
}
```

---

### L065 — Broker code format: PKB-FIRSTNAME — human-readable trust signal
**What happened:** Broker identification on listings was designed. Options were
numeric (BKR-001), hybrid (VB-2026-001), or name-based (PKB-CHAIRIT).
**Decision:** PKB-FIRSTNAME format. PKB = Ploikong Verified Broker.
**Rule:** Broker code is generated at approval time: 'PKB-' + firstName.toUpperCase()
If name collision (two brokers named Somchai), append number: PKB-SOMCHAI-2.
Broker code is stored in members.broker_code (UNIQUE constraint).
**Why:** Rich collectors learn to recognize broker names. Personal brand builds
faster than a number. A scammer cannot fake this — code is database-tied to verified identity.

---

### L066 — Broker compliance: Option C means owner AND lawyer get every report
**What happened:** Broker 14-day compliance check system was designed.
Three options: owner only (A), lawyer only (B), both (C).
**Decision:** Option C always. Both owner + lawyer receive every compliance report.
**Rule:** Every broker_compliance_checks row gets lawyer_notified = 1.
The cron job that runs compliance checks MUST queue TWO notification emails:
one to owner (csmittee@gmail.com), one to current legal officer email.
**Pattern in cron:**
```javascript
// After each compliance check completes:
await queueNotification(env, 'csmittee@gmail.com', 'compliance_report', { checkId });
const legalOfficer = await env.DB.prepare(
  "SELECT email FROM staff WHERE role='legal_officer' AND status='active' LIMIT 1"
).first();
if (legalOfficer) {
  await queueNotification(env, legalOfficer.email, 'compliance_report', { checkId });
}
```

---

### L067 — notification_queue prevents lost emails on Zoho API failures
**What happened:** In Satu, email sending was attempted inline (send and forget).
If Zoho API was down, the email was lost with no retry.
**Rule:** NEVER send email inline in a request handler. Always INSERT into
notification_queue and let the cron job process it with retry logic (max 3 attempts).
**Pattern:**
```javascript
// Use this helper everywhere instead of calling Zoho directly:
async function queueNotification(env, toEmail, template, payload, memberId = null, staffId = null) {
  await env.DB.prepare(`
    INSERT INTO notification_queue (member_id, staff_id, to_email, template, payload, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'queued', ?)
  `).bind(memberId, staffId, toEmail, template, JSON.stringify(payload), Math.floor(Date.now()/1000)).run();
}
// Cron job processes queue: attempts <= 3, status='queued'|'failed'
```

---

### L068 — MASTER_SEED vs LESSON_LEARN vs PROJECT_SEED — three file system
**What happened:** Owner clarified the file system used across all projects.
**Rule:** Three files, three purposes:
- `MASTER_SEED.md` — the specific project's architecture, decisions, build order, secrets.
  Stays with the project. Does not travel.
- `LESSON_LEARN.md` — universal coding lessons. Travels to EVERY project.
  Grows over time. Never shrinks. Referenced by all parallel chat lanes.
- `PROJECT_SEED.md` — one-page brief for a specific chat session.
  States: current task, files attached, what to produce, what NOT to touch.
  Disposable — created fresh for each focused session.
**Usage pattern for new chat:**
```
Attach: LESSON_LEARN.md + MASTER_SEED.md + PROJECT_SEED.md (one page, this session only)
Say: "Read these three files. Today's task is [one specific thing]."
```

---

### L069 — Each chat lane gets ONE responsibility. Never overlap.
**What happened:** Ploikong has 20+ handler files and HTML pages to build.
One chat cannot build everything without losing context.
**Rule:** Parallel chats are assigned lanes (Auth, Listings, Orders, Broker, Legal,
Frontend, Admin). Each lane touches only its files. Owner integrates.
**Pattern for PROJECT_SEED.md when starting a new lane:**
```
Lane: [name]
Responsibility: [one handler file or one HTML page]
Files attached: [schema.sql + MASTER_SEED.md + the one file being built]
Do NOT touch: [list the other lanes]
Produce: [exact filename, exact location in repo]
```

---

### L070 — SQL seed data: use OR IGNORE, never plain INSERT
**What happened:** schema.sql is designed to be re-runnable (CREATE TABLE IF NOT EXISTS).
But if seed data uses plain INSERT, re-running the schema would fail on duplicate rows.
**Rule:** All seed data uses INSERT OR IGNORE. This makes the schema file safe to run
multiple times — useful when rebuilding a test D1 database or adding new tables.
**Pattern:**
```sql
-- ALWAYS:
INSERT OR IGNORE INTO platform_config (key, value, ...) VALUES ('platform_fee_pct', '6.0', ...);
-- NEVER:
INSERT INTO platform_config (key, value) VALUES ('platform_fee_pct', '6.0');
```

---

### L071 — R2 keys for legal documents are NOT encrypted — they are public contracts
**What happened:** During schema design, encryption was applied to broker_documents.r2_key
(private identity documents) but NOT to legal_documents.r2_key (Terms of Service, etc.).
**Rule:** Encrypt R2 keys only for private documents (IDs, contracts, insurance).
Legal documents (ToS, Privacy Policy) are public-facing — their R2 URLs can be served
directly to members. No encryption needed or appropriate.
**Pattern:**
- `broker_documents.r2_key` → AES-256-GCM encrypted before storage
- `legal_documents.r2_key` → plain text, served as public URL
- `payment_outside_platform_reports.evidence_r2_keys` → encrypted (private evidence)

---

### L072 — Airtable sync is one-way: D1 → Airtable, never Airtable → D1
**What happened:** Owner wants a new Airtable base mirroring Ploikong D1 data
for operations visibility. Risk: if someone edits Airtable, it does not sync back.
**Rule:** The sync is read-only from Airtable's perspective. D1 is the source of truth.
Airtable is the operations VIEW. Never write back from Airtable to D1.
airtable_sync_log tracks what was pushed. The sync Worker runs on cron, push-only.
**Warning:** Do not connect Airtable automations that write back to the API endpoint.
If you need Airtable → D1 (e.g. admin approves in Airtable), build a specific
webhook endpoint that validates the source. Do not make it automatic.

---
L073 — rateLimit middleware must exist before routes call it
What happened: Auth routes were told to call rateLimit() before rateLimit.js was built. Worker crashed on any auth request.
Rule: Never uncomment a middleware call in index.js until the middleware file is physically in the repo. When a handler is built before its middleware, call the handler directly and leave the rateLimit line commented. Swap in one line per route when the middleware file is ready.
Pattern:
javascript// rateLimit.js not built yet — call handler directly:
return handleRegister(request, env);
// When rateLimit.js is ready, swap to:
// return rateLimit(request, env, () => handleRegister(request, env));
---
L074 — D1 Console SQL must be comment-free and in blocks under ~50 rows
What happened: SQL with inline comments and long single-statement inserts was given for D1 Console. D1 Console does not handle comments well and times out on very long single statements.
Rule: Any SQL meant to run in D1 Console must have all comments stripped. Split large INSERT statements into blocks of 7 rows maximum. Always end with a verification SELECT COUNT(*) as a separate block.
---






Worker URL: https://ploikong-api.[your-account].workers.dev
Health: https://ploikong-api.[your-account].workers.dev/health ✅
Auto-deploy: GitHub main → Cloudflare ✅
Completed: 2026-05-12
---



## HOW TO ADD A NEW LESSON

When a bug is fixed, a pattern is discovered, or a wrong assumption is corrected:

1. Add at the bottom with next L number (current: L072)
2. Format:
```
### L[N] — One-line title (what the lesson is about)
**What happened:** Brief description of the situation that created this lesson.
**Rule:** The rule to follow going forward. Clear, actionable.
**Pattern:** Code snippet or checklist if applicable.
```
3. Update "current: L0XX" above
4. Commit LESSON_LEARN.md with message: "L0XX — [title]"

---

## QUICK REFERENCE — MOST IMPORTANT RULES

| # | Rule | Where it hurts if ignored |
|---|---|---|
| L060 | Encrypt sensitive columns in Worker, not in DB | PDPA violation, court risk |
| L061 | Business rules in platform_config, never hardcoded | Requires code deploy to change fee |
| L062 | Member auth and staff auth are completely separate | Security breach |
| L063 | Payment firewall is hardcoded — never configurable | Broker scam vector |
| L064 | Check pending_consent in every transactional handler | Legal exposure |
| L067 | Never send email inline — always queue it | Lost notifications |
| L069 | One chat = one lane = one file | Context loss, code collision |
| L050 | Always use finally{} on buttons that change state | Stuck UI, bad UX |
| L049 | Fetch related table once, build map, attach — never per-card | N+1 API calls |
| L037 | Airtable sort must be array format | Silent query failure |
