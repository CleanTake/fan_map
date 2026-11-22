"""Map labelled campus-plan landmarks without estimating legend-only rooms."""
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write_if_changed(path, value):
    text = json.dumps(value, indent=2, ensure_ascii=False) + '\n'
    if not path.exists() or path.read_text(encoding='utf-8') != text:
        path.write_text(text, encoding='utf-8', newline='\n')


plan = read(ROOT / 'data/navigation/campus-landmarks.json')
registration = read(ROOT / 'data/navigation/reference-registration.json')
if plan['imageSha256'] != registration['imageSha256']:
    raise ValueError('Landmarks refer to a different campus image.')


def project(pixel):
    if len(pixel) != 2 or not all(math.isfinite(value) for value in pixel) or not 0 <= pixel[0] <= 830 or not 0 <= pixel[1] <= 521:
        raise ValueError('Invalid campus-map landmark pixel.')
    x,y = [origin+a*pixel[0]+b*pixel[1]+c for origin,(a,b,c) in zip(registration['mercatorOrigin'],registration['pixelToMercator'])]
    return [x/6378137*180/math.pi,math.atan(math.sinh(y/6378137))*180/math.pi]


places_path, overrides_path = ROOT/'data/places.json', ROOT/'data/place-overrides.json'
places, overrides = read(places_path), read(overrides_path)
launch = read(ROOT.parent/'data/launch-locations.geojson')['features']
deleted = set(read(ROOT/'data/deleted-place-ids.json'))
combined = {item['properties']['id']: item for item in places+launch+overrides}
existing_ids = {item['properties']['id'] for item in places}
added, positioned = [], []
for item in plan['landmarks']:
    id = item['id']
    if id in deleted:
        raise ValueError(f'Refusing to revive a deleted location: {id}')
    if item.get('existing'):
        current = combined.get(id)
        if not current:
            raise ValueError(f'Missing canonical location: {id}')
        if current.get('geometry'):
            continue  # Preserve an already checked or explicitly edited point.
        feature = {**current, 'properties': {**current['properties']}}
        properties = feature['properties']
        properties['description'] = properties.get('description','') + ' ' + item.get('note','Position shown on the supplied campus plan.')
        properties['category'] = item.get('category',properties['category'])
    else:
        if id in existing_ids:
            continue
        feature = {'type':'Feature','properties':{'id':id,'name':item['name'],'category':item['category'],
                    'description':item.get('note',item['name']+' labelled on the supplied campus reference map.')}}
        properties = feature['properties']
        if item.get('buildingCode'):
            properties['buildingCode'] = item['buildingCode']
    properties['sourceIds'] = list(dict.fromkeys(properties.get('sourceIds',[])+['user-campus-plan']))
    properties['resolutionStatus'] = 'reference-map-landmark'
    if item.get('pendingAccess'):
        properties['navigationStatus'] = 'pending-access-review'
        properties['description'] += ' Walking access is awaiting review.'
    if item.get('navigationPixel'):
        properties['navigationCoordinates'] = project(item['navigationPixel'])
    feature['geometry'] = {'type':'Point','coordinates':project(item['pixel'])}
    if item.get('existing'):
        overrides = [old for old in overrides if old['properties']['id'] != id] + [feature]
        positioned.append(id)
    else:
        places.append(feature)
        existing_ids.add(id)
        added.append(id)

write_if_changed(places_path,places)
write_if_changed(overrides_path,overrides)
print(json.dumps({'addedLandmarks':len(added),'positionedExistingRecords':positioned,'legendOnlyFoodRetailPlaced':False}))
