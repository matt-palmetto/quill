"""quill-extract: docling text extraction worker (CONTRACT.md quill-extract).

POST /extract  body = raw file bytes, headers x-filename + content-type
               -> {"text": str, "pages": int|None, "truncated": bool}
GET  /healthz  -> {"status": "ok"}
"""

from __future__ import annotations

import asyncio
import logging
import tempfile
from pathlib import Path
from urllib.parse import unquote
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from app.extract import (
    ExtractionError,
    UnsupportedFormatError,
    extract_text_from_bytes,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("quill-extract")

MAX_REQUEST_BYTES = 50 * 1024 * 1024  # CONTRACT.md 50MB per-file cap, matches pipeline scan.

app = FastAPI(title="quill-extract")


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok"}


def _filename_from_header(raw_header: str | None) -> str:
    """The pipeline encodeURIComponent()s the filename (header values must be Latin-1)."""
    if not raw_header:
        return "upload"
    try:
        return unquote(raw_header)
    except Exception:  # noqa: BLE001 - header decoding must never crash the request
        return raw_header


@app.post("/extract")
async def extract(request: Request) -> JSONResponse:
    content_length = request.headers.get("content-length")
    if content_length is not None and int(content_length) > MAX_REQUEST_BYTES:
        raise HTTPException(status_code=413, detail="request exceeds 50MB cap")

    body = await request.body()
    if len(body) > MAX_REQUEST_BYTES:
        raise HTTPException(status_code=413, detail="request exceeds 50MB cap")
    if len(body) == 0:
        raise HTTPException(status_code=400, detail="empty request body")

    filename = _filename_from_header(request.headers.get("x-filename"))
    content_type = request.headers.get("content-type", "application/octet-stream")

    try:
        # docling conversion is synchronous and CPU-bound. Calling it
        # directly blocked the event loop for the length of a PDF, so
        # /healthz stopped answering and the liveness probe SIGKILLed the
        # pod mid-document (exit 137, 2026-08-07).
        result = await asyncio.to_thread(
            extract_text_from_bytes, body, filename=filename, content_type=content_type
        )
    except UnsupportedFormatError as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from exc
    except ExtractionError as exc:
        logger.warning("extraction failed for %s: %s", filename, exc)
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return JSONResponse(content=result)
