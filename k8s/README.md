# Quill Phase 1 Kubernetes manifests

Kustomize (no Helm), namespace `quill`, target: single-node k3s v1.36.2
(node "cluster-node"), storage classes `local-path` and `nvme-tier0`. The fixed
service interface is `../CONTRACT.md` — read that first if anything here
looks surprising.

## Components

| Dir | Kind(s) | What |
|---|---|---|
| `falkordb/` | StatefulSet + Service | FalkorDB v4.18.7, graph `quill` reserved but unused until Phase 2. |
| `qdrant/` | StatefulSet + Service | Qdrant v1.18.2-unprivileged, collection `quill_chunks`. |
| `meili/` | Deployment + Service + PVC | Meilisearch v1.16.0, index `quill_files`. |
| `postgres/` | CNPG `Cluster` | `quill-pg`, 1 instance, db/owner `quill`. Requires the CNPG operator (`cnpg-system`, cluster-wide, already installed). |
| `embed/` | PVC + Job + Deployment + Service | Infinity CPU serving both `bge-m3` and `bge-reranker-v2-m3` under `/v1`; model-prefetch Job stages both models to a shared PVC before the Deployment's `verify-immutable-model` initContainer will let it start. |
| `pipeline/` | CronJob + PVC | `quill-ingest`, every 30 min UTC, reads the four NFS corpus mounts read-only, writes to Postgres/Qdrant/Meili via `quill-extract` and `quill-embed`. |
| `extract/` | Deployment + Service | docling extraction worker, reachable only from the pipeline. |
| `api/` | Deployment + Service | Fastify search API (`/search`, `/ops`, `/healthz`, `/readyz`). |
| `console/` | Deployment + Service | Next.js standalone console. |
| `cloudflared/` | Deployment (2 replicas) | Tunnel connector for `quill.example.com`, forked from the azalea pattern. |
| `networkpolicies.yaml` | 13x NetworkPolicy | Default-deny + per-workload allows. See the CNPG exception note inside the file before editing. |

## Secrets (all out-of-band — none of these are committed here)

`quill-falkordb-auth`, `quill-qdrant-auth`, `quill-meili-auth`,
`quill-console-auth` (optional), `quill-cloudflared` — materialized by
`make secrets` (`scripts/bootstrap-secrets.sh` / `materialize-secrets.sh`).
`quill-pg-app` is **not** in this list — CNPG auto-generates it from the
Cluster CR. See the header comment in `kustomization.yaml` for exact keys.

## Apply order

1. **CNPG operator must already be running** (`cnpg-system`, cluster-wide).
   This repo does not install it.
2. Materialize the five out-of-band secrets (`make secrets`) before
   applying anything that references them — StatefulSets/Deployments will
   sit in `CreateContainerConfigError` until the Secret exists, which is
   the correct fail-closed behavior, not a bug.
3. Apply the namespace and `postgres/cluster.yaml` (CNPG Cluster) and
   `embed/deployment.yaml` (model-prefetch Job) early — both take
   noticeably longer to become ready than everything else (CNPG bootstrap;
   ~2 model downloads from Hugging Face over the model-prefetch Job's
   scoped public-HTTPS NetworkPolicy exception). `kubectl apply -k k8s/`
   applies everything in one pass and kubelet/controller reconciliation
   will simply retry the dependents (pipeline's `wait-datapath`
   initContainer, embed's `verify-immutable-model` initContainer) until
   their dependencies are ready — there is no strict ordering requirement
   for a single `apply -k`, but if applying pieces individually, do these
   two first.
4. Everything else has no ordering constraint beyond secrets existing.

## Known gaps / deviations from the original task spec

See the inline comments at each site for full reasoning; summary:

- **`embed/` image digest** — `docker.io/michaelf34/infinity@sha256:94db836145f6...`
  is the digest actually pinned in `m7-sales/k8s/brain/bge-m3.yaml` (verified
  by reading that file), not the digest given in the original task text
  (which doesn't match anything in the reference manifest). Used the
  cluster-proven one.
- **`meili/` image** — pinned to the v1.16.0 multi-arch manifest-list
  digest resolved from Docker Hub 2026-08-06 (no local example to fork from
  for this image). Re-verify at release time; TODO comment left in the file.
- **`postgres/cluster.yaml` image** — reused the exact digest from the
  navi-stg recovery Cluster (`m7-cluster-node/prod-migration/.../navi-stg/database/cluster.yaml`),
  the only CNPG postgres image independently confirmed against this node's
  architecture. Quill doesn't need the pgvector variant that image ships,
  but it's a strict superset of plain `postgresql:17`.
- **`networkpolicies.yaml` CNPG exception** — `quill-pg` pods are exempted
  from the namespace's default-deny *egress* policy (ingress to 5432 is
  still locked to pipeline+api). CNPG's instance manager needs ongoing
  Kubernetes API server access and k3s has no stable in-namespace selector
  target for the API server; guessing an unverified service-CIDR ipBlock
  risked a silent no-op. Flagged in the file for the integrator to tighten
  once the cluster's API server address is confirmed.
- **`bge-reranker-v2-m3` revision** — pinned to the model's `main`-branch
  HEAD commit sha resolved via the Hugging Face API 2026-08-06 (no dated
  release tag exists for this model, unlike `bge-m3`).

## Validation performed

- `kubectl kustomize k8s/` and `kustomize build k8s/` both render cleanly
  (35 resources, 0 errors).
- `kubeconform -strict -kubernetes-version 1.36.0` against the rendered
  output: 34/34 non-CRD resources valid (the CNPG `Cluster` CR has no local
  schema for kubeconform to check and was skipped).
- Not run: `kubectl apply` (integrator deploys per repo convention) and
  live cluster admission (CNPG CRD validation, actual NetworkPolicy CNI
  enforcement behavior).
