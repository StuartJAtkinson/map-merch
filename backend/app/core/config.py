import json
from functools import lru_cache
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Database
    database_url: str = "sqlite+aiosqlite:///./dev.db"

    # WooCommerce
    woocommerce_store_url: str = ""
    woocommerce_consumer_key: str = ""
    woocommerce_consumer_secret: str = ""

    # POD Provider
    pod_provider: str = "prodigi"  # prodigi or printful
    prodigi_api_key: str = ""
    prodigi_webhook_secret: str = ""
    printful_api_key: str = ""

    # OSM / Mapping
    overpass_endpoint: str = "https://overpass-api.de/api/interpreter"
    osmium_path: str = "/usr/local/bin/osmium"

    # Stripe
    stripe_secret_key: str = ""

    # Email (SendGrid)
    sendgrid_api_key: str = ""
    email_from_address: str = "noreply@stuartjatkinson.co.uk"
    app_base_url: str = "https://green.stuartjatkinson.co.uk"

    # App
    environment: str = "development"  # set ENVIRONMENT=production in deploys
    secret_key: str = "change-me-in-production"
    port: str = "8080"
    data_dir: str = "/app/data"

    # Stored as a plain string; use .get_cors_origins() to get the parsed list.
    # Accepts comma-separated ("a,b") or JSON array ('["a","b"]').
    cors_origins: str = "http://localhost:3000,http://localhost:5174"

    def get_cors_origins(self) -> list[str]:
        try:
            parsed = json.loads(self.cors_origins)
            return parsed if isinstance(parsed, list) else [parsed]
        except (json.JSONDecodeError, ValueError):
            return [o.strip() for o in self.cors_origins.split(",")]

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


@lru_cache
def get_settings() -> Settings:
    return Settings()