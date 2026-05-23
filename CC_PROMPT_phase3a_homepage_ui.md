# CC_PROMPT_phase3a_homepage_ui.md

> **Status:** 🔲 PENDING — run after phase2a is deployed and green
> **Assigned to:** CC (Claude Code)
> **Created by:** Chat — 2026-05-24
> **Repo:** https://github.com/Csmittee/ploikong-platform
> **Owner QA required:** YES — Owner reviews this visually in browser before next prompt

---

## YOUR STARTUP CHECKLIST

1. Read `masterseed.md` — check design system section and confirmed working APIs
2. Read `lessons_learned.md`
3. Read this prompt fully
4. Read `src/handlers/listings.js` to understand what the API actually returns
5. Read `src/handlers/auth.js` to understand the login response shape

---

## CONTEXT

This is the first UI session. Owner has never seen a working page.
The backend APIs for listings and auth are live and working.
Goal: a real, beautiful, working homepage at ploikong.com that Owner can open in a browser,
see actual listings from the database, and log in.

This is NOT a mockup. It must call the real API.

---

## DESIGN SYSTEM (mandatory — use exactly these values)

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

Fonts (load from Google Fonts):
- `Playfair Display` — all headings and item titles
- `DM Sans` — all body text and UI
- `JetBrains Mono` — prices only

Feeling: dark luxury. Christie's meets a Thai antique dealer's study.
Never cluttered. Never cheap. Collector energy — proud, quiet, discerning.

---

## API ENDPOINTS AVAILABLE (live, call these)

Base URL: read from `window.PLOIKONG_API` or default to `https://api.ploikong.com`

```
GET  /v1/listings              — listing feed (query: ?page=1&limit=12&category=&selling_type=)
GET  /v1/listings/:slug        — single listing
GET  /v1/search?q=keyword      — search
POST /v1/auth/login            — { email, password } → { token, member: { name, username, role } }
GET  /health                   — { status: 'ok' }
```

Response shape for GET /v1/listings:
```json
{
  "listings": [
    {
      "id": 1,
      "slug": "example-item-abc123",
      "title": "...",
      "title_th": "...",
      "price": 45000,
      "selling_type": "fixed_price|auction|buy_now",
      "auction_end": null,
      "current_bid": null,
      "images": "[\"https://res.cloudinary.com/...\"]",
      "category": "knives",
      "condition": "excellent",
      "origin": "Japan",
      "seller_username": "...",
      "broker_code": null
    }
  ],
  "total": 42,
  "page": 1,
  "pages": 4
}
```

---

## WHAT TO BUILD

### File: `public/index.html`

One self-contained HTML file. All CSS and JS inline (no separate files yet — that comes in phase3b).

**Sections in order:**

**1. Top navigation bar**
- Left: Ploikong wordmark in Playfair Display, gold color
- Center: search input (calls GET /v1/search on submit)
- Right: "Sign In" button (opens login modal) OR member name if logged in
- Sticky on scroll
- Mobile responsive

**2. Hero section**
- Full-width, dark atmospheric background
- Headline in Playfair Display: "Where Thai Collectors Meet"
- Subline in DM Sans, muted: "Curated. Vetted. Trusted."
- No image needed — pure typographic hero, elegant
- Thai and English headline toggling (simple JS toggle, not i18n library)

**3. Category filter bar**
- Horizontal scroll on mobile
- Categories: All | Knives | Watches | Art | Ceramics | Coins | Vintage | Other
- Active category highlighted in gold
- Clicking filters the listing grid via API

**4. Listing grid**
- 3 columns desktop, 2 tablet, 1 mobile
- Each card:
  - Image (first image from JSON array, fallback placeholder if empty)
  - Title (Playfair Display)
  - Price in JetBrains Mono — format as ฿XX,XXX
  - Selling type badge: "Fixed Price" | "Auction" | "Buy Now"
  - If auction: show countdown timer (days/hours/mins)
  - If broker_code present: show small "🛡 Verified Broker" badge in gold
  - Condition tag: Excellent / Good / Fair
  - Click → navigate to `/listing.html?slug=xxx`
- Infinite scroll OR "Load more" button (Load more is simpler — use that)
- Skeleton loading state while API call is in flight

**5. Login modal**
- Triggered by "Sign In" button
- Email + password fields
- POST /v1/auth/login on submit
- On success: store JWT in localStorage as `plk_token`, store member object as `plk_member`
- Show member name in nav, hide Sign In button
- Error state: red message below form
- Close on backdrop click or X button

**6. Footer**
- Minimal. Dark. Logo + tagline + © 2026 Ploikong / Janishammer Co., Ltd.
- Links: About | How It Works | Become a Broker | Contact

---

## JAVASCRIPT REQUIREMENTS

```javascript
// Config — CC sets this to the live Worker URL
const API_BASE = 'https://api.ploikong.com';

// Auth state — check on page load
function getToken() { return localStorage.getItem('plk_token'); }
function getMember() { return JSON.parse(localStorage.getItem('plk_member') || 'null'); }

// On page load:
// 1. Check if token exists → update nav
// 2. Load listings with default filters
// 3. Category filter buttons wire up
// 4. Search form wires up

// Price formatter
function formatPrice(satang) {
  return '฿' + (satang / 100).toLocaleString('th-TH');
  // NOTE: prices in DB are stored in satang (Thai smallest unit)
  // If stored as baht integers directly, remove /100
}
```

**Important:** CC must read `src/handlers/listings.js` to confirm whether price is stored
as satang or baht before writing the price formatter. Use whatever the DB actually stores.

---

## WHAT NOT TO BUILD IN THIS SESSION

- listing.html (next session)
- sell.html (after members.js is live)
- profile.html (after members.js is live)
- Any backend changes

---

## AFTER BUILDING

1. Commit: `feat: add public/index.html — homepage with listing grid, search, login`
2. Move this prompt to `docs/prompts/` stamped ✅ COMPLETE
3. Update `masterseed.md` — mark Phase 3a complete, add public/index.html to inventory
4. Append new lessons to `lessons_learned.md`
5. Commit docs: `docs: update masterseed + lessons_learned after phase3a`

---

## OWNER QA CHECKLIST (Chat reviews with Owner after this deploys)

Owner opens ploikong.com in browser and checks:

- [ ] Page loads without console errors
- [ ] Nav is visible with Ploikong wordmark
- [ ] Listing grid shows real data (or empty state if DB has no listings yet — see seed data note)
- [ ] Category filter buttons work
- [ ] Search field submits and shows results
- [ ] Login modal opens and closes
- [ ] Login with owner credentials works and shows name in nav
- [ ] Mobile layout looks correct (check on phone)
- [ ] No prices showing as 0 or NaN
- [ ] Auction cards show countdown timer

---

## SEED DATA NOTE

If the D1 database has no listings yet, the grid will be empty. That is expected.
CC should include a console.log on API response so Owner can see what the API returns
during QA. Do not add fake/hardcoded data to the frontend — empty state is fine.

Owner will insert test data manually into D1 after seeing the UI.
