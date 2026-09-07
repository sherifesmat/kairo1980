// Fetches Google reviews into reviews.json.
//
// The Places API bills per request, so this script is deliberately stingy:
//   * a hard monthly ceiling that nothing can bypass,
//   * a minimum gap between calls so repeated manual runs cannot drain the
//     budget in one afternoon,
//   * every attempt is counted, including failed ones -- Google bills those
//     too, so counting only successes would let a broken key retry forever.
// A manual run can waive the spacing guard, never the monthly ceiling.

// `import`, not `require`: this package is ESM ("type": "module"), so `require`
// is not defined here at all. The script threw on its first line every time the
// weekly job ran -- failing before it could even read its own budget, and
// sending a failure notice every week for a call it never made.
import https from 'node:https';
import fs from 'node:fs';

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const PLACE_ID = 'ChIJdwpqXHy5l0cRyzEKo1_yYRE'; // KAIRO 1980 Hockenheim
const OUTPUT_FILE = 'reviews.json';
const LOG_FILE = 'request-log.json';

const MAX_REQUESTS_PER_MONTH = 8;
const MIN_HOURS_BETWEEN_REQUESTS = 72;
const FORCE = process.env.FORCE_FETCH === 'true';

const now = new Date();
const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

// The previous format stored a bare month index, which repeats every year.
// Carry its count over only when it really is the same calendar month.
let log = { period, count: 0, lastRequestAt: null };
if (fs.existsSync(LOG_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    const sameMonth = saved.period === period
      || (saved.period === undefined && saved.month === now.getUTCMonth());
    log = {
      period,
      count: sameMonth ? (saved.count || 0) : 0,
      lastRequestAt: saved.lastRequestAt || null
    };
  } catch (e) {
    console.log(`⚠️  ${LOG_FILE} unreadable (${e.message}); starting this period at 0.`);
  }
}

// Hard ceiling. Not overridable.
if (log.count >= MAX_REQUESTS_PER_MONTH) {
  console.log(`🛑 Monthly budget spent: ${log.count}/${MAX_REQUESTS_PER_MONTH} for ${period}. No request made.`);
  process.exit(0);
}

// Spacing guard. Overridable by a manual run.
if (log.lastRequestAt) {
  const hoursSince = (now - new Date(log.lastRequestAt)) / 3600000;
  if (hoursSince < MIN_HOURS_BETWEEN_REQUESTS) {
    if (!FORCE) {
      console.log(`⏳ Last request was ${hoursSince.toFixed(1)}h ago, minimum gap is ${MIN_HOURS_BETWEEN_REQUESTS}h. No request made.`);
      process.exit(0);
    }
    console.log(`⚠️  Spacing guard overridden by manual run (last request ${hoursSince.toFixed(1)}h ago).`);
  }
}

if (!API_KEY) {
  console.log('❌ GOOGLE_PLACES_API_KEY is not set.');
  process.exit(1);
}

// Charge the budget before the call, not after. A request that fails to parse
// still cost money, and the workflow commits this file even when the job fails.
log.count++;
log.lastRequestAt = now.toISOString();
fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2) + '\n');
console.log(`📊 Request ${log.count}/${MAX_REQUESTS_PER_MONTH} for ${period}.`);

// The field mask and the key go in **headers**, which is the form Google
// documents for the Places API (New). They were previously query parameters
// (`?fields=...&key=...`); that stopped returning anything on 2026-09-07,
// answering HTTP 200 with a body of exactly `{}` for a place that Maps shows
// with a rating and 21 reviews. A 200 carrying nothing is the worst shape a
// failure can take -- nothing to retry, nothing named, and the call still
// billed -- so the request is now made the documented way.
const FIELDS = 'rating,userRatingCount,reviews';

function askGoogle(fieldMask, done) {
  const req = https.get(
    `https://places.googleapis.com/v1/places/${PLACE_ID}?languageCode=de`,
    {
      headers: {
        'X-Goog-Api-Key': API_KEY,
        'X-Goog-FieldMask': fieldMask
      }
    },
    (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => done(res, data));
    }
  );
  req.setTimeout(20000, () => {
    req.destroy(new Error('no response within 20s'));
  });
  req.on('error', (e) => {
    console.log('❌ Request failed:', e.message);
    process.exit(1);
  });
  return req;
}

// Tell an entitlement problem apart from a dead key, and say which.
//
// `rating` and `reviews` are Enterprise/Atmosphere fields; `id` and
// `displayName` are Essentials, the cheapest tier. If the cheap mask answers
// and the expensive one does not, the key works and the project is not
// entitled to review data. If neither answers, the key or the project is the
// problem. One extra call, made only when the real one has already failed,
// and charged to the budget like any other.
function sayWhyItWasEmpty() {
  if (log.count >= MAX_REQUESTS_PER_MONTH) {
    console.log('   (no budget left for a diagnostic call this month)');
    process.exit(1);
  }
  log.count++;
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2) + '\n');
  console.log(`🔍 Diagnostic request ${log.count}/${MAX_REQUESTS_PER_MONTH}: asking for id,displayName only.`);

  askGoogle('id,displayName', (res, data) => {
    console.log(`   HTTP ${res.statusCode}: ${data.slice(0, 400)}`);
    if (res.statusCode === 200 && data.trim() !== '{}') {
      console.log('   -> The key works and the place resolves. The project is not returning');
      console.log('      Enterprise/Atmosphere fields, which is what rating and reviews are.');
      console.log('      Check billing and the Places API (New) SKU on the Google Cloud project.');
    } else {
      console.log('   -> The cheapest possible request also came back empty, so this is the key');
      console.log('      or the project, not the field mask. Check that the key is valid, that');
      console.log('      Places API (New) is enabled, and that billing is active.');
    }
    process.exit(1);
  });
}

const req = askGoogle(FIELDS, (res, data) => {
  {
    if (res.statusCode !== 200) {
      console.log(`❌ Google returned HTTP ${res.statusCode}: ${data.slice(0, 400)}`);
      process.exit(1);
    }
    try {
      const place = JSON.parse(data);

      if (!place.rating) {
        // Print the whole body, not the first 400 characters. The body that
        // started this was two characters long and the truncation hid nothing;
        // the next one may not be.
        console.log('❌ No rating in response. Full body:', data);
        console.log(`   Keys Google did return: ${Object.keys(place).join(', ') || '(none)'}`);
        sayWhyItWasEmpty();
        return;
      }

      const output = {
        lastUpdated: now.toISOString(),
        rating: place.rating,
        totalRatings: place.userRatingCount,
        reviews: (place.reviews || [])
          .filter(r => r.rating >= 4) // Only 4 and 5 star reviews
          .slice(0, 10)
          .map(r => ({
            author: r.authorAttribution?.displayName || 'Anonym',
            avatar: r.authorAttribution?.photoUri || '',
            rating: r.rating,
            text: r.text?.text || '',
            // The language the guest actually wrote in. The site never
            // translates a review — it is a quoted statement by a named
            // person — but it must mark the text so a screen reader
            // pronounces it correctly and Google knows what it is.
            lang: r.originalText?.languageCode || r.text?.languageCode || 'de',
            // Machine-readable, so the page can phrase "3 weeks ago" in
            // whichever language the visitor picked. `time` below is Google's
            // own German wording, kept as the fallback for entries fetched
            // before this field existed.
            publishTime: r.publishTime || '',
            time: r.relativePublishTimeDescription || ''
          }))
      };

      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
      console.log(`✅ Fetched ${output.reviews.length} reviews. Rating: ${output.rating}⭐ (${output.totalRatings} total)`);
      console.log(`📊 Budget used this month: ${log.count}/${MAX_REQUESTS_PER_MONTH}`);

    } catch (e) {
      console.log('❌ Error parsing response:', e.message);
      process.exit(1);
    }
  }
});
