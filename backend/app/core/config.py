import os
from pydantic_settings import BaseSettings
from functools import lru_cache


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

    # App
    secret_key: str = "change-me-in-production"
    cors_origins: list[str] = ["http://localhost:3000", "http://localhost:5173"]

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


@lru_cache
def get_settings() -> Settings:
    return Settings()