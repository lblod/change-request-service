import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canEdit, autoApprove, canDecide, canWithdraw, evaluate, ruleName } from '../policies/index.js';
import { abbEditsAll, ownOrganisation, abbDecidesAll, requestingOrganisation, holdOnConflict, always } from '../policies/rules.js';
import { config, sessions, organisations, IDS, URIS, testUuid } from './support/fixtures.js';

const ctx = (session, targetId) => ({
  session: session.session,
  account: session.account,
  actor: session.actor,
  target: { uri: organisations[targetId].uri, uuid: targetId, classification: organisations[targetId].classification },
  aggregate: 'organization-core-data',
  operations: [],
  config,
});

test('rules are reported under kebab-case names', () => {
  assert.equal(ruleName(ownOrganisation), 'own-organisation');
  assert.equal(ruleName(abbEditsAll), 'abb-edits-all');
  assert.equal(ruleName(abbDecidesAll), 'abb-decides-all');
  assert.equal(ruleName(requestingOrganisation), 'requesting-organisation');
  assert.equal(ruleName(holdOnConflict), 'hold-on-conflict');
  assert.equal(ruleName(always), 'always');
});

test('canEdit: an organisation edits itself', async () => {
  assert.deepEqual(await evaluate(canEdit, ctx(sessions.orgA, IDS.org)), { decision: 'allow', rule: 'own-organisation' });
});

test('canEdit: no rule answers for another organisation, which means deny', async () => {
  assert.deepEqual(await evaluate(canEdit, ctx(sessions.orgA, IDS.orgB)), { decision: 'deny', rule: null });
});

test('canEdit: ABB edits everything, and the first rule that answers decides', async () => {
  assert.deepEqual(await evaluate(canEdit, ctx(sessions.abb, IDS.orgB)), { decision: 'allow', rule: 'abb-edits-all' });
  assert.deepEqual(await evaluate(canEdit, ctx(sessions.abb, IDS.abb)), { decision: 'allow', rule: 'abb-edits-all' });
});

test('autoApprove: a request without conflicts is approved by the service, one with conflicts waits (hold-on-conflict)', async () => {
  assert.deepEqual(await evaluate(autoApprove, { ...ctx(sessions.orgA, IDS.org), conflicts: [] }), { decision: 'allow', rule: 'always' });
  const conflict = { resource: { type: 'administrative-units', id: IDS.org }, key: 'name', base: 'Aalst', current: 'Aalst (ABB)', proposed: 'Aalst (A)', 'competing-requests': [] };
  assert.deepEqual(await evaluate(autoApprove, { ...ctx(sessions.orgA, IDS.org), conflicts: [conflict] }), { decision: 'deny', rule: 'hold-on-conflict' });
  assert.deepEqual(await evaluate(autoApprove, { ...ctx(sessions.abb, IDS.org), conflicts: [conflict] }), { decision: 'deny', rule: 'hold-on-conflict' }, 'for ABB as well');
});

// a pending request of organisation A about itself
const onRequest = (session, requestedBy = URIS.org) => ({ ...ctx(session, IDS.org), request: { uri: `http://data.lblod.info/id/change-requests/${testUuid('request', 1)}`, uuid: testUuid('request', 1), status: 'ingediend', aggregate: 'organization-core-data', requestingOrganisation: requestedBy } });

test('canDecide: only ABB approves or rejects, also on a request an organisation made about itself', async () => {
  assert.deepEqual(await evaluate(canDecide, onRequest(sessions.abb)), { decision: 'allow', rule: 'abb-decides-all' });
  assert.deepEqual(await evaluate(canDecide, onRequest(sessions.orgA)), { decision: 'deny', rule: null });
  assert.deepEqual(await evaluate(canDecide, onRequest(sessions.orgB)), { decision: 'deny', rule: null });
});

test('canWithdraw: the requesting organisation and ABB withdraw, the target of a request by another does not', async () => {
  assert.deepEqual(await evaluate(canWithdraw, onRequest(sessions.orgA)), { decision: 'allow', rule: 'requesting-organisation' });
  assert.deepEqual(await evaluate(canWithdraw, onRequest(sessions.abb)), { decision: 'allow', rule: 'abb-edits-all' });
  assert.deepEqual(await evaluate(canWithdraw, onRequest(sessions.orgB)), { decision: 'deny', rule: null });
  assert.deepEqual(await evaluate(canWithdraw, onRequest(sessions.orgA, URIS.abb)), { decision: 'deny', rule: null }, 'A does not withdraw what ABB asked about A');
});

test('evaluate: the first answer wins, an explicit deny stops the evaluation, a bad answer is an error', async () => {
  const deny = async () => 'deny';
  const silent = async () => undefined;
  assert.deepEqual(await evaluate([silent, deny, always], {}), { decision: 'deny', rule: 'deny' });
  assert.deepEqual(await evaluate([silent, silent], {}), { decision: 'deny', rule: null });
  const wrong = async () => 'maybe';
  await assert.rejects(() => evaluate([wrong], {}), /answered "maybe"/);
});
