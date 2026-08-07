/**
 * The 15 competency questions from docs/design/ontology-design.md §1, as
 * executable SPARQL against ontology/instances/demo.trig.
 *
 * `expect: 'blocked'` records a question the ontology genuinely cannot answer
 * yet, with the reason and the phase that unblocks it. The harness fails if a
 * blocked question starts returning rows (reclassify it) — so the docs cannot
 * quietly drift out of step with the schema.
 */

const PREFIX = `
PREFIX quill:   <https://quill.example.com/ontology#>
PREFIX qid:     <https://quill.example.com/id/>
PREFIX prov:    <http://www.w3.org/ns/prov#>
PREFIX schema:  <https://schema.org/>
PREFIX foaf:    <http://xmlns.com/foaf/0.1/>
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX skos:    <http://www.w3.org/2004/02/skos/core#>
PREFIX rdfs:    <http://www.w3.org/2000/01/rdf-schema#>
PREFIX xsd:     <http://www.w3.org/2001/XMLSchema#>
`;

export const QUESTIONS = [
  {
    id: 1,
    question: 'Which contracts mention this vendor, and when did I sign them?',
    expect: 'rows',
    // Claim-mediated: the vendor link is language-derived, so it must carry provenance.
    sparql: `${PREFIX}
      SELECT ?doc ?org ?when WHERE {
        ?claim a quill:Claim ; quill:claimSubject ?doc ; quill:claimObject ?org .
        ?org a quill:Organization .
        OPTIONAL { ?claim prov:generatedAtTime ?when }
      } LIMIT 20`,
  },
  {
    id: 2,
    question: 'What did I work on the week of a given date?',
    expect: 'rows',
    sparql: `${PREFIX}
      SELECT ?f ?mtime WHERE {
        ?f a quill:File ; quill:mtime ?mtime .
        FILTER(?mtime >= "2020-01-01T00:00:00Z"^^xsd:dateTime)
      } LIMIT 20`,
  },
  {
    id: 3,
    question: 'Who sent me the mortgage documents, and where is the source file?',
    expect: 'rows',
    // schema:sender already models this; the demo carries one Communication.
    sparql: `${PREFIX}
      SELECT ?comm ?sender WHERE {
        ?comm schema:sender ?sender .
      } LIMIT 20`,
  },
  {
    id: 4,
    question: 'Photos of a given person from a given place.',
    expect: 'rows',
    sparql: `${PREFIX}
      SELECT ?photo ?person ?place WHERE {
        ?face quill:detectedIn ?photo .
        OPTIONAL { ?face quill:depictsPerson ?person }
        OPTIONAL { ?photo quill:place ?place }
      } LIMIT 20`,
  },
  {
    id: 5,
    question: 'What have I paid an organization, and which documents back that up?',
    expect: 'rows',
    // The provenance chain is the point: claim -> chunk -> file.
    sparql: `${PREFIX}
      SELECT ?claim ?org ?evidence WHERE {
        ?claim quill:claimPredicate quill:paidTo ; quill:claimObject ?org .
        OPTIONAL { ?claim prov:wasDerivedFrom ?evidence }
      } LIMIT 20`,
  },
  {
    id: 6,
    question: 'Which insurance policies expire in the next 90 days?',
    expect: 'blocked',
    blockedReason: 'no Policy instances in the demo A-Box (schema exists; needs fixture data)',
    sparql: `${PREFIX}
      SELECT ?p ?expires WHERE { ?p a quill:Policy ; quill:expirationDate ?expires } LIMIT 20`,
  },
  {
    id: 7,
    question: 'Find the photo whose OCR text contains a given phrase.',
    expect: 'rows',
    sparql: `${PREFIX}
      SELECT ?photo ?text WHERE {
        ?region a quill:OcrRegion ; quill:detectedIn ?photo ; quill:ocrText ?text .
        FILTER(CONTAINS(LCASE(?text), "roadmap"))
      } LIMIT 20`,
  },
  {
    id: 8,
    question: 'What is on one machine/root that is not on another?',
    expect: 'rows',
    // Relies on two Files legitimately sharing a contentHash — which is exactly
    // why contentHash must NEVER be declared inverse-functional.
    sparql: `${PREFIX}
      SELECT ?file ?root ?origin WHERE {
        ?file a quill:File .
        OPTIONAL { ?file quill:root ?root }
        OPTIONAL { ?file quill:origin ?origin }
      } LIMIT 20`,
  },
  {
    id: 9,
    question: 'Who have I emailed at a given organization?',
    expect: 'rows',
    sparql: `${PREFIX}
      SELECT ?comm ?person ?org WHERE {
        ?comm schema:sender ?person .
        OPTIONAL { ?person schema:worksFor ?org }
      } LIMIT 20`,
  },
  {
    id: 10,
    question: 'What tax documents exist for a given year?',
    expect: 'blocked',
    blockedReason: 'no TaxDocument instances in the demo A-Box (schema exists; needs fixture data)',
    sparql: `${PREFIX}
      SELECT ?d WHERE { ?d a quill:TaxDocument } LIMIT 20`,
  },
  {
    id: 11,
    question: 'Which statements cover a period defined by a bi-temporal claim?',
    expect: 'rows',
    // Exercises validFrom/validTo — the bi-temporal machinery.
    sparql: `${PREFIX}
      SELECT ?claim ?from ?to WHERE {
        ?claim a quill:Claim .
        OPTIONAL { ?claim quill:validFrom ?from }
        OPTIONAL { ?claim quill:validTo ?to }
      } LIMIT 20`,
  },
  {
    id: 12,
    question: 'What projects was I working on when I took this photo?',
    expect: 'rows',
    // Was blocked until 2026-08-07: no property touched both Photo and
    // {Event, Project}. Now a real traversal via quill:duringEvent, whose edge
    // is materialized at ingest from the time overlap — deliberately NOT a
    // cross-type FILTER between xsd:dateTime and xsd:date, which is not a
    // traversal and does not coerce natively.
    sparql: `${PREFIX}
      SELECT ?photo ?project ?start ?end WHERE {
        ?photo quill:duringEvent/quill:relatesToProject ?project .
        ?project quill:projectStartDate ?start ; quill:projectEndDate ?end .
      } LIMIT 20`,
  },
  {
    id: 13,
    question: 'How has a fact changed over time (supersession chain)?',
    expect: 'rows',
    // '*' path: transitivity is declared for documentation, but the PATH does the work.
    sparql: `${PREFIX}
      SELECT ?claim ?latest WHERE {
        ?claim a quill:Claim .
        OPTIONAL { ?claim quill:supersededBy* ?latest }
      } LIMIT 20`,
  },
  {
    id: 14,
    question: 'Which files came from which corpus root / origin?',
    expect: 'rows',
    sparql: `${PREFIX}
      SELECT ?origin (COUNT(?f) AS ?n) WHERE {
        ?f a quill:File ; quill:origin ?origin .
      } GROUP BY ?origin LIMIT 20`,
  },
  {
    id: 15,
    question: 'Is an alias in an old file the same person as a known person?',
    expect: 'rows',
    sparql: `${PREFIX}
      SELECT ?identity ?person ?conf WHERE {
        ?identity a quill:Identity .
        OPTIONAL { ?identity quill:identityOf ?person }
        OPTIONAL { ?identity quill:identityConfidence ?conf }
      } LIMIT 20`,
  },
];
