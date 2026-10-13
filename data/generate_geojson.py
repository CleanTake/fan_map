"""Build the launch map from the canonical campus catalog (standard library only).

Run ``python data/generate_geojson.py`` to regenerate the committed preview.
Use ``--check`` to detect stale output, and ``--require-verified`` before release.
"""

import argparse
import json
from datetime import date
from pathlib import Path


DATA_DIR = Path(__file__).resolve().parent
CATEGORY_MAP = {
    "food": "food",
    "retail": "retail",
    "student_services": "service",
    "health_wellness": "service",
    "academic_office": "service",
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


def _coordinates(anchor):
    """Return only a verified point; pending raw coordinates remain unpublished."""
    geometry = anchor.get("geometry")
    verification = anchor.get("coordinateVerification", {})
    if not isinstance(verification, dict):
        raise ValueError(f"{anchor.get('id')}: coordinateVerification must be an object")
    status = verification.get("status", "pending")
    if status not in {"pending", "verified"}:
        raise ValueError(f"{anchor.get('id')}: invalid coordinate verification status")
    if status == "verified":
        for field in ("method", "reference"):
            value = verification.get(field)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{anchor.get('id')}: verified coordinates need a nonempty {field}")
        verified_at = verification.get("verifiedAt")
        try:
            checked_date = date.fromisoformat(verified_at)
        except (TypeError, ValueError):
            raise ValueError(f"{anchor.get('id')}: verifiedAt must be an ISO date (YYYY-MM-DD)") from None
        if checked_date.isoformat() != verified_at:
            raise ValueError(f"{anchor.get('id')}: verifiedAt must be an ISO date (YYYY-MM-DD)")
        if checked_date > date.today():
            raise ValueError(f"{anchor.get('id')}: verifiedAt cannot be in the future")
        if geometry is None:
            raise ValueError(f"{anchor.get('id')}: verified coordinates need a non-null Point geometry")
    if geometry is None:
        return None, "pending"
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
    if status != "verified":
        return None, "pending"
    return {"type": "Point", "coordinates": list(point)}, "verified"


def build_feature_collection(catalog, require_verified=False):
    """Export each selected destination once, preserving original launch labels.

    Destination geometry, including an explicit null, overrides inherited anchors.
    A room is its own anchor and never falls back to its building's centroid.
    """
    if not isinstance(catalog, dict):
        raise ValueError("Catalog root must be an object")
    buildings = _index(catalog, "buildings")
    rooms = _index(catalog, "rooms")
    destinations = _index(catalog, "destinations")
    groups = _index(catalog, "launchGroups")
    launch_rows = catalog.get("launchLocations")
    if not isinstance(launch_rows, list):
        raise ValueError("launchLocations must be an array")

    for room_id, room in rooms.items():
        if room.get("buildingId") not in buildings:
            raise ValueError(f"Room {room_id}: missing building reference {room.get('buildingId')!r}")
    for destination_id, destination in destinations.items():
        for field, lookup in (("roomId", rooms), ("buildingId", buildings), ("parentId", destinations)):
            reference = destination.get(field)
            if reference is not None and reference not in lookup:
                raise ValueError(f"Destination {destination_id}: missing {field} reference {reference!r}")
        if ("geometry" in destination) != ("coordinateVerification" in destination):
            raise ValueError(f"Destination {destination_id}: geometry and coordinateVerification must occur together")

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
        if room is None and "buildingId" not in destination and parent is not None:
            room = parent["room"]
        building_id = own_room.get("buildingId") if own_room is not None else destination.get("buildingId")
        building = buildings.get(building_id)
        if building is None and parent is not None:
            building = parent["building"]

        if "geometry" in destination:
            geometry, coordinate_status = _coordinates(destination)
        elif own_room is not None:
            geometry, coordinate_status = _coordinates(own_room)
        elif parent is not None:
            geometry, coordinate_status = parent["geometry"], parent["coordinateStatus"]
        elif building is not None:
            geometry, coordinate_status = _coordinates(building)
        else:
            geometry, coordinate_status = None, "pending"
        result = {
            "geometry": geometry,
            "coordinateStatus": coordinate_status,
            "room": room,
            "building": building,
        }
        resolving.pop()
        resolved[destination_id] = result
        return result

    # Reject broken references and cycles even when they are outside launch scope.
    for destination_id in destinations:
        resolve(destination_id)

    selected = {}
    unresolved_labels = []
    for row_number, row in enumerate(launch_rows, 1):
        if not isinstance(row, dict):
            raise ValueError(f"launchLocations[{row_number}] must be an object")
        label = row.get("sourceLabel")
        group = row.get("group")
        resolution_status = row.get("resolutionStatus")
        ids = row.get("destinationIds")
        if not isinstance(label, str) or not label.strip():
            raise ValueError(f"launchLocations[{row_number}] needs a sourceLabel")
        if group not in groups:
            raise ValueError(f"Launch item {label!r}: missing group reference {group!r}")
        if resolution_status not in {"resolved", "pending"}:
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

    features = []
    pending_coordinates = []
    for destination_id, selection in selected.items():
        destination = destinations[destination_id]
        location = resolved[destination_id]
        room = location["room"] or {}
        building = location["building"] or {}
        catalog_category = destination.get("category")
        if catalog_category not in CATEGORY_MAP:
            raise ValueError(f"Destination {destination_id}: unsupported category {catalog_category!r}")
        context = []
        if room.get("code"):
            context.append("Room " + room["code"])
        if building.get("name"):
            context.append(building["name"])
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
            "coordinateStatus": location["coordinateStatus"],
            "resolutionStatus": "pending" if selection["pending"] else "resolved",
            "roomCode": room.get("code"),
            "buildingCode": building.get("code"),
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
        if location["coordinateStatus"] != "verified":
            pending_coordinates.append(destination_id)
        features.append({"type": "Feature", "geometry": location["geometry"], "properties": properties})

    if require_verified and (unresolved_labels or pending_coordinates):
        problems = []
        if unresolved_labels:
            problems.append("unresolved launch items: " + ", ".join(unresolved_labels))
        if pending_coordinates:
            problems.append("unverified coordinates: " + ", ".join(pending_coordinates))
        raise ValueError("Launch is not ready: " + "; ".join(problems))
    return {"type": "FeatureCollection", "features": features}


def serialize_geojson(collection):
    return json.dumps(collection, ensure_ascii=False, indent=2, allow_nan=False) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DATA_DIR / "campus-places.json")
    parser.add_argument("--output", type=Path, default=DATA_DIR / "launch-locations.geojson")
    parser.add_argument("--check", action="store_true", help="Fail if committed output differs; never write")
    parser.add_argument("--require-verified", action="store_true", help="Reject unresolved launch items or coordinates")
    arguments = parser.parse_args(argv)
    try:
        catalog = json.loads(arguments.input.read_text(encoding="utf-8"))
        collection = build_feature_collection(catalog, require_verified=arguments.require_verified)
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
    verified = sum(feature["properties"]["coordinateStatus"] == "verified" for feature in collection["features"])
    total = len(collection["features"])
    unresolved = sum(row["resolutionStatus"] == "pending" for row in catalog["launchLocations"])
    action = "GeoJSON is current" if arguments.check else f"Generated {arguments.output}"
    print(f"{action}: {total} destinations, {verified} verified points, {total - verified} pending points, {unresolved} unresolved launch items.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
