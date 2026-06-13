"""
Smoke tests — hit every real endpoint, assert expected HTTP codes and shapes.
No mocks: if Overpass is down these will fail, which is the point.

Run with:
    docker compose exec backend python -m pytest tests/smoke.py -v
    # or from host (requires docker compose port 8000:8000):
    cd backend && .venv/Scripts/python.exe -m pytest tests/smoke.py -v -k "not test_stl"
    # STL is excluded from host runs because it is CPU-heavy and slow (>20 s).
"""

import pytest
import httpx

# ── Target URL ────────────────────────────────────────────────────────────────
import os
TARGET = os.environ.get("TEST_TARGET", "http://backend:8000").rstrip("/")


# ── Fixed bbox — Bath, UK city centre ──────────────────────────────────────────
BATH_BBOX = {
    "west":  -2.368,
    "south": 51.379,
    "east":  -2.350,
    "north": 51.390,
}


# ── Fixtures ───────────────────────────────────────────────────────────────────

@pytest.fixture
def client():
    """Sync httpx client pointed at TEST_TARGET."""
    with httpx.Client(base_url=TARGET, timeout=120.0) as c:
        yield c


# ── Helpers ────────────────────────────────────────────────────────────────────

def post_json(client, url, json=None):
    return client.post(url, json=json)


def get_params(client, url, params=None):
    return client.get(url, params=params)


# ── Health ─────────────────────────────────────────────────────────────────────

def test_health(client):
    """GET /health → 200 + {status: ok}."""
    r = get_params(client, f"{TARGET}/health")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "ok"


# ── Estimate ───────────────────────────────────────────────────────────────────

def test_estimate_svg(client):
    """POST /api/estimate → 200, returns complexity + area_km2."""
    r = post_json(client, f"{TARGET}/api/estimate", json={
        "bbox": BATH_BBOX,
        "merch_type": "tshirt",
        "style": "osm_default",
    })
    assert r.status_code == 200, r.text
    data = r.json()
    assert "complexity" in data
    assert "area_km2" in data
    assert 0 < data["area_km2"] < 5  # Bath city centre is ~1 km²


# ── SVG generation — all merch types ──────────────────────────────────────────

@pytest.mark.parametrize("merch_type", ["tshirt", "mug", "tote", "coaster", "placemat"])
def test_svg_generation__all_merch_types(client, merch_type):
    """POST /api/generate/svg → 200 + svg_url (relative path)."""
    r = post_json(client, f"{TARGET}/api/generate/svg", json={
        "bbox": BATH_BBOX,
        "merch_type": merch_type,
        "style": "osm_default",
        "include_labels": True,
        "include_buildings": True,
        "include_roads": True,
        "include_parks": True,
    })
    assert r.status_code == 200, r.text
    data = r.json()
    # SVG is streamed inline (not persisted server-side).
    assert "svg" in data
    assert data["svg"].lstrip().startswith("<")
    assert data["merch_type"] == merch_type


@pytest.mark.parametrize("style", ["osm_default", "minimalist", "vibrant"])
def test_svg_generation__all_styles(client, style):
    """POST /api/generate/svg (tshirt) with each style → 200."""
    r = post_json(client, f"{TARGET}/api/generate/svg", json={
        "bbox": BATH_BBOX,
        "merch_type": "tshirt",
        "style": style,
    })
    assert r.status_code == 200, r.text
    assert "svg" in r.json()


# ── STL generation ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("merch_type", ["coaster", "placemat", "3d_print"])
def test_stl_generation__all_merch_types(client, merch_type):
    """POST /api/generate/stl → 200 + three stl_ URLs."""
    r = post_json(client, f"{TARGET}/api/generate/stl", json={
        "bbox": BATH_BBOX,
        "merch_type": merch_type,
        "bldg_height": 4.0,
        "water_start": 1.0,
        "water_end": 2.0,
        "land_start": 2.0,
        "land_end": 3.0,
        "gap_close_mm": 0.8,
        "water_expand_mm": 0.5,
        "min_bldg_mm": 1.0,
        "collar_mm": 1.0,
    })
    assert r.status_code == 200, r.text
    data = r.json()
    # Three interlocking pieces streamed inline as base64 (land lid, water disc, buildings base)
    for part in ("buildings", "water", "land"):
        key = f"stl_{part}"
        assert key in data, f"Missing {key} in {data.keys()}"
        assert len(data[key]) > 0, f"Empty {key}"


# ── OSM proxy ─────────────────────────────────────────────────────────────────

def test_osm_features(client):
    """GET /api/osm/features?west=... → 200 + OSM elements."""
    params = {**BATH_BBOX}
    r = get_params(client, f"{TARGET}/api/osm/features", params=params)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "elements" in data
    # Bath should have ways
    assert len(data["elements"]) > 0, "Expected OSM data for Bath bbox"


# ── License check ───────────────────────────────────────────────────────────────

def test_license_check(client):
    """POST /api/license/check → 200 + attribution info."""
    r = post_json(client, f"{TARGET}/api/license/check", json={
        "bbox": BATH_BBOX,
        "data_sources": ["osm"],
    })
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), dict)  # structure validated by caller


# ── Error handling ─────────────────────────────────────────────────────────────

def test_generate_svg__bbox_too_large(client):
    """Bbox covering half of Europe → 422 from the server-side area guard.

    The guard (MAX_BBOX_AREA_KM2) refuses oversized bboxes before any
    Overpass fetch, so this is fast and deterministic — no more waiting
    out the 60s+60s Overpass timeouts.
    """
    r = post_json(client, f"{TARGET}/api/generate/svg", json={
        "bbox": {
            "west": -10, "south": 40, "east": 10, "north": 60,
        },
        "merch_type": "tshirt",
        "style": "osm_default",
    })
    assert r.status_code == 422, f"Expected 422 from area guard, got {r.status_code}: {r.text}"
    assert "too large" in r.json().get("detail", ""), r.text


def test_generate_svg__invalid_merch(client):
    """Unknown merch_type → 422."""
    r = post_json(client, f"{TARGET}/api/generate/svg", json={
        "bbox": BATH_BBOX,
        "merch_type": "banana",
        "style": "osm_default",
    })
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"


def test_generate_svg__invalid_bbox(client):
    """Bbox with north=91 (out of range) → 422."""
    r = post_json(client, f"{TARGET}/api/generate/svg", json={
        "bbox": {"west": 0, "south": 0, "east": 1, "north": 91},
        "merch_type": "tshirt",
        "style": "osm_default",
    })
    assert r.status_code == 422, f"Expected 422, got {r.status_code}"