import asyncio
from motor.motor_asyncio import AsyncIOMotorClient

async def main():
    db = AsyncIOMotorClient("mongodb://localhost:27017")["wordpress_manager"]
    s = await db.settings.find_one({"id": "global_settings"}, {"_id": 0, "dataforseo_login": 1, "dataforseo_password": 1})
    print("Stored DFS credentials:", s)

asyncio.run(main())
