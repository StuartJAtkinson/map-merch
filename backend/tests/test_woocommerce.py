"""Unit tests for the WooCommerce REST client (no network — httpx.MockTransport).

Run with:
    cd backend && .venv/Scripts/python.exe -m pytest tests/test_woocommerce.py -v
"""
import base64

import httpx
import pytest

from app.services.woocommerce import WooCommerceClient, WooCommerceError


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
