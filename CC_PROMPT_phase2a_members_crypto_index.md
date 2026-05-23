# CC_PROMPT_phase2a_members_crypto_index.md

> **Status:** 🔲 PENDING
> **Assigned to:** CC (Claude Code)
> **Created by:** Chat — 2026-05-24
> **Repo:** https://github.com/Csmittee/ploikong-platform

---

## YOUR STARTUP CHECKLIST (do this first, every session)

1. Read `masterseed.md` from repo root — understand current phase and file inventory
2. Read `lessons_learned.md` from repo root — know the rules before touching anything
3. Read this prompt fully before writing a single line
4. Read every source file mentioned below FRESH from the repo before editing

---

## CONTEXT

Phase 1 backend is complete. Phase 2 begins here.

Three things need to happen in this session, in this order:

1. **Commit the updated `src/index.js`** — broker routes are wired in (file provided below as a diff description — CC reads the current file from repo and applies changes)
2. **Build `src/utils/crypto.js`** — AES-256-GCM encrypt/decrypt. URGENT: payout_account is currently stored unencrypted (PDPA risk)
3. **Build `src/handlers/members.js`** — member profile, watchlist, my listings

---

## TASK 1 — Update src/index.js

Read the current `src/index.js` from the repo. Apply these three changes:

### Change A — Add broker import (after the offers import line)
```javascript
import {
  handleApplyBroker,
  handleListBrokerApps, handleGetBrokerApp,
  handleAdvanceBrokerPhase, handleApproveBroker,
  handleRejectBroker, handleSuspendBroker, handleReinstateBroker,
  handleAttachBrokerDocument, handleListBrokerDocuments,
  handleListComplianceChecks, handleCreateComplianceCheck, handleRecordComplianceResult,
  handleListBrokerFlags, handleRaiseBrokerFlag, handleResolveBrokerFlag,
  handleReportPaymentBypass, handleListPaymentReports, handleResolvePaymentReport
} from './handlers/broker.js';
```

### Change B — Add member broker routes (inside member JWT block, before the final 404)
```javascript
// ── Broker (member actions) ─────────────────────────────────────────────────
if (path === '/v1/brokers/apply' && method === 'POST') {
    return respond(await handleApplyBroker(request, env, memberId));
}
if (path === '/v1/brokers/report' && method === 'POST') {
    return respond(await handleReportPaymentBypass(request, env, memberId));
}
```

### Change C — Replace the staff stub block entirely
Replace the block starting `if (path.startsWith('/v1/staff/') || path.startsWith('/v1/admin/'))` with this complete version:

```javascript
if (path.startsWith('/v1/staff/') || path.startsWith('/v1/admin/')) {
    const staffAuth = await authenticateStaffJWT(request, env);
    if (!staffAuth.valid) return respond({ error: 'Unauthorized' }, { status: 401 });
    const staff = staffAuth.staff; // { id, role, can_approve_brokers, ... } — L085

    // ── Broker reports — exact paths BEFORE numeric-id regex (L079, L086) ──
    if (path === '/v1/admin/brokers/reports' && method === 'GET') {
        return respond(await handleListPaymentReports(request, env, staff));
    }
    if (path.match(/^\/v1\/admin\/brokers\/reports\/\d+\/resolve$/) && method === 'POST') {
        const reportId = parseInt(path.split('/')[5]);
        return respond(await handleResolvePaymentReport(reportId, request, env, staff));
    }
    if (path.match(/^\/v1\/admin\/brokers\/flags\/\d+\/resolve$/) && method === 'POST') {
        const flagId = parseInt(path.split('/')[5]);
        return respond(await handleResolveBrokerFlag(flagId, request, env, staff));
    }

    // ── Broker applications ─────────────────────────────────────────────────
    if (path === '/v1/admin/brokers' && method === 'GET') {
        return respond(await handleListBrokerApps(request, env, staff));
    }
    if (path.match(/^\/v1\/admin\/brokers\/\d+$/) && method === 'GET') {
        const appId = parseInt(path.split('/')[4]);
        return respond(await handleGetBrokerApp(appId, env));
    }
    if (path.match(/^\/v1\/admin\/brokers\/\d+\/advance$/) && method === 'POST') {
        const appId = parseInt(path.split('/')[4]);
        return respond(await handleAdvanceBrokerPhase(appId, request, env, staff));
    }
    if (path.match(/^\/v1\/admin\/brokers\/\d+\/approve$/) && method === 'POST') {
        const appId = parseInt(path.split('/')[4]);
        return respond(await handleApproveBroker(appId, request, env, staff));
    }
    if (path.match(/^\/v1\/admin\/brokers\/\d+\/reject$/) && method === 'POST') {
        const appId = parseInt(path.split('/')[4]);
        return respond(await handleRejectBroker(appId, request, env, staff));
    }
    if (path.match(/^\/v1\/admin\/brokers\/\d+\/suspend$/) && method === 'POST') {
        const appId = parseInt(path.split('/')[4]);
        return respond(await handleSuspendBroker(appId, request, env, staff));
    }
    if (path.match(/^\/v1\/admin\/brokers\/\d+\/reinstate$/) && method === 'POST') {
        const appId = parseInt(path.split('/')[4]);
        return respond(await handleReinstateBroker(appId, request, env, staff));
    }

    // ── Broker documents ────────────────────────────────────────────────────
    if (path.match(/^\/v1\/admin\/brokers\/\d+\/documents$/) && method === 'POST') {
        const appId = parseInt(path.split('/')[4]);
        return respond(await handleAttachBrokerDocument(appId, request, env, staff));
    }
    if (path.match(/^\/v1\/admin\/brokers\/\d+\/documents$/) && method === 'GET') {
        const appId = parseInt(path.split('/')[4]);
        return respond(await handleListBrokerDocuments(appId, env));
    }

    // ── Broker compliance ───────────────────────────────────────────────────
    if (path.match(/^\/v1\/admin\/brokers\/\d+\/compliance\/\d+\/result$/) && method === 'POST') {
        const parts = path.split('/');
        const appId = parseInt(parts[4]);
        const checkId = parseInt(parts[6]);
        return respond(await handleRecordComplianceResult(appId, checkId, request, env, staff));
    }
    if (path.match(/^\/v1\/admin\/brokers\/\d+\/compliance$/) && method === 'GET') {
        const appId = parseInt(path.split('/')[4]);
        return respond(await handleListComplianceChecks(appId, env));
    }
    if (path.match(/^\/v1\/admin\/brokers\/\d+\/compliance$/) && method === 'POST') {
        const appId = parseInt(path.split('/')[4]);
        return respond(await handleCreateComplianceCheck(appId, request, env, staff));
    }

    // ── Broker flags ────────────────────────────────────────────────────────
    if (path.match(/^\/v1\/admin\/brokers\/\d+\/flags$/) && method === 'GET') {
        const appId = parseInt(path.split('/')[4]);
        return respond(await handleListBrokerFlags(appId, env));
    }
    if (path.match(/^\/v1\/admin\/brokers\/\d+\/flag$/) && method === 'POST') {
        const appId = parseInt(path.split('/')[4]);
        return respond(await handleRaiseBrokerFlag(appId, request, env, staff));
    }

    // ── Remaining lanes (not yet built) ────────────────────────────────────
    // GET  /v1/admin/members, POST /v1/admin/members/:id/approve|suspend|ban  (admin.js)
    // GET/POST /v1/admin/legal, POST /v1/admin/legal/:id/publish              (legal.js)
    // GET /v1/admin/config, PUT /v1/admin/config/:key                         (admin.js)
    // GET /v1/admin/disputes, POST /v1/admin/disputes/:orderId/resolve        (admin.js)

    return respond({ error: 'Staff route not found.' }, { status: 404 });
}
```

**Commit message:** `feat: wire broker routes into index.js, activate staff JWT auth`

---

## TASK 2 — Build src/utils/crypto.js

This is URGENT — `payout_account` is currently stored unencrypted.

Build a complete `src/utils/crypto.js` with these exports:

- `encrypt(plaintext, env)` — AES-256-GCM, returns `iv_b64.ciphertext_b64` string
- `decrypt(ciphertext, env)` — reverses encrypt
- Key is loaded from `env.ENCRYPTION_KEY` (32-byte hex string)
- Must use Web Crypto API only (built into Cloudflare Workers — no npm packages)

Rules:
- Random IV per encryption call (12 bytes)
- Base64-encode both IV and ciphertext
- Store as `ivB64.cipherB64` — split on first `.`
- If `env.ENCRYPTION_KEY` is missing, throw a clear error: `'ENCRYPTION_KEY secret not set'`
- Export a named `hashOneWay(plaintext)` function using SHA-256 for Thai ID hashing

**Commit message:** `feat: add src/utils/crypto.js — AES-256-GCM encrypt/decrypt for PDPA compliance`

---

## TASK 3 — Build src/handlers/members.js

### Routes to implement:

**Member JWT required (all):**

| Method | Path | Function | Description |
|---|---|---|---|
| GET | `/v1/me` | `handleGetMe` | Own full profile |
| PUT | `/v1/me` | `handleUpdateMe` | Update name, bio, avatar, payout |
| GET | `/v1/me/listings` | `handleGetMyListings` | My listings with status filter |
| GET | `/v1/me/watchlist` | `handleGetWatchlist` | My watchlist |
| POST | `/v1/listings/:id/watch` | `handleAddWatch` | Add to watchlist |
| DELETE | `/v1/listings/:id/watch` | `handleRemoveWatch` | Remove from watchlist |
| GET | `/v1/me/notifications` | `handleGetNotifications` | Unread notification_queue items |

**Public (no auth):**

| Method | Path | Function | Description |
|---|---|---|---|
| GET | `/v1/members/:username` | `handleGetMemberProfile` | Public showroom |

### Key rules for members.js:
- `handleGetMe`: decrypt `payout_account` using `crypto.js` before returning. Never return `password_hash`.
- `handleUpdateMe`: if `payout_account` is in the body, encrypt it with `crypto.js` before storing.
- `handleGetMemberProfile`: public endpoint — never return email, phone, payout_account, password_hash, thai_id_hash. Return: username, name, bio, avatar_url, cover_url, broker_code, seller_rating, total_sales, created_at + their active listings.
- `handleGetWatchlist`: JOIN listings, return listing detail for each watchlist entry.
- All transactional POSTs: call `requireConsent()` first (L064).
- Follow L061 — no hardcoded values.
- Follow L067 — never send email inline.

**Commit message:** `feat: add src/handlers/members.js — profile, watchlist, public showroom`

---

## TASK 4 — Wire members.js into src/index.js

After building members.js, update index.js to activate its routes.

Add import:
```javascript
import { handleGetMe, handleUpdateMe, handleGetMyListings,
         handleGetWatchlist, handleAddWatch, handleRemoveWatch,
         handleGetNotifications, handleGetMemberProfile } from './handlers/members.js';
```

Public route (above authenticateMemberJWT — L075):
```javascript
// Already stubbed — replace the 503 response:
if (path.match(/^\/v1\/members\/[^/]+$/) && method === 'GET') {
    const username = path.split('/')[3];
    return respond(await handleGetMemberProfile(username, env));
}
```

Member JWT routes (inside auth block):
```javascript
// ── My profile ─────────────────────────────────────────────────────────────
if (path === '/v1/me' && method === 'GET') {
    return respond(await handleGetMe(request, env, memberId));
}
if (path === '/v1/me' && method === 'PUT') {
    return respond(await handleUpdateMe(request, env, memberId));
}
if (path === '/v1/me/listings' && method === 'GET') {
    return respond(await handleGetMyListings(request, env, memberId));
}
if (path === '/v1/me/watchlist' && method === 'GET') {
    return respond(await handleGetWatchlist(request, env, memberId));
}
if (path === '/v1/me/notifications' && method === 'GET') {
    return respond(await handleGetNotifications(request, env, memberId));
}
// ── Watchlist actions — exact before listing regex (L079) ──────────────────
if (path.match(/^\/v1\/listings\/\d+\/watch$/) && method === 'POST') {
    const listingId = parseInt(path.split('/')[3]);
    return respond(await handleAddWatch(listingId, env, memberId));
}
if (path.match(/^\/v1\/listings\/\d+\/watch$/) && method === 'DELETE') {
    const listingId = parseInt(path.split('/')[3]);
    return respond(await handleRemoveWatch(listingId, env, memberId));
}
```

**Commit message:** `feat: wire members routes into index.js`

---

## AFTER ALL TASKS — CC must do this

1. Move this file to `docs/prompts/CC_PROMPT_phase2a_members_crypto_index.md`
2. Add `✅ COMPLETE — [date] — members.js + crypto.js + index.js broker/member routes wired` at the top
3. Update `masterseed.md`:
   - Mark Phase 2 tasks done in the build phases table
   - Update file inventory (crypto.js ✅, members.js ✅)
   - Update "Current State" section
4. Append any new lessons to `lessons_learned.md` with next L-numbers (starts at L088)
5. Commit: `docs: update masterseed + lessons_learned after phase2a`

---

## SCHEMA REFERENCE (tables used in this prompt)

- `members` — id, email, password_hash, name, username, bio, avatar_url, cover_url, role, status, pending_consent, broker_code, seller_rating, buyer_rating, total_sales, payout_method, payout_account (encrypted), created_at
- `watchlist` — id, member_id, listing_id, created_at. UNIQUE(member_id, listing_id)
- `listings` — id, seller_id, title, slug, status, selling_type, price, auction_end, images, created_at
- `notification_queue` — id, member_id, to_email, template, payload, status, read_at, created_at
