"""Behavioral checks for launch selection, coordinate inheritance, and freshness."""

import copy
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

import generate_geojson


def point(longitude=-81.2, latitude=43.0):
    return {"type": "Point", "coordinates": [longitude, latitude]}


def verification(status="pending"):
    return {
        "status": status,
        "method": "manual_review" if status == "verified" else None,
        "verifiedAt": "2020-01-01" if status == "verified" else None,
        "reference": "Official floor plan" if status == "verified" else None,
    }


def catalog_fixture():
    return {
        "version": 2,
        "buildings": [{
            "id": "building-e", "code": "E", "name": "E Building",
            "geometry": point(), "coordinateVerification": verification("verified"),
        }],
        "rooms": [{
            "id": "room-e2020", "code": "E2020", "buildingId": "building-e", "floor": 2,
            "geometry": None, "coordinateVerification": verification(),
        }],
        "destinations": [
            {
                "id": "fancard", "name": "FANCard, Parking and Lockers", "category": "student_services",
                "roomId": "room-e2020", "status": "open", "sourceIds": ["campus-map"],
                "aliases": ["Parking Office"],
            },
            {
                "id": "food-court", "name": "Food Court", "category": "food",
                "roomId": "room-e2020", "status": "open", "sourceIds": ["campus-map"],
            },
            {
                "id": "coffee", "name": "Coffee", "category": "food",
                "parentId": "food-court", "status": "open", "sourceIds": ["campus-map"],
            },
        ],
        "launchGroups": [
            {"id": "food", "label": "Food services"},
            {"id": "student-services", "label": "Student Services"},
            {"id": "retail", "label": "Retail"},
        ],
        "launchLocations": [{
            "sourceLabel": "FanCard Service", "group": "student-services",
            "destinationIds": ["fancard"], "resolutionStatus": "resolved",
        }],
    }


class LaunchGeoJSONTests(unittest.TestCase):
    def setUp(self):
        self.catalog = catalog_fixture()

    def feature(self, destination_id="fancard", require_verified=False):
        collection = generate_geojson.build_feature_collection(self.catalog, require_verified)
        return next(feature for feature in collection["features"] if feature["properties"]["id"] == destination_id)

    def test_catalog_root_must_be_an_object(self):
        for value in (None, [], "catalog", 42):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "Catalog root must be an object"):
                    generate_geojson.build_feature_collection(value)

    def test_room_without_coordinates_never_uses_verified_building_centroid(self):
        feature = self.feature()
        self.assertIsNone(feature["geometry"])
        properties = feature["properties"]
        self.assertEqual(properties["coordinateStatus"], "pending")
        self.assertEqual((properties["roomCode"], properties["buildingCode"], properties["floor"]), ("E2020", "E", 2))
        self.assertEqual(properties["category"], "service")
        self.assertEqual(properties["catalogCategory"], "student_services")
        self.assertIn("E2020", properties["description"])

    def test_food_court_uses_room_anchor_without_exporting_vendor_markers(self):
        self.catalog["rooms"][0].update(geometry=point(-81.21, 43.01), coordinateVerification=verification("verified"))
        self.catalog["launchLocations"] = [{
            "sourceLabel": "B Food Court", "group": "food",
            "destinationIds": ["food-court"], "resolutionStatus": "resolved",
        }]
        collection = generate_geojson.build_feature_collection(self.catalog)
        self.assertEqual(len(collection["features"]), 1)
        feature = collection["features"][0]
        self.assertEqual(feature["geometry"], point(-81.21, 43.01))
        self.assertEqual(feature["properties"]["childIds"], ["coffee"])
        self.assertEqual(feature["properties"]["markerType"], "food_court")

    def test_nested_parent_location_resolves_room_context(self):
        self.catalog["destinations"][0].pop("roomId")
        self.catalog["destinations"][0]["parentId"] = "coffee"
        self.catalog["rooms"][0].update(geometry=point(), coordinateVerification=verification("verified"))
        feature = self.feature(require_verified=True)
        self.assertEqual(feature["geometry"], point())
        self.assertEqual(feature["properties"]["roomCode"], "E2020")

    def test_shared_office_is_deduplicated_and_keeps_labels_and_group_order(self):
        self.catalog["launchLocations"] = [
            {"sourceLabel": "Retail counter", "group": "retail", "destinationIds": ["fancard"], "resolutionStatus": "resolved"},
            {"sourceLabel": "Parking Office", "group": "student-services", "destinationIds": ["fancard"], "resolutionStatus": "pending"},
            {"sourceLabel": "FanCard Service", "group": "student-services", "destinationIds": ["fancard"], "resolutionStatus": "resolved"},
        ]
        collection = generate_geojson.build_feature_collection(self.catalog)
        self.assertEqual(len(collection["features"]), 1)
        properties = collection["features"][0]["properties"]
        self.assertEqual(properties["groups"], ["student-services", "retail"])
        self.assertEqual(properties["launchLabels"], ["Retail counter", "Parking Office", "FanCard Service"])
        self.assertEqual(properties["resolutionStatus"], "pending")

    def test_pending_raw_point_is_masked(self):
        self.catalog["rooms"][0]["geometry"] = point()
        self.assertIsNone(self.feature()["geometry"])
        self.catalog["destinations"][0].update(geometry=point(-81.3, 43.1), coordinateVerification=verification())
        self.assertIsNone(self.feature()["geometry"])

    def test_manual_verified_point_takes_precedence_over_room(self):
        self.catalog["rooms"][0].update(geometry=point(), coordinateVerification=verification("verified"))
        self.catalog["destinations"][0].update(geometry=point(-81.3, 43.1), coordinateVerification=verification("verified"))
        self.assertEqual(self.feature(require_verified=True)["geometry"], point(-81.3, 43.1))

    def test_verified_flag_without_checking_evidence_is_rejected(self):
        cases = [
            ("method", None, "nonempty method"),
            ("method", "   ", "nonempty method"),
            ("reference", None, "nonempty reference"),
            ("reference", "", "nonempty reference"),
            ("verifiedAt", None, "verifiedAt must be an ISO date"),
            ("verifiedAt", "2020/01/01", "verifiedAt must be an ISO date"),
            ("verifiedAt", "20200101", "verifiedAt must be an ISO date"),
            ("verifiedAt", "9999-12-31", "verifiedAt cannot be in the future"),
        ]
        for field, value, message in cases:
            with self.subTest(field=field, value=value):
                catalog = copy.deepcopy(self.catalog)
                evidence = verification("verified")
                evidence[field] = value
                catalog["destinations"][0].update(geometry=point(), coordinateVerification=evidence)
                with self.assertRaisesRegex(ValueError, message):
                    generate_geojson.build_feature_collection(catalog)

    def test_verified_flag_without_geometry_is_rejected(self):
        self.catalog["destinations"][0].update(geometry=None, coordinateVerification=verification("verified"))
        with self.assertRaisesRegex(ValueError, "verified coordinates need a non-null Point geometry"):
            self.feature()

    def test_explicit_null_override_blocks_verified_inheritance(self):
        self.catalog["rooms"][0].update(geometry=point(), coordinateVerification=verification("verified"))
        self.catalog["destinations"][0].update(geometry=None, coordinateVerification=verification())
        self.assertIsNone(self.feature()["geometry"])
        with self.assertRaisesRegex(ValueError, "unverified coordinates: fancard"):
            self.feature(require_verified=True)

    def test_roomless_destination_can_use_verified_building(self):
        destination = self.catalog["destinations"][0]
        destination.pop("roomId")
        destination["buildingId"] = "building-e"
        feature = self.feature(require_verified=True)
        self.assertEqual(feature["geometry"], point())
        self.assertIsNone(feature["properties"]["roomCode"])

    def test_cycles_are_rejected_even_outside_launch_selection(self):
        self.catalog["destinations"][1]["parentId"] = "coffee"
        with self.assertRaisesRegex(ValueError, "Parent cycle: food-court -> coffee -> food-court"):
            self.feature()

    def test_missing_references_are_rejected(self):
        cases = [("roomId", "missing-room"), ("parentId", "missing-parent"), ("buildingId", "missing-building")]
        for field, value in cases:
            with self.subTest(field=field):
                catalog = copy.deepcopy(self.catalog)
                catalog["destinations"][0][field] = value
                with self.assertRaisesRegex(ValueError, "missing " + field + " reference"):
                    generate_geojson.build_feature_collection(catalog)
        self.catalog["launchLocations"][0]["destinationIds"] = ["missing-destination"]
        with self.assertRaisesRegex(ValueError, "missing destination reference"):
            self.feature()

    def test_require_verified_blocks_unresolved_item_with_no_destination(self):
        self.catalog["rooms"][0].update(geometry=point(), coordinateVerification=verification("verified"))
        self.catalog["launchLocations"].append({
            "sourceLabel": "Foot Patrol", "group": "student-services",
            "destinationIds": [], "resolutionStatus": "pending",
        })
        self.assertEqual(len(generate_geojson.build_feature_collection(self.catalog)["features"]), 1)
        with self.assertRaisesRegex(ValueError, "unresolved launch items: Foot Patrol"):
            self.feature(require_verified=True)

    def test_check_accepts_checkout_newlines_and_detects_stale_content_without_writing(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            input_path = Path(directory) / "catalog.json"
            output_path = Path(directory) / "launch.geojson"
            input_path.write_text(json.dumps(self.catalog), encoding="utf-8")
            arguments = ["--input", str(input_path), "--output", str(output_path)]
            with redirect_stdout(io.StringIO()):
                self.assertEqual(generate_geojson.main(arguments + ["--check"]), 1)
                self.assertFalse(output_path.exists())
                self.assertEqual(generate_geojson.main(arguments), 0)
                expected = output_path.read_bytes()
                self.assertEqual(generate_geojson.main(arguments + ["--check"]), 0)
                output_path.write_bytes(expected.replace(b"\n", b"\r\n"))
                self.assertEqual(generate_geojson.main(arguments + ["--check"]), 0)
                # Change actual feature content rather than just checkout newline style.
                output_path.write_bytes(expected.replace(b'"floor": 2', b'"floor": 9'))
                stale = output_path.read_bytes()
                self.assertEqual(generate_geojson.main(arguments + ["--check"]), 1)
                self.assertEqual(output_path.read_bytes(), stale)
                self.assertEqual(generate_geojson.main(arguments), 0)
                self.assertEqual(output_path.read_bytes(), expected)


if __name__ == "__main__":
    unittest.main()
