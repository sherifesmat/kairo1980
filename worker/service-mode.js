/* Render the active copy without overwriting the saved delivery translations. */
import { CONFIG } from './site-data.js';
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function withServiceMode(html, mode, hours) {
  if (mode !== 'pickup') return html;
  let out = html.replace(/<body([^>]*)>/, (whole, attrs) => {
    if (/\bclass="/.test(attrs)) return '<body' + attrs.replace(/class="/, 'class="pickup-only ') + '>';
    return '<body class="pickup-only"' + attrs + '>';
  });
  // Keep the guide hidden in delivery HTML even if a guest still has older CSS cached.
  out = out.replace(/(<section\b[^>]*class="pickup-guide"[^>]*?)\s+hidden(?=>)/, '$1');
  out = out.replace(/(<p[^>]*class="payment-note"[^>]*>)[\s\S]*?(<\/p>)/g,
    '$1Zahlung bei Abholung oder online.$2');
  const opening = /<(p|span|h1|h2|strong|a|summary|title|meta)\b[^>]*\bdata-pickup-de="([^"]*)"[^>]*>/g;
  const matches = [...out.matchAll(opening)].reverse();
  for (const m of matches) {
    let tag = m[0];
    const href = tag.match(/\bdata-pickup-href="([^"]*)"/);
    if (href) tag = tag.replace(/(?<![-\w])href="[^"]*"/, 'href="' + href[1] + '"');
    const start = m.index;
    const end = start + m[0].length;
    if (m[1] === 'meta') {
      const value = m[2].replace(/\{discount\}/g, String(CONFIG.order?.directDiscountPercent || 0));
      tag = tag.replace(/(?<![-\w])content="[^"]*"/, () => 'content="' + value + '"');
      out = out.slice(0, start) + tag + out.slice(end);
    } else {
      const close = matchingClose(out, m[1], end);
      if (close !== -1) out = out.slice(0, start) + tag + escape(decode(m[2]).replace(/\{discount\}/g,
        String(CONFIG.order?.directDiscountPercent || 0))) + out.slice(close);
    }
  }
  // Publish the actual saved week, including exceptions, in all three languages.
  // The language switch consumes these attributes without inventing Tuesday's hours.
  if (hours && hours.days) {
    for (const id of ['pickupWeek', 'businessHours']) {
      out = out.replace(new RegExp('<p([^>]*\\bid="' + id + '"[^>]*)>[\\s\\S]*?</p>'), (whole, attrs) => {
        let clean = attrs.replace(/\bdata-(?:de|en|ar)="[^"]*"/g, '');
        if (!/\bclass="/.test(clean)) clean += ' class="t"';
        else if (!/class="[^"]*\bt\b/.test(clean)) clean = clean.replace(/class="/, 'class="t ');
        const translated = ['de', 'en', 'ar'].map(lang => ' data-' + lang + '="' + escape(pickupWeekSummary(hours, lang)).replace(/"/g, '&quot;') + '"').join('');
        return '<p' + clean + translated + '>' + escape(pickupWeekSummary(hours, 'de')) + '</p>';
      });
    }
  }
  // The source keeps its original regional service schema for delivery mode.
  out = out.replace(/(<script[^>]*id="serviceSchema"[^>]*>)([\s\S]*?)(<\/script>)/,
    (whole, before, raw, after) => {
      try {
        const d = JSON.parse(raw);
        d.name = 'Mittagessen für Teams zur Abholung in Hockenheim';
        d.description = 'Ägyptische Küche zur Abholung in Hockenheim. Keine Lieferung.';
        d.areaServed = ['Hockenheim'];
        return before + JSON.stringify(d).replace(/</g, '\\u003c') + after;
      } catch { return whole; }
    });
  return out;
}


export function pickupWeekSummary(hours, language = 'de') {
  const keys = ['mon','tue','wed','thu','fri','sat','sun'];
  const labels = {
    de: ['Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag','Sonntag'],
    en: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'],
    ar: ['الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت','الأحد']
  };
  const days = labels[language] || labels.de;
  const groups = [];
  for (let i = 0; i < keys.length; i++) {
    const day = hours.days[keys[i]];
    const times = !day || day.closed ? '' : [day.lunch, day.evening].filter(Boolean).map(w => w.join('–')).join(' / ');
    if (!times) continue;
    const previous = groups[groups.length - 1];
    if (previous && previous.end === i - 1 && previous.times === times) previous.end = i;
    else groups.push({ start:i, end:i, times });
  }
  return groups.length ? groups.map(g => days[g.start] + (g.end !== g.start ? '–' + days[g.end] : '') + ' · ' + g.times).join(' | ')
    : ({de:'Geschlossen',en:'Closed',ar:'مغلق'}[language] || 'Geschlossen');
}


function matchingClose(html, name, from) {
  const tags = new RegExp('</?' + name + '\\b[^>]*>', 'gi');
  tags.lastIndex = from;
  let depth = 1;
  let match;
  while ((match = tags.exec(html))) {
    if (match[0].startsWith('</')) depth--;
    else depth++;
    if (!depth) return match.index;
  }
  return -1;
}
