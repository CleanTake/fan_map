"""FanMap's small, static API.

Run from this directory with: uvicorn server:app --port 3030 --reload
"""

from blacksheep import Application, get
from blacksheep.server.responses import json, not_found, redirect

app = Application()


ROUTES = [
    {
        "route": "4",
        "name": "Hamilton Road",
        "stop": "Fanshawe College Main Entrance",
        "arrivals": ["08:12", "08:42", "09:12", "09:42"],
    },
    {
        "route": "19",
        "name": "Oxford West",
        "stop": "Fanshawe College Main Entrance",
        "arrivals": ["08:05", "08:35", "09:05", "09:35"],
    },
    {
        "route": "20",
        "name": "Cherryhill",
        "stop": "Fanshawe College South Stop",
        "arrivals": ["08:18", "08:48", "09:18", "09:48"],
    },
    {
        "route": "25",
        "name": "Fanshawe College",
        "stop": "Fanshawe College South Stop",
        "arrivals": ["08:10", "08:40", "09:10", "09:40"],
    },
]

STUDY_ROOMS = {
    "27743": "https://fanshawec.libcal.com/space/27743",
}


@get("/api/routes")
async def routes():
    return json(ROUTES)


@get("/api/study_room/{study_id}")
async def study_room(study_id: str):
    booking_url = STUDY_ROOMS.get(study_id)
    if booking_url is None:
        return not_found()
    return redirect(booking_url)
