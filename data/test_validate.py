"""Exercise validation failures and the distinction between staged and publishable data."""

import copy
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import validate


def pending():
    return {"geometry": None}


def catalog():
    return {
        "version": 4, "lastVerified": "2026-09-25", "timezone": "America/Toronto",
        "sources": {"official": {
            "title": "College directory", "url": "https://example.edu/directory", "retrieved": "2026-09-25",
        }},
        "buildingNames": {"A": "A Building"},
        "rooms": [{"id": "room-a1001", "code": "A1001", "buildingCode": "A", "floor": 1, **pending()}],
        "destinations": [
            {"id": "service", "name": "Service", "category": "student_services", "roomId": "room-a1001",
             "status": "open", "sourceIds": ["official"]},
            {"id": "child", "name": "Child service", "category": "student_services", "parentId": "service",
             "status": "unknown", "sourceIds": ["official"]},
        ],
        "launchGroups": [{"id": "student_services", "label": "Student Services"}],
        "launchLocations": [{"sourceLabel": "Child service", "group": "student_services",
                             "destinationIds": ["child"], "resolutionStatus": "resolved"}],
        "excludedLaunchLocations": [],
    }


def set_point(item):
    item.update(geometry={"type": "Point", "coordinates": [-81.199, 43.014]})


class ValidationTests(unittest.TestCase):
    def setUp(self):
        validate.errors.clear()
        self.data = catalog()

    def validate(self):
        validate.validate_places(self.data)
        return "\n".join(validate.errors)

    def test_pending_catalog_is_valid_but_cannot_be_published(self):
        self.assertEqual(self.validate(), "")
        validate.validate_launch_ready(self.data)
        self.assertIn("missing coordinates", "\n".join(validate.errors))

    def test_valid_room_point_is_inherited_without_verification_metadata(self):
        set_point(self.data["rooms"][0])
        self.assertEqual(self.validate(), "")
        validate.validate_launch_ready(self.data)
        self.assertEqual(validate.errors, [])

    def test_unresolved_identity_must_be_deferred_outside_active_selection(self):
        set_point(self.data["rooms"][0])
        self.data["launchLocations"][0]["resolutionStatus"] = "pending"
        self.assertIn("unresolved identities belong in excludedLaunchLocations", self.validate())

    def test_deliberate_deferred_or_excluded_rows_do_not_block_coordinate_readiness(self):
        set_point(self.data["rooms"][0])
        self.data["excludedLaunchLocations"] = [
            {"sourceLabel": "Foot Patrol", "group": "student_services", "decision": "deferred",
             "reason": "Current service identity needs review."},
            {"sourceLabel": "Pharmacy", "group": "student_services", "decision": "excluded",
             "reason": "Permanently closed.", "sourceIds": ["official"]},
        ]
        self.assertEqual(self.validate(), "")
        validate.validate_launch_ready(self.data)
        self.assertEqual(validate.errors, [])

    def test_excluded_rows_must_explain_decision_and_cannot_select_destinations(self):
        self.data["excludedLaunchLocations"] = [{
            "sourceLabel": "Foot Patrol", "group": "student_services", "decision": "maybe",
            "reason": " ", "destinationIds": ["child"],
        }]
        problems = self.validate()
        self.assertIn(".reason", problems)
        self.assertIn(".decision", problems)
        self.assertIn("must not select destinationIds", problems)

    def test_active_and_excluded_rows_cannot_repeat_same_source_item(self):
        self.data["excludedLaunchLocations"] = [{
            "sourceLabel": "Child service", "group": "student_services", "decision": "excluded",
            "reason": "Out of scope.",
        }]
        self.assertIn("duplicate active or excluded source label", self.validate())

    def test_slim_building_names_and_references_are_validated(self):
        self.data["buildingNames"]["A"] = " "
        self.data["rooms"][0]["buildingCode"] = "B"
        problems = self.validate()
        self.assertIn("buildingNames.A", problems)
        self.assertIn("unknown buildingCode", problems)

    def test_legacy_building_data_and_destination_location_fields_are_rejected(self):
        self.data["buildings"] = []
        self.data["rooms"][0]["buildingId"] = "bldg-a"
        self.data["destinations"][0].update(buildingId="bldg-a", roomCode="A1001")
        problems = self.validate()
        self.assertIn("legacy buildings array", problems)
        self.assertIn("legacy buildingId", problems)
        self.assertIn("roomCode must be derived", problems)

    def test_explicit_null_destination_masks_room_point(self):
        set_point(self.data["rooms"][0])
        self.data["destinations"][1].update(pending())
        self.assertEqual(self.validate(), "")
        validate.validate_launch_ready(self.data)
        self.assertIn("missing coordinates", "\n".join(validate.errors))

    def test_missing_geometry_cannot_be_treated_as_pending(self):
        del self.data["rooms"][0]["geometry"]
        self.assertIn("missing 'geometry'", self.validate())

    def test_legacy_verification_metadata_is_rejected(self):
        self.data["rooms"][0]["coordinateVerification"] = {"status": "verified"}
        self.assertIn("unsupported position field; use geometry only", self.validate())

    def test_points_require_finite_numeric_lon_lat_pairs_and_bounds(self):
        for value in ([181, 0], [0, 91], [True, 0], [float("nan"), 0], [float("inf"), 0],
                      [10 ** 400, 0], ["-81.199", 43.014], [-81.199], [-81.199, 43.014, 0]):
            with self.subTest(value=value):
                validate.errors.clear()
                self.data = catalog()
                self.data["rooms"][0]["geometry"] = {"type": "Point", "coordinates": value}
                self.assertIn("geometry.coordinates", self.validate())

    def test_position_aliases_cannot_duplicate_canonical_geometry(self):
        for field in ("coordinateStatus", "position", "coordinates", "latitude", "longitude", "lat", "lng", "lon"):
            for collection in ("rooms", "destinations"):
                with self.subTest(field=field, collection=collection):
                    validate.errors.clear()
                    self.data = catalog()
                    self.data[collection][0][field] = None
                    self.assertIn("unsupported position field; use geometry only", self.validate())

    def test_parent_cycle_is_rejected(self):
        self.data["destinations"][0]["parentId"] = "child"
        self.assertIn("parent cycle", self.validate())

    def test_conflicting_parent_room_needs_explicit_override(self):
        room = copy.deepcopy(self.data["rooms"][0])
        room.update(id="room-a1002", code="A1002")
        self.data["rooms"].append(room)
        self.data["destinations"][1]["roomId"] = "room-a1002"
        self.assertIn("conflicts with its parent anchor", self.validate())
        validate.errors.clear()
        self.data["destinations"][1].update(pending())
        self.assertEqual(self.validate(), "")

    def test_malformed_hours_shapes_report_problems_without_crashing(self):
        hours = {"timezone": "America/Toronto", "sourceId": "official", "periods": [{
            "label": "Regular", "from": None, "to": None,
            "rawText": "Monday 9 to 4", "weekly": {"mon": [["09:00"]]},
        }]}
        for weekly in ({"mon": [["09:00"]]}, {"mon": [[None, "16:00"]]}, {"mon": 4}, [], 3):
            with self.subTest(weekly=weekly):
                validate.errors.clear()
                self.data = catalog()
                hours["periods"][0]["weekly"] = weekly
                self.data["destinations"][0]["hours"] = copy.deepcopy(hours)
                self.assertTrue(self.validate())

    def test_overlapping_hours_are_rejected_and_adjacent_intervals_are_valid(self):
        self.data["destinations"][0]["hours"] = {
            "timezone": "America/Toronto", "sourceId": "official", "closedOnCollegeClosures": True,
            "periods": [{"label": "Regular", "from": None, "to": None, "rawText": "Published hours",
                         "weekly": {"mon": [["09:00", "12:00"], ["11:00", "16:00"]]}}],
        }
        self.assertIn("overlapping opening intervals", self.validate())
        validate.errors.clear()
        self.data["destinations"][0]["hours"]["periods"][0]["weekly"]["mon"][1][0] = "12:00"
        self.assertEqual(self.validate(), "")

    def test_malformed_metadata_references_and_arrays_report_errors(self):
        self.data.update(version=True, lastVerified="20260925", timezone="wrong", launchGroups=[None])
        self.data["destinations"][0].update(name=" ", roomId=[], sourceIds=[{}], category=[])
        self.data["launchLocations"][0].update(group={}, destinationIds=[{}])
        self.assertTrue(self.validate())

    def test_local_scope_source_must_exist_and_stay_in_data_directory(self):
        with tempfile.TemporaryDirectory(dir=validate.DATA_DIR) as directory, patch.object(validate, "DATA_DIR", Path(directory)):
            self.assertTrue(Path(directory).resolve().is_relative_to(Path(__file__).resolve().parent))
            (Path(directory) / "launch-locations.txt").write_text("Services:\n  Child service\n", encoding="utf-8")
            source = {"title": "Owner's list", "retrieved": "2026-09-25", "purpose": "scope_only",
                      "path": "launch-locations.txt"}
            self.data["sources"]["scope"] = source
            self.assertEqual(self.validate(), "")
            source["path"] = "../outside.txt"
            self.assertIn("stay within the data directory", self.validate())
            validate.errors.clear()
            source["path"] = "missing.txt"
            self.assertIn("source file does not exist", self.validate())

    def test_holiday_nested_types_report_errors_without_crashing(self):
        data = json.loads((validate.DATA_DIR / "campus-holidays.json").read_text(encoding="utf-8"))
        validate.validate_holidays(data)
        self.assertEqual(validate.errors, [])
        data["holidays"][0].update(statutory=[], fanshawe=[], name=[], sourceIds=[{}])
        data["closures"][0]["from"] = {}
        validate.validate_holidays(data)
        self.assertTrue(validate.errors)

    def test_cli_null_roots_report_validation_error(self):
        holidays = json.loads((validate.DATA_DIR / "campus-holidays.json").read_text(encoding="utf-8"))
        for filename in ("campus-places.json", "campus-holidays.json"):
            with self.subTest(filename=filename), tempfile.TemporaryDirectory(dir=validate.DATA_DIR) as directory:
                data_dir = Path(directory)
                self.assertTrue(data_dir.resolve().is_relative_to(Path(__file__).resolve().parent))
                (data_dir / "campus-places.json").write_text(json.dumps(catalog()), encoding="utf-8")
                (data_dir / "campus-holidays.json").write_text(json.dumps(holidays), encoding="utf-8")
                (data_dir / filename).write_text("null", encoding="utf-8")
                output = io.StringIO()
                with patch.object(validate, "DATA_DIR", data_dir), redirect_stdout(output):
                    self.assertEqual(validate.main([]), 1)
                self.assertIn(filename + ": root must be an object", output.getvalue())


if __name__ == "__main__":
    unittest.main()
