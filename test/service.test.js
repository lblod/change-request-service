import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createService, parseListQuery, pageLinks } from '../lib/change-requests.js';
import { registrableClassifications } from '../lib/config.js';
import { selectInBatches } from '../lib/sparql-result.js';
import { STATUS, STEP_TYPE, OPERATION, SERVICE_AGENT, PENDING_STATUS_KEYS, PREFIXES, statusKey } from '../constants.js';
import { parses } from './support/sparql.js';
import {
  model,
  config,
  resources,
  organisations,
  reachableByOrganisation,
  masterState,
  incomingMap,
  sessions,
  body,
  operations,
  creationBody,
  creationOperations,
  changeEventOperations,
  IDS,
  URIS,
  NS,
  NOW,
  APPLIED_AT,
  uri,
  literal,
  uuidSequence,
  sequenceUuid,
  testUuid,
} from './support/fixtures.js';

const bindings = (list) => ({
  results: {
    bindings: list.map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value != null).map(([key, value]) => [key, typeof value === 'object' ? value : { value }]))),
  },
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** The IRIs of a VALUES clause of a query, or null when it has none. */
const valuesOf = (q, variable) => {
  const match = q.match(new RegExp(`VALUES \\?${variable} \\{([^}]*)\\}`));
  return match ? [...match[1].matchAll(/<([^>]+)>/g)].map((m) => m[1]) : null;
};
const pairsOf = (q) => [...q.matchAll(/\(<([^>]+)> <([^>]+)>\)/g)].map((m) => [m[1], m[2]]);

const requestsMatching = (q, requests) => {
  const uuid = q.match(/\?request mu:uuid """([^"]+)"""/)?.[1];
  const target = q.match(/FILTER\(\?target = <([^>]+)>\)/)?.[1];
  const visibleTo = q.match(/FILTER\(\?target = <([^>]+)> \|\| /)?.[1];
  const shown = [...(q.match(/\|\| \?status IN \(([^)]*)\)/)?.[1] ?? '').matchAll(/<([^>]+)>/g)].map((m) => m[1]);
  const creator = q.match(/FILTER\(\?creator = <([^>]+)>\)/)?.[1];
  const requester = q.match(/FILTER\(\?requestingOrganisation = <([^>]+)>\)/)?.[1];
  const aggregates = q.match(/VALUES \?aggregate \{([^}]*)\}/) ? [...q.match(/VALUES \?aggregate \{([^}]*)\}/)[1].matchAll(/"""([^"]+)"""/g)].map((m) => m[1]) : null;
  const from = q.match(/FILTER\(\?created >= "([^"]+)"/)?.[1];
  const until = q.match(/FILTER\(\?created <= "([^"]+)"/)?.[1];
  const uris = valuesOf(q, 'request');
  const statuses = valuesOf(q, 'status');
  return requests.filter(
    (r) =>
      (!uuid || r.uuid === uuid) &&
      (!target || r.target === target) &&
      (!visibleTo || r.target === visibleTo || r.requestingOrganisation === visibleTo || shown.includes(r.status)) &&
      (!creator || r.creator === creator) &&
      (!requester || r.requestingOrganisation === requester) &&
      (!aggregates || aggregates.includes(r.aggregate)) &&
      (!from || new Date(r.created) >= new Date(from)) &&
      (!until || new Date(r.created) <= new Date(until)) &&
      (!uris || uris.includes(r.request)) &&
      (!statuses || statuses.includes(r.status)),
  );
};
// An apply: an INSERT ... WHERE (the request insert, the steps, the statuses and the failure records are INSERT DATA).
const isApply = (q) => q.includes('\nINSERT {');
const PENDING = PENDING_STATUS_KEYS.map((key) => STATUS[key]);
/** The """...""" strings of a query, in order. */
const stringsOf = (q) => [...q.matchAll(/"""([^"]*)"""/g)].map((m) => m[1]);

/**
 * A stand-in for the triplestore: it answers the service's queries from an in-memory state (the
 * organisations and records of the fixtures, master: the current values of the masters, which
 * also tell what links to a record, records: uri -> { uuid, classes } of records that link to a
 * deleted one, requests and steps: rows of stored requests and their steps, storedVersions: rows
 * of their versions, replacedStates: rows of the states their steps replaced) and records the
 * updates. holders: KBO number -> { uri, uuid } of the organisation in the register that holds it;
 * pendingKbo: KBO number -> { request, uuid, requestingOrganisation? } of the waiting creation that
 * proposes it; identifierNames: structured identifier URI -> the name of its identifier in the
 * register. Every call yields once, so concurrent calls interleave as they would against a real
 * store. failApply: how many apply attempts fail before one succeeds. onUpdate(q, state) lets a
 * test change the state the way an update would. Steps are read per request (VALUES ?request),
 * as the service asks for them. Every query and update is parsed as SPARQL 1.1 first, so a
 * malformed one fails the test that sends it.
 */
function fakeDb({ failApply = 0, requests = [], steps = [], storedVersions = [], replacedStates = [], laterApplied = [], master = masterState(), records = {}, uuids = {}, former = {}, holders = {}, pendingKbo = {}, identifierNames = { [URIS.structuredKbo]: 'KBO nummer' }, onUpdate } = {}) {
  const state = { requests, steps, storedVersions, replacedStates, laterApplied, master };
  const updates = [];
  const queries = [];
  const log = [];
  let applyAttempts = 0;
  // The versions of the waiting creations of pendingKbo, as the lookups of a KBO number find them.
  const pendingEntries = Object.entries(pendingKbo).map(([localId, entry], n) => ({
    localId,
    ...entry,
    structured: `http://example.org/pending/structured/${n}`,
    structuredVersion: `http://example.org/pending/structured-version/${n}`,
    identifierVersion: `http://example.org/pending/identifier-version/${n}`,
  }));
  return {
    state,
    updates,
    queries,
    log,
    get applyAttempts() {
      return applyAttempts;
    },
    async query(q) {
      await tick();
      parses(q);
      queries.push(q);
      log.push(['query', q]);
      if (q.includes('SELECT ?uri ?type ?classification')) {
        const uuid = q.match(/mu:uuid """([^"]+)"""/)[1];
        const organisation = organisations[uuid];
        if (!organisation) return bindings([]);
        return bindings(organisation.classes.map((type) => ({ uri: organisation.uri, type, classification: organisation.classification })));
      }
      if (q.includes('SELECT ?uuid ?uri ?type')) {
        const ids = stringsOf(q);
        return bindings(ids.flatMap((uuid) => (resources.has(uuid) ? resources.get(uuid).classes.map((type) => ({ uuid, uri: resources.get(uuid).uri, type })) : [])));
      }
      if (q.includes('SELECT DISTINCT ?resource')) {
        const targetUri = q.match(/\n {2}<([^>]+)> \(/)[1];
        return bindings([...(reachableByOrganisation[targetUri] || [])].filter((resource) => resource !== targetUri).map((resource) => ({ resource })));
      }
      if (q.includes('SELECT ?s ?p ?o')) {
        return { results: { bindings: pairsOf(q).flatMap(([s, p]) => (state.master[`${s} ${p}`] || []).map((o) => ({ s: uri(s), p: uri(p), o }))) } };
      }
      if (q.includes('SELECT DISTINCT ?o ?p ?s')) {
        const links = incomingMap(state.master);
        return { results: { bindings: pairsOf(q).flatMap(([o, p]) => (links.get(`${o} ${p}`) || []).map((s) => ({ o: uri(o), p: uri(p), s }))) } };
      }
      if (q.includes('SELECT ?uri ?uuid\nWHERE {\n  VALUES ?localId')) {
        // the organisation in the register that holds a KBO number, one of its forms
        const except = q.match(/FILTER\(\?uri != <([^>]+)>\)/)?.[1];
        const holder = stringsOf(q).map((localId) => holders[localId]).find(Boolean);
        return bindings(holder && holder.uri !== except ? [holder] : []);
      }
      if (q.includes('SELECT DISTINCT ?structuredVersion ?structured')) {
        const forms = stringsOf(q);
        return bindings(pendingEntries.filter((entry) => forms.includes(entry.localId)).map(({ structuredVersion, structured }) => ({ structuredVersion, structured })));
      }
      if (q.includes('SELECT DISTINCT ?identifierVersion ?idName')) {
        const asked = pairsOf(q).map(([structured]) => structured);
        return bindings(pendingEntries.filter((entry) => asked.includes(entry.structured)).map(({ identifierVersion }) => ({ identifierVersion, idName: 'KBO nummer' })));
      }
      if (q.includes('SELECT DISTINCT ?structured ?idName')) {
        const asked = valuesOf(q, 'structured');
        return bindings(asked.filter((structured) => identifierNames[structured]).map((structured) => ({ structured, idName: identifierNames[structured] })));
      }
      if (q.includes('SELECT DISTINCT ?version\nWHERE')) {
        // the versions that change one of the pairs
        const pairs = pairsOf(q).map(([m, p]) => `${m} ${p}`);
        const found = new Set(
          state.storedVersions.filter((row) => !row.base && row.p.value === `${NS.cr}changesProperty` && pairs.includes(`${row.master.value} ${row.o.value}`)).map((row) => row.version.value),
        );
        return bindings([...found].map((version) => ({ version })));
      }
      if (q.includes('SELECT DISTINCT ?version ?request ?uuid ?status ?aggregate ?requestingOrganisation')) {
        const asked = valuesOf(q, 'version');
        const found = [];
        for (const version of asked) {
          const pending = pendingEntries.find((entry) => entry.identifierVersion === version);
          if (pending) {
            found.push({ version, request: pending.request, uuid: pending.uuid, status: STATUS.ingediend, aggregate: 'new-organisation', requestingOrganisation: pending.requestingOrganisation ?? URIS.orgB });
            continue;
          }
          const requestUri = state.storedVersions.find((row) => row.version.value === version)?.request.value;
          const request = state.requests.find((r) => r.request === requestUri);
          if (request) found.push({ version, request: request.request, uuid: request.uuid, status: request.status, aggregate: request.aggregate, requestingOrganisation: request.requestingOrganisation });
        }
        return bindings(found);
      }
      if (q.includes('SELECT DISTINCT ?request ?created')) {
        const descending = q.includes('ORDER BY DESC');
        const page = requestsMatching(q, state.requests).sort((a, b) => (a.created.localeCompare(b.created) || a.request.localeCompare(b.request)) * (descending ? -1 : 1));
        const [limit, offset] = [Number(q.match(/LIMIT (\d+)/)[1]), Number(q.match(/OFFSET (\d+)/)[1])];
        return bindings(page.slice(offset, offset + limit).map(({ request, created }) => ({ request, created })));
      }
      if (q.includes('SELECT (COUNT(DISTINCT ?request) AS ?count)')) return bindings([{ count: String(requestsMatching(q, state.requests).length) }]);
      if (q.includes('SELECT DISTINCT ?request ?uuid ?created')) {
        // the target's uuid and name from the proposed version when the organisation does not exist (a creation that waits)
        return bindings(requestsMatching(q, state.requests).map((r) => {
          if (r.targetUuid) return r;
          const ofTarget = state.storedVersions.filter((row) => row.request.value === r.request && row.master.value === r.target && !row.base);
          return { ...r, proposedUuid: ofTarget[0]?.masterUuid.value, proposedName: ofTarget.find((row) => row.p.value === `${NS.skos}prefLabel`)?.o.value };
        }));
      }
      if (q.includes('SELECT DISTINCT ?request ?step ?stepUuid')) {
        // per request, as the service asks: by URI
        const asked = valuesOf(q, 'request');
        return bindings(state.steps.filter((step) => asked.includes(step.request)));
      }
      if (q.includes('SELECT ?request ?version ?master')) {
        const requested = valuesOf(q, 'request');
        return { results: { bindings: state.storedVersions.filter((row) => requested.includes(row.request.value)) } };
      }
      if (q.includes('SELECT ?request ?step ?state ?master')) {
        const requested = valuesOf(q, 'request');
        return { results: { bindings: state.replacedStates.filter((row) => requested.includes(row.request.value)) } };
      }
      if (q.includes('SELECT DISTINCT ?request ?uuid ?appliedAt')) return bindings(state.laterApplied);
      if (q.includes('SELECT DISTINCT ?uri ?uuid ?type')) {
        const asked = valuesOf(q, 'uri');
        return bindings(asked.filter((u) => records[u]).flatMap((u) => records[u].classes.map((type) => ({ uri: u, uuid: records[u].uuid, type }))));
      }
      if (q.includes('SELECT DISTINCT ?uri ?uuid')) {
        const asked = valuesOf(q, 'uri');
        return bindings(asked.filter((u) => uuids[u]).map((u) => ({ uri: u, uuid: uuids[u] })));
      }
      if (q.includes('SELECT DISTINCT ?uuid ?uri')) {
        const asked = stringsOf(q);
        return bindings(asked.filter((id) => former[id]).map((id) => ({ uuid: id, uri: former[id] })));
      }
      throw new Error(`unexpected query: ${q}`);
    },
    async update(q) {
      await tick();
      parses(q);
      updates.push(q);
      log.push(['update', q]);
      if (isApply(q) && applyAttempts++ < failApply) throw new Error('Virtuoso said no');
      onUpdate?.(q, state);
    },
  };
}

/** The status a status update sets (statusQueries: INSERT DATA of adms:status), as [request, status], or null. */
const statusSet = (q) => q.match(/INSERT DATA \{\n {2}GRAPH <[^>]+> \{ <([^>]+)> adms:status <([^>]+)> \. \}/)?.slice(1) ?? null;

/** The steps an update writes: one per cr:Action block, with the fields the stepsQuery rows carry. */
const stepsWritten = (q) =>
  [...q.matchAll(/<([^>]+)> a cr:Action ;/g)].map((match) => {
    const block = q.slice(match.index, q.indexOf(' .', q.indexOf('prov:wasAssociatedWith', match.index)));
    const field = (pattern) => block.match(pattern)?.[1];
    return {
      request: field(/dct:isPartOf <([^>]+)>/),
      step: match[1],
      stepUuid: match[1].split('/').pop(),
      sequence: field(/schema:position "(\d+)"/),
      type: field(/dct:type <([^>]+)>/),
      status: field(/adms:status <([^>]+)>/),
      at: field(/prov:startedAtTime "([^"]+)"/),
      agent: field(/prov:wasAssociatedWith <([^>]+)>/),
    };
  });

/** onUpdate: keeps requests and steps in step with the step and status updates, as the triplestore would. */
const recordSteps = (q, state) => {
  const removed = q.match(/DELETE \{\n {2}GRAPH <[^>]+> \{ <([^>]+)> \?p \?o \. \}/)?.[1];
  if (removed) state.steps = state.steps.filter((step) => step.step !== removed);
  for (const step of stepsWritten(q)) {
    state.steps = state.steps.filter((other) => other.step !== step.step);
    state.steps.push(step);
  }
  const replaced = q.match(/<([^>]+)> dct:isReplacedBy <([^>]+)> \./);
  if (replaced) {
    const request = state.requests.find((r) => r.request === replaced[1]);
    if (request) Object.assign(request, { replacedBy: replaced[2], replacedByUuid: replaced[2].split('/').pop() });
  }
  const set = statusSet(q);
  if (set) {
    const request = state.requests.find((r) => r.request === set[0]);
    if (request) request.status = set[1];
  }
};

/** Whether an update only sets a status (statusQueries). */
const isStatusUpdate = (q) => Boolean(statusSet(q)) || q.includes('adms:status ?other');
/** The updates of a run other than the status updates: the writes of requests, steps and data. */
const writes = (db) => db.updates.filter((q) => !isStatusUpdate(q));
/** The statuses the updates of a run set, in order. */
const statusesSet = (db) => db.updates.map(statusSet).filter(Boolean).map(([, status]) => statusKey(status));

const clock = () => {
  const times = [NOW, APPLIED_AT];
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
};

// verifyWrites: the fake does not keep the data an apply writes, so it cannot answer the read-back (tested on its own below).
const service = (db) => createService({ model, config, db, mintUuid: uuidSequence(), clock: clock(), verifyWrites: false });

const prefLabel = `${NS.skos}prefLabel`;
const REQUEST_URI = (uuid) => `http://data.lblod.info/id/change-requests/${uuid}`;
const PREFIX_LINES = PREFIXES;
const withName = (name, state = masterState()) => ({ ...state, [`${URIS.org} ${prefLabel}`]: [literal(name)] });
const rename = (name, base) => body(IDS.org, 'organization-core-data', [
  { op: 'update', data: { type: 'administrative-units', id: IDS.org, attributes: { name }, ...(base !== undefined ? { meta: { base: { attributes: { name: base } } } } : {}) } },
]);
/** The conflict of a form that loaded the name "Aalst" and proposes "Aalst (A)" after ABB renamed the organisation. */
const nameConflict = { resource: { type: 'administrative-units', id: IDS.org }, key: 'name', base: 'Aalst', current: 'Aalst (ABB)', proposed: 'Aalst (A)', 'master-exists': true, 'competing-requests': [] };
const userStep = (session, fields) => ({
  at: '2026-11-03T10:12:00.000Z', agent: 'user', person: session.personUuid, organisation: session.actor.uuid, rule: null, reason: null, error: null, 'overrides-conflict': false, 'overridden-conflicts': [], ...fields,
});
const serviceApproval = { sequence: 2, type: 'goedkeuring', status: 'goedgekeurd', at: '2026-11-03T10:12:01.000Z', agent: 'service', person: null, organisation: null, rule: 'edits-apply-at-once', reason: null, error: null, 'overrides-conflict': false, 'overridden-conflicts': [] };
const serviceHandling = { sequence: 3, type: 'afhandeling', status: 'afgehandeld', at: '2026-11-03T10:12:01.000Z', agent: 'service', person: null, organisation: null, rule: null, reason: null, error: null, 'overrides-conflict': false, 'overridden-conflicts': [] };
/** The attributes every document carries besides the flow: an edit the viewer submitted, about an organisation the fake shows no name or classification for. */
const listed = { kind: 'edit', mine: true, 'target-name': null, 'target-classification': null };
/** A service with the config changed: pendingVisibleTo "involved" for instance. */
const configured = (db, overrides) => createService({ model, config: { ...config, ...overrides }, db, mintUuid: uuidSequence(), clock: clock(), verifyWrites: false });

// --- POST /change-requests ------------------------------------------------------------------

test('an organisation edits itself: the request with its indiening step and versions is written, the service approves and applies it', async () => {
  const db = fakeDb();
  const { status, document } = await service(db).create(sessions.orgA, body());
  assert.equal(status, 201);
  assert.equal(document.type, 'change-requests');
  assert.equal(document.id, sequenceUuid(1), 'the request uuid is minted first');
  assert.deepEqual(document.attributes, {
    status: 'afgehandeld',
    ...listed,
    created: '2026-11-03T10:12:00.000Z',
    'applied-at': '2026-11-03T10:12:01.000Z',
    aggregate: 'organization-core-data',
    error: null,
    steps: [userStep(sessions.orgA, { sequence: 1, type: 'indiening', status: 'ingediend', rule: 'own-organisation' }), serviceApproval, serviceHandling],
    conflicts: [],
    'conflicts-token': null,
    competing: [],
    'replaced-by': null,
    lids: { c1: sequenceUuid(2) },
    superseded: [],
  });
  assert.equal(document.attributes.status, document.attributes.steps.at(-1).status, 'the status is the status of the last step');
  assert.deepEqual(document.relationships, {
    target: { data: { type: 'organizations', id: IDS.org } },
    'requesting-organisation': { data: { type: 'organizations', id: IDS.org } },
  });
  assert.equal(db.updates.length, 4, 'the request insert, the apply, and the status: the new one added, then the old one removed');
  const [insert, apply, statusAdded, statusRemoved] = db.updates;
  assert.ok(statusAdded.includes(`INSERT DATA {\n  GRAPH <http://mu.semte.ch/graphs/change-requests> { <${REQUEST_URI(sequenceUuid(1))}> adms:status <${STATUS.afgehandeld}> . }\n}`));
  assert.ok(statusRemoved.includes(`FILTER(?other != <${STATUS.afgehandeld}>)`));
  assert.ok(!apply.includes('adms:status ?'), 'the apply does not touch the request status');
  assert.ok(insert.includes('a cr:ChangeRequest') && insert.includes(`adms:status <${STATUS.ingediend}>`));
  assert.ok(insert.includes(`pav:createdBy <${URIS.org}> ;\n      dct:creator <${URIS.person}> .`), 'the organisation and the person, not the account');
  assert.ok(insert.includes(`dct:type <${STEP_TYPE.indiening}> ;\n      adms:status <${STATUS.ingediend}> ;\n      schema:position "1"^^xsd:integer ;`));
  assert.ok(insert.includes(`prov:wasAssociatedWith <${URIS.person}> ;\n      cr:actingOrganisation <${URIS.org}> ;\n      cr:rule """own-organisation"""`));
  assert.ok(apply.includes(`dct:type <${STEP_TYPE.goedkeuring}> ;\n      adms:status <${STATUS.goedgekeurd}> ;\n      schema:position "2"^^xsd:integer ;`));
  assert.ok(apply.includes(`prov:wasAssociatedWith <${SERVICE_AGENT}> ;\n      cr:rule """edits-apply-at-once""" .`), 'the service approved it');
  assert.ok(apply.includes(`dct:type <${STEP_TYPE.afhandeling}> ;\n      adms:status <${STATUS.afgehandeld}> ;\n      schema:position "3"^^xsd:integer ;`));
  assert.ok(apply.includes(`prov:wasAssociatedWith <${SERVICE_AGENT}> ;\n      prov:invalidated <http://data.lblod.info/id/record-states/`), 'the afhandeling applied it, with the states it replaced');
  assert.ok(apply.includes(`a cr:RecordState ;`) && apply.includes(`<${prefLabel}> """Aalst"""`), 'the name the organisation had');
  assert.ok(apply.includes(`ext:lastModifiedBy <${URIS.person}>`));
  // the lookups: the reachable records, the current values of every carried key and the unchanged checks in one query
  assert.ok(db.queries.some((q) => q.includes('SELECT DISTINCT ?resource') && q.includes(`<${URIS.org}> (`)));
  const current = db.queries.find((q) => q.includes('SELECT ?s ?p ?o'));
  assert.ok(current.includes(`(<${URIS.org}> <${NS.org}classification>)`) && current.includes(`(<${URIS.org}> <${prefLabel}>)`));
});

test('a failed apply is retried once; when the retry succeeds the request is afgehandeld', async () => {
  const db = fakeDb({ failApply: 1 });
  const { status, document } = await service(db).create(sessions.orgA, body());
  assert.equal(status, 201);
  assert.equal(document.attributes.status, 'afgehandeld');
  assert.equal(db.applyAttempts, 2);
  assert.equal(db.updates.length, 5, 'the insert, two apply attempts and the status');
  assert.equal(db.updates[1], db.updates[2], 'the same idempotent update');
  assert.equal(statusSet(db.updates[3])[1], STATUS.afgehandeld, 'the status only once the apply went through');
});

test('when the retry fails too the afhandeling step is recorded as mislukt with the error after the goedkeuring, and the answer is 409', async () => {
  const db = fakeDb({ failApply: 2 });
  await assert.rejects(() => service(db).create(sessions.orgA, body()), (error) => {
    assert.equal(error.status, 409);
    assert.match(error.detail, /^Virtuoso said no\. The request is kept with status mislukt; a hertoepassing \(POST \/change-requests\/.*\/steps\) applies its stored versions again/);
    assert.deepEqual(error.meta, { 'change-request': { id: sequenceUuid(1), status: 'mislukt' } });
    return true;
  });
  // the insert, two attempts, the failure record, the status (added, the old one removed), and the
  // removal of whatever the attempts wrote of their step
  assert.equal(db.updates.length, 7);
  const [, attempt, , failure, statusAdded, , cleanup] = db.updates;
  assert.ok(failure.startsWith(`${PREFIX_LINES}\n\nINSERT DATA {`), 'recorded without deleting anything');
  assert.ok(failure.includes(`dct:type <${STEP_TYPE.goedkeuring}> ;\n      adms:status <${STATUS.goedgekeurd}> ;\n      schema:position "2"^^xsd:integer ;`), 'the goedkeuring is kept');
  assert.ok(failure.includes(`dct:type <${STEP_TYPE.afhandeling}> ;\n      adms:status <${STATUS.mislukt}> ;\n      schema:position "3"^^xsd:integer ;`));
  assert.ok(failure.includes(`task:error <http://redpencil.data.gift/id/jobs/error/`));
  assert.ok(failure.includes(`a oslc:Error ;`) && failure.includes('oslc:message """Virtuoso said no"""') && failure.includes(`dct:creator <${SERVICE_AGENT}>`));
  assert.equal(statusSet(statusAdded)[1], STATUS.mislukt);
  const attempted = attempt.match(/<([^>]+)> a cr:Action ;\n {6}mu:uuid "{3}[^"]+"{3} ;\n {6}dct:isPartOf <[^>]+> ;\n {6}dct:type <[^>]+7f55ec41/)?.[1];
  assert.ok(attempted && !failure.includes(`<${attempted}> a cr:Action`), 'the failure is recorded under a step of its own');
  assert.ok(cleanup.includes(`{ <${attempted}> ?p ?o . }`), 'what the attempts wrote of their step is removed');
});

test('another organisation is refused with 403 and the policy outcome; nothing is written', async () => {
  const db = fakeDb();
  await assert.rejects(() => service(db).create(sessions.orgA, body(IDS.orgB)), { status: 403, detail: 'No rule allows it', meta: { rule: null, rules: [] } });
  assert.equal(db.updates.length, 0);
});

test('ids of another organisation are refused with 422 even when the target is the acting organisation', async () => {
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
    detail: 'relationship "classification" cannot be changed through the aggregate "organization-core-data"',
    pointer: '/data/attributes/operations/0/data/relationships/classification',
  });
  assert.equal(cleared.updates.length, 0);
});

test('ABB edits another organisation', async () => {
  const db = fakeDb();
  const { status, document } = await service(db).create(sessions.abb, body(IDS.orgB, 'site', [
    { op: 'create', data: { type: 'contact-points', lid: 'c1', attributes: { email: 'abb@example.org' } } },
    { op: 'update', data: { type: 'sites', id: IDS.siteB, relationships: { contacts: { data: [{ type: 'contact-points', lid: 'c1' }] } } } },
  ]));
  assert.equal(status, 201);
  assert.equal(document.attributes.status, 'afgehandeld');
  assert.equal(document.relationships['requesting-organisation'].data.id, IDS.abb);
  assert.deepEqual(document.attributes.steps[0], userStep(sessions.abb, { sequence: 1, type: 'indiening', status: 'ingediend', rule: 'abb-edits-all' }));
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

test('permissions answer with the deciding rule, the same evaluation as the POST; without a target, what the session may request', async () => {
  assert.deepEqual(await service(fakeDb()).permissions(sessions.orgA, IDS.org), { 'can-edit': true, 'can-submit-change-event': true, 'can-decide': false, rules: ['own-organisation'] });
  assert.deepEqual(await service(fakeDb()).permissions(sessions.orgA, IDS.orgB), { 'can-edit': false, 'can-submit-change-event': false, 'can-decide': false, rules: [] });
  assert.deepEqual(await service(fakeDb()).permissions(sessions.abb, IDS.orgB), { 'can-edit': true, 'can-submit-change-event': true, 'can-decide': true, rules: ['abb-edits-all'] });
  await assert.rejects(() => service(fakeDb()).permissions(sessions.orgA, 'ffffffff-ffff-4fff-8fff-ffffffffffff'), { status: 404 });
  const gemeente = await service(fakeDb()).permissions(sessions.orgA, undefined);
  assert.deepEqual(gemeente, { 'can-create': config.creatableClassifications[URIS.gemeenteCode], 'can-decide': false });
  assert.ok(gemeente['can-create'].includes(URIS.ilvCode));
  const abb = await service(fakeDb()).permissions(sessions.abb, undefined);
  assert.equal(abb['can-decide'], true);
  assert.deepEqual(abb['can-create'], registrableClassifications(config), 'every classification the service registers, as ABB may request any');
  for (const onlyAbb of ['8392b885-a875-4b0d-b6a2-b52e53bda454', 'a3922c6d-425b-474f-9a02-ffb71a436bfc', '7a199d27-31c3-44bb-a58f-b3a64673a8b6']) {
    assert.ok(abb['can-create'].some((uri) => uri.endsWith(onlyAbb)), `ABB registers ${onlyAbb}, which no other organisation may request`);
  }
  assert.deepEqual((await service(fakeDb()).permissions({ ...sessions.orgA, actor: { ...sessions.orgA.actor, classification: null } }, undefined))['can-create'], []);
});

// --- base values and conflicts at submission --------------------------------------------------

test('a stale form: a key someone changed since is a conflict; an edit is then refused with 409 and the conflicts, and nothing is written', async () => {
  const db = fakeDb({ master: withName('Aalst (ABB)') });
  await assert.rejects(() => service(db).create(sessions.orgA, rename('Aalst (A)', 'Aalst')), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.title, 'The change conflicts with changes made since the form was loaded');
    assert.match(error.detail, /^1 conflict with what changed since the form was loaded; nothing was saved\. Reload the form and save the change again$/);
    assert.deepEqual(error.meta.conflicts, [nameConflict]);
    assert.match(error.meta['conflicts-token'], /^[0-9a-f]{64}$/);
    assert.deepEqual(error.meta.competing, []);
    return true;
  });
  assert.equal(db.updates.length, 0, 'an edit is applied at once or not at all: nothing waits for ABB');
  await assert.rejects(() => service(fakeDb({ master: withName('Aalst (ABB)') })).create(sessions.abb, rename('Aalst (A)', 'Aalst')), { status: 409 }, 'for ABB as well');
});

test('the same stale form changing only another attribute applies that one and leaves the newer name alone', async () => {
  const db = fakeDb({ master: withName('Aalst (ABB)') });
  const ops = [
    { op: 'update', data: { type: 'administrative-units', id: IDS.org, attributes: { name: 'Aalst', 'legal-name': 'Stad Aalst' }, meta: { base: { attributes: { name: 'Aalst', 'legal-name': null } } } } },
  ];
  const { document } = await service(db).create(sessions.orgA, body(IDS.org, 'organization-core-data', ops));
  assert.equal(document.attributes.status, 'afgehandeld');
  assert.deepEqual(document.attributes.conflicts, []);
  const apply = db.updates[1];
  assert.ok(apply.includes(`<${URIS.org}> <${NS.regorg}legalName> """Stad Aalst""" .`));
  assert.ok(!apply.includes(prefLabel), 'the name is neither deleted nor written');
});

test('competing requests: other pending requests that write the same key with another value are listed, on the conflict and as competing', async () => {
  const db = fakeDb({
    master: withName('Aalst (ABB)'),
    requests: [requestRow(7, 'ingediend'), requestRow(8, 'informatie-gevraagd')],
    storedVersions: [...storedRename(7, 'Aalst (B)'), ...storedRename(8, 'Aalst (A)')],
  });
  await assert.rejects(() => service(db).create(sessions.orgA, rename('Aalst (A)', 'Aalst')), (error) => {
    assert.equal(error.status, 409);
    assert.deepEqual(error.meta.conflicts[0]['competing-requests'], [RID(7)], 'the other one proposes the same name: it agrees; one that waits for an answer competes too');
    assert.deepEqual(error.meta.competing, [{ resource: { type: 'administrative-units', id: IDS.org }, key: 'name', proposed: 'Aalst (A)', 'competing-requests': [RID(7)] }]);
    return true;
  });
  assert.ok(db.queries.some((q) => q.includes(`VALUES (?master ?p) { (<${URIS.org}> <${prefLabel}>) }`)));
  // without a conflict the competing keys come with the applied request
  const agreed = fakeDb({ requests: [requestRow(7, 'ingediend')], storedVersions: storedRename(7, 'Aalst (B)') });
  const { document } = await service(agreed).create(sessions.orgA, rename('Aalst (A)', 'Aalst'));
  assert.equal(document.attributes.status, 'afgehandeld');
  assert.deepEqual(document.attributes.competing.map((key) => key['competing-requests']), [[RID(7)]]);
});

test('a relationship conflict shows the records as identifiers, the current one looked up by uri', async () => {
  const other = 'http://data.lblod.info/id/vestigingen/e5e5e5e5-0000-4000-8000-000000000001';
  const db = fakeDb({ master: { ...masterState(), [`${URIS.org} ${NS.org}hasPrimarySite`]: [uri(other)] }, uuids: { [other]: 'e5e5e5e5-0000-4000-8000-000000000001' } });
  const ops = [
    { op: 'update', data: { type: 'administrative-units', id: IDS.org, relationships: { 'primary-site': { data: { type: 'sites', id: IDS.site } } }, meta: { base: { relationships: { 'primary-site': { data: null } } } } } },
  ];
  await assert.rejects(() => service(db).create(sessions.orgA, body(IDS.org, 'organization-core-data', ops)), (error) => {
    assert.equal(error.status, 409);
    assert.deepEqual(error.meta.conflicts, [
      {
        resource: { type: 'administrative-units', id: IDS.org },
        key: 'primary-site',
        base: null,
        current: { type: 'sites', id: 'e5e5e5e5-0000-4000-8000-000000000001' },
        proposed: { type: 'sites', id: IDS.site },
        'master-exists': true,
        'competing-requests': [],
      },
    ]);
    return true;
  });
});

test('a base may refer to a record deleted since: it is found through its versions', async () => {
  const gone = 'd0d0d0d0-0000-4000-8000-000000000001';
  const goneUri = `http://data.lblod.info/id/contact-punten/${gone}`;
  const db = fakeDb({ former: { [gone]: goneUri } });
  // the page loaded the old contact and one that was deleted meanwhile, and removes the latter
  const ops = [
    {
      op: 'update',
      data: {
        type: 'sites',
        id: IDS.site,
        relationships: { contacts: { data: [{ type: 'contact-points', id: IDS.oldContact }] } },
        meta: { base: { relationships: { contacts: { data: [{ type: 'contact-points', id: IDS.oldContact }, { type: 'contact-points', id: gone }] } } } },
      },
    },
  ];
  const { document } = await service(db).create(sessions.orgA, body(IDS.org, 'organization-core-data', ops));
  assert.equal(document.attributes.status, 'afgehandeld');
  assert.ok(db.queries.some((q) => q.includes('SELECT DISTINCT ?uuid ?uri') && q.includes(gone)));
  assert.ok(!db.updates[0].includes('cr:ProposedVersion'), 'the master already holds the proposal: agreement, nothing to write');
});

// --- reading requests -------------------------------------------------------------------------

const RID = (n) => testUuid('request', n);
const SID = (n, sequence) => testUuid('step', n * 10 + sequence);
const REQUEST = (n) => `http://data.lblod.info/id/change-requests/${RID(n)}`;
/**
 * A stored request n with a status: by default a change event about organisation A that A submitted,
 * the kind that waits for ABB (an edit, aggregate organization-core-data, is applied at once).
 */
const requestRow = (n, status, extra = {}) => ({
  request: REQUEST(n),
  uuid: RID(n),
  created: '2026-11-03T10:12:00Z',
  status: STATUS[status],
  aggregate: 'change-event',
  target: URIS.org,
  targetUuid: IDS.org,
  requestingOrganisation: URIS.org,
  requestingOrganisationUuid: IDS.org,
  creator: URIS.person,
  ...extra,
});
const STEP = (n, sequence) => `http://data.lblod.info/id/change-request-actions/${SID(n, sequence)}`;
const stepRow = (n, sequence, type, status, extra = {}) => ({
  request: REQUEST(n),
  step: STEP(n, sequence),
  stepUuid: SID(n, sequence),
  sequence: String(sequence),
  type: STEP_TYPE[type],
  status: STATUS[status],
  at: `2026-11-03T10:1${sequence}:00Z`,
  agent: URIS.person,
  agentUuid: sessions.orgA.personUuid,
  organisation: URIS.org,
  organisationUuid: IDS.org,
  rule: 'own-organisation',
  ...extra,
});
const serviceStep = { agent: SERVICE_AGENT, agentUuid: null, organisation: null, organisationUuid: null, rule: 'edits-apply-at-once' };
const handlingStep = { ...serviceStep, rule: null };
/** The three steps of a request the service approved and applied at once. */
const appliedTrail = (n, extra = {}) => [stepRow(n, 1, 'indiening', 'ingediend', extra), stepRow(n, 2, 'goedkeuring', 'goedgekeurd', serviceStep), stepRow(n, 3, 'afhandeling', 'afgehandeld', handlingStep)];
/**
 * The stored rows of a version of request n (number: the version's own number, n by default):
 * operation update or delete; keys [{ predicate, proposed: [bindings], base: [bindings] }] go to
 * the version and its base state, links [{ predicate, subject }] to the links its base state
 * remembers (a tombstone's).
 */
const storedVersion = (n, { operation = 'update', master = URIS.org, masterUuid = IDS.org, type = 'administrative-units', keys = [], links = [], number = n }) => {
  const version = `http://data.lblod.info/id/proposed-versions/${testUuid('version', number)}`;
  const baseUri = `http://data.lblod.info/id/record-states/${testUuid('state', number)}`;
  const linkUri = (index) => `http://data.lblod.info/id/record-links/${testUuid('link', 100 * number + index)}`;
  const row = (p, o, record = {}) => ({ request: uri(REQUEST(n)), version: uri(version), master: uri(master), masterUuid: literal(masterUuid), type: literal(type), operation: uri(OPERATION[operation]), p: uri(p), o, ...record });
  const base = { base: uri(baseUri) };
  return [
    row(`${NS.rdf}type`, uri(`${NS.cr}ProposedVersion`)),
    row(`${NS.mu}uuid`, literal(testUuid('version', number))),
    row(`${NS.cr}base`, uri(baseUri)),
    ...keys.map(({ predicate }) => row(`${NS.cr}changesProperty`, uri(predicate))),
    ...keys.flatMap(({ predicate, proposed = [] }) => proposed.map((o) => row(predicate, o))),
    row(`${NS.rdf}type`, uri(`${NS.cr}RecordState`), base),
    row(`${NS.mu}uuid`, literal(testUuid('state', number)), base),
    row(`${NS.dct}isVersionOf`, uri(master), base),
    ...keys.flatMap(({ predicate, base: values = [] }) => values.map((o) => row(predicate, o, base))),
    ...links.flatMap(({ predicate, subject }, index) => [
      row(`${NS.cr}incomingLink`, uri(linkUri(index)), base),
      row(`${NS.rdf}type`, uri(`${NS.rdf}Statement`), { ...base, link: uri(linkUri(index)) }),
      row(`${NS.rdf}subject`, uri(subject), { ...base, link: uri(linkUri(index)) }),
      row(`${NS.rdf}predicate`, uri(predicate), { ...base, link: uri(linkUri(index)) }),
      row(`${NS.rdf}object`, uri(master), { ...base, link: uri(linkUri(index)) }),
    ]),
  ];
};
/** The rows of a state step (sequence) of request n replaced: values [[predicate, binding]] of master. */
const replacedState = (n, sequence, { master = URIS.org, values = [], number = n }) => {
  const state = `http://data.lblod.info/id/record-states/${testUuid('state', 500 + number)}`;
  const row = (p, o) => ({ request: uri(REQUEST(n)), step: uri(STEP(n, sequence)), state: uri(state), master: uri(master), p: uri(p), o });
  return [row(`${NS.rdf}type`, uri(`${NS.cr}RecordState`)), row(`${NS.dct}isVersionOf`, uri(master)), ...values.map(([p, o]) => row(p, o))];
};
/** The stored rename of request n: base "Aalst", proposal "Aalst (A)". */
const storedRename = (n, proposed = 'Aalst (A)', base = 'Aalst') => storedVersion(n, { keys: [{ predicate: prefLabel, proposed: [literal(proposed)], base: [literal(base)] }] });

// An edit ABB made of organisation A, applied at once: history, listed only when edits are asked for.
const abbRequest = requestRow(1, 'afgehandeld', { aggregate: 'organization-core-data', requestingOrganisation: URIS.abb, requestingOrganisationUuid: IDS.abb, creator: URIS.personAbb });
const abbSteps = { agent: URIS.personAbb, agentUuid: sessions.abb.personUuid, organisation: URIS.abb, organisationUuid: IDS.abb, rule: 'abb-edits-all' };

test('a listed request shows its status, steps and organisations; the person who submitted it only to its organisation and ABB', async () => {
  const db = fakeDb({ requests: [abbRequest], steps: appliedTrail(1, abbSteps) });
  const { documents: list, count } = await service(db).list(sessions.orgA, { target: IDS.org, kinds: ['edit'] });
  assert.equal(list.length, 1);
  assert.equal(count, 1);
  assert.deepEqual(list[0].attributes, {
    status: 'afgehandeld',
    ...listed,
    mine: false,
    created: '2026-11-03T10:12:00.000Z',
    'applied-at': '2026-11-03T10:13:00.000Z',
    aggregate: 'organization-core-data',
    error: null,
    steps: [
      userStep(sessions.abb, { sequence: 1, type: 'indiening', status: 'ingediend', at: '2026-11-03T10:11:00.000Z', rule: 'abb-edits-all', person: null }),
      { ...serviceApproval, at: '2026-11-03T10:12:00.000Z' },
      { ...serviceHandling, at: '2026-11-03T10:13:00.000Z' },
    ],
    conflicts: [],
    'conflicts-token': null,
    competing: [],
    'replaced-by': null,
  });
  assert.deepEqual(list[0].relationships['requesting-organisation'].data, { type: 'organizations', id: IDS.abb });
  assert.deepEqual(list[0].relationships.target, { data: { type: 'organizations', id: IDS.org } }, 'the organisation exists: no pending flag');
  const byAbb = (await service(db).list(sessions.abb, { target: IDS.org, kinds: ['edit'] })).documents[0].attributes;
  assert.equal(byAbb.steps[0].person, sessions.abb.personUuid, 'ABB sees who submitted it');
  assert.equal(byAbb.mine, true);
  const failed = await service(fakeDb({ requests: [requestRow(2, 'mislukt')], steps: [stepRow(2, 1, 'indiening', 'ingediend'), stepRow(2, 2, 'goedkeuring', 'goedgekeurd', serviceStep), stepRow(2, 3, 'afhandeling', 'mislukt', { ...handlingStep, error: 'Virtuoso said no' })] })).get(sessions.orgA, RID(2));
  assert.equal(failed.attributes.error, 'Virtuoso said no', 'the message of the oslc:Error of its last step');
  assert.equal(failed.attributes.status, 'mislukt');
});

test('everyone sees every request; with pendingVisibleTo "involved" an organisation sees its own, those about it and the decided ones, and ABB still all', async () => {
  const db = fakeDb({ requests: [abbRequest] });
  await service(db).list(sessions.orgA, { target: IDS.org });
  const pageQuery = db.queries.find((q) => q.includes('SELECT DISTINCT ?request ?created'));
  const countQuery = db.queries.find((q) => q.includes('SELECT (COUNT(DISTINCT ?request) AS ?count)'));
  for (const q of [pageQuery, countQuery]) {
    assert.ok(q.includes(`FILTER(?target = <${URIS.org}>)`));
    assert.ok(!q.includes('?requestingOrganisation = <'), 'no visibility filter: everyone sees all');
  }
  const involved = fakeDb({ requests: [abbRequest] });
  await configured(involved, { pendingVisibleTo: 'involved' }).list(sessions.orgB);
  const decided = ['goedgekeurd', 'afgehandeld', 'afgekeurd', 'ingetrokken', 'mislukt'].map((key) => `<${STATUS[key]}>`).join(', ');
  const filter = `FILTER(?target = <${URIS.orgB}> || ?requestingOrganisation = <${URIS.orgB}> || ?status IN (${decided}))`;
  const selecting = (q) => q.includes('SELECT DISTINCT ?request ?created') || q.includes('SELECT (COUNT(DISTINCT ?request) AS ?count)');
  assert.ok(involved.queries.filter(selecting).every((q) => q.includes(filter)), 'an organisation that is not involved sees the decided requests only, not the waiting ones');
  const all = fakeDb({ requests: [abbRequest] });
  await configured(all, { pendingVisibleTo: 'involved' }).list(sessions.abb);
  assert.ok(all.queries.filter((q) => q.includes('?request a cr:ChangeRequest')).every((q) => !q.includes('FILTER')), 'ABB sees all, unfiltered');
  assert.deepEqual(await service(db).list(sessions.orgA, { target: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }), { documents: [], count: 0 }, 'a filter on an unknown organisation is an empty list');
});

test('listing is paged, oldest first by default or newest first: the steps, versions and current values are read for the requests of the page only', async () => {
  const at = (minute) => `2026-11-03T10:${String(minute).padStart(2, '0')}:00Z`;
  const requests = [1, 2, 3, 4, 5].map((n) => requestRow(n, n === 4 ? 'ingediend' : 'afgehandeld', { created: at(n) }));
  const db = fakeDb({ requests, steps: [stepRow(4, 1, 'indiening', 'ingediend'), ...appliedTrail(5)], storedVersions: [...storedRename(4), ...storedRename(5)] });
  const oldest = await service(db).list(sessions.abb, { statuses: [], page: { number: 0, size: 2 } });
  assert.deepEqual(oldest.documents.map((document) => document.id), [RID(1), RID(2)], 'oldest first by default');
  assert.ok(db.queries.find((q) => q.includes('SELECT DISTINCT ?request ?created')).includes('ORDER BY ASC(?created) ASC(?request)\nLIMIT 2\nOFFSET 0'));
  db.queries.length = 0;
  const first = await service(db).list(sessions.abb, { statuses: [], sort: '-created', page: { number: 0, size: 2 } });
  assert.deepEqual(first.documents.map((document) => document.id), [RID(5), RID(4)]);
  assert.equal(first.count, 5);
  assert.ok(db.queries.find((q) => q.includes('SELECT DISTINCT ?request ?created')).includes('ORDER BY DESC(?created) DESC(?request)\nLIMIT 2\nOFFSET 0'));
  for (const q of db.queries.filter((query) => query.includes('SELECT DISTINCT ?request ?uuid ?created') || query.includes('SELECT DISTINCT ?request ?step ?stepUuid'))) {
    assert.ok(q.includes(`VALUES ?request { <${REQUEST(5)}> <${REQUEST(4)}> }`), 'the details of the page');
  }
  const versionQueries = db.queries.filter((q) => q.includes('SELECT ?request ?version ?master')).map((q) => valuesOf(q, 'request'));
  assert.deepEqual(versionQueries.map((uris) => uris.join(' ')).sort(), [REQUEST(4), REQUEST(5)].sort(), 'the versions of its pending request (live conflicts) and of its applied one (what it overrode)');
  assert.ok(db.queries.some((q) => q.includes('SELECT ?request ?step ?state ?master') && valuesOf(q, 'request').join(' ') === REQUEST(5)), 'the states the goedkeuring replaced');
  const last = await service(db).list(sessions.abb, { statuses: [], sort: '-created', page: { number: 2, size: 2 } });
  assert.deepEqual(last.documents.map((document) => document.id), [RID(1)]);
  const pending = await service(db).list(sessions.abb, { statuses: ['ingediend'], page: { number: 0, size: 20 } });
  assert.deepEqual([pending.documents.map((document) => document.id), pending.count], [[RID(4)], 1]);
  assert.ok(db.queries.at(-1).includes(`VALUES ?status { <${STATUS.ingediend}> }`) || db.queries.some((q) => q.includes(`VALUES ?status { <${STATUS.ingediend}> }`)));
});

test('the list query: the filters, sort, page[number] and page[size], with JSON:API links', () => {
  const none = { target: undefined, statuses: [], kinds: [], mine: false, requester: undefined, targetClassification: undefined, created: { from: undefined, until: undefined }, sort: 'created', page: { number: 0, size: 20 } };
  assert.deepEqual(parseListQuery({}), none);
  const query = parseListQuery({ filter: { target: IDS.org, status: 'ingediend,mislukt' }, page: { number: '1', size: '10' } });
  assert.deepEqual(query, { ...none, target: IDS.org, statuses: ['ingediend', 'mislukt'], page: { number: 1, size: 10 } });
  const full = parseListQuery({ filter: { mine: 'true', kind: 'creation,change-event', requester: IDS.org, 'target-classification': IDS.ilvCode, created: { gte: '2026-10-01', lte: '2026-10-31T23:59:59Z' } }, sort: '-created' });
  assert.deepEqual(full, { ...none, mine: true, kinds: ['creation', 'change-event'], requester: IDS.org, targetClassification: IDS.ilvCode, created: { from: '2026-10-01T00:00:00.000Z', until: '2026-10-31T23:59:59.000Z' }, sort: '-created' });
  assert.deepEqual(pageLinks(full, 5), {
    first: `/change-requests?filter%5Bkind%5D=creation%2Cchange-event&filter%5Bmine%5D=true&filter%5Brequester%5D=${IDS.org}&filter%5Btarget-classification%5D=${IDS.ilvCode}&filter%5Bcreated%5D%5Bgte%5D=2026-10-01T00%3A00%3A00.000Z&filter%5Bcreated%5D%5Blte%5D=2026-10-31T23%3A59%3A59.000Z&sort=-created&page%5Bnumber%5D=0&page%5Bsize%5D=20`,
    last: `/change-requests?filter%5Bkind%5D=creation%2Cchange-event&filter%5Bmine%5D=true&filter%5Brequester%5D=${IDS.org}&filter%5Btarget-classification%5D=${IDS.ilvCode}&filter%5Bcreated%5D%5Bgte%5D=2026-10-01T00%3A00%3A00.000Z&filter%5Bcreated%5D%5Blte%5D=2026-10-31T23%3A59%3A59.000Z&sort=-created&page%5Bnumber%5D=0&page%5Bsize%5D=20`,
  });
  for (const bad of [{ filter: { status: 'pending' } }, { filter: { status: ['ingediend'] } }, { filter: { kind: 'edits' } }, { filter: { mine: 'yes' } }, { filter: { requester: '' } }, { filter: { created: 'yesterday' } }, { filter: { created: { gte: 'yesterday' } } }, { sort: 'status' }, { page: { size: '0' } }, { page: { size: '101' } }, { page: { number: '-1' } }, { page: { number: 'x' } }]) {
    assert.throws(() => parseListQuery(bad), { status: 400 }, JSON.stringify(bad));
  }
  assert.deepEqual(pageLinks(query, 35), {
    first: `/change-requests?filter%5Btarget%5D=${IDS.org}&filter%5Bstatus%5D=ingediend%2Cmislukt&page%5Bnumber%5D=0&page%5Bsize%5D=10`,
    last: `/change-requests?filter%5Btarget%5D=${IDS.org}&filter%5Bstatus%5D=ingediend%2Cmislukt&page%5Bnumber%5D=3&page%5Bsize%5D=10`,
    prev: `/change-requests?filter%5Btarget%5D=${IDS.org}&filter%5Bstatus%5D=ingediend%2Cmislukt&page%5Bnumber%5D=0&page%5Bsize%5D=10`,
    next: `/change-requests?filter%5Btarget%5D=${IDS.org}&filter%5Bstatus%5D=ingediend%2Cmislukt&page%5Bnumber%5D=2&page%5Bsize%5D=10`,
  });
  assert.deepEqual(Object.keys(pageLinks(parseListQuery({}), 0)), ['first', 'last'], 'one empty page');
});

test('a single request is a 404 when it is not visible: never while everyone sees all, for the uninvolved while pending requests are for the involved', async () => {
  const found = await service(fakeDb({ requests: [abbRequest] })).get(sessions.orgA, RID(1));
  assert.equal(found.id, RID(1));
  assert.equal((await service(fakeDb({ requests: [abbRequest] })).get(sessions.orgB, RID(1))).id, RID(1), 'an applied request of another organisation');
  const pending = { requests: [requestRow(5, 'ingediend')], steps: [stepRow(5, 1, 'indiening', 'ingediend')], storedVersions: storedRename(5) };
  assert.equal((await service(fakeDb(pending)).get(sessions.orgB, RID(5))).id, RID(5), 'a pending one too');
  await assert.rejects(() => configured(fakeDb(pending), { pendingVisibleTo: 'involved' }).get(sessions.orgB, RID(5)), { status: 404 });
  assert.equal((await configured(fakeDb(pending), { pendingVisibleTo: 'involved' }).get(sessions.orgA, RID(5))).id, RID(5), 'its own');
  assert.equal((await configured(fakeDb({ requests: [abbRequest] }), { pendingVisibleTo: 'involved' }).get(sessions.orgB, RID(1))).id, RID(1), 'an applied one');
});

test('a request shows its steps in sequence order, with person, organisation, rule, reason and error', async () => {
  const steps = [
    stepRow(3, 4, 'hertoepassing', 'afgehandeld', { at: '2026-11-03T11:00:00Z' }),
    stepRow(3, 1, 'indiening', 'ingediend'),
    stepRow(3, 2, 'goedkeuring', 'goedgekeurd', serviceStep),
    stepRow(3, 3, 'afhandeling', 'mislukt', { ...handlingStep, error: 'Virtuoso said no' }),
  ];
  const document = await service(fakeDb({ requests: [requestRow(3, 'afgehandeld')], steps })).get(sessions.orgA, RID(3));
  assert.deepEqual(document.attributes.steps.map((step) => [step.sequence, step.type, step.status, step.agent, step.error]), [
    [1, 'indiening', 'ingediend', 'user', null],
    [2, 'goedkeuring', 'goedgekeurd', 'service', null],
    [3, 'afhandeling', 'mislukt', 'service', 'Virtuoso said no'],
    [4, 'hertoepassing', 'afgehandeld', 'user', null],
  ]);
  assert.equal(document.attributes['applied-at'], '2026-11-03T11:00:00.000Z', 'the start of the last afgehandeld step');
  assert.equal(document.attributes.error, null, 'the error of the last step');
  const rejected = await service(fakeDb({
    requests: [requestRow(4, 'afgekeurd')],
    steps: [stepRow(4, 1, 'indiening', 'ingediend'), stepRow(4, 2, 'afkeuring', 'afgekeurd', { agent: URIS.personAbb, agentUuid: sessions.abb.personUuid, organisation: URIS.abb, organisationUuid: IDS.abb, rule: 'abb-decides-all', reason: 'Fout KBO-nummer' })],
  })).get(sessions.orgA, RID(4));
  assert.deepEqual(rejected.attributes.steps[1], {
    sequence: 2, type: 'afkeuring', status: 'afgekeurd', at: '2026-11-03T10:12:00.000Z', agent: 'user', person: sessions.abb.personUuid, organisation: IDS.abb, rule: 'abb-decides-all', reason: 'Fout KBO-nummer', error: null, 'overrides-conflict': false, 'overridden-conflicts': [],
  });
  assert.equal(rejected.attributes.status, 'afgekeurd');
  assert.equal(rejected.attributes['applied-at'], null);
});

test('a pending request shows its live conflicts, in the list and alone; a decided request is not checked', async () => {
  const pending = { requests: [requestRow(5, 'ingediend'), requestRow(6, 'afgehandeld')], steps: [stepRow(5, 1, 'indiening', 'ingediend'), ...appliedTrail(6)], storedVersions: [...storedRename(5), ...storedRename(6)] };
  const renamed = fakeDb({ ...pending, master: withName('Aalst (ABB)') });
  const { documents: list } = await service(renamed).list(sessions.orgA, { target: IDS.org });
  assert.deepEqual(list.find((d) => d.id === RID(5)).attributes.conflicts, [nameConflict]);
  assert.deepEqual(list.find((d) => d.id === RID(6)).attributes.conflicts, [], 'a decided request is not checked against the current values');
  assert.deepEqual(list.find((d) => d.id === RID(6)).attributes.steps[2]['overridden-conflicts'], [], 'its afhandeling replaced no states here, so it overrode nothing');
  assert.equal((await service(renamed).get(sessions.orgA, RID(5))).attributes.conflicts.length, 1);
  assert.deepEqual((await service(fakeDb(pending)).get(sessions.orgA, RID(5))).attributes.conflicts, [], 'nothing changed since: no conflict');
});

// --- POST /change-requests/:id/steps ------------------------------------------------------------

const step = (stepType, attributes = {}) => ({ data: { type: 'change-request-steps', attributes: { 'step-type': stepType, ...attributes } } });
const pendingDb = (options = {}) => fakeDb({ requests: [requestRow(5, 'ingediend')], steps: [stepRow(5, 1, 'indiening', 'ingediend')], storedVersions: storedRename(5), ...options });

test('ABB approves a pending request: its goedkeuring is recorded and the afhandeling applies the stored versions, in one update', async () => {
  const db = pendingDb();
  const { status, document } = await service(db).addStep(sessions.abb, RID(5), step('goedkeuring', { reason: 'In orde' }));
  assert.equal(status, 201);
  assert.equal(document.attributes.status, 'afgehandeld');
  assert.deepEqual(document.attributes.steps[1], userStep(sessions.abb, { sequence: 2, type: 'goedkeuring', status: 'goedgekeurd', rule: 'abb-decides-all', reason: 'In orde' }));
  assert.deepEqual(document.attributes.steps[2], serviceHandling, 'the service applied it a moment later');
  assert.equal(document.attributes['applied-at'], '2026-11-03T10:12:01.000Z');
  assert.equal(writes(db).length, 1);
  assert.deepEqual(statusesSet(db), ['afgehandeld'], 'the status once the apply went through');
  const apply = writes(db)[0];
  assert.ok(apply.includes(`<${URIS.org}> <${prefLabel}> """Aalst (A)""" .`), 'the stored proposal');
  assert.ok(apply.includes(`dct:type <${STEP_TYPE.goedkeuring}> ;\n      adms:status <${STATUS.goedgekeurd}> ;\n      schema:position "2"^^xsd:integer ;`));
  assert.ok(apply.includes(`prov:wasAssociatedWith <${URIS.personAbb}> ;\n      cr:actingOrganisation <${URIS.abb}> ;\n      cr:rule """abb-decides-all""" ;\n      dct:description """In orde""" .`));
  assert.ok(apply.includes(`dct:type <${STEP_TYPE.afhandeling}> ;\n      adms:status <${STATUS.afgehandeld}> ;\n      schema:position "3"^^xsd:integer ;`));
  assert.ok(apply.includes(`prov:wasAssociatedWith <${SERVICE_AGENT}> ;\n      prov:invalidated <`), 'the afhandeling replaced the states');
  assert.ok(apply.includes(`dct:isVersionOf <${URIS.org}> ;\n      <${prefLabel}> """Aalst""" .`), 'the state it replaced: the name as the form had it, so nothing overridden');
  assert.equal(document.attributes.steps[2]['overrides-conflict'], false);
  assert.ok(apply.includes(`ext:lastModifiedBy <${URIS.person}>`), 'the stamp names the person who submitted the change');
});

test('a goedkeuring re-checks the conflicts: 409 with them and their token; with that token as override it applies, and the step records what it overrode', async () => {
  const conflicted = pendingDb({ master: withName('Aalst (ABB)') });
  let token;
  await assert.rejects(() => service(conflicted).addStep(sessions.abb, RID(5), step('goedkeuring')), (error) => {
    assert.equal(error.status, 409);
    assert.deepEqual(error.meta.conflicts, [nameConflict]);
    token = error.meta['conflicts-token'];
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.ok(error.detail.endsWith(`approve with "override": "${token}" to apply it anyway`), error.detail);
    return true;
  });
  assert.equal((await service(conflicted).get(sessions.abb, RID(5))).attributes['conflicts-token'], token, 'GET shows the same token');
  assert.equal(conflicted.updates.length, 0);
  const { document } = await service(conflicted).addStep(sessions.abb, RID(5), step('goedkeuring', { override: token }));
  assert.equal(document.attributes.status, 'afgehandeld');
  const { 'competing-requests': _competing, ...overridden } = nameConflict;
  assert.equal(document.attributes.steps[2]['overrides-conflict'], true, 'on the afhandeling that applied it');
  assert.deepEqual(document.attributes.steps[2]['overridden-conflicts'], [overridden]);
  assert.ok(conflicted.updates[0].includes(`dct:isVersionOf <${URIS.org}> ;\n      <${prefLabel}> """Aalst (ABB)""" .`), 'the state the step replaced keeps the name it overwrote');
  assert.ok(!conflicted.updates[0].includes('overrid'), 'no JSON of the conflicts');
});

test('a decided request shows the conflicts its afhandeling overrode, derived from the states it replaced', async () => {
  const decided = (name) =>
    fakeDb({
      requests: [requestRow(6, 'afgehandeld')],
      steps: [stepRow(6, 1, 'indiening', 'ingediend'), stepRow(6, 2, 'goedkeuring', 'goedgekeurd', { agent: URIS.personAbb, agentUuid: sessions.abb.personUuid, organisation: URIS.abb, organisationUuid: IDS.abb, rule: 'abb-decides-all' }), stepRow(6, 3, 'afhandeling', 'afgehandeld', handlingStep)],
      storedVersions: storedRename(6),
      replacedStates: replacedState(6, 3, { values: [[prefLabel, literal(name)]] }),
      master: withName('Aalst (A)'),
    });
  const { 'competing-requests': _competing, ...overridden } = nameConflict;
  const [, , approval] = (await service(decided('Aalst (ABB)')).get(sessions.orgA, RID(6))).attributes.steps;
  assert.deepEqual([approval['overrides-conflict'], approval['overridden-conflicts']], [true, [overridden]], 'ABB had renamed it: the approval overwrote that');
  const [, , plain] = (await service(decided('Aalst')).get(sessions.orgA, RID(6))).attributes.steps;
  assert.deepEqual([plain['overrides-conflict'], plain['overridden-conflicts']], [false, []], 'as the form had it: nothing overridden');
});

test('an override covers the conflicts the approver reviewed and no others: a change made since gives another 409 and token', async () => {
  const legalName = `${NS.regorg}legalName`;
  // R5 renames the organisation (from "Aalst") and sets its legal name (empty when the form loaded it)
  const keys = [
    { predicate: prefLabel, proposed: [literal('Aalst (A)')], base: [literal('Aalst')] },
    { predicate: legalName, proposed: [literal('Stad Aalst')], base: [] },
  ];
  const db = pendingDb({ storedVersions: storedVersion(5, { keys }), master: withName('Aalst (ABB)') });
  const reviewed = (await service(db).get(sessions.abb, RID(5))).attributes;
  assert.deepEqual(reviewed.conflicts.map((conflict) => conflict.key), ['name']);
  // while ABB reviews, a fresh form sets the legal name
  db.state.master[`${URIS.org} ${legalName}`] = [literal('Stad Aalst NV')];
  await assert.rejects(() => service(db).addStep(sessions.abb, RID(5), step('goedkeuring', { override: reviewed['conflicts-token'] })), (error) => {
    assert.equal(error.status, 409);
    assert.deepEqual(error.meta.conflicts.map((conflict) => [conflict.key, conflict.current]), [['name', 'Aalst (ABB)'], ['legal-name', 'Stad Aalst NV']]);
    assert.notEqual(error.meta['conflicts-token'], reviewed['conflicts-token']);
    assert.match(error.detail, /^The conflicts changed since they were reviewed: 2 conflicts now/);
    return true;
  });
  assert.equal(db.updates.length, 0, 'the newer legal name is not overwritten');
});

test('a request that updates a record deleted since cannot be applied, also not with override; it is rejected or withdrawn, also once its apply failed', async () => {
  const siteTypeName = `${NS.dct}description`;
  const siteRename = storedVersion(5, { master: URIS.site, masterUuid: IDS.site, type: 'sites', keys: [{ predicate: siteTypeName, proposed: [literal('C')], base: [literal('A')] }] });
  const deleted = { ...masterState(), [`${URIS.site} ${NS.rdf}type`]: [] };
  const db = pendingDb({ storedVersions: siteRename, master: deleted });
  const shown = (await service(db).get(sessions.abb, RID(5))).attributes;
  assert.deepEqual(shown.conflicts, [{ resource: { type: 'sites', id: IDS.site }, key: 'site-type-name', base: 'A', current: null, proposed: 'C', 'master-exists': false, 'competing-requests': [] }]);
  const missing = { status: 409, title: 'The change request changes records that no longer exist', meta: { 'missing-records': [{ type: 'sites', id: IDS.site }] } };
  await assert.rejects(() => service(db).addStep(sessions.abb, RID(5), step('goedkeuring')), missing);
  await assert.rejects(() => service(db).addStep(sessions.abb, RID(5), step('goedkeuring', { override: shown['conflicts-token'] })), missing, 'override cannot pass');
  assert.equal(db.updates.length, 0);
  const failed = () => failedDb({ storedVersions: storedVersion(2, { master: URIS.site, masterUuid: IDS.site, type: 'sites', keys: [{ predicate: siteTypeName, proposed: [literal('C')], base: [literal('A')] }] }), master: deleted });
  await assert.rejects(() => service(failed()).addStep(sessions.orgA, RID(2), step('hertoepassing')), missing);
  const rejected = await service(failed()).addStep(sessions.abb, RID(2), step('afkeuring', { reason: 'De vestiging bestaat niet meer' }));
  assert.deepEqual(rejected.document.attributes.steps.map((s) => [s.sequence, s.type, s.status]).at(-1), [4, 'afkeuring', 'afgekeurd']);
  const withdrawn = await service(failed()).addStep(sessions.orgA, RID(2), step('intrekking'));
  assert.equal(withdrawn.document.attributes.status, 'ingetrokken');
});

test('ABB rejects a pending request with a reason (afkeuring); a rejection needs a reason', async () => {
  const db = pendingDb();
  const { status, document } = await service(db).addStep(sessions.abb, RID(5), step('afkeuring', { reason: 'Het KBO-nummer hoort bij een andere organisatie' }));
  assert.equal(status, 201);
  assert.equal(document.attributes.status, 'afgekeurd');
  assert.deepEqual(document.attributes.steps[1], userStep(sessions.abb, { sequence: 2, type: 'afkeuring', status: 'afgekeurd', rule: 'abb-decides-all', reason: 'Het KBO-nummer hoort bij een andere organisatie' }));
  assert.equal(writes(db).length, 1);
  assert.deepEqual(statusesSet(db), ['afgekeurd']);
  assert.ok(!writes(db)[0].includes('http://mu.semte.ch/application'), 'nothing is applied');
  assert.ok(writes(db)[0].includes(`dct:type <${STEP_TYPE.afkeuring}> ;\n      adms:status <${STATUS.afgekeurd}> ;`) && writes(db)[0].includes('dct:description """Het KBO-nummer hoort bij een andere organisatie"""'));
  for (const reason of [undefined, '', '   ']) {
    await assert.rejects(() => service(pendingDb()).addStep(sessions.abb, RID(5), step('afkeuring', reason === undefined ? {} : { reason })), { status: 422, detail: 'an afkeuring needs a reason', pointer: '/data/attributes/reason' });
  }
});

test('the requesting organisation or ABB withdraws a pending request (intrekking); the target of a request by another does not', async () => {
  const db = pendingDb();
  const { document } = await service(db).addStep(sessions.orgA, RID(5), step('intrekking'));
  assert.equal(document.attributes.status, 'ingetrokken');
  assert.deepEqual(document.attributes.steps[1], userStep(sessions.orgA, { sequence: 2, type: 'intrekking', status: 'ingetrokken', rule: 'requesting-organisation' }));
  assert.equal((await service(pendingDb()).addStep(sessions.abb, RID(5), step('intrekking'))).document.attributes.steps[1].rule, 'abb-edits-all');
  const byAbb = fakeDb({ requests: [requestRow(5, 'ingediend', { requestingOrganisation: URIS.abb, requestingOrganisationUuid: IDS.abb })], steps: [stepRow(5, 1, 'indiening', 'ingediend')] });
  await assert.rejects(() => service(byAbb).addStep(sessions.orgA, RID(5), step('intrekking')), { status: 403, meta: { rule: null, rules: [] } });
  assert.equal(byAbb.updates.length, 0);
});

test('only ABB decides: an organisation approving, rejecting or asking is a 403, also another organisation; a request it cannot see a 404', async () => {
  for (const [stepType, attributes] of [['goedkeuring', {}], ['afkeuring', { reason: 'nee' }], ['informatievraag', { reason: 'welk besluit?' }]]) {
    const db = pendingDb();
    await assert.rejects(() => service(db).addStep(sessions.orgA, RID(5), step(stepType, attributes)), { status: 403, title: `Not allowed to take a ${stepType} step on this change request`, meta: { rule: null, rules: [] } });
    assert.equal(db.updates.length, 0);
  }
  await assert.rejects(() => service(pendingDb()).addStep(sessions.orgB, RID(5), step('goedkeuring')), { status: 403 }, 'everyone sees it; only ABB decides');
  await assert.rejects(() => configured(pendingDb(), { pendingVisibleTo: 'involved' }).addStep(sessions.orgB, RID(5), step('goedkeuring')), { status: 404 });
});

const STEPS_BY_STATUS = {
  ingediend: [[1, 'indiening', 'ingediend']],
  'informatie-gevraagd': [[1, 'indiening', 'ingediend'], [2, 'informatievraag', 'informatie-gevraagd']],
  goedgekeurd: [[1, 'indiening', 'ingediend'], [2, 'goedkeuring', 'goedgekeurd']],
  afgehandeld: [[1, 'indiening', 'ingediend'], [2, 'goedkeuring', 'goedgekeurd'], [3, 'afhandeling', 'afgehandeld']],
  afgekeurd: [[1, 'indiening', 'ingediend'], [2, 'afkeuring', 'afgekeurd']],
  ingetrokken: [[1, 'indiening', 'ingediend'], [2, 'intrekking', 'ingetrokken']],
  mislukt: [[1, 'indiening', 'ingediend'], [2, 'goedkeuring', 'goedgekeurd'], [3, 'afhandeling', 'mislukt']],
};
const ALLOWED = {
  ingediend: ['goedkeuring', 'afkeuring', 'informatievraag', 'intrekking'],
  'informatie-gevraagd': ['informatieantwoord', 'afkeuring', 'intrekking'],
  afgekeurd: ['betwisting'],
  mislukt: ['hertoepassing', 'afkeuring', 'intrekking'],
};
const REPLIES = ['informatieantwoord', 'betwisting'];

test('every step the status does not admit is a 409; afgehandeld and ingetrokken are final, afgekeurd can be contested', async () => {
  for (const [status, trail] of Object.entries(STEPS_BY_STATUS)) {
    for (const stepType of ['indiening', 'afhandeling']) {
      await assert.rejects(() => service(fakeDb({ requests: [requestRow(1, status)] })).addStep(sessions.abb, RID(1), step(stepType)), { status: 422, detail: /^unknown step type/ }, `${stepType} is not a step of the endpoint`);
    }
    for (const stepType of ['goedkeuring', 'afkeuring', 'informatievraag', 'informatieantwoord', 'betwisting', 'intrekking', 'hertoepassing']) {
      if (ALLOWED[status]?.includes(stepType)) continue;
      const db = fakeDb({ requests: [requestRow(1, status)], steps: trail.map(([sequence, type, stepStatus]) => stepRow(1, sequence, type, stepStatus)), storedVersions: storedRename(1) });
      await assert.rejects(() => service(db).addStep(REPLIES.includes(stepType) ? sessions.orgA : sessions.abb, RID(1), step(stepType, { reason: 'x' })), (error) => {
        assert.equal(error.status, 409, `${stepType} after ${status}`);
        assert.match(error.detail, new RegExp(`^Change request "${RID(1)}" has status ${status}`));
        assert.deepEqual(error.meta, { status, 'step-type': stepType });
        return true;
      });
      assert.equal(db.updates.length, 0);
    }
  }
});

test('unknown step types and malformed bodies are a 422; wijziging is reserved', async () => {
  const refused = async (payload, expected) => assert.rejects(() => service(pendingDb()).addStep(sessions.abb, RID(5), payload), { status: 422, ...expected });
  await refused(step('goedkeuren'), { detail: 'unknown step type "goedkeuren"; one of goedkeuring, afkeuring, informatievraag, informatieantwoord, betwisting, intrekking, hertoepassing', pointer: '/data/attributes/step-type' });
  await refused(step('informatievraag'), { detail: 'an informatievraag needs a reason', pointer: '/data/attributes/reason' });
  await refused({ data: { type: 'change-request-steps', attributes: {} } }, { pointer: '/data/attributes/step-type' });
  await refused(step('wijziging'), { detail: 'the step type "wijziging" is reserved and not implemented' });
  await refused({ data: { type: 'steps', attributes: { 'step-type': 'goedkeuring' } } }, { pointer: '/data/type' });
  await refused({}, { pointer: '/data' });
  await refused(step('goedkeuring', { reason: 42 }), { detail: '"reason" must be a string' });
  for (const override of [true, 42, '']) await refused(step('goedkeuring', { override }), { detail: /^"override" must be the "conflicts-token" of the conflicts you reviewed/, pointer: '/data/attributes/override' });
});

test('a step follows the last step', async () => {
  const sequenceOf = (q) => q.match(/schema:position "(\d+)"/)[1];
  const pending = pendingDb();
  await service(pending).addStep(sessions.orgA, RID(5), step('intrekking'));
  assert.equal(sequenceOf(pending.updates[0]), '2');
  const retried = fakeDb({ requests: [requestRow(1, 'mislukt')], steps: STEPS_BY_STATUS.mislukt.map(([sequence, type, status]) => stepRow(1, sequence, type, status)), storedVersions: storedRename(1) });
  const { document } = await service(retried).addStep(sessions.orgA, RID(1), step('hertoepassing'));
  assert.equal(sequenceOf(retried.updates[0]), '4');
  assert.deepEqual(document.attributes.steps.map((s) => [s.sequence, s.type, s.status]), [[1, 'indiening', 'ingediend'], [2, 'goedkeuring', 'goedgekeurd'], [3, 'afhandeling', 'mislukt'], [4, 'hertoepassing', 'afgehandeld']]);
  assert.equal(document.attributes.error, null);
});

// --- hertoepassing and its alias POST /change-requests/:id/apply -----------------------------------

const failedDb = (options = {}) =>
  fakeDb({ requests: [requestRow(2, 'mislukt')], steps: STEPS_BY_STATUS.mislukt.map(([sequence, type, status]) => stepRow(2, sequence, type, status, type === 'goedkeuring' ? serviceStep : type === 'afhandeling' ? { ...handlingStep, error: 'Virtuoso said no' } : {})), storedVersions: storedRename(2), ...options });

test('a failed request is applied again from its stored versions (hertoepassing); /apply is its alias, answered with 200', async () => {
  const db = failedDb();
  const { status, document } = await service(db).apply(sessions.orgA, RID(2));
  assert.equal(status, 200);
  assert.equal(document.id, RID(2));
  assert.equal(document.attributes.status, 'afgehandeld');
  assert.equal(document.attributes.error, null);
  assert.deepEqual(document.attributes.steps.at(-1), userStep(sessions.orgA, { sequence: 4, type: 'hertoepassing', status: 'afgehandeld', rule: 'requesting-organisation' }));
  assert.equal(writes(db).length, 1, 'the apply only, then its status');
  assert.deepEqual(statusesSet(db), ['afgehandeld']);
  assert.ok(writes(db)[0].includes(`VALUES ?s { <${URIS.org}> }\n    VALUES ?p { <${prefLabel}> }`));
  assert.ok(writes(db)[0].includes(`dct:type <${STEP_TYPE.hertoepassing}>`) && !writes(db)[0].includes(`dct:type <${STEP_TYPE.goedkeuring}>`), 'no new goedkeuring: it was approved before');
  const later = db.queries.find((q) => q.includes('SELECT DISTINCT ?request ?uuid ?appliedAt'));
  assert.ok(later.includes(`cr:target <${URIS.org}>`) && later.includes(`FILTER(?request != <${REQUEST(2)}>)`));
  assert.ok(later.includes('FILTER(?appliedAt > "2026-11-03T10:13:00.000Z"^^xsd:dateTime)'), 'applied after the failed step');
  assert.equal((await service(failedDb()).addStep(sessions.orgA, RID(2), step('hertoepassing'))).status, 201, 'through /steps: 201');
});

test('applying again is for ABB and the organisation that submitted the request, and only for one whose apply failed', async () => {
  const approved = fakeDb({ requests: [requestRow(1, 'afgehandeld')], steps: appliedTrail(1) });
  await assert.rejects(() => service(approved).apply(sessions.orgA, RID(1)), { status: 409, detail: `Change request "${RID(1)}" has status afgehandeld, which is final; no hertoepassing can follow` });
  await assert.rejects(() => service(failedDb()).apply(sessions.orgB, RID(2)), { status: 403, detail: 'No rule allows it' }, 'B sees it but did not submit it');
  // what decides is who submitted it, whatever its kind: a gemeente re-applies its own creation too
  const bySubmitter = failedDb();
  bySubmitter.state.requests[0] = { ...bySubmitter.state.requests[0], requestingOrganisation: URIS.orgB, requestingOrganisationUuid: IDS.orgB };
  assert.equal((await service(bySubmitter).apply(sessions.orgB, RID(2))).status, 200, 'the organisation that submitted it may');
  assert.equal((await service(failedDb()).apply(sessions.abb, RID(2))).status, 200, 'ABB may');
});

test('applying again is refused when a request on the organisation was applied after this one failed', async () => {
  const db = failedDb({ laterApplied: [{ request: REQUEST(9), uuid: RID(9), appliedAt: '2026-11-03T11:00:01Z' }] });
  await assert.rejects(() => service(db).apply(sessions.orgA, RID(2)), {
    status: 409,
    detail: `Change request "${RID(9)}" was applied on 2026-11-03T11:00:01.000Z; submit the change again instead of applying this one`,
  });
  assert.equal(db.updates.length, 0);
});

test('a failed re-apply records the hertoepassing as mislukt and answers 409', async () => {
  const db = failedDb({ failApply: 2 });
  await assert.rejects(() => service(db).apply(sessions.orgA, RID(2)), { status: 409, meta: { 'change-request': { id: RID(2), status: 'mislukt' } } });
  assert.equal(writes(db).length, 4, 'two attempts, the failure record and the removal of what the attempts wrote of their step');
  assert.deepEqual(statusesSet(db), ['mislukt']);
  const failure = writes(db)[2];
  assert.ok(failure.includes(`dct:type <${STEP_TYPE.hertoepassing}> ;\n      adms:status <${STATUS.mislukt}> ;\n      schema:position "4"^^xsd:integer ;`));
  assert.ok(failure.includes('oslc:message """Virtuoso said no"""'));
});

// --- simultaneous requests ------------------------------------------------------------------------

/** onUpdate: an apply of a rename changes the name on the master, as the triplestore would. */
const applyRenames = (q, state) => {
  if (!isApply(q)) return;
  const name = q.match(new RegExp(`<${URIS.org}> <${prefLabel}> """([^"]+)"""`))?.[1];
  if (name) state.master[`${URIS.org} ${prefLabel}`] = [literal(name)];
};

test('two simultaneous submissions on the same organisation are serialised: the second sees the first one applied', async () => {
  const db = fakeDb({ onUpdate: applyRenames });
  const shared = service(db);
  const [first, second] = await Promise.allSettled([shared.create(sessions.orgA, rename('Aalst (1)', 'Aalst')), shared.create(sessions.orgA, rename('Aalst (2)', 'Aalst'))]);
  assert.equal(first.value.document.attributes.status, 'afgehandeld');
  assert.equal(second.status, 'rejected', 'both forms started from "Aalst": the second one conflicts and is refused');
  assert.equal(second.reason.status, 409);
  assert.deepEqual(second.reason.meta.conflicts.map(({ base, current, proposed }) => [base, current, proposed]), [['Aalst', 'Aalst (1)', 'Aalst (2)']]);
  const firstApply = db.log.findIndex(([kind, q]) => kind === 'update' && isApply(q));
  const reads = db.log.map(([kind, q], index) => (kind === 'query' && q.includes('SELECT ?s ?p ?o') ? index : -1)).filter((index) => index >= 0);
  assert.ok(reads[0] < firstApply && reads[1] > firstApply, 'the second read of the current values comes after the first apply');
});

test('without a shared lock (two service instances) both would be applied: the lock is per instance', async () => {
  const db = fakeDb({ onUpdate: applyRenames });
  const [first, second] = await Promise.all([service(db).create(sessions.orgA, rename('Aalst (1)', 'Aalst')), service(db).create(sessions.orgA, rename('Aalst (2)', 'Aalst'))]);
  assert.deepEqual([first.document.attributes.status, second.document.attributes.status], ['afgehandeld', 'afgehandeld']);
});

test('two steps on the same request at once: the second sees the status the first one left', async () => {
  const db = pendingDb({ onUpdate: recordSteps });
  const shared = service(db);
  const [approval, withdrawal] = await Promise.allSettled([shared.addStep(sessions.abb, RID(5), step('goedkeuring')), shared.addStep(sessions.orgA, RID(5), step('intrekking'))]);
  assert.equal(approval.status, 'fulfilled');
  assert.equal(approval.value.document.attributes.status, 'afgehandeld');
  assert.equal(withdrawal.status, 'rejected');
  assert.equal(withdrawal.reason.status, 409);
  assert.match(withdrawal.reason.detail, /has status afgehandeld, which is final/);
  assert.equal(writes(db).length, 1, 'one step written, sequence 2 only once');
});

// --- deletes, merges and competing requests ---------------------------------------------------------

const email = `${NS.schema}email`;
const contactsOf = (site, contacts) => ({ [`${site} ${NS.org}siteAddress`]: contacts.map(uri) });

test('a delete from a stale form: a value set on the record since the page loaded it is a conflict, and the edit is refused', async () => {
  // the page loaded the old contact point with e0@aalst.be; someone set e1 since
  const db = fakeDb({ master: { ...masterState(), [`${URIS.oldContact} ${email}`]: [literal('e1@aalst.be')] } });
  const ops = [
    { op: 'update', data: { type: 'sites', id: IDS.site, relationships: { contacts: { data: [] } }, meta: { base: { relationships: { contacts: { data: [{ type: 'contact-points', id: IDS.oldContact }] } } } } } },
    { op: 'delete', data: { type: 'contact-points', id: IDS.oldContact, meta: { base: { attributes: { email: 'e0@aalst.be', telephone: null } } } } },
  ];
  await assert.rejects(() => service(db).create(sessions.orgA, body(IDS.org, 'organization-core-data', ops)), (error) => {
    assert.equal(error.status, 409);
    assert.deepEqual(error.meta.conflicts, [
      { resource: { type: 'contact-points', id: IDS.oldContact }, key: 'email', base: 'e0@aalst.be', current: 'e1@aalst.be', proposed: null, 'master-exists': true, 'competing-requests': [] },
    ]);
    return true;
  });
  assert.equal(db.updates.length, 0, 'refused: nothing written');
  // the same delete from a page that loaded e1 goes through
  const fresh = fakeDb({ master: { ...masterState(), [`${URIS.oldContact} ${email}`]: [literal('e1@aalst.be')] } });
  ops[1].data.meta.base.attributes.email = 'e1@aalst.be';
  const { document } = await service(fresh).create(sessions.orgA, body(IDS.org, 'organization-core-data', ops));
  assert.equal(document.attributes.status, 'afgehandeld');
  const [insert] = fresh.updates;
  assert.ok(insert.includes(`cr:operation <${OPERATION.delete}> ;\n      cr:changesProperty `), 'the tombstone changes every key');
  assert.ok(insert.includes(`<${email}> """e1@aalst.be"""`), 'its base is what the page loaded');
  assert.ok(insert.includes(`rdf:subject <${URIS.site}> ;\n      rdf:predicate <${NS.org}siteAddress> ;\n      rdf:object <${URIS.oldContact}> .`), 'and the link the site had to it');
});

/** Pending request 5 deletes the old contact point; when it was submitted its email was e0 and only the site linked it. */
// Only creations and change events wait for ABB, and neither deletes records today; a held aggregate of
// the kind change-event over the site's records keeps the rules for a pending delete tested.
const heldSites = { ...config.aggregates.site, kind: 'change-event', writable: undefined };
const heldConfig = { aggregates: { ...config.aggregates, 'held-site': heldSites } };
const pendingDelete = (master) =>
  pendingDb({
    requests: [requestRow(5, 'ingediend', { aggregate: 'held-site' })],
    storedVersions: storedVersion(5, {
      operation: 'delete',
      master: URIS.oldContact,
      masterUuid: IDS.oldContact,
      type: 'contact-points',
      keys: [{ predicate: email, base: [literal('e0@aalst.be')] }, { predicate: `${NS.schema}telephone` }],
      links: [{ predicate: `${NS.org}siteAddress`, subject: URIS.site }],
    }),
    master: { ...masterState(), [`${URIS.oldContact} ${email}`]: [literal('e0@aalst.be')], ...master },
    records: { [URIS.siteB]: { uuid: IDS.siteB, classes: [`${NS.org}Site`] } },
  });

test('a pending delete is checked live: an edit made since it was submitted is a conflict, a link from outside the organisation refuses it', async () => {
  const held = (db) => configured(db, heldConfig);
  assert.deepEqual((await held(pendingDelete()).get(sessions.abb, RID(5))).attributes.conflicts, [], 'nothing changed since');
  const edited = pendingDelete({ [`${URIS.oldContact} ${email}`]: [literal('e1@aalst.be')] });
  await assert.rejects(() => held(edited).addStep(sessions.abb, RID(5), step('goedkeuring')), (error) => {
    assert.equal(error.status, 409);
    assert.deepEqual(error.meta.conflicts.map(({ resource, key, base, current, proposed }) => [resource.id, key, base, current, proposed]), [[IDS.oldContact, 'email', 'e0@aalst.be', 'e1@aalst.be', null]]);
    return true;
  });
  // another organisation's site links the contact point now: shown as a conflict, and deleting it would take it
  // from that site, so the delete is refused, also with the token
  const linked = pendingDelete(contactsOf(URIS.siteB, [URIS.oldContact]));
  const shown = (await held(linked).get(sessions.abb, RID(5))).attributes;
  assert.deepEqual(shown.conflicts, [
    { resource: { type: 'sites', id: IDS.siteB }, key: 'contacts', base: [], current: [{ type: 'contact-points', id: IDS.oldContact }], proposed: [], 'master-exists': true, 'competing-requests': [] },
  ]);
  await assert.rejects(() => held(linked).addStep(sessions.abb, RID(5), step('goedkeuring', { override: shown['conflicts-token'] })), {
    status: 409,
    title: 'The record is used outside the organisation',
    detail: `contact-points "${IDS.oldContact}" is linked from ${URIS.siteB}, which does not belong to the organisation; deleting it would change that record too`,
  });
  assert.equal(linked.updates.length, 0, 'nothing applied');
  // a link from the organisation's own site is part of what the delete removes
  const own = pendingDelete();
  const { document } = await held(own).addStep(sessions.abb, RID(5), step('goedkeuring'));
  assert.equal(document.attributes.status, 'afgehandeld');
  assert.ok(writes(own)[0].includes(`VALUES ?o { <${URIS.oldContact}> }`));
});

/** onUpdate: an apply adds the sites it links to the organisation, as the triplestore would. */
const applySites = (q, state) => {
  if (!isApply(q)) return;
  const linked = [...q.matchAll(new RegExp(`<${URIS.org}> <${NS.org}hasSite> <([^>]+)> \\.`, 'g'))].map((m) => m[1]);
  const key = `${URIS.org} ${NS.org}hasSite`;
  state.master[key] = [...(state.master[key] || []), ...linked.map(uri)];
};

test('two pages that each add a vestiging at the same time: both are linked; the second merges instead of conflicting', async () => {
  const db = fakeDb({ onUpdate: applySites });
  const shared = service(db);
  const addSite = (lid, name) =>
    body(IDS.org, 'site', [
      { op: 'create', data: { type: 'sites', lid, attributes: { 'site-type-name': name } } },
      {
        op: 'update',
        data: {
          type: 'administrative-units',
          id: IDS.org,
          relationships: { sites: { data: [{ type: 'sites', id: IDS.site }, { type: 'sites', lid }] } },
          meta: { base: { relationships: { sites: { data: [{ type: 'sites', id: IDS.site }] } } } },
        },
      },
    ]);
  const [first, second] = await Promise.all([shared.create(sessions.orgA, addSite('n1', 'Eerste')), shared.create(sessions.orgA, addSite('n2', 'Tweede'))]);
  assert.deepEqual([first.document.attributes.status, second.document.attributes.status], ['afgehandeld', 'afgehandeld']);
  assert.deepEqual(second.document.attributes.conflicts, []);
  const [n1, n2] = [first, second].map(({ document }) => `http://data.lblod.info/id/vestigingen/${Object.values(document.attributes.lids)[0]}`);
  assert.deepEqual(db.state.master[`${URIS.org} ${NS.org}hasSite`].map((binding) => binding.value), [URIS.site, n1, n2]);
  const secondApply = db.updates.filter(isApply)[1];
  assert.ok(!secondApply.includes(`VALUES ?p { <${NS.org}hasSite> }`), 'the sites are not replaced, so the first new site stays linked');
});

// --- superseding: a newer applied request withdraws the older pending one it replaces ----------

const YESTERDAY = { created: '2026-11-02T09:00:00Z' };

test('a newer request of the same organisation that rewrites every key of its older pending request replaces it: the service withdraws the older one, naming the newer', async () => {
  // R5 is pending: a stale form proposed "Aalst (A)"; ABB renamed the organisation since. A fresh form of the same organisation proposes another name.
  const db = pendingDb({ master: withName('Aalst (ABB)'), requests: [requestRow(5, 'ingediend', YESTERDAY)], onUpdate: recordSteps });
  const { document } = await service(db).create(sessions.orgA, rename('Aalst (Y)', 'Aalst (ABB)'));
  assert.equal(document.attributes.status, 'afgehandeld', 'no conflict: it is applied');
  assert.deepEqual(document.attributes.conflicts, []);
  assert.deepEqual(document.attributes.superseded, [RID(5)]);
  assert.deepEqual(document.attributes.competing, [], 'the replaced request no longer competes');
  const withdrawal = writes(db).at(-1);
  assert.ok(withdrawal.includes(`dct:type <${STEP_TYPE.intrekking}> ;\n      adms:status <${STATUS.ingetrokken}> ;\n      schema:position "2"^^xsd:integer ;`), withdrawal);
  assert.ok(withdrawal.includes(`<${REQUEST(5)}> dct:isReplacedBy <http://data.lblod.info/id/change-requests/${document.id}> .`), 'the older request names the newer one');
  assert.deepEqual(statusSet(db.updates.at(-2)), [REQUEST(5), STATUS.ingetrokken], 'then its status');
  assert.ok(
    withdrawal.includes(
      `prov:wasAssociatedWith <${SERVICE_AGENT}> ;\n      cr:rule """superseded-by-own-request""" ;\n      dct:description """Vervangen door wijzigingsaanvraag ${document.id}""" .`,
    ),
    withdrawal,
  );
  assert.ok(!withdrawal.includes('http://mu.semte.ch/application'), 'a withdrawal changes no data');
  const old = (await service(db).get(sessions.orgA, RID(5))).attributes;
  assert.equal(old.status, 'ingetrokken');
  assert.deepEqual([old.steps.at(-1).type, old.steps.at(-1).agent], ['intrekking', 'service']);
  assert.equal(old['replaced-by'], document.id);
});

test('a pending request of another organisation is not replaced: it keeps waiting and is named as competing', async () => {
  const db = pendingDb({
    master: withName('Aalst (ABB)'),
    requests: [requestRow(5, 'ingediend', { ...YESTERDAY, requestingOrganisation: URIS.abb, requestingOrganisationUuid: IDS.abb })],
  });
  const { document } = await service(db).create(sessions.orgA, rename('Aalst (Y)', 'Aalst (ABB)'));
  assert.equal(document.attributes.status, 'afgehandeld');
  assert.deepEqual(document.attributes.superseded, []);
  assert.deepEqual(document.attributes.competing, [{ resource: { type: 'administrative-units', id: IDS.org }, key: 'name', proposed: 'Aalst (Y)', 'competing-requests': [RID(5)] }]);
  assert.ok(!db.updates.some((q) => q.includes(`<${STEP_TYPE.intrekking}>`)), 'no withdrawal');
});

test('an older request that also proposes keys the newer one did not rewrite keeps waiting', async () => {
  const keys = [
    { predicate: prefLabel, proposed: [literal('Aalst (A)')], base: [literal('Aalst')] },
    { predicate: `${NS.regorg}legalName`, proposed: [literal('Stad Aalst')], base: [] },
  ];
  const db = pendingDb({ master: withName('Aalst (ABB)'), requests: [requestRow(5, 'ingediend', YESTERDAY)], storedVersions: storedVersion(5, { keys }) });
  const { document } = await service(db).create(sessions.orgA, rename('Aalst (Y)', 'Aalst (ABB)'));
  assert.equal(document.attributes.status, 'afgehandeld');
  assert.deepEqual(document.attributes.superseded, [], 'withdrawing it would drop the legal name nobody decided on again');
  assert.deepEqual(document.attributes.competing.map((key) => key['competing-requests']), [[RID(5)]]);
});

test('an older request that changes a list keeps waiting: lists merge, so a newer change of the same list does not replace it', async () => {
  const altLabel = `${NS.skos}altLabel`;
  const db = pendingDb({
    requests: [requestRow(5, 'ingediend', YESTERDAY)],
    storedVersions: storedVersion(5, { keys: [{ predicate: altLabel, proposed: [literal('Oud Aalst')], base: [] }] }),
  });
  const ops = [{ op: 'update', data: { type: 'administrative-units', id: IDS.org, attributes: { 'alternative-name': ['Aalst-Centrum'] }, meta: { base: { attributes: { 'alternative-name': [] } } } } }];
  const { document } = await service(db).create(sessions.orgA, body(IDS.org, 'organization-core-data', ops));
  assert.equal(document.attributes.status, 'afgehandeld');
  assert.deepEqual(document.attributes.superseded, []);
  assert.ok(db.queries.some((q) => q.includes('SELECT DISTINCT ?request ?uuid ?created') && q.includes(REQUEST(5))), 'it was considered');
  assert.ok(!db.updates.some((q) => q.includes(`<${STEP_TYPE.intrekking}>`)), 'and kept');
});

test('ABB approving a newer pending request withdraws the older one of the same organisation; approving the older one leaves the newer waiting', async () => {
  const twoPending = () =>
    fakeDb({
      requests: [requestRow(5, 'ingediend', YESTERDAY), requestRow(6, 'ingediend', { created: '2026-11-02T10:00:00Z' })],
      steps: [stepRow(5, 1, 'indiening', 'ingediend'), stepRow(6, 1, 'indiening', 'ingediend')],
      storedVersions: [...storedRename(5, 'Aalst (A)'), ...storedRename(6, 'Aalst (A2)')],
      onUpdate: recordSteps,
    });
  const newer = twoPending();
  const approved = await service(newer).addStep(sessions.abb, RID(6), step('goedkeuring'));
  assert.equal(approved.document.attributes.status, 'afgehandeld');
  assert.deepEqual(approved.document.attributes.superseded, [RID(5)]);
  assert.equal(newer.state.requests.find((r) => r.uuid === RID(5)).status, STATUS.ingetrokken);

  const older = twoPending();
  const first = await service(older).addStep(sessions.abb, RID(5), step('goedkeuring'));
  assert.equal(first.document.attributes.status, 'afgehandeld');
  assert.deepEqual(first.document.attributes.superseded, [], 'an older request never withdraws a newer one');
  assert.equal(older.state.requests.find((r) => r.uuid === RID(6)).status, STATUS.ingediend);
});

test('a failure while withdrawing does not undo the apply: the newer request is applied and the older one keeps waiting', async () => {
  const db = pendingDb({
    master: withName('Aalst (ABB)'),
    requests: [requestRow(5, 'ingediend', YESTERDAY)],
    onUpdate: (q) => {
      if (q.includes(`<${STEP_TYPE.intrekking}>`)) throw new Error('Virtuoso said no');
    },
  });
  const { document } = await service(db).create(sessions.orgA, rename('Aalst (Y)', 'Aalst (ABB)'));
  assert.equal(document.attributes.status, 'afgehandeld');
  assert.deepEqual(document.attributes.superseded, []);
});

test('a result that would reach the row limit of the triplestore is queried in smaller batches instead of read cut off', async () => {
  const asked = [];
  const db = {
    async query(q) {
      asked.push(q);
      return { results: { bindings: q.split(',').flatMap((item) => Array.from({ length: Number(item) }, () => ({ v: { value: item } }))) } };
    },
  };
  const result = await selectInBatches(db, ['3', '4', '2'], (batch) => batch.join(','), { size: 3, maxRows: 6 });
  assert.equal(result.results.bindings.length, 9);
  assert.deepEqual(asked, ['3,4,2', '3,4', '3', '4', '2'], 'a batch of 9 rows reaches 6: split until each part stays under');
  await assert.rejects(() => selectInBatches(db, ['7'], (batch) => batch.join(','), { maxRows: 6 }), /row limit of the triplestore/);
});

test('the fixture request is the kerngegevens page: six operations', () => {
  assert.equal(operations.length, 6);
});

// --- creations: a request to register a new organisation ------------------------------------------

const createdOrganisation = (document) => `http://data.lblod.info/id/bestuurseenheden/${document.relationships.target.data.id}`;

test('a gemeente requests a new interlokale vereniging: the organisation is minted as the target, the request waits for ABB and nothing enters the register', async () => {
  const db = fakeDb();
  const { status, document } = await service(db).create(sessions.orgA, creationBody(creationOperations(), { reason: 'Het besluit staat op de website' }));
  assert.equal(status, 201);
  assert.equal(document.attributes.status, 'ingediend');
  assert.equal(document.attributes.kind, 'creation');
  assert.equal(document.attributes.mine, true);
  assert.equal(document.attributes['target-name'], 'ILV Denderland', 'the answer shows what the request proposes, as the listing does');
  assert.equal(document.attributes['target-classification'], IDS.ilvCode);
  assert.deepEqual(document.attributes.steps, [userStep(sessions.orgA, { sequence: 1, type: 'indiening', status: 'ingediend', rule: 'may-create-classification', reason: 'Het besluit staat op de website' })]);
  assert.deepEqual(document.relationships.target, { data: { type: 'organizations', id: sequenceUuid(1) }, meta: { registered: false, pending: true } }, 'the organisation is minted first, before the request');
  assert.equal(document.id, sequenceUuid(2));
  assert.deepEqual(document.attributes.lids, { o1: sequenceUuid(1), i1: sequenceUuid(3), s1: sequenceUuid(4), v1: sequenceUuid(5), a1: sequenceUuid(6), e1: sequenceUuid(7), d1: sequenceUuid(8) });
  assert.equal(db.updates.length, 1, 'the insert only: it waits for ABB');
  const [insert] = db.updates;
  const organisation = createdOrganisation(document);
  assert.ok(insert.includes(`cr:aggregate """new-organisation""" ;\n      cr:target <${organisation}> ;\n      pav:createdBy <${URIS.org}> ;\n      dct:creator <${URIS.person}> .`));
  assert.ok(insert.includes(`dct:isVersionOf <${organisation}> ;\n      cr:masterUuid """${sequenceUuid(1)}""" ;`) && insert.includes(`cr:operation <${OPERATION.create}> ;`), 'the organisation as a proposed version');
  assert.ok(insert.includes(`<${NS.org}classification> <${URIS.ilvCode}>`) && insert.includes(`<${NS.generiek}lokaleIdentificator> """0123456789"""`));
  assert.ok(insert.includes('dct:description """Het besluit staat op de website"""'), 'the submitter\'s text on the indiening');
  assert.ok(!insert.includes('http://mu.semte.ch/application'), 'nothing in the register');
  const holderQuery = db.queries.find((q) => q.includes('SELECT ?uri ?uuid\nWHERE') && q.includes('"""0123456789"""'));
  assert.ok(holderQuery, 'the KBO number was checked');
  assert.ok(holderQuery.includes('a ?type .') && holderQuery.includes('<http://www.w3.org/ns/org#Organization>'), 'against organisations only: a proposed version carries the identifier predicate too');
  assert.ok(holderQuery.indexOf('VALUES ?localId') < holderQuery.indexOf('?identifier'), 'anchored on the number, in the forms it may be stored in');
  assert.ok(holderQuery.includes('"""0123.456.789"""') && holderQuery.includes('"""BE0123456789"""'));
  assert.ok(holderQuery.includes('FILTER(LCASE(STR(?idName)) IN ("""kbo nummer"""'), 'under any spelling of its name');
  if (model.has('kbo-organizations')) assert.ok(holderQuery.includes(`FILTER NOT EXISTS { ?uri a <${model.get('kbo-organizations').class}> . }`), 'a KBO mirror holds no number of its own');
  assert.ok(holderQuery.includes(`FILTER(?uri != <${organisation}>)`), 'the organisation it registers is not a holder');
});

test('a creation is refused when the KBO number is registered already, or proposed by a request that waits', async () => {
  const registered = fakeDb({ holders: { '0123456789': { uri: URIS.orgB, uuid: IDS.orgB } } });
  await assert.rejects(() => service(registered).create(sessions.orgA, creationBody()), {
    status: 409,
    title: 'An organisation with this KBO number is already registered',
    pointer: '/data/attributes/operations/1/data/relationships/structured-identifier',
    meta: { 'kbo-number': '0123456789', organisation: { type: 'organizations', id: IDS.orgB } },
  });
  assert.equal(registered.updates.length, 0);
  const waiting = fakeDb({ pendingKbo: { '0123456789': { request: REQUEST(7), uuid: RID(7) } } });
  await assert.rejects(() => service(waiting).create(sessions.orgA, creationBody()), { status: 409, title: 'A request to register an organisation with this KBO number is already waiting', meta: { 'kbo-number': '0123456789', 'change-request': { id: RID(7) } } });
  assert.equal(waiting.updates.length, 0);
});

test('a creation follows "Wie beheert": a gemeente may not request a gemeente, an organisation without classification nothing; a target or a second organisation document is a 422', async () => {
  const gemeente = creationOperations();
  gemeente[0].data.relationships.classification.data.id = IDS.gemeenteCode;
  await assert.rejects(() => service(fakeDb()).create(sessions.orgA, creationBody(gemeente)), { status: 403, title: 'Not allowed to request this organisation', meta: { rule: null, rules: [] } });
  await assert.rejects(() => service(fakeDb()).create({ ...sessions.orgA, actor: { ...sessions.orgA.actor, classification: null } }, creationBody()), { status: 403 });
  const withTarget = creationBody();
  withTarget.data.relationships = { target: { data: { type: 'administrative-units', id: IDS.org } } };
  await assert.rejects(() => service(fakeDb()).create(sessions.orgA, withTarget), { status: 422, pointer: '/data/relationships/target', detail: /has no target/ });
  await assert.rejects(() => service(fakeDb()).create(sessions.orgA, creationBody([...creationOperations(), { op: 'create', data: { type: 'administrative-units', lid: 'o2', attributes: { name: 'Nog een' } } }])), { status: 422, detail: /exactly one organisation document.*got 2/ });
  await assert.rejects(() => service(fakeDb()).create(sessions.orgA, creationBody(creationOperations().slice(1))), { status: 422, detail: /exactly one organisation document.*got 0/ });
  const updating = creationOperations();
  updating[0] = { op: 'update', data: { type: 'administrative-units', id: IDS.org, attributes: { name: 'x' } } };
  await assert.rejects(() => service(fakeDb()).create(sessions.orgA, creationBody(updating)), { status: 422, detail: /"op" must be create/ });
  const other = creationOperations();
  other[3].data.relationships = { address: { data: { type: 'addresses', id: IDS.addressB } } };
  await assert.rejects(() => service(fakeDb()).create(sessions.orgA, creationBody(other)), { status: 422, detail: /does not belong to the target organisation/ }, 'an existing record of someone else');
});

test('ABB registers an organisation at once: goedkeuring and afhandeling by the service, the class tree and the Oprichting event in the register', async () => {
  const db = fakeDb();
  const { document } = await service(db).create(sessions.abb, creationBody());
  assert.equal(document.attributes.status, 'afgehandeld');
  assert.deepEqual(document.attributes.steps.map((s) => [s.type, s.status, s.agent, s.rule]), [['indiening', 'ingediend', 'user', 'abb-edits-all'], ['goedkeuring', 'goedgekeurd', 'service', 'abb-auto-approves'], ['afhandeling', 'afgehandeld', 'service', null]]);
  assert.deepEqual(document.relationships.target, { data: { type: 'organizations', id: sequenceUuid(1) } }, 'applied: no longer pending');
  const apply = db.updates[1];
  const organisation = createdOrganisation(document);
  assert.ok(apply.includes(`<${organisation}> a <${NS.besluit}Bestuurseenheid>, <${NS.org}Organization>, <${NS.dct}Agent> ;\n      mu:uuid """${sequenceUuid(1)}""" ;`), 'the class tree and the uuid');
  assert.ok(apply.includes(`<${NS.org}classification> <${URIS.ilvCode}>`) && apply.includes(`<${NS.regorg}orgStatus> <${URIS.statusCode}>`));
  assert.ok(apply.includes(`a <${NS.org}ChangeEvent>`) && apply.includes(`<${organisation}>`), 'the Oprichting change event about the new organisation');
  assert.ok(apply.includes(`<${organisation}> dct:modified`) && apply.includes(`ext:lastModifiedBy <${URIS.personAbb}>`));
});

/** A pending creation as the store holds it: the request with the organisation's version among the stored ones. */
const pendingCreation = (n = 5, options = {}) => {
  const organisation = `http://data.lblod.info/id/bestuurseenheden/${testUuid('version', 900 + n)}`;
  return {
    organisation,
    db: fakeDb({
      requests: [requestRow(n, 'ingediend', { aggregate: 'new-organisation', target: organisation, targetUuid: undefined, creator: URIS.person })],
      steps: [stepRow(n, 1, 'indiening', 'ingediend', { rule: 'may-create-classification' })],
      storedVersions: storedVersion(n, {
        operation: 'create',
        master: organisation,
        masterUuid: testUuid('version', 900 + n),
        keys: [{ predicate: prefLabel, proposed: [literal('ILV Denderland')] }, { predicate: `${NS.org}classification`, proposed: [uri(URIS.ilvCode)] }],
      }).filter((row) => !row.base && row.p.value !== `${NS.cr}base` && row.p.value !== `${NS.cr}changesProperty`),
      uuids: { [URIS.ilvCode]: IDS.ilvCode },
      ...options,
    }),
  };
};

test('a creation that waits is listed with the organisation it proposes, and its steps can be taken although the organisation does not exist', async () => {
  const { db, organisation } = pendingCreation();
  const { documents: list } = await service(db).list(sessions.orgB, { kinds: ['creation'] });
  assert.equal(list.length, 1);
  assert.equal(list[0].attributes.kind, 'creation');
  assert.deepEqual(list[0].relationships.target, { data: { type: 'organizations', id: testUuid('version', 905) }, meta: { registered: false, pending: true } }, 'the uuid from the proposed version');
  assert.equal(list[0].attributes.mine, false);
  assert.ok(db.queries.some((q) => q.includes('VALUES ?aggregate { """new-organisation""" }')), 'filtered on the aggregates of the kind');
  const detail = await service(db).get(sessions.orgA, RID(5));
  assert.deepEqual(detail.attributes.operations, [
    { op: 'create', data: { type: 'administrative-units', id: testUuid('version', 905), attributes: { name: 'ILV Denderland' }, relationships: { classification: { data: { type: 'organization-classification-codes', id: IDS.ilvCode } } } } },
  ], 'the submitted operations, rebuilt from the stored version');
  assert.equal((await service(db).list(sessions.orgA, { kinds: ['creation'] })).documents[0].attributes.operations, undefined, 'the list carries no operations');
  const { document } = await service(db).addStep(sessions.abb, RID(5), step('informatievraag', { reason: 'Welk besluit richt de vereniging op?' }));
  assert.equal(document.attributes.status, 'informatie-gevraagd');
  assert.ok(db.queries.some((q) => q.includes('SELECT ?uri ?type ?classification') && q.includes(`"""${testUuid('version', 905)}"""`)), 'the organisation is looked up, not found, and taken as pending');
  const approved = await service(pendingCreation().db).addStep(sessions.abb, RID(5), step('goedkeuring'));
  assert.equal(approved.document.attributes.status, 'afgehandeld');
  assert.ok(approved.document.attributes.steps.map((s) => s.type).includes('afhandeling'));
  const applyOf = async () => { const made = pendingCreation(); await service(made.db).addStep(sessions.abb, RID(5), step('goedkeuring')); return made.db.updates[0]; };
  assert.ok((await applyOf()).includes(`<${organisation}> a <${NS.besluit}Bestuurseenheid>`), 'the approval creates the organisation');
});

// --- change events and the validation flow ---------------------------------------------------------

test('an organisation requests a change event about itself: it waits for ABB with the event, the besluit and the new name as versions', async () => {
  const db = fakeDb();
  const { document } = await service(db).create(sessions.orgA, body(IDS.org, 'change-event', changeEventOperations()));
  assert.equal(document.attributes.status, 'ingediend');
  assert.equal(document.attributes.kind, 'change-event');
  assert.deepEqual(document.attributes.steps.map((s) => [s.type, s.rule]), [['indiening', 'own-organisation']]);
  assert.equal(db.updates.length, 1);
  assert.ok(db.updates[0].includes(`cr:resourceType """change-events"""`) && db.updates[0].includes(`cr:resourceType """decisions"""`) && db.updates[0].includes(`<${prefLabel}> """Stad Aalst"""`));
  await assert.rejects(() => service(fakeDb()).create(sessions.orgB, body(IDS.org, 'change-event', changeEventOperations())), { status: 403 }, 'another organisation does not register events about A');
  const byAbb = await service(fakeDb()).create(sessions.abb, body(IDS.org, 'change-event', changeEventOperations()));
  assert.equal(byAbb.document.attributes.status, 'afgehandeld', 'ABB registers it at once');
});

test('the validation flow: ABB asks for information, the requester answers, ABB rejects, the requester contests, ABB approves', async () => {
  const db = pendingDb({ onUpdate: recordSteps });
  const trail = [];
  const take = async (session, stepType, reason) => {
    const { document } = await service(db).addStep(session, RID(5), step(stepType, reason ? { reason } : {}));
    trail.push([document.attributes.steps.at(-1).sequence, stepType, document.attributes.status]);
    return document;
  };
  const asked = await take(sessions.abb, 'informatievraag', 'Welk besluit?');
  assert.deepEqual(asked.attributes.steps.at(-1), userStep(sessions.abb, { sequence: 2, type: 'informatievraag', status: 'informatie-gevraagd', rule: 'abb-decides-all', reason: 'Welk besluit?' }));
  await assert.rejects(() => service(db).addStep(sessions.abb, RID(5), step('informatieantwoord', { reason: 'ik antwoord mezelf' })), { status: 403 }, 'ABB does not answer');
  await assert.rejects(() => service(db).addStep(sessions.abb, RID(5), step('goedkeuring')), { status: 409 }, 'not before the answer');
  const answered = await take(sessions.orgA, 'informatieantwoord', 'Het besluit van 1 oktober');
  assert.deepEqual(answered.attributes.steps.at(-1), userStep(sessions.orgA, { sequence: 3, type: 'informatieantwoord', status: 'ingediend', rule: 'requesting-organisation', reason: 'Het besluit van 1 oktober' }));
  await take(sessions.abb, 'afkeuring', 'Dat besluit is niet gepubliceerd');
  await assert.rejects(() => service(db).addStep(sessions.orgB, RID(5), step('betwisting', { reason: 'toch wel' })), { status: 403 }, 'only the requester contests');
  const contested = await take(sessions.orgA, 'betwisting', 'Het staat in het Staatsblad van 3 oktober');
  assert.equal(contested.attributes.status, 'ingediend', 'back to validation');
  await assert.rejects(() => service(db).addStep(sessions.orgA, RID(5), step('betwisting', { reason: 'nog eens' })), { status: 409 }, 'nothing to contest any more');
  const approved = await take(sessions.abb, 'goedkeuring');
  assert.deepEqual(trail, [[2, 'informatievraag', 'informatie-gevraagd'], [3, 'informatieantwoord', 'ingediend'], [4, 'afkeuring', 'afgekeurd'], [5, 'betwisting', 'ingediend'], [7, 'goedkeuring', 'afgehandeld']]);
  assert.deepEqual(approved.attributes.steps.slice(-2).map((s) => [s.sequence, s.type, s.status, s.agent]), [[6, 'goedkeuring', 'goedgekeurd', 'user'], [7, 'afhandeling', 'afgehandeld', 'service']]);
  for (const reason of [undefined, '', ' ']) {
    for (const stepType of ['informatievraag', 'afkeuring']) await assert.rejects(() => service(pendingDb()).addStep(sessions.abb, RID(5), step(stepType, reason === undefined ? {} : { reason })), { status: 422, detail: `an ${stepType} needs a reason` });
  }
});

test('a third party sees a request without the person who submitted it and without its texts; the requesting organisation and ABB see both', async () => {
  const rows = { requests: [requestRow(5, 'informatie-gevraagd')], steps: [stepRow(5, 1, 'indiening', 'ingediend', { reason: 'Zie website' }), stepRow(5, 2, 'informatievraag', 'informatie-gevraagd', { agent: URIS.personAbb, agentUuid: sessions.abb.personUuid, organisation: URIS.abb, organisationUuid: IDS.abb, rule: 'abb-decides-all', reason: 'Welk besluit?' })], storedVersions: storedRename(5) };
  const hidden = (await service(fakeDb(rows)).get(sessions.orgB, RID(5))).attributes;
  assert.deepEqual(hidden.steps.map((s) => [s.person, s.reason, s.organisation]), [[null, null, IDS.org], [null, null, IDS.abb]], 'the organisations stay');
  assert.equal(hidden.mine, false);
  const own = (await service(fakeDb(rows)).get(sessions.orgA, RID(5))).attributes;
  assert.deepEqual(own.steps.map((s) => [s.person, s.reason]), [[sessions.orgA.personUuid, 'Zie website'], [sessions.abb.personUuid, 'Welk besluit?']]);
  assert.equal(own.mine, true, 'the session\'s person submitted it');
  const colleague = (await service(fakeDb(rows)).get({ ...sessions.orgA, person: 'http://data.lblod.info/id/persoon/other', personUuid: 'other' }, RID(5))).attributes;
  assert.deepEqual([colleague.mine, colleague.steps[0].person], [false, sessions.orgA.personUuid], 'a colleague of the same organisation: not mine, but sees who');
  const abb = (await service(fakeDb(rows)).get(sessions.abb, RID(5))).attributes;
  assert.deepEqual(abb.steps.map((s) => s.reason), ['Zie website', 'Welk besluit?']);
});

test('the listing filters on the kind, the person (mine), the requester, the classification and the time', async () => {
  const requests = [requestRow(1, 'afgehandeld', { aggregate: 'organization-core-data' }), requestRow(2, 'ingediend', { aggregate: 'new-organisation', creator: URIS.personB, requestingOrganisation: URIS.orgB, requestingOrganisationUuid: IDS.orgB, created: '2026-10-05T10:00:00Z' })];
  const db = fakeDb({ requests });
  const ids = async (query) => (await service(db).list(sessions.abb, query)).documents.map((d) => d.id);
  assert.deepEqual(await ids({ kinds: ['edit'] }), [RID(1)]);
  assert.deepEqual(await ids({ kinds: ['creation', 'change-event'] }), [RID(2)]);
  assert.deepEqual(await ids({ mine: true }), [], 'ABB submitted neither');
  assert.deepEqual((await service(db).list(sessions.orgB, { mine: true })).documents.map((d) => d.id), [RID(2)]);
  assert.deepEqual(await ids({ requester: IDS.orgB }), [RID(2)]);
  assert.deepEqual(await ids({ requester: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }), [], 'an unknown requester');
  assert.deepEqual(await ids({ created: { from: '2026-10-01T00:00:00.000Z', until: '2026-10-31T00:00:00.000Z' } }), [RID(2)]);
  assert.deepEqual(await ids({ targetClassification: IDS.ilvCode, kinds: ['edit', 'creation'] }), [RID(2), RID(1)], 'oldest first; the fake does not join classifications, the query does');
  assert.ok(db.queries.some((q) => q.includes(`FILTER(?classification = <${URIS.ilvCode}>)`)));
  assert.deepEqual(await ids({ targetClassification: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }), [], 'an unknown classification');
});

// --- KBO numbers, what a request registers, statuses, visibility and limits ------------------------

/** A waiting creation (request n) that proposes a KBO number: the organisation, its identifier and the structured identifier. */
const pendingKboCreation = (n, number, options = {}) => {
  const { db: base } = pendingCreation(n);
  const identifier = `http://data.lblod.info/id/identificatoren/${testUuid('version', 950 + n)}`;
  const structured = `http://data.lblod.info/id/gestructureerdeIdentificatoren/${testUuid('version', 960 + n)}`;
  const created = (rows) => rows.filter((row) => !row.base && row.p.value !== `${NS.cr}base` && row.p.value !== `${NS.cr}changesProperty`);
  const storedVersions = [
    ...base.state.storedVersions,
    ...created(storedVersion(n, { operation: 'create', type: 'identifiers', master: identifier, masterUuid: testUuid('version', 950 + n), number: 950 + n, keys: [{ predicate: `${NS.skos}notation`, proposed: [literal('KBO nummer')] }, { predicate: `${NS.generiek}gestructureerdeIdentificator`, proposed: [uri(structured)] }] })),
    ...created(storedVersion(n, { operation: 'create', type: 'structured-identifiers', master: structured, masterUuid: testUuid('version', 960 + n), number: 960 + n, keys: [{ predicate: `${NS.generiek}lokaleIdentificator`, proposed: [literal(number)] }] })),
  ];
  return fakeDb({ requests: base.state.requests, steps: base.state.steps, storedVersions, uuids: { [URIS.ilvCode]: IDS.ilvCode }, onUpdate: recordSteps, ...options });
};
const kboOperations = (localId, idName = 'KBO nummer') => {
  const ops = creationOperations();
  ops[1].data.attributes['id-name'] = idName;
  ops[2].data.attributes['local-id'] = localId;
  return ops;
};

test('a KBO number is kept as its ten digits: dots, spaces and BE go, nine digits get their 0, anything else is a 422; its identifier is named "KBO nummer"', async () => {
  for (const [given, stored] of [['0123.456.789', '0123456789'], ['BE 0123 456 789', '0123456789'], ['123456789', '0123456789']]) {
    const db = fakeDb();
    assert.equal((await service(db).create(sessions.orgA, creationBody(kboOperations(given)))).status, 201, given);
    assert.ok(db.updates[0].includes(`<${NS.generiek}lokaleIdentificator> """${stored}"""`), `${given} is stored as ${stored}`);
  }
  await assert.rejects(() => service(fakeDb()).create(sessions.orgA, creationBody(kboOperations('12345'))), { status: 422, detail: 'a KBO number has ten digits (0123456789 or 0123.456.789)', pointer: '/data/attributes/operations/2/data/attributes/local-id' });
  await assert.rejects(() => service(fakeDb()).create(sessions.orgA, creationBody(kboOperations('0123456789', 'KBO Nummer'))), { status: 422, detail: 'the identifier of a KBO number is named "KBO nummer"', pointer: '/data/attributes/operations/1/data/attributes/id-name' });
});

test('a creation needs a KBO number unless its classification registers without one (ILV, vervoerregioraad); one number only', async () => {
  const withoutKbo = creationOperations().filter((operation) => !['identifiers', 'structured-identifiers'].includes(operation.data.type));
  withoutKbo[0].data.relationships.identifiers = { data: [] };
  assert.equal((await service(fakeDb()).create(sessions.orgA, creationBody(withoutKbo))).status, 201, 'an ILV may wait without one');
  const agb = withoutKbo.map((operation) => structuredClone(operation));
  agb[0].data.relationships.classification.data.id = '36a82ba0-7ff1-4697-a9dd-2e94df73b721';
  const agbResources = { [agb[0].data.relationships.classification.data.id]: 'http://data.vlaanderen.be/id/concept/BestuurseenheidClassificatieCode/36a82ba0-7ff1-4697-a9dd-2e94df73b721' };
  resources.set('36a82ba0-7ff1-4697-a9dd-2e94df73b721', { uri: agbResources['36a82ba0-7ff1-4697-a9dd-2e94df73b721'], classes: [model.get('administrative-unit-classification-codes').class] });
  try {
    await assert.rejects(() => service(fakeDb()).create(sessions.orgA, creationBody(agb)), { status: 422, detail: 'an organisation of this classification is registered with its KBO number (an identifier "KBO nummer")' });
  } finally {
    resources.delete('36a82ba0-7ff1-4697-a9dd-2e94df73b721');
  }
  const two = creationOperations();
  two[0].data.relationships.identifiers.data.push({ type: 'identifiers', lid: 'i2' });
  two.push({ op: 'create', data: { type: 'identifiers', lid: 'i2', attributes: { 'id-name': 'KBO nummer' }, relationships: { 'structured-identifier': { data: { type: 'structured-identifiers', lid: 's2' } } } } });
  two.push({ op: 'create', data: { type: 'structured-identifiers', lid: 's2', attributes: { 'local-id': '0987654321' } } });
  await assert.rejects(() => service(fakeDb()).create(sessions.orgA, creationBody(two)), { status: 422, detail: 'an organisation has one KBO number' });
});

test('an edit that changes the KBO number is checked like a creation; one that carries its own number as it is, is not', async () => {
  const kboEdit = (localId) => body(IDS.org, 'organization-core-data', [{ op: 'update', data: { type: 'structured-identifiers', id: IDS.structuredKbo, attributes: { 'local-id': localId } } }]);
  // the number the organisation has, carried as it is: no lookup, even if another record held it
  const own = fakeDb({ holders: { '0207437468': { uri: URIS.orgB, uuid: IDS.orgB } } });
  assert.equal((await service(own).create(sessions.orgA, kboEdit('0207.437.468'))).status, 201, 'normalised, it is what the organisation holds: nothing to check');
  assert.ok(!own.queries.some((q) => q.includes('VALUES ?localId')), 'no uniqueness lookup for a number the request does not write');
  // a new number someone else holds
  const taken = fakeDb({ holders: { '0123456789': { uri: URIS.orgB, uuid: IDS.orgB } } });
  await assert.rejects(() => service(taken).create(sessions.orgA, kboEdit('0123456789')), { status: 409, meta: { 'kbo-number': '0123456789', organisation: { type: 'organizations', id: IDS.orgB } }, pointer: '/data/attributes/operations/0/data/attributes/local-id' });
  assert.equal(taken.updates.length, 0);
  // the register says which structured identifier is a KBO number when its identifier is not in the request
  assert.ok(taken.queries.some((q) => q.includes('SELECT DISTINCT ?structured ?idName') && q.includes(URIS.structuredKbo)));
  const free = fakeDb();
  assert.equal((await service(free).create(sessions.orgA, kboEdit('0123456789'))).status, 201);
});

test('two creations with the same KBO number at once: the lock on the number lets the second see the first', async () => {
  const db = fakeDb({ onUpdate: (q, state) => {
    // the first creation, once written, waits with its number
    if (q.includes('a cr:ChangeRequest ;')) Object.assign(pendingKbo, { '0123456789': { request: q.match(/<([^>]+)> a cr:ChangeRequest/)[1], uuid: 'first', requestingOrganisation: URIS.org } });
    recordSteps(q, state);
  } });
  const pendingKbo = {};
  const shared = service(db);
  // the stand-in reads pendingKbo when it is created, so the second lookup goes through the onUpdate above
  const lookups = [];
  const query = db.query.bind(db);
  db.query = async (q) => {
    if (q.includes('SELECT DISTINCT ?structuredVersion ?structured')) lookups.push(Object.keys(pendingKbo).length);
    if (q.includes('SELECT DISTINCT ?structuredVersion ?structured') && pendingKbo['0123456789']) {
      return { results: { bindings: [{ structuredVersion: { type: 'uri', value: 'http://example.org/v' }, structured: { type: 'uri', value: 'http://example.org/s' } }] } };
    }
    if (q.includes('SELECT DISTINCT ?identifierVersion ?idName') && pendingKbo['0123456789']) {
      return { results: { bindings: [{ identifierVersion: { type: 'uri', value: 'http://example.org/i' }, idName: { type: 'literal', value: 'KBO nummer' } }] } };
    }
    if (q.includes('SELECT DISTINCT ?version ?request ?uuid ?status ?aggregate ?requestingOrganisation') && pendingKbo['0123456789']) {
      const entry = pendingKbo['0123456789'];
      return { results: { bindings: [{ version: { type: 'uri', value: 'http://example.org/i' }, request: { type: 'uri', value: entry.request }, uuid: { type: 'literal', value: entry.uuid }, status: { type: 'uri', value: STATUS.ingediend }, aggregate: { type: 'literal', value: 'new-organisation' }, requestingOrganisation: { type: 'uri', value: URIS.org } }] } };
    }
    return query(q);
  };
  const [first, second] = await Promise.allSettled([shared.create(sessions.orgA, creationBody()), shared.create(sessions.orgA, creationBody())]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.equal(second.reason.status, 409);
  assert.deepEqual(lookups, [0, 1], 'the second looked after the first was written');
});

test('approving or re-applying a creation claims its KBO number again: refused when the register holds it by now', async () => {
  const taken = { holders: { '0123456789': { uri: URIS.orgB, uuid: IDS.orgB } } };
  const db = pendingKboCreation(5, '0123456789', taken);
  await assert.rejects(() => service(db).addStep(sessions.abb, RID(5), step('goedkeuring')), {
    status: 409,
    title: 'An organisation with this KBO number is already registered',
    meta: { 'kbo-number': '0123456789', organisation: { type: 'organizations', id: IDS.orgB } },
  });
  assert.equal(db.updates.length, 0, 'nothing applied');
  const holderQuery = db.queries.find((q) => q.includes('VALUES ?localId') && q.includes('?uri'));
  assert.ok(holderQuery.includes('FILTER(?uri != <http://data.lblod.info/id/bestuurseenheden/'), 'the organisation it registers is not a holder (a hertoepassing after a half apply)');
  // free: approved and applied
  const free = pendingKboCreation(5, '0123456789');
  assert.equal((await service(free).addStep(sessions.abb, RID(5), step('goedkeuring'))).document.attributes.status, 'afgehandeld');
  // a rejection does not keep the number: another creation may take it, and contesting the rejection is refused then
  const rejected = pendingKboCreation(5, '0123456789', { pendingKbo: { '0123456789': { request: REQUEST(7), uuid: RID(7), requestingOrganisation: URIS.orgB } } });
  rejected.state.requests[0].status = STATUS.afgekeurd;
  rejected.state.steps.push(stepRow(5, 2, 'afkeuring', 'afgekeurd', abbSteps));
  await assert.rejects(() => service(rejected).addStep(sessions.orgA, RID(5), step('betwisting', { reason: 'Het nummer is van ons' })), {
    status: 409,
    title: 'A request to register an organisation with this KBO number is already waiting',
  });
  const contested = pendingKboCreation(5, '0123456789');
  contested.state.requests[0].status = STATUS.afgekeurd;
  contested.state.steps.push(stepRow(5, 2, 'afkeuring', 'afgekeurd', abbSteps));
  assert.equal((await service(contested).addStep(sessions.orgA, RID(5), step('betwisting', { reason: 'Het nummer is van ons' }))).document.attributes.status, 'ingediend');
});

test('while waiting requests are for the involved, the KBO 409 names a waiting request only to who may see it', async () => {
  const waiting = { pendingKbo: { '0123456789': { request: REQUEST(7), uuid: RID(7), requestingOrganisation: URIS.orgB } } };
  await assert.rejects(() => configured(fakeDb(waiting), { pendingVisibleTo: 'involved' }).create(sessions.orgA, creationBody()), (error) => {
    assert.equal(error.status, 409);
    assert.deepEqual(error.meta, { 'kbo-number': '0123456789' }, 'B filed it; A may not see it');
    assert.doesNotMatch(error.detail, new RegExp(RID(7)));
    return true;
  });
  await assert.rejects(() => service(fakeDb(waiting)).create(sessions.orgA, creationBody()), { status: 409, meta: { 'kbo-number': '0123456789', 'change-request': { id: RID(7) } } }, 'everyone sees every request: named');
});

test('a creation registers what the service registers, as the type it registers it as, with exactly one oprichting', async () => {
  const unregistered = creationOperations();
  unregistered[0].data.relationships.classification.data.id = IDS.gemeenteCode;
  await assert.rejects(() => service(fakeDb()).create(sessions.abb, creationBody(unregistered.map((operation, index) => (index === 0 ? { ...operation, data: { ...operation.data, relationships: { ...operation.data.relationships, classification: { data: { type: 'organization-classification-codes', id: IDS.siteType } } } } } : operation)))), {
    status: 422,
    detail: `the service does not register organisations of the classification "${IDS.siteType}"`,
  });
  const asRegistered = creationOperations();
  asRegistered[0].data.type = 'registered-organizations';
  await assert.rejects(() => service(fakeDb()).create(sessions.abb, creationBody(asRegistered)), { status: 422, detail: 'an organisation of this classification is registered as administrative-units, not as registered-organizations', pointer: '/data/attributes/operations/0/data/type' });
  const noEvent = creationOperations().filter((operation) => !['change-events', 'decisions'].includes(operation.data.type));
  await assert.rejects(() => service(fakeDb()).create(sessions.abb, creationBody(noEvent)), { status: 422, detail: /exactly one change event, its oprichting .*got 0/ });
  const otherEvent = creationOperations();
  otherEvent[5].data.relationships.type.data.id = IDS.nameChangeType;
  await assert.rejects(() => service(fakeDb()).create(sessions.abb, creationBody(otherEvent)), { status: 422, detail: /exactly one change event, its oprichting/ });
});

test('a change-event request carries exactly one change event, about the organisation it is about', async () => {
  assert.equal((await service(fakeDb()).create(sessions.orgA, body(IDS.org, 'change-event', changeEventOperations()))).status, 201);
  const none = changeEventOperations().filter((operation) => !['change-events', 'decisions'].includes(operation.data.type));
  await assert.rejects(() => service(fakeDb()).create(sessions.orgA, body(IDS.org, 'change-event', none)), { status: 422, detail: 'a change-event request carries exactly one change event, got 0' });
  const elsewhere = changeEventOperations();
  elsewhere[0].data.relationships['original-organizations'].data = [];
  elsewhere[0].data.relationships.decision = { data: { type: 'decisions', lid: 'd1' } };
  await assert.rejects(() => service(fakeDb()).create(sessions.orgA, body(IDS.org, 'change-event', elsewhere)), { status: 422 });
});

test('a step that leaves a request waiting answers with its live conflicts and token, as a GET does', async () => {
  const db = pendingDb({ master: withName('Aalst (ABB)'), onUpdate: recordSteps });
  const { document } = await service(db).addStep(sessions.abb, RID(5), step('informatievraag', { reason: 'Welk besluit?' }));
  assert.equal(document.attributes.status, 'informatie-gevraagd');
  assert.deepEqual(document.attributes.conflicts.map(({ key, current }) => [key, current]), [['name', 'Aalst (ABB)']]);
  assert.equal(document.attributes['conflicts-token'], (await service(db).get(sessions.abb, RID(5))).attributes['conflicts-token']);
});

test('the status is the request\'s own; with two (a status update cut short) the one of its last step, with none the last step\'s', async () => {
  const twice = pendingDb();
  twice.state.requests.push({ ...twice.state.requests[0], status: STATUS.afgekeurd });
  twice.state.steps.push(stepRow(5, 2, 'afkeuring', 'afgekeurd', abbSteps));
  assert.equal((await service(twice).get(sessions.abb, RID(5))).attributes.status, 'afgekeurd');
  const lost = pendingDb();
  delete lost.state.requests[0].status;
  assert.equal((await service(lost).get(sessions.abb, RID(5))).attributes.status, 'ingediend', 'found, although its status was lost');
});

test('a request whose organisation is gone can still be read and closed by ABB', async () => {
  const db = pendingDb({ onUpdate: recordSteps });
  db.state.requests[0] = { ...db.state.requests[0], target: 'http://data.lblod.info/id/bestuurseenheden/gone', targetUuid: undefined };
  assert.equal((await service(db).get(sessions.abb, RID(5))).id, RID(5));
  assert.equal((await service(db).addStep(sessions.abb, RID(5), step('afkeuring', { reason: 'De organisatie bestaat niet meer' }))).document.attributes.status, 'afgekeurd');
});

test('the target of a creation shows whether it waits; the error of a failed apply only to the organisation that submitted it and ABB', async () => {
  const { db } = pendingCreation();
  db.state.requests[0].status = STATUS.afgekeurd;
  const rejected = await service(db).get(sessions.orgA, RID(5));
  assert.deepEqual(rejected.relationships.target.meta, { registered: false, pending: false }, 'not registered, and no longer waiting');
  const failed = failedDb();
  assert.equal((await service(failed).get(sessions.orgA, RID(2))).attributes.error, 'Virtuoso said no');
  const byB = (await service(failed).get(sessions.orgB, RID(2))).attributes;
  assert.equal(byB.error, null, 'a third organisation sees that it failed, not why');
  assert.equal(byB.steps.at(-1).error, null);
});

test('filter[target] also finds a waiting creation by the uuid it minted for its organisation', async () => {
  const minted = testUuid('version', 905);
  const { db, organisation } = pendingCreation(5, { former: { [minted]: `http://data.lblod.info/id/bestuurseenheden/${minted}` } });
  const { documents } = await service(db).list(sessions.orgA, { target: minted });
  assert.deepEqual(documents.map((document) => document.id), [RID(5)]);
  assert.ok(db.queries.some((q) => q.includes(`FILTER(?target = <${organisation}>)`)));
});

test('a delete of a record another organisation links to is refused: the apply would change that organisation\'s data', async () => {
  const shared = fakeDb({ master: { ...masterState(), ...contactsOf(URIS.siteB, [URIS.oldContact]) }, records: { [URIS.siteB]: { uuid: IDS.siteB, classes: [`${NS.org}Site`] } } });
  await assert.rejects(
    () => service(shared).create(sessions.orgA, body(IDS.org, 'site', [
      { op: 'update', data: { type: 'sites', id: IDS.site, relationships: { contacts: { data: [] } } } },
      { op: 'delete', data: { type: 'contact-points', id: IDS.oldContact } },
    ])),
    { status: 409, title: 'The record is used outside the organisation', meta: { record: { type: 'contact-points', id: IDS.oldContact } } },
  );
  assert.equal(shared.updates.length, 0);
});

test('the list query and the step text are bounded: unknown filters and pages past the triplestore\'s row limit are a 400, long or empty texts a 422', async () => {
  assert.throws(() => parseListQuery({ filter: { colour: 'red' } }), { status: 400, detail: /unknown filter\[colour\]/ });
  assert.throws(() => parseListQuery({ filter: { created: { gt: '2026-01-01' } } }), { status: 400, detail: /unknown filter\[created\]\[gt\]/ });
  assert.throws(() => parseListQuery({ page: { number: '500', size: '20' } }), { status: 400, detail: 'page[number] must be a whole number from 0 to 499' });
  assert.deepEqual(parseListQuery({ page: { number: '499', size: '20' } }).page, { number: 499, size: 20 });
  assert.throws(() => parseListQuery({ page: { number: '4294967296' } }), { status: 400 });
  assert.throws(() => parseListQuery({ filter: { target: 'a\u0000b' } }), { status: 400 });
  await assert.rejects(() => service(pendingDb()).addStep(sessions.abb, RID(5), step('informatievraag', { reason: '​ ‍' })), { status: 422, detail: 'an informatievraag needs a reason' });
  await assert.rejects(() => service(pendingDb()).addStep(sessions.abb, RID(5), step('informatievraag', { reason: 'x'.repeat(10001) })), { status: 422, detail: '"reason" is at most 10000 characters long' });
  await assert.rejects(() => service(fakeDb()).create(sessions.orgA, { data: { type: 'change-requests', attributes: { aggregate: '__proto__', operations: [{}] } } }), { status: 422, pointer: '/data/attributes/aggregate' });
});

// --- reading back what was written (verifyWrites) -------------------------------------------------------

/**
 * A stand-in for the read-backs on top of fakeDb: the submission and the apply are read back as complete
 * unless the test says otherwise (missingTriples: how many inserted triples are missing, values: the
 * value count of a pair, leftovers: records a delete left, submitted: the versions a submission stored).
 */
function verifyingDb({ missingTriples = () => 0, values = () => null, leftovers = () => [], submitted = (expected) => expected, ...options } = {}) {
  const db = fakeDb(options);
  const answer = db.query.bind(db);
  const write = db.update.bind(db);
  // the versions each submission wrote, to answer its read-back
  const expectedVersions = new Map();
  db.update = async (q) => {
    const request = q.match(/<([^>]+)> a cr:ChangeRequest ;/)?.[1];
    if (request) expectedVersions.set(request, (q.match(/a cr:ProposedVersion ;/g) || []).length);
    return write(q);
  };
  const uriTerm = (value) => ({ type: 'uri', value });
  const literalTerm = (value) => ({ type: 'literal', value: String(value) });
  const readBack = (q) => {
    if (q.includes('SELECT ?status (COUNT(DISTINCT ?version) AS ?versions)')) {
      const request = q.match(/\n {2}<([^>]+)> adms:status \?status/)[1];
      return [{ status: uriTerm(STATUS.ingediend), versions: literalTerm(submitted(expectedVersions.get(request) ?? 0)) }];
    }
    if (q.includes('SELECT DISTINCT ?s ?p ?o')) {
      // the triples asked for exist, but for the missing ones (counted from the end)
      const asked = q.slice(q.indexOf('VALUES (?s ?p ?o) {'), q.indexOf('}', q.indexOf('VALUES (?s ?p ?o) {'))).split('(<').slice(1);
      const found = asked.slice(0, asked.length - missingTriples(asked.length));
      return found.map((triple) => ({ s: uriTerm(triple.slice(0, triple.indexOf('>'))), p: uriTerm('p'), o: literalTerm(triple) }));
    }
    if (q.includes('SELECT ?s ?p ?o\nWHERE {\n  VALUES (?s ?p)') && q.includes('lastModifiedBy')) {
      // the fields an apply replaced, read back: one value each, or as many as the test says
      return pairsOf(q).flatMap(([s, p]) => Array.from({ length: values(s, p) ?? 1 }, (_, n) => ({ s: uriTerm(s), p: uriTerm(p), o: literalTerm(`value ${n}`) })));
    }
    if (q.includes('SELECT DISTINCT ?record')) return leftovers().map((record) => ({ record: uriTerm(record) }));
    if (q.includes('SELECT (COUNT(DISTINCT ?step) AS ?n)')) return [{ n: literalTerm([...q.matchAll(/\(<[^>]+> <[^>]+>\)/g)].length) }];
    return null;
  };
  db.query = async (q) => {
    const found = readBack(q);
    if (!found) return answer(q);
    await tick();
    parses(q);
    db.queries.push(q);
    return { results: { bindings: found } };
  };
  return db;
}
const verifying = (db) => createService({ model, config, db, mintUuid: uuidSequence(), clock: clock(), verifyWrites: true });
const renameOnly = () => rename('Stad Aalst', 'Aalst');

test('an apply is read back before the request is marked afgehandeld: a complete one is', async () => {
  const db = verifyingDb();
  const { document } = await verifying(db).create(sessions.orgA, renameOnly());
  assert.equal(document.attributes.status, 'afgehandeld');
  assert.ok(db.queries.some((q) => q.includes('SELECT DISTINCT ?s ?p ?o') && q.includes('"""Stad Aalst"""')), 'the new name is read back');
  assert.ok(db.queries.some((q) => q.includes('SELECT ?s ?p ?o') && q.includes('lastModifiedBy')), 'and that it is the only one');
  assert.deepEqual(statusesSet(db), ['afgehandeld']);
});

test('an apply the triplestore cut short is run again; one that stays incomplete is mislukt, and the request is kept with the reason', async () => {
  let attempts = 0;
  const once = verifyingDb({ missingTriples: () => (attempts++ === 0 ? 1 : 0) });
  assert.equal((await verifying(once).create(sessions.orgA, renameOnly())).document.attributes.status, 'afgehandeld', 'complete the second time');
  assert.equal(writes(once).filter(isApply).length, 2);
  const always = verifyingDb({ values: (s, p) => (p === prefLabel ? 2 : null) });
  await assert.rejects(() => verifying(always).create(sessions.orgA, renameOnly()), (error) => {
    assert.equal(error.status, 409);
    assert.match(error.detail, new RegExp(`${URIS.org} ${prefLabel} holds 2 values instead of 1`));
    return true;
  });
  assert.deepEqual(statusesSet(always), ['mislukt']);
});

test('a submission the triplestore cut short is written again; one that stays incomplete is withdrawn and answered with a 500', async () => {
  let attempts = 0;
  const once = verifyingDb({ submitted: (expected) => (attempts++ === 0 ? expected - 1 : expected) });
  const kept = await verifying(once).create(sessions.orgA, body(IDS.org, 'change-event', changeEventOperations()));
  assert.equal(kept.document.attributes.status, 'ingediend');
  assert.equal(writes(once).filter((q) => q.includes('a cr:ChangeRequest ;')).length, 2, 'written twice');
  const never = verifyingDb({ submitted: (expected) => expected - 1 });
  await assert.rejects(() => verifying(never).create(sessions.orgA, body(IDS.org, 'change-event', changeEventOperations())), { status: 500, title: 'The change request could not be stored', meta: { 'change-request': { id: sequenceUuid(1), status: 'ingetrokken' } } });
  assert.deepEqual(statusesSet(never), ['ingetrokken'], 'withdrawn by the service: no incomplete request waits for ABB');
});

test('when even the failure cannot be recorded, the answer says the outcome is unknown', async () => {
  const db = fakeDb({ failApply: 2 });
  const update = db.update.bind(db);
  db.update = async (q) => {
    if (q.includes('a oslc:Error')) throw new Error('Virtuoso is gone');
    return update(q);
  };
  await assert.rejects(() => service(db).create(sessions.orgA, body()), {
    status: 500,
    title: 'Applying the change request failed, and the failure could not be recorded',
    detail: /may be partly applied; reload before changing the same data again/,
  });
});
