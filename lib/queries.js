import { sparqlEscapeUri, sparqlEscapeString, sparqlEscapeDateTime, sparqlEscapeInt } from 'mu';
import { PREFIXES, STATUS, STEP_TYPE, OPERATION, SERVICE_AGENT, PENDING_STATUS_KEYS } from '../constants.js';

const iri = sparqlEscapeUri;

/**
 * A step of a request, stored as a cr:Action: { uri, uuid, type, status, sequence, at, agent,
 * organisation?, rule?, reason?, error?, generated?, invalidated? }, type and status as their keys
 * (goedkeuring, goedgekeurd), agent the person (foaf:Person) or SERVICE_AGENT, organisation the
 * acting organisation of a person's step, reason the text of the step (the question of an
 * informatievraag, the answer, the reason of an afkeuring or a betwisting), error { uri, uuid,
 * message, at } the oslc:Error of a failed apply, generated the versions of the indiening step,
 * invalidated the record states an apply replaced (stateBlock). It points at its request with
 * dct:isPartOf; its adms:status is the status of the request after it.
 */
function stepBlock(step, requestUri) {
  const lines = [
    `${iri(step.uri)} a cr:Action`,
    `mu:uuid ${sparqlEscapeString(step.uuid)}`,
    `dct:isPartOf ${iri(requestUri)}`,
    `dct:type ${iri(STEP_TYPE[step.type])}`,
    `adms:status ${iri(STATUS[step.status])}`,
    `schema:position ${sparqlEscapeInt(step.sequence)}`,
    `prov:startedAtTime ${sparqlEscapeDateTime(step.at)}`,
    `prov:wasAssociatedWith ${iri(step.agent)}`,
  ];
  if (step.organisation) lines.push(`cr:actingOrganisation ${iri(step.organisation)}`);
  if (step.rule) lines.push(`cr:rule ${sparqlEscapeString(step.rule)}`);
  if (step.reason) lines.push(`dct:description ${sparqlEscapeString(step.reason)}`);
  if (step.error) lines.push(`task:error ${iri(step.error.uri)}`);
  if (step.generated?.length) lines.push(`prov:generated ${step.generated.map(iri).join(', ')}`);
  if (step.invalidated?.length) lines.push(`prov:invalidated ${step.invalidated.map(iri).join(', ')}`);
  return `${lines.join(' ;\n      ')} .`;
}

/** Why an apply failed: an oslc:Error the service created, about the request, as job-controller writes them. */
function errorBlock(error, requestUri) {
  return [
    `${iri(error.uri)} a oslc:Error`,
    `mu:uuid ${sparqlEscapeString(error.uuid)}`,
    `oslc:message ${sparqlEscapeString(error.message)}`,
    `dct:created ${sparqlEscapeDateTime(error.at)}`,
    `dct:creator ${iri(SERVICE_AGENT)}`,
    `dct:references ${iri(requestUri)}`,
  ].join(' ;\n      ') + ' .';
}

/**
 * A cr:RecordState: the values some keys of a record (masterUri) had at one moment, with the
 * record's own predicates (no triple for a key that was empty), and for a deleted record the links
 * that pointed at it then, one rdf:Statement each (subject, predicate, the record as object). It is
 * the state a version started from (cr:base) or the state an apply replaced (prov:invalidated).
 * state: { uri, uuid, masterUri, triples: [{ predicate, object }], links?: [{ uri, uuid, subject, predicate }] }
 */
function stateBlock(state) {
  const lines = [`${iri(state.uri)} a cr:RecordState`, `mu:uuid ${sparqlEscapeString(state.uuid)}`, `dct:isVersionOf ${iri(state.masterUri)}`];
  for (const triple of state.triples) lines.push(`${iri(triple.predicate)} ${triple.object}`);
  const links = state.links || [];
  if (links.length) lines.push(`cr:incomingLink ${links.map((link) => iri(link.uri)).join(', ')}`);
  const blocks = [`${lines.join(' ;\n      ')} .`];
  for (const link of links) {
    blocks.push(
      [
        `${iri(link.uri)} a rdf:Statement`,
        `mu:uuid ${sparqlEscapeString(link.uuid)}`,
        `rdf:subject ${iri(link.subject)}`,
        `rdf:predicate ${iri(link.predicate)}`,
        `rdf:object ${iri(state.masterUri)}`,
      ].join(' ;\n      ') + ' .',
    );
  }
  return blocks.join('\n    ');
}

/**
 * A cr:ProposedVersion: everything the apply needs, so it can be applied again from the graph
 * alone: the record (dct:isVersionOf, cr:masterUuid), its JSON:API type (cr:resourceType), the
 * operation (cr:operation, as:Create, as:Update or as:Delete), the predicates it changes on the
 * record (cr:changesProperty) and the record's triples with the version as subject. An update and
 * a delete point at the state they started from (cr:base).
 */
function versionBlock(version, created) {
  const lines = [
    `${iri(version.uri)} a cr:ProposedVersion`,
    `mu:uuid ${sparqlEscapeString(version.uuid)}`,
    `dct:isVersionOf ${iri(version.masterUri)}`,
    `cr:masterUuid ${sparqlEscapeString(version.masterUuid)}`,
    `prov:generatedAtTime ${sparqlEscapeDateTime(created)}`,
    `cr:resourceType ${sparqlEscapeString(version.type)}`,
    `cr:operation ${iri(OPERATION[version.operation])}`,
  ];
  if (version.replaces.length) lines.push(`cr:changesProperty ${version.replaces.map(iri).join(', ')}`);
  if (version.base) lines.push(`cr:base ${iri(version.base.uri)}`);
  for (const triple of version.triples) lines.push(`${iri(triple.predicate)} ${triple.object}`);
  const blocks = [`${lines.join(' ;\n      ')} .`];
  if (version.base) blocks.push(stateBlock(version.base));
  return blocks.join('\n    ');
}

/**
 * Writes the request, its indiening step and the versions with the states they started from into
 * the change-requests graph, in one INSERT DATA.
 *
 * request: { uri, uuid, created, aggregate, targetUri, actorUri, creatorUri }; the requesting
 *          organisation is its pav:createdBy, the person who submitted it its dct:creator; the
 *          target is the organisation the request is about, for a creation the organisation it
 *          would register (its URI minted at submission)
 * step:    the indiening step (status ingediend, sequence 1, with the submitter's text as its
 *          reason); it generates the versions
 */
export function requestInsertQuery({ request, step, versions, graph }) {
  const blocks = [stepBlock({ ...step, generated: versions.map((version) => version.uri) }, request.uri)];
  for (const version of versions) blocks.push(versionBlock(version, request.created));
  return `${PREFIXES}

INSERT DATA {
  GRAPH ${iri(graph)} {
    ${iri(request.uri)} a cr:ChangeRequest ;
      mu:uuid ${sparqlEscapeString(request.uuid)} ;
      dct:created ${sparqlEscapeDateTime(request.created)} ;
      adms:status ${iri(STATUS[step.status])} ;
      cr:aggregate ${sparqlEscapeString(request.aggregate)} ;
      cr:target ${iri(request.targetUri)} ;
      pav:createdBy ${iri(request.actorUri)} ;
      dct:creator ${iri(request.creatorUri)} .
    ${blocks.join('\n    ')}
  }
}`;
}

/**
 * The update that applies a request and records the step that applied it (an afhandeling after a
 * goedkeuring, or a hertoepassing, status afgehandeld), or with no versions only records a step (an
 * afkeuring, an intrekking, an informatievraag, or the afhandeling of a request that changes
 * nothing). decision is the goedkeuring step the afhandeling follows, recorded in the same update
 * (by ABB, or by the service for a request it approves at once). Every update applies its plan
 * (version.apply: { replace, remove, insert }, made by settleVersions or planStored against what
 * the masters hold now): it removes, on the master, all values of the predicates it replaces and
 * the given values of the set keys it merges, and inserts the given triples with the master as
 * subject; a version without a plan replaces the predicates it lists with its triples. A create
 * inserts its triples, the class tree and the uuid of the new master; a tombstone removes the
 * master's outgoing triples and the incoming relationship triples (the predicates the model knows
 * to point at that type) of the application data. When it applies at least one version it stamps
 * dct:modified and ext:lastModifiedBy (the person who submitted the request) on the target
 * organisation. The same update adds the step, the states it replaced (states, stateBlock: what
 * the masters held, read under the lock, for the keys the versions change) and sets the request's
 * adms:status to the step's status. replacedBy, on the intrekking of a request a newer one
 * replaced, adds dct:isReplacedBy to the request.
 *
 * The update is idempotent: delete by predicate or by value, then insert. It can be run again
 * after a failure, which matters because sparql-parser sends the effective quads to the
 * triplestore in several requests (deletes first) rather than in one transaction.
 *
 * The WHERE is a UNION of independent groups, one per pattern to delete, so there is no cross
 * product between them. The first group (the request's type, which no update removes) always
 * matches, so the INSERT and the deletes of given values happen even when no pattern matches,
 * also on a retry after an attempt that got as far as removing the old status. sparql-parser
 * does not narrow the WHERE to the graph a GRAPH clause names, so the incoming triples of a
 * tombstone leave out the versions and record states of change requests, which hold the same
 * predicates in the change-requests graph.
 */
export function applyQuery({ request, step, decision = null, versions = [], states = [], model, graphs, replacedBy = null }) {
  const application = iri(graphs.application);
  const changeRequests = iri(graphs.changeRequests);
  const inserts = [];
  const deletes = [];
  const removals = [];
  const deleteGroup = (lines) => deletes.push(`{\n    ${lines.join('\n    ')}\n    GRAPH ${application} { ?s ?p ?o . }\n  }`);

  for (const version of versions) {
    if (version.operation === 'delete') {
      deleteGroup([`VALUES ?s { ${iri(version.masterUri)} }`]);
      const incoming = model.incomingPredicates(version.type);
      if (incoming.length) {
        deleteGroup([
          `VALUES ?o { ${iri(version.masterUri)} }`,
          `VALUES ?p { ${incoming.map(iri).join(' ')} }`,
          'FILTER NOT EXISTS { ?s a cr:ProposedVersion . }',
          'FILTER NOT EXISTS { ?s a cr:RecordState . }',
        ]);
      }
      continue;
    }
    const plan = version.apply ?? { replace: version.replaces, remove: [], insert: version.triples };
    const lines = [];
    if (version.operation === 'create') {
      lines.push(`a ${version.classUris.map(iri).join(', ')}`, `mu:uuid ${sparqlEscapeString(version.masterUuid)}`);
    }
    if (plan.replace.length) {
      deleteGroup([`VALUES ?s { ${iri(version.masterUri)} }`, `VALUES ?p { ${[...new Set(plan.replace)].map(iri).join(' ')} }`]);
    }
    for (const triple of plan.remove) removals.push(`${iri(version.masterUri)} ${iri(triple.predicate)} ${triple.object} .`);
    for (const triple of plan.insert) lines.push(`${iri(triple.predicate)} ${triple.object}`);
    if (lines.length) inserts.push(`${iri(version.masterUri)} ${lines.join(' ;\n      ')} .`);
  }

  if (versions.length) {
    deleteGroup([`VALUES ?s { ${iri(request.targetUri)} }`, 'VALUES ?p { dct:modified ext:lastModifiedBy }']);
    inserts.push(
      `${iri(request.targetUri)} dct:modified ${sparqlEscapeDateTime(step.at)} ;\n      ext:lastModifiedBy ${iri(request.creatorUri)} .`,
    );
  }

  const requestGroup = (pattern) => `{\n    GRAPH ${changeRequests} { ${iri(request.uri)} ${pattern} . }\n  }`;
  const groups = [requestGroup('a cr:ChangeRequest'), requestGroup('adms:status ?oldStatus'), ...deletes];
  let applicationDelete = '';
  if (removals.length) {
    const deleted = [...(deletes.length ? ['?s ?p ?o .'] : []), ...removals];
    applicationDelete = `\n  GRAPH ${application} {\n    ${deleted.join('\n    ')}\n  }`;
  } else if (deletes.length) {
    applicationDelete = `\n  GRAPH ${application} { ?s ?p ?o . }`;
  }
  const applicationInsert = inserts.length ? `\n  GRAPH ${application} {\n    ${inserts.join('\n    ')}\n  }` : '';
  const requestLines = [`adms:status ${iri(STATUS[step.status])}`];
  if (replacedBy) requestLines.push(`dct:isReplacedBy ${iri(replacedBy)}`);
  const recorded = [
    `${iri(request.uri)} ${requestLines.join(' ;\n      ')} .`,
    ...(decision ? [stepBlock(decision, request.uri)] : []),
    stepBlock({ ...step, invalidated: states.map((state) => state.uri) }, request.uri),
    ...states.map(stateBlock),
  ];

  return `${PREFIXES}

DELETE {${applicationDelete}
  GRAPH ${changeRequests} {
    ${iri(request.uri)} adms:status ?oldStatus .
  }
}
INSERT {${applicationInsert}
  GRAPH ${changeRequests} {
    ${recorded.join('\n    ')}
  }
}
WHERE {
  ${groups.join('\n  UNION\n  ')}
}`;
}

/**
 * A step that changes nothing but the status of the request: an afkeuring, an intrekking, an
 * informatievraag, an informatieantwoord or a betwisting. replacedBy: the newer request that
 * replaced this one, on the intrekking the service takes.
 */
export function stepQuery({ request, step, graphs, replacedBy = null }) {
  return applyQuery({ request, step, versions: [], graphs, replacedBy });
}

/**
 * Records a failed apply: the step that tried it (an afhandeling or a hertoepassing) with status
 * mislukt, the oslc:Error it points at (step.error), the goedkeuring it followed (decision, when
 * there is one) and the states the attempt replaced or started to, and the request's status
 * mislukt. Whatever an interrupted attempt wrote of the step is replaced.
 */
export function markFailedQuery({ request, step, decision = null, states = [], graph }) {
  const g = iri(graph);
  const recorded = [
    ...(decision ? [stepBlock(decision, request.uri)] : []),
    stepBlock({ ...step, status: 'mislukt', invalidated: states.map((state) => state.uri) }, request.uri),
    errorBlock(step.error, request.uri),
    ...states.map(stateBlock),
  ];
  return `${PREFIXES}

DELETE {
  GRAPH ${g} {
    ${iri(request.uri)} adms:status ?status .
    ${iri(step.uri)} ?stepPredicate ?stepObject .
  }
}
INSERT {
  GRAPH ${g} {
    ${iri(request.uri)} adms:status ${iri(STATUS.mislukt)} .
    ${recorded.join('\n    ')}
  }
}
WHERE {
  {
    GRAPH ${g} { ${iri(request.uri)} a cr:ChangeRequest . }
  }
  UNION
  {
    GRAPH ${g} { ${iri(request.uri)} adms:status ?status . }
  }
  UNION
  {
    GRAPH ${g} { ${iri(step.uri)} ?stepPredicate ?stepObject . }
  }
}`;
}

// What every listed request has; changeRequestsQuery, requestPageQuery and requestCountQuery
// select the same requests. The target is not joined here: the organisation a creation would
// register does not exist until the request is applied (changeRequestsQuery reads its uuid and
// name from the proposed version then).
const REQUEST_PATTERN = `?request a cr:ChangeRequest ;
    mu:uuid ?uuid ;
    dct:created ?created ;
    adms:status ?status ;
    cr:aggregate ?aggregate ;
    cr:target ?target ;
    pav:createdBy ?requestingOrganisation ;
    dct:creator ?creator .
  ?requestingOrganisation mu:uuid ?requestingOrganisationUuid .`;

const pendingStatusValues = () => PENDING_STATUS_KEYS.map((key) => iri(STATUS[key])).join(' ');

/**
 * The filters on requests: requestUris (the requests of a page), uuid (one request), targetUri
 * (the requests about one organisation), visibility ({ organisation, statuses }: the requests an
 * organisation may see while config.pendingVisibleTo is "involved": those about it, those it
 * submitted and those with one of the statuses; null shows all), statuses (the keys of the
 * statuses to list), aggregates (the names of the aggregates to list, for a filter on the kind),
 * creatorUri (the requests a person submitted: "mine"), requesterUri (the requests an
 * organisation submitted), classification ({ uri, predicate }: the requests about an organisation
 * of that classification, the proposed one for a creation) and the submission time (createdFrom,
 * createdUntil, inclusive).
 */
const requestFilters = ({ requestUris, uuid, targetUri, visibility, statuses, aggregates, creatorUri, requesterUri, classification, createdFrom, createdUntil }) => {
  const filters = [];
  if (requestUris) filters.push(`VALUES ?request { ${requestUris.map(iri).join(' ')} }`);
  if (uuid) filters.push(`?request mu:uuid ${sparqlEscapeString(uuid)} .`);
  if (statuses?.length) filters.push(`VALUES ?status { ${statuses.map((status) => iri(STATUS[status])).join(' ')} }`);
  if (aggregates?.length) filters.push(`VALUES ?aggregate { ${aggregates.map(sparqlEscapeString).join(' ')} }`);
  if (targetUri) filters.push(`FILTER(?target = ${iri(targetUri)})`);
  if (creatorUri) filters.push(`FILTER(?creator = ${iri(creatorUri)})`);
  if (requesterUri) filters.push(`FILTER(?requestingOrganisation = ${iri(requesterUri)})`);
  if (createdFrom) filters.push(`FILTER(?created >= ${sparqlEscapeDateTime(createdFrom)})`);
  if (createdUntil) filters.push(`FILTER(?created <= ${sparqlEscapeDateTime(createdUntil)})`);
  if (classification) {
    filters.push(`{ ?target ${iri(classification.predicate)} ?classification . }
  UNION
  {
    ?classificationSubmission a cr:Action ;
      dct:isPartOf ?request ;
      prov:generated ?classificationVersion .
    ?classificationVersion dct:isVersionOf ?target ;
      ${iri(classification.predicate)} ?classification .
  }
  FILTER(?classification = ${iri(classification.uri)})`);
  }
  if (visibility) {
    const own = `?target = ${iri(visibility.organisation)} || ?requestingOrganisation = ${iri(visibility.organisation)}`;
    const shown = visibility.statuses?.length ? ` || ?status IN (${visibility.statuses.map((status) => iri(STATUS[status])).join(', ')})` : '';
    filters.push(`FILTER(${own}${shown})`);
  }
  return filters.join('\n  ');
};

/**
 * Request records: one request (uuid, with visibility for what the acting organisation may see)
 * or the requests of a page (requestUris, from requestPageQuery), with the newer request that
 * replaced one (dct:isReplacedBy) where there is one, and what the listing shows of the target:
 * its uuid, name and classification from the application data when it exists, else from the
 * version of the submission that proposes it (a creation that still waits), as ?proposedUuid,
 * ?proposedName and ?proposedClassificationUuid. predicates: { name, classification } of the
 * organisation type (the model's).
 */
export function changeRequestsQuery({ uuid, requestUris, visibility, predicates } = {}) {
  return `${PREFIXES}

SELECT DISTINCT ?request ?uuid ?created ?status ?aggregate ?target ?targetUuid ?requestingOrganisation ?requestingOrganisationUuid ?creator ?replacedBy ?replacedByUuid ?targetName ?targetClassificationUuid ?proposedUuid ?proposedName ?proposedClassificationUuid
WHERE {
  ${requestFilters({ requestUris, uuid, visibility })}
  ${REQUEST_PATTERN}
  OPTIONAL { ?target mu:uuid ?targetUuid . }
  OPTIONAL { ?target ${iri(predicates.name)} ?targetName . }
  OPTIONAL {
    ?target ${iri(predicates.classification)} ?targetClassification .
    ?targetClassification mu:uuid ?targetClassificationUuid .
  }
  OPTIONAL {
    ?submission a cr:Action ;
      dct:isPartOf ?request ;
      dct:type ${iri(STEP_TYPE.indiening)} ;
      prov:generated ?targetVersion .
    ?targetVersion dct:isVersionOf ?target ;
      cr:masterUuid ?proposedUuid .
    OPTIONAL { ?targetVersion ${iri(predicates.name)} ?proposedName . }
    OPTIONAL {
      ?targetVersion ${iri(predicates.classification)} ?proposedClassification .
      ?proposedClassification mu:uuid ?proposedClassificationUuid .
    }
  }
  OPTIONAL {
    ?request dct:isReplacedBy ?replacedBy .
    ?replacedBy mu:uuid ?replacedByUuid .
  }
}
ORDER BY DESC(?created)`;
}

const natural = (value) => {
  if (!Number.isInteger(value) || value < 0) throw new Error(`expected a whole number, got ${value}`);
  return String(value);
};

/**
 * One page of the requests that match the filters (requestFilters), oldest first (sort
 * "created") or newest first ("-created"): their URIs, at most limit, after skipping offset. The
 * details of the page come from changeRequestsQuery and stepsQuery with its URIs.
 */
export function requestPageQuery({ limit, offset, sort = 'created', ...filters }) {
  const direction = sort === '-created' ? 'DESC' : 'ASC';
  return `${PREFIXES}

SELECT DISTINCT ?request ?created
WHERE {
  ${REQUEST_PATTERN}
  ${requestFilters(filters)}
}
ORDER BY ${direction}(?created) ${direction}(?request)
LIMIT ${natural(limit)}
OFFSET ${natural(offset)}`;
}

/** The number of requests that match the filters of requestPageQuery. */
export function requestCountQuery(filters) {
  return `${PREFIXES}

SELECT (COUNT(DISTINCT ?request) AS ?count)
WHERE {
  ${REQUEST_PATTERN}
  ${requestFilters(filters)}
}`;
}

/**
 * The steps of requests, one row per step, with the uuids of the person and the acting
 * organisation and the message of the error for the API: of one request (uuid, with visibility as
 * changeRequestsQuery) or of the requests of a page (requestUris).
 */
export function stepsQuery({ uuid, requestUris, visibility } = {}) {
  return `${PREFIXES}

SELECT DISTINCT ?request ?step ?stepUuid ?sequence ?type ?status ?at ?agent ?agentUuid ?organisation ?organisationUuid ?rule ?reason ?error
WHERE {
  ${requestFilters({ requestUris, uuid, visibility })}
  ?request a cr:ChangeRequest ;
    cr:target ?target ;
    pav:createdBy ?requestingOrganisation .
  ?step a cr:Action ;
    dct:isPartOf ?request ;
    mu:uuid ?stepUuid ;
    schema:position ?sequence ;
    dct:type ?type ;
    adms:status ?status ;
    prov:startedAtTime ?at ;
    prov:wasAssociatedWith ?agent .
  OPTIONAL { ?agent mu:uuid ?agentUuid . }
  OPTIONAL {
    ?step cr:actingOrganisation ?organisation .
    OPTIONAL { ?organisation mu:uuid ?organisationUuid . }
  }
  OPTIONAL { ?step cr:rule ?rule . }
  OPTIONAL { ?step dct:description ?reason . }
  OPTIONAL {
    ?step task:error ?errorRecord .
    ?errorRecord oslc:message ?error .
  }
}
ORDER BY ?request ?sequence`;
}

/**
 * Everything stored on the versions of the given requests, on the states they started from and on
 * the links of those states, one row per triple: ?base is bound on the rows of a state, ?link too
 * on the rows of one of its links. The versions can thus be rebuilt, applied again and checked for
 * conflicts (versionsFromStore in versions.js). The versions hang off the indiening step.
 */
export function storedVersionsQuery({ requestUris }) {
  return `${PREFIXES}

SELECT ?request ?version ?master ?masterUuid ?type ?operation ?base ?link ?p ?o
WHERE {
  VALUES ?request { ${requestUris.map(iri).join(' ')} }
  ?submission a cr:Action ;
    dct:isPartOf ?request ;
    prov:generated ?version .
  ?version dct:isVersionOf ?master ;
    cr:masterUuid ?masterUuid ;
    cr:resourceType ?type ;
    cr:operation ?operation .
  { ?version ?p ?o . }
  UNION
  { ?version cr:base ?base . ?base ?p ?o . }
  UNION
  { ?version cr:base ?base . ?base cr:incomingLink ?link . ?link ?p ?o . }
}
ORDER BY ?version`;
}

/**
 * The states the steps of the given requests replaced when they applied them (prov:invalidated),
 * one row per triple, ?link bound on the rows of a link of a state (statesFromStore in
 * versions.js). From them and the versions the conflicts an apply overrode are derived.
 */
export function replacedStatesQuery({ requestUris }) {
  return `${PREFIXES}

SELECT ?request ?step ?state ?master ?link ?p ?o
WHERE {
  VALUES ?request { ${requestUris.map(iri).join(' ')} }
  ?step a cr:Action ;
    dct:isPartOf ?request ;
    prov:invalidated ?state .
  ?state dct:isVersionOf ?master .
  { ?state ?p ?o . }
  UNION
  { ?state cr:incomingLink ?link . ?link ?p ?o . }
}
ORDER BY ?state`;
}

/**
 * The most recent request on the target, other than the given one, that was applied after a
 * moment (the failure of the request to apply again) and changed something (it has versions):
 * applying the failed request now would overwrite what that one changed, so the hertoepassing is
 * refused when it exists. The applied time is the start of an afgehandeld step.
 */
export function laterAppliedQuery({ targetUri, after, exclude }) {
  return `${PREFIXES}

SELECT DISTINCT ?request ?uuid ?appliedAt
WHERE {
  ?request a cr:ChangeRequest ;
    mu:uuid ?uuid ;
    cr:target ${iri(targetUri)} .
  ?step a cr:Action ;
    dct:isPartOf ?request ;
    adms:status ${iri(STATUS.afgehandeld)} ;
    prov:startedAtTime ?appliedAt .
  ?submission a cr:Action ;
    dct:isPartOf ?request ;
    prov:generated ?version .
  FILTER(?request != ${iri(exclude)})
  FILTER(?appliedAt > ${sparqlEscapeDateTime(after)})
}
ORDER BY DESC(?appliedAt)
LIMIT 1`;
}

/**
 * The pending requests (ingediend, informatie-gevraagd) whose versions write one of the given
 * (master, predicate) pairs, for the competing requests (competingRequests in conflicts.js
 * compares their stored versions).
 */
export function competingQuery({ pairs }) {
  return `${PREFIXES}

SELECT DISTINCT ?request ?uuid
WHERE {
  VALUES (?master ?p) { ${pairs.map(({ subject, predicate }) => `(${iri(subject)} ${iri(predicate)})`).join(' ')} }
  VALUES ?status { ${pendingStatusValues()} }
  ?request a cr:ChangeRequest ;
    mu:uuid ?uuid ;
    adms:status ?status .
  ?submission a cr:Action ;
    dct:isPartOf ?request ;
    prov:generated ?version .
  ?version dct:isVersionOf ?master ;
    cr:changesProperty ?p .
}`;
}

/**
 * The pending requests of the given aggregates (the creations) that propose an identifier with
 * the given name and value: a second request to register the same KBO number. The versions of
 * the identifier and of its structured identifier hang off the same submission; the identifier
 * version points at the structured identifier's master. predicates as organisationWithIdentifier
 * (organisations.js).
 */
export function pendingIdentifierQuery({ aggregates, idName, localId, predicates }) {
  return `${PREFIXES}

SELECT DISTINCT ?request ?uuid
WHERE {
  VALUES ?status { ${pendingStatusValues()} }
  VALUES ?aggregate { ${aggregates.map(sparqlEscapeString).join(' ')} }
  ?request a cr:ChangeRequest ;
    mu:uuid ?uuid ;
    adms:status ?status ;
    cr:aggregate ?aggregate .
  ?submission a cr:Action ;
    dct:isPartOf ?request ;
    prov:generated ?identifierVersion, ?structuredVersion .
  ?identifierVersion ${iri(predicates.idName)} ${sparqlEscapeString(idName)} ;
    ${iri(predicates.structuredIdentifier)} ?structured .
  ?structuredVersion dct:isVersionOf ?structured ;
    ${iri(predicates.localId)} ${sparqlEscapeString(localId)} .
}`;
}
