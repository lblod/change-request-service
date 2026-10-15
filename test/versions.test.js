import { test } from 'node:test';
import assert from 'node:assert/strict';
import { model, config, operations, resources, reachable, reachableByOrganisation, organisations, target, masterState, currentMap, incomingMap, IDS, URIS, NS, uri, literal, typed, uuidSequence, sequenceUuid, testUuid } from './support/fixtures.js';
import { OPERATION } from '../constants.js';
import {
  buildVersions,
  collectReferences,
  collectBaseReferences,
  carriedPairs,
  incomingPairs,
  settleVersions,
  planStored,
  mergeSet,
  aggregatePredicates,
  pathPredicates,
  isTypeInAggregate,
  isTargetInAggregate,
  isReferenceType,
  versionsFromStore,
  replacedStates,
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
  assert.ok(versions.every((v) => v.uri === `http://data.lblod.info/id/proposed-versions/${v.uuid}`));

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
  assert.deepEqual(tombstone.replaces, [], 'settleVersions sets it to every key of the type');
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
    const row = (p, o) => bindings.push({ version: uri(version.uri), master: uri(version.masterUri), masterUuid: literal(version.masterUuid), type: literal(version.type), operation: uri(OPERATION[version.operation]), p: uri(p), o });
    row(`${NS.rdf}type`, uri(`${NS.cr}ProposedVersion`));
    row(`${NS.mu}uuid`, literal(version.uuid));
    row(`${NS.dct}isVersionOf`, uri(version.masterUri));
    row(`${NS.cr}masterUuid`, literal(version.masterUuid));
    row(`${NS.prov}generatedAtTime`, { type: 'typed-literal', datatype: `${NS.xsd}dateTime`, value: '2026-11-03T10:12:00Z' });
    row(`${NS.cr}resourceType`, literal(version.type));
    row(`${NS.cr}operation`, uri(OPERATION[version.operation]));
    for (const predicate of version.replaces) row(`${NS.cr}changesProperty`, uri(predicate));
    for (const triple of version.triples) {
      const object = triple.object.startsWith('<') ? uri(triple.object.slice(1, -1)) : literal(triple.object.slice(3, -3).replace(/\\(["\\])/g, '$1'));
      row(triple.predicate, object);
    }
  }
  const rebuilt = versionsFromStore({ results: { bindings } }, model);
  // what the apply needs; keys and unchanged are the submission's, base states come with settleVersions
  const comparable = (list) =>
    list
      .map(({ uri: versionUri, uuid, type, classUris, masterUri, masterUuid, operation, deleted, replaces, triples }) => ({
        uri: versionUri, uuid, type, classUris, masterUri, masterUuid, operation, deleted, replaces,
        triples: [...triples].sort((a, b) => (a.predicate + a.object).localeCompare(b.predicate + b.object)),
      }))
      .sort((a, b) => a.uri.localeCompare(b.uri));
  assert.deepEqual(comparable(rebuilt), comparable(versions));
  assert.ok(rebuilt.every((version) => version.base === null && version.requestUri === null), 'no base rows, no request column');
  assert.deepEqual(versionsFromStore({ results: { bindings: [] } }, model), []);
  const unknown = bindings.slice(0, 1).map((binding) => ({ ...binding, operation: uri(`${NS.as}Move`) }));
  assert.throws(() => versionsFromStore({ results: { bindings: unknown } }, model), /unknown cr:operation/);
});

test('collectBaseReferences gathers the ids of the base relationships', () => {
  assert.deepEqual(collectBaseReferences(operations), [IDS.oldContact]);
  assert.deepEqual(collectBaseReferences(null), []);
});

test('an update records every carried key with its proposal and, when meta.base carries it, its base', () => {
  const { versions } = build();
  const [address, contact, site, , org, tombstone] = versions;
  assert.deepEqual(org.keys.find((key) => key.name === 'name'), {
    name: 'name',
    kind: 'attribute',
    predicate: `${NS.skos}prefLabel`,
    attributeType: 'string',
    objects: ['"""Stad Aalst"""'],
    proposed: ['Stad Aalst'],
    base: { objects: ['"""Aalst"""'], items: ['Aalst'] },
    where: '/data/attributes/operations/4/data/attributes/name',
  });
  assert.deepEqual(org.keys.map((key) => key.name), ['name', 'alternative-name', 'legal-name', 'expected-end-date', 'purpose', 'primary-site', 'sites', 'identifiers', 'scope'], 'attributes, then the admitted relationships; classification is an unchanged check, memberships inverse');
  const contacts = site.keys.find((key) => key.name === 'contacts');
  assert.deepEqual(contacts.base, { objects: [`<${URIS.oldContact}>`], items: [URIS.oldContact] });
  assert.deepEqual(contacts.proposed, [contact.masterUri], 'the proposal points at the minted master of the lid');
  assert.equal(address.keys.length, 10);
  assert.ok(address.keys.every((key) => key.base === undefined), 'the address carries no base');
  assert.deepEqual(contact.keys, [], 'a create has nothing to settle');
  // a delete removes every key of its type: one per attribute and non-inverse relationship, none proposed
  const expected = [
    ...[...model.attributes('contact-points').values()].map((attribute) => attribute.predicate),
    ...[...model.relationships('contact-points').values()].filter((relationship) => !relationship.inverse).map((relationship) => relationship.predicate),
  ];
  assert.deepEqual(tombstone.keys.map((key) => key.predicate), [...new Set(expected)]);
  assert.ok(tombstone.keys.every((key) => key.proposed.length === 0 && key.objects.length === 0 && key.base === undefined), 'nothing proposed, no base sent');
});

test('a delete may carry meta.base: the record as the page loaded it, keys of its type that fit their datatypes', () => {
  const remove = (base) => [{ op: 'delete', data: { type: 'contact-points', id: IDS.oldContact, meta: { base } } }];
  const [tombstone] = build(remove({ attributes: { email: 'e0@aalst.be', fax: null }, relationships: { 'contact-address': { data: { type: 'addresses', id: IDS.address } } } })).versions;
  const key = (name) => tombstone.keys.find((candidate) => candidate.name === name);
  assert.deepEqual(key('email').base, { objects: ['"""e0@aalst.be"""'], items: ['e0@aalst.be'] });
  assert.deepEqual(key('fax').base, { objects: [], items: [] });
  assert.deepEqual(key('contact-address').base, { objects: [`<${URIS.address}>`], items: [URIS.address] });
  assert.equal(key('telephone').base, undefined, 'a key the base does not carry starts from the current value');
  expect422(remove({ attributes: { colour: 'red' } }), 'unknown attribute "colour" for type "contact-points"');
  expect422(remove({ relationships: { owner: { data: null } } }), 'unknown relationship "owner" for type "contact-points"');
  assert.throws(() => build(remove({ attributes: { 'harvest-date': 'yesterday' } })), { status: 422, pointer: '/data/attributes/operations/0/data/meta/base/attributes/harvest-date' });
  expect422(remove({ relationships: { 'contact-address': { data: { type: 'addresses', lid: 'a1' } } } }), /cannot refer to a lid/);
  expect422(remove('x'), /"meta.base" must be an object/);
});

test('meta.base is only for an update or a delete, must be well-formed and fit the datatypes; its ids only have to be known', () => {
  const update = (meta) => [
    {
      op: 'update',
      data: {
        type: 'administrative-units',
        id: IDS.org,
        attributes: { name: 'x', 'expected-end-date': null },
        relationships: { 'primary-site': { data: { type: 'sites', id: IDS.site } }, sites: { data: [] }, classification: { data: { type: 'administrative-unit-classification-codes', id: IDS.gemeenteCode } } },
        meta,
      },
    },
  ];
  expect422([{ op: 'create', data: { type: 'contact-points', lid: 'c1', meta: { base: {} } } }], /only an update or a delete carries meta.base; a create has no values to start from/);
  expect422(update('base'), /"meta" must be an object/);
  expect422(update({ base: [] }), /"meta.base" must be an object/);
  expect422(update({ base: { attributes: 'name' } }), /"meta.base.attributes" must be an object/);
  assert.throws(() => build(update({ base: { attributes: { 'expected-end-date': 'someday' } } })), {
    status: 422,
    detail: /meta.base of attribute "expected-end-date" \(date\): expected a date/,
    pointer: '/data/attributes/operations/0/data/meta/base/attributes/expected-end-date',
  });
  expect422(update({ base: { relationships: { sites: { data: { type: 'sites', id: IDS.site } } } } }), /meta.base of relationship "sites" has cardinality many and needs an array/);
  expect422(update({ base: { relationships: { 'primary-site': { data: { type: 'addresses', id: IDS.address } } } } }), /meta.base of relationship "primary-site" expects sites, got addresses/);
  expect422(update({ base: { relationships: { 'primary-site': { data: { type: 'sites', lid: 's1' } } } } }), /cannot refer to a lid/);
  assert.throws(() => build(update({ base: { relationships: { 'primary-site': { data: { type: 'sites', id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } } } } })), {
    status: 422,
    detail: 'meta.base of relationship "primary-site" refers to "ffffffff-ffff-4fff-8fff-ffffffffffff", which is not a known record',
    pointer: '/data/attributes/operations/0/data/meta/base/relationships/primary-site/data',
  });
  // a record that is gone (known from its versions) or of another organisation: compared, never linked
  const gone = 'd0d0d0d0-0000-4000-8000-000000000001';
  const goneUri = `http://data.lblod.info/id/vestigingen/${gone}`;
  const { versions } = build(
    update({ base: { relationships: { 'primary-site': { data: { type: 'sites', id: gone } }, sites: { data: [{ type: 'sites', id: IDS.siteB }] }, classification: { data: null } } } }),
    { former: new Map([[gone, goneUri]]) },
  );
  assert.deepEqual(versions[0].keys.find((key) => key.name === 'primary-site').base.items, [goneUri]);
  assert.deepEqual(versions[0].keys.find((key) => key.name === 'sites').base.items, [URIS.siteB]);
  assert.deepEqual(versions[0].unchanged[0].base, { uris: [] }, 'the unchanged check keeps its base too');
  assert.equal(build(update({ base: { attributes: { purpose: 'x' } } })).versions[0].keys.find((key) => key.name === 'purpose'), undefined, 'a base for a key the document does not carry is ignored');
});

// settleVersions: the base rule against what the masters hold (masterState: the organisation is called "Aalst")
const settle = (ops, state = masterState()) =>
  settleVersions({ versions: build(ops).versions, current: currentMap(state), incoming: incomingMap(state), model, aggregateName: 'organization-core-data', mintUuid: uuidSequence() });
const orgUpdate = (attributes, base) => [
  { op: 'update', data: { type: 'administrative-units', id: IDS.org, attributes, ...(base ? { meta: { base: { attributes: base } } } : {}) } },
];
const withState = (changes) => ({ ...masterState(), ...changes });
const prefLabel = (value) => ({ [`${URIS.org} ${NS.skos}prefLabel`]: [literal(value)] });

test('B, P = B: a key the user did not change is not written, so it does not undo a change made since', () => {
  const { versions, conflicts } = settle(orgUpdate({ name: 'Aalst' }, { name: 'Aalst' }), withState(prefLabel('Aalst (ABB)')));
  assert.deepEqual(versions, [], 'the update changes nothing and leaves no version');
  assert.deepEqual(conflicts, []);
});

test('B, P ≠ B and C = B: the key is written and the base state holds the value it started from', () => {
  const { versions, conflicts } = settle(orgUpdate({ name: 'Stad Aalst' }, { name: 'Aalst' }));
  assert.equal(versions.length, 1);
  assert.deepEqual(versions[0].replaces, [`${NS.skos}prefLabel`]);
  assert.deepEqual(versions[0].triples, [{ predicate: `${NS.skos}prefLabel`, object: '"""Stad Aalst"""' }]);
  assert.deepEqual(versions[0].base, {
    uri: `http://data.lblod.info/id/record-states/${sequenceUuid(1)}`,
    uuid: sequenceUuid(1),
    masterUri: URIS.org,
    triples: [{ predicate: `${NS.skos}prefLabel`, object: '"""Aalst"""' }],
  });
  assert.deepEqual(conflicts, []);
});

test('B, P ≠ B and C = P: someone already made the same change: not written, no conflict', () => {
  const { versions, conflicts } = settle(orgUpdate({ name: 'Stad Aalst' }, { name: 'Aalst' }), withState(prefLabel('Stad Aalst')));
  assert.deepEqual(versions, []);
  assert.deepEqual(conflicts, []);
});

test('B, P ≠ B and C ∉ {B, P}: a conflict; the key stays in the version with its base', () => {
  const { versions, conflicts } = settle(orgUpdate({ name: 'Aalst (A)' }, { name: 'Aalst' }), withState(prefLabel('Aalst (ABB)')));
  assert.deepEqual(versions[0].replaces, [`${NS.skos}prefLabel`]);
  assert.deepEqual(versions[0].triples, [{ predicate: `${NS.skos}prefLabel`, object: '"""Aalst (A)"""' }]);
  assert.deepEqual(versions[0].base.triples, [{ predicate: `${NS.skos}prefLabel`, object: '"""Aalst"""' }]);
  assert.equal(conflicts.length, 1);
  const [conflict] = conflicts;
  assert.equal(conflict.version.masterUri, URIS.org);
  assert.equal(conflict.key.name, 'name');
  assert.deepEqual([conflict.base, conflict.current, conflict.proposed], [['Aalst'], ['Aalst (ABB)'], ['Aalst (A)']]);
});

test('a key without a client base starts from the current value: written when it differs, never a conflict', () => {
  assert.deepEqual(settle(orgUpdate({ name: 'Aalst' })).versions, [], 'equal to the current value: nothing to write');
  const { versions, conflicts } = settle(orgUpdate({ name: 'Stad Aalst' }), withState(prefLabel('Aalst (ABB)')));
  assert.deepEqual(versions[0].triples, [{ predicate: `${NS.skos}prefLabel`, object: '"""Stad Aalst"""' }]);
  assert.deepEqual(versions[0].base.triples, [{ predicate: `${NS.skos}prefLabel`, object: '"""Aalst (ABB)"""' }], 'the base is the value the server held');
  assert.deepEqual(conflicts, []);
});

test('the stale form: a carried unchanged name keeps the newer name, the changed attribute is written', () => {
  const { versions, conflicts } = settle(orgUpdate({ name: 'Aalst', 'legal-name': 'Stad Aalst' }, { name: 'Aalst', 'legal-name': null }), withState(prefLabel('Aalst (ABB)')));
  assert.deepEqual(versions[0].replaces, [`${NS.regorg}legalName`]);
  assert.deepEqual(versions[0].triples, [{ predicate: `${NS.regorg}legalName`, object: '"""Stad Aalst"""' }]);
  assert.deepEqual(versions[0].base.triples, [], 'the legal name was empty: no base triple');
  assert.deepEqual(conflicts, []);
});

test('a set key merges: what the user added and removed is applied to what the master holds now, so changes made since stay; it never conflicts', () => {
  const other = 'http://data.lblod.info/id/vestigingen/e5e5e5e5-0000-4000-8000-000000000001';
  const sites = (data, base) => [{ op: 'update', data: { type: 'administrative-units', id: IDS.org, relationships: { sites: { data } }, meta: { base: { relationships: { sites: { data: base } } } } } }];
  // the page loaded [site] and added n1; meanwhile another site was linked
  const state = { ...masterState(), [`${URIS.org} ${NS.org}hasSite`]: [uri(URIS.site), uri(other)] };
  const added = build([{ op: 'create', data: { type: 'sites', lid: 'n1' } }, ...sites([{ type: 'sites', id: IDS.site }, { type: 'sites', lid: 'n1' }], [{ type: 'sites', id: IDS.site }])]);
  const n1 = added.versions[0].masterUri;
  const { versions, conflicts } = settleVersions({ versions: added.versions, current: currentMap(state), incoming: incomingMap(state), model, aggregateName: 'organization-core-data', mintUuid: uuidSequence() });
  assert.deepEqual(conflicts, []);
  const org = versions[1];
  assert.deepEqual(org.replaces, [`${NS.org}hasSite`]);
  assert.deepEqual(org.apply, { replace: [], remove: [], insert: [{ predicate: `${NS.org}hasSite`, object: `<${n1}>` }] }, 'only the addition: the other site stays');
  assert.deepEqual(org.triples.map((triple) => triple.object), [`<${URIS.site}>`, `<${n1}>`], 'the version keeps the proposal');
  assert.deepEqual(org.base.triples.map((triple) => triple.object), [`<${URIS.site}>`], 'and the base, so the change can be merged again later');
  // removing the site the page loaded leaves the other one
  const removed = settle(sites([], [{ type: 'sites', id: IDS.site }]), state);
  assert.deepEqual(removed.versions[0].apply, { replace: [], remove: [{ predicate: `${NS.org}hasSite`, object: `<${URIS.site}>` }], insert: [] });
  // someone already removed it: nothing to write
  assert.deepEqual(settle(sites([], [{ type: 'sites', id: IDS.site }]), { ...masterState(), [`${URIS.org} ${NS.org}hasSite`]: [uri(other)] }).versions, []);
  // a set attribute merges the same way, by value
  const altState = { ...masterState(), [`${URIS.org} ${NS.skos}altLabel`]: [literal('Aalst'), literal('Stad Aalst')] };
  const renamed = settle([{ op: 'update', data: { type: 'administrative-units', id: IDS.org, attributes: { 'alternative-name': ['Aalst', 'Oilsjt'] }, meta: { base: { attributes: { 'alternative-name': ['Aalst'] } } } } }], altState);
  assert.deepEqual(renamed.versions[0].apply, { replace: [], remove: [], insert: [{ predicate: `${NS.skos}altLabel`, object: '"""Oilsjt"""' }] });
  assert.deepEqual(renamed.conflicts, []);
});

test('mergeSet removes the current terms of what the base had and the proposal drops, and inserts what the master lacks', () => {
  const key = { name: 'alternative-name', kind: 'attribute', predicate: `${NS.skos}altLabel`, attributeType: 'string-set' };
  const current = [literal('Aalst', 'nl'), literal('Stad Aalst')];
  assert.deepEqual(mergeSet({ key, proposed: ['Oilsjt'], proposedObjects: ['"""Oilsjt"""'], base: ['Aalst'], currentBindings: current }), {
    remove: ['"""Aalst"""@nl'],
    insert: ['"""Oilsjt"""'],
  }, 'the stored term is deleted as it is, language tag included');
  assert.deepEqual(mergeSet({ key, proposed: ['Aalst', 'Stad Aalst'], proposedObjects: ['"""Aalst"""', '"""Stad Aalst"""'], base: ['Aalst'], currentBindings: current }), { remove: [], insert: [] }, 'already there');
});

test('planStored plans the apply of stored versions against the current values, as settleVersions does', () => {
  const baseUri = `http://data.lblod.info/id/record-states/${testUuid('state', 1)}`;
  const row = (p, o, base) => ({ request: uri(`http://data.lblod.info/id/change-requests/${testUuid('request', 1)}`), version: uri(`http://data.lblod.info/id/proposed-versions/${testUuid('version', 1)}`), master: uri(URIS.org), masterUuid: literal(IDS.org), type: literal('administrative-units'), operation: uri(OPERATION.update), p: uri(p), o, ...(base ? { base: uri(baseUri) } : {}) });
  const n1 = `http://data.lblod.info/id/vestigingen/${testUuid('version', 91)}`;
  const other = `http://data.lblod.info/id/vestigingen/${testUuid('version', 92)}`;
  const stored = versionsFromStore({ results: { bindings: [
    row(`${NS.cr}changesProperty`, uri(`${NS.org}hasSite`)),
    row(`${NS.cr}changesProperty`, uri(`${NS.skos}prefLabel`)),
    row(`${NS.cr}base`, uri(baseUri)),
    row(`${NS.rdf}type`, uri(`${NS.cr}RecordState`), true),
    row(`${NS.dct}isVersionOf`, uri(URIS.org), true),
    row(`${NS.org}hasSite`, uri(URIS.site)),
    row(`${NS.org}hasSite`, uri(n1)),
    row(`${NS.skos}prefLabel`, literal('Stad Aalst')),
    row(`${NS.org}hasSite`, uri(URIS.site), true),
    row(`${NS.skos}prefLabel`, literal('Aalst'), true),
  ] } }, model);
  const [planned] = planStored(stored, currentMap({ ...masterState(), [`${URIS.org} ${NS.org}hasSite`]: [uri(URIS.site), uri(other)] }), model);
  assert.deepEqual(planned.apply, {
    replace: [`${NS.skos}prefLabel`],
    remove: [],
    insert: [{ predicate: `${NS.skos}prefLabel`, object: '"""Stad Aalst"""' }, { predicate: `${NS.org}hasSite`, object: `<${n1}>` }],
  });
  // an update without a base state (which the service does not write) replaces what it lists
  const baseless = { ...stored[0], base: null };
  assert.deepEqual(planStored([baseless], currentMap(), model)[0].apply, { replace: baseless.replaces, remove: [], insert: baseless.triples });
});

test('values compare under their datatype and sets as sets', () => {
  const state = withState({
    [`${URIS.org} ${NS.skos}altLabel`]: [literal('Stad Aalst'), literal('Aalst')],
    [`${URIS.org} ${NS.lblodgeneriek}geplandeEindDatum`]: [typed('2030-12-31', 'date')],
  });
  assert.deepEqual(settle(orgUpdate({ 'alternative-name': ['Aalst', 'Stad Aalst'], 'expected-end-date': '2030-12-31' }), state).versions, [], 'reordered set, same date');
  assert.deepEqual(settle(orgUpdate({ 'alternative-name': ['Aalst'] }), state).versions[0].replaces, [`${NS.skos}altLabel`], 'a member less is a change');
  const sites = (data, base) => [{ op: 'update', data: { type: 'administrative-units', id: IDS.org, relationships: { sites: { data } }, ...(base ? { meta: { base: { relationships: { sites: { data: base } } } } } : {}) } }];
  assert.deepEqual(settle(sites([{ type: 'sites', id: IDS.site }])).versions, [], 'the same sites');
  assert.deepEqual(settle(sites([], [{ type: 'sites', id: IDS.site }])).versions[0].replaces, [`${NS.org}hasSite`], 'unlinking the site');
});

test('an update that changes nothing leaves no version; creates and deletes stay', () => {
  const { versions } = settle([
    { op: 'update', data: { type: 'structured-identifiers', id: IDS.structuredKbo, attributes: { 'local-id': '0207437468' } } },
    { op: 'create', data: { type: 'contact-points', lid: 'c1', attributes: { email: 'info@aalst.be' } } },
    { op: 'delete', data: { type: 'contact-points', id: IDS.oldContact } },
  ]);
  assert.deepEqual(versions.map((version) => version.operation), ['create', 'delete']);
  assert.equal(versions[0].base, undefined, 'a create has no base state');
});

test('a tombstone starts from what the record holds: a base state of every key with the links that point at it; nothing to conflict without a client base', () => {
  const state = { ...masterState(), [`${URIS.oldContact} ${NS.schema}email`]: [literal('e1@aalst.be')] };
  const { versions, conflicts } = settle([{ op: 'delete', data: { type: 'contact-points', id: IDS.oldContact } }], state);
  assert.deepEqual(conflicts, []);
  const [tombstone] = versions;
  assert.deepEqual(tombstone.replaces, [...new Set(tombstone.keys.map((key) => key.predicate))].sort(), 'every key of its type');
  assert.deepEqual(tombstone.base, {
    uri: `http://data.lblod.info/id/record-states/${sequenceUuid(1)}`,
    uuid: sequenceUuid(1),
    masterUri: URIS.oldContact,
    triples: [{ predicate: `${NS.schema}email`, object: '"""e1@aalst.be"""' }],
    links: [{ uri: `http://data.lblod.info/id/record-links/${sequenceUuid(2)}`, uuid: sequenceUuid(2), subject: URIS.site, predicate: `${NS.org}siteAddress` }],
  });
  assert.equal(tombstone.incoming, undefined);
  assert.deepEqual(incomingPairs(build([{ op: 'delete', data: { type: 'contact-points', id: IDS.oldContact } }]).versions, model), model.incomingPredicates('contact-points').map((predicate) => ({ object: URIS.oldContact, predicate })));
  assert.deepEqual([...tombstone.proposals.values()].every(({ proposed, deleted }) => proposed.length === 0 && deleted), true);
});

test('a delete from a stale form conflicts where the record holds a value its base did not have: changed or set since; cleared since is no conflict', () => {
  const state = { ...masterState(), [`${URIS.oldContact} ${NS.schema}email`]: [literal('e1@aalst.be')], [`${URIS.oldContact} ${NS.schema}telephone`]: [literal('053')] };
  const ops = [{ op: 'delete', data: { type: 'contact-points', id: IDS.oldContact, meta: { base: { attributes: { email: 'e0@aalst.be', telephone: null, fax: '054' } } } } }];
  const { versions, conflicts } = settle(ops, state);
  assert.deepEqual(conflicts.map(({ key, base, current, proposed }) => [key.name, base, current, proposed]), [
    ['email', ['e0@aalst.be'], ['e1@aalst.be'], []],
    ['telephone', [], ['053'], []],
  ], 'the fax was cleared since: what the delete does anyway');
  assert.ok(versions[0].base.triples.some(({ predicate, object }) => predicate === `${NS.schema}email` && object === '"""e0@aalst.be"""'), 'the base is what the page loaded');
});

test('a relationship outside the aggregate may be carried as loaded or as the master holds it, never changed', () => {
  const classification = (data, base) => [
    { op: 'update', data: { type: 'administrative-units', id: IDS.org, relationships: { classification: { data } }, ...(base !== undefined ? { meta: { base: { relationships: { classification: { data: base } } } } } : {}) } },
  ];
  const code = { type: 'administrative-unit-classification-codes', id: IDS.gemeenteCode };
  const reclassified = withState({ [`${URIS.org} ${NS.org}classification`]: [uri('http://data.vlaanderen.be/id/concept/BestuurseenheidClassificatieCode/other')] });
  assert.deepEqual(settle(classification(code, code), reclassified).versions, [], 'stale but unchanged: not written, not refused');
  assert.deepEqual(settle(classification(code)).versions, [], 'without base: equal to the master');
  assert.throws(() => settle(classification(code), reclassified), { status: 422, detail: /relationship "classification" is not part of the aggregate/ });
  assert.throws(() => settle(classification(null, code)), { status: 422, pointer: '/data/attributes/operations/0/data/relationships/classification' });
});

test('the fixture request against the current state: what each version still writes, and its base', () => {
  const { versions, conflicts } = settle(operations);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(versions.map((version) => [version.type, version.operation]), [
    ['addresses', 'update'],
    ['contact-points', 'create'],
    ['sites', 'update'],
    ['administrative-units', 'update'],
    ['contact-points', 'delete'],
  ], 'the structured identifier changes nothing');
  const [address, , site, org] = versions;
  assert.deepEqual(address.replaces, [`${NS.locn}fullAddress`, `${NS.adres}Adresvoorstelling.huisnummer`, `${NS.adres}verwijstNaar`].sort());
  assert.deepEqual(address.base.triples, [
    { predicate: `${NS.adres}Adresvoorstelling.huisnummer`, object: '"""1"""' },
    { predicate: `${NS.locn}fullAddress`, object: '"""Grote Markt 1, 9300 Aalst, België"""' },
    { predicate: `${NS.adres}verwijstNaar`, object: '<https://data.vlaanderen.be/id/adres/123455>' },
  ]);
  assert.deepEqual(site.replaces, [`${NS.ere}vestigingstype`, `${NS.org}siteAddress`].sort());
  assert.deepEqual(site.base.triples, [{ predicate: `${NS.org}siteAddress`, object: `<${URIS.oldContact}>` }], 'the client base of contacts; no site type before');
  assert.deepEqual(org.replaces, [`${NS.besluit}werkingsgebied`, `${NS.skos}prefLabel`, `${NS.org}hasSite`].sort());
  assert.deepEqual(org.triples, [{ predicate: `${NS.skos}prefLabel`, object: '"""Stad Aalst"""' }], 'sites and scope are cleared');
  assert.deepEqual(org.base.triples, [
    { predicate: `${NS.skos}prefLabel`, object: '"""Aalst"""' },
    { predicate: `${NS.org}hasSite`, object: `<${URIS.site}>` },
    { predicate: `${NS.besluit}werkingsgebied`, object: `<${URIS.location}>` },
  ]);
  assert.deepEqual(carriedPairs(build().versions).filter(({ subject }) => subject === URIS.structuredKbo), [{ subject: URIS.structuredKbo, predicate: `${NS.generiek}lokaleIdentificator` }]);
  assert.ok(carriedPairs(build().versions).some(({ subject, predicate }) => subject === URIS.org && predicate === `${NS.org}classification`), 'the unchanged checks are read too');
});

test('versionsFromStore reads the base state, the request of each version and a harvest-source value', () => {
  const bindings = [];
  const requestUri = `http://data.lblod.info/id/change-requests/${testUuid('request', 1)}`;
  const versionUri = `http://data.lblod.info/id/proposed-versions/${testUuid('version', 1)}`;
  const baseUri = `http://data.lblod.info/id/record-states/${testUuid('state', 1)}`;
  const row = (p, o, base) =>
    bindings.push({
      request: uri(requestUri),
      version: uri(versionUri),
      master: uri(URIS.address),
      masterUuid: literal(IDS.address),
      type: literal('addresses'),
      operation: uri(OPERATION.update),
      p: uri(p),
      o,
      ...(base ? { base: uri(base) } : {}),
    });
  row(`${NS.rdf}type`, uri(`${NS.cr}ProposedVersion`));
  row(`${NS.mu}uuid`, literal(testUuid('version', 1)));
  row(`${NS.cr}base`, uri(baseUri));
  row(`${NS.cr}changesProperty`, uri(`${NS.locn}thoroughfare`));
  row(`${NS.cr}changesProperty`, uri(`${NS.adres}Adresvoorstelling.busnummer`));
  row(`${NS.cr}changesProperty`, uri(`${NS.prov}wasGeneratedBy`));
  row(`${NS.locn}thoroughfare`, literal('Nieuwe straat'));
  row(`${NS.prov}wasGeneratedBy`, literal('harvest 12'));
  row(`${NS.rdf}type`, uri(`${NS.cr}RecordState`), baseUri);
  row(`${NS.mu}uuid`, literal(testUuid('state', 1)), baseUri);
  row(`${NS.dct}isVersionOf`, uri(URIS.address), baseUri);
  row(`${NS.locn}thoroughfare`, literal('Oude straat'), baseUri);
  row(`${NS.adres}Adresvoorstelling.busnummer`, literal('A'), baseUri);
  const [version] = versionsFromStore({ results: { bindings } }, model);
  assert.equal(version.requestUri, requestUri);
  assert.equal(version.uuid, testUuid('version', 1));
  assert.deepEqual(version.replaces, [`${NS.locn}thoroughfare`, `${NS.prov}wasGeneratedBy`, `${NS.adres}Adresvoorstelling.busnummer`].sort());
  assert.deepEqual(version.triples, [
    { predicate: `${NS.locn}thoroughfare`, object: '"""Nieuwe straat"""' },
    { predicate: `${NS.prov}wasGeneratedBy`, object: '"""harvest 12"""' },
  ], 'prov:wasGeneratedBy, the harvest source of an address, is a value');
  assert.equal(version.base.uri, baseUri);
  assert.equal(version.base.masterUri, URIS.address);
  assert.deepEqual([...version.base.terms.keys()], [`${NS.locn}thoroughfare`, `${NS.adres}Adresvoorstelling.busnummer`]);
  assert.deepEqual(version.base.links, [], 'an update remembers no links');
  assert.deepEqual(version.terms.get(`${NS.locn}thoroughfare`), [literal('Nieuwe straat')]);
});

test('replacedStates: what the masters held, for the keys the versions change, and what linked to a deleted record; nothing before a create', () => {
  const state = { ...masterState(), [`${URIS.org} ${NS.skos}prefLabel`]: [literal('Aalst (ABB)')], [`${URIS.oldContact} ${NS.schema}email`]: [literal('e1@aalst.be')] };
  const { versions } = settle(
    [
      ...orgUpdate({ name: 'Stad Aalst' }, { name: 'Aalst' }),
      { op: 'create', data: { type: 'contact-points', lid: 'c1', attributes: { email: 'info@aalst.be' } } },
      { op: 'delete', data: { type: 'contact-points', id: IDS.oldContact } },
    ],
    state,
  );
  const mintUuid = uuidSequence();
  const states = replacedStates({ versions, current: currentMap(state), incoming: incomingMap(state), model, mintUuid });
  assert.deepEqual(states.map((replaced) => replaced.masterUri), [URIS.org, URIS.oldContact], 'no state before the create');
  assert.deepEqual(states[0], {
    uri: `http://data.lblod.info/id/record-states/${sequenceUuid(1)}`,
    uuid: sequenceUuid(1),
    masterUri: URIS.org,
    triples: [{ predicate: `${NS.skos}prefLabel`, object: '"""Aalst (ABB)"""' }],
  }, 'the name the approval overwrote, not the one the form started from');
  assert.deepEqual(states[1].triples, [{ predicate: `${NS.schema}email`, object: '"""e1@aalst.be"""' }]);
  assert.deepEqual(states[1].links, [{ uri: `http://data.lblod.info/id/record-links/${sequenceUuid(3)}`, uuid: sequenceUuid(3), subject: URIS.site, predicate: `${NS.org}siteAddress` }]);
  const gone = replacedStates({ versions, current: currentMap(state), incoming: incomingMap(state), model, mintUuid: uuidSequence(), present: (version) => version.masterUri !== URIS.oldContact });
  assert.deepEqual(gone.map((replaced) => replaced.masterUri), [URIS.org], 'no state for a record that is gone');
});
