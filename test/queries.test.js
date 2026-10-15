import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { model, config, operations, resources, reachable, target, IDS, URIS, NS, uuidSequence, sequenceUuid, NOW, APPLIED_AT } from './support/fixtures.js';
import { buildVersions } from '../lib/versions.js';
import { requestInsertQuery, applyQuery, markFailedQuery, changeRequestsQuery, storedVersionsQuery, laterAppliedQuery } from '../lib/queries.js';
import { STATUS } from '../constants.js';

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
  accountUri: URIS.account,
};
const { versions } = buildVersions({ operations, aggregateName: 'organization-core-data', aggregate, model, mintUuid, resources, reachable, target });

/** Compares with the golden file; UPDATE_GOLDEN=1 rewrites it. */
const golden = (name, actual) => {
  const file = path.resolve('test/fixtures', name);
  if (process.env.UPDATE_GOLDEN) fs.writeFileSync(file, `${actual}\n`);
  assert.ok(fs.existsSync(file), `${file} is missing; run UPDATE_GOLDEN=1 npm test and review it`);
  assert.equal(`${actual}\n`, fs.readFileSync(file, 'utf8'));
};

test('the request insert writes the record and its versions, status ingediend, in the change-requests graph', () => {
  const query = requestInsertQuery({ request, versions, graph: graphs.changeRequests });
  assert.match(query, /INSERT DATA \{\n {2}GRAPH <http:\/\/mu\.semte\.ch\/graphs\/change-requests> \{/);
  assert.ok(query.includes(`<${request.uri}> a cr:ChangeRequest ;`));
  assert.ok(query.includes(`mu:uuid """${requestUuid}"""`));
  assert.ok(query.includes('dct:created "2026-11-03T10:12:00.000Z"^^xsd:dateTime'));
  assert.ok(query.includes(`adms:status <${STATUS.ingediend}>`));
  assert.ok(query.includes('cr:aggregate """organization-core-data"""'));
  assert.ok(query.includes(`cr:target <${URIS.org}>`));
  assert.ok(query.includes(`cr:requestingOrganisation <${URIS.org}>`));
  assert.ok(query.includes(`prov:wasAttributedTo <${URIS.account}>`));
  assert.ok(query.includes(`prov:generated ${versions.map((v) => `<${v.uri}>`).join(', ')}`));
  for (const version of versions) {
    assert.ok(query.includes(`<${version.uri}> a cr:Version ;\n      mu:uuid """${version.uuid}""" ;\n      dct:isVersionOf <${version.masterUri}> ;\n      cr:masterUuid """${version.masterUuid}""" ;`));
    assert.ok(query.includes(`prov:wasGeneratedBy <${request.uri}>`));
    assert.ok(query.includes(`cr:resourceType """${version.type}""" ;\n      cr:operation """${version.operation}"""`));
  }
  // the tombstone records nothing but what it was
  assert.ok(query.includes(`cr:resourceType """contact-points""" ;\n      cr:operation """delete""" ;\n      cr:deleted "true"^^xsd:boolean .`));
  // a version records the predicates it replaces, so it can be applied again from the graph
  const [address] = versions;
  assert.ok(query.includes(`cr:replaces ${address.replaces.map((p) => `<${p}>`).join(', ')} ;\n      <${NS.locn}thoroughfare> """Grote Markt"""`));
  assert.ok(query.includes(`<${NS.skos}prefLabel> """Stad Aalst"""`));
  assert.ok(query.includes(`<${NS.org}siteAddress> <${versions[1].masterUri}>`));
  assert.ok(query.includes(`<${NS.ere}vestigingstype> <${URIS.siteType}>`), 'a reference is part of the version');
  assert.ok(!query.includes(`<${NS.org}classification>`), 'a relationship outside the aggregate is not');
  assert.equal((query.match(/INSERT DATA/g) || []).length, 1, 'one update');
  golden('request-insert.sparql', query);
});

test('the apply deletes per master the predicates its version replaces, inserts the versions, stamps the target, approves the request', () => {
  const query = applyQuery({ request, versions, model, appliedAt: APPLIED_AT, graphs });
  assert.equal((query.match(/\bDELETE\b/g) || []).length, 1);
  assert.equal((query.match(/\bINSERT\b/g) || []).length, 1);
  assert.equal((query.match(/\bWHERE\b/g) || []).length, 1);
  assert.ok(!query.includes(';\n\n'), 'no second update operation');

  const group = (subject) => {
    const start = query.indexOf(`VALUES ?s { <${subject}> }`);
    assert.ok(start >= 0, `no delete group for ${subject}`);
    return query.slice(start, query.indexOf('GRAPH', start));
  };
  // the address: exactly the keys the document carried (per-key semantics), the source relationship included
  const addressGroup = group(URIS.address);
  for (const name of ['street', 'number', 'box-number', 'postcode', 'municipality', 'province', 'country', 'full-address', 'address-register-uri']) {
    assert.ok(addressGroup.includes(`<${model.attribute('addresses', name).predicate}>`), name);
  }
  assert.ok(addressGroup.includes(`<${NS.dct}source>`));
  assert.equal((addressGroup.match(/<http/g) || []).length, 1 + 10);
  assert.ok(query.includes(`<${URIS.address}> <${NS.locn}thoroughfare> """Grote Markt""" ;\n      <${NS.adres}Adresvoorstelling.huisnummer> """3""" ;`));
  // the organisation: the carried keys, scope (a reference) included; classification and the uncarried contacts untouched
  const orgGroup = group(URIS.org);
  for (const predicate of [`${NS.org}hasPrimarySite`, `${NS.org}hasSite`, `${NS.adms}identifier`, `${NS.skos}prefLabel`, `${NS.skos}altLabel`, `${NS.regorg}legalName`, `${NS.org}purpose`, `${NS.lblodgeneriek}geplandeEindDatum`, `${NS.besluit}werkingsgebied`]) {
    assert.ok(orgGroup.includes(`<${predicate}>`), predicate);
  }
  assert.equal((orgGroup.match(/<http/g) || []).length, 1 + 9);
  assert.ok(!query.includes(`<${NS.org}classification>`), 'classification is never touched');
  assert.ok(!orgGroup.includes(`<${NS.schema}contactPoint>`), 'contacts was not carried');
  // the site: its reference is written
  assert.ok(group(URIS.site).includes(`<${NS.ere}vestigingstype>`));
  assert.ok(query.includes(`<${URIS.site}> <${NS.organisatie}bestaatUit> <${URIS.address}> ;\n      <${NS.org}siteAddress> <${versions[1].masterUri}> ;\n      <${NS.ere}vestigingstype> <${URIS.siteType}> .`));
  // the create inserts the class tree and the uuid of the new master
  const contact = versions[1];
  assert.ok(query.includes(`<${contact.masterUri}> a <${NS.schema}ContactPoint> ;\n      mu:uuid """${contact.masterUuid}""" ;\n      <${NS.schema}email> """info@aalst.be"""`));
  assert.ok(!query.includes(`VALUES ?s { <${contact.masterUri}> }`), 'nothing to delete for a create');
  // the tombstone: outgoing triples and the incoming relationship predicates of contact-points
  assert.ok(query.includes(`VALUES ?s { <${URIS.oldContact}> }\n    GRAPH <http://mu.semte.ch/application> { ?s ?p ?o . }`));
  assert.ok(query.includes(`VALUES ?o { <${URIS.oldContact}> }\n    VALUES ?p { <${NS.schema}contactPoint> <${NS.org}siteAddress> }`));
  assert.ok(!query.includes('<http://purl.org/dc/terms/isVersionOf>'), 'versions keep their link to a deleted master');
  // the stamp on the target and the request status
  assert.ok(query.includes(`VALUES ?s { <${URIS.org}> }\n    VALUES ?p { dct:modified ext:lastModifiedBy }`));
  assert.ok(query.includes(`<${URIS.org}> dct:modified "2026-11-03T10:12:01.000Z"^^xsd:dateTime ;\n      ext:lastModifiedBy <${URIS.account}> .`));
  assert.ok(query.includes(`GRAPH <http://mu.semte.ch/graphs/change-requests> { <${request.uri}> adms:status ?oldStatus . }`));
  assert.ok(query.includes(`<${request.uri}> adms:status <${STATUS.goedgekeurd}> ;\n      cr:appliedAt "2026-11-03T10:12:01.000Z"^^xsd:dateTime .`));
  assert.ok(query.includes(`<${request.uri}> adms:status ?oldStatus ;\n      cr:appliedAt ?oldAppliedAt ;\n      cr:error ?oldError .`), 'an earlier failure is cleaned up');
  // every WHERE group is independent: as many UNIONs as groups minus one
  const groups = 3 /* request status, appliedAt, error */ + 4 /* updates with replaced predicates */ + 2 /* tombstone */ + 1; /* target stamp */
  assert.equal((query.match(/\n {2}UNION\n/g) || []).length, groups - 1);
  golden('apply.sparql', query);
});

test('a creation of a subtype writes every class of its class tree', () => {
  const siteAggregate = config.aggregates.site;
  const created = buildVersions({
    operations: [{ op: 'create', data: { type: 'addresses', lid: 'a1', attributes: { street: 'x' } } }],
    aggregateName: 'site', aggregate: siteAggregate, model, mintUuid: uuidSequence(), resources, reachable, target,
  });
  const query = applyQuery({ request, versions: created.versions, model, appliedAt: APPLIED_AT, graphs });
  assert.ok(query.includes(`a <${NS.locn}Address> ;`));
  assert.deepEqual(model.classTree('administrative-units'), [`${NS.besluit}Bestuurseenheid`, `${NS.org}Organization`, `${NS.dct}Agent`]);
});

test('a failed apply is recorded as mislukt with the error, replacing an earlier one', () => {
  const query = markFailedQuery({ requestUri: request.uri, message: 'Virtuoso said "no"', graph: graphs.changeRequests });
  assert.ok(query.includes(`<${request.uri}> adms:status <${STATUS.mislukt}> ;\n      cr:error """Virtuoso said \\"no\\""""`));
  assert.ok(query.includes(`DELETE {\n  GRAPH <${graphs.changeRequests}> {\n    <${request.uri}> adms:status ?status ;\n      cr:error ?oldError .`));
  assert.ok(query.includes(`{ <${request.uri}> cr:error ?oldError . }`));
});

test('the listing query filters on target and on what the acting organisation may see', () => {
  const all = changeRequestsQuery();
  assert.ok(all.includes('?request a cr:ChangeRequest ;'));
  assert.ok(!all.includes('FILTER'));
  assert.ok(all.includes('ORDER BY DESC(?created)'));
  const mine = changeRequestsQuery({ targetUri: URIS.org, visibleTo: URIS.orgB });
  assert.ok(mine.includes(`FILTER(?target = <${URIS.org}>)`));
  assert.ok(mine.includes(`FILTER(?target = <${URIS.orgB}> || ?requestingOrganisation = <${URIS.orgB}>)`));
  const one = changeRequestsQuery({ uuid: requestUuid });
  assert.ok(one.includes(`?request mu:uuid """${requestUuid}""" .`));
});

test('the stored versions and the later-applied queries', () => {
  const stored = storedVersionsQuery({ requestUri: request.uri });
  assert.ok(stored.includes(`<${request.uri}> prov:generated ?version .`));
  assert.ok(stored.includes('cr:masterUuid ?masterUuid ;\n    cr:resourceType ?type ;\n    cr:operation ?operation ;\n    ?p ?o .'));
  const later = laterAppliedQuery({ targetUri: URIS.org, after: '2026-11-03T10:12:00Z' });
  assert.ok(later.includes(`cr:target <${URIS.org}> ;\n    adms:status <${STATUS.goedgekeurd}> ;`));
  assert.ok(later.includes('FILTER(?created > "2026-11-03T10:12:00.000Z"^^xsd:dateTime)'));
  assert.ok(later.includes('LIMIT 1'));
});
