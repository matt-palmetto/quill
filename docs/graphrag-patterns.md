# GraphRAG patterns Quill adopts (and deliberately improves on)

Derived from a code-level study of a reference implementation (patterns only, no code copied).
This file exists so the choices below are arguments, not preferences.

## Adopt

**1. Trace-after-the-fact, never a parallel logging path.**
The retrieval pipeline runs once and returns a result object; the explanation is *reshaped
from that same object* rather than emitted by instrumentation alongside it. The trace
therefore cannot describe something the answer didn't actually use. Every number in it is
measured — stage durations, edge counts, score factors — and nothing is synthesized for
display.

**2. Confidence is a product of measured factors, never a hand-tuned scalar.**
`confidence = content × path_strength × entity_coverage × doc_confidence`. Each factor has a
concrete formula and is rendered in the UI as its own meter that visibly multiplies into the
total. This is what makes "why this result?" answerable instead of hand-waved.

**3. One source-reference grammar, mirrored server and client.**
A small resolvable-path grammar for citations, with exactly one server-side constructor and
one client-side resolver. Any citation type gets its link target from that single function, so
server and client can never drift into broken links.

**4. Deterministic layout, no randomness.**
Same graph in, same picture out — otherwise the view jitters on every re-render. Hierarchical
relations (subclass/part-of) define vertical rank; a barycenter sweep orders each rank.
Edges terminate on computed node-border intersections rather than fixed handles, so they stay
clean regardless of label size.

**5. Predicate families as filter toggles**, with the weak "associated-with" residual family
**off by default**. The single most effective trick for keeping a dense graph legible.

**6. Tri-state store health.** `null` = unavailable (fall back), `[]` = healthy but empty,
rows = data. Collapsing the first two is how "the graph timed out" silently becomes
"the graph found nothing".

**7. Deterministic-first extraction.** Lexical/structural entity anchoring (aliases,
morphology, bounded fuzzy matching) before any LLM call, and each match records *how* it
anchored so the trace can show it.

## Improve on

**1. Bi-temporal provenance — the reference has none.** It carries `origin` and `confidence`
but *no timestamps at all*. For an archive that changes over years, Quill needs valid-time vs
recorded-time and the ability to answer "what did we believe on date D". This is a
requirement, not a nicety.

**2. One citation mechanism, not two.** The reference grew a provider-native citation path
(exact character offsets) *and* a regex `[n]`-marker path, unwired from each other, and says so
in its own docstring. Quill picks one and uses it everywhere.

**3. Real RDF, not a hand-rolled parser.** The reference hand-writes a Turtle subset parser
and a "SHACL-lite" validator to avoid a dependency — which forfeits interop, real SHACL
validation, and any reasoning. Quill uses Oxigraph: actual SPARQL 1.1, actual named graphs,
actual validation.

**4. Draw the T-Box.** The reference renders only A-Box instances joined by T-Box-typed
edges; the schema itself is never drawn, existing only in docs. Quill visualizes **both** —
the ontology (classes/properties) *and* the instances — because the ontology is a deliverable
of this project, not an implementation detail.

**5. Layout that scales past a few hundred nodes.** O(n²) repulsion is fine for ~370 concepts
and will not survive this corpus. Cap fan-out server-side by degree and treat large
neighbourhoods as paged ego-graphs.

**6. If SSE streams, stream.** The reference ships the whole answer as a single delta because
per-chunk redaction can split a secret across boundaries. Either stream with a sliding-window
redactor or don't claim to stream.
