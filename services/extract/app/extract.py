"""Document -> text extraction for Quill (CONTRACT.md quill-extract).

Engine order:
  1. **anydoc** (Firecrawl, MIT) — pure-Rust, no ML models, median ~5 ms per
     document, handles PDF/Word/PowerPoint/Excel/OpenDocument/RTF/EPUB/CSV
     and releases the GIL. Essentially every real document takes this path.
  2. **docling** — only for files anydoc cannot read (chiefly scanned,
     image-only PDFs). It runs ML layout inference per page: correct, but
     ~3 minutes for a typical 800 KB PDF on CPU, which was the entire
     pipeline's bottleneck before anydoc landed (2026-08-07).

Quill indexes text for retrieval, not layout reconstruction, so the fast
path is the right default. OCR remains off (scanned pages are indexed by
filename/path only) — revisit when there is budget for it.
"""

from __future__ import annotations

import os
from pathlib import Path

MAX_TEXT_CHARS = 10 * 1024 * 1024  # pipeline caps stored text at 10MB

# torch (docling's fallback path) sizes its thread pool from the HOST cpu
# count, not the cgroup quota, so inside a limited container it spawned ~96
# threads and thrashed. Pin it.
_THREADS = int(os.environ.get("QUILL_EXTRACT_THREADS", "0") or 0)
if _THREADS > 0:
    try:
        import torch

        torch.set_num_threads(_THREADS)
    except Exception:  # never fail startup over a tuning knob
        pass

# Formats we accept. Anything else is the pipeline's job (plain readers) and
# reaching us with it is a caller bug -> 415.
SUFFIX_BY_HINT = {
    ".pdf": ".pdf",
    ".docx": ".docx",
    ".doc": ".doc",
    ".docm": ".docm",
    ".pptx": ".pptx",
    ".ppt": ".ppt",
    ".xlsx": ".xlsx",
    ".xls": ".xls",
    ".xlsm": ".xlsm",
    ".rtf": ".rtf",
    ".odt": ".odt",
    ".ods": ".ods",
    ".odp": ".odp",
    ".epub": ".epub",
}

# Suffixes docling can attempt when anydoc declines.
_DOCLING_FALLBACK_SUFFIXES = {".pdf", ".docx", ".doc", ".pptx", ".xlsx", ".rtf", ".odt"}


class ExtractionError(Exception):
    """Every engine failed on a supported format."""


class UnsupportedFormatError(Exception):
    """Caller sent a format this worker does not handle."""


def _anydoc_markdown(body: bytes) -> str | None:
    """Convert with anydoc. Returns None when anydoc cannot read the bytes."""
    try:
        import anydoc
    except ImportError:
        return None
    try:
        text = anydoc.to_markdown_bytes(body)
    except Exception:
        # Encrypted / malformed / unsupported / resource-limited — all worth
        # a docling attempt rather than failing the file outright.
        return None
    if not text or not text.strip():
        return None
    return text


_converter = None


def _get_converter():
    """Build the docling DocumentConverter once (model warm-up is expensive)."""
    global _converter
    if _converter is None:
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.document_converter import DocumentConverter, PdfFormatOption

        pdf_opts = PdfPipelineOptions()
        artifacts = os.environ.get("DOCLING_ARTIFACTS")
        if artifacts:
            pdf_opts.artifacts_path = artifacts
        pdf_opts.do_ocr = False
        # TableFormer roughly doubles PDF cost; table CONTENT still comes
        # through as text without it.
        pdf_opts.do_table_structure = os.environ.get("QUILL_EXTRACT_TABLES", "0") == "1"
        _converter = DocumentConverter(
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pdf_opts)}
        )
    return _converter


def _docling_markdown(body: bytes, suffix: str):
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
        tmp.write(body)
        tmp.flush()
        result = _get_converter().convert(tmp.name)
        doc = result.document
        pages = len(doc.pages) if getattr(doc, "pages", None) else None
        return doc.export_to_markdown(), pages


def _result(text: str, pages, engine: str) -> dict:
    truncated = len(text) > MAX_TEXT_CHARS
    return {
        "text": text[:MAX_TEXT_CHARS] if truncated else text,
        "pages": pages,
        "truncated": truncated,
        "engine": engine,
    }


def extract_text_from_bytes(body: bytes, *, filename: str, content_type: str) -> dict:
    suffix = Path(filename).suffix.lower()
    if suffix not in SUFFIX_BY_HINT:
        raise UnsupportedFormatError(f"unsupported extension {suffix!r} for {filename!r}")

    if os.environ.get("QUILL_ANYDOC", "1") == "1":
        text = _anydoc_markdown(body)
        if text is not None:
            return _result(text, None, "anydoc")

    if suffix not in _DOCLING_FALLBACK_SUFFIXES:
        raise ExtractionError(
            f"anydoc could not read {filename!r} and docling does not handle {suffix}"
        )

    try:
        text, pages = _docling_markdown(body, SUFFIX_BY_HINT[suffix])
    except Exception as exc:  # noqa: BLE001 - docling raises many concrete types
        raise ExtractionError(f"docling failed: {type(exc).__name__}: {exc}") from exc
    return _result(text, pages, "docling")
