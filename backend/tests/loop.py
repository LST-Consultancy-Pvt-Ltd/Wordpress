"""One event loop for every test module. core.db's Motor client is a
process-wide singleton and binds to the first loop that uses it, so modules
must not each create their own."""
import asyncio

LOOP = asyncio.new_event_loop()
