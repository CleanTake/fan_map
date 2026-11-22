"""Compile the ground-floor schematic and OSM pedestrian network. No downloads.

Input data/navigation/sources/campus.osm.gz is an OSM API map extract. Rebuild from frontend with
python scripts/prepare-campus-network.py. Coordinates are approximate, not surveyed.
"""
import json
import math
from pathlib import Path
from campus_osm import SOURCE_SHA256, SOURCE_URL, load_campus_osm

ROOT = Path(__file__).resolve().parents[1]
R = 6378137
registration = json.loads((ROOT / 'data/navigation/reference-registration.json').read_bytes())
source = json.loads((ROOT / 'data/navigation/reference-passages.json').read_bytes())


def project(pixel):
    x, y = [o + a * pixel[0] + b * pixel[1] + c for o, (a, b, c) in zip(registration['mercatorOrigin'], registration['pixelToMercator'])]
    return [x / R * 180 / math.pi, math.atan(math.sinh(y / R)) * 180 / math.pi]


def unproject(point):
    (a, b, c), (d, e, f) = registration['pixelToMercator']
    x = R * math.radians(point[0]) - registration['mercatorOrigin'][0] - c
    y = R * math.asinh(math.tan(math.radians(point[1]))) - registration['mercatorOrigin'][1] - f
    return [(e * x - b * y) / (a * e - b * d), (a * y - d * x) / (a * e - b * d)]


def distance(a, b):
    lat1, lat2 = map(math.radians, [a[1], b[1]])
    lat = lat2 - lat1
    lon = math.radians(b[0] - a[0])
    return 6371000 * 2 * math.asin(min(1, math.sqrt(math.sin(lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(lon / 2) ** 2)))


def main():
    osm = load_campus_osm()
    osm_nodes = {node.attrib['id']: [float(node.attrib['lon']), float(node.attrib['lat'])] for node in osm.findall('node')}
    nodes, edges = {}, []
    edge_sequence = 0

    def add_edge(a, b, kind, label, buildings=None, source_id=None):
        nonlocal edge_sequence
        length = distance(nodes[a], nodes[b])
        if length > 0.02:
            edges.append({'id': f'e{edge_sequence}', 'from': a, 'to': b, 'kind': kind, 'label': label,
                          'buildings': [{'Student_union': 'SUB', 'student_center': 'SC'}.get(code, code) for code in (buildings or [])], 'lengthMetres': round(length, 3), 'sourceId': source_id})
            edge_sequence += 1

    highways = {'footway', 'path', 'pedestrian', 'steps', 'service', 'living_street', 'residential', 'unclassified'}
    for way in osm.findall('way'):
        tags = {tag.attrib['k']: tag.attrib['v'] for tag in way.findall('tag')}
        if tags.get('highway') not in highways or tags.get('foot') in {'no', 'private', 'use_sidepath'} or tags.get('access') in {'no', 'private'}:
            continue
        if tags.get('service') in {'driveway', 'emergency_access'}:
            continue
        refs = [node.attrib['ref'] for node in way.findall('nd')]
        for a, b in zip(refs, refs[1:]):
            if a not in osm_nodes or b not in osm_nodes:
                continue
            midpoint = [(x + y) / 2 for x, y in zip(osm_nodes[a], osm_nodes[b])]
            if not (-81.2075 <= midpoint[0] <= -81.195 and 43.0100 <= midpoint[1] <= 43.017):
                continue
            nodes['osm:' + a], nodes['osm:' + b] = osm_nodes[a], osm_nodes[b]
            label = tags.get('name') or ('parking access' if tags.get('service') == 'parking_aisle' else 'mapped pedestrian path')
            add_edge('osm:' + a, 'osm:' + b, 'outdoor', label, source_id='osm-way:' + way.attrib['id'])

    # Explicit public entrances. Do not attach every OSM entrance to a hallway:
    # H-M's mapped doorway tags, for example, were corrected to a door-free link.
    ports = [
        ('F main entrance', [531, 284], '13960477066', ['F']),
        ('B south entrance', [364.3, 451], '10739091793', ['B']),
        ('D west entrance', [449, 412], '1722999897', ['D']),
        ('D south entrance', [511, 432], '13960477150', ['D']),
        ('H south entrance', [590.3, 242], '13960477060', ['H']),
    ]
    passages = list(source['passages'])
    pixel_osm = {}
    door_nodes = []
    for label, start, osm_id, buildings in ports:
        end = unproject(osm_nodes[osm_id])
        length = math.dist(start, end)
        inside = [b + (a - b) * min(1, 1 / length) for a, b in zip(start, end)]
        passages.append({'id': 'approach-' + osm_id, 'label': label + ' passage', 'pixels': [start, inside], 'kind': 'indoor', 'buildings': buildings})
        passages.append({'id': 'door-' + osm_id, 'label': 'Pass through ' + label, 'pixels': [inside, end], 'kind': 'door', 'buildings': buildings})
        pixel_osm[tuple(round(value, 4) for value in end)] = 'osm:' + osm_id
        nodes['osm:' + osm_id] = osm_nodes[osm_id]
        door_nodes.append({'label': label, 'coordinates': osm_nodes[osm_id]})

    # Only explicitly reviewed outdoor contacts join the imported graph. This
    # retains OSM crossing topology everywhere else and avoids nearby-wall jumps.
    outdoor_joins = []
    for join in source.get('outdoorJoins', []):
        point = join['pixel']
        candidates = []
        for edge in edges:
            if edge['sourceId'] != 'osm-way:' + join['osmWayId']:
                continue
            a, b = unproject(nodes[edge['from']]), unproject(nodes[edge['to']])
            vector = [b[i] - a[i] for i in range(2)]
            denom = sum(value * value for value in vector)
            t = max(0, min(1, sum((point[i] - a[i]) * vector[i] for i in range(2)) / denom)) if denom else 0
            nearest = [a[i] + t * vector[i] for i in range(2)]
            candidates.append((math.dist(point, nearest), edge, t))
        if not candidates:
            raise ValueError(f"No imported footpath for reviewed join {join['id']}")
        gap, edge, t = min(candidates, key=lambda item: item[0])
        if gap > 0.01:
            raise ValueError(f"Reviewed outdoor join moved off its footpath: {join['id']}")
        if t < 1e-8:
            node_id = edge['from']
        elif t > 1 - 1e-8:
            node_id = edge['to']
        else:
            node_id = 'join:' + join['id']
            nodes[node_id] = project(point)
            edges.remove(edge)
            add_edge(edge['from'], node_id, 'outdoor', edge['label'], source_id=edge['sourceId'])
            add_edge(node_id, edge['to'], 'outdoor', edge['label'], source_id=edge['sourceId'])
        pixel_osm[tuple(round(value, 4) for value in point)] = node_id
        outdoor_joins.append({'id': join['id'], 'nodeId': node_id, 'osmWayId': join['osmWayId']})

    segments = []
    for passage in passages:
        for a, b in zip(passage['pixels'], passage['pixels'][1:]):
            if math.dist(a, b) > 0.00001:
                segments.append({'a': a, 'b': b, 'path': passage, 'cuts': {0.0, 1.0}})

    # Explicitly split this single-floor centreline dataset at shared junctions.
    # Geographic outdoor crossings still join only through shared OSM node IDs.
    def cross(a, b):
        return a[0] * b[1] - a[1] * b[0]

    def delta(a, b):
        return [a[0] - b[0], a[1] - b[1]]

    for i, first in enumerate(segments):
        a, r = first['a'], delta(first['b'], first['a'])
        for second in segments[i + 1:]:
            b, s = second['a'], delta(second['b'], second['a'])
            denominator = cross(r, s)
            if abs(denominator) > 1e-8:
                t, u = cross(delta(b, a), s) / denominator, cross(delta(b, a), r) / denominator
                if -1e-7 <= t <= 1 + 1e-7 and -1e-7 <= u <= 1 + 1e-7:
                    first['cuts'].add(round(max(0, min(1, t)), 8))
                    second['cuts'].add(round(max(0, min(1, u)), 8))
            elif abs(cross(delta(b, a), r)) < 1e-7:
                for target, point, vector in [(first, b, r), (first, second['b'], r), (second, a, s), (second, first['b'], s)]:
                    t = sum(x * y for x, y in zip(delta(point, target['a']), vector)) / sum(x * x for x in vector)
                    if 0 < t < 1:
                        target['cuts'].add(round(t, 8))

    def indoor_node(pixel):
        key = tuple(round(value, 4) for value in pixel)
        id = pixel_osm.get(key) or f'in:{key[0]}:{key[1]}'
        nodes.setdefault(id, [round(value, 8) for value in project(pixel)])
        return id

    for segment in segments:
        a, b = segment['a'], segment['b']
        points = [[a[axis] + (b[axis] - a[axis]) * t for axis in range(2)] for t in sorted(segment['cuts'])]
        for start, end in zip(points, points[1:]):
            passage = segment['path']
            add_edge(indoor_node(start), indoor_node(end), passage['kind'], passage['label'], passage.get('buildings'), passage['id'])

    # The visible C north entrance isn't tagged as an entrance in OSM. Join its
    # mapped approach to the closest outdoor segment, with an explicit door edge.
    c_door = indoor_node([291, 312])
    point = nodes[c_door]
    best = None
    for edge in edges:
        if not edge['sourceId'].startswith('osm-way:'):
            continue
        a, b = nodes[edge['from']], nodes[edge['to']]
        scale = math.cos(math.radians(point[1]))
        vector = [(b[0] - a[0]) * scale, b[1] - a[1]]
        denom = sum(value * value for value in vector)
        t = max(0, min(1, ((point[0] - a[0]) * scale * vector[0] + (point[1] - a[1]) * vector[1]) / denom)) if denom else 0
        nearest = [a[axis] + t * (b[axis] - a[axis]) for axis in range(2)]
        metres = distance(point, nearest)
        if best is None or metres < best[0]:
            best = (metres, edge, nearest)
    if best and best[0] <= 35:
        _, edge, nearest = best
        nodes['c-north-approach'] = nearest
        edges.remove(edge)
        add_edge(edge['from'], 'c-north-approach', 'outdoor', edge['label'], source_id=edge['sourceId'])
        add_edge('c-north-approach', edge['to'], 'outdoor', edge['label'], source_id=edge['sourceId'])
        add_edge(c_door, 'c-north-approach', 'door', 'Pass through the C north entrance', ['C'], 'C-north-door')
        door_nodes.append({'label': 'C north entrance (schematic)', 'coordinates': point})

    for passage in source['passages']:
        if passage['kind'] == 'door':
            centre = project([(a + b) / 2 for a, b in zip(passage['pixels'][0], passage['pixels'][-1])])
            if not any(distance(centre, door['coordinates']) < 5 for door in door_nodes):
                door_nodes.append({'label': passage['label'], 'coordinates': centre})

    buildings = []
    for file in sorted((ROOT.parent / 'data/building_outlines').glob('*.geojson'), key=lambda p: p.name.casefold()):
        for feature in json.loads(file.read_bytes())['features']:
            if feature['geometry']['type'] == 'Polygon':
                buildings.append({'code': feature['properties'].get('ref') or file.stem, 'rings': feature['geometry']['coordinates']})
    reviews = source.get('reviews', [])
    output = {
        'version': 1, 'floor': 'ground', 'topology': 'user-confirmed-Q1-Q5-and-reviewed-additions' if reviews else 'user-confirmed-Q1-Q5',
        'reviews': [{'date': review['date'], 'sourceSha256': review['sourceSha256'], 'annotationCount': review['annotationCount'], 'connectionCount': review.get('connectionCount', review['annotationCount'])} for review in reviews],
        'outdoorJoins': outdoor_joins,
        'geometry': 'approximate-schematic-registration',
        'attribution': '© OpenStreetMap contributors (ODbL); campus passages from user-supplied plan and confirmations.',
        'outdoorSource': SOURCE_URL,
        'outdoorSourceSha256': SOURCE_SHA256,
        'nodes': nodes, 'edges': edges, 'buildings': buildings, 'doors': door_nodes,
    }
    # Existing saved annotations identify this exact serialization by SHA-256.
    data = json.dumps(output, separators=(',', ':')) + '\r\n'
    (ROOT / 'data/navigation/campus-network.json').write_bytes(data.encode('utf-8'))
    print(json.dumps({'nodes': len(nodes), 'edges': len(edges), 'doors': len(door_nodes), 'CEntranceApproachMetres': round(best[0], 1) if best else None}))


if __name__ == '__main__':
    main()
