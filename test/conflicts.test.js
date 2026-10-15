import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  storedPairs,
  storedIncomingPairs,
  storedConflicts,
  missingMasters,
  linkingRecords,
  resolveLinks,
  writtenPairs,
  disagree,
  competingRequests,
  attachCompeting,
  competingKeys,
  relatedUris,
  renderConflict,
  renderCompeting,
  conflictsToken,
  overriddenConflicts,
} from '../lib/conflicts.js';
import { versionsFromStore, statesFromStore } from '../lib/versions.js';
import { OPERATION } from '../constants.js';
import { model, masterState, currentMap, IDS, URIS, NS, uri, literal, testUuid } from './support/fixtures.js';

const RID = (n) => testUuid('request', n);
const VERSION = (n) => `http://data.lblod.info/id/proposed-versions/${testUuid('version', n)}`;
const STATE = (n) => `http://data.lblod.info/id/record-states/${testUuid('state', n)}`;
const LINK = (n) => `http://data.lblod.info/id/record-links/${testUuid('link', n)}`;
const STEP = (n) => `http://data.lblod.info/id/change-request-actions/${testUuid('step', n)}`;
const REQUEST = (n) => `http://data.lblod.info/id/change-requests/${RID(n)}`;

/**
 * Rows of storedVersionsQuery for one version of request n: base the values of its base state,
 * links [predicate, subject] the links its base state remembers (a tombstone's).
 */
function versionRows(n, { version, master, masterUuid, type, operation = 'update', replaces = [], values = [], base, links = [] }) {
  const rows = [];
  const row = (p, o, record = {}) =>
    rows.push({ request: uri(REQUEST(n)), version: uri(VERSION(version)), master: uri(master), masterUuid: literal(masterUuid), type: literal(type), operation: uri(OPERATION[operation]), p: uri(p), o, ...record });
  row(`${NS.rdf}type`, uri(`${NS.cr}ProposedVersion`));
  for (const predicate of replaces) row(`${NS.cr}changesProperty`, uri(predicate));
  for (const [p, o] of values) row(p, o);
  if (base) {
    const state = { base: uri(STATE(version)) };
    row(`${NS.cr}base`, uri(STATE(version)));
    row(`${NS.rdf}type`, uri(`${NS.cr}RecordState`), state);
    row(`${NS.dct}isVersionOf`, uri(master), state);
    for (const [p, o] of base) row(p, o, state);
    links.forEach(([p, subject], index) => {
      const link = { ...state, link: uri(LINK(100 * version + index)) };
      row(`${NS.cr}incomingLink`, uri(LINK(100 * version + index)), state);
      row(`${NS.rdf}type`, uri(`${NS.rdf}Statement`), link);
      row(`${NS.rdf}subject`, uri(subject), link);
      row(`${NS.rdf}predicate`, uri(p), link);
      row(`${NS.rdf}object`, uri(master), link);
    });
  }
  return rows;
}

/** Rows of replacedStatesQuery: a state of master that step (of request n) replaced. */
function stateRows(n, step, { state, master, values = [], links = [] }) {
  const rows = [];
  const row = (p, o, extra = {}) => rows.push({ request: uri(REQUEST(n)), step: uri(STEP(step)), state: uri(STATE(state)), master: uri(master), p: uri(p), o, ...extra });
  row(`${NS.rdf}type`, uri(`${NS.cr}RecordState`));
  row(`${NS.dct}isVersionOf`, uri(master));
  for (const [p, o] of values) row(p, o);
  links.forEach(([p, subject], index) => {
    const link = { link: uri(LINK(1000 + 10 * state + index)) };
    row(`${NS.cr}incomingLink`, uri(LINK(1000 + 10 * state + index)));
    row(`${NS.rdf}type`, uri(`${NS.rdf}Statement`), link);
    row(`${NS.rdf}subject`, uri(subject), link);
    row(`${NS.rdf}predicate`, uri(p), link);
    row(`${NS.rdf}object`, uri(master), link);
  });
  return rows;
}

/**
 * One pending request: an update of the organisation's name (base "Aalst", proposal "Aalst (A)")
 * and of its primary site (base the site, proposal none), and an update of the address's street
 * (base "Grote Markt", proposal "Nieuwe straat").
 */
function storedRows() {
  const org = { version: 1, master: URIS.org, masterUuid: IDS.org, type: 'administrative-units' };
  return [
    ...versionRows(1, {
      ...org,
      replaces: [`${NS.skos}prefLabel`, `${NS.org}hasPrimarySite`],
      values: [[`${NS.skos}prefLabel`, literal('Aalst (A)')]],
      base: [[`${NS.skos}prefLabel`, literal('Aalst')], [`${NS.org}hasPrimarySite`, uri(URIS.site)]],
    }),
    ...versionRows(1, {
      version: 2, master: URIS.address, masterUuid: IDS.address, type: 'addresses',
      replaces: [`${NS.locn}thoroughfare`],
      values: [[`${NS.locn}thoroughfare`, literal('Nieuwe straat')]],
      base: [[`${NS.locn}thoroughfare`, literal('Grote Markt')]],
    }),
  ];
}
const stored = (rows) => versionsFromStore({ results: { bindings: rows } }, model);
const versions = () => stored(storedRows());
const state = (changes = {}) => currentMap({ ...masterState(), ...changes });
const live = (list, current = state(), incoming = new Map()) => storedConflicts({ versions: list, current, incoming, model });

test('storedPairs: the existence of every updated or deleted master, and the keys the versions change', () => {
  assert.deepEqual(storedPairs(versions()), [
    { subject: URIS.org, predicate: `${NS.rdf}type` },
    { subject: URIS.org, predicate: `${NS.skos}prefLabel` },
    { subject: URIS.org, predicate: `${NS.org}hasPrimarySite` },
    { subject: URIS.address, predicate: `${NS.rdf}type` },
    { subject: URIS.address, predicate: `${NS.locn}thoroughfare` },
  ]);
});

test('live conflicts: a key conflicts when the master holds neither the base nor the proposal', () => {
  // as submitted: name "Aalst", primary site the site: no conflict
  assert.deepEqual(live(versions()), []);
  // since then ABB renamed the organisation: the name conflicts, the primary site does not
  const renamed = live(versions(), state({ [`${URIS.org} ${NS.skos}prefLabel`]: [literal('Aalst (ABB)')] }));
  assert.equal(renamed.length, 1);
  assert.equal(renamed[0].key.name, 'name');
  assert.deepEqual([renamed[0].base, renamed[0].current, renamed[0].proposed, renamed[0].masterExists], [['Aalst'], ['Aalst (ABB)'], ['Aalst (A)'], true]);
  // someone made the same change: agreement, no conflict
  assert.deepEqual(live(versions(), state({ [`${URIS.org} ${NS.skos}prefLabel`]: [literal('Aalst (A)')] })), []);
  // the primary site was cleared meanwhile, which is also what the request proposes
  assert.deepEqual(live(versions(), state({ [`${URIS.org} ${NS.org}hasPrimarySite`]: [] })), []);
  // another primary site: a relationship conflict
  const moved = live(versions(), state({ [`${URIS.org} ${NS.org}hasPrimarySite`]: [uri(URIS.siteB)] }));
  assert.deepEqual(moved.map((conflict) => [conflict.key.name, conflict.base, conflict.current, conflict.proposed]), [['primary-site', [URIS.site], [URIS.siteB], []]]);
});

test('a set key merges and never conflicts: additions made since by others stay', () => {
  // the request added a site to the one the page loaded; another site was added meanwhile
  const added = `http://data.lblod.info/id/vestigingen/${testUuid('version', 91)}`;
  const other = `http://data.lblod.info/id/vestigingen/${testUuid('version', 92)}`;
  const list = stored(
    versionRows(1, {
      version: 1, master: URIS.org, masterUuid: IDS.org, type: 'administrative-units',
      replaces: [`${NS.org}hasSite`],
      values: [[`${NS.org}hasSite`, uri(URIS.site)], [`${NS.org}hasSite`, uri(added)]],
      base: [[`${NS.org}hasSite`, uri(URIS.site)]],
    }),
  );
  assert.deepEqual(live(list, state({ [`${URIS.org} ${NS.org}hasSite`]: [uri(URIS.site), uri(other)] })), []);
});

test('a master that no longer exists conflicts on every key, with current null; it is a missing master', () => {
  const gone = state({ [`${URIS.org} ${NS.rdf}type`]: [] });
  const conflicts = live(versions(), gone);
  assert.deepEqual(conflicts.map((conflict) => [conflict.key.name, conflict.current, conflict.masterExists]), [['name', null, false], ['primary-site', null, false]]);
  assert.ok(!conflicts.some((conflict) => conflict.version.masterUri === URIS.address));
  assert.deepEqual(missingMasters(versions(), gone).map((version) => version.masterUri), [URIS.org]);
  assert.deepEqual(missingMasters(versions(), state({ [`${URIS.address} ${NS.rdf}type`]: [] })).map((version) => version.masterUri), [URIS.address]);
  assert.deepEqual(missingMasters(versions(), state()), []);
});

// A pending tombstone of the old contact point: its email was e0 and the site linked it.
const tombstone = () =>
  stored(
    versionRows(3, {
      version: 3, master: URIS.oldContact, masterUuid: IDS.oldContact, type: 'contact-points', operation: 'delete',
      replaces: [`${NS.schema}email`, `${NS.schema}telephone`],
      base: [[`${NS.schema}email`, literal('e0@aalst.be')]],
      links: [[`${NS.org}siteAddress`, URIS.site]],
    }),
  );
const contactState = (changes = {}) => state({ [`${URIS.oldContact} ${NS.schema}email`]: [literal('e0@aalst.be')], ...changes });
const links = (entries) => new Map(entries.map(([o, p, subjects]) => [`${o} ${p}`, subjects.map(uri)]));

test('a pending tombstone conflicts on a value set since, and on a link made since; not when the record is gone already', () => {
  const [version] = tombstone();
  assert.deepEqual(version.replaces, [`${NS.schema}email`, `${NS.schema}telephone`]);
  assert.equal(version.operation, 'delete');
  assert.deepEqual(version.base.links, [{ subject: URIS.site, predicate: `${NS.org}siteAddress` }]);
  assert.deepEqual(storedIncomingPairs([version], model), model.incomingPredicates('contact-points').map((predicate) => ({ object: URIS.oldContact, predicate })));
  const linked = links([[URIS.oldContact, `${NS.org}siteAddress`, [URIS.site]]]);
  assert.deepEqual(live([version], contactState(), linked), [], 'as submitted');
  assert.deepEqual(live([version], contactState({ [`${URIS.oldContact} ${NS.schema}email`]: [] }), linked), [], 'cleared since: what the delete does anyway');
  const edited = live([version], contactState({ [`${URIS.oldContact} ${NS.schema}email`]: [literal('e1@aalst.be')], [`${URIS.oldContact} ${NS.schema}telephone`]: [literal('053')] }), linked);
  assert.deepEqual(edited.map((conflict) => [conflict.key.name, conflict.base, conflict.current, conflict.proposed]), [['email', ['e0@aalst.be'], ['e1@aalst.be'], []], ['telephone', [], ['053'], []]]);
  // another site links it now
  const relinked = live([version], contactState(), links([[URIS.oldContact, `${NS.org}siteAddress`, [URIS.site, URIS.siteB]]]));
  assert.deepEqual(relinked.map((conflict) => conflict.link), [{ subject: URIS.siteB, predicate: `${NS.org}siteAddress` }]);
  assert.deepEqual(linkingRecords(relinked), [URIS.siteB]);
  const [resolved] = resolveLinks(relinked, new Map([[URIS.siteB, { uuid: IDS.siteB, classes: [`${NS.org}Site`] }]]), model);
  assert.deepEqual(renderConflict(resolved, new Map([[URIS.oldContact, IDS.oldContact]])), {
    resource: { type: 'sites', id: IDS.siteB },
    key: 'contacts',
    base: [],
    current: [{ type: 'contact-points', id: IDS.oldContact }],
    proposed: [],
    'master-exists': true,
    'competing-requests': [],
  });
  assert.deepEqual(live([version], contactState({ [`${URIS.oldContact} ${NS.rdf}type`]: [], [`${URIS.oldContact} ${NS.schema}email`]: [literal('e1@aalst.be')] }), linked), [], 'deleted already');
});

test('competing requests: a pending request that writes the same key with another value; set keys only when one adds what the other removes', () => {
  const rename = (n, proposed) => versionRows(n, { version: n, master: URIS.org, masterUuid: IDS.org, type: 'administrative-units', replaces: [`${NS.skos}prefLabel`], values: proposed ? [[`${NS.skos}prefLabel`, literal(proposed)]] : [], base: [[`${NS.skos}prefLabel`, literal('Aalst')]] });
  const own = stored(rename(1, 'Aalst (A)'));
  const others = stored([...rename(2, 'Aalst (B)'), ...rename(3, 'Aalst (A)'), ...rename(4, null)]);
  const uuids = new Map([2, 3, 4].map((n) => [REQUEST(n), RID(n)]));
  assert.deepEqual(writtenPairs(own), [{ subject: URIS.org, predicate: `${NS.skos}prefLabel` }]);
  const competing = competingRequests(own, [...own, ...others], uuids);
  assert.deepEqual([...competing], [[`${VERSION(1)} ${NS.skos}prefLabel`, [RID(2), RID(4)]]], 'r3 agrees, r4 clears the name, r1 is itself');
  // as a submission: the versions are not stored yet, their request is named
  const submitted = own.map((version) => ({ ...version, requestUri: null }));
  assert.deepEqual([...competingRequests(submitted, others, uuids, REQUEST(9)).values()], [[RID(2), RID(4)]]);
  // conflicts get the competing requests of their key, and the keys are listed with them
  const conflicts = attachCompeting(live(own, state({ [`${URIS.org} ${NS.skos}prefLabel`]: [literal('Aalst (ABB)')] })), competing);
  assert.deepEqual(conflicts[0].competing, [RID(2), RID(4)]);
  const keys = competingKeys(own, competing);
  assert.deepEqual(renderCompeting(keys[0]), { resource: { type: 'administrative-units', id: IDS.org }, key: 'name', proposed: 'Aalst (A)', 'competing-requests': [RID(2), RID(4)] });

  // sets: two additions to the same base merge, an addition of what the other removes competes
  const key = { name: 'sites', kind: 'relationship', predicate: `${NS.org}hasSite`, cardinality: 'many', target: 'sites' };
  const proposal = (proposed, base, deleted = false) => ({ key, proposed, base, deleted });
  assert.equal(disagree(proposal(['s1', 'n1'], ['s1']), proposal(['s1', 'n2'], ['s1'])), false, 'two additions');
  assert.equal(disagree(proposal(['s1'], ['s1', 'n1']), proposal(['s1', 'n1', 'n2'], ['s1'])), true, 'one removes n1, the other adds it');
  assert.equal(disagree(proposal(['s1', 'n1'], null), proposal(['s1', 'n2'], ['s1'])), true, 'without a base: the whole proposals');
  assert.equal(disagree(proposal([], ['s1'], true), proposal(['s1', 'n2'], ['s1'])), true, 'a tombstone against an update');
  const name = { name: 'name', kind: 'attribute', predicate: `${NS.skos}prefLabel`, attributeType: 'string' };
  assert.equal(disagree({ key: name, proposed: ['a'], base: ['x'] }, { key: name, proposed: ['a'], base: ['y'] }), false, 'the same value');
});

test('conflicts render as the API shows them, with the token that overrides exactly them', () => {
  const conflicts = live(versions(), state({ [`${URIS.org} ${NS.skos}prefLabel`]: [literal('Aalst (ABB)')], [`${URIS.org} ${NS.org}hasPrimarySite`]: [uri(URIS.siteB)] }));
  attachCompeting(conflicts, new Map());
  assert.deepEqual(relatedUris(conflicts).sort(), [URIS.site, URIS.siteB].sort());
  const uuids = new Map([[URIS.site, IDS.site], [URIS.siteB, IDS.siteB]]);
  const rendered = conflicts.map((conflict) => renderConflict(conflict, uuids));
  assert.deepEqual(rendered, [
    { resource: { type: 'administrative-units', id: IDS.org }, key: 'name', base: 'Aalst', current: 'Aalst (ABB)', proposed: 'Aalst (A)', 'master-exists': true, 'competing-requests': [] },
    {
      resource: { type: 'administrative-units', id: IDS.org },
      key: 'primary-site',
      base: { type: 'sites', id: IDS.site },
      current: { type: 'sites', id: IDS.siteB },
      proposed: null,
      'master-exists': true,
      'competing-requests': [],
    },
  ]);
  const gone = live(versions(), state({ [`${URIS.org} ${NS.rdf}type`]: [] }));
  assert.deepEqual([renderConflict(gone[0]).current, renderConflict(gone[0])['master-exists']], [null, false]);

  const token = conflictsToken(rendered);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(conflictsToken([...rendered].reverse()), token, 'the order does not matter');
  assert.equal(conflictsToken(rendered.map((conflict) => ({ ...conflict, 'competing-requests': [RID(7)] }))), token, 'nor do the competing requests');
  assert.notEqual(conflictsToken([{ ...rendered[0], current: 'Aalst (B)' }, rendered[1]]), token, 'another current value is another token');
  assert.notEqual(conflictsToken([rendered[0]]), token, 'so is a conflict less');
  assert.equal(conflictsToken([]), null);
});

test('the states a step replaced are read back per step, with their links', () => {
  const byStep = statesFromStore({
    results: {
      bindings: [
        ...stateRows(1, 51, { state: 1, master: URIS.org, values: [[`${NS.skos}prefLabel`, literal('Aalst (ABB)')]] }),
        ...stateRows(1, 51, { state: 2, master: URIS.oldContact, values: [[`${NS.schema}email`, literal('e1@aalst.be')]], links: [[`${NS.org}siteAddress`, URIS.siteB]] }),
        ...stateRows(2, 52, { state: 3, master: URIS.address }),
      ],
    },
  });
  assert.deepEqual([...byStep.keys()], [STEP(51), STEP(52)]);
  const [org, contact] = byStep.get(STEP(51));
  assert.deepEqual([org.uri, org.masterUri, org.requestUri, [...org.terms.keys()], org.links], [STATE(1), URIS.org, REQUEST(1), [`${NS.skos}prefLabel`], []]);
  assert.deepEqual(contact.links, [{ subject: URIS.siteB, predicate: `${NS.org}siteAddress` }]);
  assert.deepEqual([...byStep.get(STEP(52))[0].terms], [], 'the street was empty');
});

test('the conflicts an apply overrode come from the states it replaced, in place of the current values', () => {
  const states = (rows) => statesFromStore({ results: { bindings: rows } }).get(STEP(51));
  // ABB had renamed the organisation when the request was approved; the street was as the form had it
  const renamed = states([
    ...stateRows(1, 51, { state: 1, master: URIS.org, values: [[`${NS.skos}prefLabel`, literal('Aalst (ABB)')], [`${NS.org}hasPrimarySite`, uri(URIS.site)]] }),
    ...stateRows(1, 51, { state: 2, master: URIS.address, values: [[`${NS.locn}thoroughfare`, literal('Grote Markt')]] }),
  ]);
  const overridden = overriddenConflicts({ versions: versions(), states: renamed, model });
  assert.deepEqual(overridden.map((conflict) => [conflict.key.name, conflict.base, conflict.current, conflict.proposed]), [['name', ['Aalst'], ['Aalst (ABB)'], ['Aalst (A)']]]);
  // as the form had them: nothing overridden
  const asLoaded = states(stateRows(1, 51, { state: 1, master: URIS.org, values: [[`${NS.skos}prefLabel`, literal('Aalst')], [`${NS.org}hasPrimarySite`, uri(URIS.site)]] }));
  assert.deepEqual(overriddenConflicts({ versions: versions(), states: asLoaded, model }), []);
  // a delete overrode an edit of the record and a link made since it was submitted
  const deleted = states(stateRows(3, 51, { state: 3, master: URIS.oldContact, values: [[`${NS.schema}email`, literal('e1@aalst.be')]], links: [[`${NS.org}siteAddress`, URIS.site], [`${NS.org}siteAddress`, URIS.siteB]] }));
  const tombstoned = overriddenConflicts({ versions: tombstone(), states: deleted, model });
  assert.deepEqual(tombstoned.map((conflict) => conflict.key?.name ?? conflict.link), ['email', { subject: URIS.siteB, predicate: `${NS.org}siteAddress` }]);
  // a step that replaced no states (it applied only creates) overrode nothing
  assert.deepEqual(overriddenConflicts({ versions: versions(), states: [], model }), []);
});
