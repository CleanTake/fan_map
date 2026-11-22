"""Read the pinned OpenStreetMap snapshot shared by both campus graph generators."""
import gzip
import hashlib
from pathlib import Path
from xml.etree import ElementTree

SOURCE_URL = 'https://api.openstreetmap.org/api/0.6/map?bbox=-81.2075,43.0100,-81.1950,43.0170'
SOURCE_SHA256 = '3a1b9efd5468102afac0694f4898fe9db9a99b78de96f0ad4bb8da815b9a23dd'


def load_campus_osm():
    snapshot = Path(__file__).resolve().parents[1] / 'data/navigation/sources/campus.osm.gz'
    data = gzip.decompress(snapshot.read_bytes())
    if hashlib.sha256(data).hexdigest() != SOURCE_SHA256:
        raise ValueError('The campus OSM snapshot differs from the reviewed source.')
    return ElementTree.fromstring(data)
