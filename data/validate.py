"""Validate the curated catalog; add --require-launch-ready before publication."""

import argparse
import json
import math
import re
import sys
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DATA_DIR = Path(__file__).resolve().parent
BUILDING_CATEGORIES = {
    "academic", "administrative", "student_services", "student_life", "food", "retail",
    "recreational", "health_wellness", "library", "residence", "information", "utility",
    "unclassified",
}
DESTINATION_CATEGORIES = {"food", "retail", "student_services", "academic_office", "health_wellness"}
DESTINATION_STATUSES = {"open", "closed_temporarily", "closed_permanently", "unknown"}
DAYS = {"mon", "tue", "wed", "thu", "fri", "sat", "sun"}
MONDAY_HOLIDAYS = {
    "Labour Day", "Thanksgiving Day", "Family Day", "Easter Monday", "Victoria Day", "Civic Holiday",
}
ID_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
ROOM_CODE_RE = re.compile(r"^([A-Z]{1,3}?)(\d)\d{2,3}(-\d{1,2})?$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
errors = []


def error(where, message):
    errors.append(f"{where}: {message}")


def today():
    try:
        return datetime.now(ZoneInfo("America/Toronto")).date()
    except ZoneInfoNotFoundError:
        return date.today()


def load(name):
    try:
        with (DATA_DIR / name).open(encoding="utf-8") as handle:
            value = json.load(handle)
        if value is None:
            error(name, "root must be an object, not null")
        return value
    except (OSError, ValueError) as exc:
        error(name, f"cannot load ({exc})")
        return None


def object_value(where, value):
    if not isinstance(value, dict):
        error(where, "must be an object")
        return {}
    return value


def array_value(where, value):
    if not isinstance(value, list):
        error(where, "must be an array")
        return []
    return value


def nonempty(where, value):
    if not isinstance(value, str) or not value.strip():
        error(where, "must be a non-empty string")
        return False
    return True


def enum_value(where, value, values):
    if not isinstance(value, str) or value not in values:
        error(where, f"invalid value {value!r}; expected one of {', '.join(sorted(values))}")
        return False
    return True


def parse_date(where, value, nullable=False, nonfuture=False):
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not DATE_RE.fullmatch(value):
        error(where, f"invalid ISO date {value!r}")
        return None
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        error(where, f"invalid ISO date {value!r}")
        return None
    if nonfuture and parsed > today():
        error(where, "must not be in the future")
    return parsed


def require(where, obj, *keys):
    if not isinstance(obj, dict):
        error(where, "must be an object")
        return False
    missing = [key for key in keys if key not in obj]
    for key in missing:
        error(where, f"missing '{key}'")
    return not missing


def check_ids(label, items, id_pattern=ID_RE):
    ids = {}
    for index, item in enumerate(array_value(label, items)):
        where = f"{label}[{index}]"
        if not isinstance(item, dict):
            error(where, "must be an object")
            continue
        item_id = item.get("id")
        if not isinstance(item_id, str) or not id_pattern.fullmatch(item_id):
            error(where, f"invalid id {item_id!r}")
        elif item_id in ids:
            error(where, f"duplicate id '{item_id}'")
        else:
            ids[item_id] = item
    return ids


def check_sources(where, item, sources):
    source_ids = array_value(where + ".sourceIds", item.get("sourceIds"))
    if not source_ids:
        error(where, "needs at least one sourceId")
    seen = set()
    for sid in source_ids:
        if not isinstance(sid, str) or sid not in sources:
            error(where, f"unknown sourceId {sid!r}")
        elif sid in seen:
            error(where, f"duplicate sourceId '{sid}'")
        else:
            seen.add(sid)


def check_source_table(file, sources):
    for sid, source in sources.items():
        where = f"{file} sources.{sid}"
        if not isinstance(sid, str) or not ID_RE.fullmatch(sid):
            error(where, "invalid source id")
        if not isinstance(source, dict):
            error(where, "must be an object")
            continue
        require(where, source, "title", "retrieved")
        nonempty(where + ".title", source.get("title"))
        parse_date(where + ".retrieved", source.get("retrieved"))
        if ("url" in source) == ("path" in source):
            error(where, "must provide exactly one of url or local path")
        if "url" in source:
            value = source["url"]
            try:
                parsed = urlsplit(value) if isinstance(value, str) else None
                valid = parsed and parsed.scheme == "https" and parsed.netloc
            except ValueError:
                valid = False
            if not valid:
                error(where, "url must be an absolute https URL")
        if "path" in source:
            value = source["path"]
            if nonempty(where + ".path", value):
                try:
                    relative = Path(value)
                    target = (DATA_DIR / relative).resolve()
                    if relative.is_absolute() or not target.is_relative_to(DATA_DIR.resolve()):
                        error(where, "local path must stay within the data directory")
                    elif not target.is_file():
                        error(where, "local source file does not exist")
                except (OSError, ValueError):
                    error(where, "invalid local source path")
            if source.get("purpose") != "scope_only":
                error(where, "a local source must have purpose 'scope_only'")


def check_coordinates(where, item, required=False):
    if required or "geometry" in item or "coordinateVerification" in item:
        require(where, item, "geometry", "coordinateVerification")
    else:
        return
    geometry = item.get("geometry")
    valid_point = False
    if geometry is not None:
        if not isinstance(geometry, dict):
            error(where + ".geometry", "must be a GeoJSON Point object or null")
        elif geometry.get("type") != "Point":
            error(where + ".geometry", "only GeoJSON Point geometry is supported")
        else:
            coordinates = geometry.get("coordinates")
            if not isinstance(coordinates, list) or len(coordinates) != 2:
                error(where + ".geometry.coordinates", "must be [longitude, latitude]")
            elif not all(type(value) in (int, float) and (type(value) is int or math.isfinite(value)) for value in coordinates):
                error(where + ".geometry.coordinates", "must contain two finite numbers")
            elif not (-180 <= coordinates[0] <= 180 and -90 <= coordinates[1] <= 90):
                error(where + ".geometry.coordinates", "longitude/latitude are outside geographic bounds")
            else:
                valid_point = True
    verification = object_value(where + ".coordinateVerification", item.get("coordinateVerification"))
    require(where + ".coordinateVerification", verification, "status", "method", "verifiedAt", "reference")
    status = verification.get("status")
    enum_value(where + ".coordinateVerification.status", status, {"pending", "verified"})
    for field in ("method", "reference"):
        if verification.get(field) is not None:
            nonempty(where + ".coordinateVerification." + field, verification[field])
    if status == "verified":
        if not valid_point:
            error(where, "verified coordinates require a valid non-null Point")
        nonempty(where + ".coordinateVerification.method", verification.get("method"))
        nonempty(where + ".coordinateVerification.reference", verification.get("reference"))
        parse_date(where + ".coordinateVerification.verifiedAt", verification.get("verifiedAt"), nonfuture=True)
    elif verification.get("verifiedAt") is not None:
        error(where + ".coordinateVerification.verifiedAt", "must be null until coordinates are verified")


def check_hours(where, hours, sources):
    if not isinstance(hours, dict):
        error(where, "must be an object")
        return
    require(where, hours, "timezone", "sourceId", "periods")
    if hours.get("timezone") != "America/Toronto":
        error(where, "timezone must be America/Toronto")
    sid = hours.get("sourceId")
    if not isinstance(sid, str) or sid not in sources:
        error(where, f"unknown sourceId {sid!r}")
    if "closedOnCollegeClosures" in hours and type(hours["closedOnCollegeClosures"]) is not bool:
        error(where, "closedOnCollegeClosures must be a boolean")
    periods = array_value(where + ".periods", hours.get("periods"))
    if not periods:
        error(where, "needs at least one hours period")
    dated, undated = [], 0
    for index, period in enumerate(periods):
        pw = f"{where}.periods[{index}]"
        if not isinstance(period, dict):
            error(pw, "must be an object")
            continue
        require(pw, period, "label", "from", "to", "weekly", "rawText")
        nonempty(pw + ".label", period.get("label"))
        nonempty(pw + ".rawText", period.get("rawText"))
        start = parse_date(pw + ".from", period.get("from"), nullable=True)
        end = parse_date(pw + ".to", period.get("to"), nullable=True)
        if period.get("from") is None and period.get("to") is None:
            undated += 1
        elif (period.get("from") is None) != (period.get("to") is None):
            error(pw, "from and to must both be set or both be null")
        if start and end:
            if start > end:
                error(pw, "from is after to")
            dated.append((start, end, pw))
        weekly = period.get("weekly")
        if weekly is None:
            continue  # Ambiguous published hours remain in rawText.
        if not isinstance(weekly, dict):
            error(pw + ".weekly", "must be an object or null")
            continue
        for day, ranges in weekly.items():
            if day not in DAYS:
                error(pw, f"unknown day '{day}'")
                continue
            valid_ranges = []
            for interval in array_value(pw + f".weekly.{day}", ranges):
                if not isinstance(interval, list) or len(interval) != 2:
                    error(pw, f"{day}: each interval must contain an opening and closing time")
                    continue
                opening, closing = interval
                if not all(isinstance(value, str) and TIME_RE.fullmatch(value) for value in interval):
                    error(pw, f"{day}: bad time {opening!r}-{closing!r}")
                elif opening >= closing:
                    error(pw, f"{day}: opens at or after it closes ({opening}-{closing})")
                else:
                    valid_ranges.append((opening, closing))
            valid_ranges.sort()
            for first, second in zip(valid_ranges, valid_ranges[1:]):
                if second[0] < first[1]:
                    error(pw, f"{day}: overlapping opening intervals")
    if undated > 1:
        error(where, "multiple undated hours periods are ambiguous")
    dated.sort()
    for first, second in zip(dated, dated[1:]):
        if second[0] <= first[1]:
            error(second[2], f"overlaps {first[2]}")


def check_metadata(file, data, version):
    require(file, data, "version", "lastVerified", "timezone", "sources")
    if type(data.get("version")) is not int or data.get("version") != version:
        error(file, f"version must be {version}")
    parse_date(file + ".lastVerified", data.get("lastVerified"))
    if data.get("timezone") != "America/Toronto":
        error(file, "timezone must be America/Toronto")
    sources = object_value(file + ".sources", data.get("sources"))
    check_source_table(file, sources)
    return sources


def validate_places(data):
    file = "campus-places.json"
    if not isinstance(data, dict):
        error(file, "must be an object")
        return
    sources = check_metadata(file, data, 2)
    require(file, data, "buildings", "rooms", "destinations", "launchGroups", "launchLocations")
    buildings = check_ids("buildings", data.get("buildings"))
    codes = {}
    for bid, building in buildings.items():
        where = f"buildings.{bid}"
        require(where, building, "code", "name", "categories", "zone", "sourceIds")
        nonempty(where + ".name", building.get("name"))
        code = building.get("code")
        if nonempty(where + ".code", code):
            if code in codes:
                error(where, f"duplicate building code '{code}'")
            codes[code] = bid
            if bid != f"bldg-{code.lower()}":
                error(where, "id must be 'bldg-' + lowercase code")
        categories = array_value(where + ".categories", building.get("categories"))
        if not categories:
            error(where, "needs at least one category")
        for category in categories:
            enum_value(where + ".categories", category, BUILDING_CATEGORIES)
        if building.get("zone") is not None:
            enum_value(where + ".zone", building["zone"], {"red", "yellow", "blue", "orange", "green"})
        check_sources(where, building, sources)
        check_coordinates(where, building, required=True)

    rooms = check_ids("rooms", data.get("rooms"))
    room_codes = set()
    for rid, room in rooms.items():
        where = f"rooms.{rid}"
        require(where, room, "code", "buildingId", "floor")
        code = room.get("code")
        match = ROOM_CODE_RE.fullmatch(code) if isinstance(code, str) else None
        if not match:
            error(where, f"bad room code {code!r}")
        else:
            if code in room_codes:
                error(where, f"duplicate room code '{code}'")
            room_codes.add(code)
            if rid != f"room-{code.lower()}":
                error(where, "id must be 'room-' + lowercase code")
            if type(room.get("floor")) is not int or room["floor"] != int(match.group(2)):
                error(where, f"floor does not match code '{code}'")
        bid = room.get("buildingId")
        if not isinstance(bid, str) or bid not in buildings:
            error(where, f"unknown buildingId {bid!r}")
        elif match and codes.get(match.group(1)) != bid:
            error(where, f"code prefix '{match.group(1)}' does not match buildingId '{bid}'")
        check_coordinates(where, room, required=True)

    destinations = check_ids("destinations", data.get("destinations"))
    used_rooms = set()
    for did, dest in destinations.items():
        where = f"destinations.{did}"
        require(where, dest, "name", "category", "status", "sourceIds")
        nonempty(where + ".name", dest.get("name"))
        enum_value(where + ".category", dest.get("category"), DESTINATION_CATEGORIES)
        enum_value(where + ".status", dest.get("status"), DESTINATION_STATUSES)
        if "roomCode" in dest:
            error(where, "roomCode must be derived from the referenced room")
        if not any(key in dest for key in ("roomId", "parentId", "buildingId", "geometry")):
            error(where, "needs a room, parent, building, or explicit coordinate anchor")
        rid = dest.get("roomId")
        if "roomId" in dest:
            if not isinstance(rid, str) or rid not in rooms:
                error(where, f"unknown roomId {rid!r}")
            else:
                used_rooms.add(rid)
            if "buildingId" in dest:
                error(where, "room-based destinations must derive buildingId from roomId")
        bid = dest.get("buildingId")
        if "buildingId" in dest and bid is not None:
            if not isinstance(bid, str) or bid not in buildings:
                error(where, f"unknown buildingId {bid!r}")
        if "buildingId" in dest and bid is None and not dest.get("notes"):
            error(where, "an unknown building must be explained in notes")
        parent = dest.get("parentId")
        if "parentId" in dest and (not isinstance(parent, str) or parent not in destinations or parent == did):
            error(where, f"unknown or self-referencing parentId {parent!r}")
        if "hours" in dest:
            check_hours(where + ".hours", dest["hours"], sources)
        check_sources(where, dest, sources)
        check_coordinates(where, dest)

    anchors, visiting = {}, set()

    def resolve_anchor(did):
        if did in anchors:
            return anchors[did]
        if did in visiting:
            error(f"destinations.{did}", "parent cycle detected")
            return (None, None)
        visiting.add(did)
        dest = destinations[did]
        rid, bid = dest.get("roomId"), dest.get("buildingId")
        own_room = rid if isinstance(rid, str) and rid in rooms else None
        own_building = rooms[own_room].get("buildingId") if own_room else bid
        parent = dest.get("parentId")
        inherited = resolve_anchor(parent) if isinstance(parent, str) and parent in destinations else (None, None)
        if "geometry" not in dest:
            if own_room and inherited[0] and own_room != inherited[0]:
                error(f"destinations.{did}", "roomId conflicts with its parent anchor; use an explicit geometry override")
            if own_building and inherited[1] and own_building != inherited[1]:
                error(f"destinations.{did}", "buildingId conflicts with its parent anchor; use an explicit geometry override")
        visiting.remove(did)
        anchors[did] = (own_room or inherited[0], own_building or inherited[1])
        return anchors[did]

    for did in destinations:
        resolve_anchor(did)
    for rid in rooms.keys() - used_rooms:
        error(f"rooms.{rid}", "not referenced by any destination")

    groups = check_ids("launchGroups", data.get("launchGroups"), re.compile(r"^[a-z0-9]+([-_][a-z0-9]+)*$"))
    for gid, group in groups.items():
        nonempty(f"launchGroups.{gid}.label", group.get("label"))
    rows = array_value("launchLocations", data.get("launchLocations"))
    if not rows:
        error("launchLocations", "must contain the initial rollout locations")
    seen_rows = set()
    for index, row in enumerate(rows):
        where = f"launchLocations[{index}]"
        if not isinstance(row, dict):
            error(where, "must be an object")
            continue
        require(where, row, "sourceLabel", "group", "destinationIds", "resolutionStatus")
        label, group = row.get("sourceLabel"), row.get("group")
        valid_label = nonempty(where + ".sourceLabel", label)
        if not isinstance(group, str) or group not in groups:
            error(where, f"unknown group {group!r}")
        elif valid_label:
            key = (group, label)
            if key in seen_rows:
                error(where, "duplicate source label within launch group")
            seen_rows.add(key)
        status = row.get("resolutionStatus")
        enum_value(where + ".resolutionStatus", status, {"resolved", "pending"})
        destination_ids = array_value(where + ".destinationIds", row.get("destinationIds"))
        if status == "resolved" and not destination_ids:
            error(where, "a resolved row needs at least one destinationId")
        seen_ids = set()
        for did in destination_ids:
            if not isinstance(did, str) or did not in destinations:
                error(where, f"unknown destinationId {did!r}")
            elif did in seen_ids:
                error(where, f"duplicate destinationId '{did}' within row")
            else:
                seen_ids.add(did)


def validate_launch_ready(data):
    """Run only after the catalog passes validate_places."""
    if errors:
        return
    try:
        from generate_geojson import build_feature_collection
        build_feature_collection(data, require_verified=True)
    except (ValueError, KeyError, TypeError) as exc:
        error("launch readiness", str(exc))


def validate_holidays(data):
    file = "campus-holidays.json"
    if not isinstance(data, dict):
        error(file, "must be an object")
        return
    sources = check_metadata(file, data, 1)
    require(file, data, "coverage", "basisValues", "holidays", "closures")
    coverage = object_value("coverage", data.get("coverage"))
    require("coverage", coverage, "from", "to")
    start = parse_date("coverage.from", coverage.get("from"))
    end = parse_date("coverage.to", coverage.get("to"))
    if start and end and start > end:
        error("coverage", "from is after to")
    bases = object_value("basisValues", data.get("basisValues"))
    holidays = check_ids("holidays", data.get("holidays"))
    seen = {}
    for hid, holiday in holidays.items():
        where = f"holidays.{hid}"
        require(where, holiday, "name", "date", "statutory", "fanshawe", "sourceIds")
        name = holiday.get("name")
        valid_name = nonempty(where + ".name", name)
        day = parse_date(where + ".date", holiday.get("date"))
        if day and start and end and not start <= day <= end:
            error(where, f"date {day} is outside coverage")
        if day and valid_name:
            key = (name, day.year)
            if key in seen:
                error(where, f"duplicate of {seen[key]}")
            seen[key] = hid
        statutory = object_value(where + ".statutory", holiday.get("statutory"))
        if not all(type(statutory.get(key)) is bool for key in ("federal", "ontario")):
            error(where, "statutory.federal and statutory.ontario must be booleans")
        fanshawe = object_value(where + ".fanshawe", holiday.get("fanshawe"))
        enum_value(where + ".fanshawe.status", fanshawe.get("status"), {"open", "closed"})
        basis = fanshawe.get("basis")
        if not isinstance(basis, str) or basis not in bases:
            error(where, f"unknown fanshawe.basis {basis!r}")
        check_sources(where, holiday, sources)
        if day and valid_name and name in MONDAY_HOLIDAYS and day.weekday() != 0:
            error(where, f"{name} must fall on a Monday, got {day:%A}")
        if day and name == "Good Friday" and day.weekday() != 4:
            error(where, f"Good Friday must fall on a Friday, got {day:%A}")
    closures = check_ids("closures", data.get("closures"))
    for cid, closure in closures.items():
        where = f"closures.{cid}"
        require(where, closure, "name", "from", "to", "sourceIds")
        nonempty(where + ".name", closure.get("name"))
        first = parse_date(where + ".from", closure.get("from"))
        last = parse_date(where + ".to", closure.get("to"))
        if first and last and first > last:
            error(where, "from is after to")
        check_sources(where, closure, sources)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--require-launch-ready", action="store_true", help="require resolved launch rows and verified map points")
    args = parser.parse_args(argv)
    errors.clear()
    places, holidays = load("campus-places.json"), load("campus-holidays.json")
    if places is not None:
        validate_places(places)
    if holidays is not None:
        validate_holidays(holidays)
    if args.require_launch_ready and not errors:
        validate_launch_ready(places)
    if errors:
        print(f"{len(errors)} problem(s) found:")
        for problem in errors:
            print("  - " + problem)
        return 1
    print(f"OK: {len(places['buildings'])} buildings, {len(places['rooms'])} rooms, "
          f"{len(places['destinations'])} destinations, {len(places['launchLocations'])} launch rows, "
          f"{len(holidays['holidays'])} holidays, {len(holidays['closures'])} "
          f"{'closure' if len(holidays['closures']) == 1 else 'closures'}")
    if not args.require_launch_ready:
        print("Catalog structure is valid; run --require-launch-ready before publishing map points.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
