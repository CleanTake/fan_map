"""
commands to start uvicorn server
uvicorn server:app --port 3030 --reload
"""

from datetime import datetime, timezone
from blacksheep import Application, get

app = Application()

@get("/")
async def home():
    return f"Hello, World! {datetime.now(timezone.utc).isoformat()}"