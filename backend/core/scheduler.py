from apscheduler.schedulers.asyncio import AsyncIOScheduler

# Shared across server.py and every routers/*.py module that schedules jobs
# (e.g. media plan task execution) so they all operate on the same running
# scheduler instance.
scheduler = AsyncIOScheduler()
