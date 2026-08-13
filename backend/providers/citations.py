"""NAP/citations-checking provider abstraction — the extension point for a
follow-up to the §1 Local Citations fix in `routers/opportunities.py`.

No vendor is wired in here. BrightLocal, Whitespark, and Moz Local all
require (a) a paid subscription and (b) a non-trivial, vendor-specific
signed-request API that isn't a well-known, memorizable shape the way
Google's Custom Search API is — implementing `check_listing()` correctly
requires that vendor's actual API documentation, which isn't available in
this environment. Guessing at the request/response shape would produce code
that *looks* like a real fix but silently fails or returns wrong data at
runtime, which is worse than the honest CSE-approximation fallback that
`routers/opportunities.py::_check_directory_listing` already uses.

To finish this once a vendor is chosen:
1. Pick BrightLocal, Whitespark, Moz Local, or similar, and get an account +
   API credentials.
2. Add the credential field(s) to `models.legacy.Settings`/`SettingsUpdate`
   and mask/encrypt them the same way `google_search_api_key` was handled.
3. Implement `check_listing()` below against that vendor's real API.
4. In `routers/opportunities.py::audit_local_citations`, add a real-provider
   branch that runs BEFORE the `cse_available()` check, mirroring how
   DataForSEO/CSE branches were added elsewhere in this file — real data
   first, CSE approximation second, AI estimate last.
"""


async def citations_provider_configured() -> bool:
    """Always False until step 1-3 above are done — nothing here can silently
    start returning real data; a real implementation has to actively flip this."""
    return False


async def check_listing(directory: str, business_name: str, address: str, phone: str) -> dict:
    """Real NAP/citation check via a dedicated provider. NOT IMPLEMENTED YET
    — see this module's docstring. Raises NotImplementedError (distinct from
    "provider not configured") so it's obvious this is unbuilt, not just
    unconfigured, if anything ever calls it before step 3 above is done."""
    raise NotImplementedError(
        "No NAP/citations provider is wired in yet. Pick a vendor (BrightLocal, "
        "Whitespark, Moz Local, etc.), get their API docs, and implement "
        "check_listing() here — see this module's docstring for the full checklist."
    )
