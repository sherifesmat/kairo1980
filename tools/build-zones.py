#!/usr/bin/env python3
"""Generate zones.js from the delivery-zone spreadsheet and the postcode directory snapshot.

The spreadsheet at data/delivery_zones.xlsx is the single source of truth for the delivery
area and its prices. data/postal_places.json (tools/fetch-postal-places.py) says which towns
each postcode covers. This script joins the two into zones.js, which the website and its
server both load.

    python tools/build-zones.py

Never edit zones.js by hand -- the next run overwrites it. The script refuses to write a broken
file: a malformed or duplicate postcode, an amount that is not euros and cents, a postcode the
snapshot does not know, or a snapshot postcode the spreadsheet no longer has.

Expected columns (header row, any order, extra columns ignored):
    PLZ | City | Distance | Minimum Value | Delivery Fee

One postcode has one price. One town may have several postcodes with different prices
(Heidelberg, Mannheim): that is expected, and is not an error.
"""

import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zone_sheet import ROOT, read_zone_rows  # noqa: E402

TARGET = os.path.join(ROOT, 'zones.js')
PLACES = os.path.join(ROOT, 'data', 'postal_places.json')


def js_number(value):
    """An exact amount as a JavaScript number literal: 15, 7.5, 2.9."""
    if value is None:
        return 'null'
    text = format(value.normalize(), 'f')
    return text


def join_places(zones, snapshot, errors):
    places = snapshot.get('places') or {}
    for zone in zones:
        found = places.get(zone['plz'])
        if not found:
            errors.append('postcode %s is not in data/postal_places.json -- run '
                          'python tools/fetch-postal-places.py' % zone['plz'])
            continue
        # A list of distinct, non-empty town names exactly as written; a string is
        # not a list of towns (it would iterate as letters), nor is an object.
        if (not isinstance(found, list)
                or not all(isinstance(p, str) and p and p.strip() == p for p in found)
                or len(set(found)) != len(found)):
            errors.append('postcode %s has malformed, empty or repeated towns in the snapshot'
                          % zone['plz'])
            continue
        zone['places'] = sorted(found)
    stale = sorted(set(places) - {z['plz'] for z in zones})
    if stale:
        errors.append('the snapshot has postcode(s) the spreadsheet no longer lists: %s -- '
                      're-run python tools/fetch-postal-places.py' % ', '.join(stale))


def render(zones, retrieved):
    lines = []
    for zone in zones:
        lines.append('  [%s, %s, %s, %s, %s, %s]' % (
            json.dumps(zone['plz']), json.dumps(zone['city'], ensure_ascii=False),
            js_number(zone['km']), js_number(zone['min_order']), js_number(zone['fee']),
            json.dumps(zone['places'], ensure_ascii=False)))
    # Nothing here may vary between two runs over the same inputs: the deploy workflow rebuilds
    # this file and diffs it against the committed one.
    return (
        '/* AUTO-GENERATED — DO NOT EDIT.\n'
        '   Source : data/delivery_zones.xlsx + data/postal_places.json (retrieved %s)\n'
        '   Rebuild: python tools/build-zones.py\n'
        '   Zones  : %d postcodes, %d postcode-town pairs\n'
        '\n'
        '   Edit the spreadsheet, re-run the command, commit both files.\n'
        '   Columns: [ postcode, label, km, minimum order EUR, delivery fee EUR, towns ]\n'
        '   The label is ours (it may name a district); the towns are the directory\'s.\n'
        '   Towns  : OpenPLZ API (openplzapi.org), from OpenStreetMap data (c) OpenStreetMap\n'
        '            contributors, ODbL 1.0, and the Destatis municipality list.\n'
        '            Municipalities only; not a postal address check.\n'
        '*/\n'
        'window.KAIRO_ZONES = [\n%s\n];\n'
    ) % (retrieved, len(zones), sum(len(z['places']) for z in zones), ',\n'.join(lines))


def build(zones, snapshot):
    """The text of zones.js, or (None, errors)."""
    errors = []
    join_places(zones, snapshot, errors)
    if errors:
        return None, errors
    zones.sort(key=lambda z: (z['km'] is None, z['km'] if z['km'] is not None else 0, z['plz']))
    return render(zones, snapshot.get('retrieved', '?')), []


def main():
    zones, errors = read_zone_rows()
    snapshot = json.load(io.open(PLACES, encoding='utf-8')) if os.path.exists(PLACES) else {}
    text = None
    if not errors:
        text, errors = build(zones, snapshot)
    if errors:
        print('zones.js NOT written — fix the inputs first:\n', file=sys.stderr)
        for problem in errors:
            print('  * %s' % problem, file=sys.stderr)
        sys.exit(1)
    io.open(TARGET, 'w', encoding='utf-8', newline='\n').write(text)
    print('zones.js written — %d postcodes' % len(zones))


if __name__ == '__main__':
    main()
