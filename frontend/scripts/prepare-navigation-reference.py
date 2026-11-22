"""Register the user's campus schematic against existing footprint corners.

Only standard-library Python is needed. Produces review data, never live routes.
Run from frontend: python scripts/prepare-navigation-reference.py
"""
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
R = 6378137
WIDTH, HEIGHT = 830, 521
CONTROLS = [
    ("C southwest", "building_c", 8, [249, 358], "fit"),
    ("C southeast", "building_c", 11, [407, 358], "check"),
    ("M northeast", "building_m", 23, [648, 169], "fit"),
    ("M northwest", "building_m", 24, [635, 169], "check"),
    ("M southeast", "building_m", 14, [658, 250], "check"),
    ("A northeast", "building_a", 0, [579, 352], "fit"),
    ("A southwest", "building_a", 14, [551, 460], "fit"),
    ("SC northeast", "building_student_center_building", 20, [428, 143], "fit"),
    ("SC southwest", "building_student_center_building", 45, [374, 177], "check"),
    ("T west tip", "building_t", 10, [232, 432], "fit"),
    ("T northeast", "building_t", 1, [350, 432], "check"),
    ("T southeast", "building_t", 30, [350, 466], "check"),
]


def mercator(point):
    return [R * math.radians(point[0]), R * math.asinh(math.tan(math.radians(point[1])))]


def solve(matrix, values):
    rows = [list(row) + [value] for row, value in zip(matrix, values)]
    for column in range(3):
        pivot = max(range(column, 3), key=lambda row: abs(rows[row][column]))
        rows[column], rows[pivot] = rows[pivot], rows[column]
        divisor = rows[column][column]
        if abs(divisor) < 1e-12:
            raise ValueError("Control points cannot determine an affine registration")
        rows[column] = [item / divisor for item in rows[column]]
        for row in range(3):
            if row == column:
                continue
            factor = rows[row][column]
            rows[row] = [a - factor * b for a, b in zip(rows[row], rows[column])]
    return [row[-1] for row in rows]


def main():
    image = ROOT / "public/navigation/campus-reference.png"
    digest = hashlib.sha256(image.read_bytes()).hexdigest()
    if digest != "c8a885dc113467f41d2fad3429d3ec58b404c6b3e436258ae320e586be79dac8":
        raise ValueError("Reference image changed; remeasure the control points")
    controls = []
    origin = mercator([-81.2, 43.013])
    for label, file, vertex, pixel, role in CONTROLS:
        source = ROOT.parent / "data/building_outlines" / (file + ".geojson")
        polygon = json.loads(source.read_text())["features"][0]["geometry"]["coordinates"][0]
        controls.append({"label": label, "footprint": file + ".geojson", "vertex": vertex,
                         "pixel": pixel, "coordinates": polygon[vertex], "role": role})
    fit = [point for point in controls if point["role"] == "fit"]
    rows = [[point["pixel"][0] / WIDTH, point["pixel"][1] / HEIGHT, 1] for point in fit]
    normal = [[sum(row[a] * row[b] for row in rows) for b in range(3)] for a in range(3)]
    target = [[v - o for v, o in zip(mercator(point["coordinates"]), origin)] for point in fit]
    affine = []
    for axis in range(2):
        solution = solve(normal, [sum(row[a] * value[axis] for row, value in zip(rows, target)) for a in range(3)])
        affine.append([solution[0] / WIDTH, solution[1] / HEIGHT, solution[2]])
    scale = math.cos(math.radians(43.013))
    for point in controls:
        x, y = point["pixel"]
        fitted = [o + a * x + b * y + c for o, (a, b, c) in zip(origin, affine)]
        expected = mercator(point["coordinates"])
        point["errorMetres"] = round(math.hypot(*(a - b for a, b in zip(fitted, expected))) * scale, 2)
    checks = [point["errorMetres"] for point in controls if point["role"] == "check"]
    manifest = {
        "version": 1, "status": "approximate-schematic-registration", "imageUrl": "/navigation/campus-reference.png",
        "imageSha256": digest, "imageSize": [WIDTH, HEIGHT], "projection": "EPSG:3857",
        "mercatorOrigin": origin, "pixelToMercator": affine, "controlPoints": controls,
        "checkRmsMetres": round(math.sqrt(sum(error ** 2 for error in checks) / len(checks)), 2),
        "checkMaxMetres": max(checks),
        "note": "Schematic alignment from manually matched corners, not a survey. Checkpoint errors measure fit to existing footprints, not absolute accuracy. Ground-floor connectivity follows the user's Q1-Q5 confirmations; doorway coordinates remain approximate.",
    }
    destination = ROOT / "data/navigation/reference-registration.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"fitControls": len(fit), "checkpoints": len(checks), "checkRmsMetres": manifest["checkRmsMetres"], "checkMaxMetres": manifest["checkMaxMetres"]}))


if __name__ == "__main__":
    main()
