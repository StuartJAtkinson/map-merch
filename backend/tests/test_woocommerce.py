"""Unit tests for the WooCommerce REST client (no network — httpx.MockTransport).

Run with:
    cd backend && .venv/Scripts/python.exe -m pytest tests/test_woocommerce.py -v
"""
import base64
from types import SimpleNamespace

import httpx
import pytest

from app.services.woocommerce import (
    WooCommerceClient, WooCommerceError, build_product_payload, calculate_price,
)


def _client(handler):
    return WooCommerceClient("https://shop.example.com/", "ck_1", "cs_2",
                             transport=httpx.MockTransport(handler))


async def test_request_url_auth_and_body():
    seen = {}

    def handler(req: httpx.Request):
        seen["url"] = str(req.url)
        seen["auth"] = req.headers["authorization"]
        seen["body"] = req.content
        return httpx.Response(201, json={"id": 7})

    async with _client(handler) as wc:
        assert await wc.post("/products", {"name": "Bath tee"}) == {"id": 7}

    assert seen["url"] == "https://shop.example.com/wp-json/wc/v3/products"
    assert seen["auth"] == "Basic " + base64.b64encode(b"ck_1:cs_2").decode()
    assert b'"Bath tee"' in seen["body"]


async def test_error_surfaces_wc_message_and_status():
    def handler(req):
        return httpx.Response(404, json={"code": "woocommerce_rest_product_invalid_id",
                                         "message": "Invalid ID."})

    async with _client(handler) as wc:
        with pytest.raises(WooCommerceError, match="Invalid ID") as ei:
            await wc.get("products/999")
    assert ei.value.status_code == 404


def test_unconfigured_raises():
    with pytest.raises(WooCommerceError):
        WooCommerceClient("", "", "")


def test_product_payload_is_unpriced_draft_with_project_sku():
    project = SimpleNamespace(id=42, name="Bath", merch_type="3d_print",
                              bbox_west=-2.37, bbox_south=51.37, bbox_east=-2.34, bbox_north=51.39)
    p = build_product_payload(project)
    assert p["name"] == "Bath — Relief"
    assert p["status"] == "draft" and "regular_price" not in p
    assert p["sku"] == "hoas-42"
    meta = {m["key"]: m["value"] for m in p["meta_data"]}
    assert meta["hoas_project_id"] == "42"
    assert meta["hoas_bbox"] == "-2.370000,51.370000,-2.340000,51.390000"


def test_calculate_price_base_plus_markup_rounded_half_up():
    costs = {"mug": 6.20, "tshirt": 10}
    assert calculate_price("mug", costs, 50) == "9.30"
    assert calculate_price("tshirt", costs, 0) == "10.00"
    assert calculate_price("tshirt", costs, 12.345) == "11.23"   # 11.2345 → 11.23
    assert calculate_price("mug", {"mug": 1.01}, 50) == "1.52"   # 1.515 → 1.52 (half-up)
    assert calculate_price("tote", costs, 50) is None            # unconfigured → unpriced


def test_payload_carries_price_when_given():
    project = SimpleNamespace(id=1, name="Bath", merch_type="mug",
                              bbox_west=0, bbox_south=0, bbox_east=1, bbox_north=1)
    p = build_product_payload(project, "9.30")
    assert p["regular_price"] == "9.30" and p["status"] == "draft"
