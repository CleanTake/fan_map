"""Apply the user's 2026-11-22 ground-floor survey to the schematic centrelines.

The raw review is retained unchanged. These map-reviewed adjustments remove
cursor jitter, preserve intended bends, and use exact shared junctions. Exposure
and doorway transitions are inferred from the supplied campus schematic, as
authorized in chat. No room/floor survey accuracy is implied.
"""
import hashlib
import json
import math
import sys
from pathlib import Path
from campus_osm import load_campus_osm

ROOT = Path(__file__).resolve().parents[1]
REVIEW_PATH = ROOT / 'data/navigation/reviews/2026-11-22.json'
SOURCE_PATH = ROOT / 'data/navigation/reference-passages.json'
JUNCTION = [421, 263 + (421 - 414) * 18 / 19]

# Canonical vertices in the original 830 x 521 reference. Horizontal/vertical
# stretches are aligned; the intentional diagonal bends around H/R1 are kept.
CLEAN = {
    'A001': [[409,326],[409,292],[421,292],JUNCTION],
    'A002': [[570,379],[570,335],[522,335]],
    'A003': [[551,418],[511,418]],
    'A004': [[383,394],[383,451]],
    'A005': [[449,412],[449,421],[437,421],[437,451]],
    'A006': [[277,451],[277,376]],
    'A007': [[587,242],[579,222],[563,209],[556,209],[541,223],[541,242]],
    'A008': [[541,223],[531,208],[480,208]],
    'A009': [[449,224],[447,224],[447,242],[430,257],JUNCTION],
    'A010': [[414,177],[461,177],[480,197],[480,224]],
    'A011': [[480,206],[480,208]],
    'A012': [[560,178],[560,186],[531,186],[531,208]],
    'A013': [[389,177],[336,177]],
    'A014': [[399,250],[368,250]],
    'A015': [[399,394],[399,375]],
    'A016': [[321,394],[321,375]],
    'A017': [[481,350],[481,375],[449,375]],
}


def nearest_distance(point, polyline):
    best = math.inf
    for a, b in zip(polyline, polyline[1:]):
        vector = [b[i] - a[i] for i in range(2)]
        length = sum(value * value for value in vector)
        t = max(0, min(1, sum((point[i] - a[i]) * vector[i] for i in range(2)) / length)) if length else 0
        best = min(best, math.dist(point, [a[i] + t * vector[i] for i in range(2)]))
    return best


def shape_offset(first, second):
    # Check both directions, including points along each segment. A010's initial
    # backtrack is removed as duplicate coverage rather than deleting its extent.
    return max(nearest_distance([a[i] + (b[i] - a[i]) * t / 10 for i in range(2)], target)
               for line, target in [(first, second), (second, first)]
               for a, b in zip(line, line[1:]) for t in range(11))


def main():
    raw = REVIEW_PATH.read_bytes()
    review = json.loads(raw)
    source = json.loads(SOURCE_PATH.read_bytes())
    if review['schema'] != 'fanmap-ground-floor-review' or review['version'] != 1:
        raise ValueError('Unsupported review format.')
    registration = json.loads((ROOT / 'data/navigation/reference-registration.json').read_bytes())
    if review['imageSha256'] != registration['imageSha256'] or review['imageSize'] != [830, 521]:
        raise ValueError('Review references a different campus image.')
    digest = hashlib.sha256(raw).hexdigest()
    prior = next((entry for entry in source.get('reviews', []) if entry['sourceSha256'] == digest), None)
    current_hash = hashlib.sha256((ROOT / 'data/navigation/campus-network.json').read_bytes()).hexdigest()
    if not prior and current_hash != review['networkSha256']:
        raise ValueError('The network changed since this review was made; reconcile it before applying.')
    annotations = {item['id']: item for item in review['annotations']}
    if set(annotations) != set(CLEAN) or any(item['kind'] != 'line' or item['issue'] != 'missing' for item in annotations.values()):
        raise ValueError('Review content differs from the seventeen additions examined for this update.')
    audit = []
    for id, points in CLEAN.items():
        offset = shape_offset(annotations[id]['points'], points)
        if offset > 4.5:
            raise ValueError(f'{id}: cleanup moved more than the permitted small correction ({offset:.2f} px).')
        audit.append({'annotationId': id, 'pixels': points, 'maxShapeOffsetPixels': round(offset, 3)})

    additions = []

    def part(annotation, suffix, label, pixels, kind='indoor', buildings=None, **extra):
        additions.append({'id': f'review-{annotation}-{suffix}', 'label': label, 'pixels': pixels,
                          'kind': kind, 'buildings': buildings or [], 'reviewAnnotationId': annotation,
                          'reviewDate': '2026-11-22', **extra})

    part('A001', 'walkway', 'C / Student Union outdoor walkway', CLEAN['A001'], 'outdoor')

    part('A002', 'a', 'A north entrance approach', [[570,379],[570,358]], buildings=['A'])
    part('A002', 'a-door', 'Pass through the A north doorway', [[570,358],[570,356]], 'door', ['A'])
    part('A002', 'courtyard', 'A / E courtyard walkway', [[570,356],[570,352]], 'outdoor')
    part('A002', 'e-door', 'Pass through the E south doorway', [[570,352],[570,350]], 'door', ['E'])
    part('A002', 'e', 'E corridor and F connection', [[570,350],[570,335],[522,335]], buildings=['E','F','D'])

    part('A003', 'a-door', 'Pass through the A west doorway', [[551,418],[549,418]], 'door', ['A'])
    part('A003', 'courtyard', 'A / Alumni Lecture Theatre courtyard walkway', [[549,418],[513,418]], 'outdoor')
    part('A003', 'd-door', 'Pass through the Alumni Lecture Theatre doorway', [[513,418],[511,418]], 'door', ['D'])

    part('A004', 'atrium', 'B central atrium corridor', CLEAN['A004'], buildings=['B'])

    part('A005', 'd-door', 'Pass through the D southwest doorway', [[449,412],[449,414]], 'door', ['D'])
    part('A005', 'courtyard', 'D / B courtyard walkway', [[449,414],[449,421],[437,421],[437,428]], 'outdoor')
    part('A005', 'b-door', 'Pass through the B east doorway', [[437,428],[437,430]], 'door', ['B'])
    part('A005', 'b', 'B eastern corridor', [[437,430],[437,451]], buildings=['B','T'])

    part('A006', 'b-west', 'B / T western north-south corridor', CLEAN['A006'], buildings=['B','T'])

    part('A007', 'h-east', 'H north courtyard entrance approach', [[587,242],[584.2,235]], buildings=['H'])
    part('A007', 'h-east-door', 'Pass through the H north courtyard doorway', [[584.2,235],[583.4,233]], 'door', ['H'])
    part('A007', 'courtyard', 'H / F north courtyard walkway', [[583.4,233],[579,222],[563,209],[556,209],[541,223],[541,236]], 'outdoor')
    part('A007', 'h-west-door', 'Pass through the H west courtyard doorway', [[541,236],[541,238]], 'door', ['H'])
    part('A007', 'h-west', 'H west courtyard entrance approach', [[541,238],[541,242]], buildings=['H'])

    part('A008', 'walkway', 'H / R1 / G courtyard walkway', CLEAN['A008'], 'outdoor')

    part('A009', 'g-approach', 'G west ground-floor corridor', [[468,224],[449,224]], buildings=['G'],
         geometryAddition='Visible G corridor joins the reviewed west entrance to the existing G / F enclosed passage.')
    part('A009', 'g-door', 'Pass through the G west doorway', [[449,224],[447,224]], 'door', ['G'])
    part('A009', 'walkway', 'G / Student Union outdoor walkway', [[447,224],[447,242],[430,257],JUNCTION], 'outdoor')

    part('A010', 'j', 'J east entrance approach', [[414,177],[428,177]], buildings=['J','SC'])
    part('A010', 'j-door', 'Pass through the J east doorway', [[428,177],[430,177]], 'door', ['J'])
    part('A010', 'road', 'J / R1 Residence Circle crossing', [[430,177],[454,177]], 'outdoor')
    part('A010', 'r1-west-door', 'Pass through the R1 west doorway', [[454,177],[456,177]], 'door', ['R1'])
    part('A010', 'r1', 'R1 southwest ground-floor corridor', [[456,177],[461,177],[480,197],[480,206]], buildings=['R1'])
    # A011 is this short joining/doorway stretch; do not duplicate it in A010.
    part('A011', 'r1-door', 'Pass through the R1 south doorway', CLEAN['A011'], 'door', ['R1'])
    part('A010', 'g-approach', 'R1 / G outdoor approach', [[480,208],[480,214]], 'outdoor')
    part('A010', 'g-door', 'Pass through the G north doorway', [[480,214],[480,216]], 'door', ['G'])
    part('A010', 'g', 'G north entrance corridor', [[480,216],[480,224]], buildings=['G'])

    part('A012', 'k', 'K south entrance approach', [[560,178],[560,180]], buildings=['K'])
    part('A012', 'k-door', 'Pass through the K south doorway', [[560,180],[560,182]], 'door', ['K'])
    part('A012', 'walkway', 'K / G courtyard walkway', [[560,182],[560,186],[531,186],[531,208]], 'outdoor')

    part('A013', 'sc', 'Student Centre west entrance corridor', [[389,177],[375,177]], buildings=['SC'])
    part('A013', 'sc-door', 'Pass through the Student Centre west doorway', [[375,177],[373,177]], 'door', ['SC'])
    part('A013', 'road', 'Student Centre / R2 Student Road crossing', [[373,177],[341,177]], 'outdoor')
    part('A013', 'r2-door', 'Pass through the R2 east doorway', [[341,177],[339,177]], 'door', ['R2'])
    part('A013', 'r2', 'R2 east entrance approach', [[339,177],[336,177]], buildings=['R2'])

    part('A014', 'j', 'J west ground-floor corridor', [[399,250],[375,250]], buildings=['J'])
    part('A014', 'j-door', 'Pass through the J west doorway', [[375,250],[373,250]], 'door', ['J'])
    part('A014', 'walkway', 'J west outdoor approach', [[373,250],[368,250]], 'outdoor')

    part('A015', 'b-east', 'B eastern north entrance corridor', CLEAN['A015'], buildings=['B'])
    part('A016', 'b-north', 'B north entrance corridor', CLEAN['A016'], buildings=['B'])
    part('A017', 'd', 'D central ground-floor corridor', CLEAN['A017'], buildings=['D'])

    # Reapplying replaces this review's generated parts, never duplicates them.
    first_index = next((i for i, item in enumerate(source['passages']) if item.get('reviewAnnotationId') in CLEAN), len(source['passages']))
    retained = [item for item in source['passages'] if item.get('reviewAnnotationId') not in CLEAN]
    source['passages'] = retained[:first_index] + additions + retained[first_index:]
    entry = {'date': '2026-11-22', 'sourceFile': 'reviews/2026-11-22.json', 'sourceSha256': digest,
             'baseNetworkSha256': review['networkSha256'], 'annotationCount': len(annotations),
             'connectionCount': len(annotations),
             'generatedPassageCount': len(additions), 'classification': 'Exposed roads/courtyards are outdoor, as confirmed by user. Door boundaries are estimated from the schematic.',
             'normalization': audit, 'maximumShapeOffsetPixels': round(max(item['maxShapeOffsetPixels'] for item in audit), 3),
             'notes': ['A010 collinear backtrack was merged, preserving its full extent.',
                       'A011 is the shared R1 south doorway junction, rather than a duplicate overlapping path.',
                       'A009 includes the visible G west indoor approach needed to meet the existing corridor.']}
    reviews = source.setdefault('reviews', [])
    existing = next((i for i, item in enumerate(reviews) if item['sourceFile'] == entry['sourceFile']), None)
    if existing is None:
        reviews.append(entry)
    else:
        reviews[existing] = entry
    SOURCE_PATH.write_text(json.dumps(source, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps({'annotationsApplied': len(annotations), 'passageParts': len(additions), 'maxCleanupPixels': entry['maximumShapeOffsetPixels']}))


def apply_entrance_review():
    """Reconcile a cumulative export against the already-applied 17 marks."""
    path = ROOT / 'data/navigation/reviews/2026-11-22-entrances.json'
    raw = path.read_bytes()
    review, previous = json.loads(raw), json.loads(REVIEW_PATH.read_bytes())
    source = json.loads(SOURCE_PATH.read_bytes())
    if any(review.get(key) != previous.get(key) for key in ['schema', 'version', 'networkSha256', 'imageSha256', 'imageSize']):
        raise ValueError('The cumulative review references a different base map.')
    annotations = {item['id']: item for item in review['annotations']}
    if len(annotations) != len(review['annotations']):
        raise ValueError('Duplicate annotation IDs.')
    for item in previous['annotations']:
        if annotations.get(item['id']) != item:
            raise ValueError(f"Earlier annotation changed: {item['id']}")
    ids = {'A018', 'A019', 'A020', 'A021', 'A022'}
    if set(annotations) - set(CLEAN) != ids or any(annotations[id]['kind'] != 'line' or annotations[id]['pathId'] for id in ids):
        raise ValueError('Unexpected entrance/hallway review content.')

    registration = json.loads((ROOT / 'data/navigation/reference-registration.json').read_bytes())

    def pixel(coordinate):
        (a,b,c),(d,e,f) = registration['pixelToMercator']
        x = 6378137 * math.radians(coordinate[0]) - registration['mercatorOrigin'][0] - c
        y = 6378137 * math.asinh(math.tan(math.radians(coordinate[1]))) - registration['mercatorOrigin'][1] - f
        return [(e*x-b*y)/(a*e-b*d), (a*y-d*x)/(a*e-b*d)]

    osm = load_campus_osm()
    osm_nodes = {node.attrib['id']: pixel([float(node.attrib['lon']), float(node.attrib['lat'])]) for node in osm.findall('node')}

    def crossing(way_id, y, near_x):
        way = next(item for item in osm.findall('way') if item.attrib['id'] == way_id)
        points = [osm_nodes[item.attrib['ref']] for item in way.findall('nd')]
        candidates = []
        for a,b in zip(points, points[1:]):
            if abs(b[1]-a[1]) < 1e-8:
                continue
            t = (y-a[1])/(b[1]-a[1])
            if 0 <= t <= 1:
                candidates.append([a[0]+t*(b[0]-a[0]), y])
        if not candidates:
            raise ValueError(f'No matching outdoor junction on OSM way {way_id}')
        return min(candidates, key=lambda point: abs(point[0]-near_x))

    f_door = osm_nodes['13960477066']
    f_join = crossing('1531709051', f_door[1], 547)
    m_join = crossing('1531709030', 215, 663)
    if math.dist(f_join, [547,f_door[1]]) > 4.5 or math.dist(m_join, [663,215]) > 4.5:
        raise ValueError('An outdoor entrance join exceeds the allowed tiny gap.')
    clean = {
        'A018': [f_door, [547,f_door[1]]],
        'A019': [[655,215], m_join],
        'A020': [[277,451],[277,456],[280,458],[291,460.5],[306,462],[317,463.5],[317,459.5]],
        'A021': [[317,459.5],[317,451]],
        'A022': [[317,463.5],[331,464],[339,463.5],[354,460],[359,457],[364.3,451]],
    }
    audit = []
    for id, points in clean.items():
        offset = shape_offset(annotations[id]['points'], points)
        if offset > 4.5:
            raise ValueError(f'{id}: entrance cleanup moved too far ({offset:.2f} px).')
        audit.append({'annotationId': id, 'pixels': points, 'maxShapeOffsetPixels': round(offset,3)})

    parts = []

    def part(id, suffix, label, points, kind, buildings):
        parts.append({'id': f'review-{id}-{suffix}', 'label': label, 'pixels': points, 'kind': kind,
                      'buildings': buildings, 'reviewAnnotationId': id, 'reviewDate': '2026-11-22'})

    part('A018', 'f-approach', 'F main entrance outdoor approach', [f_door,f_join,[547,f_door[1]]], 'outdoor', [])
    part('A019', 'm-corridor', 'M east entrance corridor', [[655,215],[658,215]], 'indoor', ['M'])
    part('A019', 'm-door', 'Pass through the M east doorway', [[658,215],[660,215]], 'door', ['M'])
    part('A019', 'm-approach', 'M east entrance outdoor approach', [[660,215],m_join], 'outdoor', [])
    part('A020', 't-b-west-curve', 'T / B curved ground-floor hallway', clean['A020'], 'indoor', ['T','B'])
    part('A021', 't-b-branch', 'T / B curved hallway central connection', clean['A021'], 'indoor', ['T','B'])
    part('A022', 't-b-east-curve', 'T / B curved ground-floor hallway', clean['A022'], 'indoor', ['T','B'])

    source['passages'] = [item for item in source['passages'] if item.get('reviewAnnotationId') not in ids] + parts
    joins = [{'id': 'review-A018-f-footpath', 'osmWayId': '1531709051', 'pixel': f_join},
             {'id': 'review-A019-m-footpath', 'osmWayId': '1531709030', 'pixel': m_join}]
    source['outdoorJoins'] = [item for item in source.get('outdoorJoins', []) if item['id'] not in {join['id'] for join in joins}] + joins
    entry = {'date': '2026-11-22', 'sourceFile': 'reviews/2026-11-22-entrances.json', 'sourceSha256': hashlib.sha256(raw).hexdigest(),
             'baseNetworkSha256': review['networkSha256'], 'parentReviewSha256': hashlib.sha256(REVIEW_PATH.read_bytes()).hexdigest(),
             'annotationCount': 5, 'connectionCount': 3, 'generatedPassageCount': len(parts),
             'normalization': audit, 'maximumShapeOffsetPixels': round(max(item['maxShapeOffsetPixels'] for item in audit),3),
             'notes': ['A001-A017 are unchanged and are not reapplied by this cumulative update.',
                       'A020-A022 form one curved indoor T/B hallway with a central branch; its curvature is retained.',
                       'A021 has no selected replacement target and is applied as the connecting branch described by the user.',
                       'F reuses its existing doorway. M adds an east doorway; both outdoor approaches join the mapped footpaths.']}
    reviews = source.setdefault('reviews', [])
    existing = next((i for i,item in enumerate(reviews) if item['sourceFile'] == entry['sourceFile']), None)
    if existing is None:
        reviews.append(entry)
    else:
        reviews[existing] = entry
    SOURCE_PATH.write_text(json.dumps(source,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    print(json.dumps({'connectionsAdded':3,'newStrokesApplied':5,'maxCleanupPixels':entry['maximumShapeOffsetPixels']}))


if __name__ == '__main__':
    if sys.argv[1:] == ['--entrances']:
        apply_entrance_review()
    elif sys.argv[1:]:
        raise SystemExit('Usage: python scripts/apply-campus-review.py [--entrances]')
    else:
        main()
