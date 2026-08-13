import os

from motor.motor_asyncio import AsyncIOMotorClient

from core.config import ROOT_DIR  # noqa: F401  (ensures .env is loaded before reading env vars below)

mongo_url = os.environ['MONGO_URL']
mongo_client = AsyncIOMotorClient(mongo_url)
db = mongo_client[os.environ['DB_NAME']]
