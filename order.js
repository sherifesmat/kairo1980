/* ---------------------------------------------------------------------------
   KAIRO 1980 — opening hours renderer + basket with WhatsApp handover
   ---------------------------------------------------------------------------
   Everything configurable lives in config.js. This file only reads it.

   Why a basket that hands over to WhatsApp instead of plain WhatsApp links:
   a free-text chat order arrives incomplete (no quantities, no address, no
   total) and costs a phone call to repair. A basket that composes the message
   for the guest keeps the conversion in WhatsApp — where this restaurant
   already answers — while guaranteeing a structured, priced order. It needs no
   backend, no cookies and no third-party script: nothing leaves the browser
   until the guest presses "send", which also keeps the site GDPR-clean.

   The basket has no hardcoded menu. It reads every `.mitem[data-item]` out of
   the page, so adding a dish to the HTML is enough to make it orderable.
--------------------------------------------------------------------------- */

(function () {
  'use strict';

  var CFG = window.KAIRO_CONFIG;
  if (!CFG) return;

  /* --- what is true right now ---------------------------------------------
     The opening hours and the ordering switch are things the restaurant
     changes from its phone, so they live in the database rather than in
     config.js. The Worker writes them into the page as a JSON island before
     it is sent (worker/page-render.js), which is why this is read here and
     not fetched: a fetch would mean the guest watches last week's hours
     repaint into this week's a moment after the page appears, and would leave
     a crawler that does not run JavaScript reading whatever config.js shipped
     with.

     config.js is the fallback and nothing more. If the island is missing —
     an old cached page, a Worker that could not reach the database — the site
     publishes the hours it launched with and keeps working. */
  var LIVE = readLiveData();
  if (LIVE.hours && LIVE.hours.days) CFG.hours = LIVE.hours;
  /* The holiday the restaurant announced at /admin. config.js deliberately
     ships no default for it — a holiday is never typed by a developer, see the
     note there — so the island is the only source, and it is put onto CFG at
     boot exactly as the live hours are. Everything downstream then asks one
     object for what is configured, whoever configured it. */
  if (LIVE.holiday) CFG.holiday = LIVE.holiday;

  /* Dishes the kitchen has run out of, written into the page by the Worker so
     the answer is right in the markup rather than a moment after load. The
     `data-soldout` attribute on the row says the same thing for a reader with
     no JavaScript at all; this is the copy the basket asks. */
  var SOLD_OUT = (LIVE && LIVE.soldOut) || {};
  function soldOut(id) {
    if (SOLD_OUT[id]) return true;
    /* The row carries the same fact as an attribute, which is what a reader
       with no JavaScript sees. Asking both means a page cached with one and
       not the other still refuses the dish — and refusing wrongly costs one
       order, while selling a dish that does not exist costs a phone call and
       the guest's evening. */
    var el = items[id] && items[id].el;
    return !!(el && el.getAttribute('data-soldout') === '1');
  }

  function readLiveData() {
    var node = document.getElementById('kairoLive');
    var out = {
      hours: null, ordering: { open: true, resumesAt: null }, soldOut: {},
      extension: null, deliveryShift: null, holiday: null
    };
    if (!node) return out;
    try {
      var data = JSON.parse(node.textContent);
      out.hours = data.hours || null;
      out.soldOut = data.soldOut || {};
      out.extension = data.extension || null;
      out.deliveryShift = data.deliveryShift || null;
      out.holiday = data.holiday || null;
      if (data.ordering && data.ordering.open === false) {
        /* The WHOLE verdict. `reason` and `namedEnd` were dropped here, which
           made orderingNotice() unable to say either why we had stopped or
           when we were back: every closure read "we are not taking orders,
           please look again later", however carefully the restaurant had
           filled the form in. */
        out.ordering = {
          open: false,
          resumesAt: data.ordering.resumesAt || null,
          reason: data.ordering.reason || null,
          namedEnd: data.ordering.namedEnd === true
        };
      }
    } catch (e) { /* the defaults are a complete answer */ }
    return out;
  }

  /* Closing is always temporary and always carries its own end. Asking the
     clock rather than trusting the flag is what lets a tab left open since
     yesterday evening start taking orders again by itself at midnight, with
     no reload and nothing to switch back. */
  function orderingOpen() {
    if (!LIVE.ordering.open) {
      var at = Date.parse(LIVE.ordering.resumesAt || '');
      if (!isFinite(at) || Date.now() < at) return false;
    }
    return !holidayEnds();
  }

  /* When the /admin switch ends, as a day and a minute in Hockenheim — the
     same two values every other time comparison in this file uses, so no
     instant arithmetic and no timezone to get wrong. */
  function switchEnds() {
    if (LIVE.ordering.open) return null;
    var at = Date.parse(LIVE.ordering.resumesAt || '');
    if (!isFinite(at) || Date.now() >= at) return null;
    return {
      iso: berlinDayOf(at), minutes: hhmm(berlinClock(at)), at: at,
      reason: LIVE.ordering.reason, namedEnd: LIVE.ordering.namedEnd
    };
  }

  /* And when the HOLIDAY ends, which is the other thing that can stop the
     till and was for a while the only one that could not.

     The switch defaults to midnight tonight and that default is right: a shop
     closed by accident on a Saturday must be open again on Tuesday. But a
     kitchen away for ten days is the case it gets wrong every single night —
     the closure lapsed at midnight, the till opened at breakfast, and orders
     arrived for a shop with nobody in it.

     Nothing before `from` is withheld. The band goes up the moment the dates
     are saved, usually a fortnight early, and those are days the restaurant is
     open and selling — which is exactly why announcing and closing stayed two
     facts, and why they are joined here rather than merged at the source.

     Read against the clock like everything else: a tab open across the morning
     we are back starts taking orders again on the next tick, and one open
     across the first night away stops. */
  function holidayEnds() {
    var h = CFG.holiday;
    if (!h || !h.from || !h.until) return null;
    var today = (berlinNow() || {}).iso;
    if (!today || today < h.from || today >= h.until) return null;
    return {
      iso: h.until,
      minutes: 0,
      /* Midday UTC on the day we are back. Used for FORMATTING only — the
         comparison above is day-against-day, so no offset can move it — and
         midday is the hour no timezone can push onto the day before. */
      at: Date.parse(h.until + 'T12:00:00Z'),
      reason: 'holiday',
      /* Always: the day we are back is a date somebody typed, so the guest is
         told "back on Saturday the 19th", never "try again later". */
      namedEnd: true
    };
  }

  /* One verdict from the two. Whichever reaches further wins — a closure
     through the weekend after a holiday ending on Friday is still a closure
     through the weekend, and a holiday still shuts the days a closure set for
     tonight cannot reach. Neither may shorten the other. */
  function closureEnds() {
    var off = switchEnds();
    var away = holidayEnds();
    if (!off) return away;
    if (!away) return off;
    return (away.iso > off.iso || (away.iso === off.iso && away.minutes > off.minutes))
      ? away : off;
  }

  /* Is the moment the guest has actually chosen inside the closure?

     This is the whole difference between withholding an option and refusing an
     order. A kitchen that cannot cook tonight can still take an order for
     tomorrow at seven, and the basket already knows how to schedule one. So
     "as soon as possible" is what the closure takes away — exactly as a lunch
     slot takes away delivery — and a time chosen after we reopen is an
     ordinary order that goes through untouched. */
  function orderingBlocksChoice() {
    var end = closureEnds();
    if (!end) return false;
    if (form.when !== 'scheduled') return true;
    if (!draft.fDate || !draft.fTime) return true;
    var day = String(draft.fDate);
    var minutes = hhmm(draft.fTime);
    return day < end.iso || (day === end.iso && minutes < end.minutes);
  }

  // v2 stores { savedAt, items } instead of a bare id -> qty map, so a basket
  // can expire. v1 keys are removed on sight rather than migrated: they carry
  // no timestamp, so there is no way to tell a five-minute-old basket from a
  // five-week-old one.
  var STORAGE_KEY = 'kairo.cart.v2';
  var LEGACY_STORAGE_KEYS = ['kairo.cart.v1'];
  var DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  var SCHEMA_DAY = {
    mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
    fri: 'Friday', sat: 'Saturday', sun: 'Sunday'
  };

  var T = {
    de: {
      days: { mon: 'Montag', tue: 'Dienstag', wed: 'Mittwoch', thu: 'Donnerstag', fri: 'Freitag', sat: 'Samstag', sun: 'Sonntag' },
      closed: 'Geschlossen',
      openLater: 'Heute länger geöffnet — Bestellungen bis {until} Uhr.',
      /* One sentence for both directions: a driver out earlier than usual and
         a driver out later are the same fact with a different time in it, and
         a sentence that simply states today's time is true either way. */
      deliveryToday: 'Heute liefern wir ab {from} Uhr.',
      deliveryTodayAll: 'Heute liefern wir während der gesamten Öffnungszeit.',
      deliveryTodayNone: 'Heute bieten wir ausschließlich Abholung an — es ist kein Fahrer unterwegs.',
      cartPickupOnlyToday: 'Heute bieten wir ausschließlich Abholung an. Für eine Lieferung wählen Sie unter „Wunschtermin“ bitte einen anderen Tag.',
      soldOut: 'Ausverkauft',
      soldOutRemoved: '{dish} ist heute leider ausverkauft und wurde aus dem Warenkorb entfernt.',
      pickupLabel: 'Abholung', deliveryLabel: 'Lieferung',
      deliveryNotice: 'Abholung während der gesamten Öffnungszeit, Lieferung ab {from} Uhr.',
      deliveryClause: 'Bitte beachten: Lieferungen ab {from} Uhr, davor ausschließlich Abholung.',
      hoursByArrangement: 'Firmenbestellungen zu anderen Zeiten nach Absprache.',
      businessByArrangement: 'Liefertermine für Firmenbestellungen nach Absprache — sagen Sie uns einfach, wann Sie es brauchen.',
      cartDeliveryLater: 'Zu dieser Zeit bieten wir ausschließlich Abholung an. Für eine Lieferung wählen Sie unter „Wunschtermin“ bitte eine Zeit ab {from} Uhr.',
      /* The ordering switch. Three sentences, assembled: why (or nothing),
         when we are back (or nothing), and how to reach a person. Each part
         can fall silent on its own, which is what lets one switch produce a
         message that reads properly whether or not a reason was given and
         whether or not an end was named. */
      offNone: 'Wir nehmen zurzeit keine Bestellungen an.',
      offDemand: 'Wir haben gerade außergewöhnlich viele Bestellungen und nehmen vorübergehend keine neuen an.',
      offEmergency: 'Wir mussten die Bestellannahme kurzfristig unterbrechen.',
      offHoliday: 'Wir haben Betriebsferien und nehmen zurzeit keine Bestellungen an.',
      offBackAt: 'Ab {time} Uhr sind wir wieder für Sie da.',
      offBackOn: 'Ab {date} sind wir wieder für Sie da.',
      offBackSoon: 'Bitte schauen Sie etwas später noch einmal vorbei.',
      offOrderLater: 'Sie können aber jetzt schon für später bestellen — wählen Sie unter „Wunschtermin“ eine Zeit ab {resumes}.',
      offContact: 'Bei Fragen erreichen Sie uns unter {phone}.',
      ordersOffShort: 'Bestellungen pausiert',
      openNow: 'Jetzt geöffnet', closedNow: 'Zurzeit geschlossen',
      until: 'bis', opensAgain: 'öffnet wieder',
      today: 'Heute',
      add: 'Hinzufügen', remove: 'Entfernen',
      cartOpen: 'Bestellung öffnen', itemsOne: 'Gericht', itemsMany: 'Gerichte',
      cart: 'Bestellung', cartEmpty: 'Ihr Warenkorb ist noch leer.',
      cartEmptyHint: 'Tippen Sie in der Speisekarte auf „+“, um Gerichte hinzuzufügen.',
      subtotal: 'Zwischensumme', discount: 'Direktbestellung', total: 'Gesamt',
      type: 'Lieferung oder Abholung', delivery: 'Lieferung', pickup: 'Abholung',
      name: 'Name', phone: 'Telefon', address: 'Straße & Hausnummer',
      addressPh: 'z. B. Rostocker Straße 20a',
      postcode: 'Postleitzahl', postcodePh: '68766',
      deliveryFee: 'Lieferung',
      zoneOk: 'Wir liefern nach {city}.',
      zoneFee: 'Lieferung nach {city}: {fee}.',
      zoneToFree: 'Noch {missing} bis zur kostenfreien Lieferung.',
      zoneFreeReached: 'Lieferung nach {city} — kostenfrei, Sie sparen {saved}.',
      zoneBelowMin: 'Noch {missing} bis zum Mindestbestellwert in {city} ({min} €).',
      // Who the minimum is asked of, written from config.order.minimumOrder so
      // the pages state the rule the basket applies.
      minimumClause: 'Der Mindestbestellwert gilt nur für private Lieferbestellungen — bei Abholung und bei Firmenbestellungen entfällt er.',
      freeDeliveryAll: 'Ab {freeDeliveryFrom} € Bestellwert liefern wir kostenfrei — für jede Bestellung, privat wie geschäftlich.',
      zoneUnknown: 'Diese Postleitzahl liegt außerhalb unseres Liefergebiets. Sie können uns trotzdem eine unverbindliche Anfrage senden — das ist noch keine Bestellung. Wir prüfen, ob wir zu Ihnen liefern können, und antworten direkt im Chat.',
      when: 'Wunschtermin', asap: 'So schnell wie möglich', scheduled: 'Für später planen',
      dateLabel: 'Datum', timeLabel: 'Uhrzeit',
      closedNote: 'Wir haben gerade geschlossen. Sie können trotzdem vorbestellen — wählen Sie einen Wunschtermin, wir bestätigen ihn im Chat.',
      warnClosedAsap: 'Wir sind gerade geschlossen, „so schnell wie möglich“ heißt daher: zur nächsten Öffnung ({next}).',
      warnOutsideHours: 'Zu diesem Termin haben wir geschlossen. Senden Sie die Bestellung trotzdem — wir schlagen im Chat eine passende Zeit vor.',
      warnLeadTime: 'Für Firmenbestellungen brauchen wir mindestens {h} Stunden Vorlauf. Wir prüfen den Termin und bestätigen ihn im Chat.',
      warnPastTime: 'Dieser Termin liegt in der Vergangenheit.',
      notes: 'Anmerkung', notesPh: 'Allergien, Klingel, Etage …',
      company: 'Firma / Rechnungsadresse',
      isBusiness: 'Firmenbestellung',
      leadTime: 'Größere Bestellungen bitte mindestens {h} Std. im Voraus.',
      // Wortlaut nach § 312j Abs. 3 BGB.
      orderLiable: 'Zahlungspflichtig bestellen',
      send: 'Per WhatsApp senden', sendRequest: 'Unverbindliche Anfrage senden',
      sending: 'WhatsApp wird geöffnet …',
      sentTitleRequest: 'Anfrage vorbereitet',
      sentTextRequest: 'Bitte senden Sie die Nachricht ab. Es handelt sich um eine Anfrage, nicht um eine bestätigte Bestellung — wir melden uns im Chat, ob wir zu Ihnen liefern können.',
      msgTitleRequest: 'ANFRAGE (keine Bestellung) über kairo1980.de',
      privacy: 'Ihre Angaben werden ausschließlich in die WhatsApp-Nachricht übernommen — wir speichern nichts auf dieser Seite.',
      required: 'Bitte ausfüllen.',
      sentTitle: 'WhatsApp geöffnet',
      sentText: 'Bitte senden Sie die vorbereitete Nachricht ab — wir bestätigen Ihre Bestellung direkt im Chat.',
      payNow: 'Jetzt bezahlen', payHint: 'Optional — Sie können auch bei Erhalt bezahlen.',
      or: 'oder',
      pay: { cash: 'Bargeld', giro: 'EC-/Girocard', card: 'Kreditkarte' },
      // Kennzeichnungspflichtige Allergene nach LMIV (EU) Nr. 1169/2011.
      allergen: {
        gluten: 'Gluten', milk: 'Milch', sesame: 'Sesam',
        nuts: 'Schalenfrüchte'
      },
      allergenLabel: 'Allergene',
      allergenNone: 'Keine kennzeichnungspflichtigen Allergene',
      allergenPending: 'Allergene bitte erfragen',
      allergenLegendTitle: 'Allergenkennzeichnung',
      allergenLegendNote: 'Die Buchstaben hinter einem Gericht nennen die enthaltenen kennzeichnungspflichtigen Allergene nach LMIV (EU) Nr. 1169/2011. Gerichte ohne Buchstaben enthalten keine kennzeichnungspflichtigen Allergene. Bei Fragen sprechen Sie uns bitte an — auch zu Spuren, die sich in einer offenen Küche nie ganz ausschließen lassen.',
      // Wortlaut gesetzlich vorgegeben (LMIV Anhang III Nr. 4.1).
      caffeineNotice: 'Erhöhter Koffeingehalt. Für Kinder und schwangere oder stillende Frauen nicht empfohlen.',
      payOnSite: 'Zahlung bei {type}: {methods}.',
      payOnline: 'Oder direkt online bezahlen — mit Apple Pay, Google Pay, Karte oder PayPal.',
      payInvoice: 'Rechnung (Firmenkunden)',
      // Lower case in English, where "Payment on Pickup" reads like a title.
      // German keeps the capitals: they are nouns.
      atPickup: 'Abholung', atDelivery: 'Lieferung',
      payMethod: 'Zahlungsart',
      payOptionOnline: 'Jetzt online bezahlen',
      payOptionOnSite: 'Bei Erhalt bezahlen',
      payOnlineHint: 'Im nächsten Schritt bezahlen Sie {total} mit Apple Pay, Google Pay, Karte oder PayPal. Danach öffnet sich WhatsApp mit Ihrer Bestellung.',
      paySecure: 'Verschlüsselte Zahlung — Kartendaten erreichen kairo1980.de zu keinem Zeitpunkt.',
      payTitle: 'Bezahlen', payAmountLabel: 'Zu zahlen', payRef: 'Bestellnummer',
      payPaidTitle: 'Zahlung erfolgreich',
      payPaidText: 'Vielen Dank! Ihre Zahlung ist eingegangen.',
      // The single most important sentence on the site: the money is ours, the
      // order is not yet. Said plainly, above the button that fixes it.
      mustSend: 'Bitte senden Sie Ihre Bestellung jetzt ab — erst dann erreicht sie unsere Küche.',
      sendOrderNow: 'Bestellung jetzt senden',
      popupBlocked: 'Ihr Browser hat das WhatsApp-Fenster blockiert. Bitte tippen Sie auf den Knopf.',
      payCancelTitle: 'Zahlung abgebrochen',
      payCancelText: 'Es wurde nichts abgebucht. Versuchen Sie es erneut oder bezahlen Sie einfach bei Erhalt.',
      payFailTitle: 'Zahlung fehlgeschlagen',
      payFailText: 'Es wurde nichts abgebucht. Bitte versuchen Sie eine andere Zahlungsart — oder bezahlen Sie bei Erhalt.',
      payDeclined: 'Ihre Bank hat die Zahlung abgelehnt. Es wurde nichts abgebucht.',
      payPendingTitle: 'Zahlung wird geprüft',
      payPendingText: 'Ihre Zahlung wird noch bestätigt. Senden Sie Ihre Bestellung jetzt ab — wir melden uns im Chat.',
      payUnavailable: 'Online-Zahlung ist gerade nicht verfügbar. Senden Sie Ihre Bestellung und bezahlen Sie bei Erhalt.',
      payRetry: 'Erneut versuchen',
      paySendAnyway: 'Bestellung senden und bei Erhalt bezahlen',
      payWorking: 'Einen Moment …',
      mPayment: 'Zahlung',
      mPayOnline: 'ONLINE BEZAHLT ✓ ({ref} · {amount})',
      mPayPending: 'Online-Zahlung in Prüfung ({ref}) — bitte Eingang bestätigen',
      mPayOnSite: 'Vor Ort bei {type} ({methods})',
      mRef: 'Bestellnummer',
      mItemCount: '{n} Positionen',
      mListFollows: 'Vollständige Liste folgt gleich im Chat',
      waShortened: 'Ihre Bestellung ist sehr umfangreich. An WhatsApp haben wir eine Kurzfassung übergeben — die vollständige Liste liegt in der Zwischenablage, bitte im Chat einfügen.',
      newOrder: 'Neue Bestellung', close: 'Schließen',
      msgTitle: 'Neue Bestellung über kairo1980.de',
      msgBusiness: 'FIRMENBESTELLUNG',
      mLead: 'Vorlauf', mHours: 'Std.',
      mType: 'Art', mName: 'Name', mPhone: 'Telefon', mAddress: 'Adresse',
      mTime: 'Wunschtermin', mNotes: 'Anmerkung', mCompany: 'Firma',
      mPreorder: 'VORBESTELLUNG — ausserhalb der Öffnungszeiten aufgegeben',
      mCheckTime: 'Wunschtermin ausserhalb der Öffnungszeiten — bitte prüfen',
      mCheckLead: 'Weniger als {h} Std. Vorlauf — bitte prüfen',
      mSubtotal: 'Zwischensumme', mDiscount: 'Rabatt', mTotal: 'Gesamt', mPaypal: 'PayPal',
      mOutsideArea: 'PLZ ausserhalb des Liefergebiets — Anfrage zur Prüfung',
      mUnderMin: 'Unter dem Mindestbestellwert ({min} €)',
      noWhatsapp: 'Kein WhatsApp auf diesem Gerät?',
      qrHint: 'Scannen Sie den Code mit der Handykamera — WhatsApp öffnet sich auf dem Handy mit Ihrer fertigen Bestellung.',
      qrHintLong: 'Scannen Sie den Code mit der Handykamera — der Chat öffnet sich auf Ihrem Handy. Kopieren Sie die Bestellung mit der Schaltfläche darunter und fügen Sie sie dort ein.',
      qrAlt: 'QR-Code, der WhatsApp mit Ihrer Bestellung öffnet',
      copyOrder: 'Bestellung kopieren', copied: 'Kopiert ✓',
      callUs: 'Anrufen', smsUs: 'Per SMS senden',
      openAgain: 'WhatsApp erneut öffnen',
      areaFree: 'frei',
      areaMinOrder: 'Mindestbestellwert {min} €',
      faqHoursLead: 'Unsere aktuellen Öffnungszeiten: ',
      faqHoursTail: 'Der Status im Kontaktbereich zeigt jederzeit an, ob wir gerade geöffnet haben. Bestellungen außerhalb dieser Zeiten erreichen uns als Vorbestellung für Ihren Wunschtermin.',
      waBusiness: 'Hallo KAIRO 1980, ich möchte ein Angebot für eine Firmenbestellung.\n\n' +
        'Firma: \nUngefährer Bestellwert: \nDatum & Uhrzeit: \n' +
        'Lieferung oder Abholung: \nLieferadresse: \nAnmerkung (Allergien o. Ä.): ',
      waSimple: 'Hallo KAIRO 1980! Ich möchte gerne bestellen.'
    },
    en: {
      days: { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' },
      closed: 'Closed',
      openLater: 'Open later today — orders until {until}.',
      deliveryToday: 'Today we deliver from {from}.',
      deliveryTodayAll: 'Today we deliver throughout our opening hours.',
      deliveryTodayNone: 'Today we offer collection only — no driver is out.',
      cartPickupOnlyToday: 'Today we offer collection only. For a delivery, please pick another day under “Preferred time”.',
      soldOut: 'Sold out',
      soldOutRemoved: '{dish} is sold out today and has been removed from your basket.',
      pickupLabel: 'Pickup', deliveryLabel: 'Delivery',
      deliveryNotice: 'Collection throughout our opening hours, delivery from {from}.',
      deliveryClause: 'Please note: deliveries from {from} — before that, collection only.',
      hoursByArrangement: 'Corporate orders outside these times by arrangement.',
      businessByArrangement: 'Delivery times for corporate orders by arrangement — just tell us when you need it.',
      cartDeliveryLater: 'At this time we offer collection only. For a delivery, pick a time from {from} under "Preferred time".',
      offNone: 'We are not taking orders at the moment.',
      offDemand: 'We have an unusually high number of orders right now and are not taking new ones for the moment.',
      offEmergency: 'We have had to stop taking orders at short notice.',
      offHoliday: 'We are closed for our annual holiday and are not taking orders at the moment.',
      offBackAt: 'We are back from {time}.',
      offBackOn: 'We are back from {date}.',
      offBackSoon: 'Please check back a little later.',
      offOrderLater: 'You can still order for later — pick a time from {resumes} under “Preferred time”.',
      offContact: 'If you have any questions, reach us on {phone}.',
      ordersOffShort: 'Ordering paused',
      openNow: 'Open now', closedNow: 'Currently closed',
      until: 'until', opensAgain: 'opens again',
      today: 'Today',
      add: 'Add', remove: 'Remove',
      cartOpen: 'Open your order', itemsOne: 'dish', itemsMany: 'dishes',
      cart: 'Your order', cartEmpty: 'Your basket is still empty.',
      cartEmptyHint: 'Tap "+" next to a dish in the menu to add it.',
      subtotal: 'Subtotal', discount: 'Direct order', total: 'Total',
      type: 'Delivery or pickup', delivery: 'Delivery', pickup: 'Pickup',
      name: 'Name', phone: 'Phone', address: 'Street & number',
      addressPh: 'e.g. Rostocker Straße 20a',
      postcode: 'Postcode', postcodePh: '68766',
      deliveryFee: 'Delivery',
      zoneOk: 'We deliver to {city}.',
      zoneFee: 'Delivery to {city}: {fee}.',
      zoneToFree: '{missing} to go until delivery is free.',
      zoneFreeReached: 'Delivery to {city} — free, saving you {saved}.',
      zoneBelowMin: '{missing} to go until the minimum order in {city} (€{min}).',
      minimumClause: 'The minimum order value applies to private delivery orders only — it does not apply to collection or to company orders.',
      freeDeliveryAll: 'From €{freeDeliveryFrom} we deliver free of charge — on every order, private or corporate.',
      zoneUnknown: 'This postcode is outside our delivery area. You can still send us a non-binding enquiry — this is not an order yet. We will check whether we can deliver to you and reply in the chat.',
      when: 'Preferred time', asap: 'As soon as possible', scheduled: 'Schedule for later',
      dateLabel: 'Date', timeLabel: 'Time',
      closedNote: 'We are closed right now. You can still pre-order — pick a preferred time and we will confirm it in the chat.',
      warnClosedAsap: 'We are currently closed, so "as soon as possible" means at our next opening ({next}).',
      warnOutsideHours: 'We are closed at that time. Send the order anyway — we will suggest a suitable time in the chat.',
      warnLeadTime: 'Corporate orders need at least {h} hours lead time. We will check the time and confirm it in the chat.',
      warnPastTime: 'That time is in the past.',
      notes: 'Note', notesPh: 'Allergies, doorbell, floor …',
      company: 'Company / billing address',
      isBusiness: 'Corporate order',
      leadTime: 'Please place larger orders at least {h} hours in advance.',
      orderLiable: 'Order with obligation to pay',
      send: 'Send via WhatsApp', sendRequest: 'Send a non-binding enquiry',
      sending: 'Opening WhatsApp …',
      sentTitleRequest: 'Enquiry prepared',
      sentTextRequest: 'Please send the message. This is an enquiry, not a confirmed order — we will let you know in the chat whether we can deliver to you.',
      msgTitleRequest: 'ENQUIRY (not an order) via kairo1980.de',
      privacy: 'Your details are only copied into the WhatsApp message — nothing is stored on this site.',
      required: 'Please fill this in.',
      sentTitle: 'WhatsApp opened',
      sentText: 'Please send the prepared message — we confirm your order right in the chat.',
      payNow: 'Pay now', payHint: 'Optional — you can also pay on arrival.',
      or: 'or',
      pay: { cash: 'cash', giro: 'girocard', card: 'credit card' },
      allergen: {
        gluten: 'gluten', milk: 'milk', sesame: 'sesame',
        nuts: 'tree nuts'
      },
      allergenLabel: 'Allergens',
      allergenNone: 'No allergens requiring declaration',
      allergenPending: 'Please ask us about allergens',
      allergenLegendTitle: 'Allergen information',
      allergenLegendNote: 'The letters after a dish name list the allergens requiring declaration under LMIV (EU) 1169/2011. Dishes without letters contain none. Please ask us about anything else — including traces, which an open kitchen can never fully rule out.',
      caffeineNotice: 'High caffeine content. Not recommended for children or pregnant or breastfeeding women.',
      payOnSite: 'Payment on {type}: {methods}.',
      payOnline: 'Or pay online right away — with Apple Pay, Google Pay, card or PayPal.',
      payInvoice: 'Invoice (business customers)',
      atPickup: 'pickup', atDelivery: 'delivery',
      payMethod: 'Payment',
      payOptionOnline: 'Pay online now',
      payOptionOnSite: 'Pay on arrival',
      payOnlineHint: 'In the next step you pay {total} with Apple Pay, Google Pay, card or PayPal. WhatsApp then opens with your order.',
      paySecure: 'Encrypted payment — card details never reach kairo1980.de.',
      payTitle: 'Payment', payAmountLabel: 'To pay', payRef: 'Order number',
      payPaidTitle: 'Payment successful',
      payPaidText: 'Thank you! Your payment has gone through.',
      mustSend: 'Please send your order now — it only reaches our kitchen once you do.',
      sendOrderNow: 'Send order now',
      popupBlocked: 'Your browser blocked the WhatsApp window. Please tap the button.',
      payCancelTitle: 'Payment cancelled',
      payCancelText: 'Nothing was charged. Try again, or simply pay on arrival.',
      payFailTitle: 'Payment failed',
      payFailText: 'Nothing was charged. Please try another payment method — or pay on arrival.',
      payDeclined: 'Your bank declined the payment. Nothing was charged.',
      payPendingTitle: 'Payment being checked',
      payPendingText: 'Your payment is still being confirmed. Send your order now — we will get back to you in the chat.',
      payUnavailable: 'Online payment is unavailable right now. Send your order and pay on arrival.',
      payRetry: 'Try again',
      paySendAnyway: 'Send order and pay on arrival',
      payWorking: 'One moment …',
      mPayment: 'Payment',
      mPayOnline: 'PAID ONLINE ✓ ({ref} · {amount})',
      mPayPending: 'Online payment under review ({ref}) — please confirm receipt',
      mPayOnSite: 'In person on {type} ({methods})',
      mRef: 'Order number',
      mItemCount: '{n} items',
      mListFollows: 'Full list follows in the chat',
      waShortened: 'Your order is very large. We handed WhatsApp a short version — the full list is on your clipboard, please paste it into the chat.',
      newOrder: 'New order', close: 'Close',
      msgTitle: 'New order via kairo1980.de',
      msgBusiness: 'CORPORATE ORDER',
      mLead: 'Lead time', mHours: 'hrs',
      mType: 'Type', mName: 'Name', mPhone: 'Phone', mAddress: 'Address',
      mTime: 'Preferred time', mNotes: 'Note', mCompany: 'Company',
      mPreorder: 'PRE-ORDER — placed outside opening hours',
      mCheckTime: 'Preferred time is outside opening hours — please check',
      mCheckLead: 'Less than {h} hrs lead time — please check',
      mSubtotal: 'Subtotal', mDiscount: 'Discount', mTotal: 'Total', mPaypal: 'PayPal',
      mOutsideArea: 'Postcode outside the delivery area — request to be checked',
      mUnderMin: 'Below the minimum order (€{min})',
      noWhatsapp: 'No WhatsApp on this device?',
      qrHint: 'Scan the code with your phone camera — WhatsApp opens on the phone with your order already written.',
      qrHintLong: 'Scan the code with your phone camera — the chat opens on your phone. Copy the order with the button below and paste it there.',
      qrAlt: 'QR code that opens WhatsApp with your order',
      copyOrder: 'Copy the order', copied: 'Copied ✓',
      callUs: 'Call us', smsUs: 'Send by SMS',
      openAgain: 'Open WhatsApp again',
      areaFree: 'free',
      areaMinOrder: 'Minimum order €{min}',
      faqHoursLead: 'Our current opening hours are: ',
      faqHoursTail: 'The live status at the top of the contact section always shows whether we are open right now. Orders placed outside these hours reach us as a pre-order for a time you choose.',
      waBusiness: 'Hello KAIRO 1980, I would like a quote for a corporate order.\n\n' +
        'Company: \nApprox. order value: \nDate & time it is needed: \n' +
        'Delivery or pickup: \nDelivery address: \nNotes (allergies, etc.): ',
      waSimple: 'Hello KAIRO 1980! I would like to place an order.'
    },
    ar: {
      days: { mon: 'الاثنين', tue: 'الثلاثاء', wed: 'الأربعاء', thu: 'الخميس', fri: 'الجمعة', sat: 'السبت', sun: 'الأحد' },
      closed: 'مغلق',
      openLater: 'النهارده فاتحين لوقت متأخر — الطلبات لحد الساعة {until}.',
      deliveryToday: 'النهارده بنوصّل من الساعة {from}.',
      deliveryTodayAll: 'النهارده بنوصّل طول مواعيد الفتح.',
      deliveryTodayNone: 'النهارده الاستلام من المطعم بس — مفيش سواق برّه.',
      cartPickupOnlyToday: 'النهارده الاستلام من المطعم بس. لو عايز توصيل، اختار يوم تاني من «الميعاد المطلوب».',
      soldOut: 'خلص',
      soldOutRemoved: '{dish} خلص النهارده للأسف واتشال من السلة.',
      pickupLabel: 'الاستلام', deliveryLabel: 'التوصيل',
      deliveryNotice: 'الاستلام من المطعم طول مواعيد الفتح، والتوصيل من الساعة {from}.',
      deliveryClause: 'للعلم: التوصيل من الساعة {from}، وقبل كده الاستلام من المطعم بس.',
      hoursByArrangement: 'طلبات الشركات في مواعيد تانية بالاتفاق معانا.',
      businessByArrangement: 'مواعيد توصيل طلبات الشركات بالاتفاق — قول لنا بس محتاجها إمتى.',
      cartDeliveryLater: 'في الوقت ده عندنا استلام من المطعم بس. لو عايز توصيل، اختار تحت «الموعد المطلوب» وقت من الساعة {from}.',
      offNone: 'مش بنستقبل طلبات دلوقتي.',
      offDemand: 'عندنا طلبات كتير جداً دلوقتي، فمش بنستقبل طلبات جديدة مؤقتاً.',
      offEmergency: 'اضطرينا نوقف استقبال الطلبات فجأة.',
      offHoliday: 'إحنا في أجازة ومش بنستقبل طلبات دلوقتي.',
      offBackAt: 'هنرجع من الساعة {time}.',
      offBackOn: 'هنرجع من {date}.',
      offBackSoon: 'تعالى بصّ تاني بعد شوية.',
      offOrderLater: 'بس تقدر تطلب من دلوقتي لوقت لاحق — اختار تحت «الموعد المطلوب» وقت من {resumes}.',
      offContact: 'لو عندك أي استفسار كلّمنا على {phone}.',
      ordersOffShort: 'الطلبات متوقفة',
      openNow: 'مفتوح دلوقتي', closedNow: 'مغلق دلوقتي',
      until: 'لحد', opensAgain: 'هنفتح تاني',
      today: 'النهارده',
      add: 'أضف', remove: 'شيل',
      cartOpen: 'افتح الطلب', itemsOne: 'طبق', itemsMany: 'أطباق',
      cart: 'طلبك', cartEmpty: 'السلة لسه فاضية.',
      cartEmptyHint: 'دوس على «+» جنب أي طبق في المنيو عشان تضيفه.',
      subtotal: 'الإجمالي المبدئي', discount: 'طلب مباشر', total: 'الإجمالي',
      type: 'توصيل ولا استلام', delivery: 'توصيل', pickup: 'استلام',
      name: 'الاسم', phone: 'التليفون', address: 'الشارع ورقم البيت',
      addressPh: 'مثال: Rostocker Straße 20a',
      postcode: 'الرمز البريدي', postcodePh: '68766',
      deliveryFee: 'التوصيل',
      zoneOk: 'بنوصّل لـ {city}.',
      zoneFee: 'التوصيل لـ {city}: {fee}.',
      zoneToFree: 'فاضل {missing} والتوصيل يبقى مجاني.',
      zoneFreeReached: 'التوصيل لـ {city} — مجاني، ووفّرت {saved}.',
      zoneBelowMin: 'فاضل {missing} على الحد الأدنى للطلب في {city} ({min} €).',
      minimumClause: 'الحد الأدنى للطلب بينطبق على طلبات التوصيل للأفراد بس — مش بينطبق على الاستلام ولا على طلبات الشركات.',
      freeDeliveryAll: 'من {freeDeliveryFrom} € وفوق التوصيل مجاني — على أي طلب، فرد أو شركة.',
      zoneUnknown: 'الرمز البريدي ده برة منطقة التوصيل بتاعتنا. تقدر تبعتلنا استفسار من غير أي التزام — ده لسه مش طلب. هنشوف نقدر نوصّلك ولا لأ ونرد عليك في الشات.',
      when: 'الموعد المطلوب', asap: 'في أقرب وقت', scheduled: 'حدد موعد بعدين',
      dateLabel: 'التاريخ', timeLabel: 'الساعة',
      closedNote: 'إحنا مقفولين دلوقتي، بس تقدر تطلب مقدماً — اختار الموعد اللي يناسبك وهنأكده لك في الشات.',
      warnClosedAsap: 'إحنا مقفولين دلوقتي، يعني «في أقرب وقت» معناها أول ما نفتح ({next}).',
      warnOutsideHours: 'الموعد ده إحنا مقفولين فيه. ابعت الطلب برضه — وهنقترح عليك وقت مناسب في الشات.',
      warnLeadTime: 'طلبات الشركات محتاجة {h} ساعات تحضير على الأقل. هنشوف الموعد ونأكده لك في الشات.',
      warnPastTime: 'الموعد ده عدّى خلاص.',
      notes: 'ملاحظات', notesPh: 'حساسية، الجرس، الدور …',
      company: 'الشركة / عنوان الفاتورة',
      isBusiness: 'طلب شركة',
      leadTime: 'الطلبات الكبيرة يا ريت قبلها بـ {h} ساعات على الأقل.',
      orderLiable: 'اطلب مع الالتزام بالدفع',
      send: 'ابعت على واتساب', sendRequest: 'ابعت استفسار من غير التزام',
      sending: 'بنفتح واتساب …',
      sentTitleRequest: 'الاستفسار جاهز',
      sentTextRequest: 'من فضلك ابعت الرسالة. ده استفسار مش طلب مؤكد — هنقولك في الشات نقدر نوصّلك ولا لأ.',
      msgTitleRequest: 'استفسار (مش طلب) من kairo1980.de',
      privacy: 'بياناتك بتتكتب في رسالة واتساب بس — إحنا مش بنحفظ أي حاجة على الموقع ده.',
      required: 'من فضلك املا الخانة دي.',
      sentTitle: 'واتساب اتفتح',
      sentText: 'من فضلك ابعت الرسالة الجاهزة — وهنأكد طلبك في الشات على طول.',
      payNow: 'ادفع دلوقتي', payHint: 'اختياري — تقدر تدفع عند الاستلام برضه.',
      or: 'أو',
      pay: { cash: 'كاش', giro: 'كارت EC/Giro', card: 'كارت ائتمان' },
      allergen: {
        gluten: 'جلوتين', milk: 'لبن', sesame: 'سمسم',
        nuts: 'مكسرات قشرية'
      },
      allergenLabel: 'مسببات الحساسية',
      allergenNone: 'لا توجد مسببات حساسية واجبة الإعلان',
      allergenPending: 'برجاء السؤال عن مسببات الحساسية',
      allergenLegendTitle: 'بيان مسببات الحساسية',
      allergenLegendNote: 'الحروف اللي جنب اسم الطبق بتوضّح مسببات الحساسية الواجب الإعلان عنها حسب لائحة LMIV (EU) 1169/2011. والأطباق اللي من غير حروف مفيهاش مسببات واجبة الإعلان. ولو عندك أي سؤال كلّمنا — كمان بخصوص الآثار البسيطة اللي مطبخ مفتوح عمره ما يقدر يمنعها تماماً.',
      caffeineNotice: 'نسبة كافيين عالية. غير مناسب للأطفال ولا للحوامل أو المرضعات.',
      payOnSite: 'الدفع عند ال{type}: {methods}.',
      payOnline: 'أو ادفع أونلاين على طول — بـ Apple Pay أو Google Pay أو الكارت أو PayPal.',
      payInvoice: 'فاتورة (لعملاء الشركات)',
      atPickup: 'استلام', atDelivery: 'توصيل',
      payMethod: 'طريقة الدفع',
      payOptionOnline: 'ادفع أونلاين دلوقتي',
      payOptionOnSite: 'الدفع عند الاستلام',
      payOnlineHint: 'في الخطوة الجاية هتدفع {total} بـ Apple Pay أو Google Pay أو الكارت أو PayPal. وبعدين هيفتح واتساب بطلبك.',
      paySecure: 'الدفع مشفّر — بيانات الكارت عمرها ما بتوصل لـ kairo1980.de.',
      payTitle: 'الدفع', payAmountLabel: 'المطلوب دفعه', payRef: 'رقم الطلب',
      payPaidTitle: 'تم الدفع بنجاح',
      payPaidText: 'شكراً! الدفع وصل بنجاح.',
      mustSend: 'من فضلك ابعت طلبك دلوقتي — من غير كده الطلب مش هيوصل للمطبخ.',
      sendOrderNow: 'ابعت الطلب دلوقتي',
      popupBlocked: 'المتصفح منع نافذة واتساب. من فضلك دوس على الزرار.',
      payCancelTitle: 'تم إلغاء الدفع',
      payCancelText: 'مفيش أي مبلغ اتخصم. جرّب تاني أو ادفع عند الاستلام عادي.',
      payFailTitle: 'الدفع ما تمّش',
      payFailText: 'مفيش أي مبلغ اتخصم. جرّب طريقة دفع تانية — أو ادفع عند الاستلام.',
      payDeclined: 'البنك رفض العملية. مفيش أي مبلغ اتخصم.',
      payPendingTitle: 'الدفع تحت المراجعة',
      payPendingText: 'الدفع لسه بيتأكد. ابعت طلبك دلوقتي — وهنرد عليك في الشات.',
      payUnavailable: 'الدفع أونلاين مش متاح دلوقتي. ابعت طلبك وادفع عند الاستلام.',
      payRetry: 'جرّب تاني',
      paySendAnyway: 'ابعت الطلب وادفع عند الاستلام',
      payWorking: 'لحظة واحدة …',
      mPayment: 'الدفع',
      mPayOnline: 'مدفوع أونلاين ✓ ({ref} · {amount})',
      mPayPending: 'دفع أونلاين تحت المراجعة ({ref}) — برجاء تأكيد الوصول',
      mPayOnSite: 'عند ال{type} ({methods})',
      mRef: 'رقم الطلب',
      mItemCount: '{n} صنف',
      mListFollows: 'القائمة الكاملة هتوصل حالاً في الشات',
      waShortened: 'طلبك كبير جداً. بعتنا لواتساب نسخة مختصرة — والقائمة الكاملة متسجّلة في الحافظة، من فضلك الصقها في الشات.',
      newOrder: 'طلب جديد', close: 'إغلاق',
      msgTitle: 'طلب جديد من kairo1980.de',
      msgBusiness: 'طلب شركة',
      mLead: 'وقت التحضير', mHours: 'ساعة',
      mType: 'النوع', mName: 'الاسم', mPhone: 'التليفون', mAddress: 'العنوان',
      mTime: 'الموعد المطلوب', mNotes: 'ملاحظات', mCompany: 'الشركة',
      mPreorder: 'طلب مسبق — اتبعت برة مواعيد العمل',
      mCheckTime: 'الموعد المطلوب برة مواعيد العمل — برجاء المراجعة',
      mCheckLead: 'أقل من {h} ساعات تحضير — برجاء المراجعة',
      mSubtotal: 'الإجمالي المبدئي', mDiscount: 'خصم', mTotal: 'الإجمالي', mPaypal: 'PayPal',
      mOutsideArea: 'الرمز البريدي برة منطقة التوصيل — استفسار للمراجعة',
      mUnderMin: 'أقل من الحد الأدنى للطلب ({min} €)',
      noWhatsapp: 'مفيش واتساب على الجهاز ده؟',
      qrHint: 'امسح الكود بكاميرا الموبايل — واتساب هيفتح على تليفونك والطلب مكتوب جاهز.',
      qrHintLong: 'امسح الكود بكاميرا الموبايل — الشات هيفتح على تليفونك. انسخ الطلب بالزرار اللي تحت والزقه هناك.',
      qrAlt: 'كود QR بيفتح واتساب وفيه طلبك',
      copyOrder: 'انسخ الطلب', copied: 'اتنسخ ✓',
      callUs: 'اتصل بينا', smsUs: 'ابعت SMS',
      openAgain: 'افتح واتساب تاني',
      areaFree: 'مجاني',
      areaMinOrder: 'الحد الأدنى للطلب {min} €',
      faqHoursLead: 'مواعيد العمل الحالية: ',
      faqHoursTail: 'حالة المطعم في قسم التواصل بتوضّح دايماً إحنا مفتوحين دلوقتي ولا لأ. والطلبات برة المواعيد دي بتوصلنا كطلب مسبق للموعد اللي اخترته.',
      waBusiness: 'أهلاً KAIRO 1980، عايز عرض سعر لطلب شركة.\n\n' +
        'الشركة: \nقيمة الطلب التقريبية: \nالتاريخ والساعة: \n' +
        'توصيل ولا استلام: \nعنوان التوصيل: \nملاحظات (حساسية وخلافه): ',
      waSimple: 'أهلاً KAIRO 1980! عايز أطلب من فضلك.'
    }
  };

  // Whatever lang.js put on <html>, as long as this file has that dictionary.
  function lang() {
    var tag = document.documentElement.lang;
    return Object.prototype.hasOwnProperty.call(T, tag) ? tag : 'de';
  }
  function t() {
    return T[lang()];
  }

  // Arabic uses Latin digits: the prices are German prices on a German
  // receipt, and Egypt reads them this way day to day anyway.
  var DATE_LOCALE = { de: 'de-DE', en: 'en-GB', ar: 'ar-EG-u-nu-latn' };

  var money = function (value) {
    return new Intl.NumberFormat(CFG.order.locale || 'de-DE', {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    }).format(value) + ' ' + (CFG.order.currency || '€');
  };

  /* =========================================================================
     Opening hours
     ========================================================================= */

  function hhmm(value) {
    var bits = String(value).split(':');
    return (+bits[0]) * 60 + (+bits[1] || 0);
  }

  // The guest may sit in any timezone; the restaurant does not. Always judge
  // "open now" against Europe/Berlin.
  function berlinNow(at) {
    try {
      var parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Berlin', weekday: 'short',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
      }).formatToParts(at || new Date());
      var get = function (type) {
        var hit = parts.filter(function (p) { return p.type === type; })[0];
        return hit ? hit.value : '';
      };
      var map = { Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun' };
      var day = map[get('weekday').slice(0, 3)];
      if (!day) return null;
      return {
        day: day,
        minutes: ((+get('hour')) % 24) * 60 + (+get('minute')),
        iso: get('year') + '-' + get('month') + '-' + get('day')
      };
    } catch (e) {
      return berlinFromUTC(new Date());
    }
  }

  /* Berlin without Intl.
     -----------------------------------------------------------------------
     If the timezone database is missing — an old engine, a stripped embedded
     browser, a locked-down kiosk — the previous fallback used the visitor's
     OWN clock. A guest in Cairo or New York would then be shown the wrong
     day's opening hours and could schedule an order for a date that is not
     the restaurant's today.

     The restaurant is in one place and that place has one rule: UTC+1, or
     UTC+2 from the last Sunday in March at 01:00 UTC until the last Sunday in
     October at 01:00 UTC. That rule is arithmetic, needs no data, and is the
     same one Intl would have applied.

     This is a fallback and stays one: whenever Intl works, Intl decides. */
  function lastSundayUTC(year, monthIndex) {
    // Day 0 of the next month is the last day of this one.
    var d = new Date(Date.UTC(year, monthIndex + 1, 0, 1, 0, 0));
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    return d;
  }

  function berlinFromUTC(date) {
    var year = date.getUTCFullYear();
    var summer = date >= lastSundayUTC(year, 2) && date < lastSundayUTC(year, 9);
    var shifted = new Date(date.getTime() + (summer ? 120 : 60) * 60000);
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return {
      day: DAY_KEYS[(shifted.getUTCDay() + 6) % 7],   // DAY_KEYS starts Monday
      minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
      iso: shifted.getUTCFullYear() + '-' + pad(shifted.getUTCMonth() + 1) +
        '-' + pad(shifted.getUTCDate())
    };
  }

  /* --- opening, and the delivery shift ------------------------------------
     Two facts, and they are different shapes on purpose:

       the OPENING is a set of windows, per day — when the door is unlocked,
       and therefore when an order can be collected;
       the DELIVERY SHIFT is a single time — when a driver starts.

     Collection needs no window of its own: it runs for the whole opening, so
     giving it one would be a second copy of the same fact, free to drift.
     Delivery is the opening clipped at `deliveryFrom`, computed here and
     nowhere else, so the table, the badge, the basket and the WhatsApp message
     cannot each reach their own answer.
  ------------------------------------------------------------------------- */

  // The time a driver's shift starts. '' means a driver is out for the whole
  // opening, and every question below answers itself accordingly.
  function deliveryFrom() {
    var v = String((CFG.hours && CFG.hours.deliveryFrom) || '').trim();
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : '';
  }
  // Berlin's date, with the device's own as a fallback: a start date is only
  // ever compared against a calendar day, never against a clock time.
  // berlinNow() always answers now — with Intl where it works, by arithmetic
  // where it does not. There is deliberately no local-clock fallback here: the
  // restaurant's day is Berlin's day, wherever the guest happens to be reading.
  function todayISO() {
    return berlinNow().iso;
  }
  /* Every opening window of one day, with windows that TOUCH merged into one.
     11:00–18:00 followed by 18:00–23:00 is one opening typed into two boxes,
     and printing it as two closes the shop at 18:00 in the reader's head. */
  function slotsFor(dayKey) {
    var day = (CFG.hours.days || {})[dayKey];
    if (!day || day.closed) return [];
    var out = [];
    [day.lunch, day.evening].forEach(function (win) {
      if (!win) return;
      var last = out[out.length - 1];
      if (last && last.to === win[0]) last.to = win[1];
      else out.push({ from: win[0], to: win[1] });
    });
    return out;
  }

  /* The windows a driver goes out in: the opening, clipped to start no earlier
     than the delivery shift. A window ending before the shift starts drops out
     — that is the collection-only stretch of the day.

     `from` is the shift to clip against, and it is a parameter for one reason:
     the PUBLISHED table must be drawn from the standing time (this is what we
     do every week) while the basket asks about a particular moment, which may
     fall under a shift moved for today. Callers that draw the week pass
     nothing and get the standing answer; callers that ask "can we drive then"
     pass shiftFor(). */
  function deliverySlotsFor(dayKey, from) {
    if (from === undefined) from = deliveryFrom();
    var out = [];
    slotsFor(dayKey).forEach(function (s) {
      if (from && hhmm(from) >= hhmm(s.to)) return;
      out.push({ from: (from && hhmm(from) > hhmm(s.from)) ? from : s.from, to: s.to });
    });
    return out;
  }

  // Can we drive an order out at this exact moment? The question the basket
  // asks, and it is a comparison against a time — never against which named
  // window a moment happens to fall in.
  function deliversAt(iso, minutes) {
    var key = dayKeyFromISO(iso);
    if (!key) return false;
    // Today's driver if one was moved, the standing shift otherwise.
    var from = shiftFor(iso, minutes);
    // No driver at all today. Nothing else can make one appear — not an
    // extension, not an opening window — so this answers before either.
    if (from === null) return false;
    var hit = false;
    deliverySlotsFor(key, from).forEach(function (s) {
      if (minutes >= hhmm(s.from) && minutes <= hhmm(s.to)) hit = true;
    });
    /* Somebody who stays late to keep serving is also there to drive. The
       shift's START still applies — an extension at the end of the evening is
       always past it — so this only ever adds time, never brings delivery
       forward into the collection-only part of the day. */
    if (!hit && withinExtension(iso, minutes)) {
      hit = !from || minutes >= hhmm(from) || minutes < 6 * 60;
    }
    return hit;
  }

  /* --- a driver out at a different time today ------------------------------
     `hours.deliveryFrom` is when a driver goes out every week. Some days that
     is not when one actually goes out — somebody is free to drive at two, or
     nobody is free until nine — and neither is a reason to edit the week. So
     /admin can move TODAY's shift in either direction, and this is the one
     place anything asks which shift applies to a given moment.

     It is deliberately not folded into deliveryFrom(): that function answers
     "what do we do every week", which is what the hours table, the structured
     data and every printed sentence state, and what must not change because
     one afternoon had a driver in it.

     `from` has THREE answers and two of them are falsy, which is why every
     caller below tests `=== null` by name and never truthiness:

       null    — no driver at all today. Collection only.
       ''      — a driver out for the whole opening.
       'HH:MM' — a driver from that time.

     The week has only the last two: "we do not deliver" is not a fact about
     a restaurant that delivers, it is a fact about the Tuesday its driver was
     ill. Reading null as '' would turn "no driver" into "a driver all day",
     which is the worst answer this can give — it promises a car that does not
     exist. */
  function deliveryShiftToday() {
    var raw = (LIVE && LIVE.deliveryShift) || null;
    if (!raw) return null;
    var until = Date.parse(raw.until || '');
    if (!isFinite(until) || until <= Date.now()) return null;

    var u = berlinNow(new Date(until));
    if (!u) return null;
    var from = raw.from === null ? null : String(raw.from == null ? '' : raw.from).trim();
    // A stored time that is not a time is ignored rather than read as "all
    // day": guessing here would put a driver on the road that does not exist.
    if (from && !/^([01]\d|2[0-3]):[0-5]\d$/.test(from)) return null;
    return { from: from, untilStamp: stamp(u.iso, u.minutes) };
  }

  // The delivery shift in force at one moment: today's if it has been moved
  // and the moment falls before the move lapses, the standing one otherwise.
  // A guest scheduling for tomorrow evening therefore meets the ordinary rule.
  // May be null — see deliveryShiftToday: that is "no driver", not "no rule".
  function shiftFor(iso, minutes) {
    var today = deliveryShiftToday();
    if (today && stamp(iso, minutes) <= today.untilStamp) return today.from;
    return deliveryFrom();
  }

  /* --- scheduling ---------------------------------------------------------
     The guest may order at 02:00 for tomorrow lunch. None of these checks
     block: they set expectations and flag the message, the same contract the
     postcode check uses.
  ------------------------------------------------------------------------- */

  // 'YYYY-MM-DD' -> config day key, without touching the local timezone.
  function dayKeyFromISO(iso) {
    var p = String(iso).split('-');
    if (p.length !== 3) return null;
    var date = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    if (isNaN(date.getTime())) return null;
    return DAY_KEYS[(date.getUTCDay() + 6) % 7];
  }

  // Comparable ordinal for a wall-clock moment; both sides are Berlin time.
  function stamp(iso, minutes) {
    var p = String(iso).split('-');
    return Date.UTC(+p[0], +p[1] - 1, +p[2]) / 60000 + minutes;
  }

  // The service window covering a moment, or null. Which window it is decides
  // more than "are we open": a lunch window may be collection only.
  function slotAt(iso, minutes) {
    var key = dayKeyFromISO(iso);
    if (!key) return null;
    var hit = null;
    slotsFor(key).forEach(function (s) {
      if (minutes >= hhmm(s.from) && minutes <= hhmm(s.to)) hit = s;
    });
    /* An extended evening is a real window for everything that asks "can this
       be served" — the basket, the badge, the delivery check — and for nothing
       that asks "when are you open", which reads slotsFor() and never this. */
    if (!hit && withinExtension(iso, minutes)) {
      var ext = extensionWindow();
      hit = { from: '00:00', to: ext.untilLabel, extended: true };
    }
    return hit;
  }

  /* --- staying open later than the hours say ------------------------------
     The restaurant is still in the building. This makes "now" orderable past
     the fixed closing time WITHOUT touching the published hours: the table and
     the structured data state what happens every week, and a Saturday that ran
     late is not a new Saturday. It expires by being read against the clock.

     Compared in the same wall-clock space stamp() uses rather than against
     epoch milliseconds, because every other time on this page is a Berlin wall
     clock and mixing the two is how an hour goes missing twice a year. */
  function extensionWindow() {
    var raw = (LIVE && LIVE.extension) || null;
    if (!raw) return null;
    var until = Date.parse(raw.until || '');
    if (!isFinite(until) || until <= Date.now()) return null;

    var u = berlinNow(new Date(until));
    if (!u) return null;
    var fromAt = Date.parse(raw.from || '');
    var f = isFinite(fromAt) ? berlinNow(new Date(fromAt)) : null;
    return {
      fromStamp: f ? stamp(f.iso, f.minutes) : -Infinity,
      untilStamp: stamp(u.iso, u.minutes),
      untilLabel: pad2(Math.floor(u.minutes / 60)) + ':' + pad2(u.minutes % 60)
    };
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function withinExtension(iso, minutes) {
    var ext = extensionWindow();
    if (!ext) return false;
    var at = stamp(iso, minutes);
    return at >= ext.fromStamp && at <= ext.untilStamp;
  }

  function openAt(iso, minutes) {
    return !!slotAt(iso, minutes) || withinExtension(iso, minutes);
  }

  function isOpenNow() {
    var now = berlinNow();
    return !!now && openAt(now.iso, now.minutes);
  }

  // First service window at or after "now", searched a week ahead.
  function nextOpening() {
    var now = berlinNow();
    if (!now) return null;
    var L = t();
    for (var i = 0; i < 8; i++) {
      var key = DAY_KEYS[(DAY_KEYS.indexOf(now.day) + i) % 7];
      var slots = slotsFor(key);
      for (var j = 0; j < slots.length; j++) {
        if (i > 0 || hhmm(slots[j].from) > now.minutes) {
          return { day: key, from: slots[j].from, sameDay: i === 0, slot: slots[j],
                   // The calendar date of that opening, so a caller can ask
                   // whether we deliver then — a weekday name cannot be
                   // compared against a delivery shift on its own.
                   iso: addDays(now.iso, i),
                   label: (i === 0 ? '' : L.days[key] + ' ') + slots[j].from };
        }
      }
    }
    return null;
  }

  // 'YYYY-MM-DD' + n days, in UTC so no local timezone can shift the date.
  function addDays(iso, n) {
    var p = String(iso).split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // "11:00 – 23:00", or "11:00 – 14:30 & 18:00 – 23:00" across an afternoon
  // break. One function, so the pickup row and the delivery row are formatted
  // by the same rule and can be compared as strings to see if they differ.
  function spanOf(wins) {
    return wins.map(function (w) { return w.from + ' – ' + w.to; }).join(' & ');
  }

  function line(label, wins) {
    return '<span class="hslot">' +
      (label ? '<span class="hslot-label">' + label + '</span>' : '') +
      '<span class="hslot-time">' + spanOf(wins) + '</span></span>';
  }

  function renderHours() {
    var host = document.getElementById('hoursTable');
    if (!host) return;

    var L = t();
    var now = berlinNow();
    var html = '';

    DAY_KEYS.forEach(function (key) {
      var slots = slotsFor(key);
      var deliver = deliverySlotsFor(key);
      var isToday = now && now.day === key;
      var cells;

      if (!slots.length) {
        cells = '<span class="hclosed">' + L.closed + '</span>';
      } else {
        /* Labelled by SERVICE, and only when the two differ. A day whose driver
           is out for the whole opening has nothing to tell apart, so it gets
           one unlabelled range — a lone "Abholung" would raise the question of
           when delivery runs and then not answer it. */
        var split = spanOf(deliver) !== spanOf(slots);
        cells = '<span class="hslots">' + (split
          ? line(L.pickupLabel, slots) + (deliver.length ? line(L.deliveryLabel, deliver) : '')
          : line('', slots)) + '</span>';
      }

      html += '<div class="hrow' + (isToday ? ' today' : '') + '">' +
        '<span class="day">' + L.days[key] + (isToday ? ' <em>· ' + L.today + '</em>' : '') + '</span>' +
        cells + '</div>';
    });

    host.innerHTML = html;
    renderStatus(now);
    renderExtensionNote();
    updateSchemaHours();
  }

  /* Said beneath the hours, never inside them. The rows and the structured
     data state what happens every week; this states what is true tonight. */
  function renderExtensionNote() {
    var host = document.querySelector('.hours-extended');
    if (!host) return;
    var ext = extensionWindow();
    host.textContent = ext ? fill(t().openLater, { until: ext.untilLabel }) : '';
    host.hidden = !ext;

    renderDeliveryToday();
  }

  /* What is true today about the driver, printed with the OPEN/CLOSED badge
     rather than under the table. The badge cannot say this itself — a day
     nobody is driving is still a day we are open — and it is the line a guest
     reads before deciding to order, so a restriction that lives four lines
     below it is read after the delivery button has already been tapped.

     Silent when today's shift is the standing one: a note repeating the rule
     printed under the table reads as a contradiction the guest has to resolve.

     The restrictive case is marked so it can carry the weight of the badge
     beside it. The other two ADD a service and are said quietly; this one
     takes one away, and is the only line on the page that says so. */
  function renderDeliveryToday() {
    var host = document.querySelector('.hours-today');
    if (!host) return;
    var today = deliveryShiftToday();
    var L = t();
    var say = '';
    var limited = false;
    if (today && today.from !== deliveryFrom()) {
      // Three answers, three sentences. `null` first: it is the only one that
      // takes something away, and reading it as falsy would print "we deliver
      // all day" on the day there is nobody to drive.
      if (today.from === null) { say = L.deliveryTodayNone; limited = true; }
      else if (today.from) say = fill(L.deliveryToday, { from: today.from });
      else say = L.deliveryTodayAll;
    }
    host.className = 'hours-today' + (limited ? ' is-limited' : '');
    host.textContent = say;
    host.hidden = !say;
  }

  function renderStatus(now) {
    var host = document.getElementById('hoursStatus');
    if (!host) return;
    if (!now) { host.innerHTML = ''; return; }

    var L = t();
    /* Asked through slotAt so the badge agrees with the basket. Reading
       slotsFor() directly left the two able to disagree: on a night the
       restaurant had extended, the page said "closed" while the send button
       took the order. A badge that contradicts the button is worse than no
       badge — it is the one thing on the page a guest checks before ordering. */
    var open = slotAt(now.iso, now.minutes);
    if (open && now.minutes >= hhmm(open.to)) open = null;

    /* The till outranks the door, in both directions. A badge reading "open
       now" above a send button that refuses is the contradiction the comment
       above calls worse than no badge — and during a holiday the alternative
       branch is worse still, because "opens again Wednesday 11:00" names a day
       the restaurant is away. When ordering is off the badge says so and stops;
       when we are back is the next line down, in a whole sentence. */
    if (!orderingOpen()) {
      host.className = 'hours-status is-closed';
      host.innerHTML = '<span class="hours-dot"></span>' + L.ordersOffShort;
      return;
    }

    if (open) {
      host.className = 'hours-status is-open';
      host.innerHTML = '<span class="hours-dot"></span>' + L.openNow +
        ' <span class="hours-status-sub">· ' + L.until + ' ' + open.to + '</span>';
      return;
    }

    // Next window: the rest of today first, then the following days.
    var next = null;
    for (var i = 0; i < 8 && !next; i++) {
      var key = DAY_KEYS[(DAY_KEYS.indexOf(now.day) + i) % 7];
      var slots = slotsFor(key);
      for (var j = 0; j < slots.length; j++) {
        if (i > 0 || hhmm(slots[j].from) > now.minutes) {
          next = { day: key, slot: slots[j], sameDay: i === 0 };
          break;
        }
      }
    }

    host.className = 'hours-status is-closed';
    host.innerHTML = '<span class="hours-dot"></span>' + L.closedNow +
      (next ? ' <span class="hours-status-sub">· ' + L.opensAgain + ' ' +
        (next.sameDay ? '' : L.days[next.day] + ' ') + next.slot.from + '</span>' : '');
  }

  // Keep schema.org in step with the page. Google renders this page, so the
  // rewritten JSON-LD is what gets indexed; the static block in the HTML stays
  // as a valid fallback for crawlers that do not execute scripts.
  var schemaRating = null;

  function updateSchemaHours() {
    var node = document.getElementById('restaurantSchema');
    if (!node) return;
    try {
      var data = JSON.parse(node.textContent);

      var spec = [];
      DAY_KEYS.forEach(function (key) {
        slotsFor(key).forEach(function (s) {
          spec.push({
            '@type': 'OpeningHoursSpecification',
            dayOfWeek: SCHEMA_DAY[key],
            opens: s.from,
            closes: s.to
          });
        });
      });
      if (spec.length) data.openingHoursSpecification = spec;

      // Every town we deliver to, as a named place rather than a bare string.
      var cities = areaServedCities();
      if (cities.length) data.areaServed = cities;

      // The menu, read from the page so it cannot drift from what guests see.
      var menu = buildMenuSchema();
      if (menu) data.hasMenu = menu;

      // Payment methods from config rather than from this file's own literal:
      // PayPal must not appear here before it appears in the basket.
      var accepted = paymentAccepted();
      if (accepted) data.paymentAccepted = accepted;

      // Only ever the real Google figures, and only while they are on screen.
      if (schemaRating && schemaRating.count > 0) {
        data.aggregateRating = {
          '@type': 'AggregateRating',
          ratingValue: schemaRating.value,
          reviewCount: schemaRating.count,
          bestRating: 5,
          worstRating: 1
        };
      }

      node.textContent = JSON.stringify(data, null, 2);
    } catch (e) { /* malformed JSON-LD — leave the original untouched */ }
  }

  // The delivery towns, derived once from the zone list and shared by both
  // structured-data blocks: the Restaurant on the ordering page and the
  // catering Service on /firmencatering. Two derivations would be two chances
  // for the site to name different towns in different places.
  // A postcode covering two places ("Schwetzingen / Plankstadt") is filed
  // under the first, and a district suffix ("Heidelberg (Altstadt)") is
  // dropped: schema.org wants the town, not our delivery bookkeeping.
  function areaServedCities() {
    var zones = (CFG.delivery && CFG.delivery.zones) || [];
    var seen = {};
    return zones.map(function (row) {
      return String(row[1]).replace(/\s*\(.*\)$/, '').split(' / ')[0];
    }).filter(function (city) {
      if (seen[city]) return false;
      seen[city] = true;
      return true;
    }).map(function (city) {
      return { '@type': 'City', name: city };
    });
  }

  function buildMenuSchema() {
    var heads = document.querySelectorAll('.menu-section .cat-head');
    if (!heads.length) return null;

    var sections = [];
    [].forEach.call(heads, function (head) {
      var name = head.querySelector('.cat-name');
      var dishes = [];
      var node = head.nextElementSibling;
      while (node && !node.classList.contains('cat-head')) {
        if (node.classList.contains('mitem')) {
          var title = node.querySelector('.mname');
          var price = node.getAttribute('data-price');
          if (title) {
            var dish = { '@type': 'MenuItem', name: title.textContent.trim() };
            var desc = node.querySelector('.mdesc');
            if (desc) dish.description = desc.textContent.trim();
            if (price) {
              dish.offers = { '@type': 'Offer', price: price, priceCurrency: 'EUR' };
            }
            var tag = node.querySelector('.tag');
            if (tag) dish.suitableForDiet = /vegan/i.test(tag.textContent)
              ? 'https://schema.org/VeganDiet'
              : 'https://schema.org/VegetarianDiet';
            dishes.push(dish);
          }
        }
        node = node.nextElementSibling;
      }
      if (name && dishes.length) {
        sections.push({
          '@type': 'MenuSection',
          name: name.textContent.trim(),
          hasMenuItem: dishes
        });
      }
    });

    if (!sections.length) return null;
    return {
      '@type': 'Menu',
      name: { de: 'Speisekarte', en: 'Menu', ar: 'المنيو' }[lang()],
      url: 'https://kairo1980.de/#speisekarte',
      hasMenuSection: sections
    };
  }

  /* --- the corporate catering page ----------------------------------------
     /firmencatering is one business doing one named thing, so its Service node
     points at the Restaurant by @id instead of describing a second company at
     the same address — which is how a single restaurant ends up looking like
     two to a search engine.

     Everything the node says is read back off the page that carries it: the
     name and description from the heading and lead a visitor reads, the towns
     from the same zone list the basket prices with, the formats from the cards
     that describe them. Nothing is asserted that the page does not state — an
     offer invented in markup is the same violation as a rating nobody left.
  ------------------------------------------------------------------------- */
  function updateServiceSchema() {
    var node = document.getElementById('serviceSchema');
    if (!node) return;
    try {
      var data = JSON.parse(node.textContent);

      var name = document.getElementById('serviceName');
      var lead = document.getElementById('serviceDescription');
      if (name) data.name = flatten(name.textContent);
      if (lead) data.description = flatten(lead.textContent);
      data.inLanguage = lang();

      var cities = areaServedCities();
      if (cities.length) data.areaServed = cities;

      // Only the formats the page actually describes, in the words it uses.
      // Deliberately without prices: a corporate order is quoted per order, and
      // the page states no figure for one.
      var offers = [];
      [].forEach.call(document.querySelectorAll('.service-format'), function (el) {
        var title = el.querySelector('.service-format-name');
        if (!title) return;
        var offered = { '@type': 'Service', name: flatten(title.textContent) };
        var text = el.querySelector('.service-format-text');
        if (text) offered.description = flatten(text.textContent);
        offers.push({ '@type': 'Offer', itemOffered: offered });
      });
      if (offers.length) {
        data.hasOfferCatalog = {
          '@type': 'OfferCatalog', name: data.name, itemListElement: offers
        };
      } else {
        delete data.hasOfferCatalog;
      }

      node.textContent = JSON.stringify(data, null, 2);
    } catch (e) { /* malformed JSON-LD — leave the original untouched */ }
  }

  function flatten(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  /* =========================================================================
     Basket
     ========================================================================= */

  var items = {};   // id -> { el, price, node }
  var cart = {};    // id -> qty

  /* --- basket persistence -------------------------------------------------
     A basket is a short-lived intention, not a saved document. Remembering it
     forever is the behaviour a guest reads as a bug: they close the tab, come
     back next week and find an order they no longer want — priced at whatever
     the menu said back then. Remembering it for nothing is just as bad, since
     a reload, a phone call or a detour to the delivery-area list would empty
     it. So it is kept on a sliding window, set in config.js, and the clock
     restarts on every change.
  ------------------------------------------------------------------------- */

  function cartLifetimeMs() {
    var minutes = CFG.order.cartLifetimeMinutes;
    if (minutes === 0) return 0;                       // never remembered
    return (minutes > 0 ? minutes : 120) * 60000;      // unset -> 2 hours
  }

  function clearStoredCart() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* private mode */ }
  }

  function loadCart() {
    LEGACY_STORAGE_KEYS.forEach(function (key) {
      try { localStorage.removeItem(key); } catch (e) { /* private mode */ }
    });

    var lifetime = cartLifetimeMs();
    if (!lifetime) { clearStoredCart(); return; }

    try {
      var raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!raw || typeof raw !== 'object' || !raw.items) { clearStoredCart(); return; }

      // A negative age means the device clock moved backwards; that basket is
      // no more trustworthy than an expired one.
      var age = Date.now() - raw.savedAt;
      if (!(raw.savedAt > 0) || age < 0 || age > lifetime) { clearStoredCart(); return; }

      Object.keys(raw.items).forEach(function (id) {
        var qty = parseInt(raw.items[id], 10);
        if (items[id] && qty > 0) cart[id] = Math.min(qty, 99);
      });
    } catch (e) { clearStoredCart(); }
  }

  function saveCart() {
    if (!cartLifetimeMs() || !count()) { clearStoredCart(); return; }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        savedAt: Date.now(), items: cart
      }));
    } catch (e) { /* private mode */ }
  }

  /* The dish name, without the allergen letters.
     .mname carries a <sup> of allergen codes, so textContent alone yields
     "Baba Ghanougha,g,k" — which is what the kitchen would then read in the
     WhatsApp order and the guest would read in the basket. Only the text
     nodes belong to the name; the superscript is a footnote marker. */
  function itemName(id) {
    var node = items[id] && items[id].node;
    if (!node) return id;
    var name = '';
    [].forEach.call(node.childNodes, function (child) {
      if (child.nodeType === 3) name += child.nodeValue;
    });
    return (name || node.textContent).trim();
  }

  // Postcode -> zone. Advisory only: an unknown postcode is reported, never
  // used to refuse an order (see the rationale in config.js).
  function zoneFor(postcode) {
    var code = String(postcode || '').replace(/\D/g, '');
    if (code.length !== 5) return null;
    var rows = (CFG.delivery && CFG.delivery.zones) || [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][0] === code) {
        return { plz: rows[i][0], city: rows[i][1], km: rows[i][2], minOrder: rows[i][3], fee: rows[i][4] };
      }
    }
    return null;
  }

  /* --- the two delivery rules ---------------------------------------------
     Both are stated once in config.js and asked here by name, so that no
     screen has to re-derive them from a threshold and a checkbox. The server
     asks the same two questions of the same config in worker/pricing.js —
     it cannot trust the browser's answer, but it must never give a different
     one.
  ------------------------------------------------------------------------- */

  // Free delivery: one threshold, every order, company or private.
  function freeDeliveryQualifies(subtotal) {
    var from = (CFG.business || {}).freeDeliveryFrom;
    return from != null && subtotal >= from;
  }

  // The minimum order value is asked of a private order that has to be driven
  // out, and of nothing else.
  function minimumApplies(type, business) {
    var rule = (CFG.order && CFG.order.minimumOrder) || {};
    return business ? rule.business === true : rule[type] === true;
  }

  function totals() {
    var subtotal = 0;
    Object.keys(cart).forEach(function (id) {
      if (items[id]) subtotal += items[id].price * cart[id];
    });
    // Company + collected in person earns the better rate; everything else
    // gets the standard direct-order discount.
    var pct = (form.business && form.type === 'pickup' &&
               CFG.order.businessPickupDiscountPercent != null)
      ? CFG.order.businessPickupDiscountPercent
      : (CFG.order.directDiscountPercent || 0);
    var discount = Math.round(subtotal * pct) / 100;

    // The delivery fee sits OUTSIDE the discount: the 10 % is a discount on
    // food, not on driving. It is waived once the food subtotal reaches the
    // threshold, for every order alike. An unknown zone charges nothing here;
    // that fee is agreed in the chat rather than guessed by the page.
    var zone = form.type === 'delivery' ? zoneFor(draft.fPlz) : null;
    var qualifies = freeDeliveryQualifies(subtotal);
    var fee = (zone && !qualifies) ? zone.fee : 0;

    return {
      subtotal: subtotal,
      discount: discount,
      discountPercent: pct,
      fee: fee,
      zone: zone,
      // Answered once, here, so the basket, the send button and the WhatsApp
      // message cannot each reach their own verdict about the same order.
      freeDelivery: qualifies,
      // The fee this postcode would have charged had the order not reached
      // the threshold — what "you have just saved" is measured against.
      feeWaived: (zone && qualifies) ? zone.fee : 0,
      minimumApplies: !!(zone && minimumApplies(form.type, form.business)),
      belowMinimum: !!(zone && minimumApplies(form.type, form.business) &&
                       subtotal < zone.minOrder),
      total: subtotal - discount + fee
    };
  }

  function count() {
    return Object.keys(cart).reduce(function (n, id) { return n + cart[id]; }, 0);
  }

  /* A basket lives for two hours and the kitchen can run out inside that. A
     guest who added Koshari before it went off must not carry it to a checkout
     that will refuse it — the server prices this order and would reject the
     whole basket, so the dish is dropped here and the guest is told which one
     and why. Silence would look like a bug in the total. */
  /* Said once, where the guest is already looking. Deliberately not an alert():
     a modal on load is the kind of thing people dismiss without reading, and
     this has to be read — the total changed. */
  function notifySoldOut(names) {
    var host = document.getElementById('cartSoldOutNote');
    if (!host) return;
    host.textContent = names
      .map(function (n) { return fill(t().soldOutRemoved, { dish: n }); })
      .join(' ');
    host.hidden = false;
  }

  function dropSoldOut() {
    var dropped = [];
    Object.keys(cart).forEach(function (id) {
      if (soldOut(id)) {
        dropped.push(itemName(id));
        delete cart[id];
      }
    });
    if (dropped.length) saveCart();
    return dropped;
  }

  function setQty(id, qty) {
    /* The single gate. Every path that adds a dish comes through here — the
       menu "+", the basket "+", a restored basket — so a dish that has run out
       cannot be added by any of them, including a button left on screen from
       before the kitchen flipped it. */
    if (qty > 0 && soldOut(id)) return;
    if (qty <= 0) delete cart[id];
    else cart[id] = Math.min(qty, 99);
    saveCart();
    paint();
    bumpFab();
  }

  // The steam rises once whenever the basket changes: on a long menu the
  // button sits far from the dish that was just tapped, and a change with no
  // acknowledgement reads as a tap that did not register.
  var bumpTimer = null;
  function bumpFab() {
    if (!els.fab || els.fab.hidden) return;
    els.fab.classList.remove('is-bumped');
    void els.fab.offsetWidth;                 // restart the animation
    els.fab.classList.add('is-bumped');
    clearTimeout(bumpTimer);
    bumpTimer = setTimeout(function () {
      if (els.fab) els.fab.classList.remove('is-bumped');
    }, 1200);
  }

  /* --- menu wiring ------------------------------------------------------- */

  function collectItems() {
    [].forEach.call(document.querySelectorAll('.mitem[data-item]'), function (el) {
      var id = el.getAttribute('data-item');
      var price = parseFloat(el.getAttribute('data-price'));
      var name = el.querySelector('.mname');
      if (!id || isNaN(price) || !name) return;
      items[id] = { el: el, price: price, node: name };

      // The buy control is injected rather than written into the markup, so a
      // new dish only needs its data attributes to become orderable.
      var priceEl = el.querySelector('.mprice');
      if (!priceEl) return;
      var buy = document.createElement('div');
      buy.className = 'mbuy';
      priceEl.parentNode.insertBefore(buy, priceEl);
      buy.appendChild(priceEl);

      var stepper = document.createElement('div');
      stepper.className = 'qty';
      stepper.setAttribute('data-for', id);
      buy.appendChild(stepper);
    });
  }

  /* --- allergens ----------------------------------------------------------
     LMIV (EU) 1169/2011 requires the declarable allergens to be given for
     non-prepacked food, and for distance selling they must be available BEFORE
     the order is placed — not on request afterwards. So they are rendered onto
     the dish itself, where a guest reads the price.

     The declaration lives on the .mitem in index.html, exactly like the price
     and the diet tags: one place, edited by whoever edits the menu, nothing to
     keep in sync. Only the four that actually occur in these recipes have
     labels; a fifth is one word in three dictionaries.

     Where a manufacturer's declaration is not in hand the dish says so rather
     than guessing. An invented allergen line is worse than none — it is the
     one field on this site where being wrong can put somebody in hospital.
  ------------------------------------------------------------------------- */

  /* The letters are the German trade convention, and they are not arbitrary:
     a = Glutenhaltiges Getreide, g = Milch, h = Schalenfrüchte, k = Sesam,
     in the order LMIV Annex II lists them. Every printed menu in the country
     uses them, which is exactly why they work — a guest with an allergy knows
     to look for the legend without being told.

     Deliberately NOT behind a click. For distance selling the information has
     to be available BEFORE the order, and something a guest must first
     discover, then open, is an argument waiting to happen. Small type on the
     page satisfies the law; a popup invites a lawyer. */
  var ALLERGEN_CODE = { gluten: 'a', milk: 'g', nuts: 'h', sesame: 'k' };
  var CODE_ORDER = ['a', 'g', 'h', 'k'];

  function renderAllergens() {
    var L = t();
    var used = {};
    var anyPending = false;
    var anyCaffeine = false;

    [].forEach.call(document.querySelectorAll('.mitem[data-item]'), function (el) {
      var declared = (el.getAttribute('data-allergens') || '').trim();
      var name = el.querySelector('.mname');
      if (!name) return;

      var mark = name.querySelector('.mallergen-codes');
      if (!mark) {
        mark = document.createElement('sup');
        mark.className = 'mallergen-codes';
        name.appendChild(mark);
      }

      if (declared === 'pending') {
        anyPending = true;
        mark.textContent = '*';
        mark.setAttribute('aria-label', L.allergenPending);
        mark.title = L.allergenPending;
      } else if (!declared) {
        // Nothing to declare: no mark, and no clutter.
        mark.textContent = '';
        mark.removeAttribute('aria-label');
        mark.removeAttribute('title');
      } else {
        var codes = declared.split(/\s+/).map(function (key) {
          return ALLERGEN_CODE[key];
        }).filter(Boolean).sort();
        codes.forEach(function (c) { used[c] = true; });
        mark.textContent = codes.join(',');
        // The letters are shorthand; screen readers and hovers get the words.
        var words = declared.split(/\s+/).map(function (key) {
          return L.allergen[key] || key;
        }).join(', ');
        mark.setAttribute('aria-label', L.allergenLabel + ': ' + words);
        mark.title = L.allergenLabel + ': ' + words;
      }

      if (el.getAttribute('data-caffeine')) anyCaffeine = true;
      renderCaffeine(el, L);
    });

    renderLegend(L, used, anyPending, anyCaffeine);
  }

  // The caffeine wording is prescribed by law and belongs on the drink itself,
  // not folded into a legend with everything else.
  function renderCaffeine(el, L) {
    if (!el.getAttribute('data-caffeine')) return;
    var host = el.querySelector('.mcaffeine');
    if (!host) {
      host = document.createElement('p');
      host.className = 'mcaffeine';
      var anchor = el.querySelector('.mtags') || el.querySelector('.mdesc') || el.querySelector('.mname');
      if (anchor && anchor.parentNode) anchor.parentNode.appendChild(host);
    }
    if (host) host.textContent = L.caffeineNotice;
  }

  function renderLegend(L, used, anyPending, anyCaffeine) {
    var section = document.querySelector('#speisekarte .menu-section');
    if (!section) return;
    var host = document.getElementById('allergenLegend');
    if (!host) {
      host = document.createElement('div');
      host.className = 'menu-allergen-legend';
      host.id = 'allergenLegend';
      section.appendChild(host);
    }

    var parts = CODE_ORDER.filter(function (c) { return used[c]; }).map(function (code) {
      var key = Object.keys(ALLERGEN_CODE).filter(function (k) {
        return ALLERGEN_CODE[k] === code;
      })[0];
      return '<span class="legend-item"><b>' + code + '</b> ' +
        escapeHtml(L.allergen[key] || key) + '</span>';
    });
    if (anyPending) {
      parts.push('<span class="legend-item"><b>*</b> ' + escapeHtml(L.allergenPending) + '</span>');
    }

    host.innerHTML =
      '<h3 class="legend-title">' + escapeHtml(L.allergenLegendTitle) + '</h3>' +
      '<div class="legend-items">' + parts.join('') + '</div>' +
      '<p class="legend-note">' + escapeHtml(L.allergenLegendNote) + '</p>';
  }

  function paintMenu() {
    var L = t();
    Object.keys(items).forEach(function (id) {
      items[id].el.classList.toggle('is-soldout', soldOut(id));
      var box = items[id].el.querySelector('.qty[data-for="' + id + '"]');
      if (!box) return;
      var qty = cart[id] || 0;
      if (qty > 0) {
        box.className = 'qty has-qty';
        box.innerHTML =
          '<button type="button" class="qty-btn" data-act="dec" data-id="' + id + '" aria-label="−">−</button>' +
          '<span class="qty-num">' + qty + '</span>' +
          '<button type="button" class="qty-btn" data-act="inc" data-id="' + id + '" aria-label="+">+</button>';
      } else if (soldOut(id)) {
        /* No disabled "+" here. A button that is present and refuses reads as a
           broken page; the words say what is true and there is nothing to
           press. This is the one place the site withholds an order outright —
           see the note in worker/admin/dishes.js. */
        box.className = 'qty is-soldout';
        box.innerHTML = '<span class="soldout-tag">' + escapeHtml(L.soldOut) + '</span>';
      } else {
        box.className = 'qty';
        box.innerHTML = '<button type="button" class="qty-add" data-act="inc" data-id="' + id + '" ' +
          'aria-label="' + L.add + ': ' + itemName(id) + '">+</button>';
      }
    });
  }

  /* --- panel ------------------------------------------------------------- */

  // A supermarket trolley is the wrong metaphor for a restaurant: nobody
  // wheels a trolley through a kitchen. This is a cloche — the domed cover a
  // plate travels under — drawn in the same hairline weight as the rest of the
  // page, with three wisps of steam that rise every time the basket changes.
  //
  // The dome alone read as a notification bell, which is the shape it shares.
  // What separates them is the plate: the platter runs WIDER than the dome on
  // both sides and closes underneath with a shallow curve, so the silhouette
  // is a covered dish seen from the side. A bell has neither the overhang nor
  // the base — it flares open at the bottom. The knob sits directly on the
  // dome rather than on a stem, which is the other half of the difference: a
  // bell hangs from a loop above it.
  var CART_ICON =
    '<svg class="cart-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">' +
      '<g fill="none" stroke="currentColor" stroke-width="1.4" ' +
         'stroke-linecap="round" stroke-linejoin="round">' +
        '<g class="cart-icon-steam">' +
          '<path d="M8.7 7.4c1-.9.3-2.1 0-2.8"/>' +
          '<path d="M12 6.6c1-.9.3-2.1 0-2.8"/>' +
          '<path d="M15.3 7.4c1-.9.3-2.1 0-2.8"/>' +
        '</g>' +
        // The lid is its own group so it can lift off the plate when a dish is
        // added. The plate below stays put, which is what makes the movement
        // read as a lid rather than as the whole icon jiggling.
        '<g class="cart-icon-lid">' +
          '<circle cx="12" cy="10.55" r="0.85"/>' +
          '<path d="M5 18.4a7 7 0 0 1 14 0"/>' +
        '</g>' +
        '<path d="M2.4 18.4h19.2"/>' +
        '<path d="M4.6 18.4c.5 1.8 3.4 2.9 7.4 2.9s6.9-1.1 7.4-2.9"/>' +
      '</g>' +
    '</svg>';

  var els = {};

  function buildPanel() {
    var wrap = document.createElement('div');
    wrap.innerHTML =
      '<button type="button" class="cart-fab" id="cartFab" hidden>' +
        '<span class="cart-fab-icon">' + CART_ICON + '</span>' +
        '<span class="cart-fab-count" id="cartFabCount">0</span>' +
        '<span class="cart-fab-total" id="cartFabTotal"></span>' +
      '</button>' +
      '<div class="cart-backdrop" id="cartBackdrop" hidden></div>' +
      '<aside class="cart-panel" id="cartPanel" role="dialog" aria-modal="true" aria-labelledby="cartHeading" hidden>' +
        '<header class="cart-head">' +
          '<h2 class="cart-heading" id="cartHeading"></h2>' +
          '<button type="button" class="cart-close" id="cartClose" aria-label="×">×</button>' +
        '</header>' +
        // Sits above the basket contents because it explains why they changed.
        '<p class="cart-soldout-note" id="cartSoldOutNote" hidden></p>' +
        '<div class="cart-body" id="cartBody"></div>' +
      '</aside>';
    while (wrap.firstChild) document.body.appendChild(wrap.firstChild);

    els.fab = document.getElementById('cartFab');
    els.fabCount = document.getElementById('cartFabCount');
    els.fabTotal = document.getElementById('cartFabTotal');
    els.backdrop = document.getElementById('cartBackdrop');
    els.panel = document.getElementById('cartPanel');
    els.heading = document.getElementById('cartHeading');
    els.body = document.getElementById('cartBody');

    // Populated up front: an empty heading would otherwise sit in the
    // document outline that crawlers and screen readers walk.
    els.heading.textContent = t().cart;

    els.fab.addEventListener('click', function () { openPanel(); });
    els.backdrop.addEventListener('click', closePanel);
    document.getElementById('cartClose').addEventListener('click', closePanel);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !els.panel.hidden) closePanel();
      trapFocus(e);
    });
  }

  var lastFocused = null;

  function openPanel() {
    // Outside opening hours "as soon as possible" is meaningless, so the panel
    // opens on the scheduling tab. Only ever pre-selected, never forced.
    if (!isOpenNow() && !draft.fDate && form.when === 'asap') form.when = 'scheduled';
    // First time the basket is opened is the right moment to find out what
    // can be paid: early enough to draw the choice, late enough that a visitor
    // who never orders never pays for the request.
    ensurePayConfig();
    lastFocused = document.activeElement;
    els.panel.hidden = false;
    els.backdrop.hidden = false;
    document.body.classList.add('cart-open');
    paintPanel();
    var first = els.panel.querySelector('input, button');
    if (first) first.focus({ preventScroll: true });
  }

  function closePanel() {
    els.panel.hidden = true;
    els.backdrop.hidden = true;
    document.body.classList.remove('cart-open');
    // Send focus back where it came from, so a keyboard user is not dropped
    // at the top of the document after closing the drawer.
    if (lastFocused && document.contains(lastFocused)) {
      lastFocused.focus({ preventScroll: true });
    }
    lastFocused = null;
  }

  // The panel is aria-modal, so focus must not escape it while it is open.
  function trapFocus(e) {
    if (e.key !== 'Tab' || els.panel.hidden) return;
    var focusable = els.panel.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])');
    var open = [].filter.call(focusable, function (el) {
      return el.offsetParent !== null || el === document.activeElement;
    });
    if (!open.length) return;
    var first = open[0], last = open[open.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function field(id, label, type, placeholder, required) {
    return '<label class="cart-field">' +
      '<span class="cart-label">' + label + (required ? ' *' : '') + '</span>' +
      (type === 'textarea'
        ? '<textarea id="' + id + '" rows="2" placeholder="' + placeholder + '"></textarea>'
        : '<input id="' + id + '" type="' + type + '" placeholder="' + placeholder + '"' +
          (required ? ' required' : '') + '>') +
      '</label>';
  }

  // `when` starts as 'asap', but the panel switches it to 'scheduled' the
  // first time it opens while the kitchen is closed — a 2 a.m. "as soon as
  // possible" is never what the guest means.
  // `pay` starts at 'onsite': cash is the one method that is always possible,
  // so a guest who ignores the choice cannot end up with an order that expects
  // a payment they never made.
  var form = { type: 'delivery', business: false, when: 'asap', pay: 'onsite' };

  /* --- delivery or pickup -------------------------------------------------
     The MOMENT an order will actually be served at decides whether delivery is
     on offer, and it is compared against the delivery shift
     (config.js -> hours.deliveryFrom). Not against which window it falls in:
     an opening that runs straight through has one window covering both a time
     we can drive out at and a time we cannot.
  ----------------------------------------------------------------------- */

  // The moment this order lands at, or null when it cannot be known — a time
  // outside every window is settled in the chat, and nothing is assumed here.
  function targetMoment() {
    if (form.when === 'scheduled') {
      if (!draft.fDate || !draft.fTime) return null;
      return { iso: draft.fDate, minutes: hhmm(draft.fTime) };
    }
    // "As soon as possible" means now if we are open, and the next opening if
    // we are not — the same promise warnClosedAsap makes to the guest.
    var now = berlinNow();
    if (!now) return null;
    if (slotAt(now.iso, now.minutes)) return { iso: now.iso, minutes: now.minutes };
    var next = nextOpening();
    return next ? { iso: next.iso, minutes: hhmm(next.from) } : null;
  }

  // The single exception to "validation never blocks": it withholds an OPTION,
  // never the order. Pickup at midday and delivery in the evening are both one
  // tap away, and the note under the buttons says which — nobody is left
  // guessing why the button is dim, and nobody can order a driver we cannot
  // send. Promising a lunchtime delivery we then have to cancel by phone costs
  // far more than a clearly labelled disabled button.
  function deliveryBlocked() {
    var at = targetMoment();
    // A moment we cannot place is never blocked: an unknown time is settled in
    // the chat, and withholding the button on a guess is the one thing this
    // check must not do.
    if (!at) return false;
    /* Asked of the shift in force AT THAT MOMENT, not of the standing one: a
       day whose driver is out from opening has nothing to withhold, and a day
       whose driver starts late withholds it even when the week says otherwise.
       Tested by name, because null and '' are both falsy and mean opposites. */
    var from = shiftFor(at.iso, at.minutes);
    if (from === null) return true;    // no driver today — collection only
    if (!from) return false;           // a driver out for the whole opening
    return !deliversAt(at.iso, at.minutes);
  }

  function fill(template, values) {
    return String(template).replace(/\{(\w+)\}/g, function (whole, key) {
      return values[key] !== undefined ? values[key] : whole;
    });
  }

  // Structured pick-a-time control. Native date/time inputs give every phone
  // its own familiar picker for free — no library, and no free-text "asap-ish"
  // strings that have to be deciphered in the chat.
  function whenHtml() {
    var L = t();
    var now = berlinNow();
    var scheduled = form.when === 'scheduled';
    return '<fieldset class="cart-when">' +
      '<legend class="cart-label">' + L.when + '</legend>' +
      '<div class="cart-types">' +
        '<button type="button" class="cart-type' + (scheduled ? '' : ' active') +
          '" data-when="asap">' + L.asap + '</button>' +
        '<button type="button" class="cart-type' + (scheduled ? ' active' : '') +
          '" data-when="scheduled">' + L.scheduled + '</button>' +
      '</div>' +
      '<div class="cart-when-fields" id="fWhenFields"' + (scheduled ? '' : ' hidden') + '>' +
        '<label class="cart-field"><span class="cart-label">' + L.dateLabel + '</span>' +
          '<input id="fDate" type="date"' + (now ? ' min="' + now.iso + '"' : '') + '></label>' +
        '<label class="cart-field"><span class="cart-label">' + L.timeLabel + '</span>' +
          '<input id="fTime" type="time" step="300"></label>' +
      '</div>' +
      '<div class="cart-warn" id="cartWhenHint"></div>' +
      '</fieldset>';
  }

  // Everything wrong with the chosen moment, in the guest's language. Advisory.
  function whenWarnings() {
    var L = t();
    var out = [];
    var now = berlinNow();
    if (!now) return out;

    if (form.when !== 'scheduled') {
      if (!isOpenNow()) {
        var next = nextOpening();
        out.push({ kind: 'closed', text: fill(L.warnClosedAsap, { next: next ? next.label : '—' }) });
      }
      return out;
    }

    var iso = draft.fDate, time = draft.fTime;
    if (!iso || !time) return out;

    var minutes = hhmm(time);
    var target = stamp(iso, minutes);
    var current = stamp(now.iso, now.minutes);

    if (target < current) {
      out.push({ kind: 'past', text: L.warnPastTime });
      return out;
    }
    if (!openAt(iso, minutes)) {
      out.push({ kind: 'hours', text: L.warnOutsideHours });
    } else if (form.type === 'delivery' && !deliversAt(iso, minutes)) {
      // Open, but before a driver goes out. Not "we are closed" — the guest has
      // picked a time we can serve, just not in the way they asked for — so the
      // note names the alternative rather than the refusal.
      // The time named is the one that would actually work for the day the
      // guest picked — today's moved shift, or the standing one. When there is
      // no driver at all, no time works and the note says so instead of
      // sending the guest to hunt for one.
      var when = shiftFor(iso, minutes);
      out.push({ kind: 'hours', text: when === null
        ? L.cartPickupOnlyToday
        : fill(L.cartDeliveryLater, { from: when }) });
    }
    var lead = (CFG.business && CFG.business.leadTimeHours) || 0;
    if (form.business && lead && target - current < lead * 60) {
      out.push({ kind: 'lead', text: fill(L.warnLeadTime, { h: lead }) });
    }
    return out;
  }

  function paintWhen() {
    var host = document.getElementById('cartWhenHint');
    if (!host) return;
    var warnings = whenWarnings();
    // Its own class: this warns about the time, not about the delivery zone,
    // and reusing 'is-below-min' for "outside opening hours" made both harder
    // to read and impossible to target on their own.
    host.className = 'cart-warn' + (warnings.length ? ' is-active' : '');
    host.textContent = warnings.map(function (w) { return w.text; }).join(' ');
  }

  // Human-readable version of the chosen moment, for the WhatsApp message.
  function whenText() {
    var L = t();
    if (form.when !== 'scheduled' || !draft.fDate || !draft.fTime) return L.asap;
    var p = String(draft.fDate).split('-');
    return p[2] + '.' + p[1] + '.' + p[0] + ', ' + draft.fTime;
  }

  function sumsHtml(sums) {
    var L = t();
    return '<div class="cart-sum"><span>' + L.subtotal + '</span><span>' + money(sums.subtotal) + '</span></div>' +
      (sums.discount > 0
        ? '<div class="cart-sum is-discount"><span>' + L.discount + ' −' + sums.discountPercent +
          ' %</span><span>−' + money(sums.discount) + '</span></div>'
        : '') +
      (form.type === 'delivery' && sums.zone
        ? '<div class="cart-sum"><span>' + L.deliveryFee + '</span><span>' + money(sums.fee) + '</span></div>'
        : '') +
      '<div class="cart-sum is-total"><span>' + L.total + '</span><span>' + money(sums.total) + '</span></div>';
  }

  // Live feedback while the postcode is typed. Never disables the send button:
  // the guest is informed, the restaurant decides.
  // True once a full postcode has been typed that we do not deliver to. The
  // whole flow then relabels itself as an enquiry, so nobody can believe they
  // placed an order we never agreed to.
  function isOutsideArea() {
    if (form.type !== 'delivery') return false;
    var typed = String(draft.fPlz || '').replace(/\D/g, '');
    return typed.length === 5 && !zoneFor(typed);
  }

  function paintSendButton() {
    var btn = document.getElementById('cartSend');
    if (!btn) return;
    var L = t();
    var outside = isOutsideArea();

    /* § 312j Abs. 3 BGB: where an electronically concluded consumer contract
       obliges payment, the button must say so unambiguously — the wording the
       statute names is "zahlungspflichtig bestellen".

       It applies to one of the two routes out of this form. Paying on arrival
       prepares a WhatsApp message and nothing more; the contract forms when we
       answer in the chat, and the button says what it does. Paying online
       moves money on this page, before anyone has confirmed anything — so
       there the obligation is entered here, and the button has to say that.

       An out-of-area enquiry has no agreed price and obliges nobody, so it
       keeps its own wording whatever was chosen. */
    var obliges = !outside && form.pay === 'online' && onlinePayEnabled();

    btn.textContent = outside ? L.sendRequest : (obliges ? L.orderLiable : L.send);
    btn.classList.toggle('is-request', outside);

    /* The button's state belongs to the one function that owns the button.
       renderOrdering() sets this too, but the panel is rebuilt on every
       repaint and on every open — and a button rebuilt after that call came
       back enabled with the notice above it still saying we are closed. One
       owner, applied wherever the button is drawn. */
    var blocked = orderingBlocksChoice();
    btn.disabled = blocked;
    var note = document.getElementById('cartOrderOff');
    if (note) {
      note.textContent = blocked ? orderingNotice() : '';
      note.hidden = !blocked;
    }
  }

  function paintZone() {
    var host = document.getElementById('cartZoneHint');
    paintSendButton();
    if (!host) return;
    var L = t();
    var sums = totals();
    var zone = sums.zone;
    var typed = String(draft.fPlz || '').replace(/\D/g, '');

    if (typed.length < 5) { host.className = 'cart-zone'; host.textContent = ''; return; }

    if (!zone) {
      host.className = 'cart-zone is-unknown';
      host.textContent = L.zoneUnknown;
      return;
    }

    /* Free delivery is now every guest's, so this is where they find out.
       Three different things can be true and they must not be confused:
         - this postcode is free anyway (Hockenheim and its neighbours),
         - the fee has been waived because the order reached the threshold,
         - a fee applies, and it is worth saying how much is missing.
       Saying "free delivery" for the first case would promise a discount the
       guest never earned; saying nothing for the second hides one they did. */
    var from = (CFG.business || {}).freeDeliveryFrom;
    var parts = [];

    if (sums.fee > 0) {
      parts.push(fill(L.zoneFee, { city: zone.city, fee: money(sums.fee) }));
      if (from != null) {
        parts.push(fill(L.zoneToFree, { missing: money(from - sums.subtotal) }));
      }
    } else if (sums.feeWaived > 0) {
      parts.push(fill(L.zoneFreeReached, { city: zone.city, saved: money(sums.feeWaived) }));
    } else {
      parts.push(fill(L.zoneOk, { city: zone.city }));
    }

    if (sums.belowMinimum) {
      parts.push(fill(L.zoneBelowMin, {
        missing: money(zone.minOrder - sums.subtotal), city: zone.city, min: zone.minOrder
      }));
      host.className = 'cart-zone is-below-min';
    } else {
      host.className = 'cart-zone is-ok';
    }
    host.textContent = parts.join(' ');
  }

  function paintSums() {
    var box = document.getElementById('cartSums');
    if (box) box.innerHTML = sumsHtml(totals());
    paintZone();
  }

  // A form still saying "delivery" while delivery is impossible would put the
  // wrong word in the WhatsApp message and a delivery fee in the total, so the
  // choice is corrected in one place, before anything is calculated from it.
  function syncType() {
    if (form.type === 'delivery' && deliveryBlocked()) form.type = 'pickup';
  }

  function typesHtml() {
    var L = t();
    syncType();
    var blocked = deliveryBlocked();
    // Named from the moment the order would land at, so the note tells the
    // guest the time that would actually get them a driver — or says there is
    // no time at all today, which naming one would be a lie about.
    var at = blocked ? targetMoment() : null;
    var deliversFrom = at ? shiftFor(at.iso, at.minutes) : deliveryFrom();
    var noteText = deliversFrom === null
      ? L.cartPickupOnlyToday
      : fill(L.cartDeliveryLater, { from: deliversFrom });

    return '<div class="cart-types" role="group" aria-label="' + L.type + '">' +
      '<button type="button" class="cart-type' +
        (form.type === 'delivery' ? ' active' : '') + (blocked ? ' is-off' : '') + '"' +
        (blocked ? ' disabled aria-describedby="cartTypeNote"' : '') +
        ' data-type="delivery">' + L.delivery + '</button>' +
      '<button type="button" class="cart-type' + (form.type === 'pickup' ? ' active' : '') +
        '" data-type="pickup">' + L.pickup + '</button>' +
      '</div>' +
      '<p class="cart-note is-pickup-only" id="cartTypeNote"' + (blocked ? '' : ' hidden') + '>' +
        (blocked ? escapeHtml(noteText) : '') +
      '</p>' +
      payHtml();
  }

  /* --- paying -------------------------------------------------------------
     The choice is made in the basket, not after it: "can I pay by card?"
     decides whether a guest orders at all, and the answer has to travel with
     the order so the kitchen knows whether to expect a PayPal payment, get the
     terminal ready, or send the driver out for cash.

     PayPal is a link to paypal.com carrying the exact amount — no card data,
     no third-party script and no cookie ever touches this site, which is what
     keeps the strict CSP and the consent-free privacy policy intact. What it
     cannot do is tell the page whether the money arrived: the amount in a
     PayPal.Me link is editable by the payer, so the total received must be
     checked in the PayPal app against the WhatsApp order before the food goes
     out. That check is the reason the confirmation screen calls the payment
     optional rather than final.
  ------------------------------------------------------------------------- */

  // There are exactly two decisions a guest can make on this website: pay now,
  // online, or pay when they get the food. Card and girocard are NOT on this
  // list — they are what the terminal in the shop accepts, not something this
  // page can offer, so they are stated as information under the buttons. A
  // button for a method the website cannot process would be a promise made by
  // the wrong party.
  function payChoosable() {
    return onlinePayEnabled();
  }

  // Only 'online' is ever stored; anything else means "in person".
  function syncPay() {
    if (form.pay === 'online' && !onlinePayEnabled()) form.pay = 'onsite';
  }

  function payChosenText() {
    var L = t();
    if (form.pay === 'online') {
      return fill(L.payOnlineHint, { total: money(totals().total) });
    }
    return payOnSiteText(form.type);
  }

  function payHtml() {
    var L = t();
    syncPay();

    // Without PayPal there is no choice to make, only a fact to state.
    if (!payChoosable()) {
      return '<p class="cart-pay">' + escapeHtml(payOnSiteText(form.type)) + '</p>';
    }

    var online = form.pay === 'online';
    return '<fieldset class="cart-pay-pick">' +
      '<legend class="cart-label">' + L.payMethod + '</legend>' +
      '<div class="cart-types" role="group" aria-label="' + L.payMethod + '">' +
        '<button type="button" class="cart-type' + (online ? ' active' : '') +
          '" data-pay="online">' + L.payOptionOnline + '</button>' +
        '<button type="button" class="cart-type' + (online ? '' : ' active') +
          '" data-pay="onsite">' + L.payOptionOnSite + '</button>' +
      '</div>' +
      '<p class="cart-pay">' + escapeHtml(payChosenText()) + '</p>' +
      // The one sentence a first-time guest wants before typing a card number.
      // Only shown where it is relevant, so it reads as a fact and not a slogan.
      (online ? '<p class="cart-pay-trust">' + escapeHtml(L.paySecure) + '</p>' : '') +
      '</fieldset>';
  }

  // Repaints only the delivery/pickup control. The chosen time turns delivery
  // on and off, and a full repaint while the guest is inside the time picker
  // would take the focus with it.
  function paintTypes() {
    var box = document.getElementById('cartTypeBox');
    if (!box) return;
    box.innerHTML = typesHtml();
    var addr = document.getElementById('fAddressWrap');
    if (addr) addr.hidden = form.type !== 'delivery';
    paintSums();
  }

  function paintPanel() {
    if (!els.body || els.panel.hidden) return;
    var L = t();
    els.heading.textContent = L.cart;

    var ids = Object.keys(cart);
    if (!ids.length) {
      els.body.innerHTML = '<div class="cart-empty"><span class="cart-empty-icon">' +
        CART_ICON + '</span><p>' + L.cartEmpty + '</p><p class="cart-empty-hint">' +
        L.cartEmptyHint + '</p></div>';
      return;
    }

    syncType();
    var sums = totals();
    var lines = ids.map(function (id) {
      return '<li class="cart-line">' +
        '<span class="cart-line-name">' + escapeHtml(itemName(id)) + '</span>' +
        '<span class="qty has-qty cart-line-qty">' +
          '<button type="button" class="qty-btn" data-act="dec" data-id="' + id + '" aria-label="−">−</button>' +
          '<span class="qty-num">' + cart[id] + '</span>' +
          '<button type="button" class="qty-btn" data-act="inc" data-id="' + id + '" aria-label="+">+</button>' +
        '</span>' +
        '<span class="cart-line-price">' + money(items[id].price * cart[id]) + '</span>' +
        '</li>';
    }).join('');

    var leadNote = (CFG.business && CFG.business.enabled)
      ? '<p class="cart-note" id="cartLeadNote"' + (form.business ? '' : ' hidden') + '>' +
        L.leadTime.replace('{h}', CFG.business.leadTimeHours) + '</p>'
      : '';

    els.body.innerHTML =
      (isOpenNow() ? '' : '<p class="cart-note is-closed">' + L.closedNote + '</p>') +
      '<ul class="cart-lines">' + lines + '</ul>' +
      '<div class="cart-sums" id="cartSums">' + sumsHtml(sums) + '</div>' +
      '<div id="cartTypeBox">' + typesHtml() + '</div>' +
      '<form class="cart-form" id="cartForm" novalidate>' +
        field('fName', L.name, 'text', '', true) +
        field('fPhone', L.phone, 'tel', '', true) +
        '<div id="fAddressWrap"' + (form.type === 'delivery' ? '' : ' hidden') + '>' +
          field('fAddress', L.address, 'text', L.addressPh, true) +
          field('fPlz', L.postcode, 'text', L.postcodePh, true) +
          '<div class="cart-zone" id="cartZoneHint"></div>' +
        '</div>' +
        whenHtml() +
        (CFG.business && CFG.business.enabled
          ? '<label class="cart-check"><input type="checkbox" id="fBusiness"' +
            (form.business ? ' checked' : '') + '><span>' + L.isBusiness + '</span></label>' +
            '<div id="fCompanyWrap"' + (form.business ? '' : ' hidden') + '>' +
              field('fCompany', L.company, 'text', '', false) + '</div>'
          : '') +
        field('fNotes', L.notes, 'textarea', L.notesPh, false) +
        leadNote +
        // Label left empty on purpose: paintSendButton() below is the single
        // place that decides the wording, because the wording is a legal
        // statement about what pressing it does. Two places would drift.
        '<p class="order-off" id="cartOrderOff" hidden></p>' +
        '<button type="submit" class="cart-send" id="cartSend"></button>' +
        '<p class="cart-privacy">' + L.privacy + '</p>' +
      '</form>';

    restoreForm();
    paintZone();
  }

  // Repainting the panel (language switch, quantity change) rebuilds its DOM,
  // so anything the guest already typed has to be carried across.
  var draft = {};
  var DRAFT_FIELDS = ['fName', 'fPhone', 'fAddress', 'fPlz', 'fDate', 'fTime', 'fCompany', 'fNotes'];
  function rememberForm() {
    DRAFT_FIELDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) draft[id] = el.value;
    });
  }
  function restoreForm() {
    Object.keys(draft).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = draft[id];
    });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  // The count and the total are the only text in the button, and neither says
  // what pressing it does — so the accessible name has to.
  function paint() {
    paintMenu();
    var n = count();
    if (els.fab) {
      var L = t();
      els.fab.hidden = n === 0;
      els.fabCount.textContent = n;
      els.fabTotal.textContent = money(totals().total);
      els.fab.setAttribute('aria-label', L.cartOpen + ' — ' + n + ' ' +
        (n === 1 ? L.itemsOne : L.itemsMany) + ', ' + money(totals().total));
    }
    // The panel stays open when the last line is removed — it shows the empty
    // state, which is clearer than the drawer vanishing under the guest.
    if (els.panel && !els.panel.hidden) { rememberForm(); paintPanel(); }

    /* Last, and not only at boot. The basket's copy of the notice and the send
       button both live inside a panel that does not exist until buildPanel()
       has run and is rewritten every time the basket is repainted — so a
       renderOrdering() called once at startup dressed a page that had no
       basket in it yet, and the send button came back enabled on the next
       repaint. Found by tests/e2e/ordering-switch.spec.js, which pressed it. */
    renderOrdering();
  }

  /* --- how the guest pays -------------------------------------------------
     Two ways, and the site says both in every place it says either: online
     with PayPal while ordering, or in person on collection or delivery. Which
     methods exist in person comes from config.payment.onSite, so the FAQ, the
     basket, the confirmation screen and the methods Google indexes cannot
     drift apart — and cannot outlive a card terminal.
  ------------------------------------------------------------------------- */

  /* Online payment needs the switch in config.js AND a payment account the
     server can actually use. The second half is not knowable in the browser,
     so the server is asked — once, when the basket is first opened.

     Not on page load: a visitor who reads the menu and leaves should cost one
     request for the menu and nothing else. And not the payment SDK either —
     that is fetched by pay.js only once a guest chooses to pay online, which
     is what keeps "no third-party requests on load" true. */
  var payCfg = null;
  var payCfgAsked = false;

  function onlinePayEnabled() {
    return !!(payCfg && payCfg.online && CFG.payment && CFG.payment.prepayOnline);
  }

  function ensurePayConfig() {
    if (payCfgAsked || !(CFG.payment && CFG.payment.prepayOnline)) return;
    payCfgAsked = true;
    fetch('/api/payments/config', { credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.online) return;
        payCfg = data;
        // The option only now became known; redraw whatever is on screen.
        if (els.panel && !els.panel.hidden) paintPanel();
        renderPaymentNote();
        applyConfig();
      })
      .catch(function () { /* offline — the basket simply offers paying in person */ });
  }

  function joinList(parts) {
    if (parts.length < 2) return parts.join('');
    return parts.slice(0, -1).join(', ') + ' ' + t().or + ' ' + parts[parts.length - 1];
  }

  function onSiteMethods(type) {
    var L = t();
    var keys = ((CFG.payment && CFG.payment.onSite) || {})[type] || [];
    return keys.map(function (key) { return L.pay[key]; }).filter(Boolean);
  }

  function payOnSiteText(type) {
    var L = t();
    var list = onSiteMethods(type);
    if (!list.length) return '';
    return fill(L.payOnSite, {
      type: type === 'pickup' ? L.atPickup : L.atDelivery,
      methods: joinList(list)
    });
  }

  // Both order types plus PayPal and the invoice, for schema.org. Only ever
  // what is actually on offer: a payment method Google shows and the shop does
  // not take is a wasted trip for the guest.
  // Provider ids -> the words Google and the guest read. Apple Pay, Google Pay
  // and PayPal are brands and are the same string in all three languages; a
  // card is not a brand, so it comes from the dictionary like everything else.
  function onlineMethodLabels() {
    var L = t();
    return [
      ['applepay', 'Apple Pay'],
      ['googlepay', 'Google Pay'],
      ['card', L.pay.card],
      ['paypal', 'PayPal']
    ];
  }

  function paymentAccepted() {
    var L = t();
    var seen = {};
    var out = [];
    ['pickup', 'delivery'].forEach(function (type) {
      onSiteMethods(type).forEach(function (label) {
        if (!seen[label]) { seen[label] = true; out.push(label); }
      });
    });
    // Only ever what is really on offer. The online methods come from the
    // server, so a method PayPal has not enabled for this account is never
    // advertised to Google or to a guest.
    if (onlinePayEnabled()) onlineMethodLabels().forEach(function (pair) {
      if (payCfg.methods.indexOf(pair[0]) !== -1 && !seen[pair[1]]) {
        seen[pair[1]] = true;
        out.push(pair[1]);
      }
    });
    if (CFG.payment && CFG.payment.invoiceForBusiness) out.push(L.payInvoice);
    return out.join(', ');
  }

  function renderPaymentNote() {
    var text = [payOnSiteText('pickup'), payOnSiteText('delivery')];
    if (onlinePayEnabled()) text.push(t().payOnline);
    [].forEach.call(document.querySelectorAll('.payment-note'), function (el) {
      el.textContent = text.filter(Boolean).join(' ');
    });
  }

  /* --- WhatsApp handover -------------------------------------------------- */

  // What the chat is told about payment. A captured payment says so in as
  // many words, with the reference and the amount actually taken — the two
  // facts that make checking anything by hand unnecessary.
  function paymentLine(data, payment) {
    var L = t();
    if (payment && payment.status === 'captured') {
      return fill(L.mPayOnline, {
        ref: payment.reference,
        amount: money(payment.amount / 100)
      });
    }
    if (payment && payment.status === 'pending') {
      return fill(L.mPayPending, { ref: payment.reference });
    }
    return fill(L.mPayOnSite, {
      methods: joinList(onSiteMethods(data.type)),
      type: data.type === 'pickup' ? L.atPickup : L.atDelivery
    });
  }

  /* A flag the restaurant must not miss, written so nothing downstream can
     eat it. The warning sign U+26A0 was the obvious choice and the wrong one:
     wa.me redirects through api.whatsapp.com, and that redirect replaces it
     with U+FFFD — so the kitchen read "� PRE-ORDER". A check mark and an
     em dash survive the same trip; this one does not. Plain ASCII, bolded by
     WhatsApp's own asterisks, is louder anyway. */
  function warn(text) {
    return '*! ' + text + '*';
  }

  /* How much of the order goes into the message.
       'full'     every line with its price — what a normal order sends
       'compact'  every line, prices dropped; the totals still state them
       'summary'  no lines, a count instead

     Never a truncation: each is a complete, readable order. The full text
     reaches the clipboard regardless, so nothing is lost — only moved out of
     the URL and into the paste. */
  function buildMessage(data, payment, density) {
    var L = t();
    var mode = density || 'full';
    var sums = totals();
    var outside = isOutsideArea();
    var out = ['*' + (outside ? L.msgTitleRequest : L.msgTitle) + '*'];

    if (data.business) out.push('*' + L.msgBusiness + '*');
    out.push('');

    if (mode === 'summary') {
      out.push(fill(L.mItemCount, { n: count() }));
      out.push(L.mListFollows);
    } else {
      Object.keys(cart).forEach(function (id) {
        out.push(cart[id] + '× ' + itemName(id) +
          (mode === 'compact' ? '' : ' — ' + money(items[id].price * cart[id])));
      });
    }

    out.push('');
    out.push(L.mSubtotal + ': ' + money(sums.subtotal));
    if (sums.discount > 0) {
      out.push(L.mDiscount + ' ' + sums.discountPercent + ' %: −' + money(sums.discount));
    }
    if (data.type === 'delivery' && sums.zone) {
      out.push(L.deliveryFee + ': ' + (sums.fee > 0 ? money(sums.fee) : money(0)));
    }
    out.push('*' + L.mTotal + ': ' + money(sums.total) + '*');
    out.push('');
    out.push(L.mType + ': ' + (data.type === 'delivery' ? L.delivery : L.pickup));
    // Whoever answers the chat has to know whether the money is already in —
    // and if so, under which reference — or whether to take the terminal to
    // the counter or send the driver out for cash.
    out.push(L.mPayment + ': ' + paymentLine(data, payment));
    out.push(L.mName + ': ' + data.name);
    out.push(L.mPhone + ': ' + data.phone);
    if (data.type === 'delivery') {
      out.push(L.mAddress + ': ' + data.address + ', ' + data.plz +
        (sums.zone ? ' ' + sums.zone.city : ''));

      // Flags the restaurant acts on. Neither one blocked the guest, and the
      // minimum is only ever raised with someone it is actually asked of —
      // a company order or a collected one must not arrive flagged for it.
      if (!sums.zone) out.push(warn(L.mOutsideArea));
      else if (sums.belowMinimum) {
        out.push(warn(fill(L.mUnderMin, { min: sums.zone.minOrder })));
      }
    }
    out.push(L.mTime + ': ' + data.time);
    if (data.company) out.push(L.mCompany + ': ' + data.company);
    if (data.notes) out.push(L.mNotes + ': ' + data.notes);
    if (data.business && CFG.business) {
      out.push(L.mLead + ': ≥ ' + CFG.business.leadTimeHours + ' ' + L.mHours);
    }

    // Anything the guest was warned about is repeated here, so the same facts
    // reach whoever answers the chat.
    whenWarnings().forEach(function (warning) {
      if (warning.kind === 'hours' || warning.kind === 'past') out.push(warn(L.mCheckTime));
      if (warning.kind === 'lead') {
        out.push(warn(fill(L.mCheckLead, { h: CFG.business.leadTimeHours })));
      }
    });
    if (!isOpenNow()) out.push(warn(L.mPreorder));

    return out.join('\n');
  }

  /* --- when WhatsApp is not on this device ---------------------------------
     On a phone the handover is one tap. On a desktop it opens WhatsApp Web,
     and a guest whose phone is not linked to that browser meets a login screen
     with their order nowhere in sight — a basket built and then a dead end.

     So the confirmation screen carries a way out, collapsed until it is
     needed: a QR code that opens the same prepared message on the phone, the
     order text on the clipboard, a phone number, and SMS. Deliberately NOT
     e-mail: an order is only ordered once it has been read, and this
     restaurant answers its phone, not its inbox.

     The QR is generated on the spot, and qr.js is fetched only when somebody
     actually opens the panel — nobody pays for it on the way in.
  ------------------------------------------------------------------------- */

  var lastOrder = null;      // { url, text } of the message just handed over

  function loadQr(done) {
    if (window.KairoQR) { done(true); return; }
    var script = document.createElement('script');
    script.src = 'qr.js';
    script.onload = function () { done(!!window.KairoQR); };
    script.onerror = function () { done(false); };
    document.head.appendChild(script);
  }

  function fallbackHtml() {
    var L = t();
    if (!lastOrder) return '';
    var sms = 'sms:' + CFG.whatsapp.number.replace(/^/, '+') +
      '?body=' + encodeURIComponent(lastOrder.text);
    return '<details class="cart-fallback" id="cartFallback"' +
      (lastOrder.shortened ? ' open' : '') + '>' +
      '<summary>' + escapeHtml(L.noWhatsapp) + '</summary>' +
      '<div class="cart-fallback-body">' +
        '<div class="cart-qr" id="cartQr"></div>' +
        '<p class="cart-qr-hint" id="cartQrHint"></p>' +
        '<div class="cart-fallback-actions">' +
          '<button type="button" class="cart-alt" id="cartCopy">' + escapeHtml(L.copyOrder) + '</button>' +
          '<a class="cart-alt" href="tel:+' + escapeHtml(CFG.whatsapp.number) + '">' + escapeHtml(L.callUs) + '</a>' +
          '<a class="cart-alt" href="' + escapeHtml(sms) + '">' + escapeHtml(L.smsUs) + '</a>' +
          '<a class="cart-alt" href="' + escapeHtml(lastOrder.url) + '" target="_blank" rel="noopener">' +
            escapeHtml(L.openAgain) + '</a>' +
        '</div>' +
      '</div>' +
      '</details>';
  }

  // A QR carrying a whole order can run to a thousand bytes; past a point the
  // modules get too fine to scan off a screen. So the code carries the full
  // message while it comfortably fits, and falls back to the bare chat link —
  // with the copy button doing the rest — when it does not.
  var QR_TEXT_LIMIT = 900;

  function paintQr() {
    var host = document.getElementById('cartQr');
    var hint = document.getElementById('cartQrHint');
    if (!host || !lastOrder || host.getAttribute('data-done')) return;
    host.setAttribute('data-done', '1');
    var L = t();
    var full = lastOrder.url.length <= QR_TEXT_LIMIT;
    var payload = full ? lastOrder.url : 'https://wa.me/' + CFG.whatsapp.number;
    loadQr(function (ready) {
      if (!ready) { host.remove(); return; }
      var svg = window.KairoQR.svg(payload, { width: 232 });
      if (!svg) { host.remove(); return; }
      host.innerHTML = svg;
      var node = host.querySelector('svg');
      if (node) node.setAttribute('aria-label', L.qrAlt);
      if (hint) hint.textContent = full ? L.qrHint : L.qrHintLong;
    });
  }

  function copyOrder(btn) {
    if (!lastOrder) return;
    var L = t();
    var done = function () {
      btn.textContent = L.copied;
      btn.classList.add('is-done');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(lastOrder.text).then(done, function () { legacyCopy(done); });
    } else {
      legacyCopy(done);
    }
  }

  // execCommand is deprecated but still the only path on an insecure origin or
  // an older iOS Safari, and a copy button that silently does nothing is worse.
  function legacyCopy(done) {
    var area = document.createElement('textarea');
    area.value = lastOrder.text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* nothing to do */ }
    document.body.removeChild(area);
  }

  /* --- placing the order --------------------------------------------------
     Two routes out of the form, and which one is taken decides what the
     restaurant reads in the chat.

     Paying in person is unchanged: hand the message to WhatsApp and be done.

     Paying online takes payment FIRST and hands over afterwards, so the order
     arrives already marked paid, with its reference — nobody has to check an
     app against a chat, which is the manual reconciliation this exists to
     remove. It is also the better order on a phone: sending the message first
     switches apps and leaves the payment behind in a tab the guest may never
     come back to.

     What it must never do is lose an order. Every failure path below ends with
     the same escape — send the order anyway and pay on arrival — because a
     guest whose card was declined still wants dinner.
  ------------------------------------------------------------------------- */

  var pending = null;   // { data, outside } — the order awaiting payment

  function submitOrder(e) {
    e.preventDefault();

    /* Refused only for a moment we have already said we cannot cook in. A
       time chosen after we reopen is an ordinary order and goes through. */
    if (orderingBlocksChoice()) { renderOrdering(); paintWhen(); return; }

    syncType();
    syncPay();

    var data = {
      type: form.type,
      pay: form.pay,
      business: !!document.getElementById('fBusiness') && document.getElementById('fBusiness').checked,
      name: val('fName'), phone: val('fPhone'), address: val('fAddress'),
      plz: val('fPlz'), time: whenText(), company: val('fCompany'), notes: val('fNotes')
    };

    var required = ['fName', 'fPhone'];
    if (data.type === 'delivery') required.push('fAddress', 'fPlz');
    var bad = null;
    required.forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      var empty = !el.value.trim();
      el.classList.toggle('is-invalid', empty);
      if (empty && !bad) bad = el;
    });
    if (bad) { bad.focus(); return; }

    var outside = isOutsideArea();
    pending = { data: data, outside: outside };

    // An out-of-area enquiry has no agreed price yet, so there is nothing to
    // pay for and the payment step is skipped entirely.
    if (data.pay === 'online' && !outside && onlinePayEnabled()) {
      showPaymentStep();
      return;
    }

    handOver(null);
  }

  /* --- the payment step ---------------------------------------------------- */

  function payScreen(body) {
    els.body.innerHTML = '<div class="cart-pay-step">' + body + '</div>';
  }

  function loadPay(done) {
    if (window.KairoPay) { done(true); return; }
    var script = document.createElement('script');
    script.src = 'pay.js';
    script.onload = function () { done(!!window.KairoPay); };
    script.onerror = function () { done(false); };
    document.head.appendChild(script);
  }

  function showPaymentStep() {
    var L = t();
    var total = totals().total;

    payScreen(
      '<h3>' + escapeHtml(L.payTitle) + '</h3>' +
      '<p class="cart-pay-amount"><span>' + escapeHtml(L.payAmountLabel) + '</span>' +
        '<strong>' + escapeHtml(money(total)) + '</strong></p>' +
      '<div class="cart-pay-methods" id="cartPayMethods">' +
        '<p class="cart-empty-hint">' + escapeHtml(L.payWorking) + '</p>' +
      '</div>' +
      '<p class="cart-pay-trust">' + escapeHtml(L.paySecure) + '</p>' +
      // The way out, present from the first frame. A guest who changes their
      // mind at the payment step must never have to go back and start again.
      '<button type="button" class="cart-alt" data-payact="onsite">' +
        escapeHtml(L.paySendAnyway) + '</button>'
    );

    loadPay(function (ready) {
      var host = document.getElementById('cartPayMethods');
      if (!ready || !host) { paymentUnavailable(); return; }

      host.innerHTML = '';
      window.KairoPay.mount({
        host: host,
        // What is wanted, never what it costs — the server prices it.
        order: {
          items: cloneCart(),
          type: pending.data.type,
          business: pending.data.business,
          postcode: pending.data.plz,
          // Which moment this order is for, so the server can apply the same
          // closure rule the basket did. Never a price — only a wish.
          when: form.when === 'scheduled' && draft.fDate && draft.fTime
            ? { date: String(draft.fDate), time: String(draft.fTime) }
            : null,
          lang: lang()
        },
        // In cents, and only so the wallet sheet can show the guest the same
        // figure the panel does. The charge is still the server's number.
        amount: Math.round(total * 100),
        labels: { payNow: L.payNow, amount: money(total) },
        onState: onPaymentState
      });
    });
  }

  function cloneCart() {
    var out = {};
    Object.keys(cart).forEach(function (id) { out[id] = cart[id]; });
    return out;
  }

  function onPaymentState(state, detail) {
    var L = t();
    var info = detail || {};

    if (state === 'ready' || state === 'paying') return;
    if (state === 'paid' || state === 'pending') { handOver(info.payment); return; }
    if (state === 'cancelled') { paymentStopped(L.payCancelTitle, L.payCancelText); return; }
    if (state === 'unavailable') { paymentUnavailable(); return; }

    paymentStopped(L.payFailTitle, info.code === 'declined' ? L.payDeclined : L.payFailText);
  }

  // Nothing was charged. Both ways forward are offered: try again, or send the
  // order and pay on arrival.
  function paymentStopped(title, text) {
    var L = t();
    payScreen(
      '<div class="cart-sent is-request">' +
        '<div class="cart-sent-mark" aria-hidden="true">!</div>' +
        '<h3>' + escapeHtml(title) + '</h3>' +
        '<p>' + escapeHtml(text) + '</p>' +
        '<button type="button" class="cart-send" data-payact="retry">' +
          escapeHtml(L.payRetry) + '</button>' +
        '<button type="button" class="cart-alt" data-payact="onsite">' +
          escapeHtml(L.paySendAnyway) + '</button>' +
      '</div>'
    );
  }

  function paymentUnavailable() {
    var L = t();
    payScreen(
      '<div class="cart-sent is-request">' +
        '<div class="cart-sent-mark" aria-hidden="true">!</div>' +
        '<h3>' + escapeHtml(L.payFailTitle) + '</h3>' +
        '<p>' + escapeHtml(L.payUnavailable) + '</p>' +
        '<button type="button" class="cart-send" data-payact="onsite">' +
          escapeHtml(L.paySendAnyway) + '</button>' +
      '</div>'
    );
  }

  /* --- handing the order to WhatsApp --------------------------------------
     The single exit. Whether payment happened, is still being checked or was
     never attempted, the order leaves by exactly this route — so the message,
     the confirmation screen and the emptying of the basket cannot disagree
     about what just happened. */

  /* Tell our own server the order exists.
     -----------------------------------------------------------------------
     Deliberately NOT awaited, and that is the whole design of this call. The
     handover opens WhatsApp with window.open, which browsers allow only while
     the click that caused it is still being handled. Awaiting a fetch first
     spends that gesture and the popup is blocked — which already happened in
     production once, on the online-payment path, and cost an order.

     So this is fired and forgotten. If it lands, the restaurant learns of the
     order whether or not the guest ever presses send in WhatsApp. If it does
     not, nothing is worse than it was: the chat is still the route, exactly as
     before. An order must never be lost to our own bookkeeping. */
  function announceOrder(data, payment) {
    try {
      fetch('/api/orders/announce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,   // survives the tab going to WhatsApp
        body: JSON.stringify({
          items: cart,
          type: data.type,
          business: !!data.business,
          postcode: data.plz,
          time: data.time,
          name: data.name,
          phone: data.phone,
          address: data.address,
          company: data.company,
          notes: data.notes,
          paymentId: payment && payment.id ? payment.id : null
        })
      }).catch(function () { /* the chat is still the route */ });
    } catch (e) { /* never let this reach the guest */ }
  }

  function handOver(payment) {
    if (!pending) return;
    var L = t();
    var data = pending.data;
    var outside = pending.outside;
    var paid = !!(payment && payment.status === 'captured');

    /* An out-of-area enquiry is a question, not an order: there is no agreed
       price and nothing to cook, so it is not recorded as one. */
    if (!outside) announceOrder(data, payment);

    /* A wa.me link carries the whole order in its query string, and a very
       large order can outgrow what a browser or a mobile OS will follow —
       silently, by refusing to open at all. So the URL gets the densest
       version that fits, and the clipboard always gets the whole thing.

       Three complete orders, never a cut-off one. Whichever is used, the full
       text is what copyOrder() puts on the clipboard and what the QR encodes. */
    var message = buildMessage(data, payment);
    var fitted = fitForWhatsApp(data, payment, message);
    var url = fitted.url;
    lastOrder = { url: url, text: message, shortened: fitted.shortened };

    /* Opening WhatsApp is a convenience, never the mechanism.

       After an online payment this runs from a promise, long after the click
       that started it, so the browser has no user gesture to attribute the
       popup to and blocks it. That happened in production: money taken, and
       the order never reached the kitchen, while the screen cheerfully said
       WhatsApp had opened.

       So the link below is always drawn, as a link. A tap on it IS a gesture
       and cannot be blocked. The automatic open is attempted anyway, and if it
       fails the guest is told plainly rather than reassured.

       The feature string used to say 'noopener', and that quietly broke the
       detection: window.open returns null WHENEVER noopener is set — that is
       the specified behaviour, not a blocked popup — so `blocked` was true on
       every single order and every guest was told their browser had stopped
       WhatsApp while WhatsApp was opening in front of them. A warning that is
       always shown is a warning nobody reads on the day it is true.

       So the opener is severed on the handle instead. Same protection against
       the opened tab navigating this one, and a null return now means what it
       says. Setting it can throw once the tab is cross-origin, which costs
       nothing here: the target is wa.me, and the guest is one tap from a link
       carrying rel="noopener" anyway. */
    var opened = null;
    try { opened = window.open(url, '_blank'); } catch (e) { opened = null; }
    if (opened) { try { opened.opener = null; } catch (e) { /* cross-origin */ } }
    var blocked = !opened;

    var title = outside ? L.sentTitleRequest : (paid ? L.payPaidTitle : L.sentTitle);
    var text = outside ? L.sentTextRequest : (paid ? L.payPaidText : L.sentText);
    var note = '';
    if (payment && payment.status === 'pending') note = L.payPendingText;
    else if (!outside && !paid) note = payChosenText();

    els.body.innerHTML =
      '<div class="cart-sent' + (outside ? ' is-request' : '') + (paid ? ' is-paid' : '') + '">' +
        '<div class="cart-sent-mark" aria-hidden="true">' + (outside ? '!' : '✓') + '</div>' +
        '<h3>' + escapeHtml(title) + '</h3>' +
        '<p>' + escapeHtml(text) + '</p>' +
        // The reference is what ties this order to its payment in the books,
        // so the guest gets it too: it is the number to quote on the phone.
        (payment
          ? '<p class="cart-pay-ref">' + escapeHtml(L.payRef) + ': <strong>' +
            escapeHtml(payment.reference) + '</strong></p>'
          : '') +
        // The order has not been placed until this is tapped. It is the
        // loudest thing on the screen, and it is here whether the popup was
        // blocked or not — a guest who dismissed the new tab needs it too.
        '<p class="cart-must-send">' + escapeHtml(L.mustSend) + '</p>' +
        (blocked ? '<p class="cart-blocked">' + escapeHtml(L.popupBlocked) + '</p>' : '') +
        // A short version went to WhatsApp; the full one is on the clipboard.
        (fitted.shortened ? '<p class="cart-blocked">' + escapeHtml(L.waShortened) + '</p>' : '') +
        '<a class="cart-send cart-send-wa" href="' + escapeHtml(url) + '" target="_blank" rel="noopener"' +
          (payment ? ' data-handover="' + escapeHtml(payment.id) + '"' : '') + '>' +
          escapeHtml(L.sendOrderNow) + '</a>' +
        (note ? '<p class="cart-empty-hint">' + escapeHtml(note) + '</p>' : '') +
        '<button type="button" class="cart-reset" id="cartReset">' + L.newOrder + '</button>' +
        fallbackHtml() +
      '</div>';

    pending = null;
    cart = {};
    draft = {};
    saveCart();
    paintMenu();
    if (els.fab) els.fab.hidden = true;
    if (window.KairoPay) window.KairoPay.forget();

    var reset = document.getElementById('cartReset');
    if (reset) reset.addEventListener('click', closePanel);
  }

  /* Practical ceiling for a URL a browser or mobile OS will actually follow.
     Desktop Chrome and Safari go far higher; Android intent handling and some
     in-app browsers do not. Comfortably below the lowest of them. */
  var WA_URL_LIMIT = 3500;

  function waUrl(text) {
    return 'https://wa.me/' + CFG.whatsapp.number + '?text=' + encodeURIComponent(text);
  }

  function fitForWhatsApp(data, payment, full) {
    var url = waUrl(full);
    if (url.length <= WA_URL_LIMIT) return { url: url, shortened: false };

    // The same order with prices dropped from the lines. The totals below
    // still state them, so nothing a kitchen needs has gone.
    url = waUrl(buildMessage(data, payment, 'compact'));
    if (url.length <= WA_URL_LIMIT) return { url: url, shortened: false };

    // Hundreds of lines. A count travels; the guest pastes the rest.
    return { url: waUrl(buildMessage(data, payment, 'summary')), shortened: true };
  }

  /* --- coming back to a payment -------------------------------------------
     A refresh, a back button, a tab the browser restored. The id is in
     localStorage, but what HAPPENED is only ever read from the server, which
     re-checks with the provider when it is unsure. A guest is never told an
     order failed when the money was taken, and never asked to pay twice.
  ------------------------------------------------------------------------- */

  function recoverPayment() {
    if (!CFG.payment || !CFG.payment.prepayOnline) return;
    var record = null;
    try {
      var raw = localStorage.getItem('kairo.payment.v1');
      record = raw ? JSON.parse(raw) : null;
    } catch (e) { return; }
    // Nothing to recover: do not fetch pay.js, and do not touch PayPal.
    if (!record || !record.id) return;

    loadPay(function (ready) {
      if (!ready) return;
      if (!window.KairoPay.remembered()) return;

      window.KairoPay.statusOf(record.id).then(function (payment) {
        if (!payment) return;
        if (payment.status !== 'captured' && payment.status !== 'pending') {
          window.KairoPay.forget();
          return;
        }
        // Paid, but the handover never happened. The basket still holds the
        // order, so it can still reach the kitchen.
        if (!Object.keys(cart).length) { window.KairoPay.forget(); return; }
        pending = pending || { data: restoreOrderData(), outside: isOutsideArea() };
        openPanel();
        handOver(payment);
      }).catch(function () { /* leave it; the webhook remains the record */ });
    });
  }

  // The form as the guest left it before the payment sheet. The draft survives
  // in memory and in the inputs; this rebuilds the shape buildMessage expects.
  function restoreOrderData() {
    return {
      type: form.type,
      pay: form.pay,
      business: form.business,
      name: draft.fName || val('fName'), phone: draft.fPhone || val('fPhone'),
      address: draft.fAddress || val('fAddress'), plz: draft.fPlz || val('fPlz'),
      time: whenText(), company: draft.fCompany || '', notes: draft.fNotes || ''
    };
  }

  function val(id) {
    var el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }

  /* --- events ------------------------------------------------------------- */

  function wireEvents() {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (btn) {
        var id = btn.getAttribute('data-id');
        if (!items[id]) return;
        var adding = btn.getAttribute('data-act') === 'inc';
        /* Building a basket is never withheld, even while the till is closed.
           The guest may be putting together an order for tomorrow, and the
           basket is where they find out that they can. */
        setQty(id, (cart[id] || 0) + (adding ? 1 : -1));
        return;
      }
      var type = e.target.closest('[data-type]');
      if (type) {
        form.type = type.getAttribute('data-type');
        rememberForm();
        paintPanel();
        return;
      }

      var pay = e.target.closest('[data-pay]');
      if (pay) {
        form.pay = pay.getAttribute('data-pay');
        rememberForm();
        paintPanel();
        return;
      }

      // Buttons on the payment step: try the payment again, or give up on
      // paying now and send the order to be paid on arrival.
      // The guest is handing the order over. Tell the server, so a paid order
      // that never arrives can be found later. sendBeacon because the tab is
      // about to lose focus to WhatsApp and a fetch would be cancelled.
      var handover = e.target.closest('[data-handover]');
      if (handover) {
        var payId = handover.getAttribute('data-handover');
        var to = '/api/payments/' + encodeURIComponent(payId) + '/handover';
        try {
          if (navigator.sendBeacon) navigator.sendBeacon(to);
          else fetch(to, { method: 'POST', keepalive: true, credentials: 'same-origin' });
        } catch (err) { /* the link must open regardless */ }
        // Deliberately no return: the link still navigates.
      }

      var payact = e.target.closest('[data-payact]');
      if (payact) {
        if (!pending) return;
        if (payact.getAttribute('data-payact') === 'retry') {
          showPaymentStep();
        } else {
          // The message must say what will actually happen, so the choice is
          // corrected before the order is written.
          pending.data.pay = 'onsite';
          form.pay = 'onsite';
          handOver(null);
        }
        return;
      }

      var when = e.target.closest('[data-when]');
      if (when) {
        form.when = when.getAttribute('data-when');
        rememberForm();
        paintPanel();
      }
    });

    document.addEventListener('change', function (e) {
      if (e.target.id === 'fBusiness') {
        form.business = e.target.checked;
        var wrap = document.getElementById('fCompanyWrap');
        var note = document.getElementById('cartLeadNote');
        if (wrap) wrap.hidden = !form.business;
        if (note) note.hidden = !form.business;
        // Ticking the box can waive the delivery fee, so the total moves.
        paintSums();
      }
    });

    document.addEventListener('submit', function (e) {
      if (e.target.id === 'cartForm') submitOrder(e);
    });

    document.addEventListener('click', function (e) {
      if (e.target.id === 'cartCopy') copyOrder(e.target);
    });

    // <details> fires toggle, not click, and only then is the QR worth drawing.
    document.addEventListener('toggle', function (e) {
      if (e.target.id === 'cartFallback' && e.target.open) paintQr();
    }, true);

    document.addEventListener('input', function (e) {
      if (!e.target.id || DRAFT_FIELDS.indexOf(e.target.id) === -1) return;
      draft[e.target.id] = e.target.value;
      if (e.target.classList.contains('is-invalid') && e.target.value.trim()) {
        e.target.classList.remove('is-invalid');
      }
      // The postcode changes the fee and therefore the total, so the summary
      // is repainted in place — a full repaint would steal the caret.
      if (e.target.id === 'fPlz') paintSums();
      // A new time can move the order into or out of the collection-only lunch
      // window, so the delivery/pickup control is repainted with the hint.
      if (e.target.id === 'fDate' || e.target.id === 'fTime') { paintWhen(); paintTypes(); }
    });

    // Deep link used by the business section and the "order now" buttons.
    document.addEventListener('click', function (e) {
      var open = e.target.closest('[data-open-cart]');
      if (open) { e.preventDefault(); openPanel(); }
    });
  }

  /* =========================================================================
     Config-driven page content
     ========================================================================= */

  function applyConfig() {
    var b = CFG.business || {};
    var minRule = (CFG.order && CFG.order.minimumOrder) || {};

    // Sections that config can switch off entirely.
    if (!b.enabled) {
      [].forEach.call(document.querySelectorAll('[data-requires="business"]'), function (el) {
        el.hidden = true;
      });
    }

    // Numbers written once in config, shown in many places.
    var values = {
      freeDeliveryFrom: b.freeDeliveryFrom,
      leadTimeHours: b.leadTimeHours,
      discount: CFG.order.directDiscountPercent,
      businessPickupDiscount: CFG.order.businessPickupDiscountPercent,
      /* Empty when a driver is out for the whole opening, so copy that promises
         delivery carries the restriction only while there is one to carry, and
         falls silent by itself the day a midday driver exists. Filled here
         rather than left to the pass below: a value substituted into copy is
         not rescanned for placeholders of its own.

         The caveat has to appear wherever delivery is promised, not only in the
         hours block. A guest reading "free delivery from 100 €" has no way to
         know that nothing is delivered before 18:00 unless the sentence that
         promises it says so. */
      deliveryClause: deliveryFrom()
        ? fill(t().deliveryClause, { from: deliveryFrom() })
        : '',
      // How far we deliver, counted from the zone list rather than written
      // into the copy as "over 30" and left to rot when a postcode is added.
      deliveryPostcodes: ((CFG.delivery && CFG.delivery.zones) || []).length,
      // Printed by the festival band. A bound, not a measurement — see the
      // note in config.js — and written once there so all three languages
      // change together.
      ringDistanceKm: (CFG.event || {}).ringDistanceKm,
      /* The holiday band's three dates, written from the two the restaurant
         saved at /admin and in the reader's own language. The last day closed is DERIVED from the
         day we are back rather than stored beside it: two dates that have to
         stay one apart are one date, and the one nobody would notice going
         wrong is the one in the middle. */
      holidayFrom: dayMonth((CFG.holiday || {}).from),
      holidayTo: dayMonth(dayBefore((CFG.holiday || {}).until)),
      holidayBack: dayMonth((CFG.holiday || {}).until),
      // The two delivery rules as sentences, written from the same config the
      // basket applies. Wherever a page shows a minimum or a threshold it can
      // print the rule with it, and neither can be edited into disagreeing
      // with what the basket actually charges. Both fall silent by themselves:
      // a minimum asked of everyone, or no threshold at all, needs no caveat.
      // Printed only while it is exactly true: a minimum asked of a private
      // delivery and of nothing else. Widen or drop the rule in config and
      // the sentence stops being written, rather than becoming a small lie.
      minimumClause: (minRule.delivery === true && minRule.pickup !== true &&
                      minRule.business !== true) ? t().minimumClause : '',
      freeDeliveryAll: b.freeDeliveryFrom != null
        ? fill(t().freeDeliveryAll, { freeDeliveryFrom: b.freeDeliveryFrom })
        : ''
    };

    [].forEach.call(document.querySelectorAll('[data-cfg]'), function (el) {
      var value = values[el.getAttribute('data-cfg')];
      if (value !== undefined && value !== null) el.textContent = value;
    });

    // Translated copy carries {placeholders} instead of literal numbers, so a
    // changed threshold updates the German and the English wording at once.
    // The markup keeps the current numbers as its no-JavaScript fallback.
    [].forEach.call(document.querySelectorAll('.t[data-de]'), function (el) {
      var tpl = el.getAttribute('data-' + lang());
      if (!tpl || tpl.indexOf('{') === -1) return;
      el.textContent = tpl.replace(/\{(\w+)\}/g, function (whole, key) {
        return values[key] !== undefined && values[key] !== null ? values[key] : whole;
      });
    });

    renderDeliveryNotice();
    renderAllergens();
    renderPaymentNote();
    renderBusinessHours();
    renderAreas();
    renderFaqHours();
    updateFaqSchema();
    updateServiceSchema();

    // Corporate enquiry links carry a prefilled, structured template.
    [].forEach.call(document.querySelectorAll('[data-wa-template]'), function (el) {
      el.setAttribute('href', 'https://wa.me/' + CFG.whatsapp.number + '?text=' +
        encodeURIComponent(businessTemplate(el.getAttribute('data-wa-template'))));
    });

    // Online payment is only advertised once the server confirms it works.
    var canPayOnline = onlinePayEnabled();
    [].forEach.call(document.querySelectorAll('[data-requires="paypal"]'), function (el) {
      el.hidden = !canPayOnline;
    });

    renderBands();

    if (!CFG.order.cartEnabled) {
      document.body.classList.add('no-cart');
    }
  }

  /* --- the dated bands: a holiday, and an event next door -------------------
     Two announcements with two different authors. The festival next door is
     set by a developer in config.js, because that is where a date somebody
     else publishes belongs; the holiday is set by the restaurant at /admin and
     arrives in the live island, because a fortnight away is the restaurant's
     own calendar and waiting for a deploy is how a site announces a holiday
     that ended last week.

     Both are read against the clock, on every tick, exactly as the closure and
     the extension are. Berlin calendar dates all the way down: `berlinNow().iso`
     is 'YYYY-MM-DD' and so are the bounds, so this is a string comparison — no
     Date parsing, no timezone of its own, and no way for a band to be a day out
     for a reader in Cairo. Nothing has to run for either to lapse, and nobody
     has to remember to take one down.

     They differ in when they GO UP, and deliberately. The festival band is up
     for the days of the festival: it advertises something happening, and
     before it starts there is nothing to say. The holiday band is up from the
     moment it is saved until the day we are back: it warns of an absence, and
     a warning that arrives on the first morning of the absence has missed
     everyone who was going to order this week. So the restaurant announces it
     by saving it, and the copy reads the same either side of the first day —
     "closed from the 9th to the 18th, back on the 19th" is as true in August
     as it is on the 12th.

     `until` is EXCLUSIVE in both: for the festival it is the morning after, for
     the holiday it is the day we are back. That is what lets the last day be
     derived rather than stored, and two dates that must stay one apart cannot
     drift when only one of them is written down.

     Only one bar is ever up. Two announcement bars stacked read as one bar
     with a fold in it, so they are ranked by what they cost to get wrong: a
     holiday says we are shut and outranks both, a festival next door outranks
     the standing office-lunch offer, and the offer is still in the nav and
     still has its own page either way.
  ------------------------------------------------------------------------- */
  function bandRunning(block, now) {
    var b = block || {};
    if (!b.enabled || !b.from || !b.until) return false;
    var today = (now || berlinNow() || {}).iso;
    return !!today && today >= b.from && today < b.until;
  }

  /* The server already refuses to serve a holiday whose last day has passed;
     this asks again because a page does not reload at midnight. A tab open on
     the morning we reopen has an island saying we are away, and that is the
     one morning the band costs a day of orders. */
  function holidayRunning(now) {
    var h = CFG.holiday;
    if (!h || !h.from || !h.until) return false;
    var today = (now || berlinNow() || {}).iso;
    return !!today && today < h.until;
  }

  /* One band at a time, and which one is not a preference. A holiday says the
     kitchen is shut; the other two invite an order — so while it runs it is
     the only thing the bar can honestly say, and both of the others stand
     down. Every condition is recomputed here rather than latched, so the
     festival band and the corporate bar come back on the tick after the
     holiday ends, without a reload. */
  function renderBands(now) {
    var holiday = holidayRunning(now);
    var event = !holiday && bandRunning(CFG.event, now);
    var businessOn = !!(CFG.business || {}).enabled && !holiday && !event;

    [].forEach.call(document.querySelectorAll('[data-requires="holiday"]'), function (el) {
      el.hidden = !holiday;
    });
    [].forEach.call(document.querySelectorAll('[data-requires="event"]'), function (el) {
      el.hidden = !event;
    });
    [].forEach.call(document.querySelectorAll('.announce[data-requires="business"]'), function (el) {
      el.hidden = !businessOn;
    });
  }

  /* --- what the page says about delivery times ----------------------------
     One sentence, built from config, printed everywhere the delivery shift is
     mentioned: the corporate section, under the opening hours, in the delivery
     area and in the FAQ. Three places that each described it in their own words
     is how a site ends up promising delivery in one paragraph and refusing it
     in the next.
  ------------------------------------------------------------------------- */

  /* Silent by itself when a driver is out for the whole opening. That is the
     point: the day a midday driver is hired, `deliveryFrom` is emptied at
     /admin and every sentence describing the restriction disappears from the
     site at once, rather than being hunted down in four files. */
  function deliveryNotice() {
    var from = deliveryFrom();
    if (!from) return '';
    return fill(t().deliveryNotice, { from: from });
  }

  // `.delivery-note` carries the sentence; `[data-requires="delivery"]` is the
  // container that disappears entirely when there is nothing to say — an FAQ
  // entry with an empty answer would otherwise sit there looking broken, and
  // would be picked up by the FAQ structured data.
  function renderDeliveryNotice() {
    var text = deliveryNotice();
    [].forEach.call(document.querySelectorAll('.delivery-note'), function (el) {
      el.textContent = text;
    });
    [].forEach.call(document.querySelectorAll('[data-requires="delivery"]'), function (el) {
      el.hidden = !text;
    });
  }

  /* --- the ordering switch -------------------------------------------------
     One sentence, in the guest's own language, wherever an order would have
     started. It says three things and no more: that we are not taking orders,
     when we will be, and how to reach a person now. Why the kitchen stopped is
     nobody's business but ours.
  ------------------------------------------------------------------------- */

  // '4917679906621' -> '+49 176 79906621'. Built from the one number in
  // config.js rather than typed again: a number written twice is a number that
  // will be right in one of the two places.
  function phoneDisplay() {
    var n = String((CFG.whatsapp && CFG.whatsapp.number) || '').replace(/\D/g, '');
    return n.length > 5 ? '+' + n.slice(0, 2) + ' ' + n.slice(2, 5) + ' ' + n.slice(5) : n;
  }

  function berlinClock(ms) {
    try {
      return new Intl.DateTimeFormat('de-DE', {
        timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false
      }).format(new Date(ms));
    } catch (e) { return ''; }
  }

  function berlinDayOf(ms) {
    try {
      return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
    } catch (e) { return ''; }
  }

  // "Montag, 17. August" / "Monday, 17 August" / Arabic — in the reader's own
  // language, which a bare date string could never be.
  function berlinDate(ms) {
    try {
      return new Intl.DateTimeFormat(DATE_LOCALE[lang()], {
        timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long'
      }).format(new Date(ms));
    } catch (e) { return berlinDayOf(ms); }
  }

  /* A calendar date in the reader's own language and without a weekday: a band
     names days, not appointments, and "Mittwoch, 9. September" in a sentence
     that already carries two more dates reads as a timetable. Parsed at midday
     UTC and formatted in UTC so that no timezone can shift it onto the day
     before — the value is a calendar date, not a moment. */
  function dayMonth(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return '';
    try {
      return new Intl.DateTimeFormat(DATE_LOCALE[lang()], {
        timeZone: 'UTC', day: 'numeric', month: 'long'
      }).format(new Date(iso + 'T12:00:00Z'));
    } catch (e) { return iso; }
  }

  /* The day before an exclusive end date. Midday UTC again, so a month or a
     year boundary is arithmetic and not a special case. */
  function dayBefore(iso) {
    var ms = Date.parse(String(iso || '') + 'T12:00:00Z');
    return isNaN(ms) ? '' : new Date(ms - 86400000).toISOString().slice(0, 10);
  }

  var OFF_REASON = {
    demand: 'offDemand', emergency: 'offEmergency', holiday: 'offHoliday'
  };

  /* Three sentences, each able to fall silent: why, when we are back, and how
     to reach a person. Assembled rather than written out in every combination,
     so a new reason is one string in three dictionaries and nothing else. */
  function orderingNotice() {
    if (orderingOpen()) return '';
    var L = t();
    /* Closed with no end anybody can read is not a shape the server produces —
       normaliseOrdering() turns it back into "open" — but the notice is the
       one thing that must still say something if it ever arrives. */
    var off = closureEnds() || { reason: LIVE.ordering.reason, namedEnd: false, at: NaN };
    var at = off.at;

    var why = L[OFF_REASON[off.reason]] || L.offNone;

    var when = L.offBackSoon;
    if (off.namedEnd && isFinite(at)) {
      /* Today gets a clock, another day gets a date. Naming a weekday for
         something six hours away reads as evasive; naming a time for something
         eleven days away reads as nonsense. */
      when = berlinDayOf(at) === berlinNow().iso
        ? fill(L.offBackAt, { time: berlinClock(at) })
        : fill(L.offBackOn, { date: berlinDate(at) });
    }

    /* The way out, named. Without this the notice is a closed door; with it,
       it is a closed door and a bell — and the basket the guest already filled
       is still worth something. */
    var later = '';
    if (isFinite(at)) {
      later = ' ' + fill(L.offOrderLater, {
        resumes: berlinDayOf(at) === berlinNow().iso
          ? berlinClock(at) + (lang() === 'de' ? ' Uhr' : '')
          : berlinDate(at)
      });
    }

    return why + ' ' + when + later + ' ' + fill(L.offContact, { phone: phoneDisplay() });
  }

  /* `.order-off` carries the sentence; the attribute on <html> is what dims
     the buttons. The Worker sets that attribute too, before the page is sent,
     so the buttons are never live for the moment it takes this to run. */
  function renderOrdering() {
    var off = !orderingOpen();
    var text = orderingNotice();

    document.documentElement.setAttribute('data-ordering', off ? 'off' : 'on');
    [].forEach.call(document.querySelectorAll('.order-off'), function (el) {
      el.textContent = text;
      el.hidden = !off;
    });

    var send = document.getElementById('cartSend');
    if (send) {
      var blocked = orderingBlocksChoice();
      send.disabled = blocked;
      if (blocked) send.setAttribute('aria-describedby', 'cartOrderOff');
      else send.removeAttribute('aria-describedby');
    }
  }

  // Visible delivery-area list. Same data as the basket, so a price change in
  // the spreadsheet updates the marketing copy and the checkout together.
  //
  // Grouped by minimum order rather than listed in one long table: the zones
  // already fall into natural price tiers, a reader only cares which tier they
  // are in, and it lets each town sit on one line instead of a three-column
  // grid breaking "Oberhausen-Rheinhausen" across three.
  //
  // The delivery fee is stated per town, not per tier, because it varies
  // inside a tier — three towns with the same €50 minimum are charged €3, €4
  // and €8. Publishing it here is the same figure the basket charges, from the
  // same row of the spreadsheet, so the page cannot promise one price and
  // invoice another.
  function renderAreas() {
    var host = document.getElementById('areasList');
    if (!host) return;
    var rows = (CFG.delivery && CFG.delivery.zones) || [];
    if (!rows.length) { host.innerHTML = ''; return; }

    var L = t();
    var tiers = [];
    var byMin = {};

    rows.forEach(function (row) {
      var min = row[3];
      if (!byMin[min]) { byMin[min] = []; tiers.push(min); }
      byMin[min].push(row);
    });
    tiers.sort(function (a, b) { return a - b; });

    host.innerHTML = tiers.map(function (min) {
      var towns = byMin[min].slice().sort(function (a, b) {
        return String(a[1]).localeCompare(String(b[1]), 'de');
      }).map(function (row) {
        var fee = Number(row[4]) || 0;
        return '<li class="area">' +
          '<span class="area-city">' + escapeHtml(row[1]) + '</span>' +
          '<span class="area-plz">' + escapeHtml(row[0]) + '</span>' +
          '<span class="area-fee' + (fee > 0 ? '' : ' is-free') + '">' +
            (fee > 0 ? money(fee) : L.areaFree) +
          '</span>' +
          '</li>';
      }).join('');

      return '<div class="area-tier">' +
        '<h3 class="area-tier-title">' +
          fill(L.areaMinOrder, { min: min }) +
        '</h3>' +
        '<ul class="area-towns">' + towns + '</ul>' +
        '</div>';
    }).join('');
  }

  // The opening-hours answer is written from config, never typed by hand, so
  // it can never contradict the table above it.
  function renderFaqHours() {
    var host = document.querySelector('.faq-hours');
    if (!host) return;
    var L = t();

    var lines = DAY_KEYS.map(function (key) {
      var slots = slotsFor(key);
      return L.days[key] + ': ' + (slots.length
        ? slots.map(function (s) { return s.from + '–' + s.to; }).join(', ')
        : L.closed);
    });

    host.textContent = L.faqHoursLead + lines.join(' · ') + '. ' +
      (deliveryNotice() ? deliveryNotice() + ' ' : '') + L.faqHoursTail;
  }

  // FAQPage built from the rendered <details>, so an edited answer updates the
  // structured data automatically and the two can never disagree.
  function buildFaqSchema() {
    var items = document.querySelectorAll('#faq .faq-item');
    if (!items.length) return null;
    var entities = [];
    [].forEach.call(items, function (item) {
      if (item.hidden) return;
      var q = item.querySelector('summary');
      var a = item.querySelector('.faq-answer');
      if (!q || !a) return;
      var answer = a.textContent.replace(/\s+/g, ' ').trim();
      if (!answer) return;
      entities.push({
        '@type': 'Question',
        name: q.textContent.replace(/\s+/g, ' ').trim(),
        acceptedAnswer: { '@type': 'Answer', text: answer }
      });
    });
    if (!entities.length) return null;
    return { '@context': 'https://schema.org', '@type': 'FAQPage',
             inLanguage: lang(), mainEntity: entities };
  }

  function updateFaqSchema() {
    var node = document.getElementById('faqSchema');
    if (!node) return;
    var data = buildFaqSchema();
    node.textContent = data ? JSON.stringify(data, null, 2) : '';
  }

  // The delivery shift itself is stated by the notice at the top of the
  // section, so this line only adds what the notice does not: that anything
  // outside those hours is still possible, by arrangement.
  function renderBusinessHours() {
    var host = document.getElementById('businessHours');
    if (!host) return;
    var L = t();
    host.textContent = deliveryNotice() ? L.hoursByArrangement : L.businessByArrangement;
  }

  // The template asks for what actually decides the order — budget and time —
  // and no longer for a head count, which told us nothing we could cook from.
  function businessTemplate(kind) {
    var L = t();
    return kind === 'business' ? L.waBusiness : L.waSimple;
  }

  /* =========================================================================
     Boot
     ========================================================================= */

  function init() {
    applyConfig();
    renderHours();
    renderOrdering();

    // The basket has no menu of its own — it reads the dishes out of the page.
    // A page that carries no menu (the corporate catering page) still wants
    // the hours, the config-driven copy and the structured data, but must not
    // grow a floating basket button for a menu that is not there, and must
    // never reach for the checkout: it is not the page the relaxed CSP names.
    var hasMenu = !!document.querySelector('.mitem[data-item]');

    if (CFG.order.cartEnabled && hasMenu) {
      collectItems();
      loadCart();
      /* A basket outlives a service. Anything the kitchen has run out of since
         it was filled goes now, before a total is drawn from it — otherwise
         the guest reads a figure the server will refuse to charge. */
      var gone = dropSoldOut();
      buildPanel();
      wireEvents();
      paint();
      if (gone.length) {
        notifySoldOut(gone);
      }
      // A payment that was taken but never handed over must not be lost
      // because the guest refreshed at the wrong moment.
      recoverPayment();
    }

    // Language switch repaints everything that carries generated text.
    document.addEventListener('kairo:lang', function () {
      renderHours();
      renderOrdering();
      applyConfig();
      if (CFG.order.cartEnabled && hasMenu) paint();
    });

    // Keep "open now" honest on a tab left open across closing time — and the
    // ordering switch too, which ends by the clock rather than by anybody
    // coming back to release it.
    setInterval(function () {
      renderStatus(berlinNow());
      renderOrdering();
      /* Tonight's two notes end by the clock as well, and a tab left open past
         midnight would otherwise keep saying "today we deliver from 15:00"
         while the basket had already gone back to the standing shift — a note
         contradicting the button, which is the one thing it must not do. */
      renderExtensionNote();
      renderBands();
    }, 60000);
  }

  // Registered at module level, not inside init(): app.js fetches reviews.json
  // and a cached response could resolve before DOMContentLoaded, which would
  // lose the rating. aggregateRating is only ever emitted for figures actually
  // rendered on the page — inventing them is a structured-data violation.
  document.addEventListener('kairo:reviews', function (e) {
    var detail = e.detail || {};
    if (!detail.rating || !detail.total) return;
    schemaRating = { value: detail.rating, count: detail.total };
    updateSchemaHours();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
