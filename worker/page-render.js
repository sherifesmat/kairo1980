/* Putting what is true right now into the page, before it is sent.
   ---------------------------------------------------------------------------
   The hours and the ordering switch live in the database, and the pages that
   state them are static files. Three readers need the answer and only one of
   them runs JavaScript:

     a guest      — who must not watch last week's hours repaint into this
                    week's a moment after the page appears;
     Googlebot    — which does render, eventually, on its own schedule;
     Applebot,
     Bingbot      — which largely do not, and which feed the Apple Maps and
                    Bing place cards where most of this restaurant's local
                    searches actually land.

   So the answer is written into the markup on the way out. Nothing here is a
   second copy of a business fact: every value comes from `settings`, and the
   page is rewritten from it rather than agreeing with it.

   Done with string surgery rather than HTMLRewriter, deliberately. Every edit
   is anchored to a marker that exists in the markup for this purpose — an id,
   or a pair of comments that say what they are for — and none of it depends on
   a runtime global, so the whole thing runs under `node --test` and is covered
   by tests that would otherwise have to be taken on trust. The site already
   reads its own menu out of index.html the same way (worker/site-data.js).

   Every edit is independent and every one is optional: a page without an
   `#hoursTable` simply does not get that one. A marker that has been renamed
   leaves the page exactly as it was found, which is the correct failure — a
   page stating last week's hours beats a page with its markup torn open. */

import { orderingNow } from './settings.js';
import { parseMenu } from './site-data.js';
import { priceOf } from './pricing.js';

const DAYS = [
  ['mon', 'Montag', 'Monday', 'الاثنين'],
  ['tue', 'Dienstag', 'Tuesday', 'الثلاثاء'],
  ['wed', 'Mittwoch', 'Wednesday', 'الأربعاء'],
  ['thu', 'Donnerstag', 'Thursday', 'الخميس'],
  ['fri', 'Freitag', 'Friday', 'الجمعة'],
  ['sat', 'Samstag', 'Saturday', 'السبت'],
  ['sun', 'Sonntag', 'Sunday', 'الأحد']
];

const SCHEMA_DAY = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday'
};

const LABEL = {
  closed: ['Geschlossen', 'Closed', 'مغلق'],
  // The rows are labelled by SERVICE, not by time of day. A kitchen open
  // straight through has no "Mittag" and no "Abend" to point at, but it always
  // has an opening and a delivery shift, and those are the two things a guest
  // is actually trying to tell apart.
  pickup: ['Abholung', 'Pickup', 'الاستلام'],
  delivery: ['Lieferung', 'Delivery', 'التوصيل']
};

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ESC[c]);

/** The opening windows of one day. Mirrors slotsFor() in order.js and reads the
 *  same config values by the same names, so the table the Worker draws and the
 *  table the browser draws cannot disagree.
 *
 *  Two windows that TOUCH are one window. 11:00–18:00 followed by 18:00–23:00
 *  is not an afternoon break, it is a day the restaurant typed in two boxes
 *  because the form has two boxes — and printing it as two rows tells a guest
 *  something closes at 18:00 when nothing does. */
export function slotsFor(hours, key) {
  const day = (hours.days || {})[key];
  if (!day || day.closed) return [];
  const out = [];
  for (const win of [day.lunch, day.evening]) {
    if (!win) continue;
    const last = out[out.length - 1];
    if (last && last.to === win[0]) last.to = win[1];
    else out.push({ from: win[0], to: win[1] });
  }
  return out;
}

/** The windows a driver actually goes out in: the opening, clipped to start no
 *  earlier than `deliveryFrom`. A window that ends before the shift starts
 *  drops out entirely — that is the collection-only part of the day. */
export function deliveryFor(hours, key) {
  const from = hours.deliveryFrom || '';
  return slotsFor(hours, key)
    .filter((s) => !from || from < s.to)
    .map((s) => ({ from: from && from > s.from ? from : s.from, to: s.to }));
}

/* The days the restaurant is away, as structured data.
   ---------------------------------------------------------------------------
   `openingHoursSpecification` states what happens every week and is what the
   place cards cache; a fortnight away is not a change to the week, so it is
   never written there. `specialOpeningHoursSpecification` is the field that
   exists for exactly this — dates that override the week — and a closure is
   said in it the way Google reads one: `opens` and `closes` both '00:00'.

   One entry for the whole run rather than one per day: `validThrough` is
   INCLUSIVE, so it is the last day closed, derived here from the day we are
   back exactly as the band derives it. The stored pair is still two dates and
   the third is still nobody's to type.

   It disappears when the holiday does, and the holiday disappears by being
   read against the clock — so the day the shop reopens, the page stops saying
   it is shut without anyone editing anything. */
function specialClosure(holiday) {
  if (!holiday || !holiday.from || !holiday.until) return null;
  const ms = Date.parse(holiday.until + 'T12:00:00Z');
  if (!Number.isFinite(ms)) return null;
  const through = new Date(ms - 86400000).toISOString().slice(0, 10);
  if (through < holiday.from) return null;

  return [{
    '@type': 'OpeningHoursSpecification',
    // Both '00:00' is how a closed day is stated: the window has no width.
    opens: '00:00',
    closes: '00:00',
    validFrom: holiday.from,
    validThrough: through
  }];
}

function schemaHours(hours) {
  const spec = [];
  for (const [key] of DAYS) {
    for (const slot of slotsFor(hours, key)) {
      spec.push({
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: SCHEMA_DAY[key],
        opens: slot.from,
        closes: slot.to
      });
    }
  }
  return spec;
}

/* One row per day, exactly as renderHours() in order.js lays them out, so the
   fallback and the rendered table are the same table. Every visible word
   carries all three languages: this is the markup a reader without JavaScript
   is left with, and the language switch is JavaScript. */
const span = (wins) => wins.map((w) => `${w.from} – ${w.to}`).join(' & ');

/* One labelled line — "Abholung 11:00 – 23:00". The label is omitted entirely
   when there is nothing to distinguish, because a single row reading "Abholung"
   on a day that also delivers throughout is a label that asks a question it
   then does not answer. */
function line(labelKey, wins) {
  const label = labelKey ? LABEL[labelKey] : null;
  return '<span class="hslot">' +
    (label ? `<span class="hslot-label t" data-de="${esc(label[0])}" data-en="${esc(label[1])}" data-ar="${esc(label[2])}">${esc(label[0])}</span>` : '') +
    `<span class="hslot-time">${esc(span(wins))}</span></span>`;
}

function hoursTable(hours) {
  return DAYS.map(([key, de, en, ar]) => {
    const open = slotsFor(hours, key);
    const del = deliveryFor(hours, key);
    // Labelled only when the driver's day is genuinely shorter than the shop's.
    const split = open.length && span(del) !== span(open);

    const cells = open.length
      ? `<span class="hslots">${
          split
            ? line('pickup', open) + (del.length ? line('delivery', del) : '')
            : line(null, open)
        }</span>`
      : `<span class="hclosed t" data-de="${LABEL.closed[0]}" data-en="${LABEL.closed[1]}" data-ar="${LABEL.closed[2]}">${LABEL.closed[0]}</span>`;

    return `<div class="hrow"><span class="day t" data-de="${esc(de)}" data-en="${esc(en)}" data-ar="${esc(ar)}">${esc(de)}</span>${cells}</div>`;
  }).join('');
}

/* --- the edits ------------------------------------------------------------ */

const HOURS_BLOCK = /(<!--hours:start-->)[\s\S]*?(<!--hours:end-->)/;
const SCHEMA_BLOCK = /(<script id="restaurantSchema"[^>]*>)([\s\S]*?)(<\/script>)/;

/**
 * @param {string} html the page as published
 * @param {object} settings from readSettings()
 */
export function withLiveData(html, settings) {
  const { hours, ordering, soldOut } = settings;
  let out = html;

  out = withPrices(out, settings.prices);

  /* A dish the kitchen has run out of is marked in the markup itself, not left
     to the script. The attribute is what CSS dims and what order.js reads, so a
     reader with no JavaScript still sees "ausverkauft" rather than an add
     button that refuses to work. */
  const off = Object.keys(soldOut || {});
  if (off.length) {
    for (const id of off) {
      /* A topping is "dish:option" and is marked on its own row inside the
         dish's, which is the first data-option of that name after the dish. */
      const colon = id.indexOf(':');
      if (colon > 0) {
        const at = out.indexOf(`data-item="${id.slice(0, colon)}"`);
        const opt = `data-option="${id.slice(colon + 1)}"`;
        const where = at < 0 ? -1 : out.indexOf(opt, at);
        if (where < 0) continue;
        out = out.slice(0, where + opt.length) + ' data-soldout="1"' + out.slice(where + opt.length);
        continue;
      }
      const attr = `data-item="${id}"`;
      if (!out.includes(attr)) continue;   // a dish since removed from the menu
      out = out.split(attr).join(`${attr} data-soldout="1"`);
    }
  }

  /* Read by order.js at boot, synchronously — no fetch, so no moment in which
     the page shows one thing and then another. type="application/json" is a
     data block, not a script: nothing executes it, so the strict script-src
     stands untouched. The escape keeps a "</script>" inside a value from
     ending the element early. */
  const island = `<script type="application/json" id="kairoLive">${
    JSON.stringify({
      hours, ordering, soldOut: soldOut || {},
      /* Tonight only, and never merged into `hours` — the JSON-LD below is
         built from `hours` alone, so neither an extension nor a driver out at
         an unusual time can leak into the opening hours Google caches for the
         place card. */
      extension: settings.extension || null,
      deliveryShift: settings.deliveryShift || null,
      /* The holiday band's two dates. Also never merged into `hours`: a
         fortnight away is not a change to what the restaurant does every
         week, and the place cards must not learn otherwise. */
      holiday: settings.holiday || null
    }).replace(/</g, '\\u003c')
  }</script>\n`;
  if (out.includes('</head>')) out = out.replace('</head>', island + '</head>');

  /* Lets CSS dim the order buttons before a line of script has run — and it
     asks the resolved verdict, not the switch, so a page served on a holiday
     morning arrives already dimmed rather than waiting for order.js to notice
     the second fact. The island still carries the two facts SEPARATELY: the
     band is drawn from the dates, the till from the verdict, and merging them
     there would leave one of the two unable to say what it is for. */
  if (!orderingNow(settings).open) {
    out = out.replace(/<html(\s|>)/, '<html data-ordering="off"$1');
  }

  if (SCHEMA_BLOCK.test(out)) {
    out = out.replace(SCHEMA_BLOCK, (whole, open, body, close) => {
      try {
        const data = JSON.parse(body);
        data.openingHoursSpecification = schemaHours(hours);

        /* Set when there is a holiday, REMOVED when there is not. A stale
           closure in the markup is the one failure worth guarding here: it
           tells every crawler the restaurant is shut on days it is open, and
           nothing on the page would look wrong to the person reading it. */
        const away = specialClosure(settings.holiday);
        if (away) data.specialOpeningHoursSpecification = away;
        else delete data.specialOpeningHoursSpecification;

        return open + JSON.stringify(data) + close;
      } catch {
        // Unparseable markup is left as found: a page still stating last
        // week's hours beats a page whose structured data is broken.
        return whole;
      }
    });
  }

  if (HOURS_BLOCK.test(out)) {
    out = out.replace(HOURS_BLOCK, (whole, start, end) => start + hoursTable(hours) + end);
  }

  return out;
}

/** An ETag that changes when what the page SAYS changes, not only when the
 *  file behind it does. Without this, `must-revalidate` faithfully revalidates
 *  its way back to a cached copy stating last month's hours, because the asset
 *  it was built from never moved. */
export function liveETag(assetETag, settings) {
  const base = (assetETag || 'none').replace(/^W\//, '').replace(/"/g, '');
  const state = settings.ordering.open ? 'open' : `off:${settings.ordering.resumesAt}`;
  // The sold-out set is stated in the markup too, so a change to it has to make
  // every cached copy stale — same reason hoursVersion is here.

  /* And so is everything true only tonight. Both are written into the JSON
     island above, which means a page cached before either was set is a page
     that STATES the wrong thing — and `must-revalidate` would faithfully
     revalidate its way back to it, because the asset behind it never moved.
     That is not theoretical: it is why the note under the hours did not appear
     until the guest happened to get a fresh copy.

     Each is identified by the values it publishes rather than by an
     updated_at, so the tag also moves when one LAPSES — they expire by being
     read against the clock, and nothing writes a row when they do.

     NEVER PUT A COMMA IN THIS STRING. `If-None-Match` carries a comma-
     separated LIST of entity tags, so matches() splits the header on commas
     before comparing — a comma inside the tag is torn in half by that split
     and can never match itself. The failure is silent and total: every
     request answers 200 with a full body, forever, and the only symptom is a
     site that has quietly stopped being cacheable. `~` is the separator here
     for that reason. */
  const extension = settings.extension ? `x${settings.extension.until}` : 'x-';
  const shift = settings.deliveryShift
    ? `d${settings.deliveryShift.from}@${settings.deliveryShift.until}`
    : 'd-';
  /* And the holiday, for the same reason as the two above: it is stated in the
     island, so a copy cached before it was announced states that there is no
     holiday — and would go on saying so, revalidating its way back to itself,
     because index.html never moved. */
  const holiday = settings.holiday
    ? `h${settings.holiday.from}@${settings.holiday.until}`
    : 'h-';

  /* Prices are written into the markup like the sold-out marks, and move the
     tag for the same reason — but by WHAT they are, not when they were saved.
     updated_at has one-second precision, and two saves inside one second would
     share a tag while stating different money. */
  const prices = `p${pricesDigest(settings.prices)}`;

  return `W/"${base}~${settings.hoursVersion}~${settings.soldOutVersion || '0'}~${state}~${extension}~${shift}~${holiday}~${prices}"`;
}

/* --- prices changed at /admin ---------------------------------------------
   The page is sent already carrying the price in effect: the data-price the
   basket and the structured data read, and the figure a reader without
   JavaScript sees. Resolved through the same priceOf() the till charges by,
   against the same markup, so the three cannot disagree — and an override
   for anything the current menu does not price changes nothing here either. */

/** A short fingerprint of the overrides in effect: FNV-1a over the sorted
 *  pairs. Same prices, same tag; any other prices, another tag. */
export function pricesDigest(prices) {
  const text = Object.keys(prices || {}).sort().map((id) => id + '=' + prices[id]).join(';');
  if (!text) return '0';
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

const euro = (cents) => (cents / 100).toFixed(2).replace('.', ',') + ' €';
const PRICE_TEXT = /\d+,\d{2} €/;

/** Replace the first `class="<cls>"…price…` figure at or after `from`, and
 *  no further than `until`. Returns the new html. */
function setShown(html, cls, from, until, cents) {
  const at = html.indexOf(`class="${cls}"`, from);
  if (at < 0 || at > until) return html;
  // To the element's own end: the bowl's "ab" sits in a span before the figure.
  const close = html.indexOf(cls === 'mprice' ? '</div>' : '</span>', at);
  const text = html.slice(at, close);
  if (!PRICE_TEXT.test(text)) return html;
  return html.slice(0, at) + text.replace(PRICE_TEXT, euro(cents)) + html.slice(close);
}

function setAttrPrice(html, tagStart, cents) {
  const tagEnd = html.indexOf('>', tagStart);
  const tag = html.slice(tagStart, tagEnd);
  const next = tag.replace(/(\sdata-price=")[^"]*"/, `$1${(cents / 100).toFixed(2)}"`);
  return html.slice(0, tagStart) + next + html.slice(tagEnd);
}

export function withPrices(html, overrides) {
  const ids = Object.keys(overrides || {});
  if (!ids.length) return html;
  const { dishes } = parseMenu(html);
  let out = html;

  const dishTag = (id) => out.search(new RegExp(`<div\\b[^>]*\\sdata-item="${id}"`));
  const dishEnd = (from) => {
    const next = out.slice(from + 1).search(/<div\b[^>]*\bclass="[^"]*\b(?:mitem|cat-head)\b|<\/section>/);
    return next < 0 ? out.length : from + 1 + next;
  };
  const touchedBowls = new Set();

  for (const id of ids) {
    const cents = priceOf(dishes, overrides, id);
    if (!(cents > 0)) continue;
    const colon = id.indexOf(':');
    const dishId = colon < 0 ? id : id.slice(0, colon);
    const start = dishTag(dishId);
    if (start < 0) continue;
    const end = dishEnd(start);

    if (colon < 0) {
      out = setAttrPrice(out, start, cents);
      out = setShown(out, 'mprice', start, dishEnd(start), cents);
      continue;
    }
    const optAt = out.slice(start, end).search(new RegExp(`<[a-z]+\\b[^>]*\\sdata-option="${id.slice(colon + 1)}"`));
    if (optAt < 0) continue;
    out = setAttrPrice(out, start + optAt, cents);
    out = setShown(out, 'mchoice-price', start + optAt, dishEnd(start), cents);
    touchedBowls.add(dishId);
  }

  /* A dish priced by its options prints "ab" its cheapest make-up. Only
     rewritten when one of its options moved; otherwise the markup is right. */
  for (const dishId of touchedBowls) {
    const dish = dishes.get(dishId);
    if (dish.price != null) continue;
    /* One pick per group, and the picks add up — base plus topping — so the
       cheapest bowl is the cheapest of each group, summed. */
    const lowest = dish.groups.reduce((sum, g) => sum + Math.min(...g.options
      .map((o) => priceOf(dishes, overrides, dishId + ':' + o.id))
      .filter((c) => c > 0)), 0);
    if (!Number.isFinite(lowest) || !(lowest > 0)) continue;
    const start = dishTag(dishId);
    // The dish's own figure is the LAST .mprice in its block, after the toppings.
    const end = dishEnd(start);
    const at = out.lastIndexOf('class="mprice"', end);
    if (at > start) out = setShown(out, 'mprice', at, end, lowest);
  }
  return out;
}
