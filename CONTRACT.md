# Quill service contract (Phase 1)

The fixed interface between k8s manifests, pipeline, api, and console. Change this file
first; code follows it. Namespace: `quill`. Registry: `REGISTRY_HOST:5000/quill/*`.

## Services (cluster DNS, in-namespace)

| Service | Port | What |
|---|---|---|
| `quill-falkordb` | 6379 | FalkorDB v4.18.7, auth via `requirepass` (secret `quill-falkordb-auth`, key `redis.conf`) — graph name `quill` (unused until Phase 2) |
| `quill-qdrant` | 6333 (http) / 6334 (grpc) | Qdrant v1.18.2, `QDRANT__SERVICE__API_KEY` from secret `quill-qdrant-auth` key `QDRANT_API_KEY` |
| `quill-meili` | 7700 | Meilisearch v1.16, master key from secret `quill-meili-auth` key `MEILI_MASTER_KEY` |
| `quill-pg-rw` | 5432 | CNPG cluster `quill-pg` (1 instance, 50Gi local-path, db `quill`); app creds in CNPG-generated secret `quill-pg-app` |
| `quill-embed` | 7997 | Infinity 0.0.77 CPU serving BOTH `bge-m3` (embed, 1024-d) and `bge-reranker-v2-m3` (rerank), OpenAI-style under `/v1`, models pre-fetched to PVC `quill-embed-model-cache`, offline serve |
| `quill-extract` | 9000 | docling worker: `POST /extract` (raw bytes, headers `x-filename`, `content-type`) → `{"text": str, "pages": int|null, "truncated": bool}`; `GET /healthz` |
| `quill-api` | 8080 | Fastify: `GET /search`, `GET /ops`, `GET /healthz`, `GET /readyz` |
| `quill-console` | 8080 (svc 80) | Next.js standalone |

## Env var names (set by manifests, consumed by services)

`QUILL_PG_URL` (from `quill-pg-app` uri) · `QUILL_QDRANT_URL` · `QUILL_QDRANT_API_KEY` ·
`QUILL_MEILI_URL` · `QUILL_MEILI_KEY` · `QUILL_EMBED_URL` (=`http://quill-embed:7997/v1`) ·
`QUILL_EXTRACT_URL` · `QUILL_API_URL` (console) · `QUILL_SOURCES_PATH` (default
`/app/sources.json`) · `QUILL_STATE_DIR` (=`/data`, state PVC) ·
`QUILL_INGEST_BUDGET_SECONDS` (default 1500)

## Corpus mounts (pipeline CronJob pod, all NFS from NAS_IP, all `readOnly: true`)

| Mount | Export |
|---|---|
| `/corpus/cloud-drives` | `/mnt/storage/cloud-drives` |
| `/corpus/archives` | `/mnt/storage/archives` |
| `/corpus/mac-sync` | `/mnt/storage/mac-sync` |
| `/corpus/git-mirrors` | `/mnt/storage/system/git-mirrors` |

## Sources config (`services/pipeline/sources.json`)

Scanner reads ONLY roots listed here; `exclude` is enforced before any read (never
read-then-filter). Every emitted record carries `source`, `root`, and `origin`.
Origin for cloud-drives = first path segment (`matt`, `example-org`,
`meridian7`, `example-fitness`, `archives`). `cloud-drives/sarah` is excluded
(DECISIONS 2026-08-06). Skip extensions: media/binary (`jpg png gif heic mp4 mov mp3
wav zip dmg iso pkg app exe dll so dylib sqlite db photoslibrary` …full list in code);
size cap 50 MB per file for extraction.

## Postgres schema (owned by pipeline, migrated idempotently at job start)

```sql
file_state(path text primary key, root text, origin text, size bigint, mtime timestamptz,
           content_hash text, status text,           -- pending|extracted|indexed|skipped|error
           error text, first_seen timestamptz, last_seen timestamptz, indexed_at timestamptz)
sync_state(key text primary key, value jsonb, updated_at timestamptz)
ingest_log(id bigserial, run_id text, stage text, path text, detail jsonb, at timestamptz)
```

`content_hash` (sha256 of raw bytes) is the dedup authority; watermarks are convenience.

## Meilisearch

Index `quill_files`, primary key `id` = sha256(path). Document:
`{id, path, root, origin, source:"files", title, ext, mtime_unix, size, text}`
(`text` capped at 100 KB). Filterable: `origin, root, ext, source`; sortable: `mtime_unix`.

## Qdrant

Collection `quill_chunks`, 1024-d cosine, on-disk payload. Point id = uuid5(path + chunk_index + content_hash).
Payload: `{path, root, origin, source:"files", chunk_index, text, content_hash,
model:"bge-m3", model_revision, mtime_unix}`.
Chunking: 500-token window, 0.15 overlap, markdown-header-aware (fork of
m7-sales `lib/brain-chunk.mjs` contract).

## quill-api

- `GET /search?q=…&limit=20&origin=…&root=…` → `{hits:[{id, kind:"file", path, origin,
  root, title, snippet, score, mtime_unix, match:"keyword"|"semantic"|"both"}], took_ms}`.
  Meili + (embed→Qdrant) in parallel, merged on normalized score, keyword rank boosted
  for exact matches. Target < 150 ms on LAN (semantic leg may be skipped under a
  `fast=1` flag if embed latency blows the budget — palette sends `fast=1`, full search
  doesn't).
- `GET /ops` → per-source `{last_run, files_seen, files_indexed, pending, errors}` from
  Postgres.

## Provenance rule (non-negotiable, DECISIONS 2026-08-06)

Every Meili doc, Qdrant payload, Postgres row, and (later) graph claim carries
`source` + `origin` + enough to deep-link (`path` for files). Set at pull time only.
