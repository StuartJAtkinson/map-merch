import math
import time
import httpx
from datetime import datetime
from ..models.schemas import BBox
from ..timing_utils import tlog


class OverpassError(Exception):
    """Raised when the Overpass API cannot be reached or returns an error."""
    def __init__(self, message: str, status_code: int = 0):
        super().__init__(message)
        self.status_code = status_code


# Mirror tried once if the primary endpoint returns a transient error
_MIRROR = "https://overpass.kumi.systems/api/interpreter"


def _build_query(bb: str, km2: float, timeout: int, force_buildings: bool = False) -> str:
    """Return a single comprehensive Overpass QL query — ALL features, no area tiering.

    Area-based filtering used to scale the feature set down for larger selections. That
    is now enforced at the frontend via a hard selection-size cap (MAX_AREA_KM2), so we
    always fetch the complete feature set for whatever area was selected. ``km2`` and
    ``force_buildings`` are retained for call-site compatibility but no longer alter the
    query (buildings and every road/path class are always included).
    """
    features = f"""
  way["highway"]({bb});
  way["landuse"]({bb});
  way["leisure"]({bb});
  way["natural"]({bb});
  way["building"]({bb});
  way["waterway"]({bb});
  way["railway"]({bb});
  relation["natural"]({bb});
  relation["landuse"]({bb});
  node["place"~"city|town|village|hamlet|suburb|neighbourhood|quarter|island"]({bb});"""
    return f"[out:json][timeout:{timeout}];\n(\n{features}\n);\nout body;\n>;\nout skel qt;\n"


class OSMFetcher:
    """Fetches OSM data via Overpass API with a single-shot mirror fallback."""

    def __init__(self, overpass_endpoint: str):
        self.endpoint = overpass_endpoint
        # Primary first, then mirror (each tried exactly once — no retry loops)
        self._endpoints = [overpass_endpoint] + (
            [_MIRROR] if overpass_endpoint != _MIRROR else []
        )
        self._cache: dict[tuple, tuple[dict, float]] = {}
        self._cache_ttl = 300  # 5-minute TTL so colour regens are instant

    async def fetch_area(self, bbox: BBox, timeout: int = 60, force_buildings: bool = False) -> dict:
        key = (round(bbox.west, 5), round(bbox.south, 5),
               round(bbox.east, 5), round(bbox.north, 5), force_buildings)
        cached = self._cache.get(key)
        if cached and (time.time() - cached[1] < self._cache_ttl):
            data = cached[0]
            data['_cached'] = True
            return data

        bb = f"{bbox.south},{bbox.west},{bbox.north},{bbox.east}"
        cos_lat = math.cos((bbox.south + bbox.north) / 2 * math.pi / 180)
        km2 = round((bbox.east - bbox.west) * cos_lat * 111.32 * (bbox.north - bbox.south) * 111.32, 2)
        query = _build_query(bb, km2, timeout, force_buildings=force_buildings)
        headers = {"User-Agent": "heart-on-a-sleeve/1.0", "Accept": "*/*"}

        last_error: OverpassError | None = None
        for endpoint in self._endpoints:
            try:
                t0 = time.perf_counter()
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(connect=10, read=timeout + 5, write=10, pool=5),
                    headers=headers,
                ) as client:
                    response = await client.post(endpoint, data={"data": query})

                elapsed_ms = (time.perf_counter() - t0) * 1000

                # Transient server errors — try next endpoint
                if response.status_code in (429, 503, 504):
                    last_error = OverpassError(
                        f"Overpass {response.status_code} from {endpoint[-20:]}", response.status_code)
                    tlog("overpass_transient", elapsed_ms,
                         f"status={response.status_code} ep={endpoint[-20:]} km2={km2}")
                    continue

                # Non-transient HTTP error — don't bother trying mirrors
                if not response.is_success:
                    raise OverpassError(
                        f"Overpass returned HTTP {response.status_code}", response.status_code)

                data = response.json()
                tlog("overpass_fetch", elapsed_ms,
                     f"km2={km2} elements={len(data.get('elements', []))} ep={endpoint[-20:]}")
                self._cache[key] = (data, time.time())
                return data

            except httpx.TimeoutException:
                last_error = OverpassError(
                    f"Overpass timed out after {timeout}s — try a smaller area", 504)
                tlog("overpass_timeout", (time.perf_counter() - t0) * 1000,
                     f"ep={endpoint[-20:]} km2={km2}")
            except httpx.ConnectError:
                last_error = OverpassError(
                    "Cannot reach Overpass API — check network connection", 503)
            except OverpassError:
                raise
            except httpx.HTTPError as e:
                last_error = OverpassError(f"Overpass network error: {e}", 502)

        raise last_error or OverpassError("Overpass fetch failed", 502)

    async def get_license_info(self, bbox: BBox) -> dict:
        return {
            "license": "ODbL",
            "url": "https://www.openstreetmap.org/copyright",
            "attribution_required": True,
            "attribution": "© OpenStreetMap contributors",
            "data_sources": ["OpenStreetMap contributors"],
            "fetched_at": datetime.utcnow().isoformat(),
            "bbox": bbox.model_dump(),
        }