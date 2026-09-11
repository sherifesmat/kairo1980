# Working on kairo1980.de

Static site for KAIRO 1980, an Egyptian restaurant in Hockenheim. Read this
before touching anything; it is the context that is expensive to rediscover.

## What this is

No build step, no framework, no bundler. Cloudflare Workers serves the repo
directory as it sits. A change to opening hours is a one-line edit and a push,
not a release. **Do not introduce a build step, a framework, or an npm
dependency the browser loads** — the whole design of the site is that the
restaurant can change a price without a developer.

There is one server, and it exists for one reason. `worker/` answers `/api/`
so that payments can be taken: deciding what an order costs, telling a provider
to take the money, and being told afterwards whether it worked cannot be done
in a browser without trusting the guest's own arithmetic. Everything that is
not `/api/` still falls through to the static files untouched. The npm
dependencies are wrangler and Playwright — build and test tooling only; nothing
is bundled into a page. See `docs/payments.md`.

Push to `main` deploys automatically. `.github/workflows/deploy.yml` checks
that every browser script parses and that `zones.js` still matches the
spreadsheet before publishing.

**That workflow is the only way anything reaches production, on purpose.**
Cloudflare's own Git integration — Worker Builds, configured in the dashboard
rather than in this repository — was connected once and disconnected on
4 August 2026. It deployed the same Worker on the same push, which is a race
whose winner is whichever finishes last, and it ran none of the guards this
deploy exists for: no parse check, no test suite, no `zones.js`-versus-
spreadsheet comparison, no D1 migration, no regenerated `sitemap.xml`, no
IndexNow ping. A green build there would have published a site that skipped
all of it. **Do not reconnect it.** If deploys ever appear to be broken, the
answer is in the Actions log, and usually in one of the two repository secrets
the workflow needs — `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. A
rolled token fails there the way a rolled build token failed in the dashboard:
loudly, and with a message that names everything except the cause.

## Files

```
index.html   markup only — no inline script, no inline style, ever
firmencatering.html  the corporate offer as its own URL (/firmencatering)
lang.js      language: detection, memory, direction, the switch (all pages)
config.js    every business rule and feature flag
zones.js     GENERATED from data/delivery_zones.xlsx — never hand-edit
order.js     hours, basket, WhatsApp handover, structured data
app.js       page chrome: scroll reveal, reviews carousel, map consent
qr.js        QR encoder, loaded on demand by the WhatsApp fallback only
pay.js       the payment step, loaded on demand when a guest pays online
style.css    all styles
_headers     cache policy + CSP

worker/      the /api/ routes: pricing, payments, webhooks, settlement
worker/admin/  /admin — the internal pages, behind one login
migrations/  the payments schema (D1)
tests/       unit + integration (node --test) and e2e (Playwright)
```

Load order is `lang.js` → `zones.js` → `config.js` → `order.js` → `app.js`,
all `defer`. `qr.js` and `pay.js` are fetched at runtime, never on page load.
That order is load-bearing in the Worker too: `worker/site-data.js` imports the
very same `zones.js` and `config.js`, in the same order, rather than keeping a
second copy of a price or a postcode on the server.

## The one rule

**A business fact lives in exactly one place; everything else derives from it.**
If you are about to type a price, a postcode, an opening time or a percentage
into a second file, stop — that is the bug this architecture exists to prevent.

| Fact | Single source |
| --- | --- |
| Hours, and when a driver starts | `config.js` → `hours` (overridden by `/admin`) |
| Payment on arrival, the online switch | `config.js` → `payment` |
| PayPal credentials, which online methods are live | Cloudflare secrets + `wrangler.jsonc` vars, served by `/api/payments/config` |
| Postcodes, fees, minimums | `data/delivery_zones.xlsx` → `zones.js` |
| Discounts, thresholds, lead time, basket lifetime | `config.js` → `order`, `business` |
| Who the minimum order value is asked of | `config.js` → `order.minimumOrder` |
| Dishes, prices, diet tags | `index.html` `.mitem[data-item][data-price]` |
| Ratings and reviews | `reviews.json` (fetched weekly) |
| Every visible string | `data-de` / `data-en` / `data-ar` on the element itself |

Translated copy carries `{placeholders}` (e.g. `{freeDeliveryFrom}`) that
`applyConfig()` in order.js fills at runtime. The literal numbers in the markup
are only the no-JavaScript fallback — update both or neither.

## Hard constraints

- **Strict CSP.** No `<script>`, no `style="…"` and no
  `onclick=` in the markup. There is exactly one exception and it is narrow:
  the ordering page (`/` only) allows the named PayPal hosts, and `style-src`
  there gains `'unsafe-inline'` because the checkout SDK styles what it
  injects. `script-src` stays strict everywhere, and impressum and datenschutz
  keep the untouched policy. That one policy is set by the Worker
  (`CHECKOUT_CSP` in `worker/index.js`), **not** in `_headers` — a per-path
  rule there does not override the `/*` rule, it loses to it, which is why
  `run_worker_first` names `/`. Event wiring goes through the delegated
  `[data-action]` / `[data-act]` handlers. Setting `el.style.x` from JS is
  fine (CSSOM, not an inline attribute); parsing a style attribute is not.
- **Trilingual: German, English, Egyptian Arabic.** Every visible string needs
  `class="t" data-de="…" data-en="…" data-ar="…"` or it will not switch.
  Generated text must repaint on the `kairo:lang` event, and every key in the
  `T` table in order.js must exist in all three dictionaries — they are checked
  against each other, not filled in later. `data-t="content|alt|aria-label|
  placeholder|title"` writes an attribute instead of the text; `data-t="html"`
  is for legal prose that contains a link, and is used nowhere else.
- **Arabic is a direction, not a stylesheet.** The layout mirrors because every
  rule is written in logical properties (`margin-inline`, `border-inline-start`,
  `text-align: start`) and `lang.js` sets `dir="rtl"`. Do not add a physical
  `left`/`right` property: it will be correct in two languages and wrong in the
  third. The only `[dir="rtl"]` rules that may exist are the ones direction
  cannot express — a mirrored arrow, a drop shadow, and the LTR isolation that
  keeps "+49 176 79906621" and "11,00 €" from being reordered inside an Arabic
  sentence.
- **Arabic typography is not Latin typography.** No `letter-spacing` and no
  `text-transform` — the script is cursive and has no capitals; both are
  switched off under `:root[lang="ar"]`, and the small-caps labels get size and
  weight instead. Amiri for display, Cairo for text, both self-hosted and both
  behind a `unicode-range` so no Latin reader ever downloads them.
- **`zones.js` is generated.** Edit `data/delivery_zones.xlsx`, then
  `python tools/build-zones.py`. CI fails the deploy if the two disagree.
- **No third-party requests on load.** No fonts CDN, no analytics, no cookies.
  The Google Maps embed loads only after an explicit click — but a map is
  visible immediately, because the picture underneath it is rendered from
  OpenStreetMap and **served from this origin**, which is not a third-party
  request at all. Regenerate with the script in `docs/static-map.md`; ODbL
  attribution is required and must stay legible, so it is not put behind a
  hover. The consent panel is a card, never a scrim across the whole map: a
  full overlay washes the map into wallpaper and wastes the reason for drawing
  one. `tests/e2e/seo.spec.js` asserts that NOTHING leaves this origin before
  the button is pressed.
- **Staying open later is not an opening hour.** `/admin` extends tonight only:
  it changes what can be ordered now and what the badge says, and never touches
  the hours table or `openingHoursSpecification`, which state what happens every
  week and are cached by Google for the place card. It carries its own end like
  the closure does, is capped at 8 hours, and expires by being read against the
  clock. Ask `slotAt()`, never `slotsFor()`, when the question is "can this be
  served" — `slotsFor()` is the published week and deliberately does not know.
- **The `.html` twins move with a 301, and one file never moves at all.** A 307
  tells a crawler the old URL may return, so it keeps both and splits the
  ranking. `googled7bbc73984e8deda.html` is Google's verification file and is
  served at that exact URL with a 200 — it was being 307'd to the extensionless
  path, which worked only because Google followed it.
- **A sold-out dish is the ONE refusal.** `/admin/dishes` takes a dish off the
  menu when the kitchen runs out. Unlike everything below, this blocks: the
  ingredient is not in the building, so it is refused in the basket AND in
  `worker/pricing.js`, where the browser cannot argue. The dish list is read
  from `index.html` itself, so a new dish appears on that page by itself. The
  row shows words, never a disabled `+` — a control that is present and refuses
  reads as a broken page. A basket lives two hours and the kitchen can run out
  inside that, so `dropSoldOut()` clears such items at boot and says which.
- **Validation is advisory, never blocking.** An unknown postcode, a closed
  slot or a sub-minimum order warns the guest and flags the WhatsApp message —
  it never refuses the order. Losing one €300 corporate order to an automatic
  rejection costs more than reading a message and saying no.

## Things that are the way they are on purpose

- **The two delivery rules are asked by name, never re-derived.**
  Free delivery is one threshold for every order — company and private are the
  same trip to a driver, so there is no switch to narrow it. The minimum order
  value is asked only of a private order that has to be driven out: never of a
  collection, never of a company. Both live in `config.js`
  (`business.freeDeliveryFrom`, `order.minimumOrder`) and are asked through
  `freeDeliveryQualifies()` / `minimumApplies()` — the same two names in
  `order.js` and in `worker/pricing.js`. The server cannot trust the browser's
  answer, but it must never give a different one. `totals()` answers
  `belowMinimum` once, so the basket, the send button and the WhatsApp message
  cannot each reach their own verdict.
- **A rule that qualifies a number is printed with it, from the rule.**
  `{minimumClause}` and `{freeDeliveryAll}` are written by `applyConfig()` the
  way `{deliveryClause}` is, and fall silent by themselves when the rule they
  describe no longer needs saying. Never type "gilt nur für private
  Lieferbestellungen" into copy: that is the sentence that goes stale the day
  the rule changes, in the one place nobody thinks to look.
- **The corporate offer has a URL, and the homepage section is a teaser.**
  `#firmen` keeps the heading, the lead, the two figures and one button, and
  hands the reader on; `/firmencatering` carries the formats, the allergen
  declaration, the diet tags, the invoice and § 19 UStG, and is the only place
  any of that is written. Hub and spoke: the homepage sells the idea to someone
  already reading it, the page answers a search for *Firmencatering Walldorf*,
  which a `#fragment` never can. Do not let the teaser grow the detail back —
  two pages saying the same thing is how a site competes with itself. `order.js` runs there for what it knows, not for the basket —
  it builds no basket on a page carrying no `.mitem`, which also keeps the
  checkout away from a page the relaxed CSP does not name.
- **A page's canonical URL is written once, in its own `<link rel="canonical">`.**
  `lang.js` reads that href at load and appends `?lang=` to it for the two
  non-German readings, so the canonical and the hreflang set always agree and a
  new page needs nothing but a correct href. It used to read a `data-base`
  attribute whose fallback was the homepage, which meant impressum and
  datenschutz — neither of which carried one — declared the homepage as their
  canonical the moment the script ran, and asked Google to drop them as
  duplicates. Do not reintroduce a second attribute holding the same URL: the
  bug was not the missing attribute, it was that the URL was written twice.
  `tests/e2e/seo.spec.js` holds every page to it, in the rendered DOM.
  **The canonical mirrors the URL, never the language being displayed.** It
  once followed the detected language, so Googlebot — which renders in English
  — fetched `/` and was handed a page claiming its canonical was `/?lang=en`.
  Search Console reported "Duplicate, Google chose different canonical than
  user" and the homepage left the index on 13 June 2026. Only `updateUrl()` may
  move it, because that is the only thing that moves the URL. The suite missed
  it because `playwright.config.js` pins `locale: 'de-DE'`; the canonical tests
  now also run under `en-GB` and `ar-EG`.
- **The menu is a section, not a page.** `#speisekarte` is the homepage's
  primary content and the address printed on the Google and Apple place cards.
  It stays there because the basket and the checkout CSP both belong to `/`,
  because the homepage already emits the whole menu as `hasMenu` structured
  data, and because a `/speisekarte` page would compete with `/` for the one
  search the homepage exists to win. This is the opposite call to
  `/firmencatering`, and for the opposite reason: *Firmencatering Walldorf* is
  a search the homepage cannot answer, "Speisekarte" is the search it IS.
- **A page that can be found alone must be complete alone.** Whoever lands on
  `/firmencatering` from a search may never see the menu, so LMIV, the PAngV
  price notice and § 19 UStG are stated there in full rather than one click
  away. Its `Service` node names the Restaurant by `@id` instead of describing
  a second business, and asserts only what the page renders — the formats are
  read out of the cards that describe them, so a format deleted from the page
  leaves the markup with it.
- **The ordering switch withholds a MOMENT, not an order.** `/admin` can stop
  the till in one tap, and a guest can still fill a basket while it is stopped —
  because someone who cannot order tonight may be ordering for tomorrow, and
  the basket already knows how to schedule one. What the closure takes away is
  "as soon as possible", exactly as a lunch slot takes away delivery: the send
  button dims, and the note above it names the time to pick instead. A moment
  chosen after we reopen is an ordinary order and goes through untouched, in
  the browser and at `/api/payments`, which applies the same comparison rather
  than trusting the browser's verdict. Blocking the basket outright was the
  first version and it was wrong — it broke the rule directly above it.
- **A holiday is announced from `/admin`, and on the days it covers it also
  closes the till.** Two dates put the band on `/` and `/firmencatering` in
  three languages; `until` is EXCLUSIVE and is the day we are back, so the last
  day closed is derived and cannot be a day out. It is up from the moment it is
  saved — a warning that arrives on the first morning of an absence has missed
  everyone it was for — and comes down by being read against the clock, like
  the closure and the extension. There is no holiday in `config.js` on purpose;
  a date that needs a deploy reaches the site a week late.
  **It closes the till on its own days and on NO others**, which is why the
  band and the switch are still two controls. Days before `from` are open for
  business — the band is meant to go up weeks ahead — and a burst pipe wants a
  closure with no band at all. The two are resolved into ONE verdict by
  `orderingNow()` in `worker/settings.js` and `closureEnds()` in `order.js`, and
  the later end always wins: neither may shorten the other. Everything that
  asks whether an order may be taken asks that verdict — never
  `settings.ordering`, which is one half of the answer.
  It withholds a MOMENT, not the order, exactly as the closure does: a guest
  ordering ahead for the evening we reopen goes through untouched, and that is
  the most valuable order the site takes all fortnight.
  It used to announce and nothing more. The band went up for 9-19 September
  2026, the switch was left alone — `/admin` said in as many words that the
  band did not stop orders — and the till sold through the absence until an
  order arrived on the morning of the 11th, for a kitchen with nobody in it.
  The dates already said which days those were; nothing asked them. The switch
  was no workaround either: with no end named it runs to midnight tonight,
  which is right for a closure and lapses every night of a fortnight, so
  enforcing a holiday by hand means re-closing the till every morning from
  wherever you are.
  The same two dates are published as `specialOpeningHoursSpecification` —
  `opens` and `closes` both `00:00`, `validThrough` the last day closed — which
  is the ONE place a date may touch the structured data. `openingHoursSpecification`
  stays the week, because that is what the place cards cache. The entry is
  removed when the holiday lapses: a stale closure tells every crawler the shop
  is shut on days it is open, and nothing on the page looks wrong to a reader.
  A holiday must be set on the Google Business Profile by hand as well
  (Edit profile → Hours → Special hours) — Google reads the place card from the
  profile, not from the page.
- **A closure always carries its own end.** By default midnight tonight; a date
  set at `/admin` overrides it. It expires by being read against the clock, so
  nothing has to run for it to lift. The failure being guarded is not a shop
  left open, it is a Tuesday lunchtime spent wondering why nobody is ordering
  because someone stopped the till on Saturday and went home.
- **Opening hours live in the database now, and config.js is the default.**
  `config.js` → `hours` is what the site launched with, what "reset" restores
  and what the browser falls back on when the server cannot be reached; a row
  in `settings` overrides it entirely. Exactly one is in effect and `/admin`
  says which. The Worker writes the live hours into the markup before it is
  sent — the JSON-LD, the no-JavaScript table, and a JSON island `order.js`
  reads synchronously — because Googlebot renders eventually but Applebot and
  Bingbot largely do not, and those two feed the place cards. A time that is
  not a time refuses the whole save: read as "no window" it would silently
  publish that day as closed, and a typo would shut the restaurant.
- **The admin area checks a username AND a password.** `/admin` is the one
  page a person signs into. It replaced a Basic-auth page that read the
  password and threw the username away, and compared it with a length check
  that leaked how long the real secret was. Both fields are now compared as
  SHA-256 digests, neither comparison short-circuits, and the error never says
  which half was wrong. The session cookie is signed with a key derived from
  the two credentials, so changing either one logs every device out — that is
  the lost-phone procedure, and it needs no session store to sweep. Secrets are
  `ADMIN_USER` and `ADMIN_PASSWORD`; set neither and the area opens for nobody,
  because an unconfigured lock is not an unlocked door. See `docs/admin.md`.
- **We do not COLLECT a name; we do STORE what PayPal tells us.** Those are
  different sentences and the privacy policy says both. Nothing here ever asks a
  guest for a name — but `payment_events.payload` keeps the provider's words
  verbatim, and a `CHECKOUT.ORDER.APPROVED` body carries `payer.name`. The
  policy claimed a name was never stored, and that was false from the day
  payments went live. **Before writing what is stored, look in the payload.**
  Identity is nulled after 180 days (PayPal's dispute window) by a nightly cron;
  the financial record stays ten years for § 147 AO. The period is published, so
  the sweep failing makes the policy untrue — `worker/retention.js`,
  `docs/data-retention.md`. Never delete a `payment_events` ROW: `event_key` is
  the replay guard. Empty the payload instead.
- **The order is recorded here; the details never travel.** `/api/orders/announce`
  stores every order — cash included — because an order that exists only in the
  guest's WhatsApp draft is an order that is lost when they do not press send.
  Name, phone, address, company and notes are the ONLY personal data this site
  collects, are rendered at `/admin/orders` and nowhere else, and are **never
  put in a notification**: Telegram FZ-LLC is in the UAE with no adequacy
  decision, so the alert carries a reference, a basket and a postcode and stops.
  Purged at the end of the third calendar year (§§ 195, 199 BGB).
  **The announce call is never awaited.** Awaiting it spends the click's user
  gesture and the WhatsApp popup is blocked — that has cost an order before. And
  it never blocks: throttled, unpriceable or unreachable, the handover proceeds.
- **The basket still hands over to WhatsApp.** That route is unchanged and the
  guest's chat still carries the order — it simply stopped being the only copy.
  What ties a payment to an order is the short reference printed in both.
- **A day has up to two opening windows, and they are not times of day.** The
  keys are still called `lunch` and `evening` because stored settings rows use
  them, but they mean "first window" and "second window" and nothing is labelled
  from them. Two that **touch** are one opening and print as one — `11:00–18:00`
  plus `18:00–23:00` is `11:00 – 23:00`, because a restaurant that types its day
  into two boxes has not closed at 18:00. Two that **overlap** refuse the whole
  save: each is valid alone, which is exactly why they must be compared, and
  accepting them publishes two contradictory `OpeningHoursSpecification` entries
  to the crawlers behind the Google and Apple place cards.
- **The hours table is labelled by service, never by time of day.** `Abholung` /
  `Lieferung`, and only when the two differ — a day whose driver is out for the
  whole opening gets one unlabelled range, because a lone "Abholung" raises the
  question of when delivery runs and then does not answer it.
- **The delivery shift is a time, not a switch.** `hours.deliveryFrom` ('18:00',
  or '' for a driver out for the whole opening — delivery whenever the door is
  open, NOT no delivery, which is `/admin`'s "no driver today") is the single
  fact. It dims the delivery button before the shift, corrects `form.type`,
  and rewrites the business section, the hours rows, the delivery area, the FAQ
  and the corporate answer from the same sentence (`deliveryNotice()`). Never
  write the restriction into copy by hand — that is how the site ends up
  promising delivery in one paragraph and refusing it in the next. The public
  wording states the fact only; the reason is nobody's business but ours.
  It replaced `hours.lunch.delivery`, a boolean that could only express the
  restriction by pointing at a named window — which worked while midday and
  evening were separated by a closed afternoon, and could say nothing at all
  once the kitchen opened straight through. "Open 11:00–23:00, delivering from
  18:00" is not a fact about lunch. **Never ask which window a moment falls in
  to decide whether it delivers**; ask `deliversAt()`, which compares times.
- **Driving out at a different time is not a delivery shift.** `/admin` moves
  TODAY's driver — earlier because somebody is free, later because nobody is
  yet — and it is the same shape as staying open later and as the closure: it
  carries its own end (midnight tonight), it expires by being read against the
  clock, and nothing has to run for it to lapse. One switch, either direction,
  because "I can drive from now" and "no driver until nine" are one fact with
  two values. It never touches `hours.deliveryFrom`, the hours rows or
  `openingHoursSpecification` — the week is what Google caches for the place
  card, and one afternoon with a driver in it is not a new week. So it changes
  what can be ORDERED and adds one sentence beneath the hours, and that is all.
  Ask `shiftFor(iso, minutes)` for the shift in force at a moment; ask
  `deliveryFrom()` only for what is printed as the standing arrangement. That
  is why `deliverySlotsFor()` takes the shift as a parameter: the published
  table is drawn from the week, the basket from the moment. `''` means the same
  here as in `hours.deliveryFrom` — a driver out for the whole opening — so
  every caller checks for null, never for falsiness.
- **The delivery button is dimmed, never removed.** It is the one place
  validation withholds anything, and it withholds an option, not an order: a
  missing button reads as a broken page, so it stays visible with the note that
  names pickup and the evening alternative.
- **Payment is chosen before the order is sent.** The outcome travels in the
  WhatsApp message, because whoever answers the chat has to know whether the
  money is already in — and under which reference — or whether to take the
  terminal to the counter or send the driver for cash. What is offered comes from `payment.onSite` per order type —
  the terminal stands in the shop, so a delivery is cash only until a driver
  carries one.
- **Payment is a payment, not a link.** PayPal.Me is gone: its amount was
  editable by the payer and nothing reported back, so every order had to be
  checked by hand. The checkout takes the money through PayPal Checkout and
  records the result, so a paid order reaches the chat already marked paid,
  with its reference.
- **The checkout is built around payment methods, not around PayPal.** The
  guest picks Apple Pay, Google Pay, card or PayPal. PayPal processes all four,
  and three of them — the wallets and the card — are guest checkout: no PayPal
  account, no sign-in, the guest never sees the name. A second provider is one
  file in `worker/payments/` plus a line in `providers.js`, never a change to
  the checkout.
- **The server says what is possible; the browser draws what is real.** Apple
  Pay and Google Pay need PayPal's Advanced Checkout enabled for the merchant
  AND a device that has the wallet, and neither fact is knowable server-side.
  So `pay.js` asks the SDK per method and skips whatever is ineligible. Do not
  move that decision into config: the point is that the wallets appear on their
  own the day PayPal approves the account, with no edit and no deploy.
- **The server prices the order; the browser only says what is in the basket.**
  No amount, discount or fee is ever read from a request body. The prices are
  read out of `index.html` itself through the ASSETS binding.
- **Payment happens before the WhatsApp handover, and never blocks the order.**
  Paying first means the restaurant is told the truth in one message. But every
  failure — declined, cancelled, SDK blocked, provider down — offers the same
  way out: send the order anyway and pay on arrival. Losing an order to a
  refused card costs more than taking cash at the door.
- **A payment can only be captured once.** `worker/payments/store.js` moves a
  payment only from a status it may legally come from, in one conditional
  UPDATE, and `payment_events.event_key` is UNIQUE. Those two facts are what
  make a double click, a provider retry and a replayed webhook all harmless.
  Do not add a code path that writes `status` directly.
- **The webhook is the source of truth, and is verified with PayPal before it
  is believed.** A browser redirect only says the guest came back; it does not
  say the money arrived.
- **And a sweep asks, because the webhook is one channel.** Everything that
  silences it silences it completely — a rolled credential verifying against
  the wrong account, an endpoint refusing for an hour, a subscription edited in
  the dashboard — and a guest who approved has agreed to pay, believes they
  have paid, and is never charged. So every cron tick reads back any payment
  left `created`, `approved` or `pending` for more than ten minutes and settles
  it on what PayPal says. It interprets NOTHING of its own: it is the third
  caller of `applyCaptureResult`, alongside the browser and the webhook, so
  three paths cannot reach three verdicts on one fact. It announces through the
  same `changed` gate, so a payment it recovers is announced once however many
  ticks see it. Ten minutes is a floor because the browser captures in seconds
  and PayPal retries for minutes; three days is a ceiling because past that an
  abandoned order 404s for ever. `reconcileStuckPayments` in `worker/index.js`.
- **The server tells the restaurant an order exists; it does not wait for the
  guest to.** The money is taken server-side, but the order is composed in the
  guest's browser and handed to WhatsApp by the guest — so a guest who pays and
  closes the tab bought food nobody was told to cook. That happened. A paid
  order is now announced from the transition to `captured`, gated on `changed`
  from `store.settle`, so the ledger's own replay guard is the thing that makes
  it fire once. It carries no name, phone or address, because the server has
  never held any — which is what keeps it clear of the privacy rewrite that
  delivering the full order server-side would need. `worker/notify.js`,
  `docs/order-alerts.md`. **A notification may never fail a payment**: by the
  time it runs the money is taken.
  Note that the "sent" tick on `/admin/orders` records that the guest TAPPED
  send, not that a message arrived. Do not read it as proof of delivery.
- **The basket expires.** `order.cartLifetimeMinutes` (120) is a sliding
  window: long enough to survive a reload, short enough that a guest returning
  tomorrow does not meet a stale order at last week's prices.
- **Review text is never translated.** It is a quoted statement by a named
  person. Only the chrome around it — score, count, relative date, buttons —
  follows the language switch. Review dates are formatted from `publishTime`
  with `Intl.RelativeTimeFormat`, falling back to Google's German string.
- **`aggregateRating` is only ever emitted for figures actually rendered.**
  Inventing them is a structured-data violation.
- **Diet tags are a selling point, not a footnote.** Green = vegan, olive =
  vegetarian, both with a leaf. Do not shrink them back into hairline text.
- **One primary order route.** The menu and its basket. Lieferando and Uber
  Eats are secondary and labelled as alternatives — they charge commission.
  Resist adding more order buttons; every extra one splits the same intent.
- **Hairlines: exactly one line between any two things.** Rows carry their own
  rule (`border-top` in the delivery list, `border-bottom` in the menu with the
  last item of each category cleared). Do not add a container rule on top of
  a list whose rows already draw one — that is where doubled lines come from.
- **The reviews carousel has a fixed height** so the page cannot jump every
  five seconds. The height comes from the 5-line clamp, not from the longest
  review. Longer reviews get "Mehr lesen".

## Brand, and what is never translated

KAIRO 1980 is a brand: the name, the logo, the domain, `info@kairo1980.de`,
the WhatsApp number, the Instagram handle, Lieferando, Uber Eats, Google,
PayPal, `Fritz Kola`, the street address and every technical identifier are the
same string in all three languages. They carry no `data-*` attributes, so no
switch can touch them. German statute citations (§ 5 DDG, § 139c AO, Art. 6
DSGVO) stay in German in the English and Arabic legal texts — a translated
citation is not a citation. **Dish names are identical in German and English**
— the printed menu, the shop signage and the delivery platforms all use the
same spelling — and are written in Arabic script only on the Arabic page.

## Legal pages

`impressum.html` and `datenschutz.html` carry all three languages in the same
markup. **German is the binding version**; the English and Arabic texts show a
notice saying so, which is empty in German (`.legal-note:empty` hides it). The
German wording was never retyped when the translations were added — it was read
out of the file and put back — so the binding text cannot drift.

## Local preview

```
python -m http.server 8788
```

`config.js` behaves exactly as it will in production.

## Email

`info@kairo1980.de` runs on Cloudflare Email Routing, forwarding to a personal
Gmail. DNS (MX, SPF, DKIM, DMARC) is in place. To check whether the address
actually accepts mail, an SMTP `RCPT TO` probe against `route1.mx.cloudflare.net`
answers definitively without sending anything — `550 5.1.1 Address does not
exist` means the routing rule is missing or its destination is unverified.
