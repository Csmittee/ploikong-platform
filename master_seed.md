# 🌱 MASTERSEED — Ploikong Platform
> **Last Updated:** 2026-05-24 — Backend Phase 1 complete. Moving to CC workflow. Frontend Phase starts next.
> **Version:** 2.0 — Merged from MASTER_SEED.md + PLOIKONG_BLUEPRINT + schema.sql summary

---

## PROJECT IDENTITY

**ploikong.com** — Thai Collector's Marketplace
A three-sided trust platform. Not eBay. Not Shopee.
Think Christie's auction house + Airbnb escrow + vetted agent network.

- **Buyers** — rich collectors, no time, trust the platform
- **Sellers** — shy collectors who want dignity, not exposure
- **Brokers** — vetted agents (max 5 in Year 1) who facilitate both sides

**Owner:** Chairit Smittee / csmittee@gmail.com
**Entity:** Janishammer Co., Ltd., Thailand
**Repo:** https://github.com/Csmittee/ploikong-platform (private)

**Revenue model:**
- 6% platform fee on all sales
- 3% broker fee (50/50 split platform/broker) when broker involved
- Promotions + 7-day escrow float

---

## OPERATING MODEL (CC Era — from 2026-05-24)

Three roles. Read WORKFLOW_SKILL.md for the full loop.

| Role | Who | Does |
|---|---|---|
| **Owner** | Chairit | Describes goal, QAs live result, reports back |
| **Chat** | Claude Chat | Reads repo, diagnoses, writes CC prompts, reviews output |
| **CC** | Claude Code | Reads fresh from repo, writes complete files, commits, updates docs |

**CC must do after every session:**
1. Commit all changed files
2. Move prompt file → `docs/prompts/` stamped `✅ COMPLETE`
3. Update `masterseed.md` — phase status, file inventory, current state
4. Append new lessons to `lessons_learned.md` with next L-number
5. Commit docs separately: `docs: update masterseed + lessons_learned after [task]`

---

## TECH STACK

| Layer | Technology | Status |
|---|---|---|
| Backend | Cloudflare Workers (`ploikong-api`) | ✅ Live |
| Database | Cloudflare D1 (`ploikong_db`) | ✅ Live — 29 tables deployed |
| File Storage | Cloudflare R2 (`ploikong-images`) | ✅ Created |
| Frontend | Cloudflare Pages (`ploikong.com`) | 🔲 Not started |
| API Domain | api.ploikong.com | ✅ Routing to Worker |
| Payment | Omise (PromptPay + credit card) | ✅ Handler built, fake mode |
| Email | Zoho OAuth | 🔲 email.js not built yet |
| Images | Cloudinary (folder: `/ploikong/`) | 🔲 Not integrated yet |
| Monitoring | Airtable (base: Ploikong Operations) | 🔲 Sync worker not built |
| Encryption | Web Crypto API — AES-256-GCM in Worker | 🔲 crypto.js not built yet |

---

## LOCKED DECISIONS (never revisit these)

1. **Membership** — invitation-only at launch. `membership_applications` stages applicants. Approved → INSERT to `members`. Future public reg = code path only, no schema change.

2. **Broker fee** — 3% total, 50/50 split. All rates in `platform_config`. Never hardcoded.

3. **Offers** — three types: buyer_offer, seller_counter, seller_mass_offer. Time-limited.

4. **Encryption** — AES-256-GCM for `members.payout_account` and `broker_documents.r2_key`. Thai ID = SHA-256 one-way hash only. Lives in `src/utils/crypto.js` (not built yet).

5. **Escrow** — `payout_due_at = delivered_at + 7 days`. Auto-deliver after 14 days. Cron releases.

6. **Consent wall** — Option B: browse freely, transact blocked until latest docs signed. `members.pending_consent = 1` is the flag.

7. **Broker compliance** — Option C: owner AND lawyer receive every 14-day report. Flag = auto-suspend.

8. **Payment firewall** — HARDCODED, not configurable. All money: Omise → Ploikong escrow → seller. Broker never touches money. Violations logged to `payment_outside_platform_reports`.

9. **Staff roles** — owner | ops_manager | support_agent | legal_officer | compliance_auditor. In `staff` table with permission flags.

10. **Staff seed** — owner: csmittee@gmail.com. Legal: legal_temp@ploikong.com (update when lawyer confirmed).

---

## DATABASE — 29 TABLES (✅ DEPLOYED)

**D1 database_id:** `ea1289d3-e265-496a-9cf5-45f225955d7e`
**Schema file:** `schema.sql` (repo root)
**Verified:** 29 tables + _cf_KV, 57 indexes, 2 staff rows, 11 config rows, 3 legal doc placeholders

```
IDENTITY & ACCESS (4):      members, membership_applications, staff, staff_action_log
LISTINGS & COMMERCE (5):    listings, offers, bids, orders, broker_commission_log
BROKER VETTING (5):         broker_applications, broker_documents, broker_compliance_checks,
                            broker_flags, payment_outside_platform_reports
MEMBER ENGAGEMENT (5):      watchlist, saved_searches, messages, reviews, stories
LEGAL INFRASTRUCTURE (4):   platform_config, legal_documents, member_consents, consent_audit_export
NOTIFICATIONS & OPS (3):    promotions, notification_queue, airtable_sync_log
PLATFORM HEALTH (3):        audit_log, rate_limit_counters, cron_log
```

**Key platform_config values (live in DB):**
- `platform_fee_pct` = 6.0%
- `broker_fee_pct` = 3.0%
- `escrow_hold_days` = 7
- `auto_deliver_days` = 14
- `max_broker_count` = 5
- `compliance_check_days` = 14
- `insurance_warn_days` = 30
- `payment_mode` = fake

---

## BUILD PHASES

### Phase 1 — Backend API ✅ COMPLETE

| Handler | File | Status |
|---|---|---|
| Auth | `src/handlers/auth.js` | ✅ Built + wired |
| Listings | `src/handlers/listings.js` | ✅ Built + wired |
| Search | `src/handlers/search.js` | ✅ Built + wired |
| Orders | `src/handlers/orders.js` | ✅ Built + wired |
| Payment | `src/handlers/payment.js` | ✅ Built + wired (fake mode) |
| Webhook | `src/handlers/webhook.js` | ✅ Built + wired |
| Bids | `src/handlers/bids.js` | ✅ Built + wired |
| Offers | `src/handlers/offers.js` | ✅ Built + wired |
| Broker | `src/handlers/broker.js` | ✅ Built — index.js update pending |

| Middleware | File | Status |
|---|---|---|
| Member + Staff JWT | `src/middleware/auth.js` | ✅ Built + wired |
| Rate limiter | `src/middleware/rateLimit.js` | ✅ Built (not yet active in routes) |
| Audit logger | `src/middleware/logging.js` | 🔲 Not built |

| Utility | File | Status |
|---|---|---|
| JWT sign/verify | `src/utils/jwt.js` | ✅ Built |
| URL slugs | `src/utils/slugify.js` | ✅ Built |
| AES-256-GCM | `src/utils/crypto.js` | 🔲 Not built |
| Zoho email | `src/utils/email.js` | 🔲 Not built |

### Phase 2 — Backend Completion 🔲 (hand to CC)

| Handler | File | Routes |
|---|---|---|
| Members | `src/handlers/members.js` | `/v1/me`, `/v1/me/watchlist`, `/v1/members/:username` |
| Legal | `src/handlers/legal.js` | `/v1/consent/*`, `/v1/admin/legal/*` |
| Admin | `src/handlers/admin.js` | `/v1/admin/members/*`, `/v1/admin/config`, `/v1/admin/disputes/*` |
| Chat | `src/handlers/chat.js` | `/v1/chat`, `/v1/chat/:memberId` |
| Stories | `src/handlers/stories.js` | `/v1/stories` CRUD |
| Crypto util | `src/utils/crypto.js` | AES-256-GCM encrypt/decrypt |
| Email util | `src/utils/email.js` | Zoho OAuth queue helper |

### Phase 3 — Frontend 🔲 (hand to CC)

| Page | File | Depends on |
|---|---|---|
| Homepage | `public/index.html` | Listings GET ✅ |
| Single listing | `public/listing.html` | Listings GET ✅, Bids ✅ |
| Sell / create | `public/sell.html` | Auth ✅, Listings POST ✅ |
| Member profile | `public/profile.html` | Members (Phase 2) |
| Search | `public/search.html` | Search ✅ |
| Checkout | `public/basket.html` | Orders ✅, Payment ✅ |
| Admin dashboard | `public/admin/index.html` | Admin (Phase 2) |
| Shared JS | `public/assets/js/api.js` | All handlers |
| Shared styles | `public/assets/css/ploikong.css` | Design system |

### Phase 4 — Testing + Ops 🔲

- `tests/ploikong-tester.html` — 20-test suite
- Airtable sync Worker
- `src/utils/email.js` Zoho integration activate
- `src/middleware/logging.js` activate
- Payment mode: fake → live

---

## CURRENT STATE (2026-05-24)

**What is working:**
- Worker deployed at `https://ploikong-api.[account].workers.dev`
- Auto-deploy: GitHub main → Cloudflare ✅
- All Phase 1 handlers built and live
- Staff JWT auth now active (broker routes wire-in pending — new index.js ready but not yet committed)

**Immediate next action:**
- Commit updated `src/index.js` (broker routes wired, staff JWT active) — file ready in CC hands
- Then begin Phase 2 with CC: start with `members.js` + `crypto.js` together

**Known gaps:**
- `crypto.js` not built — payout_account stored unencrypted until built (PDPA risk)
- `email.js` not built — notifications queued but never sent
- broker.js wired in index.js but index.js not yet committed

---

## FILE INVENTORY (actual repo state 2026-05-24)

```
ploikong-platform/
├── masterseed.md              ✅ (this file — just updated)
├── lessons_learned.md         ✅ (CC maintains)
├── WORKFLOW_SKILL.md          ✅ (operating model)
├── schema.sql                 ✅ deployed to D1
├── wrangler.toml              ✅ configured
├── README.md                  ✅
├── docs/
│   └── prompts/               (CC archives completed prompts here)
├── src/
│   ├── index.js               ✅ (broker wire-in pending commit)
│   ├── handlers/
│   │   ├── auth.js            ✅
│   │   ├── listings.js        ✅
│   │   ├── search.js          ✅
│   │   ├── orders.js          ✅
│   │   ├── payment.js         ✅
│   │   ├── webhook.js         ✅
│   │   ├── bids.js            ✅
│   │   ├── offers.js          ✅
│   │   ├── broker.js          ✅ (needs index.js commit to activate)
│   │   ├── members.js         🔲
│   │   ├── legal.js           🔲
│   │   ├── admin.js           🔲
│   │   ├── chat.js            🔲
│   │   └── stories.js         🔲
│   ├── middleware/
│   │   ├── auth.js            ✅
│   │   ├── rateLimit.js       ✅
│   │   └── logging.js         🔲
│   └── utils/
│       ├── jwt.js             ✅
│       ├── slugify.js         ✅
│       ├── crypto.js          🔲 URGENT — PDPA risk
│       └── email.js           🔲
└── public/                    🔲 entire folder — Phase 3
```

---

## CRON JOBS (active in index.js — runs every 6h)

| Job | What it does |
|---|---|
| `expire_listings` | Auctions past end time → expired |
| `release_payouts` | `payout_due_at < now` → release escrow |
| `process_notifications` | Send queued emails (stub — email.js not built) |
| `check_saved_searches` | Match listings to saved searches (stub) |
| `broker_compliance_due` | Flag brokers overdue for 14-day check |
| `check_insurance_expiry` | Warn/suspend brokers with lapsing insurance |
| `cleanup_rate_limits` | Delete stale rate_limit_counters rows |
| `expire_offers` | Offers past `expires_at` → expired |

---

## SECRETS (set in Cloudflare Dashboard → Workers → ploikong-api → Settings)

```
JWT_SECRET              ✅ set
ADMIN_SECRET            ✅ set
OMISE_SECRET_KEY        ✅ set
OMISE_WEBHOOK_SECRET    ✅ set
ENCRYPTION_KEY          🔲 generate when crypto.js is built
ZOHO_CLIENT_ID          🔲 set when email.js is built
ZOHO_CLIENT_SECRET      🔲 set when email.js is built
ZOHO_REFRESH_TOKEN      🔲 set when email.js is built
ALERT_EMAIL             chairit.smittee@janishammer.com
CLOUDINARY_API_KEY      🔲 set when image upload built
CLOUDINARY_API_SECRET   🔲 set when image upload built
CLOUDINARY_CLOUD_NAME   🔲 set when image upload built
PAYMENT_MODE            fake (change to live when ready)
ENVIRONMENT             production
```

---

## DESIGN SYSTEM (use in every public/ HTML file)

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

**Fonts (Google Fonts):**
- Display: `Playfair Display` — headings, item titles
- Body: `DM Sans` — paragraphs, UI
- Mono: `JetBrains Mono` — prices, codes, IDs

**Feeling:** Dark luxury. Like Christie's meets a Thai antique dealer's study. Never cluttered. Never cheap.

---

## CRITICAL RULES (CC must follow every session)

| # | Rule | Lesson |
|---|---|---|
| 1 | All business rates from `platform_config` — never hardcode | L061 |
| 2 | Member JWT and Staff JWT are completely separate | L062 |
| 3 | Payment firewall is hardcoded — broker never touches money | L063 |
| 4 | `requireConsent()` on every transactional POST | L064 |
| 5 | Never send email inline — always queue to `notification_queue` | L067 |
| 6 | Encrypt sensitive columns in Worker before INSERT, decrypt after SELECT | L060 |
| 7 | Exact routes before regex routes in index.js | L079, L082 |
| 8 | Public GET routes above the `authenticateMemberJWT` call | L075 |
| 9 | File names must match import paths exactly — no dashes vs dots | L087 |
| 10 | Read all relevant files fresh from repo before writing anything | WORKFLOW |
| 11 | Write complete replacement files — never patches or diffs | WORKFLOW |
| 12 | `staff` object = `staffAuth.staff` — never pass `staffAuth` itself | L085 |

---

*masterseed.md — single source of truth. CC updates after every session.*
