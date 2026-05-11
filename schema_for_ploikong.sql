-- ============================================================================
-- PLOIKONG.COM — COMPLETE DATABASE SCHEMA
-- Database: Cloudflare D1 (SQLite)
-- Version:  1.0.0
-- Created:  2026-05-11
-- Author:   Chairit Smittee / Janishammer Co., Ltd.
--
-- HOW TO USE THIS FILE:
--   Full reconstruction (new DB):
--     1. Cloudflare Dashboard → D1 → ploikong_db → Console
--     2. Paste and run this entire file
--     3. All 29 tables + indexes + seed data will be created
--
--   After any schema change:
--     1. Run verification queries at the bottom
--     2. Update this file to match
--     3. Commit — this is the source of truth
--
-- ENCRYPTION NOTE (PDPA COMPLIANCE):
--   D1 encrypts at rest (disk level) but NOT at column level.
--   The following columns store encrypted values — encryption/decryption
--   is handled in the Worker using Web Crypto API (AES-256-GCM):
--     members.payout_account      — bank account / PromptPay number
--     members.thai_id_hash        — hashed Thai national ID (one-way)
--     broker_documents.r2_key     — path to encrypted file in R2
--   Utility: src/utils/crypto.js  (encrypt / decrypt functions)
--   NOTE: Satu schema has the same gap on donor_consent.encrypted_national_id
--         — apply same crypto.js fix there.
--
-- TABLE COUNT: 29 (+ _cf_KV internal)
--
-- ── IDENTITY & ACCESS (4) ───────────────────────────────────────────────────
--   1.  members
--   2.  membership_applications
--   3.  staff
--   4.  staff_action_log
--
-- ── LISTINGS & COMMERCE (5) ─────────────────────────────────────────────────
--   5.  listings
--   6.  offers
--   7.  bids
--   8.  orders
--   9.  broker_commission_log
--
-- ── BROKER VETTING SYSTEM (5) ───────────────────────────────────────────────
--   10. broker_applications
--   11. broker_documents
--   12. broker_compliance_checks
--   13. broker_flags
--   14. payment_outside_platform_reports
--
-- ── MEMBER ENGAGEMENT (5) ───────────────────────────────────────────────────
--   15. watchlist
--   16. saved_searches
--   17. messages
--   18. reviews
--   19. stories
--
-- ── LEGAL INFRASTRUCTURE (4) ────────────────────────────────────────────────
--   20. platform_config
--   21. legal_documents
--   22. member_consents
--   23. consent_audit_export
--
-- ── NOTIFICATIONS & OPERATIONS (3) ──────────────────────────────────────────
--   24. promotions
--   25. notification_queue
--   26. airtable_sync_log
--
-- ── PLATFORM HEALTH (3) ─────────────────────────────────────────────────────
--   27. audit_log
--   28. rate_limit_counters
--   29. cron_log
-- ============================================================================


-- ============================================================================
-- ── IDENTITY & ACCESS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. MEMBERS
--    All buyers, sellers, and brokers are members first.
--    role: 'member' | 'broker' | 'admin'
--    status: 'pending' (awaiting approval) | 'active' | 'suspended' | 'banned'
--    pending_consent: 1 = must sign latest legal docs before transacting (Option B)
--    thai_id_hash: SHA-256 one-way hash only — never reversible, never plain text
--    payout_account: AES-256-GCM encrypted in Worker before storage
--    broker_code: null until broker status granted. Format: PKB-FIRSTNAME
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS members (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    email               TEXT    UNIQUE NOT NULL,
    password_hash       TEXT    NOT NULL,               -- bcrypt
    name                TEXT    NOT NULL,
    username            TEXT    UNIQUE,                  -- public handle
    phone               TEXT,
    line_id             TEXT,
    thai_id_hash        TEXT,                            -- SHA-256, one-way
    address             TEXT,
    avatar_url          TEXT,                            -- Cloudinary URL
    cover_url           TEXT,                            -- Cloudinary URL
    bio                 TEXT,
    role                TEXT    DEFAULT 'member',        -- member | broker | admin
    status              TEXT    DEFAULT 'pending',       -- pending | active | suspended | banned
    pending_consent     INTEGER DEFAULT 0,               -- 1 = must sign before transacting
    broker_code         TEXT    UNIQUE,                  -- PKB-FIRSTNAME, null if not broker
    verified_by         INTEGER,                         -- staff.id who approved
    verified_at         INTEGER,                         -- Unix timestamp
    seller_rating       REAL    DEFAULT 0,
    buyer_rating        REAL    DEFAULT 0,
    total_sales         INTEGER DEFAULT 0,
    total_purchases     INTEGER DEFAULT 0,
    payout_method       TEXT,                            -- promptpay | bank_transfer
    payout_account      TEXT,                            -- AES-256-GCM encrypted
    language            TEXT    DEFAULT 'th',
    created_at          INTEGER NOT NULL,
    last_seen           INTEGER,
    FOREIGN KEY (verified_by) REFERENCES staff(id)
);


-- ----------------------------------------------------------------------------
-- 2. MEMBERSHIP APPLICATIONS
--    Staging table for invitation-only phase.
--    Approved → INSERT into members + UPDATE status here.
--    Rejected → stays here, member row never created.
--    Future public registration: skip this table, insert directly to members
--    with status='active'. No schema change required — only code path changes.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS membership_applications (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    email               TEXT    NOT NULL,
    name                TEXT    NOT NULL,
    phone               TEXT,
    line_id             TEXT,
    what_they_collect   TEXT    NOT NULL,                -- "I collect Japanese knives..."
    referral_source     TEXT,                            -- "EDC Thailand group", "friend: Somchai"
    referral_member_id  INTEGER,                         -- member.id if referred by existing member
    application_text    TEXT,                            -- free-form "tell us about yourself"
    status              TEXT    DEFAULT 'pending',       -- pending | approved | rejected | waitlist
    reviewed_by         INTEGER,                         -- staff.id
    reviewed_at         INTEGER,
    rejection_reason    TEXT,
    member_id           INTEGER,                         -- members.id after approval (null until then)
    ip_address          TEXT,
    created_at          INTEGER NOT NULL,
    FOREIGN KEY (reviewed_by)        REFERENCES staff(id),
    FOREIGN KEY (member_id)          REFERENCES members(id),
    FOREIGN KEY (referral_member_id) REFERENCES members(id)
);


-- ----------------------------------------------------------------------------
-- 3. STAFF
--    Internal operations team. Completely separate from members.
--    roles and permissions:
--      owner            — full access, all actions, cannot be restricted
--      ops_manager      — approve/reject brokers, manage disputes, see all chats
--      support_agent    — review flagged chats, respond to tickets
--      legal_officer    — read-only: contracts, consents, compliance reports, export
--      compliance_auditor — runs broker checks, raises flags, cannot approve/reject
--    rule_of_engagement: TEXT field storing the written policy for this role.
--    Stored in DB so it can be updated without code deploy.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    email               TEXT    UNIQUE NOT NULL,
    name                TEXT    NOT NULL,
    password_hash       TEXT    NOT NULL,               -- bcrypt, separate auth from members
    role                TEXT    NOT NULL,               -- owner | ops_manager | support_agent | legal_officer | compliance_auditor
    status              TEXT    DEFAULT 'active',       -- active | suspended | departed
    rule_of_engagement  TEXT,                           -- written policy for this role (JSON or text)
    can_read_chats      INTEGER DEFAULT 0,              -- explicit permission flags
    can_approve_brokers INTEGER DEFAULT 0,
    can_touch_money     INTEGER DEFAULT 0,              -- only owner can do this
    can_export_legal    INTEGER DEFAULT 0,
    created_by          INTEGER,                        -- staff.id who created this account
    created_at          INTEGER NOT NULL,
    last_seen           INTEGER,
    FOREIGN KEY (created_by) REFERENCES staff(id)
);


-- ----------------------------------------------------------------------------
-- 4. STAFF ACTION LOG
--    Immutable audit trail. Every action any staff member takes.
--    If a staff member attempts an action outside their permissions,
--    that attempt is also logged with action='permission_denied'.
--    target_type: member | listing | order | broker | message | config | legal
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff_action_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id            INTEGER NOT NULL,
    action              TEXT    NOT NULL,               -- approve_member | suspend_broker | export_consent | etc.
    target_type         TEXT,
    target_id           TEXT,                           -- member.id, listing.id, etc.
    details             TEXT,                           -- JSON payload
    ip_address          TEXT,
    result              TEXT    DEFAULT 'ok',           -- ok | permission_denied | error
    created_at          INTEGER NOT NULL,
    FOREIGN KEY (staff_id) REFERENCES staff(id)
);


-- ============================================================================
-- ── LISTINGS & COMMERCE
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 5. LISTINGS
--    The core product. One row per item for sale.
--    selling_type: fixed | auction | offer | buy_now
--      fixed      — set price, take it or leave it
--      auction    — bidding engine, ends at auction_end timestamp
--      offer      — seller accepts/rejects/counters offers (see offers table)
--      buy_now    — can coexist with auction (auction + buy_now_price)
--    broker_id: if listed by a verified broker on behalf of private seller.
--      When broker_id is set, seller identity shows as "Private Collection"
--      on the public listing page. True seller_id is never exposed publicly.
--    price / amounts: ALL in satang (THB × 100). 10000 = 100 THB.
--    slug: URL-safe unique identifier. ploikong.com/item/seki-japan-chef-knife-1987
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listings (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id           INTEGER NOT NULL,
    broker_id           INTEGER,                         -- members.id (must have role='broker')
    title               TEXT    NOT NULL,
    title_th            TEXT,                            -- Thai title
    story               TEXT,                            -- collector narrative — the soul of the listing
    description         TEXT,
    category            TEXT    NOT NULL,                -- knives | vintage-tools | plants | dolls | books | other
    subcategory         TEXT,
    condition           TEXT,                            -- mint | excellent | good | fair | poor
    year_made           TEXT,                            -- "1987", "circa 1960s", "Edo period"
    origin              TEXT,                            -- "Seki, Japan" | "Chiang Mai, Thailand"
    provenance          TEXT,                            -- ownership history narrative
    images              TEXT,                            -- JSON array of Cloudinary URLs
    primary_image       TEXT,                            -- main display image URL
    selling_type        TEXT    NOT NULL,                -- fixed | auction | offer | buy_now
    price               INTEGER,                         -- satang, for fixed/buy_now
    min_offer           INTEGER,                         -- satang, minimum offer accepted
    auction_start       INTEGER,                         -- satang, opening bid
    auction_reserve     INTEGER,                         -- satang, hidden reserve (not shown publicly)
    auction_end         INTEGER,                         -- Unix timestamp when auction closes
    buy_now_price       INTEGER,                         -- satang, instant purchase during auction
    offer_expires_at    INTEGER,                         -- Unix timestamp, for time-limited offers
    shipping_type       TEXT,                            -- seller_ships | buyer_arranges | meetup
    shipping_cost       INTEGER,                         -- satang
    shipping_providers  TEXT,                            -- JSON: ["flash","kerry","thailand_post"]
    status              TEXT    DEFAULT 'draft',         -- draft | active | sold | expired | removed
    views               INTEGER DEFAULT 0,
    watchers            INTEGER DEFAULT 0,
    featured            INTEGER DEFAULT 0,
    promoted_until      INTEGER,                         -- Unix timestamp
    tags                TEXT,                            -- JSON array for search
    slug                TEXT    UNIQUE,                  -- URL-friendly unique ID
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER,
    sold_at             INTEGER,
    FOREIGN KEY (seller_id) REFERENCES members(id),
    FOREIGN KEY (broker_id) REFERENCES members(id)
);


-- ----------------------------------------------------------------------------
-- 6. OFFERS
--    Supports full seller toolkit: direct offer, counter offer, mass offer.
--    offer_type: buyer_offer | seller_counter | seller_mass_offer
--      buyer_offer      — buyer initiates offer on a listing
--      seller_counter   — seller counters buyer's offer
--      seller_mass_offer — seller sends offer to all watchers simultaneously
--    status: pending | accepted | rejected | countered | expired | cancelled
--    parent_offer_id: links counter-offers to the original offer chain
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS offers (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id          INTEGER NOT NULL,
    from_member_id      INTEGER NOT NULL,               -- who sent this offer/counter
    to_member_id        INTEGER NOT NULL,               -- who receives it
    offer_type          TEXT    NOT NULL,               -- buyer_offer | seller_counter | seller_mass_offer
    amount              INTEGER NOT NULL,               -- satang
    message             TEXT,                           -- optional note with offer
    parent_offer_id     INTEGER,                        -- for counter-offer chains
    expires_at          INTEGER,                        -- Unix timestamp, seller can set time limit
    status              TEXT    DEFAULT 'pending',      -- pending | accepted | rejected | countered | expired | cancelled
    responded_at        INTEGER,
    created_at          INTEGER NOT NULL,
    FOREIGN KEY (listing_id)      REFERENCES listings(id),
    FOREIGN KEY (from_member_id)  REFERENCES members(id),
    FOREIGN KEY (to_member_id)    REFERENCES members(id),
    FOREIGN KEY (parent_offer_id) REFERENCES offers(id)
);


-- ----------------------------------------------------------------------------
-- 7. BIDS
--    Auction engine. One row per bid placed.
--    is_auto_bid: 1 = system placed this bid automatically from auto-bid ceiling
--    max_auto_bid: the ceiling the bidder set — never shown publicly
--    status: active | outbid | won | cancelled
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bids (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id          INTEGER NOT NULL,
    bidder_id           INTEGER NOT NULL,
    amount              INTEGER NOT NULL,               -- satang, actual bid placed
    is_auto_bid         INTEGER DEFAULT 0,              -- 1 = system auto-bid
    max_auto_bid        INTEGER,                        -- satang, ceiling (private)
    status              TEXT    DEFAULT 'active',       -- active | outbid | won | cancelled
    created_at          INTEGER NOT NULL,
    FOREIGN KEY (listing_id) REFERENCES listings(id),
    FOREIGN KEY (bidder_id)  REFERENCES members(id)
);


-- ----------------------------------------------------------------------------
-- 8. ORDERS
--    One row per completed transaction. Created when buyer pays or bid is won.
--    PAYMENT FIREWALL: All money flows Omise → Ploikong escrow → seller.
--    Broker NEVER receives payment. broker_id here is for commission tracking only.
--    escrow_status: holding | released | disputed | refunded
--    Payout timeline: paid_at → delivered_at → payout_due_at (delivered + 7 days)
--    delivered_at: set by buyer confirmation OR auto-assumed after auto_deliver_days
--    platform_fee = amount × platform_fee_pct (from platform_config)
--    broker_fee   = amount × broker_fee_pct (from platform_config, only if broker_id set)
--    seller_payout = amount - platform_fee - broker_fee - shipping_cost_absorbed
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
    id                  TEXT    PRIMARY KEY,            -- UUID: PLK-YYYYMMDD-XXXX
    listing_id          INTEGER NOT NULL,
    buyer_id            INTEGER NOT NULL,
    seller_id           INTEGER NOT NULL,
    broker_id           INTEGER,                        -- members.id, commission tracking only
    amount              INTEGER NOT NULL,               -- satang, final sale price
    platform_fee        INTEGER,                        -- satang, 6% of amount
    broker_fee          INTEGER,                        -- satang, broker_fee_pct% if broker used
    seller_payout       INTEGER,                        -- satang, amount - all fees
    omise_charge_id     TEXT,                           -- null in fake/test mode
    payment_method      TEXT,                           -- promptpay | credit_card
    payment_status      TEXT    DEFAULT 'pending',      -- pending | paid | failed | refunded
    escrow_status       TEXT    DEFAULT 'holding',      -- holding | released | disputed | refunded
    paid_at             INTEGER,                        -- Unix timestamp, Omise webhook confirms
    delivered_at        INTEGER,                        -- Unix timestamp, buyer confirms or auto
    payout_due_at       INTEGER,                        -- Unix timestamp, delivered_at + 7 days
    payout_released_at  INTEGER,                        -- Unix timestamp, cron releases
    shipping_tracking   TEXT,
    shipping_provider   TEXT,
    status              TEXT    DEFAULT 'pending',      -- pending | confirmed | shipped | delivered | complete | disputed | cancelled
    dispute_reason      TEXT,
    dispute_opened_at   INTEGER,
    dispute_resolved_at INTEGER,
    dispute_resolved_by INTEGER,                        -- staff.id
    notes               TEXT,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER,
    FOREIGN KEY (listing_id)          REFERENCES listings(id),
    FOREIGN KEY (buyer_id)            REFERENCES members(id),
    FOREIGN KEY (seller_id)           REFERENCES members(id),
    FOREIGN KEY (broker_id)           REFERENCES members(id),
    FOREIGN KEY (dispute_resolved_by) REFERENCES staff(id)
);


-- ----------------------------------------------------------------------------
-- 9. BROKER COMMISSION LOG
--    Records every commission calculation and payout for brokers.
--    Separate from orders for clean financial audit trail.
--    platform_share + broker_share must always equal broker_fee in orders.
--    status: pending | paid | withheld (if broker suspended during transaction)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS broker_commission_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id            TEXT    NOT NULL,
    broker_id           INTEGER NOT NULL,
    gross_amount        INTEGER NOT NULL,               -- satang, the order amount
    broker_fee_pct      REAL    NOT NULL,               -- % applied (snapshot at time of sale)
    broker_fee_total    INTEGER NOT NULL,               -- satang, gross × broker_fee_pct
    platform_share_pct  REAL    NOT NULL,               -- platform's cut of broker fee
    broker_share_pct    REAL    NOT NULL,               -- broker's cut of broker fee
    platform_share      INTEGER NOT NULL,               -- satang
    broker_share        INTEGER NOT NULL,               -- satang
    status              TEXT    DEFAULT 'pending',      -- pending | paid | withheld
    paid_at             INTEGER,
    withheld_reason     TEXT,
    created_at          INTEGER NOT NULL,
    FOREIGN KEY (order_id)   REFERENCES orders(id),
    FOREIGN KEY (broker_id)  REFERENCES members(id)
);


-- ============================================================================
-- ── BROKER VETTING SYSTEM
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 10. BROKER APPLICATIONS
--     Full vetting pipeline. 5 phases:
--       applied → screening → background_check → interview → contract → approved | rejected
--     Mail verification: system sends physical letter with code to their address.
--     mail_verify_code: 8-digit code sent by post, must be entered to proceed.
--     insurance_expiry_date: tracked for auto-suspend if policy lapses.
--     Cron: 30 days before expiry → warning email. Day of expiry → auto-suspend.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS broker_applications (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id               INTEGER NOT NULL,           -- must be active member first
    full_legal_name         TEXT    NOT NULL,
    thai_id_hash            TEXT    NOT NULL,            -- SHA-256 one-way hash
    physical_address        TEXT    NOT NULL,
    professional_background TEXT,
    years_in_collecting     INTEGER,
    specialties             TEXT,                        -- JSON: ["knives","vintage-tools"]
    certificates            TEXT,                        -- JSON array of descriptions
    references_text         TEXT,                        -- names of vouching collectors
    reference_member_ids    TEXT,                        -- JSON array of members.id
    insurance_provider      TEXT,
    insurance_policy_number TEXT,
    insurance_expiry_date   INTEGER,                     -- Unix timestamp — TRACKED BY CRON
    bank_verified           INTEGER DEFAULT 0,           -- 1 = test deposit confirmed
    mail_verify_code        TEXT,                        -- 8-digit code sent by post
    mail_verified           INTEGER DEFAULT 0,           -- 1 = physical address confirmed
    video_call_done         INTEGER DEFAULT 0,           -- 1 = video call recorded
    phase                   TEXT    DEFAULT 'applied',   -- applied | screening | background_check | interview | contract | approved | rejected
    assigned_to             INTEGER,                     -- staff.id handling this application
    rejection_reason        TEXT,
    approved_by             INTEGER,                     -- staff.id (ops_manager or owner only)
    approved_at             INTEGER,
    created_at              INTEGER NOT NULL,
    updated_at              INTEGER,
    FOREIGN KEY (member_id)    REFERENCES members(id),
    FOREIGN KEY (assigned_to)  REFERENCES staff(id),
    FOREIGN KEY (approved_by)  REFERENCES staff(id)
);


-- ----------------------------------------------------------------------------
-- 11. BROKER DOCUMENTS
--     Encrypted file references stored in R2.
--     r2_key: path in R2 bucket, AES-256-GCM encrypted before storage here.
--     doc_type: thai_id_front | thai_id_back | insurance_policy | signed_contract
--               | video_call_recording | bank_statement | certificate | other
--     The actual file in R2 is also encrypted at upload (Worker handles this).
--     expiry_date: for time-limited documents (insurance, certificates).
--     Cron monitors expiry_date and alerts staff + broker before expiry.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS broker_documents (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    broker_app_id       INTEGER NOT NULL,               -- broker_applications.id
    broker_member_id    INTEGER NOT NULL,               -- members.id
    doc_type            TEXT    NOT NULL,               -- see types above
    r2_key              TEXT    NOT NULL,               -- encrypted R2 path
    file_hash           TEXT,                           -- SHA-256 of original file
    expiry_date         INTEGER,                        -- Unix timestamp, null if permanent
    uploaded_by         INTEGER,                        -- staff.id who uploaded/verified
    uploaded_at         INTEGER NOT NULL,
    notes               TEXT,
    FOREIGN KEY (broker_app_id)    REFERENCES broker_applications(id),
    FOREIGN KEY (broker_member_id) REFERENCES members(id),
    FOREIGN KEY (uploaded_by)      REFERENCES staff(id)
);


-- ----------------------------------------------------------------------------
-- 12. BROKER COMPLIANCE CHECKS
--     Every 14-day audit record. Runs automatically via cron.
--     Also supports manual spot checks triggered by staff.
--     check_type: scheduled_14day | manual_spot | phone_verification | chat_review
--     result: pass | fail | pending | no_response
--     phone_code_sent: random code sent by SMS, broker must reply within 24h.
--     No response within 24h → auto-suspend → staff alerted immediately.
--     reviewer_id: compliance_auditor or ops_manager who reviewed.
--     lawyer_notified: 1 = report was emailed to legal officer (Option C — always yes)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS broker_compliance_checks (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    broker_member_id    INTEGER NOT NULL,
    check_type          TEXT    NOT NULL,               -- scheduled_14day | manual_spot | phone_verification | chat_review
    scheduled_at        INTEGER NOT NULL,               -- when it was due
    completed_at        INTEGER,
    result              TEXT    DEFAULT 'pending',      -- pass | fail | pending | no_response
    phone_code_sent     TEXT,                           -- random code sent to broker
    phone_code_received TEXT,                           -- what broker replied (null if no response)
    phone_deadline      INTEGER,                        -- Unix timestamp: 24h after send
    chat_sample_ids     TEXT,                           -- JSON: message.id array reviewed
    reviewer_id         INTEGER,                        -- staff.id
    lawyer_notified     INTEGER DEFAULT 1,              -- always 1 — Option C
    notes               TEXT,
    flags_raised        INTEGER DEFAULT 0,              -- count of issues found
    auto_suspended      INTEGER DEFAULT 0,              -- 1 = system suspended broker on this check
    created_at          INTEGER NOT NULL,
    FOREIGN KEY (broker_member_id) REFERENCES members(id),
    FOREIGN KEY (reviewer_id)      REFERENCES staff(id)
);


-- ----------------------------------------------------------------------------
-- 13. BROKER FLAGS
--     Any complaint, anomaly, or manual flag raised against a broker.
--     flag_type: complaint | anomaly | chat_violation | payment_bypass_attempt
--                | insurance_lapsed | phone_no_response | manual
--     severity: low | medium | high | critical
--     critical severity → immediate auto-suspend → owner + lawyer alerted.
--     resolved_by: staff.id who closed the flag.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS broker_flags (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    broker_member_id    INTEGER NOT NULL,
    raised_by           INTEGER,                        -- staff.id or null if system-raised
    flag_type           TEXT    NOT NULL,
    severity            TEXT    NOT NULL,               -- low | medium | high | critical
    description         TEXT    NOT NULL,
    related_order_id    TEXT,                           -- orders.id if relevant
    related_message_id  INTEGER,                        -- messages.id if relevant
    status              TEXT    DEFAULT 'open',         -- open | investigating | resolved | dismissed
    resolved_by         INTEGER,
    resolved_at         INTEGER,
    resolution_notes    TEXT,
    auto_suspended      INTEGER DEFAULT 0,              -- 1 = system auto-suspended broker
    created_at          INTEGER NOT NULL,
    FOREIGN KEY (broker_member_id) REFERENCES members(id),
    FOREIGN KEY (raised_by)        REFERENCES staff(id),
    FOREIGN KEY (resolved_by)      REFERENCES staff(id)
);


-- ----------------------------------------------------------------------------
-- 14. PAYMENT OUTSIDE PLATFORM REPORTS
--     Buyer reports that broker asked for payment outside the platform.
--     This is the #1 scam vector. Every report triggers immediate investigation.
--     First report: auto-suspend broker, alert owner + lawyer.
--     Confirmed: permanent ban, contract breach enforced, legal referral.
--     PAYMENT FIREWALL RULE: Any money not flowing through Omise → Ploikong
--     is a platform violation regardless of broker explanation.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_outside_platform_reports (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_member_id  INTEGER NOT NULL,               -- buyer who reported
    broker_member_id    INTEGER NOT NULL,               -- accused broker
    listing_id          INTEGER,
    order_id            TEXT,
    description         TEXT    NOT NULL,               -- what the buyer says happened
    evidence_r2_keys    TEXT,                           -- JSON: encrypted R2 paths to screenshots
    auto_suspended      INTEGER DEFAULT 1,              -- broker auto-suspended on submission
    status              TEXT    DEFAULT 'investigating',-- investigating | confirmed | dismissed
    investigated_by     INTEGER,                        -- staff.id
    outcome             TEXT,                           -- free text: "permanent ban, legal referral"
    created_at          INTEGER NOT NULL,
    resolved_at         INTEGER,
    FOREIGN KEY (reporter_member_id) REFERENCES members(id),
    FOREIGN KEY (broker_member_id)   REFERENCES members(id),
    FOREIGN KEY (listing_id)         REFERENCES listings(id),
    FOREIGN KEY (investigated_by)    REFERENCES staff(id)
);


-- ============================================================================
-- ── MEMBER ENGAGEMENT
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 15. WATCHLIST
--     Member saves a listing. Triggers saved search alerts when price drops.
--     One row per member-listing pair. Unique constraint prevents duplicates.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS watchlist (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id           INTEGER NOT NULL,
    listing_id          INTEGER NOT NULL,
    created_at          INTEGER NOT NULL,
    UNIQUE(member_id, listing_id),
    FOREIGN KEY (member_id)  REFERENCES members(id),
    FOREIGN KEY (listing_id) REFERENCES listings(id)
);


-- ----------------------------------------------------------------------------
-- 16. SAVED SEARCHES
--     Member saves a search query with filters.
--     alert_enabled: 1 = send email when new listing matches this search.
--     filters: JSON blob — category, price range, condition, origin, etc.
--     Cron (every 6h) scans new listings against all active saved searches.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_searches (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id           INTEGER NOT NULL,
    query               TEXT,                           -- free text search term
    filters             TEXT,                           -- JSON: {category, min_price, max_price, condition, origin}
    alert_enabled       INTEGER DEFAULT 1,
    last_alerted        INTEGER,                        -- Unix timestamp of last match email sent
    created_at          INTEGER NOT NULL,
    FOREIGN KEY (member_id) REFERENCES members(id)
);


-- ----------------------------------------------------------------------------
-- 17. MESSAGES
--     DM system between members, and system announcements.
--     from_id: null = system message (outbid alert, payout notice, etc.)
--     listing_id / order_id: context links — "this message is about item X"
--     BROKER MONITORING: messages where either party is a broker can be
--     reviewed by staff with can_read_chats = 1. This is disclosed in ToS
--     and Broker Agreement — PDPA compliant.
--     flagged: 1 = staff flagged for review. flagged_by: staff.id.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id             INTEGER,                        -- members.id, null = system
    to_id               INTEGER NOT NULL,
    listing_id          INTEGER,
    order_id            TEXT,
    content             TEXT    NOT NULL,
    read_at             INTEGER,
    flagged             INTEGER DEFAULT 0,
    flagged_by          INTEGER,                        -- staff.id
    flagged_at          INTEGER,
    flagged_reason      TEXT,
    created_at          INTEGER NOT NULL,
    FOREIGN KEY (from_id)    REFERENCES members(id),
    FOREIGN KEY (to_id)      REFERENCES members(id),
    FOREIGN KEY (listing_id) REFERENCES listings(id),
    FOREIGN KEY (flagged_by) REFERENCES staff(id)
);


-- ----------------------------------------------------------------------------
-- 18. REVIEWS
--     Buyer reviews seller and seller reviews buyer after completed order.
--     role: buyer_reviewing_seller | seller_reviewing_buyer
--     rating: 1–5. Updates members.seller_rating or buyer_rating (rolling avg).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reviews (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id            TEXT    NOT NULL,
    reviewer_id         INTEGER NOT NULL,
    reviewed_id         INTEGER NOT NULL,
    role                TEXT    NOT NULL,               -- buyer_reviewing_seller | seller_reviewing_buyer
    rating              INTEGER NOT NULL,               -- 1 to 5
    comment             TEXT,
    created_at          INTEGER NOT NULL,
    FOREIGN KEY (order_id)     REFERENCES orders(id),
    FOREIGN KEY (reviewer_id)  REFERENCES members(id),
    FOREIGN KEY (reviewed_id)  REFERENCES members(id)
);


-- ----------------------------------------------------------------------------
-- 19. STORIES
--     Collector blog. Published by members. Featured on homepage.
--     This is the "soul" content — the 16th century lantern narrative.
--     Moderated: status must be 'published' by staff before appearing.
--     featured: 1 = shown in homepage hero rotation.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stories (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id           INTEGER NOT NULL,
    title               TEXT    NOT NULL,
    title_th            TEXT,
    content             TEXT    NOT NULL,               -- rich text / markdown
    cover_image         TEXT,                           -- Cloudinary URL
    category            TEXT,
    tags                TEXT,                           -- JSON array
    status              TEXT    DEFAULT 'draft',        -- draft | review | published | removed
    views               INTEGER DEFAULT 0,
    featured            INTEGER DEFAULT 0,
    approved_by         INTEGER,                        -- staff.id
    published_at        INTEGER,
    created_at          INTEGER NOT NULL,
    FOREIGN KEY (author_id)   REFERENCES members(id),
    FOREIGN KEY (approved_by) REFERENCES staff(id)
);


-- ============================================================================
-- ── LEGAL INFRASTRUCTURE
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 20. PLATFORM CONFIG
--     Live business rule variables. Never hardcoded in Worker code.
--     One row per config key. Change via admin dashboard — logs to staff_action_log.
--     Keys include:
--       platform_fee_pct         — "6.0"  (standard transaction fee %)
--       broker_fee_pct           — "3.0"  (total broker fee %)
--       platform_broker_split    — "50.0" (platform's % of broker_fee)
--       broker_broker_split      — "50.0" (broker's % of broker_fee)
--       escrow_hold_days         — "7"    (days after delivery before payout)
--       auto_deliver_days        — "14"   (days before auto-marking delivered)
--       max_auction_days         — "30"
--       compliance_check_days    — "14"   (broker audit frequency)
--       insurance_warn_days      — "30"   (days before expiry to warn)
--       max_broker_count         — "5"    (platform cap on active brokers)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_config (
    key                 TEXT    PRIMARY KEY,
    value               TEXT    NOT NULL,
    description         TEXT,                           -- human-readable explanation
    updated_by          INTEGER,                        -- staff.id
    updated_at          INTEGER,
    FOREIGN KEY (updated_by) REFERENCES staff(id)
);


-- ----------------------------------------------------------------------------
-- 21. LEGAL DOCUMENTS
--     Every version of every contract. R2 stores the actual PDF/HTML file.
--     doc_type: terms_of_service | privacy_policy | broker_agreement
--               | seller_agreement | buyer_agreement | cookie_policy
--     effective_date: when this version becomes binding.
--     When a new version is published:
--       1. Insert row here with status='published'
--       2. All active members get pending_consent = 1 (except doc_type-specific ones)
--       3. Cron/notification_queue emails all affected members
--     Old versions: status='superseded' — NEVER deleted (court evidence).
--     r2_key: path to PDF in R2 bucket (not encrypted — these are public documents).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legal_documents (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_type            TEXT    NOT NULL,               -- see types above
    version             TEXT    NOT NULL,               -- "1.0", "1.1", "2.0"
    title               TEXT    NOT NULL,
    r2_key              TEXT    NOT NULL,               -- R2 path to PDF/HTML
    effective_date      INTEGER NOT NULL,               -- Unix timestamp
    status              TEXT    DEFAULT 'draft',        -- draft | published | superseded
    published_by        INTEGER,                        -- staff.id
    published_at        INTEGER,
    requires_all_members INTEGER DEFAULT 1,             -- 1 = all members must re-consent
    requires_brokers_only INTEGER DEFAULT 0,            -- 1 = only broker_agreement type
    notes               TEXT,                           -- "Changed clause 4.2 — escrow period"
    UNIQUE(doc_type, version),
    FOREIGN KEY (published_by) REFERENCES staff(id)
);


-- ----------------------------------------------------------------------------
-- 22. MEMBER CONSENTS
--     Cryptographic consent record. One row per member per document version.
--     This is the legal evidence that member agreed to specific terms.
--     consent_hash: SHA-256 of (member_id + doc_version_id + timestamp + ip + user_agent)
--     This hash is the digital signature. Reproducible, verifiable, court-admissible.
--     method: checkbox | scroll_confirm | explicit_sign (future: biometric)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_consents (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id           INTEGER NOT NULL,
    legal_doc_id        INTEGER NOT NULL,
    consent_hash        TEXT    NOT NULL,               -- SHA-256 digital signature
    method              TEXT    DEFAULT 'checkbox',     -- checkbox | scroll_confirm | explicit_sign
    ip_address          TEXT    NOT NULL,
    user_agent          TEXT,
    consented_at        INTEGER NOT NULL,               -- Unix timestamp — immutable
    UNIQUE(member_id, legal_doc_id),
    FOREIGN KEY (member_id)    REFERENCES members(id),
    FOREIGN KEY (legal_doc_id) REFERENCES legal_documents(id)
);


-- ----------------------------------------------------------------------------
-- 23. CONSENT AUDIT EXPORT
--     Immutable log of every time a consent record is exported.
--     Required when lawyer needs proof for a specific member.
--     exported_by: staff.id — only legal_officer or owner can export.
--     purpose: "dispute resolution PLK-20260511-0042" | "court order" | etc.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consent_audit_export (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    exported_by         INTEGER NOT NULL,               -- staff.id
    member_id           INTEGER NOT NULL,               -- whose consent was exported
    legal_doc_id        INTEGER,                        -- null = all documents exported
    purpose             TEXT    NOT NULL,
    ip_address          TEXT,
    exported_at         INTEGER NOT NULL,
    FOREIGN KEY (exported_by)  REFERENCES staff(id),
    FOREIGN KEY (member_id)    REFERENCES members(id),
    FOREIGN KEY (legal_doc_id) REFERENCES legal_documents(id)
);


-- ============================================================================
-- ── NOTIFICATIONS & OPERATIONS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 24. PROMOTIONS
--     Featured listings, top search placement, banners.
--     type: featured | top_search | homepage_banner | category_banner
--     Charged to seller/member. amount_paid in satang.
--     Cron checks promoted_until on listings and clears featured flag.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promotions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id          INTEGER,
    member_id           INTEGER NOT NULL,
    type                TEXT    NOT NULL,               -- featured | top_search | homepage_banner | category_banner
    amount_paid         INTEGER NOT NULL,               -- satang
    starts_at           INTEGER NOT NULL,
    ends_at             INTEGER NOT NULL,
    status              TEXT    DEFAULT 'active',       -- active | expired | cancelled
    created_at          INTEGER NOT NULL,
    FOREIGN KEY (listing_id) REFERENCES listings(id),
    FOREIGN KEY (member_id)  REFERENCES members(id)
);


-- ----------------------------------------------------------------------------
-- 25. NOTIFICATION QUEUE
--     Outbound email jobs for Zoho OAuth email system.
--     Events are queued here — cron processes and sends via Zoho.
--     This prevents email loss if Zoho API is momentarily unavailable.
--     template: welcome | bid_placed | outbid | item_sold | payment_received
--               | payout_released | new_message | consent_required
--               | broker_check_due | broker_flag_raised | broker_suspended
--               | insurance_expiring | compliance_report (→ lawyer)
--     status: queued | sent | failed | cancelled
--     attempts: retry counter — max 3 attempts before marking failed.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_queue (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id           INTEGER,                        -- null for staff/lawyer emails
    staff_id            INTEGER,                        -- null for member emails
    to_email            TEXT    NOT NULL,
    template            TEXT    NOT NULL,               -- see types above
    payload             TEXT,                           -- JSON: template variables
    status              TEXT    DEFAULT 'queued',       -- queued | sent | failed | cancelled
    attempts            INTEGER DEFAULT 0,              -- max 3
    last_attempt_at     INTEGER,
    sent_at             INTEGER,
    error_msg           TEXT,
    created_at          INTEGER NOT NULL,
    FOREIGN KEY (member_id) REFERENCES members(id),
    FOREIGN KEY (staff_id)  REFERENCES staff(id)
);


-- ----------------------------------------------------------------------------
-- 26. AIRTABLE SYNC LOG
--     Tracks what has been synced to the Ploikong Airtable base.
--     Used by the one-shot Airtable creation Worker.
--     table_name: the D1 table that was synced.
--     airtable_record_id: the Airtable record ID created.
--     sync_type: create | update | delete
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS airtable_sync_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name          TEXT    NOT NULL,               -- D1 table name
    d1_record_id        TEXT    NOT NULL,               -- ID in D1
    airtable_record_id  TEXT,                           -- Airtable record ID
    sync_type           TEXT    NOT NULL,               -- create | update | delete
    status              TEXT    DEFAULT 'ok',           -- ok | error
    error_msg           TEXT,
    synced_at           INTEGER NOT NULL
);


-- ============================================================================
-- ── PLATFORM HEALTH
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 27. AUDIT LOG
--     Platform-wide event log. Covers member actions (not staff — see staff_action_log).
--     actor_id: members.id. null = system action.
--     target_type: listing | member | order | bid | offer | message | story
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id            INTEGER,                        -- members.id, null = system
    action              TEXT    NOT NULL,
    target_type         TEXT,
    target_id           TEXT,
    details             TEXT,                           -- JSON
    ip_address          TEXT,
    created_at          INTEGER NOT NULL
);


-- ----------------------------------------------------------------------------
-- 28. RATE LIMIT COUNTERS
--     D1-backed rate limiter. Identical pattern to Satu.
--     One row per (ip, window_key). window_key = floor(unix_seconds / 60).
--     Stale rows pruned by cron (every 6h cleanup job).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limit_counters (
    ip                  TEXT    NOT NULL,
    window_key          INTEGER NOT NULL,
    count               INTEGER DEFAULT 0,
    PRIMARY KEY (ip, window_key)
);


-- ----------------------------------------------------------------------------
-- 29. CRON LOG
--     Audit trail for all scheduled jobs.
--     Jobs (every 6 hours):
--       expire_listings          — auctions past end time → expired
--       release_payouts          — payout_due_at < now → release escrow
--       process_notifications    — send queued emails via Zoho
--       check_saved_searches     — match new listings to saved searches
--       broker_compliance_due    — flag brokers whose 14-day check is due
--       check_insurance_expiry   — warn/suspend brokers with lapsing insurance
--       cleanup_rate_limits      — delete stale rate_limit_counters rows
--       expire_offers            — offers past expires_at → expired
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cron_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    job_name            TEXT    NOT NULL,
    started_at          INTEGER NOT NULL,
    finished_at         INTEGER,
    status              TEXT    DEFAULT 'running',      -- running | ok | error
    rows_affected       INTEGER DEFAULT 0,
    error_msg           TEXT,
    details             TEXT                            -- JSON for extra context
);


-- ============================================================================
-- INDEXES
-- ============================================================================

-- members
CREATE INDEX IF NOT EXISTS idx_members_email      ON members(email);
CREATE INDEX IF NOT EXISTS idx_members_username   ON members(username);
CREATE INDEX IF NOT EXISTS idx_members_role       ON members(role);
CREATE INDEX IF NOT EXISTS idx_members_status     ON members(status);
CREATE INDEX IF NOT EXISTS idx_members_broker     ON members(broker_code);

-- membership_applications
CREATE INDEX IF NOT EXISTS idx_memapp_status      ON membership_applications(status);
CREATE INDEX IF NOT EXISTS idx_memapp_email       ON membership_applications(email);

-- staff
CREATE INDEX IF NOT EXISTS idx_staff_email        ON staff(email);
CREATE INDEX IF NOT EXISTS idx_staff_role         ON staff(role);

-- staff_action_log
CREATE INDEX IF NOT EXISTS idx_sal_staff          ON staff_action_log(staff_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sal_target         ON staff_action_log(target_type, target_id);

-- listings
CREATE INDEX IF NOT EXISTS idx_listings_seller    ON listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_listings_broker    ON listings(broker_id);
CREATE INDEX IF NOT EXISTS idx_listings_category  ON listings(category, status);
CREATE INDEX IF NOT EXISTS idx_listings_status    ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_slug      ON listings(slug);
CREATE INDEX IF NOT EXISTS idx_listings_featured  ON listings(featured, status);
CREATE INDEX IF NOT EXISTS idx_listings_auction   ON listings(auction_end, status);
CREATE INDEX IF NOT EXISTS idx_listings_created   ON listings(created_at);

-- offers
CREATE INDEX IF NOT EXISTS idx_offers_listing     ON offers(listing_id);
CREATE INDEX IF NOT EXISTS idx_offers_from        ON offers(from_member_id);
CREATE INDEX IF NOT EXISTS idx_offers_to          ON offers(to_member_id);
CREATE INDEX IF NOT EXISTS idx_offers_status      ON offers(status, expires_at);

-- bids
CREATE INDEX IF NOT EXISTS idx_bids_listing       ON bids(listing_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bids_bidder        ON bids(bidder_id);
CREATE INDEX IF NOT EXISTS idx_bids_status        ON bids(status);

-- orders
CREATE INDEX IF NOT EXISTS idx_orders_buyer       ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_seller      ON orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_orders_listing     ON orders(listing_id);
CREATE INDEX IF NOT EXISTS idx_orders_status      ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_escrow      ON orders(escrow_status, payout_due_at);
CREATE INDEX IF NOT EXISTS idx_orders_omise       ON orders(omise_charge_id);
CREATE INDEX IF NOT EXISTS idx_orders_created     ON orders(created_at);

-- broker_commission_log
CREATE INDEX IF NOT EXISTS idx_bcl_broker         ON broker_commission_log(broker_id);
CREATE INDEX IF NOT EXISTS idx_bcl_order          ON broker_commission_log(order_id);
CREATE INDEX IF NOT EXISTS idx_bcl_status         ON broker_commission_log(status);

-- broker_applications
CREATE INDEX IF NOT EXISTS idx_bapp_member        ON broker_applications(member_id);
CREATE INDEX IF NOT EXISTS idx_bapp_phase         ON broker_applications(phase);
CREATE INDEX IF NOT EXISTS idx_bapp_insurance     ON broker_applications(insurance_expiry_date);

-- broker_compliance_checks
CREATE INDEX IF NOT EXISTS idx_bcc_broker         ON broker_compliance_checks(broker_member_id);
CREATE INDEX IF NOT EXISTS idx_bcc_scheduled      ON broker_compliance_checks(scheduled_at, result);

-- broker_flags
CREATE INDEX IF NOT EXISTS idx_bflag_broker       ON broker_flags(broker_member_id);
CREATE INDEX IF NOT EXISTS idx_bflag_status       ON broker_flags(status, severity);

-- payment_outside_platform_reports
CREATE INDEX IF NOT EXISTS idx_popr_broker        ON payment_outside_platform_reports(broker_member_id);
CREATE INDEX IF NOT EXISTS idx_popr_status        ON payment_outside_platform_reports(status);

-- watchlist
CREATE INDEX IF NOT EXISTS idx_watchlist_member   ON watchlist(member_id);
CREATE INDEX IF NOT EXISTS idx_watchlist_listing  ON watchlist(listing_id);

-- saved_searches
CREATE INDEX IF NOT EXISTS idx_ss_member          ON saved_searches(member_id);
CREATE INDEX IF NOT EXISTS idx_ss_alert           ON saved_searches(alert_enabled);

-- messages
CREATE INDEX IF NOT EXISTS idx_msg_to             ON messages(to_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_from           ON messages(from_id);
CREATE INDEX IF NOT EXISTS idx_msg_listing        ON messages(listing_id);
CREATE INDEX IF NOT EXISTS idx_msg_flagged        ON messages(flagged);

-- reviews
CREATE INDEX IF NOT EXISTS idx_reviews_reviewed   ON reviews(reviewed_id);
CREATE INDEX IF NOT EXISTS idx_reviews_order      ON reviews(order_id);

-- stories
CREATE INDEX IF NOT EXISTS idx_stories_author     ON stories(author_id);
CREATE INDEX IF NOT EXISTS idx_stories_status     ON stories(status, featured);
CREATE INDEX IF NOT EXISTS idx_stories_published  ON stories(published_at);

-- legal_documents
CREATE INDEX IF NOT EXISTS idx_legal_type         ON legal_documents(doc_type, status);

-- member_consents
CREATE INDEX IF NOT EXISTS idx_consent_member     ON member_consents(member_id);
CREATE INDEX IF NOT EXISTS idx_consent_doc        ON member_consents(legal_doc_id);

-- consent_audit_export
CREATE INDEX IF NOT EXISTS idx_cae_member         ON consent_audit_export(member_id);
CREATE INDEX IF NOT EXISTS idx_cae_exported       ON consent_audit_export(exported_at);

-- promotions
CREATE INDEX IF NOT EXISTS idx_promo_listing      ON promotions(listing_id, status);
CREATE INDEX IF NOT EXISTS idx_promo_ends         ON promotions(ends_at, status);

-- notification_queue
CREATE INDEX IF NOT EXISTS idx_notif_status       ON notification_queue(status, attempts);
CREATE INDEX IF NOT EXISTS idx_notif_member       ON notification_queue(member_id);

-- audit_log
CREATE INDEX IF NOT EXISTS idx_audit_actor        ON audit_log(actor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_target       ON audit_log(target_type, target_id);

-- rate_limit_counters
CREATE INDEX IF NOT EXISTS idx_rl_window          ON rate_limit_counters(window_key);

-- cron_log
CREATE INDEX IF NOT EXISTS idx_cron_job           ON cron_log(job_name, started_at);
CREATE INDEX IF NOT EXISTS idx_cron_status        ON cron_log(status);


-- ============================================================================
-- SEED DATA
-- ============================================================================

-- Platform owner (staff account — NOT a member account)
INSERT OR IGNORE INTO staff (email, name, password_hash, role, status,
    can_read_chats, can_approve_brokers, can_touch_money, can_export_legal,
    rule_of_engagement, created_at)
VALUES (
    'csmittee@gmail.com',
    'Chairit Smittee',
    '$2a$10$REPLACE_WITH_BCRYPT_HASH',     -- generate: npx bcryptjs 'yourpassword'
    'owner',
    'active',
    1, 1, 1, 1,                            -- owner: all permissions
    'Full platform access. Owner account. All actions permitted.',
    strftime('%s','now')
);

-- Temporary legal officer slot (same email until real lawyer onboarded)
-- UPDATE this row when lawyer joins: UPDATE staff SET email='lawyer@firm.com' WHERE role='legal_officer'
INSERT OR IGNORE INTO staff (email, name, password_hash, role, status,
    can_read_chats, can_approve_brokers, can_touch_money, can_export_legal,
    rule_of_engagement, created_at)
VALUES (
    'legal_temp@ploikong.com',             -- placeholder — update when lawyer confirmed
    'Legal Officer (TBD)',
    '$2a$10$REPLACE_WITH_BCRYPT_HASH',
    'legal_officer',
    'active',
    0, 0, 0, 1,                            -- legal_officer: export only
    'Read-only access to contracts, consents, and compliance reports. Export to lawyer. No operational actions.',
    strftime('%s','now')
);

-- Default platform config
INSERT OR IGNORE INTO platform_config (key, value, description, updated_at) VALUES
    ('platform_fee_pct',      '6.0',  'Standard transaction fee charged to seller (%)', strftime('%s','now')),
    ('broker_fee_pct',        '3.0',  'Total broker fee added when broker facilitates sale (%)', strftime('%s','now')),
    ('platform_broker_split', '50.0', 'Platform share of broker_fee (%)', strftime('%s','now')),
    ('broker_broker_split',   '50.0', 'Broker share of broker_fee (%)', strftime('%s','now')),
    ('escrow_hold_days',      '7',    'Days after delivery confirmed before seller payout is released', strftime('%s','now')),
    ('auto_deliver_days',     '14',   'Days after shipping before system auto-marks as delivered', strftime('%s','now')),
    ('max_auction_days',      '30',   'Maximum allowed auction duration in days', strftime('%s','now')),
    ('compliance_check_days', '14',   'Broker audit frequency in days', strftime('%s','now')),
    ('insurance_warn_days',   '30',   'Days before insurance expiry to send broker warning', strftime('%s','now')),
    ('max_broker_count',      '5',    'Maximum active brokers on platform at any time', strftime('%s','now')),
    ('payment_mode',          'fake', 'fake = test mode, live = real Omise charges', strftime('%s','now'));

-- Placeholder first legal document (Terms of Service v1.0)
-- Upload actual PDF to R2 and update r2_key before going live
INSERT OR IGNORE INTO legal_documents
    (doc_type, version, title, r2_key, effective_date, status, requires_all_members, notes)
VALUES
    ('terms_of_service', '1.0', 'Ploikong Terms of Service',
     'legal/terms_of_service_v1.0.pdf',   -- upload this to R2 before launch
     strftime('%s','now'), 'draft', 1,
     'Initial ToS — update r2_key after uploading PDF to R2 bucket'),
    ('privacy_policy', '1.0', 'Ploikong Privacy Policy (PDPA)',
     'legal/privacy_policy_v1.0.pdf',
     strftime('%s','now'), 'draft', 1,
     'PDPA-compliant privacy policy — have lawyer review before publishing'),
    ('broker_agreement', '1.0', 'Ploikong Verified Broker Agreement',
     'legal/broker_agreement_v1.0.pdf',
     strftime('%s','now'), 'draft', 0,
     'Separate broker contract — requires_brokers_only=1 update after lawyer signs off');


-- ============================================================================
-- VERIFICATION QUERIES
-- Run these after reconstruction to confirm everything is correct.
-- ============================================================================

-- 1. Count tables (expect 29, plus _cf_KV = 30 total in sqlite_master)
-- SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';

-- 2. List all tables in order
-- SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;

-- 3. Count indexes (expect 57)
-- SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%';

-- 4. Confirm seed data
-- SELECT id, email, role, can_touch_money FROM staff;
-- SELECT key, value FROM platform_config ORDER BY key;
-- SELECT doc_type, version, status FROM legal_documents;

-- 5. Confirm no _cf_KV contamination in your tables
-- SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;

-- ============================================================================
-- AIRTABLE BASE MAP
-- When building the Airtable sync Worker, create one Base with these tables.
-- Each D1 table → one Airtable Table.
-- Primary field in Airtable = the column marked (PK) below.
-- ============================================================================
-- members              (PK: id)         → Members base
-- membership_applications (PK: id)      → Applications base
-- staff                (PK: id)         → Staff base (restricted view)
-- listings             (PK: id)         → Listings base
-- orders               (PK: id)         → Orders base
-- broker_applications  (PK: id)         → Broker Pipeline base
-- broker_compliance_checks (PK: id)     → Compliance base
-- broker_flags         (PK: id)         → Flags base
-- member_consents      (PK: id)         → Legal Consents base
-- notification_queue   (PK: id)         → Notifications base
-- platform_config      (PK: key)        → Config base
-- cron_log             (PK: id)         → System Health base
-- ============================================================================