import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../lib/change-requests.js';
import { STATUS } from '../constants.js';
import { model, config, resources, organisations, reachableByOrganisation, masterObjects, sessions, body, operations, IDS, URIS, NS, NOW, APPLIED_AT, uuidSequence, sequenceUuid } from './support/fixtures.js';

const bindings = (list) => ({
  results: {
    bindings: list.map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value != null).map(([key, value]) => [key, typeof value === 'object' ? value : { value }]))),
  },
});

/**
 * A stand-in for the triplestore that answers the service's lookups from the fixtures.
 * failApply: how many apply attempts fail before one succeeds.
 */
function fakeDb({ failApply = 0, requests = [], storedVersions = [], laterApplied = [] } = {}) {
  const updates = [];
  const queries = [];
  let applyAttempts = 0;
  return {
    updates,
    queries,
    get applyAttempts() {
      return applyAttempts;
    },
    async query(q) {
      queries.push(q);
      if (q.includes('SELECT ?uri ?type ?classification')) {
        const uuid = q.match(/mu:uuid """([^"]+)"""/)[1];
        const organisation = organisations[uuid];
        if (!organisation) return bindings([]);
        return bindings(organisation.classes.map((type) => ({ uri: organisation.uri, type, classification: organisation.classification })));
      }
      if (q.includes('SELECT ?uuid ?uri ?type')) {
        const ids = [...q.matchAll(/"""([^"]+)"""/g)].map((m) => m[1]);
        return bindings(ids.flatMap((uuid) => (resources.has(uuid) ? resources.get(uuid).classes.map((type) => ({ uuid, uri: resources.get(uuid).uri, type })) : [])));
      }
      if (q.includes('SELECT DISTINCT ?resource')) {
        const targetUri = q.match(/\n {2}<([^>]+)> \(/)[1];
        return bindings([...(reachableByOrganisation[targetUri] || [])].filter((uri) => uri !== targetUri).map((resource) => ({ resource })));
      }
      if (q.includes('SELECT ?s ?p ?o')) {
        const pairs = [...q.matchAll(/\(<([^>]+)> <([^>]+)>\)/g)].map((m) => [m[1], m[2]]);
        return bindings(pairs.flatMap(([s, p]) => (masterObjects[`${s} ${p}`] || []).map((o) => ({ s, p, o }))));
      }
      if (q.includes('SELECT DISTINCT ?request')) {
        const uuid = q.match(/\?request mu:uuid """([^"]+)"""/)?.[1];
        const visibleTo = q.match(/FILTER\(\?target = <([^>]+)> \|\| /)?.[1];
        return bindings(requests.filter((r) => (!uuid || r.uuid === uuid) && (!visibleTo || r.target === visibleTo || r.requestingOrganisation === visibleTo)));
      }
      if (q.includes('SELECT ?version ?master')) return { results: { bindings: storedVersions } };
      if (q.includes('SELECT ?request ?uuid ?created ?appliedAt')) return bindings(laterApplied);
      throw new Error(`unexpected query: ${q}`);
    },
    async update(q) {
      updates.push(q);
      if (q.includes('cr:appliedAt "') && applyAttempts++ < failApply) throw new Error('Virtuoso said no');
    },
  };
}

const clock = () => {
  const times = [NOW, APPLIED_AT];
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
};

const service = (db) => createService({ model, config, db, mintUuid: uuidSequence(), clock: clock() });

test('an organisation edits itself: the request is written, applied and answered with 201', async () => {
  const db = fakeDb();
  const { status, document } = await service(db).create(sessions.orgA, body());
  assert.equal(status, 201);
  assert.equal(document.type, 'change-requests');
  assert.equal(document.id, sequenceUuid(1), 'the request uuid is minted first');
  assert.deepEqual(document.attributes, {
    status: 'goedgekeurd',
    created: '2026-11-03T10:12:00.000Z',
    'applied-at': '2026-11-03T10:12:01.000Z',
    aggregate: 'organization-core-data',
    lids: { c1: sequenceUuid(2) },
  });
  assert.deepEqual(document.relationships, {
    target: { data: { type: 'organizations', id: IDS.org } },
    'requesting-organisation': { data: { type: 'organizations', id: IDS.org } },
  });
  assert.equal(db.updates.length, 2, 'the request insert and the apply');
  assert.ok(db.updates[0].includes('a cr:ChangeRequest') && db.updates[0].includes(`<${STATUS.ingediend}>`));
  assert.ok(db.updates[1].includes('cr:appliedAt') && db.updates[1].includes(`<${STATUS.goedgekeurd}>`));
  assert.ok(db.updates[1].includes(`ext:lastModifiedBy <${URIS.account}>`));
  // the lookups: target, the referenced ids and the reachable records in one round, the unchanged check
  assert.ok(db.queries.some((q) => q.includes('SELECT DISTINCT ?resource') && q.includes(`<${URIS.org}> (`)));
  assert.ok(db.queries.some((q) => q.includes('SELECT ?s ?p ?o') && q.includes(`(<${URIS.org}> <${NS.org}classification>)`)));
});

test('a failed apply is retried once; when the retry succeeds the request is goedgekeurd', async () => {
  const db = fakeDb({ failApply: 1 });
  const { status, document } = await service(db).create(sessions.orgA, body());
  assert.equal(status, 201);
  assert.equal(document.attributes.status, 'goedgekeurd');
  assert.equal(db.applyAttempts, 2);
  assert.equal(db.updates.length, 3, 'the insert and two apply attempts');
  assert.equal(db.updates[1], db.updates[2], 'the same idempotent update');
});

test('when the retry fails too the request is marked mislukt with the error and the answer is 409', async () => {
  const db = fakeDb({ failApply: 2 });
  await assert.rejects(() => service(db).create(sessions.orgA, body()), (error) => {
    assert.equal(error.status, 409);
    assert.match(error.detail, /^Virtuoso said no\. The request is kept with status mislukt; POST \/change-requests\/.*\/apply applies its stored versions again/);
    assert.deepEqual(error.meta, { 'change-request': { id: sequenceUuid(1), status: 'mislukt' } });
    return true;
  });
  assert.equal(db.updates.length, 4);
  assert.ok(db.updates[3].includes(`<${STATUS.mislukt}>`) && db.updates[3].includes('cr:error """Virtuoso said no"""'));
});

test('another organisation is refused with 403 and the policy outcome; nothing is written', async () => {
  const db = fakeDb();
  await assert.rejects(() => service(db).create(sessions.orgA, body(IDS.orgB)), { status: 403, detail: 'No rule allows it', meta: { rule: null, rules: [] } });
  assert.equal(db.updates.length, 0);
});

test('ids of another organisation are refused with 422 even when the target is the acting organisation', async () => {
  const siteB = resources.get(IDS.siteB);
  const refused = async (ops, detail) => {
    const db = fakeDb();
    await assert.rejects(() => service(db).create(sessions.orgA, body(IDS.org, 'organization-core-data', ops)), { status: 422, detail });
    assert.equal(db.updates.length, 0, 'nothing is written');
  };
  await refused([{ op: 'delete', data: { type: 'sites', id: IDS.siteB } }], /does not belong to the target organisation/);
  await refused([{ op: 'update', data: { type: 'addresses', id: IDS.addressB, attributes: { street: 'pwned' } } }], /does not belong to the target organisation/);
  await refused([{ op: 'update', data: { type: 'organizations', id: IDS.abb, attributes: { name: 'pwned' } } }], /must be the target of the request/);
  await refused([{ op: 'update', data: { type: 'administrative-units', id: IDS.org, relationships: { 'primary-site': { data: { type: 'sites', id: IDS.siteB } } } } }], /does not belong to the target organisation/);
  await refused([{ op: 'delete', data: { type: 'administrative-units', id: IDS.org } }], /cannot be deleted/);
  await refused([{ op: 'create', data: { type: 'administrative-units', lid: 'o1', attributes: { name: 'Gemeente Nergens' } } }], /cannot be created/);
  assert.equal(siteB.uri, URIS.siteB);
});

test('a relationship outside the aggregate passes when unchanged and is refused with 422 when it differs', async () => {
  const withClassification = (ref) => [
    { op: 'update', data: { type: 'administrative-units', id: IDS.org, attributes: { name: 'Stad Aalst' }, relationships: { classification: { data: ref } } } },
  ];
  const same = fakeDb();
  const { status } = await service(same).create(sessions.orgA, body(IDS.org, 'organization-core-data', withClassification({ type: 'administrative-unit-classification-codes', id: IDS.gemeenteCode })));
  assert.equal(status, 201);
  assert.ok(!same.updates[1].includes(`${NS.org}classification`), 'the classification is neither deleted nor inserted');

  const cleared = fakeDb();
  await assert.rejects(() => service(cleared).create(sessions.orgA, body(IDS.org, 'organization-core-data', withClassification(null))), {
    status: 422,
    detail: 'relationship "classification" is not part of the aggregate "organization-core-data" and cannot be changed through it',
    pointer: '/data/attributes/operations/0/data/relationships/classification',
  });
  assert.equal(cleared.updates.length, 0);
});

test('ABB edits another organisation', async () => {
  const db = fakeDb();
  const { status, document } = await service(db).create(sessions.abb, body(IDS.orgB, 'site', [
    { op: 'create', data: { type: 'contact-points', lid: 'c1', attributes: { email: 'abb@example.org' } } },
  ]));
  assert.equal(status, 201);
  assert.equal(document.attributes.status, 'goedgekeurd');
  assert.equal(document.relationships['requesting-organisation'].data.id, IDS.abb);
  assert.ok(db.updates[1].includes(`<${URIS.orgB}> dct:modified`));
});

test('an unknown target is a 404, an unknown aggregate or a bad document a 422', async () => {
  await assert.rejects(() => service(fakeDb()).create(sessions.orgA, body('ffffffff-ffff-4fff-8fff-ffffffffffff')), { status: 404 });
  await assert.rejects(() => service(fakeDb()).create(sessions.orgA, body(IDS.org, 'everything')), { status: 422, detail: /unknown aggregate "everything"/ });
  await assert.rejects(() => service(fakeDb()).create(sessions.orgA, { data: { type: 'organizations' } }), { status: 422, pointer: '/data/type' });
  await assert.rejects(() => service(fakeDb()).create(sessions.orgA, {}), { status: 422, pointer: '/data' });
  const noTarget = body();
  delete noTarget.data.relationships;
  await assert.rejects(() => service(fakeDb()).create(sessions.orgA, noTarget), { status: 422, pointer: '/data/relationships/target' });
  const siteTarget = body();
  siteTarget.data.relationships.target.data.type = 'sites';
  await assert.rejects(() => service(fakeDb()).create(sessions.orgA, siteTarget), { status: 422, detail: /must be of type organizations or a subtype/ });
});

test('permissions answer with the deciding rule, the same evaluation as the POST', async () => {
  assert.deepEqual(await service(fakeDb()).permissions(sessions.orgA, IDS.org), { 'can-edit': true, rules: ['own-organisation'] });
  assert.deepEqual(await service(fakeDb()).permissions(sessions.orgA, IDS.orgB), { 'can-edit': false, rules: [] });
  assert.deepEqual(await service(fakeDb()).permissions(sessions.abb, IDS.orgB), { 'can-edit': true, rules: ['abb-edits-all'] });
  await assert.rejects(() => service(fakeDb()).permissions(sessions.orgA, 'ffffffff-ffff-4fff-8fff-ffffffffffff'), { status: 404 });
});

const storedRequest = {
  request: 'http://data.lblod.info/id/change-requests/r1',
  uuid: 'r1',
  created: '2026-11-03T10:12:00Z',
  status: STATUS.goedgekeurd,
  aggregate: 'organization-core-data',
  target: URIS.org,
  targetUuid: IDS.org,
  requestingOrganisation: URIS.abb,
  requestingOrganisationUuid: IDS.abb,
  account: URIS.accountAbb,
  appliedAt: '2026-11-03T10:12:01Z',
};

test('listing is filtered to what the acting organisation may see; ABB sees all', async () => {
  const db = fakeDb({ requests: [storedRequest] });
  const list = await service(db).list(sessions.orgA, IDS.org);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].attributes, { status: 'goedgekeurd', created: '2026-11-03T10:12:00.000Z', 'applied-at': '2026-11-03T10:12:01.000Z', aggregate: 'organization-core-data' });
  assert.deepEqual(list[0].relationships['requesting-organisation'].data, { type: 'organizations', id: IDS.abb });
  const listQuery = db.queries.at(-1);
  assert.ok(listQuery.includes(`FILTER(?target = <${URIS.org}>)`));
  assert.ok(listQuery.includes(`FILTER(?target = <${URIS.org}> || ?requestingOrganisation = <${URIS.org}>)`));

  await service(db).list(sessions.abb);
  assert.ok(!db.queries.at(-1).includes('FILTER'), 'ABB sees all, unfiltered');

  assert.deepEqual(await service(db).list(sessions.orgA, 'ffffffff-ffff-4fff-8fff-ffffffffffff'), [], 'a filter on an unknown organisation is an empty list');
});

test('a single request is a 404 when it is not visible', async () => {
  const found = await service(fakeDb({ requests: [storedRequest] })).get(sessions.orgA, 'r1');
  assert.equal(found.id, 'r1');
  await assert.rejects(() => service(fakeDb({ requests: [storedRequest] })).get(sessions.orgB, 'r1'), { status: 404 });
});

// A failed request of organisation A with its stored versions: an update of the address and a
// create of a contact point.
const failedRequest = {
  ...storedRequest,
  request: 'http://data.lblod.info/id/change-requests/r2',
  uuid: 'r2',
  status: STATUS.mislukt,
  requestingOrganisation: URIS.org,
  requestingOrganisationUuid: IDS.org,
  account: URIS.account,
  appliedAt: null,
  error: 'Virtuoso said no',
};
const uri = (value) => ({ type: 'uri', value });
const literal = (value) => ({ type: 'literal', value });
const storedVersion = (version, triples) =>
  triples.map(([p, o]) => ({ version: uri(version.uri), master: uri(version.master), masterUuid: literal(version.masterUuid), type: literal(version.type), operation: literal(version.operation), p: uri(p), o }));
const storedVersions = [
  ...storedVersion({ uri: 'http://data.lblod.info/id/versions/v1', master: URIS.address, masterUuid: IDS.address, type: 'addresses', operation: 'update' }, [
    [`${NS.rdf}type`, uri(`${NS.cr}Version`)],
    [`${NS.mu}uuid`, literal('v1')],
    [`${NS.cr}replaces`, uri(`${NS.locn}thoroughfare`)],
    [`${NS.cr}replaces`, uri(`${NS.adres}Adresvoorstelling.huisnummer`)],
    [`${NS.locn}thoroughfare`, literal('Nieuwe straat')],
  ]),
  ...storedVersion({ uri: 'http://data.lblod.info/id/versions/v2', master: 'http://data.lblod.info/id/contact-punten/new1', masterUuid: 'new1', type: 'contact-points', operation: 'create' }, [
    [`${NS.rdf}type`, uri(`${NS.cr}Version`)],
    [`${NS.mu}uuid`, literal('v2')],
    [`${NS.cr}replaces`, uri(`${NS.schema}email`)],
    [`${NS.schema}email`, literal('info@aalst.be')],
  ]),
];

test('a failed request is applied again from its stored versions', async () => {
  const db = fakeDb({ requests: [failedRequest], storedVersions });
  const { status, document } = await service(db).apply(sessions.orgA, 'r2');
  assert.equal(status, 200);
  assert.equal(document.id, 'r2');
  assert.equal(document.attributes.status, 'goedgekeurd');
  assert.equal(document.attributes['applied-at'], '2026-11-03T10:12:00.000Z');
  assert.equal(document.attributes.error, undefined);
  assert.equal(db.updates.length, 1, 'the apply only');
  const apply = db.updates[0];
  assert.ok(apply.includes(`VALUES ?s { <${URIS.address}> }\n    VALUES ?p { <${NS.locn}thoroughfare> <${NS.adres}Adresvoorstelling.huisnummer> }`), 'replaces the stored predicates, sorted');
  assert.ok(apply.includes(`<${URIS.address}> <${NS.locn}thoroughfare> """Nieuwe straat""" .`));
  assert.ok(apply.includes(`<http://data.lblod.info/id/contact-punten/new1> a <${NS.schema}ContactPoint> ;\n      mu:uuid """new1""" ;\n      <${NS.schema}email> """info@aalst.be""" .`), 'a stored create inserts its class and uuid again');
  assert.ok(apply.includes(`<http://data.lblod.info/id/change-requests/r2> cr:error ?oldError`), 'the error of the failed attempt goes');
  assert.ok(apply.includes(`<${URIS.org}> dct:modified`) && apply.includes(`ext:lastModifiedBy <${URIS.account}>`), 'stamped with the account of the request');
  assert.ok(db.queries.some((q) => q.includes('SELECT ?request ?uuid ?created ?appliedAt') && q.includes(`cr:target <${URIS.org}>`) && q.includes('"2026-11-03T10:12:00.000Z"^^xsd:dateTime')));
});

test('applying again is refused for a request that did not fail, that is not visible, or that another organisation may not edit', async () => {
  await assert.rejects(() => service(fakeDb({ requests: [storedRequest], storedVersions })).apply(sessions.orgA, 'r1'), { status: 409, detail: 'Change request "r1" has status goedgekeurd' });
  await assert.rejects(() => service(fakeDb({ requests: [failedRequest], storedVersions })).apply(sessions.orgB, 'r2'), { status: 404 });
  const abbRequestOnA = { ...failedRequest, uuid: 'r3', request: 'http://data.lblod.info/id/change-requests/r3', requestingOrganisation: URIS.abb, requestingOrganisationUuid: IDS.abb };
  const asB = fakeDb({ requests: [{ ...abbRequestOnA, target: URIS.orgB, targetUuid: IDS.orgB }], storedVersions });
  await assert.rejects(() => service(asB).apply(sessions.orgA, 'r3'), { status: 404 }, 'not visible to A');
  const visibleButDenied = fakeDb({ requests: [{ ...abbRequestOnA, requestingOrganisation: URIS.orgB, requestingOrganisationUuid: IDS.orgB }], storedVersions });
  await assert.rejects(() => service(visibleButDenied).apply(sessions.orgB, 'r3'), { status: 403 }, 'B submitted it (sees it) but may not edit A');
  const { status } = await service(fakeDb({ requests: [abbRequestOnA], storedVersions })).apply(sessions.abb, 'r3');
  assert.equal(status, 200, 'ABB may');
});

test('applying again is refused when a later request on the organisation was applied since', async () => {
  const db = fakeDb({ requests: [failedRequest], storedVersions, laterApplied: [{ request: 'http://data.lblod.info/id/change-requests/r9', uuid: 'r9', created: '2026-11-03T11:00:00Z', appliedAt: '2026-11-03T11:00:01Z' }] });
  await assert.rejects(() => service(db).apply(sessions.orgA, 'r2'), {
    status: 409,
    detail: 'Change request "r9" was applied on 2026-11-03T11:00:01.000Z; submit the change again instead of applying this one',
  });
  assert.equal(db.updates.length, 0);
  await assert.rejects(() => service(fakeDb({ requests: [failedRequest], storedVersions: [] })).apply(sessions.orgA, 'r2'), { status: 409, detail: /Nothing is stored/ });
});

test('a failed re-apply keeps the request mislukt and answers 409', async () => {
  const db = fakeDb({ requests: [failedRequest], storedVersions, failApply: 2 });
  await assert.rejects(() => service(db).apply(sessions.orgA, 'r2'), { status: 409, meta: { 'change-request': { id: 'r2', status: 'mislukt' } } });
  assert.equal(db.updates.length, 3, 'two attempts and the failure record');
  assert.ok(db.updates[2].includes(`<${STATUS.mislukt}>`));
});

test('the fixture request is the kerngegevens page: six operations', () => {
  assert.equal(operations.length, 6);
});
