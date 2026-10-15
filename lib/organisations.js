import { sparqlEscapeString, sparqlEscapeUri } from 'mu';
import { PREFIXES, TARGET_TYPE } from '../constants.js';
import { rows } from './sparql-result.js';

/**
 * Finds the organisation behind a uuid: its URI, its RDF classes (which must include a class
 * of the organizations type or one of its subtypes) and its classification for the policies.
 */
export async function findOrganisation(db, uuid, model) {
  if (typeof uuid !== 'string' || !uuid) return null;
  const result = await db.query(`${PREFIXES}

SELECT ?uri ?type ?classification
WHERE {
  ?uri mu:uuid ${sparqlEscapeString(uuid)} ;
    a ?type .
  OPTIONAL { ?uri org:classification ?classification . }
}`);
  const found = rows(result);
  if (!found.length) return null;
  const classes = [...new Set(found.map((row) => row.type))];
  const organisationClasses = model.classesOf(TARGET_TYPE);
  if (!classes.some((rdfClass) => organisationClasses.includes(rdfClass))) return null;
  return {
    uri: found[0].uri,
    uuid,
    classification: found.find((row) => row.classification)?.classification || null,
    classes,
  };
}

/** Resolves uuids to URIs and classes in one query: Map uuid -> { uri, classes }. */
export async function resolveResources(db, ids) {
  const resources = new Map();
  if (!ids.length) return resources;
  const result = await db.query(`${PREFIXES}

SELECT ?uuid ?uri ?type
WHERE {
  VALUES ?uuid { ${ids.map(sparqlEscapeString).join(' ')} }
  ?uri mu:uuid ?uuid ;
    a ?type .
}`);
  for (const row of rows(result)) {
    const entry = resources.get(row.uuid) || { uri: row.uri, classes: [] };
    entry.classes.push(row.type);
    resources.set(row.uuid, entry);
  }
  return resources;
}

/**
 * The records of the target's aggregate: everything reachable from the target organisation over
 * the given predicates (pathPredicates of the aggregate), the target itself included. One query
 * with a property path; sparql-parser 0.0.15 passes it through to Virtuoso.
 */
export async function reachableFromTarget(db, targetUri, predicates) {
  const reachable = new Set([targetUri]);
  if (!predicates.length) return reachable;
  const result = await db.query(`${PREFIXES}

SELECT DISTINCT ?resource
WHERE {
  ${sparqlEscapeUri(targetUri)} (${predicates.map(sparqlEscapeUri).join('|')})+ ?resource .
}`);
  for (const row of rows(result)) reachable.add(row.resource);
  return reachable;
}

/**
 * The current objects of the given (subject, predicate) pairs on the masters, as a Map from
 * "<subject> <predicate>" to the set of object values. Used to check that a relationship a
 * document carries without the aggregate admitting it is unchanged.
 */
export async function currentObjects(db, pairs) {
  const objects = new Map();
  const key = (subject, predicate) => `${subject} ${predicate}`;
  for (const { subject, predicate } of pairs) objects.set(key(subject, predicate), new Set());
  if (!pairs.length) return objects;
  const result = await db.query(`${PREFIXES}

SELECT ?s ?p ?o
WHERE {
  VALUES (?s ?p) { ${pairs.map(({ subject, predicate }) => `(${sparqlEscapeUri(subject)} ${sparqlEscapeUri(predicate)})`).join(' ')} }
  ?s ?p ?o .
}`);
  for (const row of rows(result)) objects.get(key(row.s, row.p))?.add(row.o);
  return objects;
}
