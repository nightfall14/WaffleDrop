from __future__ import annotations

import os

import uvicorn


def main() -> None:
    host = os.getenv("HOST", "0.0.0.0")

    port_raw = os.getenv("PORT", "8000")
    try:
        port = int(port_raw)
    except ValueError:
        port = 8000

    reload_raw = os.getenv("RELOAD", "1").strip().lower()
    reload_enabled = reload_raw not in {"0", "false", "no", "off"}

    uvicorn.run(
        "backend.main:app",
        host=host,
        port=port,
        reload=reload_enabled,
    )
