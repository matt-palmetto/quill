# Immich as a Quill source — verified ground truth (2026-08-07)

Measured directly against the live Immich Postgres (`immich-postgres` in ns `homelab`),
not inferred from docs. This is the basis for the photo-metadata + OCR connector.

**Scope rule: metadata and OCR TEXT only. Image bytes are never read or indexed.**

## Volume

| what | count |
|---|---|
| assets (photos/videos) | 194,704 |
| assets with EXIF | 194,700 |
| **OCR text rows** | **975,701** |
| people (named + unnamed) | 6,824 |
| faces linked to assets | 132,564 |

Immich runs OCR itself and stores the result — ~1M text fragments from receipts,
signs, whiteboards, documents photographed over the years. This is real searchable
content that exists nowhere else in the corpus.

## Tables and columns that matter

```
asset_ocr    id, assetId, text, boxScore, textScore, isVisible,
             x1..y4 (quad bounding box)
asset        id, ownerId, type, originalPath, originalFileName,
             fileCreatedAt, fileModifiedAt, checksum, updatedAt   <- incremental cursor
asset_exif   assetId, dateTimeOriginal, latitude, longitude, city,
             make, model, lensModel, fNumber, focalLength, iso, fileSizeInByte
person       id, name, birthDate, isHidden, ownerId
asset_face   assetId, personId, sourceType, isVisible, bounding box
```

## Why the DB and not the REST API

`asset_ocr` is not exposed as bulk-readable OCR text through the public API, and we need
a full sweep plus an incremental cursor over ~1M rows. `asset.updatedAt` gives a clean
watermark. Reads are **read-only** against a replica-safe query path; Quill never writes
to Immich.

An API key is still required for anything user-facing (deep links back into Immich);
the connector itself needs only DB read access.

## Mapping into the Quill graph

- `person.name` (non-null) → a Person identity, joining the identity spine alongside
  email addresses and git authors. `asset_face` gives Person↔Photo.
- `asset_exif.dateTimeOriginal` + `latitude/longitude/city` → time and Place.
- `asset_ocr.text` → text attached to the Photo, embedded like any other document text
  (subject to the embed policy), carrying `textScore` as extraction confidence.
- Deep link back to the asset in Immich is the citation target.

Confidence is available per OCR row (`textScore`, `boxScore`) and should be carried into
the graph as extraction confidence rather than discarded — low-score OCR is noisy.
