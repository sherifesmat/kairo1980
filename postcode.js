/* The delivery postcode: what the checkout may offer, and how an old free-text value is read.

   Loaded by the browser before order.js, and imported by the Worker (worker/site-data.js), so
   the basket and the server can never read one address two ways again. They did: the basket
   stripped every non-digit, so "68799 Reilingen" showed Reilingen's fee, while the server
   wanted exactly five digits, called it "outside the area" and charged no fee (KBOSS
   DELIVERY_PRICING round 20).

   Two different jobs, kept apart on purpose (DELIVERY_PRICING round 21, G3/G7):

   * pairFor()  -- STRICT, for every new delivery. The customer chooses a postcode and a town
                   from the list (PO-15); only a pair that is on the list is a delivery.
   * parse()    -- PERMISSIVE, for values already stored (payments and orders from before the
                   list). Five digits with a town after them is that postcode; anything else
                   has no postcode. It follows the shared corpus tests/fixtures/
                   postcodes_de.v1.json, the same file KBOSS's parser is tested against. KBOSS
                   also compares a separate city field; the website has none, so parse() takes
                   only the postcode.

   The towns come from zones.js (column 6), which tools/build-zones.py joins from the postcode
   directory snapshot. Our zone labels ("Heidelberg (Neuenheim)") are never offered. */
(function (root) {
  'use strict';

  var VERSION = 1;
  var FIVE = /^[0-9]{5}$/;
  var FIVE_TOKEN = /(?<![0-9])[0-9]{5}(?![0-9])/g;
  var REDACTION = /^[\-._*#/\\,;:|]+$/;
  // Control and format characters, except tab, newline, vertical tab, form feed and carriage
  // return -- the same rule as KBOSS (postcodes_de._WHITESPACE_CONTROLS).
  var CONTROL = /[\p{Cc}\p{Cf}]/u;
  var WHITESPACE_CONTROLS = '\t\n\u000b\u000c\r';
  var TOWN_PUNCTUATION = " .'-";
  var LETTER = /\p{L}/u;

  function hasControl(text) {
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (CONTROL.test(ch) && WHITESPACE_CONTROLS.indexOf(ch) < 0) return true;
    }
    return false;
  }

  function looksLikeATown(text) {
    var letter = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (LETTER.test(ch)) letter = true;
      else if (TOWN_PUNCTUATION.indexOf(ch) < 0) return false;
    }
    return letter;
  }

  function result(status, code, town) {
    return { status: status, code: code || null, town: town || null };
  }

  /** What an already-stored postcode field holds: {status, code, town}. */
  function parse(value) {
    if (value === null || value === undefined) return result('missing');
    if (typeof value !== 'string') return result('unrecognised');
    var text = value.normalize('NFC');
    if (hasControl(text)) return result('unrecognised');
    text = text.split(/\s+/).filter(Boolean).join(' ');
    if (!text) return result('missing');
    if (REDACTION.test(text)) return result('withheld');
    if (FIVE.test(text)) return result('valid', text);

    var space = text.indexOf(' ');
    var head = space < 0 ? text : text.slice(0, space);
    var rest = space < 0 ? '' : text.slice(space + 1);
    if (FIVE.test(head) && rest) {
      if (rest.match(FIVE_TOKEN)) return result('ambiguous');
      if (!looksLikeATown(rest)) return result('unrecognised');
      return result('valid_with_town', head, rest);
    }
    if ((text.match(FIVE_TOKEN) || []).length > 1) return result('ambiguous');
    if (looksLikeATown(text)) return result('city_only', null, text);
    return result('unrecognised');
  }

  /** The postcode an old stored value stands for, or null. Two nulls are never equal. */
  function legacyCode(value) {
    var read = parse(value);
    return read.status === 'valid' || read.status === 'valid_with_town' ? read.code : null;
  }

  function zonesOf(zones) {
    return zones || (root.KAIRO_CONFIG && root.KAIRO_CONFIG.delivery &&
      root.KAIRO_CONFIG.delivery.zones) || root.KAIRO_ZONES || [];
  }

  /** The listed delivery a chosen postcode and town make, or null. No coercion, no trimming. */
  function pairFor(postcode, town, zones) {
    if (typeof postcode !== 'string' || typeof town !== 'string' || !FIVE.test(postcode)) {
      return null;
    }
    var rows = zonesOf(zones);
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row[0] === postcode && Array.isArray(row[5]) && row[5].indexOf(town) >= 0) {
        return { postcode: postcode, town: town, zone: row };
      }
    }
    return null;
  }

  /** The stable id of one choice. A postcode alone is not enough: 68723 is three towns. */
  function choiceId(postcode, town) {
    return postcode + '|' + town;
  }

  function fromChoiceId(id) {
    if (typeof id !== 'string') return null;
    var bar = id.indexOf('|');
    return bar === 5 ? { postcode: id.slice(0, 5), town: id.slice(6) } : null;
  }

  /** The list, grouped by town in German order, each town's postcodes ascending. */
  function choices(zones) {
    var byTown = {};
    zonesOf(zones).forEach(function (row) {
      (row[5] || []).forEach(function (town) {
        (byTown[town] = byTown[town] || []).push(row[0]);
      });
    });
    var collator = new Intl.Collator('de', { sensitivity: 'base' });
    return Object.keys(byTown)
      .sort(function (a, b) { return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0); })
      .map(function (town) {
        return {
          town: town,
          options: byTown[town].sort().map(function (postcode) {
            return { id: choiceId(postcode, town), postcode: postcode, town: town };
          }),
        };
      });
  }

  root.KAIRO_POSTCODE = {
    VERSION: VERSION,
    parse: parse,
    legacyCode: legacyCode,
    pairFor: pairFor,
    choiceId: choiceId,
    fromChoiceId: fromChoiceId,
    choices: choices,
  };
})(typeof window !== 'undefined' ? window : globalThis);
