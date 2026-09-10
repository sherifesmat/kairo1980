/* ---------------------------------------------------------------------------
   KAIRO 1980 — site configuration
   ---------------------------------------------------------------------------
   This is the ONLY file you need to touch to change opening hours, to switch
   the lunch service on or off, to change the corporate delivery rules or to
   enable PayPal. No HTML and no other script has these values hardcoded.

   Everything below is plain data. Edit it, save, deploy — done.

   The visible opening-hours table AND the structured data Google reads are
   both generated from `hours` at runtime, so the two can never drift apart.
--------------------------------------------------------------------------- */

window.KAIRO_CONFIG = {

  /* --- Contact ---------------------------------------------------------- */
  whatsapp: {
    // International format, digits only — no "+", no spaces.
    number: '4917679906621'
  },

  /* --- Ordering --------------------------------------------------------- */
  order: {
    // Master switch for the website basket. Set to false and the site falls
    // back to plain "write us on WhatsApp" links, exactly as before.
    cartEnabled: true,

    // Discount for ordering directly with us instead of via a delivery
    // platform. Applies to everyone, company or private, delivery or pickup.
    // Set to 0 to remove it everywhere.
    directDiscountPercent: 10,

    // Optional better rate for company orders that are collected in person.
    // Currently OFF: one rate, 10 %, for every order placed through this site —
    // delivery or pickup, company or private. Nothing on the page promises a
    // second percentage, so this stays null unless the copy is revisited.
    //   null -> everyone gets directDiscountPercent above (the current rule)
    //   15   -> "Firmenbestellung" ticked AND pickup selected earns 15 %
    businessPickupDiscountPercent: null,

    /* Who the per-zone minimum order value applies to.
       -----------------------------------------------------------------------
       The minimum exists for one reason: to make a driver's trip worth making.
       So it applies to exactly one case — a private order that has to be
       driven out. Nobody who collects their own order pays it, because there
       is no trip to pay for; and a company order is never held to it, whatever
       it is worth, because that is the relationship we want with an office.

       The AMOUNTS live per postcode in data/delivery_zones.xlsx. This is only
       the rule about who they are asked of, and it is read by the basket, by
       the WhatsApp message, by the server's pricing and by the sentence the
       pages print — so there is one answer, not five.

       Free delivery has no such carve-out: see business.freeDeliveryFrom. */
    minimumOrder: {
      pickup: false,      // collected in person — no trip to pay for
      delivery: true,     // the ordinary case: a private order, driven out
      business: false     // a company order is never held to it
    },

    // How long a basket survives after the last change, in minutes.
    // A basket is a short-lived intention, not a saved document: it must
    // survive a reload, a phone call or a detour to the delivery-area list,
    // but a guest returning tomorrow should start fresh rather than meet an
    // order they no longer want — at prices that may since have changed.
    //   0  -> never remembered (the basket is gone as soon as the tab closes)
    //   120 -> the current rule, roughly one evening's browsing
    cartLifetimeMinutes: 120,

    // Currency symbol / locale used for every price shown by the basket.
    currency: '€',
    locale: 'de-DE'
  },

  /* --- A one-off event next door -----------------------------------------
     Not a feature: a date. Something enormous happens beside this restaurant
     a few days a year — the Glücksgefühle festival puts roughly a quarter of
     a million people about two kilometres away — and for those days the
     homepage should say so. The rest of the year this block is switched off
     and the site is exactly what it was.

     It carries its own end, like the closure and the extension do, and it
     expires by being READ AGAINST THE CLOCK: nothing has to run, nobody has
     to remember, and a tab left open past the last day drops the band by
     itself. `until` is EXCLUSIVE — the band is gone the moment that date
     starts, so the value below is the morning after the festival ends.

     `ringDistanceKm` is deliberately a conservative bound rather than a
     measured walking route: it is printed to the public, and "less than 2 km"
     is true from every corner of the site whereas a precise figure invites
     being wrong. Change the number here and every language changes with it. */
  event: {
    enabled: true,
    label: 'gluecksgefuehle',   // for us, not printed anywhere
    from:  '2026-09-03',        // festival opens (campsite, Thursday noon)
    until: '2026-09-07',        // EXCLUSIVE: gone at 00:00 on the 7th
    ringDistanceKm: 2
  },

  /* --- A holiday is NOT here ----------------------------------------------
     The fortnight the restaurant is away is set at /admin, not in this file,
     and this note exists because this is the first place anyone will look for
     it. A holiday is the restaurant's own calendar: it is decided on a phone
     in August, it has to be announced the day it is decided, and a date that
     needs a developer and a deploy is a date that ends up on the site a week
     after the shop has reopened.

     So it lives beside the ordering switch in `settings` — see the block in
     worker/settings.js — and reaches the page in the live island, exactly as
     the hours do. The band itself is the markup in index.html and
     firmencatering.html marked `data-requires="holiday"`. */

  /* --- Business / corporate catering ------------------------------------ */
  business: {
    // Shows or hides the whole "Firmenbestellungen" section, its nav link
    // and the announcement strip.
    enabled: true,

    /* Order value from which the delivery fee is waived (euros), applied to
       the food subtotal, before the direct-order discount.

       ONE THRESHOLD, EVERYONE. A company and a private guest reaching 100 €
       are the same order to a driver, so they are charged the same for it.
       There is deliberately no switch here to narrow it to company orders:
       a rule with an exception has to be explained in every place it is
       printed, and the exception was worth less than the explanation cost.

       Because it now applies to everyone, it is advertised to everyone — the
       basket says how much is missing and says so when it has been reached,
       instead of leaving it as small print in the corporate section. */
    freeDeliveryFrom: 100,

    // Minimum lead time for large / corporate orders, in hours.
    leadTimeHours: 2
  },

  /* --- Delivery area ------------------------------------------------------
     Postcode zones, not a radius. A radius needs a geocoding service (an API
     key in public JavaScript, a cost per lookup and the guest's address sent
     to a third party before they consented), and it still gets the answer
     wrong: a typo in the street becomes a rejected order, and 20 km in a
     straight line across the Rhine is a 35-minute drive. A postcode list is
     exact, free, offline and the same model Lieferando and Uber Eats use.

     The check is ADVISORY on purpose. An unknown postcode never blocks the
     order — it is flagged in the WhatsApp message so you can decide. Losing a
     €300 corporate order to an automatic rejection costs far more than
     reading one message and saying no.

     THE ZONE LIST IS NOT EDITED HERE. Its single source of truth is the
     spreadsheet data/delivery_zones.xlsx. Change a price or add a postcode
     there, then run:

         python tools/build-zones.py

     which regenerates zones.js (loaded just before this file) and refuses to
     write anything if the sheet has a duplicate or malformed postcode.
  --------------------------------------------------------------------------- */
  delivery: {
    zones: window.KAIRO_ZONES || [],
  },

  /* --- Payment ---------------------------------------------------------- */
  payment: {
    // Offer paying online while ordering — Apple Pay, Google Pay, card or
    // PayPal. Set to false and the whole online option disappears from the
    // basket in a second; the site falls back to paying in person, exactly as
    // it did before online payment existed.
    //
    // No credential belongs in this file. The client id, the secret and the
    // webhook id are Cloudflare secrets held by the Worker
    // (`wrangler secret put PAYPAL_CLIENT_ID`, …), and the page asks the
    // Worker what is switched on. That is deliberate: a client id pasted here
    // could end up naming the sandbox while the secret names production, and
    // the guest would meet a checkout that cannot take money.
    //
    // Which methods actually appear is decided by the payment account, not by
    // this file: Apple Pay and Google Pay show up only on a device that
    // supports them AND once PayPal has enabled them for the merchant. See
    // docs/payments.md.
    prepayOnline: true,

    // What can be paid in person, per order type. The FAQ, the basket, the
    // confirmation screen and the payment methods Google indexes are all
    // written from these two lists — nothing is typed twice.
    //   'cash' -> Bargeld       'giro' -> EC-/Girocard       'card' -> Kreditkarte
    // Delivery is cash only because the card terminal stands in the shop; add
    // 'giro' / 'card' to the delivery line the day a driver carries one.
    onSite: {
      pickup: ['cash', 'giro', 'card'],
      delivery: ['cash']
    },

    // Offer companies payment by invoice.
    invoiceForBusiness: true
  },

  /* --- Opening hours ----------------------------------------------------- */
  hours: {

    /* --- When a driver goes out -------------------------------------------
       The door and the driver do not open at the same time. The shop takes
       collections from the moment it opens; a delivery needs somebody to drive
       it, and that shift starts later.

       So this is a TIME, not a switch. It used to be `lunch.delivery: false` —
       a boolean that said "the midday window is collection only" — which could
       only ever express the restriction by pointing at a named window. That
       worked while midday and evening were separated by a closed afternoon,
       and stopped being able to say anything the moment the kitchen opened
       straight through: "we are open 11:00–23:00 and deliver from 18:00" is
       not a fact about lunch at all.

         '18:00'  -> collection from opening, delivery from 18:00
         ''       -> a driver is out whenever the door is open

       Delivery always ends when the day does — there is no separate closing
       time, because a driver cannot deliver from a shut kitchen.

       Empty right now, and deliberately. A driver start is a PROMISE, printed
       in the business section, the hours rows, the delivery area, the FAQ and
       the corporate answer at once — so it may only name a time the kitchen can
       keep every week. While the driver roster is unsettled there is no such
       time, and '17:00' beside a 17:00 opening was in any case a restriction
       that never bit: it raised the question of when delivery does not run and
       then did not answer it. A day that genuinely has no driver is said at
       /admin, which withholds tonight only and lapses at midnight on its own.
       Put a time back here when the roster is fixed, and the sentence returns
       everywhere by itself. */
    deliveryFrom: '',

    /* One entry per weekday. Times are "HH:MM" in 24h format.

       A day has up to TWO opening windows, because a kitchen that shuts in the
       afternoon is an ordinary thing and has to be sayable. The keys are named
       `lunch` and `evening` for historical reasons and are simply the first and
       second window of the day — they carry no meaning of their own any more,
       and nothing is labelled "Mittag" or "Abend" on the strength of them.
       Two windows that touch (11:00–18:00 and 18:00–23:00) are ONE opening,
       and are printed as one: 11:00 – 23:00.

         closed : true          -> closed all day; the times below are ignored
         lunch  : ['11:00','23:00'] or null   the day's first window
         evening: ['18:00','23:00'] or null   a second window, after a break

       The two windows may not overlap, and a second window may not start
       before the first has ended — worker/settings.js refuses the whole save
       rather than publish a day that contradicts itself.

       WHO can be served in those windows is not written here: collection runs
       for the whole opening, delivery from `deliveryFrom` above. */
    days: {
      mon: { closed: true,  lunch: null,               evening: null },
      tue: { closed: true,  lunch: null,               evening: null },
      wed: { closed: false, lunch: ['17:00', '23:00'], evening: null },
      thu: { closed: false, lunch: ['17:00', '23:00'], evening: null },
      fri: { closed: false, lunch: ['17:00', '23:00'], evening: null },
      sat: { closed: false, lunch: ['17:00', '23:00'], evening: null },
      sun: { closed: false, lunch: ['17:00', '23:00'], evening: null }
    }
  }
};
