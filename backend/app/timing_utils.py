"""Lightweight timing logger — writes to <project-root>/timing.log and stdout."""
import os as _os
import time
from pathlib import Path
from fastapi import APIRouter

VERSION = "current"
LOG_PATH = Path(_os.environ.get("DATA_DIR", str(Path(__file__).resolve().parents[2]))) / "timing.log"

def tlog(label: str, ms: float, extra: str = "") -> None:
    ts = time.strftime("%H:%M:%S")
    line = f"[{VERSION}][{ts}] {label:<42} {ms:>8.0f}ms  {extra}"
    print(line, flush=True)
    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(line + "\n")

router = APIRouter()

@router.post("/api/timing")
async def record_timing(payload: dict) -> dict:
    tlog(f"[FE] {payload.get('label','?')}", float(payload.get("ms", 0)), payload.get("extra", ""))
    return {"ok": True}
