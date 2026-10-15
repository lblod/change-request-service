import { sparqlEscapeString, sparqlEscapeUri } from 'mu';
import { PREFIXES, TARGET_TYPE } from '../constants.js';
import { rows, selectInBatches } from './sparql-result.js';

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
 * "<subject> <predicate>" to the SPARQL JSON bindings of the objects (an empty list when there are
 * none), so values can be compared under their datatype and written again as they are. Used for
 * the base rule and the unchanged check (settleVersions), for the live conflicts and for the plan
 * of an apply; a pair (subject, rdf:type) tells whether a master still exists. Queried in batches
 * of pairs, so no result reaches the row limit of the triplestore.
 */
export async function currentTerms(db, pairs) {
  const objects = new Map();
  const key = (subject, predicate) => `${subject} ${predicate}`;
  for (const { subject, predicate } of pairs) objects.set(key(subject, predicate), []);
  const unique = [...new Set(pairs.map(({ subject, predicate }) => `(${sparqlEscapeUri(subject)} ${sparqlEscapeUri(predicate)})`))];
  const result = await selectInBatches(db, unique, (batch) => `${PREFIXES}

SELECT ?s ?p ?o
WHERE {
  VALUES (?s ?p) { ${batch.join(' ')} }
  ?s ?p ?o .
}`);
  for (const binding of result.results.bindings) {
    objects.get(key(binding.s.value, binding.p.value))?.push(binding.o);
  }
  return objects;
}

/**
 * The records that link to the given objects now: a Map from "<object> <predicate>" to the SPARQL
 * JSON bindings of the subjects of (subject, predicate, object), an empty list when there are
 * none. pairs are { object, predicate } (incomingPairs in versions.js). The versions and record
 * states of change requests are left out: they hold the same predicates in the change-requests
 * graph, which the service's scope reads too (sparql-parser does not narrow a SELECT to the graph
 * a GRAPH clause names). A link a record state remembers is an rdf:Statement, which does not
 * hold the predicate itself.
 */
export async function incomingTerms(db, pairs) {
  const subjects = new Map();
  const key = (object, predicate) => `${object} ${predicate}`;
  for (const { object, predicate } of pairs) subjects.set(key(object, predicate), []);
  const unique = [...new Set(pairs.map(({ object, predicate }) => `(${sparqlEscapeUri(object)} ${sparqlEscapeUri(predicate)})`))];
  const result = await selectInBatches(db, unique, (batch) => `${PREFIXES}

SELECT DISTINCT ?o ?p ?s
WHERE {
  VALUES (?o ?p) { ${batch.join(' ')} }
  ?s ?p ?o .
  FILTER NOT EXISTS { ?s a cr:ProposedVersion . }
  FILTER NOT EXISTS { ?s a cr:RecordState . }
}`);
  for (const binding of result.results.bindings) {
    subjects.get(key(binding.o.value, binding.p.value))?.push(binding.s);
  }
  return subjects;
}

/** The mu:uuid and the RDF classes of records: Map uri -> { uuid, classes }. */
export async function describeRecords(db, uris) {
  const records = new Map();
  const result = await selectInBatches(db, [...new Set(uris)], (batch) => `${PREFIXES}

SELECT DISTINCT ?uri ?uuid ?type
WHERE {
  VALUES ?uri { ${batch.map(sparqlEscapeUri).join(' ')} }
  ?uri mu:uuid ?uuid .
  OPTIONAL { ?uri a ?type . }
}`);
  for (const row of rows(result)) {
    const record = records.get(row.uri) || { uuid: row.uuid, classes: [] };
    if (row.type && !record.classes.includes(row.type)) record.classes.push(row.type);
    records.set(row.uri, record);
  }
  return records;
}

/**
 * The mu:uuid of each URI, for the identifiers in the conflicts of the API: Map uri -> uuid. A
 * record that no longer exists, or that a pending request creates, is found through its versions
 * (cr:masterUuid).
 */
export async function uuidsOf(db, uris) {
  const uuids = new Map();
  const result = await selectInBatches(db, [...new Set(uris)], (batch) => `${PREFIXES}

SELECT DISTINCT ?uri ?uuid
WHERE {
  VALUES ?uri { ${batch.map(sparqlEscapeUri).join(' ')} }
  { ?uri mu:uuid ?uuid . }
  UNION
  { ?version a cr:ProposedVersion ; dct:isVersionOf ?uri ; cr:masterUuid ?uuid . }
}`);
  for (const row of rows(result)) if (!uuids.has(row.uri)) uuids.set(row.uri, row.uuid);
  return uuids;
}

/**
 * The URIs of ids that are not (or no longer) in the application data but are known from the
 * versions of change requests, a record deleted through one for instance: Map uuid -> uri. A base
 * value may refer to such a record, since the client loaded it before it went.
 */
export async function formerResources(db, ids) {
  const former = new Map();
  if (!ids.length) return former;
  const result = await db.query(`${PREFIXES}

SELECT DISTINCT ?uuid ?uri
WHERE {
  VALUES ?uuid { ${ids.map(sparqlEscapeString).join(' ')} }
  ?version a cr:ProposedVersion ; cr:masterUuid ?uuid ; dct:isVersionOf ?uri .
}`);
  for (const row of rows(result)) if (!former.has(row.uuid)) former.set(row.uuid, row.uri);
  return former;
}
