# quill-extract — docling text-extraction worker (CONTRACT.md).
# CPU-only torch keeps the image far smaller than the default cu* wheels.
FROM python:3.11-slim

# docling's PDF pipeline imports cv2, which needs these X/GL shared objects
# even in headless use — without them every PDF dies at runtime with
# "ImportError: libxcb.so.1" (2026-08-07).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 libxcb1 libsm6 libxext6 libxrender1 \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -u 10001 -m quill
WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu \
    -r requirements.txt

COPY app ./app

# Docling needs its own artifacts directory (NOT just the HF hub cache): the
# PDF pipeline resolves models by revision from `artifacts_path`, and without
# it every PDF fails at runtime with LocalEntryNotFoundError once offline.
# The assertion is load-bearing — the first build "succeeded" while fetching
# only 272 KB of metadata, and shipped an image that could not read a single
# PDF (2026-08-07).
ENV HF_HOME=/opt/models/hf XDG_CACHE_HOME=/opt/models/cache
ENV DOCLING_ARTIFACTS=/opt/models/docling
RUN python - <<'PY' \
 && chown -R quill:quill /opt/models
from pathlib import Path
from docling.utils.model_downloader import download_models
out = Path("/opt/models/docling")
download_models(output_dir=out, progress=False, with_rapidocr=False)
size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
print(f"docling artifacts: {size/1e6:.1f} MB")
assert size > 150_000_000, f"docling model download looks empty ({size} bytes)"
PY
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
# docling's layout model calls torch.compile, whose inductor backend JITs C++
# and dies with InvalidCxxCompiler on this slim image. Eager mode is correct
# here (CPU inference, no hot loop worth compiling) and avoids shipping a
# ~200 MB toolchain (2026-08-07).
ENV TORCHDYNAMO_DISABLE=1 TORCH_COMPILE_DISABLE=1

# Prove the whole PDF path works offline INSIDE the image. PDFs are the
# highest-value content in the corpus and have now failed to ship twice
# (missing models, then missing cv2 libs); a green build must mean a
# readable PDF.
RUN python - <<'PY'
import io, os
os.environ.setdefault("DOCLING_ARTIFACTS", "/opt/models/docling")
# hand-built minimal PDF with correct xref offsets
objs = [
    b"<</Type/Catalog/Pages 2 0 R>>",
    b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
    b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R"
    b"/Resources<</Font<</F1 5 0 R>>>>>>",
    None,
    b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
]
stream = b"BT /F1 24 Tf 72 700 Td (Quillsmoketest) Tj ET"
objs[3] = b"<</Length " + str(len(stream)).encode() + b">>stream\n" + stream + b"\nendstream"
buf = io.BytesIO(); buf.write(b"%PDF-1.4\n"); offsets = []
for i, body in enumerate(objs, start=1):
    offsets.append(buf.tell())
    buf.write(str(i).encode() + b" 0 obj" + body + b"endobj\n")
xref = buf.tell()
buf.write(b"xref\n0 " + str(len(objs) + 1).encode() + b"\n0000000000 65535 f \n")
for off in offsets:
    buf.write(("%010d 00000 n \n" % off).encode())
buf.write(b"trailer<</Size " + str(len(objs) + 1).encode() + b"/Root 1 0 R>>\nstartxref\n"
          + str(xref).encode() + b"\n%%EOF\n")
pdf = buf.getvalue()

from app.extract import extract_text_from_bytes
res = extract_text_from_bytes(pdf, filename="smoke.pdf", content_type="application/pdf")
print("primary engine:", res.get("engine"), repr(res["text"][:80]))
assert res.get("engine") == "anydoc", f"anydoc must be the primary PDF engine, got {res.get('engine')}"
assert "Quill" in res["text"].replace(" ", ""), f"anydoc produced no text: {res}"

# docling fallback must still work for scanned PDFs anydoc cannot read
os.environ["QUILL_ANYDOC"] = "0"
import importlib, app.extract as ex
importlib.reload(ex)
res2 = ex.extract_text_from_bytes(pdf, filename="smoke.pdf", content_type="application/pdf")
print("fallback engine:", res2.get("engine"), repr(res2["text"][:80]))
assert res2.get("engine") == "docling" and "Quill" in res2["text"].replace(" ", ""), f"docling fallback broken: {res2}"
print("PDF verified offline: anydoc primary + docling fallback")
PY
USER 10001
EXPOSE 9000
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "9000"]
