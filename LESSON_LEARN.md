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
L075 — Public GET routes activate before auth is wired
What happened: listings GET routes (feed, single item, search) are public —
they can be uncommented and activated in index.js before member JWT auth
is fully wired into the protected routes section.
Rule: Activate public GET routes immediately when the handler is built.
Leave POST/PUT/DELETE commented until memberId extraction from JWT is confirmed working.
Pattern: Public = uncomment now. Transactional = wait for auth wire-up session.

---

L076 — generateUniqueSlug lives in the handler, not in index.js
What happened: slugify.js is imported inside listings.js directly.
index.js does not need to import it.
Rule: Utility imports belong in the handler file that uses them, not in the router.
index.js only imports handlers and middleware — never utilities directly.

---

L077 — index.js route stubs: leave commented line above active line
What happened: original stub lines (// return handleGetListings) were left
above the active lines as a record of what changed.
Rule: Leave the commented stub in place — it shows the before/after without
needing git blame. Delete only when file is fully stable and tested.

---

L078 — Search in Phase 1 is LIKE query only — not full text search
What happened: D1/SQLite has no full-text index built for Phase 1.
Search uses LIKE %keyword% across title, story, tags, origin, provenance.
Rule: This is correct under ~1000 listings. At ~5000 listings, replace with
Cloudflare Vectorize or a keyword index table. Do not over-engineer now.
Flag in code with a TODO comment so the upgrade point is obvious.


L079 — index.js: auth block must be uncommented before order/payment routes go live
What happened: The member JWT auth check (authenticateMemberJWT) was left commented in index.js while order/payment imports were activated. This would have allowed unauthenticated access to all transactional routes.
Rule: Never activate a transactional route import without also activating the auth block above it. They are one atomic step — do both together or neither.

L080 — payment.js fake mode must call confirmOrderPayment() to queue notifications
What happened: In fake mode, Omise webhook never fires, so payment confirmation and notification queuing would be skipped if the handler just updated the DB and returned. The fake mode handler must call confirmOrderPayment() directly so buyer/seller emails are queued identically to live mode.
Rule: Fake mode must mirror live mode behavior exactly — same DB updates, same notification queue inserts. Only the Omise API call is skipped.

L081 — Order ID regex in routes must match the generation format exactly
What happened: Order IDs are PLK-YYYYMMDD-XXXX (8 digits, 4 alphanumeric). The route regex must be /PLK-\d{8}-[A-Z0-9]{4}/ — not a generic /:id — or it will collide with numeric listing IDs on the same /v1/ path prefix.
Rule: Use the exact format regex in route matching for typed IDs. Generic :id patterns cause silent route collisions.

L082 — /v1/bids/auto must be routed BEFORE /v1/bids/:listingId
What happened: In index.js, the route /v1/bids/auto would be incorrectly
caught by the regex /^\/v1\/bids\/\d+$/ IF "auto" were numeric. It isn't,
so the regex doesn't match — but the correct safe order is still: exact paths
first, then regex patterns. This prevents future bugs if routes are reordered.
Rule: Always register exact-string routes (e.g. /v1/bids/auto) BEFORE
regex routes (e.g. /v1/bids/:id) in index.js. Same for /v1/offers/mass
before /v1/offers/:id/respond.
Pattern:
javascript// CORRECT order:
if (path === '/v1/bids/auto' && method === 'POST') { ... }         // exact first
if (path.match(/^\/v1\/bids\/\d+$/) && method === 'GET') { ... }   // regex after
// WRONG order would risk "auto" being swallowed if regex ever broadens

L083 — GET /v1/bids/:listingId is public but sits inside the JWT block
What happened: Bid history is logically public (anyone can see auction bids)
but in the current index.js it is wired inside the member JWT block (below
authenticateMemberJWT). This means unauthenticated users cannot see bid history.
Decision: Acceptable for Phase 1 — Ploikong is invitation-only, all browsers
are members. When public browsing opens, move GET /v1/bids/:listingId to the
PUBLIC LISTING ROUTES section above the JWT call.
Rule: Add a TODO comment in index.js on that route as a reminder.
TODO already added: see comment in bids block in index.js.

L084 — max_auto_bid is private — never expose it in public responses
What happened: bids.js handleGetBids (public endpoint) was explicitly
written to exclude max_auto_bid from the response. auction_reserve is also
excluded from public bid history.
Rule: Any SELECT on the bids table for a public endpoint must omit
max_auto_bid. Only handleGetMyBids (private, own bids only) may include it.
Only the listing owner's admin view may see auction_reserve.
Pattern:
javascript// Public bid endpoint — explicit column list, never SELECT *
SELECT b.id, b.amount, b.is_auto_bid, b.status, b.created_at,
       m.username AS bidder_username
FROM bids b ...
// max_auto_bid intentionally excluded

### L085 — Always check current lesson count before numbering new ones
**What happened:** Claude numbered new lessons starting from L079 without
verifying the current last lesson in LESSON_LEARN.md. The file was already
at L081, so the new lessons collided.
**Rule:** Before writing any new lesson, read the bottom of LESSON_LEARN.md
and find the last L number. New lessons start from last+1. Never assume.
**Pattern:** At start of every session where lessons may be added —
search LESSON_LEARN.md for the highest L number before writing anything new.

L086 — Do not create manual text fields when a Lookup already exists
When designing Airtable tables, if a linked record field (e.g. Business Link) already exists, create bus_id as a Lookup field pulling from that relationship — not a manual Single line text field. Manual text requires the user to type the same value twice and creates a failure point. Lookup auto-populates from the relationship. Check the Products table as the reference pattern — bus_id there is already a Lookup. Apply this same pattern to all new tables (Gallery, News, Testimonials).

### L088 — Never use [skip ci] in workflow auto-commit messages
**What happened:** generate-news.yml was drafted with [skip ci] in the commit
message. This tells GitHub Actions to skip ALL workflows on that commit —
can silently block other pipelines depending on the pushed file.
**Rule:** Remove [skip ci] from all workflow commit messages. Bot commits only
touch their own output file so there is no infinite loop risk.
**Pattern:**
git commit -m "chore: regenerate news-data.json"        ✅
git commit -m "chore: regenerate news-data.json [skip ci]"  ❌
Check: generate-gallery.yml, generate-blog.yml, generate-products.yml —
all confirmed clean. Only new workflows need this check at generation time.

---

### L089 — Smooth expand must use max-height transition, never display:none toggle
**What happened:** News accordion was using display:none / display:block toggle.
This always snaps — cannot be animated. User wanted luxury smooth open.
**Rule:** For any expand/collapse animation use max-height + opacity + transition.
Never toggle display property when smoothness matters.
**Pattern:**
.element {
    max-height: 0;
    overflow: hidden;
    opacity: 0;
    transition: max-height 0.6s cubic-bezier(0.4, 0, 0.2, 1),
                opacity 0.5s ease 0.1s,
                padding 0.4s ease;
}
.element.open {
    max-height: 600px;
    opacity: 1;
    padding: 0.75rem 0;
}
cubic-bezier(0.4, 0, 0.2, 1) — starts fast, decelerates gently at the end.
Opacity delay 0.1s — content appears as tray arrives, not before.

---

### L090 — Text-heavy sections use 800px max-width, not 1280px
**What happened:** News section was set to max-width 1280px matching the
layout containers. Wide text blocks are hard to read and look undesigned.
**Rule:** Any section that is primarily text (news, testimonials, FAQ, blog)
should cap at 800px max-width. 1280px is for image grids and full layouts only.

---

### L091 — Links belong in body text, not as a separate link_url button
**What happened:** News items had a link_url field that powered a "Learn more"
button. This sent users to random pages (Facebook, product listing, contact)
with no context — confusing UX.
**Rule:** Remove dedicated link_url buttons from card/accordion components.
Links should appear naturally inside the body text where they have context.
The link_url Airtable field is not needed and should not be output to JSON.

---

### L092 — Brand gold (#FFD700) must never be used as badge/alert background
**What happened:** NEW badge used brand gold background with dark text.
On a light page background it looked faded and ugly, not attention-grabbing.
**Rule:** Badges and alerts that need attention use red #e53e3e with white text.
Brand gold is for headings, borders, accents, and CTAs only — not status badges.

---

### L093 — FOUC block must never contain background property — only visibility
**What happened:** The critical inline style block at the top of every HTML page
had `background: white` added alongside `visibility: visible`. This was intended
to prevent flash of unstyled content but instead painted solid white over every
section before the injector loaded — completely destroying the glass transparent
design. It survived multiple sessions undetected because it looked intentional.
**Rule:** The FOUC block in every HTML page may ONLY contain `visibility: visible`.
Never set `background`, `color`, or any other visual property there.
**Pattern:**
```css
/* CORRECT */
.hero-section, .brand-section, .section-container, .bottom-hero { 
    visibility: visible; 
}
/* WRONG — kills glass design on every section */
.hero-section, .brand-section { 
    visibility: visible; 
    background: white;  ← NEVER
}
```
**Applies to:** index.html, th/index.html, and every future page added to the site.

---

### L094 — CSS class ownership — iflex-core.js vs iflex-config.js never overlap
**What happened:** Multiple chat sessions added section CSS (glass effects, backgrounds,
layout) into iflex-core.js alongside the navbar and footer styles. iflex-config.js
already owned those same classes. Two definitions of the same class = unpredictable
winner depending on load order. Caused white panels, missing images, wrong glass tint.
**Rule:** Strict ownership — never cross the boundary:
- `iflex-core.js` owns ONLY: `.navbar-fixed-wrapper`, `.footer`, `.mobile-menu`,
  `.hamburger`, `.lang-sel-wrapper`, `body` (background only), `.btn` (fallback only)
- `iflex-config.js` owns EVERYTHING ELSE: all section classes, glass effects,
  typography, animations, cards, FAQ, news, marquee, compare table
**Detection:** If the same class appears in both files, the one in iflex-core.js
is wrong. Delete from core, keep in config.

---

### L095 — Glass design system — permanent locked rules for i-flexthailand.com
**What happened:** After a full day of debugging, the glass transparent scroll
design was finally achieved and locked. These rules must never be broken.

**TRANSPARENT — these classes must always have background: transparent**
L096 — Never rewrite a full HTML file when only adding a section
Always diff the original vs what you deliver. If the diff shows more than your intended changes — stop, identify what changed, fix before delivering. A full rewrite is never acceptable when the task is "add a section."

L097 — Always use download files for HTML over 100 lines
Copy-paste of large HTML files introduces invisible errors. Always present_files for download. No exceptions for files the user will upload to GitHub.

L098 — Never use octal escape sequences in JS template literals
'\201C' inside a backtick template string causes SyntaxError and kills the entire config file. Use the literal character " or ' directly instead. Always run node --input-type=module syntax check before delivering any .js file.

L099 — Diff before AND after every delivery
Before: diff your output against the original to confirm only intended changes exist. After: if the user reports a problem, diff again to find what slipped through. Never trust memory — always diff the files.
L100 — New CSS card structures require matching JS card builder updates
If CSS expects .testimonial-photo-wrap and .testimonial-content divs, the JS that builds the HTML must also output those divs. CSS and JS card structure must always match — check both together before delivering.

L101 - White text on light background — feature cards and transparent containers
Never use rgba(255,255,255,x) for text inside cards that float over the site background. The background is mostly white. Only use white text on: dark navbar, dark overlays, dark testimonial cards. Card body text must use #333333 or darker.

L102 - Cloudflare Pages _headers — wildcard JS rule silently overrides specific path rules
Never use /*.js with max-age greater than 0 if any JS file needs real-time updates. The wildcard bleeds onto specific paths and the specific path rule does not reliably win. The correct setup is to list only the specific injector files explicitly with max-age=0, must-revalidate and remove the /*.js wildcard entirely.

L103- Two systems must both release for a cached JS injector fix to take effect
When an injector JS file is corrected in GitHub and deployed successfully, the fix may still not appear because: (1) Cloudflare edge serves stale JS due to a wildcard cache rule, AND (2) the browser holds the already-executed script in memory. Both must clear together. Hard reload Cmd+Shift+R forces both. Incognito alone is not sufficient.

L104 - Debugging injected styles — use the console, not DevTools Styles panel
When a CSS class color looks wrong, run this to confirm what is actually live in the injected style block — not what GitHub says, not what DevTools guesses:
javascriptfetch('/js/iflex-config.js').then(r=>r.text()).then(t=>{
    const idx = t.indexOf('YOUR-CLASS-NAME');
    console.log(t.slice(idx, idx+120));
});







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
