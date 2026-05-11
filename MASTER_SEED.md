# PLOIKONG — MASTER SEED
## Read this first. Every chat. Every agent. No exceptions.
**Version:** 1.0  
**Created:** 2026-05-11  
**Project:** ploikong.com — Thai Collector's Marketplace  
**Owner:** Chairit Smittee / csmittee@gmail.com  
**Entity:** Janishammer Co., Ltd., Thailand  
**Repo:** github.com/Csmittee/ploikong-platform (private)

---

## WHAT THIS PROJECT IS

A three-sided trust platform for Thai collectors. Not eBay. Not Shopee.
Think Christie's auction house + Airbnb escrow + vetted agent network.

Three sides:
- **Buyers** — rich collectors with no time, trust the platform
- **Sellers** — shy collectors who want dignity, not exposure
- **Brokers** — vetted agents (max 5 in Year 1) who facilitate for both sides

Revenue model: 6% platform fee on all sales + 3% broker fee (50/50 split platform/broker) + promotions + float (7-day escrow hold).

---

## TECH STACK

| Layer | Technology |
|---|---|
| Backend | Cloudflare Workers (ploikong-api) |
| Database | Cloudflare D1 (ploikong_db) |
| File storage | Cloudflare R2 (ploikong-images) |
| Frontend | Cloudflare Pages (ploikong.com) |
| API domain | api.ploikong.com |
| Payment | Omise (PromptPay + credit card) |
| Email | Zoho OAuth (same credentials as Satu/Janis) |
| Images | Cloudinary (folder: /ploikong/) |
| Monitoring | Airtable (new base: Ploikong Operations) |
| Encryption | Web Crypto API — AES-256-GCM in Worker |

**Pattern source:** Satu backend (api.janishammer.com) — copy jwt.js, auth middleware, rateLimit.js, logging.js, Omise handler, webhook handler, admin dashboard, test suite pattern.

---

## DECISIONS ALREADY MADE (DO NOT REVISIT)

1. **Membership** — invitation-only at launch. `membership_applications` table stages applicants. Approved → INSERT to `members`. Rejected → stays in applications. Future public registration = skip application table, code path only.

2. **Broker fee** — platform-fixed at 3% total, split 50/50. All rates live in `platform_config` table. Never hardcoded. Dashboard to change them.

3. **Offers** — full seller toolkit: buyer_offer, seller_counter, seller_mass_offer. Time-limited. `offers` table built now.

4. **Encryption** — Web Crypto API (AES-256-GCM) in Worker for: `members.payout_account`, `broker_documents.r2_key`. Thai ID = SHA-256 one-way hash only. See `src/utils/crypto.js` (to be built).

5. **Escrow timeline** — `payout_due_at = delivered_at + 7 days`. `delivered_at` = buyer confirms OR auto after `auto_deliver_days` (default 14). Cron releases.

6. **Consent wall** — Option B: browsing allowed, transacting blocked until latest legal docs signed. `members.pending_consent = 1` triggers wall.

7. **Broker approval** — Option C: owner + lawyer both receive every 14-day compliance report. Either can raise a flag. Flag = auto-suspend pending investigation.

8. **Payment firewall** — HARDCODED (not configurable): all money flows Omise → Ploikong escrow → seller. Broker never touches money. `payment_outside_platform_reports` table for violations.

9. **Support team roles** — owner | ops_manager | support_agent | legal_officer | compliance_auditor. All in `staff` table with explicit permission flags.

10. **Staff seed** — owner: csmittee@gmail.com. Legal officer: legal_temp@ploikong.com (placeholder until real lawyer). UPDATE when lawyer confirmed.

---

## SCHEMA STATUS

**File:** `src/db/schema.sql`  
**Tables:** 29  
**Status:** ✅ COMPLETE — ready to run in D1 Console  
D1 database_id: [paste yours here]
Schema deployed: 2026-05-11 ✅
Verified: 30 tables, 72 indexes, 2 staff, 11 config rows
Table groups:
```
IDENTITY & ACCESS (4):     members, membership_applications, staff, staff_action_log
LISTINGS & COMMERCE (5):   listings, offers, bids, orders, broker_commission_log
BROKER VETTING (5):        broker_applications, broker_documents, broker_compliance_checks, broker_flags, payment_outside_platform_reports
MEMBER ENGAGEMENT (5):     watchlist, saved_searches, messages, reviews, stories
LEGAL INFRASTRUCTURE (4):  platform_config, legal_documents, member_consents, consent_audit_export
NOTIFICATIONS & OPS (3):   promotions, notification_queue, airtable_sync_log
PLATFORM HEALTH (3):       audit_log, rate_limit_counters, cron_log
```

Verification: after running schema.sql in D1 Console, expect:
- 29 tables (+ _cf_KV = 30 total)
- 57 indexes
- 2 staff seed rows (owner + legal officer placeholder)
- 11 platform_config rows
- 3 legal_document placeholder rows

---

## BUILD ORDER — WHAT IS DONE / WHAT IS NEXT

### ✅ DONE
- [x] Master concept (CONCEPT_MASTER_PORTFOLIO.md)
- [x] Blueprint (PLOIKONG_BLUEPRINT_md.txt)
- [x] schema.sql — 29 tables, complete
- [x] All architectural decisions locked

### 🔲 NEXT — DO IN THIS ORDER

**Step 1 — Cloudflare Setup (manual — you do this)**
```
1. Cloudflare Dashboard → D1 → Create Database: ploikong_db
2. Copy the database_id
3. D1 Console → paste and run schema.sql
4. Run verification queries — confirm 29 tables, 57 indexes
5. Create R2 bucket: ploikong-images
6. Create Worker: ploikong-api
7. Create Pages project: ploikong-frontend
```

**Step 2 — wrangler.toml** (Claude writes this — file ready in outputs/)

**Step 3 — src/index.js router** (Claude writes this — copy Satu pattern, new routes)

**Step 4 — src/utils/** (Claude writes these)
- `jwt.js` — identical copy from Satu
- `crypto.js` — NEW: AES-256-GCM encrypt/decrypt for payout_account
- `slugify.js` — NEW: URL-safe listing slugs
- `email.js` — copy from Satu/Janis Zoho OAuth

**Step 5 — src/middleware/** (Claude writes these)
- `auth.js` — copy from Satu, adapt for members + staff dual auth
- `rateLimit.js` — identical copy from Satu
- `logging.js` — identical copy from Satu

**Step 6 — src/handlers/auth.js** — register (via application), login, JWT

**Step 7 — src/handlers/listings.js** — CRUD, slug generation, broker listing

**Step 8 — src/handlers/members.js** — profile, showroom, watchlist

**Step 9 — src/handlers/orders.js** — create order, escrow logic, confirm delivery

**Step 10 — src/handlers/payment.js + webhook.js** — Omise, copy from Satu 80%

**Step 11 — src/handlers/bids.js** — auction engine, auto-bid

**Step 12 — src/handlers/offers.js** — direct, counter, mass offer

**Step 13 — src/handlers/admin.js** — member approval, listing moderation, config dashboard

**Step 14 — src/handlers/broker.js** — application pipeline, compliance checks, vetting

**Step 15 — src/handlers/legal.js** — document deploy, consent wall, export

**Step 16 — src/handlers/chat.js** — DM, flagging, broker monitoring

**Step 17 — src/handlers/stories.js** — blog CRUD

**Step 18 — public/index.html** — cinematic landing page (dark luxury, Playfair Display)

**Step 19 — public/listing.html** — single item page

**Step 20 — public/sell.html** — create listing (seller toolkit)

**Step 21 — public/profile.html** — member showroom

**Step 22 — public/admin/index.html** — full admin dashboard (config, broker, legal)

**Step 23 — tests/ploikong-tester.html** — 20-test suite

**Step 24 — Airtable sync Worker** — one-shot table creation

---

## CRON JOBS (every 6 hours)

| Job | What it does |
|---|---|
| `expire_listings` | Auctions past end time → expired |
| `release_payouts` | `payout_due_at < now` → release escrow, email seller |
| `process_notifications` | Send queued Zoho emails (max 3 attempts) |
| `check_saved_searches` | Match new listings to member saved searches, queue alerts |
| `broker_compliance_due` | Flag brokers whose 14-day check is due, email compliance_auditor |
| `check_insurance_expiry` | 30-day warning / day-of auto-suspend |
| `cleanup_rate_limits` | Delete stale rate_limit_counters rows |
| `expire_offers` | Offers past `expires_at` → expired |

---

## SECRETS NEEDED (set via Cloudflare Dashboard → Workers → Settings → Variables)

```
JWT_SECRET              — new random 32+ char string for Ploikong
ADMIN_SECRET            — X-Admin-Token for admin dashboard
OMISE_SECRET_KEY        — Omise API key
OMISE_WEBHOOK_SECRET    — Omise webhook signing secret
ZOHO_CLIENT_ID          — same as Satu/Janis
ZOHO_CLIENT_SECRET      — same as Satu/Janis
ZOHO_REFRESH_TOKEN      — same as Satu/Janis
ALERT_EMAIL             — chairit.smittee@janishammer.com
CLOUDINARY_API_KEY      — for server-side upload signing
CLOUDINARY_API_SECRET   — for server-side upload signing
CLOUDINARY_CLOUD_NAME   — your cloud name
PAYMENT_MODE            — fake (change to live when hardware tested)
ENCRYPTION_KEY          — 32-byte hex key for AES-256-GCM (generate once, never change)
```

---

## DESIGN SYSTEM (use in every HTML file)

```css
--bg:       #0a0a0a;   /* near black, warm */
--surface:  #141414;   /* card backgrounds */
--border:   #2a2a2a;   /* subtle separation */
--gold:     #c9a84c;   /* aged gold accent */
--text:     #e8e0d0;   /* warm white */
--muted:    #6b6560;   /* warm grey */
--green:    #4a7c59;   /* forest green */
--red:      #8b3a3a;   /* deep red */
```

Fonts (Google Fonts):
- Display: "Playfair Display" — headings, item titles
- Body: "DM Sans" — paragraphs, UI
- Mono: "JetBrains Mono" — prices, codes, IDs

---

## HOW TO HAND OFF TO A NEW CLAUDE SESSION

Start every new chat with:

```
Read MASTER_SEED.md first. 
We are building Ploikong (ploikong.com) — Thai collector's marketplace.
Schema is complete (29 tables). 
Today's task: [specific step from build order above]
Here are the relevant files: [attach only what that step needs]
```

Attach only the files relevant to that step. Do not paste the entire codebase.
Each chat = one handler file, or one HTML page, or one utility. One lane.

---

## PARALLEL CHAT LANES (run simultaneously if needed)

| Lane | Responsibility | Files needed |
|---|---|---|
| A | Auth + middleware | schema.sql, Satu auth.js reference |
| B | Listings + offers + bids | schema.sql |
| C | Orders + payment + webhook | schema.sql, Satu order.js reference |
| D | Broker vetting system | schema.sql |
| E | Legal infrastructure | schema.sql |
| F | Frontend pages | design system above |
| G | Admin dashboard | schema.sql, Satu admin pattern |

Lanes never overlap. Each lane produces its files. Owner integrates.

---

## IP PROTECTION NOTE

All business logic (broker vetting engine, escrow state machine, consent system, compliance surveillance) runs server-side in Cloudflare Workers only. No logic exposed in frontend JavaScript. This is the natural protection layer. When licensing/acquisition conversations happen — the engine is invisible to any buyer.

---

*MASTER_SEED.md — save to repo root. Commit with every major milestone.*  
*This document IS the project memory. Keep it updated.*
