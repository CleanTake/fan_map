"""
Validate the FanMap data files.

usage: python data/validate.py
Exits with status 1 and lists every problem found; standard library only.
"""

import json
import re
import sys
from datetime import date
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent

BUILDING_CATEGORIES = {
    "academic", "administrative", "student_services", "student_life", "food", "retail", "recreational",
    "health_wellness", "library", "residence", "information", "utility", "unclassified",
}
DESTINATION_CATEGORIES = {"food", "retail", "student_services", "academic_office", "health_wellness"}
DESTINATION_STATUSES = {"open", "closed_temporarily", "closed_permanently", "unknown"}
ZONES = {"red", "yellow", "blue", "orange", "green", None}
DAYS = {"mon", "tue", "wed", "thu", "fri", "sat", "sun"}
FANSHAWE_STATUSES = {"open", "closed"}
MONDAY_HOLIDAYS = {"Labour Day", "Thanksgiving Day", "Family Day", "Easter Monday", "Victoria Day", "Civic Holiday"}

ID_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
ROOM_CODE_RE = re.compile(r"^([A-Z]{1,3}?)(\d)\d{2,3}(-\d{1,2})?$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

errors = []


def error(where, message):
    errors.append(f"{where}: {message}")


def load(name):
    path = DATA_DIR / name
    try:
        with path.open(encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        error(name, f"cannot load ({e})")
        return None


def parse_date(where, value, nullable=False):
    if value is None and nullable:
        return None
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        error(where, f"invalid date {value!r}")
        return None


def require(where, obj, *keys):
    ok = True
    for key in keys:
        if key not in obj:
            error(where, f"missing '{key}'")
            ok = False
    return ok


def check_ids(label, items):
    ids = {}
    for i, item in enumerate(items):
        where = f"{label}[{i}]"
        item_id = item.get("id")
        if not isinstance(item_id, str) or not ID_RE.match(item_id):
            error(where, f"invalid id {item_id!r}")
        elif item_id in ids:
            error(where, f"duplicate id '{item_id}'")
        else:
            ids[item_id] = item
    return ids


def check_sources(where, item, sources):
    source_ids = item.get("sourceIds")
    if not source_ids:
        error(where, "needs at least one sourceId")
        return
    for sid in source_ids:
        if sid not in sources:
            error(where, f"unknown sourceId '{sid}'")


def check_source_table(file, sources):
    for sid, s in sources.items():
        where = f"{file} sources.{sid}"
        require(where, s, "title", "url", "retrieved")
        if not str(s.get("url", "")).startswith("https://"):
            error(where, "url must be https")
        parse_date(where, s.get("retrieved"))


def check_hours(where, hours, sources):
    require(where, hours, "timezone", "sourceId", "periods")
    if hours.get("timezone") != "America/Toronto":
        error(where, "timezone must be America/Toronto")
    if hours.get("sourceId") not in sources:
        error(where, f"unknown sourceId '{hours.get('sourceId')}'")
    dated = []
    for i, p in enumerate(hours.get("periods", [])):
        pw = f"{where}.periods[{i}]"
        require(pw, p, "label", "from", "to", "weekly", "rawText")
        start = parse_date(pw + ".from", p.get("from"), nullable=True)
        end = parse_date(pw + ".to", p.get("to"), nullable=True)
        if start and end:
            if start > end:
                error(pw, "from is after to")
            dated.append((start, end, pw))
        elif (start is None) != (end is None):
            error(pw, "from and to must both be set or both be null")
        weekly = p.get("weekly")
        if weekly is None:
            continue  # published hours are ambiguous; rawText carries them
        for day, ranges in weekly.items():
            if day not in DAYS:
                error(pw, f"unknown day '{day}'")
                continue
            for open_, close in ranges:
                if not (TIME_RE.match(open_) and TIME_RE.match(close)):
                    error(pw, f"{day}: bad time {open_!r}-{close!r}")
                elif open_ >= close:
                    error(pw, f"{day}: opens at or after it closes ({open_}-{close})")
    dated.sort()
    for (s1, e1, w1), (s2, e2, w2) in zip(dated, dated[1:]):
        if s2 <= e1:
            error(w2, f"overlaps {w1}")


def validate_places(data):
    f = "campus-places.json"
    if not require(f, data, "version", "lastVerified", "sources", "buildings", "rooms", "destinations"):
        return
    sources = data["sources"]
    check_source_table(f, sources)

    buildings = check_ids("buildings", data["buildings"])
    codes = {}
    for bid, bld in buildings.items():
        where = f"buildings.{bid}"
        require(where, bld, "code", "name", "categories", "zone", "sourceIds")
        code = bld.get("code")
        if code in codes:
            error(where, f"duplicate building code '{code}'")
        codes[code] = bid
        if bid != f"bldg-{str(code).lower()}":
            error(where, "id must be 'bldg-' + lowercase code")
        cats = bld.get("categories") or []
        if not cats:
            error(where, "needs at least one category")
        for c in cats:
            if c not in BUILDING_CATEGORIES:
                error(where, f"unknown category '{c}'")
        if bld.get("zone") not in ZONES:
            error(where, f"unknown zone {bld.get('zone')!r}")
        check_sources(where, bld, sources)

    rooms = check_ids("rooms", data["rooms"])
    room_codes = {}
    for rid, room in rooms.items():
        where = f"rooms.{rid}"
        require(where, room, "code", "buildingId", "floor")
        code = room.get("code", "")
        m = ROOM_CODE_RE.match(code)
        if not m:
            error(where, f"bad room code '{code}'")
            continue
        room_codes[code] = rid
        if rid != f"room-{code.lower()}":
            error(where, "id must be 'room-' + lowercase code")
        if room.get("buildingId") not in buildings:
            error(where, f"unknown buildingId '{room.get('buildingId')}'")
        elif codes.get(m.group(1)) != room["buildingId"]:
            error(where, f"code prefix '{m.group(1)}' does not match buildingId '{room['buildingId']}'")
        if room.get("floor") != int(m.group(2)):
            error(where, f"floor {room.get('floor')} does not match code '{code}'")

    dests = check_ids("destinations", data["destinations"])
    used_rooms = set()
    for did, dest in dests.items():
        where = f"destinations.{did}"
        require(where, dest, "name", "category", "buildingId", "roomCode", "roomId", "status", "sourceIds")
        if dest.get("category") not in DESTINATION_CATEGORIES:
            error(where, f"unknown category '{dest.get('category')}'")
        if dest.get("status") not in DESTINATION_STATUSES:
            error(where, f"unknown status '{dest.get('status')}'")
        bid = dest.get("buildingId")
        if bid is None:
            if not dest.get("notes"):
                error(where, "a destination without a building must explain why in notes")
        elif bid not in buildings:
            error(where, f"unknown buildingId '{bid}'")
        room_id, room_code = dest.get("roomId"), dest.get("roomCode")
        if room_id is not None or room_code is not None:
            room = rooms.get(room_id)
            if room is None:
                error(where, f"unknown roomId '{room_id}'")
            else:
                used_rooms.add(room_id)
                if room["code"] != room_code:
                    error(where, f"roomCode '{room_code}' does not match room '{room_id}'")
                if room["buildingId"] != bid:
                    error(where, f"room '{room_id}' is not in building '{bid}'")
        parent = dest.get("parentId")
        if parent is not None:
            if parent not in dests or parent == did:
                error(where, f"unknown parentId '{parent}'")
            elif dests[parent].get("buildingId") != bid:
                error(where, "must be in the same building as its parent")
        if "hours" in dest:
            check_hours(where + ".hours", dest["hours"], sources)
        check_sources(where, dest, sources)

    for rid in rooms.keys() - used_rooms:
        error(f"rooms.{rid}", "not referenced by any destination")


def validate_holidays(data):
    f = "campus-holidays.json"
    if not require(f, data, "version", "lastVerified", "coverage", "basisValues", "sources", "holidays", "closures"):
        return
    sources = data["sources"]
    check_source_table(f, sources)
    cov_from = parse_date("coverage.from", data["coverage"].get("from"))
    cov_to = parse_date("coverage.to", data["coverage"].get("to"))
    bases = data["basisValues"]

    holidays = check_ids("holidays", data["holidays"])
    seen = {}
    for hid, hol in holidays.items():
        where = f"holidays.{hid}"
        if not require(where, hol, "name", "date", "statutory", "fanshawe", "sourceIds"):
            continue
        d = parse_date(where, hol["date"])
        if d and cov_from and cov_to and not cov_from <= d <= cov_to:
            error(where, f"date {d} is outside coverage")
        if d and (hol["name"], d.year) in seen:
            error(where, f"duplicate of {seen[(hol['name'], d.year)]}")
        if d:
            seen[(hol["name"], d.year)] = hid
        stat = hol["statutory"]
        if not (isinstance(stat.get("federal"), bool) and isinstance(stat.get("ontario"), bool)):
            error(where, "statutory.federal and statutory.ontario must be booleans")
        fan = hol["fanshawe"]
        if fan.get("status") not in FANSHAWE_STATUSES:
            error(where, f"unknown fanshawe.status {fan.get('status')!r}")
        if fan.get("basis") not in bases:
            error(where, f"unknown fanshawe.basis {fan.get('basis')!r}")
        check_sources(where, hol, sources)
        # Holidays defined by weekday must land on that weekday.
        if d and hol["name"] in MONDAY_HOLIDAYS and d.weekday() != 0:
            error(where, f"{hol['name']} must fall on a Monday, got {d:%A}")
        if d and hol["name"] == "Good Friday" and d.weekday() != 4:
            error(where, f"Good Friday must fall on a Friday, got {d:%A}")

    closures = check_ids("closures", data["closures"])
    for cid, c in closures.items():
        where = f"closures.{cid}"
        require(where, c, "name", "from", "to", "sourceIds")
        start, end = parse_date(where + ".from", c.get("from")), parse_date(where + ".to", c.get("to"))
        if start and end and start > end:
            error(where, "from is after to")
        check_sources(where, c, sources)



def main():
    places = load("campus-places.json")
    holidays = load("campus-holidays.json")
    if places is not None:
        validate_places(places)
    if holidays is not None:
        validate_holidays(holidays)
    if errors:
        print(f"{len(errors)} problem(s) found:")
        for e in errors:
            print("  - " + e)
        return 1
    print(f"OK: {len(places['buildings'])} buildings, {len(places['rooms'])} rooms, "
          f"{len(places['destinations'])} destinations, {len(holidays['holidays'])} holidays, "
          f"{len(holidays['closures'])} closures")
    return 0


if __name__ == "__main__":
    sys.exit(main())
