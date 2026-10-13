"""Keep the launch selection aligned with the owner's preliminary list."""

import json
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
        actual = [(row["group"], row["sourceLabel"]) for row in catalog["launchLocations"]]
        self.assertEqual(expected, actual)
        self.assertEqual(source_groups, [group["id"] for group in catalog["launchGroups"]])


if __name__ == "__main__":
    unittest.main()
