# kairo1980.de

Static site for KAIRO 1980, Hockenheim. No build step, no framework: the
browser gets the files as they sit in this repo. Cloudflare Workers serves the
directory (`wrangler.jsonc`), and `.assetsignore` lists what must never be
published.

## Changing the things that change

Almost everything the business changes day to day lives in **`config.js`** or
in the delivery spreadsheet. Neither needs a developer.

| I want to change… | Edit | Then |
| --- | --- | --- |
| Opening hours, per day | `config.js` → `hours.days` | commit |
| When a driver starts delivering | `/admin` → Opening hours, or `config.js` → `hours.deliveryFrom` | live at once / commit |
| Free-delivery threshold (every order) | `config.js` → `business.freeDeliveryFrom` | commit |
| Who the minimum order applies to | `config.js` → `order.minimumOrder` | commit |
| Lead time for large orders | `config.js` → `business.leadTimeHours` | commit |
| Direct-order discount | `config.js` → `order.directDiscountPercent` | commit |
| How long a basket is remembered | `config.js` → `order.cartLifetimeMinutes` | commit |
| Show the PayPal buttons | `config.js` → `payment.paypalMe` | commit |
| Hide the whole business section | `config.js` → `business.enabled` | commit |
| Turn the basket off entirely | `config.js` → `order.cartEnabled` | commit |
| Delivery postcodes, fees, minimums | `data/delivery_zones.xlsx` | run the generator below |
| A dish, its price or description | `index.html` | see "Adding a dish" |

Pushing to `main` deploys automatically. Nothing else is required.

### Opening hours

`config.js` holds one entry per weekday:

```js
wed: { closed: false, lunch: ['11:00', '23:00'], evening: null },
tue: { closed: false, lunch: ['11:30', '14:30'], evening: ['18:00', '23:00'] },
mon: { closed: true,  lunch: null,               evening: null }
```

A day has up to **two opening windows**, so a kitchen that shuts in the
afternoon can say so. The keys are named `lunch` and `evening` for historical
reasons and mean nothing more than "the first window" and "the second" — nothing
is labelled by time of day. `closed: true` closes the day outright and any times
on it are ignored. Two windows that **touch** are one opening and are printed as
one: `11:00–18:00` and `18:00–23:00` render as `11:00 – 23:00`. Two that
**overlap** are refused outright, because they would publish two contradictory
`OpeningHoursSpecification` entries.

### When a driver goes out

Collection runs for the whole opening. Delivery starts at `hours.deliveryFrom`:

```js
deliveryFrom: '18:00',   // collection from 11:00, delivery from 18:00
deliveryFrom: '',        // a driver is out whenever the door is open
```

That one value dims the delivery button before the shift, writes the note that
names the alternative, and adds the caveat to every sentence that promises free
delivery. Empty it and all of that disappears at once — there is no copy to hunt
down. It is editable at `/admin` without a deploy.

The visible table, the "open now" badge and the `openingHoursSpecification`
that Google reads are all generated from this one object, so they cannot
disagree with each other.

### Delivery zones

`data/delivery_zones.xlsx` is the **single source of truth**. It is the same
table used for the Lieferando zones. After editing it:

```
python -m pip install openpyxl      # once
python tools/build-zones.py
```

That regenerates `zones.js`, which the site loads. Never edit `zones.js` by
hand — it is overwritten. The generator refuses to write anything if the sheet
has a duplicate postcode, a malformed postcode or a non-numeric price, and CI
fails the deploy if `zones.js` and the spreadsheet disagree.

A postcode outside the sheet is **not** rejected. The basket relabels itself as
a non-binding enquiry and the message is flagged for you to judge — an
automatic refusal would throw away large orders and you would never hear about
them.

The delivery-area section on the page lists every town with its postcode and
its delivery fee, grouped by minimum order value. It is rendered from the same
row of the spreadsheet the basket charges from, so the published price and the
invoiced price cannot drift apart.

### How long the basket is remembered

`order.cartLifetimeMinutes` (default 120) is a sliding window that restarts on
every change. It is long enough that a reload, a phone call or a look at the
delivery area does not empty the basket, and short enough that somebody
returning tomorrow starts fresh instead of meeting an order they no longer want
at prices that may have moved. Set it to `0` to forget the basket the moment
the tab closes.

### Adding a dish

Copy an existing `.mitem` block in `index.html` and give it two attributes:

```html
<div class="mitem" data-item="unique-id" data-price="14.50">
```

`data-price` is the machine-readable price in plain decimal; the `.mprice` text
is what humans see. The basket discovers dishes from the page itself, so
nothing else needs touching. Leave both attributes off and the dish shows on
the menu without being orderable — useful for market-price or seasonal items.

The **PDF menu is the reference** for every name, description and price.

### Dishes with choices

Three attributes let a dish ask the guest something before it goes in the
basket. The page, the basket and the Worker all read them from the same markup,
so none of them needs editing when a choice is added.

- **Its own choices** — the KAIRO Bowl's base and topping — are written inside
  the row: a `<ul class="mchoices" data-group="…">` of
  `<li class="mchoice" data-option="…" data-price="…">`. The guest picks exactly
  one per group; an option without `data-price` costs nothing. A dish priced
  entirely by its options has no `data-price` of its own.
- **`data-addons="getraenk beilagen-bowl"`** offers shared extras, defined once
  in the hidden `.addon-groups` block at the top of the menu. A group lists
  dishes by id (`<span data-ref="salata-baladi">`) and carries no prices: an
  extra costs what its own row on the menu says. `data-max` caps the count.
- **`data-includes="menue-getraenk"`** asks for exactly one from a group,
  already in the dish's price — the Menü drink.
- **`data-contains="hawawshy steakhouse-pommes"`** says what a dish is made of.
  Its allergens are read from those rows, and it is sold out with any of them.

Each option can be marked sold out at `/admin/dishes` on its own, as
`dish:option`. `tests/unit/menu.test.js` fails if any reference points at a
dish that is not on the menu.

## Deployment

`.github/workflows/deploy.yml` deploys on every push to `main`, using the
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets. No local
login and no manual step. Before publishing it checks that every browser script
parses and that `zones.js` still matches the spreadsheet.

`fetch-reviews.yml` refreshes the Google reviews weekly and then calls the
deploy workflow, because a push made by a GitHub Action does not trigger other
workflows on its own.

To deploy by hand: Actions → "Deploy to Cloudflare" → Run workflow.

## Local preview

```
python -m http.server 8788
```

then open <http://127.0.0.1:8788/>. There is no build and no dependency to
install; `config.js` behaves exactly as it will in production.

## Layout

```
index.html          the whole page; menu content lives here for SEO
config.js           every business rule (hours, thresholds, flags, PayPal)
zones.js            GENERATED from data/delivery_zones.xlsx — do not edit
order.js            hours renderer + basket + WhatsApp handover
style.css           all styles
data/               source spreadsheet          (never published)
tools/build-zones.py  the generator             (never published)
```
