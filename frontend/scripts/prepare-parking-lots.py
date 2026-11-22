"""Add map-sourced parking pins without inventing pedestrian connections."""
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
reference = json.loads((ROOT / 'data/navigation/parking-lots.json').read_text(encoding='utf-8'))
registration = json.loads((ROOT / 'data/navigation/reference-registration.json').read_text(encoding='utf-8'))
if reference['imageSha256'] != registration['imageSha256']:
    raise ValueError('Parking locations refer to a different campus image.')


def project(pixel):
    x, y = [origin + a * pixel[0] + b * pixel[1] + c for origin, (a, b, c) in zip(registration['mercatorOrigin'], registration['pixelToMercator'])]
    return [x / 6378137 * 180 / math.pi, math.atan(math.sinh(y / 6378137)) * 180 / math.pi]


path = ROOT / 'data/places.json'
places = json.loads(path.read_text(encoding='utf-8'))
existing = {place['properties']['id'] for place in places}
added = []
for lot in reference['lots']:
    if lot['id'] in existing:
        continue  # Preserve existing pins and explicit overrides, including Lot 5.
    if lot['navigationStatus'] != 'pending-access-review':
        raise ValueError('A new lot requires a reviewed access point before enabling navigation.')
    places.append({'type': 'Feature', 'properties': {
        'id': lot['id'], 'name': lot['name'], 'category': 'parking',
        'description': f"{lot['designation']} as labelled on the campus reference map. Pedestrian access connections are awaiting review.",
        'sourceIds': ['user-campus-plan'], 'resolutionStatus': 'schematic-position',
        'navigationStatus': lot['navigationStatus'],
    }, 'geometry': {'type': 'Point', 'coordinates': project(lot['pixel'])}})
    added.append(lot['id'])
if added:
    path.write_text(json.dumps(places, indent=2, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')
print(json.dumps({'added': added, 'parkingPointsOnPlan': len(reference['lots'])}))
