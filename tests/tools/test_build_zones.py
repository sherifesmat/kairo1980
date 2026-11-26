"""The zone generator reads the spreadsheet strictly and joins the directory snapshot.

    python -m unittest discover -s tests/tools

PO-15 / KBOSS DELIVERY_PRICING round 21 (DP-21-01): one postcode has one price; one town may
have several postcodes with different prices; every town a postcode covers is listed.
"""

import importlib.util
import io
import json
import os
import tempfile
import unittest
from decimal import Decimal

import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOOLS = os.path.join(ROOT, 'tools')


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(TOOLS, filename))
    module = importlib.util.module_from_spec(spec)
    import sys
    sys.path.insert(0, TOOLS)
    spec.loader.exec_module(module)
    return module


zone_sheet = _load('zone_sheet', 'zone_sheet.py')
build_zones = _load('build_zones', 'build-zones.py')

HEADER = ('PLZ', 'City', 'Distance', 'Round Trip', 'Minimum Value', 'Delivery Fee')


def sheet(*rows):
    book = openpyxl.Workbook()
    ws = book.active
    ws.append(HEADER)
    for row in rows:
        ws.append(row)
    handle = tempfile.NamedTemporaryFile(suffix='.xlsx', delete=False)
    handle.close()
    book.save(handle.name)
    return handle.name


def snapshot(places):
    return {'retrieved': '2026-11-26', 'places': places}


class ReadingTheSheet(unittest.TestCase):
    def test_a_lost_leading_zero_is_refused_not_guessed(self):
        zones, errors = zone_sheet.read_zone_rows(sheet((1067, 'Dresden', 1, 2, 15, 1)))
        self.assertEqual(zones, [])
        self.assertIn('leading zero', errors[0])

    def test_a_postcode_written_as_text_keeps_its_leading_zero(self):
        zones, errors = zone_sheet.read_zone_rows(sheet(('01067', 'Dresden', 1, 2, 15, 1)))
        self.assertEqual(errors, [])
        self.assertEqual(zones[0]['plz'], '01067')

    def test_malformed_postcodes_are_refused(self):
        for bad in ('68766 Hockenheim', '6876', 'D-68766', '６８７６６', 687660):
            zones, errors = zone_sheet.read_zone_rows(sheet((bad, 'X', 1, 2, 15, 1)))
            self.assertEqual(zones, [], bad)
            self.assertEqual(len(errors), 1, bad)

    def test_amounts_are_exact_euros_and_cents(self):
        zones, errors = zone_sheet.read_zone_rows(sheet(('68766', 'Hockenheim', 0, 0, 15, 7.5)))
        self.assertEqual(errors, [])
        self.assertEqual(zones[0]['fee'], Decimal('7.5'))
        for bad in (7.555, -1, 'abc', None):
            _, errors = zone_sheet.read_zone_rows(sheet(('68766', 'Hockenheim', 0, 0, 15, bad)))
            self.assertEqual(len(errors), 1, bad)

    def test_one_postcode_has_one_price(self):
        _, errors = zone_sheet.read_zone_rows(
            sheet(('68766', 'Hockenheim', 0, 0, 15, 1), ('68766', 'Hockenheim', 0, 0, 20, 2)))
        self.assertIn('only have one price', errors[0])


class JoiningTheDirectory(unittest.TestCase):
    def zones(self, *rows):
        zones, errors = zone_sheet.read_zone_rows(sheet(*rows))
        self.assertEqual(errors, [])
        return zones

    def test_every_town_of_a_postcode_is_listed(self):
        text, errors = build_zones.build(
            self.zones(('68723', 'Schwetzingen / Plankstadt', 8.4, 0, 15, 2)),
            snapshot({'68723': ['Schwetzingen', 'Plankstadt', 'Oftersheim']}))
        self.assertEqual(errors, [])
        self.assertIn('["Oftersheim", "Plankstadt", "Schwetzingen"]', text)

    def test_one_town_may_have_postcodes_with_different_prices(self):
        text, errors = build_zones.build(
            self.zones(('69115', 'Heidelberg (Zentrum)', 9, 0, 50, 4),
                       ('69123', 'Heidelberg (Kirchheim)', 8, 0, 25, 2)),
            snapshot({'69115': ['Heidelberg'], '69123': ['Heidelberg']}))
        self.assertEqual(errors, [])
        self.assertIn('["69115", "Heidelberg (Zentrum)", 9, 50, 4, ["Heidelberg"]]', text)
        self.assertIn('["69123", "Heidelberg (Kirchheim)", 8, 25, 2, ["Heidelberg"]]', text)

    def test_a_postcode_the_directory_does_not_know_is_refused(self):
        text, errors = build_zones.build(
            self.zones(('68766', 'Hockenheim', 0, 0, 15, 1)), snapshot({}))
        self.assertIsNone(text)
        self.assertIn('68766', errors[0])

    def test_a_snapshot_postcode_no_longer_served_is_refused(self):
        _, errors = build_zones.build(
            self.zones(('68766', 'Hockenheim', 0, 0, 15, 1)),
            snapshot({'68766': ['Hockenheim'], '68799': ['Reilingen']}))
        self.assertIn('68799', errors[0])

    def test_repeated_or_empty_towns_are_refused(self):
        for towns in (['Hockenheim', 'Hockenheim'], ['']):
            _, errors = build_zones.build(
                self.zones(('68766', 'Hockenheim', 0, 0, 15, 1)), snapshot({'68766': towns}))
            self.assertEqual(len(errors), 1, towns)

    def test_quotes_in_a_name_cannot_break_the_file(self):
        text, errors = build_zones.build(
            self.zones(('68766', "L'Isle \"x\"", 0, 0, 15, 1)),
            snapshot({'68766': ["L'Isle"]}))
        self.assertEqual(errors, [])
        row = text.split('window.KAIRO_ZONES = ')[1].rstrip().rstrip(';')
        self.assertEqual(json.loads(row)[0][1], "L'Isle \"x\"")

    def test_two_runs_over_the_same_inputs_are_identical(self):
        rows = (('68799', 'Reilingen', 2.9, 12, 15, 1), ('68766', 'Hockenheim', 0, 0, 15, 1))
        places = snapshot({'68766': ['Hockenheim'], '68799': ['Reilingen']})
        first, _ = build_zones.build(self.zones(*rows), places)
        second, _ = build_zones.build(self.zones(*rows), places)
        self.assertEqual(first, second)


class TheCommittedFiles(unittest.TestCase):
    """The published zones.js is the generator's output of the committed inputs."""

    def test_zones_js_is_up_to_date(self):
        zones, errors = zone_sheet.read_zone_rows()
        self.assertEqual(errors, [])
        places = json.load(io.open(os.path.join(ROOT, 'data', 'postal_places.json'), encoding='utf-8'))
        text, errors = build_zones.build(zones, places)
        self.assertEqual(errors, [])
        with io.open(os.path.join(ROOT, 'zones.js'), encoding='utf-8') as committed:
            self.assertEqual(committed.read(), text)

    def test_oftersheim_is_offered_under_68723(self):
        places = json.load(io.open(os.path.join(ROOT, 'data', 'postal_places.json'), encoding='utf-8'))
        self.assertIn('Oftersheim', places['places']['68723'])


if __name__ == '__main__':
    unittest.main()
