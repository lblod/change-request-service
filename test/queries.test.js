import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { model, config, operations, resources, reachable, target, currentMap, incomingMap, IDS, URIS, NS, uuidSequence, sequenceUuid, testUuid, NOW, APPLIED_AT } from './support/fixtures.js';
import { buildVersions, settleVersions, replacedStates } from '../lib/versions.js';
import {
  requestInsertQuery,
  applyQuery,
  stepQuery,
  statusQueries,
  markFailedQuery,
  cleanupStepQuery,
  changeRequestsQuery,
  requestPageQuery,
  requestCountQuery,
  stepsQuery,
  storedVersionsQuery,
  replacedStatesQuery,
  laterAppliedQuery,
  versionsChangingQuery,
  requestsOfVersionsQuery,
  proposedLocalIdsQuery,
  proposedIdentifiersQuery,
  identifierNamesQuery,
  existingTriplesQuery,
  leftoversQuery,
  storedStepsQuery,
  storedSubmissionQuery,
} from '../lib/queries.js';
import { STATUS, STEP_TYPE, OPERATION, SERVICE_AGENT } from '../constants.js';
import { parses } from './support/sparql.js';

const aggregate = config.aggregates['organization-core-data'];
const graphs = { application: 'http://mu.semte.ch/application', changeRequests: 'http://mu.semte.ch/graphs/change-requests' };
const mintUuid = uuidSequence();
const requestUuid = mintUuid();
const request = {
  uri: `http://data.lblod.info/id/change-requests/${requestUuid}`,
  uuid: requestUuid,
  created: NOW,
  aggregate: 'organization-core-data',
  targetUri: URIS.org,
  targetUuid: IDS.org,
  actorUri: URIS.org,
  actorUuid: IDS.org,
  creatorUri: URIS.person,
};
// the fixture request, settled against the current state of the masters (see fixtures.js)
const built = buildVersions({ operations, aggregateName: 'organization-core-data', aggregate, model, mintUuid, resources, reachable, target });
const { versions } = settleVersions({ versions: built.versions, current: currentMap(), incoming: incomingMap(), model, aggregateName: 'organization-core-data', mintUuid });
const newStep = (fields) => {
  const uuid = mintUuid();
  return { uri: `http://data.lblod.info/id/change-request-actions/${uuid}`, uuid, ...fields };
};
const submission = newStep({ type: 'indiening', status: 'ingediend', sequence: 1, at: NOW, agent: URIS.person, organisation: URIS.org, rule: 'own-organisation' });
const approval = newStep({ type: 'goedkeuring', status: 'goedgekeurd', sequence: 2, at: APPLIED_AT, agent: SERVICE_AGENT, rule: 'edits-apply-at-once' });
// the afhandeling that applies what the service approved
const handling = newStep({ type: 'afhandeling', status: 'afgehandeld', sequence: 3, at: APPLIED_AT, agent: SERVICE_AGENT });
const predicates = { name: `${NS.skos}prefLabel`, classification: `${NS.org}classification` };
// what the masters held when the approval applied the request: the state of the fixtures
const states = replacedStates({ versions, current: currentMap(), incoming: incomingMap(), model, mintUuid });

/** Compares with the golden file; UPDATE_GOLDEN=1 rewrites it. */
const golden = (name, actual) => {
  parses(actual);
  const file = path.resolve('test/fixtures', name);
  if (process.env.UPDATE_GOLDEN) fs.writeFileSync(file, `${actual}\n`);
  assert.ok(fs.existsSync(file), `${file} is missing; run UPDATE_GOLDEN=1 npm test and review it`);
  assert.equal(`${actual}\n`, fs.readFileSync(file, 'utf8'));
};

test('the uuids: the request, the minted master, one per built version, one per base state and link, one per step, one per replaced state and link', () => {
  assert.equal(requestUuid, sequenceUuid(1));
  assert.deepEqual(built.lids, { c1: sequenceUuid(2) });
  assert.deepEqual(built.versions.map((version) => version.uuid), [3, 4, 5, 6, 7, 8].map(sequenceUuid));
  assert.deepEqual(versions.filter((version) => version.base).map((version) => version.base.uuid), [9, 10, 11, 12].map(sequenceUuid));
  assert.deepEqual(versions.at(-1).base.links.map((link) => link.uuid), [13].map(sequenceUuid), 'the tombstone: the site linked it');
  assert.deepEqual([submission.uuid, approval.uuid, handling.uuid], [14, 15, 16].map(sequenceUuid));
  assert.deepEqual(states.map((state) => state.uuid), [17, 18, 19, 20].map(sequenceUuid), 'no state before the create');
  assert.deepEqual(states.at(-1).links.map((link) => link.uuid), [21].map(sequenceUuid));
});

test('the request insert writes the record, its indiening step, the versions and the states they started from in the change-requests graph', () => {
  const query = requestInsertQuery({ request, step: submission, versions, graph: graphs.changeRequests });
  assert.match(query, /INSERT DATA \{\n {2}GRAPH <http:\/\/mu\.semte\.ch\/graphs\/change-requests> \{/);
  assert.equal((query.match(/INSERT DATA/g) || []).length, 1, 'one update');
  // the request: the status of its last step, the requesting organisation and the person who submitted it
  assert.ok(
    query.includes(
      `<${request.uri}> a cr:ChangeRequest ;\n      mu:uuid """${requestUuid}""" ;\n      dct:created "2026-11-03T10:12:00.000Z"^^xsd:dateTime ;\n      adms:status <${STATUS.ingediend}> ;\n      cr:aggregate """organization-core-data""" ;\n      cr:target <${URIS.org}> ;\n      pav:createdBy <${URIS.org}> ;\n      dct:creator <${URIS.person}> .`,
    ),
  );
  assert.ok(!query.includes('cr:step') && !query.includes('prov:wasAttributedTo') && !query.includes('cr:requestingOrganisation'));
  // the indiening step points at the request and generated the versions
  assert.ok(
    query.includes(
      `<${submission.uri}> a cr:Action ;\n      mu:uuid """${submission.uuid}""" ;\n      dct:isPartOf <${request.uri}> ;\n      dct:type <${STEP_TYPE.indiening}> ;\n      adms:status <${STATUS.ingediend}> ;\n      schema:position "1"^^xsd:integer ;\n      prov:startedAtTime "2026-11-03T10:12:00.000Z"^^xsd:dateTime ;\n      prov:wasAssociatedWith <${URIS.person}> ;\n      cr:actingOrganisation <${URIS.org}> ;\n      cr:rule """own-organisation""" ;\n      prov:generated ${versions.map((version) => `<${version.uri}>`).join(', ')} .`,
    ),
  );
  for (const version of versions) {
    assert.ok(
      query.includes(
        `<${version.uri}> a cr:ProposedVersion ;\n      mu:uuid """${version.uuid}""" ;\n      dct:isVersionOf <${version.masterUri}> ;\n      cr:masterUuid """${version.masterUuid}""" ;\n      prov:generatedAtTime "2026-11-03T10:12:00.000Z"^^xsd:dateTime ;\n      cr:resourceType """${version.type}""" ;\n      cr:operation <${OPERATION[version.operation]}>`,
      ),
    );
  }
  assert.ok(!query.includes('prov:wasGeneratedBy <') && !query.includes('cr:deleted'), 'no link back to the step, no deleted flag');
  const [address] = versions;
  assert.ok(query.includes(`cr:changesProperty ${address.replaces.map((p) => `<${p}>`).join(', ')} ;\n      cr:base <${address.base.uri}> ;\n      <${NS.adres}Adresvoorstelling.huisnummer> """3"""`));
  assert.ok(!query.includes(`<${NS.locn}thoroughfare> """Grote Markt"""`), 'an unchanged key is not part of the version');
  // a base state: the values the version started from, with the master's predicates
  assert.ok(query.includes(`<${address.base.uri}> a cr:RecordState ;\n      mu:uuid """${address.base.uuid}""" ;\n      dct:isVersionOf <${URIS.address}> ;\n      <${NS.adres}Adresvoorstelling.huisnummer> """1""" ;`));
  const site = versions[2];
  assert.ok(query.includes(`<${site.base.uri}> a cr:RecordState ;\n      mu:uuid """${site.base.uuid}""" ;\n      dct:isVersionOf <${URIS.site}> ;\n      <${NS.org}siteAddress> <${URIS.oldContact}> .`), 'no site type before: no triple');
  const tombstone = versions.at(-1);
  assert.ok(
    query.includes(`cr:resourceType """contact-points""" ;\n      cr:operation <${OPERATION.delete}> ;\n      cr:changesProperty ${tombstone.replaces.map((p) => `<${p}>`).join(', ')} ;\n      cr:base <${tombstone.base.uri}> .`),
    'a tombstone changes every key of its type and points at its base state',
  );
  const [link] = tombstone.base.links;
  assert.ok(query.includes(`<${tombstone.base.uri}> a cr:RecordState ;\n      mu:uuid """${tombstone.base.uuid}""" ;\n      dct:isVersionOf <${URIS.oldContact}> ;\n      cr:incomingLink <${link.uri}> .`), 'the old contact point held no values; the site linked it');
  assert.ok(query.includes(`<${link.uri}> a rdf:Statement ;\n      mu:uuid """${link.uuid}""" ;\n      rdf:subject <${URIS.site}> ;\n      rdf:predicate <${NS.org}siteAddress> ;\n      rdf:object <${URIS.oldContact}> .`), 'the link, as a statement');
  assert.ok(!query.includes(`<${link.uri}> <${NS.org}siteAddress>`) && !query.includes(`<${tombstone.base.uri}> <${NS.org}siteAddress>`), 'no link predicate written the other way round');
  assert.ok(!query.includes(`<${NS.org}classification>`), 'a relationship outside the aggregate is not part of a version');
  assert.ok(!query.includes(URIS.structuredKbo), 'the update that changes nothing has no version');
  golden('request-insert.sparql', query);
});

test('the apply replaces the single-valued keys, merges the set keys, inserts the versions, stamps the target and adds the step with the states it replaced', () => {
  const query = applyQuery({ request, step: handling, decision: approval, versions, states, model, graphs });
  assert.equal((query.match(/\bDELETE\b/g) || []).length, 1);
  assert.equal((query.match(/\bINSERT\b/g) || []).length, 1);
  assert.equal((query.match(/\bWHERE\b/g) || []).length, 1);
  assert.ok(!query.includes(';\n\n'), 'no second update operation');

  const group = (subject) => {
    const start = query.indexOf(`VALUES ?s { <${subject}> }`);
    assert.ok(start >= 0, `no delete group for ${subject}`);
    return query.slice(start, query.indexOf('GRAPH', start));
  };
  // the address: exactly the keys that change
  const addressGroup = group(URIS.address);
  assert.equal((addressGroup.match(/<http/g) || []).length, 1 + 3);
  for (const predicate of [`${NS.adres}Adresvoorstelling.huisnummer`, `${NS.locn}fullAddress`, `${NS.adres}verwijstNaar`]) assert.ok(addressGroup.includes(`<${predicate}>`), predicate);
  assert.ok(query.includes(`<${URIS.address}> <${NS.adres}Adresvoorstelling.huisnummer> """3""" ;\n      <${NS.locn}fullAddress> """Grote Markt 3, 9300 Aalst, België""" ;`));
  // the organisation: the name is replaced (the werkingsgebied it carries as it is, read-only through the
  // kerngegevens); the sites (a set) lose the one it unlinks
  const orgGroup = group(URIS.org);
  assert.equal((orgGroup.match(/<http/g) || []).length, 1 + 1);
  assert.ok(orgGroup.includes(`<${NS.skos}prefLabel>`));
  assert.ok(!query.includes(`<${NS.besluit}werkingsgebied> `), 'the werkingsgebied is not written');
  assert.ok(query.includes(`DELETE {\n  GRAPH <http://mu.semte.ch/application> {\n    ?s ?p ?o .\n    <${URIS.site}> <${NS.org}siteAddress> <${URIS.oldContact}> .\n    <${URIS.org}> <${NS.org}hasSite> <${URIS.site}> .\n  }`), 'the values a merge removes');
  assert.ok(!query.includes(`<${NS.org}classification>`), 'classification is never touched');
  // the site: its site type (a reference) is replaced, the new contact point added to its contacts
  const siteGroup = group(URIS.site);
  assert.equal((siteGroup.match(/<http/g) || []).length, 1 + 1);
  assert.ok(siteGroup.includes(`<${NS.ere}vestigingstype>`));
  assert.ok(query.includes(`<${URIS.site}> <${NS.org}siteAddress> <${versions[1].masterUri}> ;\n      <${NS.ere}vestigingstype> <${URIS.siteType}> .`));
  // the create inserts the class tree and the uuid of the new master
  const contact = versions[1];
  assert.ok(query.includes(`<${contact.masterUri}> a <${NS.schema}ContactPoint> ;\n      mu:uuid """${contact.masterUuid}""" ;\n      <${NS.schema}email> """info@aalst.be"""`));
  // the tombstone: outgoing triples and the incoming relationship predicates of contact-points, not the
  // versions and record states of change requests that hold them too (sparql-parser reads every graph)
  assert.ok(query.includes(`VALUES ?s { <${URIS.oldContact}> }\n    GRAPH <http://mu.semte.ch/application> { ?s ?p ?o . }`));
  assert.ok(
    query.includes(
      `VALUES ?o { <${URIS.oldContact}> }\n    VALUES ?p { <${NS.schema}contactPoint> <${NS.org}siteAddress> }\n    FILTER NOT EXISTS { ?s a cr:ProposedVersion . }\n    FILTER NOT EXISTS { ?s a cr:RecordState . }\n    GRAPH <http://mu.semte.ch/application> { ?s ?p ?o . }`,
    ),
  );
  // the stamp on the target with the person who submitted the request
  assert.ok(query.includes(`VALUES ?s { <${URIS.org}> }\n    VALUES ?p { dct:modified ext:lastModifiedBy }`));
  assert.ok(query.includes(`<${URIS.org}> dct:modified "2026-11-03T10:12:01.000Z"^^xsd:dateTime ;\n      ext:lastModifiedBy <${URIS.person}> .`));
  // the goedkeuring and the afhandeling with the states it replaced, in the same update; not the request's
  // status, which follows once the apply is read back (statusQueries)
  assert.ok(query.includes(`INSERT {\n  GRAPH <http://mu.semte.ch/application> {`));
  assert.ok(query.includes(`  GRAPH <http://mu.semte.ch/graphs/change-requests> {\n    <${approval.uri}> a cr:Action ;`));
  assert.ok(!query.includes(`<${request.uri}> adms:status`), 'the status is not touched');
  assert.ok(
    query.includes(
      `<${approval.uri}> a cr:Action ;\n      mu:uuid """${approval.uuid}""" ;\n      dct:isPartOf <${request.uri}> ;\n      dct:type <${STEP_TYPE.goedkeuring}> ;\n      adms:status <${STATUS.goedgekeurd}> ;\n      schema:position "2"^^xsd:integer ;\n      prov:startedAtTime "2026-11-03T10:12:01.000Z"^^xsd:dateTime ;\n      prov:wasAssociatedWith <${SERVICE_AGENT}> ;\n      cr:rule """edits-apply-at-once""" .`,
    ),
    'the service approved it: no acting organisation, no states (the afhandeling replaces them)',
  );
  assert.ok(
    query.includes(
      `<${handling.uri}> a cr:Action ;\n      mu:uuid """${handling.uuid}""" ;\n      dct:isPartOf <${request.uri}> ;\n      dct:type <${STEP_TYPE.afhandeling}> ;\n      adms:status <${STATUS.afgehandeld}> ;\n      schema:position "3"^^xsd:integer ;\n      prov:startedAtTime "2026-11-03T10:12:01.000Z"^^xsd:dateTime ;\n      prov:wasAssociatedWith <${SERVICE_AGENT}> ;\n      prov:invalidated ${states.map((state) => `<${state.uri}>`).join(', ')} .`,
    ),
    'the afhandeling applied it and replaced the states',
  );
  const [addressState, siteState, orgState, contactState] = states;
  assert.ok(
    query.includes(
      `<${addressState.uri}> a cr:RecordState ;\n      mu:uuid """${addressState.uuid}""" ;\n      dct:isVersionOf <${URIS.address}> ;\n      <${NS.locn}fullAddress> """Grote Markt 1, 9300 Aalst, België""" ;\n      <${NS.adres}Adresvoorstelling.huisnummer> """1""" ;\n      <${NS.adres}verwijstNaar> <https://data.vlaanderen.be/id/adres/123455> .`,
    ),
    'what the address held for the keys the version changes',
  );
  assert.ok(query.includes(`<${siteState.uri}> a cr:RecordState ;\n      mu:uuid """${siteState.uuid}""" ;\n      dct:isVersionOf <${URIS.site}> ;\n      <${NS.org}siteAddress> <${URIS.oldContact}> .`), 'the whole set the merge changed; no site type');
  assert.ok(query.includes(`<${orgState.uri}> a cr:RecordState ;\n      mu:uuid """${orgState.uuid}""" ;\n      dct:isVersionOf <${URIS.org}> ;\n      <${NS.skos}prefLabel> """Aalst""" ;\n      <${NS.org}hasSite> <${URIS.site}> .`));
  const [link] = contactState.links;
  assert.ok(query.includes(`<${contactState.uri}> a cr:RecordState ;\n      mu:uuid """${contactState.uuid}""" ;\n      dct:isVersionOf <${URIS.oldContact}> ;\n      cr:incomingLink <${link.uri}> .`), 'the deleted contact point and the site that linked it');
  assert.ok(query.includes(`<${link.uri}> a rdf:Statement ;\n      mu:uuid """${link.uuid}""" ;\n      rdf:subject <${URIS.site}> ;\n      rdf:predicate <${NS.org}siteAddress> ;\n      rdf:object <${URIS.oldContact}> .`));
  assert.ok(!query.includes('?oldStatus'));
  // every WHERE group is independent; the first one, the request's type, always matches
  assert.ok(query.includes(`WHERE {\n  {\n    GRAPH <http://mu.semte.ch/graphs/change-requests> { <${request.uri}> a cr:ChangeRequest . }\n  }\n  UNION`));
  const groups = 1 /* request type */ + 3 /* updates */ + 2 /* tombstone */ + 1; /* target stamp */
  assert.equal((query.match(/\n {2}UNION\n/g) || []).length, groups - 1);
  golden('apply.sparql', query);
});

test('a goedkeuring by ABB carries the person, the organisation and the rule; the afhandeling that follows replaces the states; the stamp names the person who submitted the change', () => {
  const decision = newStep({ type: 'goedkeuring', status: 'goedgekeurd', sequence: 2, at: APPLIED_AT, agent: URIS.personAbb, organisation: URIS.abb, rule: 'abb-decides-all', reason: 'In orde' });
  const applying = newStep({ type: 'afhandeling', status: 'afgehandeld', sequence: 3, at: APPLIED_AT, agent: SERVICE_AGENT, overriddenConflicts: [{ key: 'name' }] });
  const query = applyQuery({ request, step: applying, decision, versions, states, model, graphs });
  assert.ok(query.includes(`prov:wasAssociatedWith <${URIS.personAbb}> ;\n      cr:actingOrganisation <${URIS.abb}> ;\n      cr:rule """abb-decides-all""" ;\n      dct:description """In orde""" .`));
  assert.ok(query.includes(`prov:wasAssociatedWith <${SERVICE_AGENT}> ;\n      prov:invalidated `));
  assert.ok(!query.includes('overrid'), 'what it overrode is kept by the states it replaced, not written as such');
  assert.ok(query.includes(`ext:lastModifiedBy <${URIS.person}>`), 'not the approver');
});

test('a plan removes given values and inserts given triples; without a plan a version replaces what it lists', () => {
  const [address] = versions;
  const planned = { ...address, apply: { replace: [], remove: [{ predicate: `${NS.locn}thoroughfare`, object: '"""Grote Markt"""@nl' }], insert: [{ predicate: `${NS.locn}thoroughfare`, object: '"""Groenplaats"""' }] } };
  const query = applyQuery({ request, step: approval, versions: [planned], model, graphs });
  assert.ok(query.includes(`GRAPH <http://mu.semte.ch/application> {\n    ?s ?p ?o .\n    <${URIS.address}> <${NS.locn}thoroughfare> """Grote Markt"""@nl .\n  }`), 'the stamp group binds ?s ?p ?o; the merge deletes the value');
  assert.ok(query.includes(`<${URIS.address}> <${NS.locn}thoroughfare> """Groenplaats""" .`));
  assert.ok(!query.includes(`VALUES ?s { <${URIS.address}> }`), 'nothing replaced');
  const { apply: _plan, ...unplanned } = address;
  assert.ok(applyQuery({ request, step: approval, versions: [unplanned], model, graphs }).includes(`VALUES ?s { <${URIS.address}> }\n    VALUES ?p { ${address.replaces.map((p) => `<${p}>`).join(' ')} }`));
});

test('approving a request that changes nothing records the steps only, without a DELETE', () => {
  const query = parses(applyQuery({ request, step: handling, decision: approval, versions: [], model, graphs }));
  assert.ok(!query.includes('http://mu.semte.ch/application'), 'no application graph, no stamp');
  assert.ok(!query.includes('DELETE'), 'nothing to delete: no empty DELETE template');
  assert.ok(query.includes(`GRAPH <http://mu.semte.ch/graphs/change-requests> {\n    <${approval.uri}> a cr:Action ;`));
  assert.ok(query.includes(`<${handling.uri}> a cr:Action ;`));
  assert.ok(!query.includes('prov:invalidated'), 'it replaced nothing');
  assert.equal((query.match(/\n {2}UNION\n/g) || []).length, 0);
});

test('a status is set in two updates: the new one is added before the others are removed, so a request never lacks one', () => {
  const [add, removeOthers] = statusQueries({ request, status: 'afgekeurd', graph: graphs.changeRequests }).map(parses);
  assert.ok(add.includes(`INSERT DATA {\n  GRAPH <${graphs.changeRequests}> { <${request.uri}> adms:status <${STATUS.afgekeurd}> . }\n}`));
  assert.ok(!add.includes('DELETE'));
  assert.ok(removeOthers.includes(`DELETE {\n  GRAPH <${graphs.changeRequests}> { <${request.uri}> adms:status ?other . }\n}`));
  assert.ok(removeOthers.includes(`FILTER(?other != <${STATUS.afgekeurd}>)`), 'never the status just added');
  assert.ok(!removeOthers.includes('INSERT'));
});

test('an informatievraag, an informatieantwoord and a betwisting change the status and keep their text', () => {
  const question = newStep({ type: 'informatievraag', status: 'informatie-gevraagd', sequence: 2, at: APPLIED_AT, agent: URIS.personAbb, organisation: URIS.abb, rule: 'abb-decides-all', reason: 'Welk besluit?' });
  const asked = parses(stepQuery({ request, step: question, graphs }));
  assert.ok(asked.includes(`INSERT DATA {\n  GRAPH <${graphs.changeRequests}> {\n    <${question.uri}> a cr:Action ;`), 'the step only: the status follows with statusQueries');
  assert.ok(!asked.includes(`<${request.uri}> adms:status`));
  assert.ok(asked.includes(`dct:type <${STEP_TYPE.informatievraag}> ;\n      adms:status <${STATUS['informatie-gevraagd']}> ;`) && asked.includes('dct:description """Welk besluit?"""'));
  const answer = newStep({ type: 'informatieantwoord', status: 'ingediend', sequence: 3, at: APPLIED_AT, agent: URIS.person, organisation: URIS.org, rule: 'requesting-organisation', reason: 'Zie link' });
  assert.ok(stepQuery({ request, step: answer, graphs }).includes(`dct:type <${STEP_TYPE.informatieantwoord}> ;\n      adms:status <${STATUS.ingediend}> ;`));
  const contest = newStep({ type: 'betwisting', status: 'ingediend', sequence: 4, at: APPLIED_AT, agent: URIS.person, organisation: URIS.org, rule: 'requesting-organisation', reason: 'Het besluit is wel geldig' });
  assert.ok(stepQuery({ request, step: contest, graphs }).includes(`dct:type <${STEP_TYPE.betwisting}> ;\n      adms:status <${STATUS.ingediend}> ;`));
});

test('an afkeuring or intrekking adds the step with its reason; the intrekking of a replaced request names the newer one', () => {
  const rejection = newStep({ type: 'afkeuring', status: 'afgekeurd', sequence: 2, at: APPLIED_AT, agent: URIS.personAbb, organisation: URIS.abb, rule: 'abb-decides-all', reason: 'Het "ondernemingsnummer" klopt niet' });
  const query = parses(stepQuery({ request, step: rejection, graphs }));
  assert.ok(!query.includes('http://mu.semte.ch/application'));
  assert.ok(!query.includes('DELETE'), 'nothing is deleted: the status follows with statusQueries');
  assert.ok(query.includes(`GRAPH <${graphs.changeRequests}> {\n    <${rejection.uri}> a cr:Action ;`));
  assert.ok(query.includes(`dct:type <${STEP_TYPE.afkeuring}> ;\n      adms:status <${STATUS.afgekeurd}> ;\n      schema:position "2"^^xsd:integer ;`));
  assert.ok(query.includes('cr:rule """abb-decides-all""" ;\n      dct:description """Het \\"ondernemingsnummer\\" klopt niet""" .'));
  assert.ok(!query.includes('dct:isReplacedBy'));
  const newer = `http://data.lblod.info/id/change-requests/${testUuid('request', 9)}`;
  const withdrawal = newStep({ type: 'intrekking', status: 'ingetrokken', sequence: 2, at: APPLIED_AT, agent: SERVICE_AGENT, rule: 'superseded-by-own-request', reason: `Vervangen door wijzigingsaanvraag ${testUuid('request', 9)}` });
  const replaced = parses(stepQuery({ request, step: withdrawal, graphs, replacedBy: newer }));
  assert.ok(replaced.includes(`\n    <${request.uri}> dct:isReplacedBy <${newer}> .`));
});

test('a failed apply is recorded as a step with status mislukt, an oslc:Error and the states the attempt replaced; the status follows', () => {
  const error = { uri: `http://redpencil.data.gift/id/jobs/error/${testUuid('error', 1)}`, uuid: testUuid('error', 1), message: 'Virtuoso said "no"', at: APPLIED_AT };
  const query = parses(markFailedQuery({ request, step: { ...handling, error }, decision: approval, states, graph: graphs.changeRequests }));
  assert.ok(query.includes(`INSERT DATA {\n  GRAPH <${graphs.changeRequests}> {\n    <${approval.uri}> a cr:Action ;`), 'the goedkeuring is kept; nothing is deleted');
  assert.ok(!query.includes(`<${request.uri}> adms:status`) && !query.includes('DELETE'));
  assert.ok(query.includes(`dct:type <${STEP_TYPE.goedkeuring}> ;\n      adms:status <${STATUS.goedgekeurd}> ;\n      schema:position "2"^^xsd:integer ;`));
  assert.ok(query.includes(`dct:type <${STEP_TYPE.afhandeling}> ;\n      adms:status <${STATUS.mislukt}> ;\n      schema:position "3"^^xsd:integer ;`));
  assert.ok(query.includes(`prov:wasAssociatedWith <${SERVICE_AGENT}> ;\n      task:error <${error.uri}> ;\n      prov:invalidated ${states.map((state) => `<${state.uri}>`).join(', ')} .`));
  assert.ok(
    query.includes(
      `<${error.uri}> a oslc:Error ;\n      mu:uuid """${error.uuid}""" ;\n      oslc:message """Virtuoso said \\"no\\"""" ;\n      dct:created "2026-11-03T10:12:01.000Z"^^xsd:dateTime ;\n      dct:creator <${SERVICE_AGENT}> ;\n      dct:references <${request.uri}> .`,
    ),
    'in the shape job-controller writes its errors',
  );
  assert.ok(query.includes(`<${states[0].uri}> a cr:RecordState ;`));
  // what an interrupted attempt wrote of its step goes, by the step's URI
  const cleanup = parses(cleanupStepQuery({ stepUri: handling.uri, graph: graphs.changeRequests }));
  assert.ok(cleanup.includes(`DELETE {\n  GRAPH <${graphs.changeRequests}> { <${handling.uri}> ?p ?o . }\n}`) && !cleanup.includes('INSERT'));
});

test('the listing pages the requests that match the filters, oldest first by default, and reads the details of a page by URI', () => {
  const visibility = { organisation: URIS.orgB, statuses: ['afgehandeld'] };
  const involved = `FILTER(?target = <${URIS.orgB}> || ?requestingOrganisation = <${URIS.orgB}> || ?status IN (<${STATUS.afgehandeld}>))`;
  const filters = { targetUri: URIS.org, visibility, statuses: ['ingediend', 'mislukt'] };
  const page = requestPageQuery({ ...filters, sort: '-created', limit: 20, offset: 40 });
  assert.ok(page.includes('SELECT DISTINCT ?request ?created'));
  assert.ok(page.includes('?request a cr:ChangeRequest ;'));
  assert.ok(page.includes('pav:createdBy ?requestingOrganisation ;\n    dct:creator ?creator .'));
  assert.ok(!page.includes('?targetUuid'), 'the target is not joined: a creation that waits has none in the data');
  assert.ok(page.includes(`VALUES ?status { <${STATUS.ingediend}> <${STATUS.mislukt}> }`));
  assert.ok(page.includes(`FILTER(?target = <${URIS.org}>)`));
  assert.ok(page.includes(involved), 'an organisation that is not ABB, while pending requests are for the involved only');
  assert.ok(page.endsWith('ORDER BY DESC(?created) DESC(?request)\nLIMIT 20\nOFFSET 40'));
  assert.ok(requestPageQuery({ limit: 20, offset: 0 }).endsWith('ORDER BY ASC(?created) ASC(?request)\nLIMIT 20\nOFFSET 0'), 'oldest first by default');
  assert.throws(() => requestPageQuery({ ...filters, limit: '20; DROP', offset: 0 }), /expected a whole number/);
  const count = requestCountQuery(filters);
  assert.ok(count.includes('SELECT (COUNT(DISTINCT ?request) AS ?count)') && count.includes(`VALUES ?status { <${STATUS.ingediend}> <${STATUS.mislukt}> }`));
  assert.ok(!requestPageQuery({ limit: 20, offset: 0 }).includes('FILTER'), 'everyone sees all');
  // the filters of the listing: the person who submitted them, the kind, the requester, the classification, the time
  const filtered = requestPageQuery({ creatorUri: URIS.person, aggregates: ['new-organisation', 'change-event'], requesterUri: URIS.org, classification: { uri: URIS.ilvCode, predicate: predicates.classification }, createdFrom: '2026-10-01T00:00:00Z', createdUntil: '2026-10-31T23:59:59Z', limit: 20, offset: 0 });
  assert.ok(filtered.includes(`FILTER(?creator = <${URIS.person}>)`));
  assert.ok(filtered.includes('VALUES ?aggregate { """new-organisation""" """change-event""" }'));
  assert.ok(filtered.includes(`FILTER(?requestingOrganisation = <${URIS.org}>)`));
  assert.ok(filtered.includes(`{ ?target <${NS.org}classification> ?classification . }\n  UNION\n  {`) && filtered.includes(`FILTER(?classification = <${URIS.ilvCode}>)`), 'the classification of the organisation, or of the one a creation proposes');
  assert.ok(filtered.includes('FILTER(?created >= "2026-10-01T00:00:00.000Z"^^xsd:dateTime)') && filtered.includes('FILTER(?created <= "2026-10-31T23:59:59.000Z"^^xsd:dateTime)'));

  const other = `http://data.lblod.info/id/change-requests/${testUuid('request', 2)}`;
  const details = changeRequestsQuery({ requestUris: [request.uri, other], predicates });
  assert.ok(details.includes(`VALUES ?request { <${request.uri}> <${other}> }`));
  assert.ok(details.includes('OPTIONAL {\n    ?request dct:isReplacedBy ?replacedBy .\n    ?replacedBy mu:uuid ?replacedByUuid .\n  }'), 'the newer request that replaced it');
  assert.ok(details.includes('OPTIONAL { ?target mu:uuid ?targetUuid . }') && details.includes(`OPTIONAL { ?target <${NS.skos}prefLabel> ?targetName . }`), 'the target when it exists');
  assert.ok(details.includes(`dct:type <${STEP_TYPE.indiening}> ;\n      prov:generated ?targetVersion .\n    ?targetVersion dct:isVersionOf ?target ;\n      cr:masterUuid ?proposedUuid .`), 'else what the submission proposes');
  assert.ok(!details.includes('cr:appliedAt'));
  const one = changeRequestsQuery({ uuid: requestUuid, visibility, predicates });
  assert.ok(one.includes(`?request mu:uuid """${requestUuid}""" .`) && one.includes(involved));

  const steps = stepsQuery({ requestUris: [request.uri] });
  assert.ok(steps.includes(`VALUES ?request { <${request.uri}> }`));
  assert.ok(steps.includes('?step dct:isPartOf ?request ;\n    a cr:Action ;\n    mu:uuid ?stepUuid ;\n    schema:position ?sequence ;'));
  assert.ok(steps.includes('OPTIONAL { ?agent mu:uuid ?agentUuid . }'));
  assert.ok(steps.includes('?step task:error ?errorRecord .\n    ?errorRecord oslc:message ?error .'));
  assert.ok(!steps.includes('FILTER'), 'by URI only: who may see the request is decided before');
  assert.ok(steps.indexOf('VALUES ?request') < steps.indexOf('?step dct:isPartOf ?request'), 'anchored on the requests');
  for (const query of [page, count, filtered, details, one, steps]) parses(query);
  assert.ok(details.includes('OPTIONAL { ?request adms:status ?status . }'), 'a request whose status was lost is still found');
  assert.ok(details.includes('OPTIONAL { ?requestingOrganisation mu:uuid ?requestingOrganisationUuid . }'), 'and one whose requesting organisation is gone');
});

test('the stored versions, replaced states, later-applied queries and the anchored lookups of other requests', () => {
  const other = `http://data.lblod.info/id/change-requests/${testUuid('request', 2)}`;
  const stored = storedVersionsQuery({ requestUris: [request.uri, other] });
  assert.ok(stored.includes(`VALUES ?request { <${request.uri}> <${other}> }`));
  assert.ok(stored.includes('?submission a cr:Action ;\n    dct:isPartOf ?request ;\n    prov:generated ?version .'));
  assert.ok(stored.includes('{ ?version ?p ?o . }\n  UNION\n  { ?version cr:base ?base . ?base ?p ?o . }\n  UNION\n  { ?version cr:base ?base . ?base cr:incomingLink ?link . ?link ?p ?o . }'));

  const replaced = replacedStatesQuery({ requestUris: [request.uri] });
  assert.ok(replaced.includes('SELECT ?request ?step ?state ?master ?link ?p ?o'));
  assert.ok(replaced.includes('?step a cr:Action ;\n    dct:isPartOf ?request ;\n    prov:invalidated ?state .\n  ?state dct:isVersionOf ?master .'));
  assert.ok(replaced.includes('{ ?state ?p ?o . }\n  UNION\n  { ?state cr:incomingLink ?link . ?link ?p ?o . }'));

  const later = laterAppliedQuery({ targetUri: URIS.org, after: '2026-11-03T10:12:00Z', exclude: request.uri });
  assert.ok(later.includes(`cr:target <${URIS.org}> .`));
  assert.ok(later.includes(`?step a cr:Action ;\n    dct:isPartOf ?request ;\n    adms:status <${STATUS.afgehandeld}> ;\n    prov:startedAtTime ?appliedAt .`));
  assert.ok(later.includes('?submission a cr:Action ;\n    dct:isPartOf ?request ;\n    prov:generated ?version .'), 'only a request that changed something: an approval of a request without versions does not count');
  assert.ok(later.includes(`FILTER(?request != <${request.uri}>)`));
  assert.ok(later.includes('FILTER(?appliedAt > "2026-11-03T10:12:00.000Z"^^xsd:dateTime)'));
  assert.ok(later.includes('LIMIT 1'));

  // The lookups of other requests: small queries, each starting from the values it is given, so Virtuoso
  // does not refuse them on its cost estimate while the change-requests graph is still empty.
  const changing = parses(versionsChangingQuery({ pairs: [{ subject: URIS.org, predicate: `${NS.skos}prefLabel` }] }));
  assert.ok(changing.includes(`VALUES (?master ?p) { (<${URIS.org}> <${NS.skos}prefLabel>) }\n  ?version dct:isVersionOf ?master ;\n    cr:changesProperty ?p .\n}`));
  const version = `http://data.lblod.info/id/proposed-versions/${testUuid('version', 1)}`;
  const ofVersions = parses(requestsOfVersionsQuery({ versionUris: [version] }));
  assert.ok(ofVersions.includes(`VALUES ?version { <${version}> }\n  ?submission prov:generated ?version ;\n    dct:isPartOf ?request .`));
  assert.ok(ofVersions.includes('adms:status ?status ;\n    cr:aggregate ?aggregate ;\n    pav:createdBy ?requestingOrganisation .'), 'the status and the aggregate are filtered by the service');

  const identifierPredicates = { identifiers: `${NS.adms}identifier`, idName: `${NS.skos}notation`, structuredIdentifier: `${NS.generiek}gestructureerdeIdentificator`, localId: `${NS.generiek}lokaleIdentificator` };
  const localIds = parses(proposedLocalIdsQuery({ localIds: ['0123456789', '0123.456.789'], predicates: identifierPredicates }));
  assert.ok(localIds.includes(`VALUES ?localId { """0123456789""" """0123.456.789""" }\n  ?structuredVersion <${NS.generiek}lokaleIdentificator> ?localId ;\n    dct:isVersionOf ?structured ;\n    a cr:ProposedVersion .`));
  const structured = `http://data.lblod.info/id/gestructureerdeIdentificatoren/${testUuid('version', 2)}`;
  const named = parses(proposedIdentifiersQuery({ pairs: [{ structured, structuredVersion: version }], predicates: identifierPredicates }));
  assert.ok(named.includes(`VALUES (?structured ?structuredVersion) { (<${structured}> <${version}>) }`));
  assert.ok(named.includes('?submission prov:generated ?identifierVersion, ?structuredVersion .'), 'the identifier and its structured identifier of one submission');
  const names = parses(identifierNamesQuery({ structuredUris: [URIS.structuredKbo], predicates: identifierPredicates, idClass: `${NS.adms}Identifier` }));
  assert.ok(names.includes(`VALUES ?structured { <${URIS.structuredKbo}> }`) && names.includes(`a <${NS.adms}Identifier> .`), 'identifiers of the register, not versions');
});

test('the read-backs of a submission and of an apply are anchored queries that parse', () => {
  const triple = { subject: `<${URIS.org}>`, predicate: `<${NS.skos}prefLabel>`, object: '"""Stad Aalst"""' };
  assert.ok(parses(existingTriplesQuery({ triples: [triple] })).includes(`VALUES (?s ?p ?o) { (<${URIS.org}> <${NS.skos}prefLabel> """Stad Aalst""") }\n  ?s ?p ?o .`));
  const leftovers = parses(leftoversQuery({ uris: [URIS.oldContact], incoming: [`${NS.org}siteAddress`] }));
  assert.ok(leftovers.includes(`VALUES ?record { <${URIS.oldContact}> }\n    VALUES ?p { <${NS.org}siteAddress> }\n    ?s ?p ?record .`));
  assert.ok(!parses(leftoversQuery({ uris: [URIS.oldContact], incoming: [] })).includes('UNION'));
  assert.ok(parses(storedStepsQuery({ steps: [approval, handling] })).includes(`(<${handling.uri}> <${STATUS.afgehandeld}>)`));
  assert.ok(parses(storedSubmissionQuery({ request, step: submission })).includes(`<${submission.uri}> prov:generated ?version .`));
});

test('a creation of a subtype writes every class of its class tree', () => {
  const created = buildVersions({
    operations: [
      { op: 'create', data: { type: 'addresses', lid: 'a1', attributes: { street: 'x' } } },
      { op: 'update', data: { type: 'sites', id: IDS.site, relationships: { address: { data: { type: 'addresses', lid: 'a1' } } } } },
    ],
    aggregateName: 'site', aggregate: config.aggregates.site, model, mintUuid: uuidSequence(), resources, reachable, target,
  });
  const query = applyQuery({ request, step: approval, versions: created.versions, model, graphs });
  assert.ok(query.includes(`a <${NS.locn}Address> ;`));
  assert.deepEqual(model.classTree('administrative-units'), [`${NS.besluit}Bestuurseenheid`, `${NS.org}Organization`, `${NS.dct}Agent`]);
});
