#!/usr/bin/env node
/**
 * Competency-question test harness.
 *
 * "15 competency questions were used to design this" is marketing.
 * "15 competency questions pass" is evidence. This turns the ontology's stated
 * design rationale into an executable gate, so a regression like an orphaned
 * class or a dropped property is caught here rather than by a reviewer.
 *
 * Each question is either:
 *   expect: 'rows'    — must return at least one row against the demo A-Box
 *   expect: 'blocked' — documented as NOT answerable yet, with the reason. The
 *                       harness FAILS if a blocked question starts returning
 *                       rows without being reclassified, so nobody quietly
 *                       fixes something and leaves the docs stale — and fails
 *                       if it is still blocked past its stated phase.
 *
 * Usage:  node eval/competency/run.mjs [--endpoint http://quill-oxigraph:7878]
 * Loads ontology/*.ttl + ontology/instances/demo.trig into a scratch graph,
 * runs every question, prints a table, exits non-zero on any failure.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { QUESTIONS } from './questions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const ENDPOINT = process.argv.includes('--endpoint')
  ? process.argv[process.argv.indexOf('--endpoint') + 1]
  : process.env.QUILL_SPARQL_URL ?? 'http://quill-oxigraph:7878';
const SCRATCH = 'https://quill.example.com/id/g-competency-test';

async function load(file, contentType, graph) {
  const body = await readFile(join(REPO, file), 'utf8');
  const url = graph
    ? `${ENDPOINT}/store?graph=${encodeURIComponent(graph)}`
    : `${ENDPOINT}/store`;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': contentType }, body });
  if (!res.ok) throw new Error(`load ${file}: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

async function select(query) {
  const res = await fetch(`${ENDPOINT}/query?query=${encodeURIComponent(query)}`, {
    headers: { accept: 'application/sparql-results+json' },
  });
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 160)}` };
  const json = await res.json();
  return { rows: json.results?.bindings ?? [] };
}

async function dropScratch() {
  await fetch(`${ENDPOINT}/update`, {
    method: 'POST',
    headers: { 'content-type': 'application/sparql-update' },
    body: `DROP SILENT GRAPH <${SCRATCH}>`,
  });
}

const main = async () => {
  await dropScratch();
  await load('ontology/quill.ttl', 'text/turtle', SCRATCH);
  await load('ontology/shapes.ttl', 'text/turtle', SCRATCH);
  // demo.trig carries its own named graphs — load without overriding them so
  // the provenance partitioning the questions rely on stays intact.
  await load('ontology/instances/demo.trig', 'application/trig', null);

  // Structural guard, checked before the questions: multiple rdfs:domain (or
  // rdfs:range) triples on one property mean INTERSECTION under RDFS, not union.
  // It reads like widening and silently narrows. Unions must use owl:unionOf.
  const structural = [];
  for (const [kind, pred] of [['domain', 'domain'], ['range', 'range']]) {
    // Scope to the scratch graph: the server runs with --union-default-graph, so
    // an unscoped query would also see any other graph in the store and report
    // phantom defects from unrelated data.
    const { rows } = await select(`SELECT ?p (COUNT(DISTINCT ?v) AS ?n) WHERE {
        GRAPH <${SCRATCH}> { ?p <http://www.w3.org/2000/01/rdf-schema#${pred}> ?v } }
        GROUP BY ?p HAVING(COUNT(DISTINCT ?v) > 1)`);
    for (const r of rows ?? []) {
      structural.push(`${r.p.value.replace(/^.*[#/]/, '')} has ${r.n.value} rdfs:${kind} triples ` +
        `— RDFS reads that as intersection; use owl:unionOf`);
    }
  }
  if (structural.length) {
    console.log('STRUCTURAL DEFECTS:');
    for (const d of structural) console.log(`  FAIL  ${d}`);
    console.log('');
  }

  let pass = 0;
  const failures = [];
  console.log(`\ncompetency questions — ${ENDPOINT}\n`);

  for (const q of QUESTIONS) {
    const { rows, error } = await select(q.sparql);
    let ok, note;
    if (error) {
      ok = false;
      note = `SPARQL error: ${error}`;
    } else if (q.expect === 'rows') {
      ok = rows.length > 0;
      note = ok ? `${rows.length} row(s)` : 'NO ROWS — the ontology cannot answer this';
    } else {
      // A blocked question must stay empty AND still be genuinely blocked.
      ok = rows.length === 0;
      note = ok ? `blocked as documented: ${q.blockedReason}` : `NOW RETURNS ${rows.length} ROW(S) — reclassify to expect:'rows'`;
    }
    if (ok) pass += 1;
    else failures.push({ id: q.id, question: q.question, note });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  CQ${String(q.id).padStart(2)}  ${q.question.slice(0, 62).padEnd(62)} ${note}`);
  }

  console.log(`\n${pass}/${QUESTIONS.length} passed`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  CQ${f.id}: ${f.question}\n        ${f.note}`);
  }
  await dropScratch();
  process.exit(failures.length || structural.length ? 1 : 0);
};

main().catch((err) => {
  console.error('harness error:', err.message);
  process.exit(2);
});
