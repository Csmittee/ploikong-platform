# CC_PROMPT_phase2b_cleanup_wrangler_utils.md

> **Status:** 🔲 PENDING — run AFTER phase2a is complete and deployed green
> **Assigned to:** CC (Claude Code)
> **Created by:** Chat — 2026-05-24
> **Repo:** https://github.com/Csmittee/ploikong-platform

---

## YOUR STARTUP CHECKLIST

1. Read `masterseed.md` — verify phase2a is marked complete before starting this
2. Read `lessons_learned.md`
3. Read this prompt fully
4. Read every file mentioned below FRESH from the repo

---

## CONTEXT

Phase 2a introduced members.js and crypto.js. This session cleans up technical debt
found in the audit, and fixes a wrangler.toml bug causing deploy warnings.
No new features. Consolidation and correctness only.

---

## TASK 1 — Fix wrangler.toml routes placement bug

**Problem:** `routes = [...]` is currently indented inside the `[[r2_buckets]]` block.
TOML reads it as a property of r2_buckets (invalid). Wrangler warns every deploy:
`"Unexpected fields found in r2_buckets[0] field: routes"`

**Fix:** Move `routes` to be a standalone top-level key, separated from r2_buckets.

Read `wrangler.toml` fresh. The correct structure is:

```toml
[[r2_buckets]]
binding     = "IMAGES"
bucket_name = "ploikong-images"

routes = [
  { pattern = "api.ploikong.com/*", zone_name = "ploikong.com" }
]
```

The blank line between `[[r2_buckets]]` block and `routes = [...]` is what makes TOML
treat them as separate top-level items. Write the complete corrected wrangler.toml.

**Commit message:** `fix: move routes out of r2_buckets block in wrangler.toml`

---

## TASK 2 — Create src/utils/helpers.js (shared utilities)

Three functions are currently copy-pasted across multiple handler files:
- `requireConsent()` — in 6 handler files (listings, orders, payment, bids, offers, broker)
- `queueNotification()` — in 4 handler files (orders, bids, offers, broker)
- `getPlatformConfig()` — in 3 handler files (orders, bids, broker)

Build `src/utils/helpers.js` that exports all three as the canonical versions:

```javascript
// src/utils/helpers.js
// Shared helpers used across multiple handlers.
// Import from here — never copy-paste these into individual handler files.

export async function getPlatformConfig(env) { ... }

export async function queueNotification(env, toEmail, template, payload, memberId = null, staffId = null) { ... }

export async function requireConsent(memberId, env) { ... }
```

Use the most complete version of each from the existing handlers (broker.js has the
most complete queueNotification signature). The requireConsent pattern must match L064.

**Commit message:** `refactor: add src/utils/helpers.js with shared getPlatformConfig, queueNotification, requireConsent`

---

## TASK 3 — Update all handler files to import from helpers.js

For each handler file that has its own local copy, replace the local function definition
with an import from helpers.js. Read each file fresh before editing.

Files to update:
- `src/handlers/listings.js` — remove local `requireConsent`, import from helpers.js
- `src/handlers/orders.js` — remove local `requireConsent`, `queueNotification`, `getPlatformConfig`
- `src/handlers/payment.js` — remove local `requireConsent`
- `src/handlers/bids.js` — remove local `requireConsent`, `queueNotification`
- `src/handlers/offers.js` — remove local `requireConsent`, `queueNotification`
- `src/handlers/broker.js` — remove local `requireConsent`, `queueNotification`, `getPlatformConfig`

Add at top of each file:
```javascript
import { getPlatformConfig, queueNotification, requireConsent } from '../utils/helpers.js';
```

Only import what each file actually uses. Do not add unused imports.

**Commit message:** `refactor: replace copy-pasted helpers with imports from utils/helpers.js`

---

## TASK 4 — Wire search routes into index.js

search.js has 4 built functions that have no active routes:
- `handleSaveSearch` — POST /v1/search/save
- `handleGetSavedSearches` — GET /v1/search/saved
- `handleDeleteSavedSearch` — DELETE /v1/search/saved/:id
- `handleToggleSavedSearchAlert` — POST /v1/search/saved/:id/toggle

Update index.js import for search:
```javascript
import {
  handleSearch,
  handleSaveSearch, handleGetSavedSearches,
  handleDeleteSavedSearch, handleToggleSavedSearchAlert
} from './handlers/search.js';
```

Add routes inside the member JWT block (exact paths before regex — L079):
```javascript
// ── Search (authenticated) ──────────────────────────────────────────────────
if (path === '/v1/search/saved' && method === 'GET') {
    return respond(await handleGetSavedSearches(env, memberId));
}
if (path === '/v1/search/save' && method === 'POST') {
    return respond(await handleSaveSearch(request, env, memberId));
}
if (path.match(/^\/v1\/search\/saved\/\d+\/toggle$/) && method === 'POST') {
    const searchId = parseInt(path.split('/')[4]);
    return respond(await handleToggleSavedSearchAlert(searchId, env, memberId));
}
if (path.match(/^\/v1\/search\/saved\/\d+$/) && method === 'DELETE') {
    const searchId = parseInt(path.split('/')[4]);
    return respond(await handleDeleteSavedSearch(searchId, env, memberId));
}
```

**Commit message:** `feat: wire search saved routes into index.js`

---

## AFTER ALL TASKS — CC must do this

1. Move this file to `docs/prompts/CC_PROMPT_phase2b_cleanup_wrangler_utils.md`
2. Add `✅ COMPLETE — [date] — wrangler fix + helpers.js + search routes wired` at top
3. Update `masterseed.md`:
   - Add `src/utils/helpers.js` ✅ to file inventory
   - Update current state section
   - Note wrangler warning resolved
4. Append new lessons to `lessons_learned.md` (next after current highest)
5. Commit: `docs: update masterseed + lessons_learned after phase2b`
