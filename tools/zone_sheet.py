"""Reading data/delivery_zones.xlsx strictly: one place, used by every zone tool.

A postcode is five ASCII digits, kept as text. A spreadsheet stores 68766 as a number, which
is fine; it would store 01067 as 1067, and that is refused rather than guessed back.
Money is read exactly (Decimal), never through a float.
"""

import os
import re
import sys
from decimal import Decimal, InvalidOperation

try:
    import openpyxl
except ImportError:
    sys.exit("openpyxl is required:  python -m pip install openpyxl")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, 'data', 'delivery_zones.xlsx')

WANTED = {
    'plz': 'plz',
    'city': 'city',
    'distance': 'km',
    'minimum value': 'min_order',
    'delivery fee': 'fee',
}

_FIVE = re.compile(r'[0-9]{5}')


def postcode_of(cell):
    """Five ASCII digits, or None when the cell is not one."""
    if isinstance(cell, bool):
        return None
    if isinstance(cell, int):
        return str(cell) if 10000 <= cell <= 99999 else None
    if isinstance(cell, str) and _FIVE.fullmatch(cell.strip()):
        return cell.strip()
    return None


def amount_of(cell):
    """A finite, non-negative amount in whole cents, as a Decimal; or None."""
    if cell is None or isinstance(cell, bool) or str(cell).strip() == '':
        return None
    try:
        value = Decimal(str(cell).strip().replace(',', '.'))
    except InvalidOperation:
        return None
    # Bounded before rounding: quantize raises on a value too large for the context,
    # and no fee, minimum or distance here is anywhere near ten thousand.
    if not value.is_finite() or value < 0 or value > 9999:
        return None
    if value != value.quantize(Decimal('0.01')):
        return None
    return value


def read_zone_rows(source=SOURCE):
    """(zones, errors). Each zone: plz, city, km, min_order, fee (Decimals for money)."""
    sheet = openpyxl.load_workbook(source, data_only=True).worksheets[0]
    rows = sheet.iter_rows(values_only=True)
    header = next(rows)
    index = {}
    for position, label in enumerate(header):
        key = WANTED.get(str(label or '').strip().lower())
        if key:
            index[key] = position
    missing = {'plz', 'city', 'min_order', 'fee'} - set(index)
    if missing:
        sys.exit('spreadsheet is missing column(s): %s' % ', '.join(sorted(missing)))

    zones, errors, seen = [], [], {}
    for offset, row in enumerate(rows, start=2):
        if not any(cell is not None and str(cell).strip() for cell in row):
            continue
        raw = row[index['plz']]
        plz = postcode_of(raw)
        city = str(row[index['city']] or '').strip()
        if plz is None:
            hint = (' (a leading zero was lost: format the PLZ column as text)'
                    if isinstance(raw, int) and 0 < raw < 10000 else '')
            errors.append('row %d: %r is not a 5-digit postcode%s' % (offset, raw, hint))
            continue
        if not city:
            errors.append('row %d: city is empty' % offset)
        if plz in seen:
            errors.append(
                'row %d: postcode %s is already used in row %d (%s vs %s) — '
                'one postcode can only have one price'
                % (offset, plz, seen[plz][0], seen[plz][1], city))
            continue
        seen[plz] = (offset, city)
        zone = {'plz': plz, 'city': city, 'km': None}
        for key, label in (('min_order', 'minimum value'), ('fee', 'delivery fee')):
            value = amount_of(row[index[key]])
            if value is None:
                errors.append('row %d: %s is not an amount in euros and cents (%r)'
                              % (offset, label, row[index[key]]))
            zone[key] = value
        if 'km' in index and row[index['km']] not in (None, ''):
            try:
                km = Decimal(str(row[index['km']]).replace(',', '.'))
                zone['km'] = km if km.is_finite() and km >= 0 else None
            except InvalidOperation:
                pass
            if zone['km'] is None:
                errors.append('row %d: distance is not a number (%r)' % (offset, row[index['km']]))
        zones.append(zone)
    return zones, errors


def read_zone_postcodes(source=SOURCE):
    zones, errors = read_zone_rows(source)
    if errors:
        sys.exit('fix the spreadsheet first:\n  * ' + '\n  * '.join(errors))
    return [z['plz'] for z in zones]
