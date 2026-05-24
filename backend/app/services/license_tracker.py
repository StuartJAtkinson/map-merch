from datetime import datetime


class LicenseTracker:
    """Tracks license requirements for all data sources used in a design."""

    LICENSE_INFO = {
        "odbl": {
            "name": "Open Database License v1.0",
            "url": "https://www.openstreetmap.org/copyright",
            "attribution_required": True,
            "share_alike": True,
            "compatible_with_commercial": False,
        },
        "cc_by_sa": {
            "name": "Creative Commons Attribution-ShareAlike 2.0",
            "url": "https://creativecommons.org/licenses/by-sa/2.0/",
            "attribution_required": True,
            "share_alike": True,
            "compatible_with_commercial": True,
        },
        "cc0": {
            "name": "Public Domain (CC0)",
            "url": "https://creativecommons.org/publicdomain/zero/1.0/",
            "attribution_required": False,
            "share_alike": False,
            "compatible_with_commercial": True,
        },
        "public_domain": {
            "name": "Public Domain",
            "attribution_required": False,
            "share_alike": False,
            "compatible_with_commercial": True,
        },
    }

    async def check_licenses(self, bbox: dict, data_sources: list[str]) -> dict:
        """Check license compliance for given bbox and data sources."""
        results = []
        for source in data_sources:
            license_data = self._get_source_license(source)
            results.append({
                "source": source,
                "license": license_data,
                "attribution_required": license_data.get("attribution_required", False),
                "bbox": bbox,
            })

        return {
            "checked_at": datetime.utcnow().isoformat(),
            "sources": results,
            "all_compatible": all(r["license"].get("compatible_with_commercial", False) for r in results),
        }

    def _get_source_license(self, source: str) -> dict:
        """Return license info for a data source."""
        if source == "osm":
            return self.LICENSE_INFO["odbl"]
        elif source == "custom_upload":
            return self.LICENSE_INFO["cc_by_sa"]
        elif source == "public_domain_asset":
            return self.LICENSE_INFO["cc0"]
        return self.LICENSE_INFO["public_domain"]

    def generate_attribution_svg(self, license_data: dict) -> str:
        """Generate SVG text block with all required attributions."""
        attributions = []
        for src in license_data.get("sources", []):
            lic = src["license"]
            attributions.append(f'{lic["name"]} - {lic["url"]}')
        return " | ".join(attributions)