import { sparqlEscapeUri, sparqlEscapeString, sparqlEscapeDateTime, sparqlEscapeBool } from 'mu';
import { PREFIXES, STATUS } from '../constants.js';

const iri = sparqlEscapeUri;

/**
 * Writes the request record and its version objects, status ingediend, into the change-requests graph.
 *
 * request: { uri, uuid, created, aggregate, targetUri, actorUri, accountUri }
 *
 * A version records everything the apply needs, so it can be applied again from the graph alone:
 * the master (dct:isVersionOf, cr:masterUuid), its JSON:API type (cr:resourceType), the operation
 * (cr:operation, plus cr:deleted on a tombstone), the predicates it replaces on the master
 * (cr:replaces) and the master's triples with the version as subject.
 */
export function requestInsertQuery({ request, versions, graph }) {
  const generated = versions.length ? ` ;\n      prov:generated ${versions.map((version) => iri(version.uri)).join(', ')}` : '';
  const versionBlocks = versions.map((version) => {
    const lines = [
      `${iri(version.uri)} a cr:Version`,
      `mu:uuid ${sparqlEscapeString(version.uuid)}`,
      `dct:isVersionOf ${iri(version.masterUri)}`,
      `cr:masterUuid ${sparqlEscapeString(version.masterUuid)}`,
      `prov:generatedAtTime ${sparqlEscapeDateTime(request.created)}`,
      `prov:wasGeneratedBy ${iri(request.uri)}`,
      `cr:resourceType ${sparqlEscapeString(version.type)}`,
      `cr:operation ${sparqlEscapeString(version.operation)}`,
    ];
    if (version.deleted) lines.push(`cr:deleted ${sparqlEscapeBool(true)}`);
    if (version.replaces.length) lines.push(`cr:replaces ${version.replaces.map(iri).join(', ')}`);
    for (const triple of version.triples) lines.push(`${iri(triple.predicate)} ${triple.object}`);
    return `${lines.join(' ;\n      ')} .`;
  });
  return `${PREFIXES}

INSERT DATA {
  GRAPH ${iri(graph)} {
    ${iri(request.uri)} a cr:ChangeRequest ;
      mu:uuid ${sparqlEscapeString(request.uuid)} ;
      dct:created ${sparqlEscapeDateTime(request.created)} ;
      adms:status ${iri(STATUS.ingediend)} ;
      cr:aggregate ${sparqlEscapeString(request.aggregate)} ;
      cr:target ${iri(request.targetUri)} ;
      cr:requestingOrganisation ${iri(request.actorUri)} ;
      prov:wasAttributedTo ${iri(request.accountUri)}${generated} .
    ${versionBlocks.join('\n    ')}
  }
}`;
}

/**
 * The update that applies a request. For every version it removes, on the master, the triples of
 * the predicates the version replaces and inserts the version's triples with the master as
 * subject; a create also inserts the class tree and the uuid of the new master; a tombstone
 * removes the master's outgoing triples and the incoming relationship triples (the predicates
 * the model knows to point at that type). The same update stamps dct:modified and
 * ext:lastModifiedBy on the target organisation and moves the request to goedgekeurd with
 * cr:appliedAt, dropping the cr:error of an earlier failed attempt.
 *
 * The update is idempotent: delete by predicate, then insert the full carried state. It can be
 * run again after a failure, which matters because sparql-parser sends the effective quads to
 * the triplestore in several requests (deletes first) rather than in one transaction.
 *
 * The WHERE is a UNION of independent groups, one per thing to delete, so there is no cross
 * product between them; the first group (the request's current status) always matches, so the
 * INSERT happens even when nothing has to be deleted.
 */
export function applyQuery({ request, versions, model, appliedAt, graphs }) {
  const application = iri(graphs.application);
  const changeRequests = iri(graphs.changeRequests);
  const inserts = [];
  const deletes = [];
  const deleteGroup = (lines) => deletes.push(`{\n    ${lines.join('\n    ')}\n    GRAPH ${application} { ?s ?p ?o . }\n  }`);

  for (const version of versions) {
    if (version.deleted) {
      deleteGroup([`VALUES ?s { ${iri(version.masterUri)} }`]);
      const incoming = model.incomingPredicates(version.type);
      if (incoming.length) {
        deleteGroup([`VALUES ?o { ${iri(version.masterUri)} }`, `VALUES ?p { ${incoming.map(iri).join(' ')} }`]);
      }
      continue;
    }
    const lines = [];
    if (version.operation === 'create') {
      lines.push(`a ${version.classUris.map(iri).join(', ')}`, `mu:uuid ${sparqlEscapeString(version.masterUuid)}`);
    }
    if (version.replaces.length) {
      deleteGroup([`VALUES ?s { ${iri(version.masterUri)} }`, `VALUES ?p { ${version.replaces.map(iri).join(' ')} }`]);
    }
    for (const triple of version.triples) lines.push(`${iri(triple.predicate)} ${triple.object}`);
    if (lines.length) inserts.push(`${iri(version.masterUri)} ${lines.join(' ;\n      ')} .`);
  }

  deleteGroup([`VALUES ?s { ${iri(request.targetUri)} }`, 'VALUES ?p { dct:modified ext:lastModifiedBy }']);
  inserts.push(
    `${iri(request.targetUri)} dct:modified ${sparqlEscapeDateTime(appliedAt)} ;\n      ext:lastModifiedBy ${iri(request.accountUri)} .`,
  );

  const requestGroup = (pattern) => `{\n    GRAPH ${changeRequests} { ${iri(request.uri)} ${pattern} . }\n  }`;
  const groups = [
    requestGroup('adms:status ?oldStatus'),
    requestGroup('cr:appliedAt ?oldAppliedAt'),
    requestGroup('cr:error ?oldError'),
    ...deletes,
  ];

  return `${PREFIXES}

DELETE {
  GRAPH ${application} { ?s ?p ?o . }
  GRAPH ${changeRequests} {
    ${iri(request.uri)} adms:status ?oldStatus ;
      cr:appliedAt ?oldAppliedAt ;
      cr:error ?oldError .
  }
}
INSERT {
  GRAPH ${application} {
    ${inserts.join('\n    ')}
  }
  GRAPH ${changeRequests} {
    ${iri(request.uri)} adms:status ${iri(STATUS.goedgekeurd)} ;
      cr:appliedAt ${sparqlEscapeDateTime(appliedAt)} .
  }
}
WHERE {
  ${groups.join('\n  UNION\n  ')}
}`;
}

/** Records a failed apply on the request: status mislukt and the error message (replacing an earlier one). */
export function markFailedQuery({ requestUri, message, graph }) {
  return `${PREFIXES}

DELETE {
  GRAPH ${iri(graph)} {
    ${iri(requestUri)} adms:status ?status ;
      cr:error ?oldError .
  }
}
INSERT {
  GRAPH ${iri(graph)} {
    ${iri(requestUri)} adms:status ${iri(STATUS.mislukt)} ;
      cr:error ${sparqlEscapeString(message)} .
  }
}
WHERE {
  {
    GRAPH ${iri(graph)} { ${iri(requestUri)} adms:status ?status . }
  }
  UNION
  {
    GRAPH ${iri(graph)} { ${iri(requestUri)} cr:error ?oldError . }
  }
}`;
}

/**
 * Request records, newest first. uuid narrows to one request, targetUri to one organisation's
 * requests, visibleTo to the requests an organisation may see: those about it or submitted by it.
 */
export function changeRequestsQuery({ uuid, targetUri, visibleTo } = {}) {
  const filters = [];
  if (uuid) filters.push(`?request mu:uuid ${sparqlEscapeString(uuid)} .`);
  if (targetUri) filters.push(`FILTER(?target = ${iri(targetUri)})`);
  if (visibleTo) filters.push(`FILTER(?target = ${iri(visibleTo)} || ?requestingOrganisation = ${iri(visibleTo)})`);
  return `${PREFIXES}

SELECT DISTINCT ?request ?uuid ?created ?status ?aggregate ?target ?targetUuid ?requestingOrganisation ?requestingOrganisationUuid ?account ?appliedAt ?error
WHERE {
  ?request a cr:ChangeRequest ;
    mu:uuid ?uuid ;
    dct:created ?created ;
    adms:status ?status ;
    cr:aggregate ?aggregate ;
    cr:target ?target ;
    cr:requestingOrganisation ?requestingOrganisation ;
    prov:wasAttributedTo ?account .
  ?target mu:uuid ?targetUuid .
  ?requestingOrganisation mu:uuid ?requestingOrganisationUuid .
  OPTIONAL { ?request cr:appliedAt ?appliedAt . }
  OPTIONAL { ?request cr:error ?error . }
  ${filters.join('\n  ')}
}
ORDER BY DESC(?created)`;
}

/**
 * Everything stored on the versions of a request, one row per triple, so the versions can be
 * rebuilt and applied again (versionsFromStore in versions.js).
 */
export function storedVersionsQuery({ requestUri }) {
  return `${PREFIXES}

SELECT ?version ?master ?masterUuid ?type ?operation ?p ?o
WHERE {
  ${iri(requestUri)} prov:generated ?version .
  ?version dct:isVersionOf ?master ;
    cr:masterUuid ?masterUuid ;
    cr:resourceType ?type ;
    cr:operation ?operation ;
    ?p ?o .
}
ORDER BY ?version`;
}

/**
 * The most recent request on the target that was applied after a given moment. Re-applying an
 * older request would overwrite what that later one changed, so the re-apply refuses when it exists.
 */
export function laterAppliedQuery({ targetUri, after }) {
  return `${PREFIXES}

SELECT ?request ?uuid ?created ?appliedAt
WHERE {
  ?request a cr:ChangeRequest ;
    mu:uuid ?uuid ;
    cr:target ${iri(targetUri)} ;
    adms:status ${iri(STATUS.goedgekeurd)} ;
    dct:created ?created ;
    cr:appliedAt ?appliedAt .
  FILTER(?created > ${sparqlEscapeDateTime(after)})
}
ORDER BY DESC(?created)
LIMIT 1`;
}
