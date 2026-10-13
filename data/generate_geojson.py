"""Build the launch map from the canonical campus catalog (standard library only).

Run ``python data/generate_geojson.py`` to regenerate the committed preview.
Use ``--check`` to detect stale output, and ``--require-coordinates`` before release.
"""

import argparse
import json
from pathlib import Path


DATA_DIR = Path(__file__).resolve().parent
CATEGORY_MAP = {
    "food": "food",
    "retail": "retail",
    "student_services": "service",
    "health_wellness": "service",
    "academic_office": "service",
}
POSITION_ALIASES = {
    "coordinateVerification", "coordinateStatus", "position", "coordinates",
    "latitude", "longitude", "lat", "lng", "lon",
}


def _index(catalog, key):
    items = catalog.get(key)
    if not isinstance(items, list):
        raise ValueError(f"{key} must be an array")
    result = {}
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            raise ValueError(f"{key} entries must have string IDs")
        item_id = item["id"]
        if item_id in result:
            raise ValueError(f"Duplicate {key} ID: {item_id}")
        result[item_id] = item
    return result


def _reject_coordinate_aliases(anchor):
    aliases = POSITION_ALIASES.intersection(anchor)
    if aliases:
        raise ValueError(f"{anchor.get('id')}: use geometry only; unsupported position fields: {', '.join(sorted(aliases))}")


def _coordinates(anchor):
    """Return a valid Point or null; geometry does not prove positional accuracy."""
    _reject_coordinate_aliases(anchor)
    geometry = anchor.get("geometry")
    if geometry is None:
        return None
    if not isinstance(geometry, dict) or geometry.get("type") != "Point":
        raise ValueError(f"{anchor.get('id')}: map anchors must be GeoJSON Points")
    point = geometry.get("coordinates")
    if (
        not isinstance(point, list)
        or len(point) != 2
        or any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in point)
        or not -180 <= point[0] <= 180
        or not -90 <= point[1] <= 90
    ):
        raise ValueError(f"{anchor.get('id')}: invalid longitude/latitude coordinates")
    return {"type": "Point", "coordinates": list(point)}


def build_feature_collection(catalog, require_coordinates=False):
    """Export each selected destination once, preserving original launch labels.

    Destination geometry, including an explicit null, overrides inherited anchors.
    Building names provide display context only and never supply coordinates.
    """
    if not isinstance(catalog, dict):
        raise ValueError("Catalog root must be an object")
    if type(catalog.get("version")) is not int or catalog.get("version") != 4 or "buildings" in catalog:
        raise ValueError("Expected a version 4 catalog with buildingNames instead of buildings")
    building_names = catalog.get("buildingNames")
    if not isinstance(building_names, dict):
        raise ValueError("buildingNames must be an object of building codes and names")
    for code, name in building_names.items():
        if not isinstance(code, str) or not code or not isinstance(name, str) or not name.strip():
            raise ValueError("buildingNames entries must have nonempty string codes and names")
    rooms = _index(catalog, "rooms")
    destinations = _index(catalog, "destinations")
    groups = _index(catalog, "launchGroups")
    launch_rows = catalog.get("launchLocations")
    if not isinstance(launch_rows, list):
        raise ValueError("launchLocations must be an array")
    excluded_rows = catalog.get("excludedLaunchLocations")
    if not isinstance(excluded_rows, list):
        raise ValueError("excludedLaunchLocations must be an array")

    for room_id, room in rooms.items():
        _reject_coordinate_aliases(room)
        if "geometry" not in room:
            raise ValueError(f"Room {room_id}: missing geometry")
        _coordinates(room)
        code = room.get("buildingCode")
        if not isinstance(code, str) or code not in building_names:
            raise ValueError(f"Room {room_id}: missing buildingCode reference {code!r}")
        if "buildingId" in room:
            raise ValueError(f"Room {room_id}: use buildingCode instead of buildingId")
    for destination_id, destination in destinations.items():
        _reject_coordinate_aliases(destination)
        for field, lookup in (("roomId", rooms), ("buildingCode", building_names), ("parentId", destinations)):
            reference = destination.get(field)
            if reference is not None and (not isinstance(reference, str) or reference not in lookup):
                raise ValueError(f"Destination {destination_id}: missing {field} reference {reference!r}")
        if "buildingId" in destination or "roomCode" in destination:
            raise ValueError(f"Destination {destination_id}: legacy location fields must be derived from roomId")

    resolved = {}
    resolving = []

    def resolve(destination_id):
        if destination_id in resolved:
            return resolved[destination_id]
        if destination_id in resolving:
            cycle = resolving[resolving.index(destination_id):] + [destination_id]
            raise ValueError("Parent cycle: " + " -> ".join(cycle))
        resolving.append(destination_id)
        destination = destinations[destination_id]
        parent_id = destination.get("parentId")
        parent = resolve(parent_id) if parent_id is not None else None
        own_room = rooms.get(destination.get("roomId"))
        room = own_room
        if room is None and "buildingCode" not in destination and parent is not None:
            room = parent["room"]
        building_code = own_room.get("buildingCode") if own_room is not None else destination.get("buildingCode")
        if building_code is None and parent is not None:
            building_code = parent["buildingCode"]

        if "geometry" in destination:
            geometry = _coordinates(destination)
        elif own_room is not None:
            geometry = _coordinates(own_room)
        elif parent is not None:
            geometry = parent["geometry"]
        else:
            geometry = None
        result = {
            "geometry": geometry,
            "room": room,
            "buildingCode": building_code,
        }
        resolving.pop()
        resolved[destination_id] = result
        return result

    # Reject broken references and cycles even when they are outside launch scope.
    for destination_id in destinations:
        resolve(destination_id)

    selected = {}
    unresolved_labels = []
    seen_rows = set()
    for row_number, row in enumerate(launch_rows, 1):
        if not isinstance(row, dict):
            raise ValueError(f"launchLocations[{row_number}] must be an object")
        label = row.get("sourceLabel")
        group = row.get("group")
        resolution_status = row.get("resolutionStatus")
        ids = row.get("destinationIds")
        if not isinstance(label, str) or not label.strip():
            raise ValueError(f"launchLocations[{row_number}] needs a sourceLabel")
        if not isinstance(group, str) or group not in groups:
            raise ValueError(f"Launch item {label!r}: missing group reference {group!r}")
        row_key = (group, label)
        if row_key in seen_rows:
            raise ValueError(f"Duplicate launch source row: {label!r}")
        seen_rows.add(row_key)
        if not isinstance(resolution_status, str) or resolution_status not in {"resolved", "pending"}:
            raise ValueError(f"Launch item {label!r}: invalid resolutionStatus")
        if not isinstance(ids, list) or any(not isinstance(item_id, str) for item_id in ids):
            raise ValueError(f"Launch item {label!r}: destinationIds must be an array of IDs")
        if resolution_status == "resolved" and not ids:
            raise ValueError(f"Launch item {label!r}: a resolved item needs a destination")
        if resolution_status == "pending":
            unresolved_labels.append(label)
        for destination_id in ids:
            if destination_id not in destinations:
                raise ValueError(f"Launch item {label!r}: missing destination reference {destination_id!r}")
            selection = selected.setdefault(destination_id, {"groups": [], "labels": [], "pending": False})
            if group not in selection["groups"]:
                selection["groups"].append(group)
            if label not in selection["labels"]:
                selection["labels"].append(label)
            selection["pending"] = selection["pending"] or resolution_status == "pending"

    for row in excluded_rows:
        if not isinstance(row, dict):
            raise ValueError("Excluded launch entries must be objects")
        label, group = row.get("sourceLabel"), row.get("group")
        if not isinstance(label, str) or not label.strip() or not isinstance(group, str) or group not in groups:
            raise ValueError("Excluded launch entries need a sourceLabel and valid group")
        row_key = (group, label)
        if row_key in seen_rows:
            raise ValueError(f"Duplicate active or excluded launch source row: {label!r}")
        seen_rows.add(row_key)
        if "destinationIds" in row:
            raise ValueError(f"Excluded launch item {label!r} must not select destinations")
        if not isinstance(row.get("decision"), str) or row["decision"] not in {"excluded", "deferred"}:
            raise ValueError(f"Excluded launch item {label!r} needs an excluded/deferred decision")
        if not isinstance(row.get("reason"), str) or not row["reason"].strip():
            raise ValueError(f"Excluded launch item {label!r} needs a reason")

    features = []
    missing_coordinates = []
    for destination_id, selection in selected.items():
        destination = destinations[destination_id]
        location = resolved[destination_id]
        room = location["room"] or {}
        building_code = location["buildingCode"]
        catalog_category = destination.get("category")
        if catalog_category not in CATEGORY_MAP:
            raise ValueError(f"Destination {destination_id}: unsupported category {catalog_category!r}")
        context = []
        if room.get("code"):
            context.append("Room " + room["code"])
        if building_code in building_names:
            context.append(building_names[building_code])
        if room.get("floor") is not None:
            context.append("Floor " + str(room["floor"]))
        if not context and destination.get("locationText"):
            context.append(destination["locationText"])
        name = destination.get("name", destination_id)
        properties = {
            "id": destination_id,
            "name": name,
            "category": CATEGORY_MAP[catalog_category],
            "catalogCategory": catalog_category,
            "description": name + (" — " + ", ".join(context) if context else " — Location awaiting confirmation"),
            "groups": [group_id for group_id in groups if group_id in selection["groups"]],
            "launchLabels": selection["labels"],
            "status": destination.get("status", "unknown"),
            "resolutionStatus": "pending" if selection["pending"] else "resolved",
            "roomCode": room.get("code"),
            "buildingCode": building_code,
            "floor": room.get("floor"),
            "sourceIds": destination.get("sourceIds", []),
        }
        if destination.get("aliases"):
            properties["aliases"] = destination["aliases"]
        child_ids = [
            child_id for child_id, child in destinations.items()
            if child.get("parentId") == destination_id and child.get("category") == "food"
        ]
        if catalog_category == "food" and child_ids:
            properties["childIds"] = child_ids
            properties["markerType"] = "food_court"
        if location["geometry"] is None:
            missing_coordinates.append(destination_id)
        features.append({"type": "Feature", "geometry": location["geometry"], "properties": properties})

    if require_coordinates and (unresolved_labels or missing_coordinates):
        problems = []
        if unresolved_labels:
            problems.append("unresolved launch items: " + ", ".join(unresolved_labels))
        if missing_coordinates:
            problems.append("missing coordinates: " + ", ".join(missing_coordinates))
        raise ValueError("Launch is not ready: " + "; ".join(problems))
    return {"type": "FeatureCollection", "features": features}


def serialize_geojson(collection):
    return json.dumps(collection, ensure_ascii=False, indent=2, allow_nan=False) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DATA_DIR / "campus-places.json")
    parser.add_argument("--output", type=Path, default=DATA_DIR / "launch-locations.geojson")
    parser.add_argument("--check", action="store_true", help="Fail if committed output differs; never write")
    parser.add_argument("--require-coordinates", action="store_true", help="Require valid points for selected destinations; does not prove positional accuracy")
    arguments = parser.parse_args(argv)
    try:
        catalog = json.loads(arguments.input.read_text(encoding="utf-8"))
        collection = build_feature_collection(catalog, require_coordinates=arguments.require_coordinates)
        expected = serialize_geojson(collection)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    if arguments.check:
        try:
            actual = arguments.output.read_text(encoding="utf-8")
        except FileNotFoundError:
            print(f"Missing GeoJSON output: {arguments.output}; regenerate it before committing.")
            return 1
        except OSError as error:
            parser.error(str(error))
        if actual != expected:
            print(f"Stale GeoJSON output: {arguments.output}; regenerate it before committing.")
            return 1
    else:
        try:
            arguments.output.parent.mkdir(parents=True, exist_ok=True)
            arguments.output.write_bytes(expected.encode("utf-8"))
        except OSError as error:
            parser.error(str(error))
    placed = sum(feature["geometry"] is not None for feature in collection["features"])
    total = len(collection["features"])
    unresolved = sum(row["resolutionStatus"] == "pending" for row in catalog["launchLocations"])
    action = "GeoJSON is current" if arguments.check else f"Generated {arguments.output}"
    print(f"{action}: {total} destinations, {placed} points present, {total - placed} points missing, {unresolved} unresolved launch items, {len(catalog['excludedLaunchLocations'])} excluded/deferred items.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
