"""
WooCommerce REST API (v3) client.

Thin async wrapper (auth, base URL, JSON in/out, errors) plus the
design-project → product payload mapping.
"""

import httpx
from app.core.config import get_settings


# Same labels as the frontend's merch map (UX.md › Terminology)
MERCH_LABELS = {
    "tshirt": "T-Shirt", "mug": "Mug", "tote": "Tote Bag",
    "coaster": "Coaster", "placemat": "Placemat", "3d_print": "Relief",
}


def product_sku(project_id: int) -> str:
    return f"hoas-{project_id}"


def build_product_payload(project) -> dict:
    """WooCommerce product body for a DesignProject.

    Created as a draft with no price — pricing is a separate step, so nothing
    goes on sale until it's set. SKU is unique per project, so WooCommerce
    itself rejects a second create for the same design.
    """
    label = MERCH_LABELS.get(project.merch_type, project.merch_type)
    bbox = [project.bbox_west, project.bbox_south, project.bbox_east, project.bbox_north]
    return {
        "name": f"{project.name} — {label}",
        "type": "simple",
        "status": "draft",
        "sku": product_sku(project.id),
        "meta_data": [
            {"key": "hoas_project_id", "value": str(project.id)},
            {"key": "hoas_merch_type", "value": project.merch_type},
            {"key": "hoas_bbox", "value": ",".join(f"{v:.6f}" for v in bbox)},
        ],
    }


class WooCommerceError(Exception):
    """Raised when the store is unconfigured or returns a non-2xx response."""

    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


class WooCommerceClient:
    def __init__(self, store_url: str, consumer_key: str, consumer_secret: str,
                 transport: httpx.AsyncBaseTransport | None = None):
        if not (store_url and consumer_key and consumer_secret):
            raise WooCommerceError("WooCommerce store URL / consumer key / secret not set")
        # Basic auth with the consumer key/secret — WooCommerce only accepts this over HTTPS
        self._client = httpx.AsyncClient(
            base_url=store_url.rstrip("/") + "/wp-json/wc/v3/",
            auth=(consumer_key, consumer_secret),
            timeout=httpx.Timeout(20.0, connect=5.0),
            headers={"User-Agent": "heart-on-a-sleeve/1.0"},
            transport=transport,
        )

    @classmethod
    def from_settings(cls) -> "WooCommerceClient":
        s = get_settings()
        return cls(s.woocommerce_store_url, s.woocommerce_consumer_key, s.woocommerce_consumer_secret)

    async def request(self, method: str, path: str, **kwargs) -> dict | list:
        try:
            r = await self._client.request(method, path.lstrip("/"), **kwargs)
        except httpx.HTTPError as e:
            raise WooCommerceError(f"WooCommerce unreachable: {e}") from e
        if not r.is_success:
            # WC errors are {"code": ..., "message": ...}
            try:
                msg = r.json().get("message", r.text)
            except ValueError:
                msg = r.text
            raise WooCommerceError(f"WooCommerce {r.status_code}: {msg}", r.status_code)
        return r.json()

    async def get(self, path: str, **params) -> dict | list:
        return await self.request("GET", path, params=params or None)

    async def post(self, path: str, data: dict) -> dict:
        return await self.request("POST", path, json=data)

    async def put(self, path: str, data: dict) -> dict:
        return await self.request("PUT", path, json=data)

    async def delete(self, path: str, force: bool = False) -> dict:
        return await self.request("DELETE", path, params={"force": str(force).lower()})

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        await self.aclose()
