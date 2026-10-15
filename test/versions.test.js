import { test } from 'node:test';
import assert from 'node:assert/strict';
import { model, config, operations, resources, reachable, reachableByOrganisation, organisations, target, IDS, URIS, NS, uuidSequence, sequenceUuid } from './support/fixtures.js';
import {
  buildVersions,
  collectReferences,
  aggregatePredicates,
  pathPredicates,
  isTypeInAggregate,
  isTargetInAggregate,
  isReferenceType,
  versionsFromStore,
} from '../lib/versions.js';

const aggregate = config.aggregates['organization-core-data'];
const build = (ops = operations, options = {}) =>
  buildVersions({ operations: ops, aggregateName: 'organization-core-data', aggregate, model, mintUuid: uuidSequence(), resources, reachable, target, ...options });
const objects = (version, predicate) => version.triples.filter((t) => t.predicate === predicate).map((t) => t.object);
const predicates = (version) => [...new Set(version.triples.map((t) => t.predicate))].sort();

test('collectReferences gathers the ids of updates, deletes and relationship references', () => {
  assert.deepEqual(
    collectReferences(operations).sort(),
    [IDS.address, IDS.site, IDS.structuredKbo, IDS.org, IDS.kboIdentifier, IDS.oldContact, IDS.siteType, IDS.gemeenteCode].sort(),
  );
  assert.deepEqual(collectReferences(null), []);
});

test('the aggregate whitelist admits subtypes of its types, the relationships between them and its references', () => {
  assert.ok(isTypeInAggregate(model, aggregate, 'administrative-units'));
  assert.ok(isTypeInAggregate(model, aggregate, 'contact-points'));
  assert.ok(!isTypeInAggregate(model, aggregate, 'governing-bodies'));
  assert.ok(!isTypeInAggregate(model, aggregate, 'locations'), 'a reference type is linked, never operated on');
  assert.ok(isTargetInAggregate(model, aggregate, 'organizations'));
  assert.ok(!isTargetInAggregate(model, aggregate, 'organization-classification-codes'));
  assert.ok(isReferenceType(model, aggregate, 'locations'));
  assert.ok(isReferenceType(model, aggregate, 'site-types'));
  assert.ok(!isReferenceType(model, aggregate, 'organization-status-codes'));
  assert.deepEqual(aggregatePredicates(model, aggregate, 'administrative-units'), [
    `${NS.schema}contactPoint`,
    `${NS.org}hasPrimarySite`,
    `${NS.org}hasSite`,
    `${NS.org}purpose`,
    `${NS.skos}altLabel`,
    `${NS.skos}prefLabel`,
    `${NS.skos}exactMatch`,
    `${NS.regorg}legalName`,
    `${NS.adms}identifier`,
    `${NS.lblodgeneriek}geplandeEindDatum`,
    `${NS.besluit}werkingsgebied`,
    `${NS.organisatie}rechtsvorm`,
    `${NS.code}inhoudelijkThema`,
    // additional-qualification-codes are concepts, located-within points at a location
    `${NS.code}bijkomendeKwalificatie`,
    'http://www.opengis.net/ont/geosparql#sfWithin',
  ].sort());
  assert.deepEqual(aggregatePredicates(model, aggregate, 'structured-identifiers'), [`${NS.generiek}lokaleIdentificator`]);
  assert.deepEqual(aggregatePredicates(model, aggregate, 'sites'), [`${NS.dct}description`, `${NS.ere}vestigingstype`, `${NS.org}siteAddress`, `${NS.organisatie}bestaatUit`].sort());
});

test('pathPredicates are the links from the target to the records of its aggregate, organisations excluded', () => {
  assert.deepEqual(pathPredicates(model, aggregate), [
    `${NS.schema}contactPoint`,
    `${NS.org}hasPrimarySite`,
    `${NS.org}hasSite`,
    `${NS.org}siteAddress`,
    `${NS.locn}address`,
    `${NS.adms}identifier`,
    `${NS.generiek}gestructureerdeIdentificator`,
    `${NS.organisatie}bestaatUit`,
  ].sort());
  assert.deepEqual(pathPredicates(model, config.aggregates.site), [
    `${NS.schema}contactPoint`,
    `${NS.org}hasPrimarySite`,
    `${NS.org}hasSite`,
    `${NS.org}siteAddress`,
    `${NS.locn}address`,
    `${NS.organisatie}bestaatUit`,
  ].sort());
});

test('builds one version per operation with fresh URIs, master URIs, typed triples and the predicates each replaces', () => {
  const { versions, lids } = build();
  assert.equal(versions.length, 6);
  // the create's master uuid is minted first, then one uuid per version
  assert.deepEqual(lids, { c1: sequenceUuid(1) });
  assert.deepEqual(versions.map((v) => v.uuid), [2, 3, 4, 5, 6, 7].map(sequenceUuid));
  assert.ok(versions.every((v) => v.uri === `http://data.lblod.info/id/versions/${v.uuid}`));

  const [address, contact, site, structuredId, org, tombstone] = versions;

  assert.equal(address.operation, 'update');
  assert.equal(address.masterUri, URIS.address);
  assert.equal(address.masterUuid, IDS.address);
  assert.deepEqual(address.classUris, [`${NS.locn}Address`]);
  assert.deepEqual(objects(address, `${NS.locn}thoroughfare`), ['"""Grote Markt"""']);
  assert.deepEqual(objects(address, `${NS.adres}Adresvoorstelling.huisnummer`), ['"""3"""']);
  assert.deepEqual(objects(address, `${NS.adres}Adresvoorstelling.busnummer`), [], 'null attributes give no triple');
  assert.ok(address.replaces.includes(`${NS.adres}Adresvoorstelling.busnummer`), 'but the key is replaced (cleared)');
  assert.deepEqual(objects(address, `${NS.adres}verwijstNaar`), ['<https://data.vlaanderen.be/id/adres/123456>'], 'url attributes are IRIs');
  assert.deepEqual(objects(address, `${NS.dct}source`), [], 'source (a concept, reference) carried as null: cleared');
  assert.ok(address.replaces.includes(`${NS.dct}source`));
  assert.equal(address.replaces.length, 10, 'the nine attributes and the source relationship');
  assert.deepEqual(address.unchanged, []);

  assert.equal(contact.operation, 'create');
  assert.equal(contact.lid, 'c1');
  assert.equal(contact.masterUuid, sequenceUuid(1));
  assert.equal(contact.masterUri, `http://data.lblod.info/id/contact-punten/${sequenceUuid(1)}`, 'minted from new-resource-base');
  assert.deepEqual(contact.classUris, [`${NS.schema}ContactPoint`]);
  assert.deepEqual(objects(contact, `${NS.schema}email`), ['"""info@aalst.be"""']);
  assert.deepEqual(objects(contact, `${NS.schema}contactType`), ['"""Primary"""']);
  assert.deepEqual(objects(contact, `${NS.locn}address`), [`<${URIS.address}>`], 'relationships point at master URIs');
  assert.deepEqual(contact.replaces, [], 'a create replaces nothing: its master is new');

  assert.deepEqual(objects(site, `${NS.organisatie}bestaatUit`), [`<${URIS.address}>`]);
  assert.deepEqual(objects(site, `${NS.org}siteAddress`), [`<${contact.masterUri}>`], 'a lid resolves to the minted master URI');
  assert.deepEqual(objects(site, `${NS.ere}vestigingstype`), [`<${URIS.siteType}>`], 'site-type is a reference: part of the version');
  assert.deepEqual(objects(site, `${NS.dct}description`), []);
  assert.deepEqual(site.replaces, [`${NS.dct}description`, `${NS.organisatie}bestaatUit`, `${NS.org}siteAddress`, `${NS.ere}vestigingstype`].sort(), 'sorted, so the update is deterministic');

  assert.deepEqual(structuredId.triples, [{ predicate: `${NS.generiek}lokaleIdentificator`, object: '"""0207437468"""' }]);
  assert.deepEqual(structuredId.replaces, [`${NS.generiek}lokaleIdentificator`]);

  assert.equal(org.type, 'administrative-units');
  assert.deepEqual(org.classUris, [`${NS.besluit}Bestuurseenheid`, `${NS.org}Organization`, `${NS.dct}Agent`]);
  assert.deepEqual(objects(org, `${NS.skos}prefLabel`), ['"""Stad Aalst"""']);
  assert.deepEqual(objects(org, `${NS.skos}altLabel`), ['"""Aalst"""']);
  assert.deepEqual(objects(org, `${NS.org}hasPrimarySite`), [`<${URIS.site}>`]);
  assert.deepEqual(objects(org, `${NS.org}hasSite`), [], 'an empty to-many relationship gives no triple');
  assert.ok(org.replaces.includes(`${NS.org}hasSite`), 'but clears the predicate');
  assert.deepEqual(objects(org, `${NS.adms}identifier`), [`<${URIS.kboIdentifier}>`]);
  assert.deepEqual(objects(org, `${NS.org}classification`), [], 'classification is outside the aggregate');
  assert.ok(!org.replaces.includes(`${NS.org}classification`), 'and is not replaced');
  assert.deepEqual(org.unchanged, [
    { name: 'classification', predicate: `${NS.org}classification`, objects: [URIS.gemeenteCode], where: '/data/attributes/operations/4/data/relationships/classification' },
  ]);
  assert.deepEqual(objects(org, `${NS.besluit}werkingsgebied`), []);
  assert.ok(org.replaces.includes(`${NS.besluit}werkingsgebied`), 'scope is a reference: null clears it');
  assert.ok(!org.replaces.includes(`${NS.schema}contactPoint`), 'contacts was not carried: left as it is');
  assert.ok(!org.replaces.includes(`${NS.org}organization`) && !org.replaces.includes(`${NS.org}member`), 'inverse relationships are ignored');
  assert.deepEqual(predicates(org), [`${NS.adms}identifier`, `${NS.org}hasPrimarySite`, `${NS.skos}altLabel`, `${NS.skos}prefLabel`].sort());

  assert.equal(tombstone.operation, 'delete');
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.masterUri, URIS.oldContact);
  assert.deepEqual(tombstone.triples, []);
  assert.deepEqual(tombstone.replaces, []);
  assert.ok(versions.slice(0, 5).every((v) => v.deleted === false));
});

const expect422 = (ops, detail, options) => assert.throws(() => build(ops, options), { status: 422, detail });

test('refuses a type outside the aggregate and unknown types', () => {
  expect422([{ op: 'update', data: { type: 'governing-bodies', id: IDS.site } }], /type "governing-bodies" is outside the aggregate "organization-core-data"/);
  expect422([{ op: 'update', data: { type: 'gebouwen', id: IDS.site } }], /unknown type "gebouwen"/);
  expect422([{ op: 'update', data: { type: 'site-types', id: IDS.siteType } }], /type "site-types" is outside the aggregate/);
});

test('refuses unknown attributes and relationships', () => {
  expect422([{ op: 'update', data: { type: 'addresses', id: IDS.address, attributes: { colour: 'blue' } } }], /unknown attribute "colour" for type "addresses"/);
  expect422([{ op: 'update', data: { type: 'sites', id: IDS.site, relationships: { owner: { data: null } } } }], /unknown relationship "owner" for type "sites"/);
});

test('refuses relationship target type mismatches, unknown ids and ids of another class', () => {
  expect422(
    [{ op: 'update', data: { type: 'sites', id: IDS.site, relationships: { address: { data: { type: 'sites', id: IDS.site } } } } }],
    /relationship "address" expects addresses, got sites/,
  );
  expect422(
    [{ op: 'update', data: { type: 'sites', id: IDS.site, relationships: { address: { data: { type: 'addresses', id: IDS.oldContact } } } } }],
    /id ".*" is not of type addresses/,
  );
  expect422(
    [{ op: 'update', data: { type: 'sites', id: IDS.site, relationships: { address: { data: { type: 'addresses', id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } } } } }],
    /no addresses with id "ffffffff-ffff-4fff-8fff-ffffffffffff" exists/,
  );
  expect422([{ op: 'update', data: { type: 'sites', id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } }], /no sites with id/);
  expect422([{ op: 'delete', data: { type: 'sites', id: IDS.address } }], /is not of type sites/);
});

test('an id that does not belong to the target organisation is refused, as operation and as reference', () => {
  // organisation A, target A, the site of organisation B
  expect422([{ op: 'delete', data: { type: 'sites', id: IDS.siteB } }], new RegExp(`id "${IDS.siteB}" \\(sites\\) does not belong to the target organisation`));
  expect422([{ op: 'update', data: { type: 'addresses', id: IDS.addressB, attributes: { street: 'x' } } }], /does not belong to the target organisation/);
  expect422(
    [{ op: 'update', data: { type: 'administrative-units', id: IDS.org, relationships: { 'primary-site': { data: { type: 'sites', id: IDS.siteB } } } } }],
    /does not belong to the target organisation/,
  );
  expect422(
    [{ op: 'update', data: { type: 'sites', id: IDS.site, relationships: { address: { data: { type: 'addresses', id: IDS.addressB } } } } }],
    /does not belong to the target organisation/,
  );
  // the same ids are fine for organisation B as target
  const forB = build(
    [{ op: 'update', data: { type: 'sites', id: IDS.siteB, relationships: { address: { data: { type: 'addresses', id: IDS.addressB } } } } }],
    { reachable: reachableByOrganisation[URIS.orgB], target: organisations[IDS.orgB] },
  );
  assert.equal(forB.versions[0].masterUri, URIS.siteB);
  // references and relationships outside the aggregate only have to exist
  const { versions } = build([{ op: 'update', data: { type: 'administrative-units', id: IDS.org, relationships: { scope: { data: { type: 'locations', id: IDS.location } } } } }]);
  assert.deepEqual(objects(versions[0], `${NS.besluit}werkingsgebied`), [`<${URIS.location}>`]);
});

test('an organisation is only ever updated, and only the target itself', () => {
  expect422([{ op: 'delete', data: { type: 'administrative-units', id: IDS.org } }], /an organisation cannot be deleted through a change request; only "update" of the target is allowed/);
  assert.throws(() => build([{ op: 'delete', data: { type: 'administrative-units', id: IDS.org } }]), { pointer: '/data/attributes/operations/0/op' });
  expect422([{ op: 'create', data: { type: 'administrative-units', lid: 'o1', attributes: { name: 'Gemeente Nergens' } } }], /an organisation cannot be created through a change request/);
  expect422([{ op: 'create', data: { type: 'kbo-organizations', lid: 'k1' } }], /an organisation cannot be created/);
  expect422([{ op: 'update', data: { type: 'administrative-units', id: IDS.orgB, attributes: { name: 'pwned' } } }], new RegExp(`an organisation document must be the target of the request \\("${IDS.org}"\\)`));
  assert.throws(() => build([{ op: 'update', data: { type: 'organizations', id: IDS.abb, attributes: { name: 'pwned' } } }]), { pointer: '/data/attributes/operations/0/data/id' });
  const { versions } = build([{ op: 'update', data: { type: 'organizations', id: IDS.org, attributes: { name: 'Stad Aalst' } } }]);
  assert.equal(versions[0].masterUri, URIS.org);
});

test('a relationship outside the aggregate is kept for the unchanged check, refused on a create or with a lid', () => {
  const { versions } = build([
    { op: 'update', data: { type: 'administrative-units', id: IDS.org, relationships: { 'organization-status': { data: { type: 'organization-status-codes', id: IDS.statusCode } }, classification: { data: null } } } },
  ]);
  assert.deepEqual(versions[0].unchanged.map(({ name, objects }) => [name, objects]), [['organization-status', [URIS.statusCode]], ['classification', []]]);
  assert.deepEqual(versions[0].replaces, []);
  expect422(
    [{ op: 'create', data: { type: 'contact-points', lid: 'c1', relationships: { vendor: { data: { type: 'vendors', id: IDS.site } } } } }],
    model.has('vendors') ? /relationship "vendor" is not part of the aggregate "organization-core-data" and cannot be set on a new contact-points/ : /unknown relationship "vendor"/,
  );
  const created = build([{ op: 'create', data: { type: 'sites', lid: 's1', relationships: { 'site-type': { data: { type: 'site-types', id: IDS.siteType } } } } }]);
  assert.deepEqual(objects(created.versions[0], `${NS.ere}vestigingstype`), [`<${URIS.siteType}>`], 'a reference may be set on a create');
});

test('refuses lids that do not exist or point at the wrong type', () => {
  expect422(
    [{ op: 'update', data: { type: 'sites', id: IDS.site, relationships: { contacts: { data: [{ type: 'contact-points', lid: 'nope' }] } } } }],
    /refers to the unknown lid "nope"/,
  );
  expect422(
    [
      { op: 'create', data: { type: 'addresses', lid: 'a1', attributes: { street: 'x' } } },
      { op: 'update', data: { type: 'sites', id: IDS.site, relationships: { contacts: { data: [{ type: 'contact-points', lid: 'a1' }] } } } },
    ],
    /lid "a1" is a addresses/,
  );
});

test('refuses malformed operations', () => {
  expect422([], /must be a non-empty array/);
  expect422([{ op: 'patch', data: { type: 'sites', id: IDS.site } }], /"op" must be create, update or delete/);
  expect422([{ op: 'create', data: { type: 'sites', id: IDS.site, lid: 's' } }], /must not carry an id/);
  expect422([{ op: 'create', data: { type: 'sites' } }], /needs a "lid"/);
  expect422([{ op: 'create', data: { type: 'sites', lid: 's' } }, { op: 'create', data: { type: 'sites', lid: 's' } }], /duplicate lid "s"/);
  expect422([{ op: 'update', data: { type: 'sites' } }], /needs an id/);
  expect422([{ op: 'update', data: { type: 'sites', id: IDS.site, lid: 'x' } }], /only a create carries a lid/);
  expect422([{ op: 'update', data: { type: 'sites', id: IDS.site } }, { op: 'delete', data: { type: 'sites', id: IDS.site } }], /duplicate operation on id/);
  expect422(
    [{ op: 'update', data: { type: 'administrative-units', id: IDS.org, relationships: { sites: { data: { type: 'sites', id: IDS.site } } } } }],
    /cardinality many and needs an array/,
  );
  expect422(
    [{ op: 'update', data: { type: 'administrative-units', id: IDS.org, relationships: { 'primary-site': { data: [{ type: 'sites', id: IDS.site }] } } } }],
    /cardinality one and needs an object or null/,
  );
  expect422([{ op: 'update', data: { type: 'sites', id: IDS.site, relationships: { address: {} } } }], /must carry "data"/);
  expect422(
    [{ op: 'update', data: { type: 'administrative-units', id: IDS.org, attributes: { 'expected-end-date': 'someday' } } }],
    /attribute "expected-end-date" \(date\): expected a date/,
  );
  expect422(
    [{ op: 'update', data: { type: 'administrative-units', id: IDS.org, attributes: { 'alternative-name': 'Aalst' } } }],
    /attribute "alternative-name" \(string-set\): expected an array/,
  );
  expect422(
    [{ op: 'update', data: { type: 'addresses', id: IDS.address, attributes: { 'address-register-uri': 'https://x/a> . } } ; DROP ALL #' } } }],
    /attribute "address-register-uri" \(url\): a URI cannot contain/,
  );
});

test('the site aggregate admits its own types, the organisation as the target and its references', () => {
  const siteAggregate = config.aggregates.site;
  const buildSite = (ops) => buildVersions({ operations: ops, aggregateName: 'site', aggregate: siteAggregate, model, mintUuid: uuidSequence(), resources, reachable, target });
  const { versions, lids } = buildSite([
    { op: 'create', data: { type: 'addresses', lid: 'a1', attributes: { street: 'Grote Markt' } } },
    { op: 'create', data: { type: 'sites', lid: 's1', relationships: { address: { data: { type: 'addresses', lid: 'a1' } }, 'site-type': { data: { type: 'site-types', id: IDS.siteType } } } } },
    { op: 'update', data: { type: 'administrative-units', id: IDS.org, relationships: { sites: { data: [{ type: 'sites', id: IDS.site }, { type: 'sites', lid: 's1' }] } } } },
  ]);
  assert.deepEqual(lids, { a1: sequenceUuid(1), s1: sequenceUuid(2) });
  assert.deepEqual(objects(versions[1], `${NS.organisatie}bestaatUit`), [`<http://data.lblod.info/id/adressen/${sequenceUuid(1)}>`]);
  assert.deepEqual(objects(versions[1], `${NS.ere}vestigingstype`), [`<${URIS.siteType}>`]);
  assert.deepEqual(objects(versions[2], `${NS.org}hasSite`), [`<${URIS.site}>`, `<http://data.lblod.info/id/vestigingen/${sequenceUuid(2)}>`]);
  assert.deepEqual(versions[2].replaces, [`${NS.org}hasSite`]);
  assert.throws(() => buildSite([{ op: 'update', data: { type: 'administrative-units', id: IDS.orgB } }]), { status: 422, detail: /must be the target of the request/ });
  assert.throws(() => buildSite([{ op: 'update', data: { type: 'identifiers', id: IDS.kboIdentifier } }]), { status: 422, detail: /outside the aggregate "site"/ });
});

test('versionsFromStore rebuilds the versions of a request from the stored triples', () => {
  const { versions } = build();
  const uri = (value) => ({ type: 'uri', value });
  const literal = (value) => ({ type: 'literal', value });
  const bindings = [];
  for (const version of versions) {
    const row = (p, o) => bindings.push({ version: uri(version.uri), master: uri(version.masterUri), masterUuid: literal(version.masterUuid), type: literal(version.type), operation: literal(version.operation), p: uri(p), o });
    row(`${NS.rdf}type`, uri(`${NS.cr}Version`));
    row(`${NS.mu}uuid`, literal(version.uuid));
    row(`${NS.dct}isVersionOf`, uri(version.masterUri));
    row(`${NS.cr}masterUuid`, literal(version.masterUuid));
    row(`${NS.prov}generatedAtTime`, { type: 'typed-literal', datatype: `${NS.xsd}dateTime`, value: '2026-11-03T10:12:00Z' });
    row(`${NS.prov}wasGeneratedBy`, uri('http://data.lblod.info/id/change-requests/r1'));
    row(`${NS.cr}resourceType`, literal(version.type));
    row(`${NS.cr}operation`, literal(version.operation));
    if (version.deleted) row(`${NS.cr}deleted`, { type: 'typed-literal', datatype: `${NS.xsd}boolean`, value: 'true' });
    for (const predicate of version.replaces) row(`${NS.cr}replaces`, uri(predicate));
    for (const triple of version.triples) {
      const object = triple.object.startsWith('<') ? uri(triple.object.slice(1, -1)) : literal(triple.object.slice(3, -3).replace(/\\(["\\])/g, '$1'));
      row(triple.predicate, object);
    }
  }
  const rebuilt = versionsFromStore({ results: { bindings } }, model);
  const comparable = (list) => list.map(({ lid, ...version }) => ({ ...version, triples: [...version.triples].sort((a, b) => (a.predicate + a.object).localeCompare(b.predicate + b.object)), unchanged: [] })).sort((a, b) => a.uri.localeCompare(b.uri));
  assert.deepEqual(comparable(rebuilt), comparable(versions));
  assert.deepEqual(versionsFromStore({ results: { bindings: [] } }, model), []);
});
