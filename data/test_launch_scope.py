"""Keep the launch selection aligned with the owner's preliminary list."""

import json
from collections import Counter
from pathlib import Path
import unittest


DATA_DIR = Path(__file__).resolve().parent


class LaunchScopeTests(unittest.TestCase):
    def test_every_named_source_entry_has_an_explicit_mapping(self):
        catalog = json.loads((DATA_DIR / "campus-places.json").read_text(encoding="utf-8"))
        groups = {group["label"]: group["id"] for group in catalog["launchGroups"]}
        expected = []
        source_groups = []
        group = None
        for line in (DATA_DIR / "launch-locations.txt").read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            if not line[0].isspace():
                label = line.strip().rstrip(":")
                self.assertIn(label, groups)
                group = groups[label]
                source_groups.append(group)
            else:
                self.assertIsNotNone(group)
                expected.append((group, line.strip()))
        active = [(row["group"], row["sourceLabel"]) for row in catalog["launchLocations"]]
        excluded = [(row["group"], row["sourceLabel"]) for row in catalog["excludedLaunchLocations"]]
        self.assertEqual(Counter(expected), Counter(active + excluded))
        self.assertTrue(set(active).isdisjoint(excluded))
        self.assertEqual([entry for entry in expected if entry in set(active)], active)
        self.assertEqual([entry for entry in expected if entry in set(excluded)], excluded)
        for row in catalog["excludedLaunchLocations"]:
            self.assertIn(row["decision"], {"excluded", "deferred"})
            self.assertTrue(row["reason"].strip())
            self.assertNotIn("destinationIds", row)
        self.assertEqual(source_groups, [group["id"] for group in catalog["launchGroups"]])

    def test_only_selected_locations_and_confirmed_food_vendors_remain(self):
        catalog = json.loads((DATA_DIR / "campus-places.json").read_text(encoding="utf-8"))
        selected = {did for row in catalog["launchLocations"] for did in row["destinationIds"]}
        destinations = {item["id"]: item for item in catalog["destinations"]}
        vendors = {item["id"] for item in destinations.values() if item.get("parentId")}
        self.assertEqual(len(catalog["launchLocations"]), 25)
        self.assertEqual(len(selected), 25)
        self.assertEqual(len(vendors), 6)
        self.assertEqual(set(destinations), selected | vendors)
        for vendor_id in vendors:
            self.assertIn(destinations[vendor_id]["parentId"], selected)
            self.assertEqual(destinations[vendor_id]["status"], "open")
        self.assertNotIn("pharmacy", destinations)
        self.assertNotIn("d-cafe-on-the-go", destinations)
        variety = next(row for row in catalog["launchLocations"] if row["sourceLabel"] == "Variety Store (both locations)")
        self.assertEqual(variety["destinationIds"], ["variety-store"])
        self.assertIn("deferred", variety["notes"])

    def test_only_referenced_room_anchors_and_building_labels_remain(self):
        catalog = json.loads((DATA_DIR / "campus-places.json").read_text(encoding="utf-8"))
        rooms = {room["id"]: room for room in catalog["rooms"]}
        referenced = {item["roomId"] for item in catalog["destinations"] if item.get("roomId")}
        self.assertEqual(set(rooms), referenced)
        self.assertEqual(len(rooms), 23)
        self.assertNotIn("buildings", catalog)
        self.assertEqual(set(catalog["buildingNames"]), {room["buildingCode"] for room in rooms.values()})
        self.assertEqual(len(catalog["buildingNames"]), 9)
        for room in rooms.values():
            self.assertNotIn("buildingId", room)
        destinations = {item["id"]: item for item in catalog["destinations"]}
        self.assertEqual(destinations["financial-aid-student-awards"]["roomId"], destinations["office-of-the-registrar"]["roomId"])
        self.assertEqual(destinations["fowler-kennedy-sport-medicine"]["roomId"], destinations["student-health-services"]["roomId"])


if __name__ == "__main__":
    unittest.main()
