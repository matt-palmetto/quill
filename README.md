# Quill

A GraphRAG system over a personal and small-business file archive — documents, photos,
and (soon) mail — where **every fact carries provenance** and the retrieval path can
explain itself.

This repository is a working reference implementation, not a demo. It is published so the
design decisions are inspectable: an ontology built for a real corpus, a provenance model
that survives contact with changing data, and a hybrid retrieval design that fuses a
knowledge graph with vector search.

## Why this exists

Most GraphRAG examples show the happy path on a tidy corpus. Real archives are not tidy:
380,000 files across cloud drives, laptop backups and a decade-old NAS; 195,000 photos
carrying a million OCR'd text fragments; the same person appearing as an email address, a
git author string, a phone number and a face. Quill is an attempt to build something
genuinely useful on that, and to be honest in public about what the hard parts were.

## Design decisions worth stealing

**Deterministic first, LLM second.** Anything derivable from file metadata, EXIF, headers
or paths is written as an exact triple — cheap, reproducible, and correct. The LLM is used
only where language must actually be understood, and everything it produces becomes a
`Claim` with provenance and a confidence score, never a bare fact.

**Provenance via named graphs, not RDF-star.** RDF 1.2 triple terms are still
Candidate-Recommendation-track, and Oxigraph's own documentation calls its support
experimental with breaking changes expected. Named graphs plus PROV-O have been stable
since SPARQL 1.1 in 2013. Every triple lands in a per-source, per-run named graph, so an
entire source can be filtered, re-synced, or **retracted by dropping graphs**.

**Bi-temporal claims.** Facts carry valid-time (when the fact was true) separately from
recorded-time (when we learned it), and supersession is a chain rather than an overwrite —
so "what did we believe in March?" is answerable, and a correction never destroys history.

**Confidence is a product of measured factors**, not a hand-tuned number, so "why this
result?" has a real answer rather than a black-box score.

**The ontology is tested.** Fifteen competency questions — drawn from things a person
actually asks their own archive — run as executable SPARQL in CI. "Competency questions
informed the design" is marketing; "competency questions pass" is evidence.

## The ontology

`ontology/quill.ttl` — 30 classes, 57 object properties, 79 datatype properties, built
around questions like *"which contracts mention this vendor and when did I sign them"*,
*"what's on the old laptop backup that isn't on my current machine"*, and *"photos of a
person from a particular trip"*.

It reuses PROV-O, schema.org, FOAF, SKOS and Dublin Core rather than reinventing them, and
`ontology/shapes.ttl` enforces the rule that matters most: **no claim without provenance**.

Two constraints shaped it, both worth knowing before you extend it:

- **Oxigraph performs no RDFS/OWL entailment.** `rdfs:subClassOf` is documentation; it
  drives SHACL targets and the visualiser, but it is never query-time inference. Writers
  materialize the full type chain, and traversal uses SPARQL property paths.
- **Multiple `rdfs:domain` triples mean intersection, not union.** This reads like
  widening and silently narrows. Unions use `owl:unionOf`; CI fails the build if a
  property ever carries two domains.

## Architecture

```
  corpus (NFS)  ─┐
  photos/OCR    ─┼─►  pipeline (Node ESM)  ─┬─►  Meilisearch   keyword
  mail (planned)─┘    scan → extract →      ├─►  Qdrant        vectors
                      index → graphify      ├─►  Oxigraph      knowledge graph (SPARQL)
                                            └─►  Postgres      file state, cursors, run log
                                   api (Fastify)  ─►  console (Next.js)
```

Document extraction uses [anydoc](https://github.com/firecrawl/anydoc) (Rust, no ML
models) with [docling](https://github.com/docling-project/docling) as a fallback for
scanned PDFs — a change that moved throughput from 33 to 168 documents/minute while
*lowering* CPU use, because per-page layout inference was buying nothing for a text index.

## Try the ontology without the corpus

The competency-question harness needs only an Oxigraph instance and the fixtures in this
repo — no private data:

```bash
docker run -d -p 7878:7878 ghcr.io/oxigraph/oxigraph:0.5.9 \
  serve --location /data --bind 0.0.0.0:7878 --union-default-graph

node eval/competency/run.mjs --endpoint http://localhost:7878
```

`--union-default-graph` is required: every triple lives in a named graph, so without it a
bare query sees nothing.

## Status

Honest state of things:

| | |
|---|---|
| Corpus scan, extract, index, search | working |
| Ontology, SHACL shapes, competency tests | working (15/15) |
| Oxigraph deployment | working (~31k triples/s over HTTP) |
| Graph writer (corpus → triples) | in progress |
| Photo metadata + OCR connector | in progress |
| Ask pipeline with citations and a step-by-step retrieval trace | designed, not built |
| Ontology/instance visualiser | designed, not built |
| Mail connectors | scoped, not built |

The `k8s/` manifests describe a single-node k3s deployment with placeholder addresses;
they are a reference, not a turnkey install.

## License

MIT — see [LICENSE](LICENSE).
