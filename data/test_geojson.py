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


def catalog_fixture():
    return {
        "version": 4,
        "buildingNames": {"E": "E Building"},
        "rooms": [{
            "id": "room-e2020", "code": "E2020", "buildingCode": "E", "floor": 2,
            "geometry": None,
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
        "excludedLaunchLocations": [],
    }


class LaunchGeoJSONTests(unittest.TestCase):
    def setUp(self):
        self.catalog = catalog_fixture()

    def feature(self, destination_id="fancard", require_coordinates=False):
        collection = generate_geojson.build_feature_collection(self.catalog, require_coordinates)
        return next(feature for feature in collection["features"] if feature["properties"]["id"] == destination_id)

    def test_catalog_root_must_be_an_object(self):
        for value in (None, [], "catalog", 42):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "Catalog root must be an object"):
                    generate_geojson.build_feature_collection(value)

    def test_room_without_coordinates_remains_pending_with_building_name_context(self):
        feature = self.feature()
        self.assertIsNone(feature["geometry"])
        properties = feature["properties"]
        self.assertNotIn("coordinateStatus", properties)
        self.assertEqual((properties["roomCode"], properties["buildingCode"], properties["floor"]), ("E2020", "E", 2))
        self.assertEqual(properties["category"], "service")
        self.assertEqual(properties["catalogCategory"], "student_services")
        self.assertIn("E2020", properties["description"])

    def test_food_court_uses_room_anchor_without_exporting_vendor_markers(self):
        self.catalog["rooms"][0]["geometry"] = point(-81.21, 43.01)
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
        self.catalog["rooms"][0]["geometry"] = point()
        feature = self.feature(require_coordinates=True)
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

    def test_valid_point_is_exported_directly_without_metadata(self):
        self.catalog["rooms"][0]["geometry"] = point()
        self.assertEqual(self.feature(require_coordinates=True)["geometry"], point())
        self.assertNotIn("coordinateStatus", self.feature()["properties"])

    def test_explicit_point_takes_precedence_over_room(self):
        self.catalog["rooms"][0]["geometry"] = point()
        self.catalog["destinations"][0]["geometry"] = point(-81.3, 43.1)
        self.assertEqual(self.feature(require_coordinates=True)["geometry"], point(-81.3, 43.1))

    def test_invalid_geometry_is_rejected_without_metadata(self):
        coordinates = ([181, 0], [0, 91], [True, 0], [float("nan"), 0], [float("inf"), 0],
                       [10 ** 400, 0], ["-81.2", 43], [-81.2], [-81.2, 43, 0])
        for value in coordinates:
            with self.subTest(value=value):
                catalog = copy.deepcopy(self.catalog)
                catalog["rooms"][0]["geometry"] = {"type": "Point", "coordinates": value}
                with self.assertRaisesRegex(ValueError, "invalid longitude/latitude coordinates"):
                    generate_geojson.build_feature_collection(catalog)
        self.catalog["rooms"][0]["geometry"] = {"type": "LineString", "coordinates": []}
        with self.assertRaisesRegex(ValueError, "map anchors must be GeoJSON Points"):
            self.feature()

    def test_legacy_verification_and_position_aliases_are_rejected(self):
        for field in ("coordinateVerification", "coordinateStatus", "position", "coordinates", "latitude", "longitude", "lat", "lng", "lon"):
            for collection in ("rooms", "destinations"):
                with self.subTest(field=field, collection=collection):
                    catalog = copy.deepcopy(self.catalog)
                    catalog[collection][0][field] = None
                    with self.assertRaisesRegex(ValueError, "use geometry only"):
                        generate_geojson.build_feature_collection(catalog)

    def test_explicit_null_override_blocks_point_inheritance(self):
        self.catalog["rooms"][0]["geometry"] = point()
        self.catalog["destinations"][0]["geometry"] = None
        self.assertIsNone(self.feature()["geometry"])
        with self.assertRaisesRegex(ValueError, "missing coordinates: fancard"):
            self.feature(require_coordinates=True)

    def test_roomless_building_context_never_supplies_coordinates(self):
        destination = self.catalog["destinations"][0]
        destination.pop("roomId")
        destination["buildingCode"] = "E"
        feature = self.feature()
        self.assertIsNone(feature["geometry"])
        self.assertEqual(feature["properties"]["buildingCode"], "E")
        self.assertIn("E Building", feature["properties"]["description"])
        self.assertIsNone(feature["properties"]["roomCode"])
        with self.assertRaisesRegex(ValueError, "missing coordinates"):
            self.feature(require_coordinates=True)

    def test_legacy_building_geometry_catalog_is_rejected(self):
        self.catalog["buildings"] = [{"id": "building-e", "geometry": point()}]
        with self.assertRaisesRegex(ValueError, "buildingNames instead of buildings"):
            self.feature()

    def test_deliberate_exclusions_do_not_block_coordinate_readiness(self):
        self.catalog["rooms"][0]["geometry"] = point()
        self.catalog["excludedLaunchLocations"] = [{
            "sourceLabel": "Foot Patrol", "group": "student-services", "decision": "deferred",
            "reason": "Current service identity is unconfirmed.",
        }]
        self.assertEqual(self.feature(require_coordinates=True)["geometry"], point())

    def test_active_and_excluded_source_rows_cannot_overlap(self):
        self.catalog["excludedLaunchLocations"] = [{
            "sourceLabel": "FanCard Service", "group": "student-services", "decision": "excluded",
            "reason": "Out of scope.",
        }]
        with self.assertRaisesRegex(ValueError, "Duplicate active or excluded launch source row"):
            self.feature()

    def test_cycles_are_rejected_even_outside_launch_selection(self):
        self.catalog["destinations"][1]["parentId"] = "coffee"
        with self.assertRaisesRegex(ValueError, "Parent cycle: food-court -> coffee -> food-court"):
            self.feature()

    def test_missing_references_are_rejected(self):
        cases = [("roomId", "missing-room"), ("parentId", "missing-parent"), ("buildingCode", "MISSING")]
        for field, value in cases:
            with self.subTest(field=field):
                catalog = copy.deepcopy(self.catalog)
                catalog["destinations"][0][field] = value
                with self.assertRaisesRegex(ValueError, "missing " + field + " reference"):
                    generate_geojson.build_feature_collection(catalog)
        self.catalog["launchLocations"][0]["destinationIds"] = ["missing-destination"]
        with self.assertRaisesRegex(ValueError, "missing destination reference"):
            self.feature()

    def test_require_coordinates_blocks_unresolved_item_with_no_destination(self):
        self.catalog["rooms"][0]["geometry"] = point()
        self.catalog["launchLocations"].append({
            "sourceLabel": "Foot Patrol", "group": "student-services",
            "destinationIds": [], "resolutionStatus": "pending",
        })
        self.assertEqual(len(generate_geojson.build_feature_collection(self.catalog)["features"]), 1)
        with self.assertRaisesRegex(ValueError, "unresolved launch items: Foot Patrol"):
            self.feature(require_coordinates=True)

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
