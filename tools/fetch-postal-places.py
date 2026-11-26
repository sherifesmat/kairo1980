#!/usr/bin/env python3
"""Snapshot which towns each delivery postcode covers, from the OpenPLZ directory.

    python tools/fetch-postal-places.py

Run by hand when a postcode is added to data/delivery_zones.xlsx -- never at build or deploy
time, so the website never depends on a third-party service to show its checkout. It writes
data/postal_places.json, which tools/build-zones.py joins to the spreadsheet.

Why a directory at all (PO-15, KBOSS DELIVERY_PRICING rounds 20-21): the checkout lets a
customer choose their town from a list, and a list built from our own zone labels was wrong --
"Schwetzingen / Plankstadt" left out Oftersheim, which has the same postcode 68723.

What the directory is, and is not:
* OpenPLZ API (https://openplzapi.org), localities derived from OpenStreetMap
  (© OpenStreetMap contributors, ODbL 1.0) and the municipality list of the Federal Statistical
  Office. It is open data, not Deutsche Post's licensed directory.
* It names municipalities (Gemeinden), not city districts. "Heidelberg (Neuenheim)" in our own
  zone labels is ours, and is never offered as a choice.
* It does not validate a street or a building.
"""

import datetime
import io
import json
import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.join(ROOT, 'data', 'postal_places.json')
ENDPOINT = 'https://openplzapi.org/de/Localities?postalCode=%s&page=%d&pageSize=50'

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zone_sheet import read_zone_postcodes  # noqa: E402


def localities(postcode):
    names, page = [], 1
    while True:
        request = urllib.request.Request(
            ENDPOINT % (postcode, page), headers={'User-Agent': 'postcode-snapshot'})
        with urllib.request.urlopen(request, timeout=20) as response:
            # The page count is the directory's own statement of completeness. Without
            # it a missing page would look like a shorter list (DP-22, DP-21-01).
            header = response.headers.get('x-total-pages')
            if header is None or not header.strip().isdigit() or int(header) < 1:
                sys.exit('directory sent no usable x-total-pages for %s (%r)' % (postcode, header))
            pages = int(header)
            for row in json.load(response):
                if row.get('postalCode') != postcode:
                    sys.exit('directory answered %r for %s' % (row.get('postalCode'), postcode))
                names.append(row['name'])
        if page >= pages:
            return sorted(set(names))
        page += 1


def main():
    postcodes = read_zone_postcodes()
    places = {}
    for postcode in postcodes:
        if not re.fullmatch(r'[0-9]{5}', postcode):
            sys.exit('not a postcode: %r' % postcode)
        found = localities(postcode)
        if not found:
            sys.exit('the directory knows no town for %s -- check the spreadsheet' % postcode)
        places[postcode] = found
    snapshot = {
        'source': 'OpenPLZ API, https://openplzapi.org/de/Localities?postalCode=<code>',
        'derived_from': 'OpenStreetMap (ODbL 1.0, (c) OpenStreetMap contributors) and the '
                        'municipality list of the Federal Statistical Office',
        'limitations': 'Municipalities only: no city districts, no street or building '
                       'validation. Not the Deutsche Post directory.',
        'retrieved': datetime.date.today().isoformat(),
        'places': dict(sorted(places.items())),
    }
    io.open(TARGET, 'w', encoding='utf-8', newline='\n').write(
        json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n')
    print('postal_places.json written: %d postcodes, %d places'
          % (len(places), sum(len(v) for v in places.values())))


if __name__ == '__main__':
    main()
