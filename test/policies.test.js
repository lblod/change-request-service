import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canEdit, canCreate, autoApprove, canDecide, canReply, canWithdraw, evaluate, ruleName } from '../policies/index.js';
import { abbEditsAll, ownOrganisation, mayCreateClassification, editsApplyAtOnce, abbAutoApproves, abbDecidesAll, requestingOrganisation, always } from '../policies/rules.js';
import { config, sessions, organisations, IDS, URIS, testUuid } from './support/fixtures.js';

const ctx = (session, targetId, kind = 'edit') => ({
  session: session.session,
  account: session.account,
  actor: session.actor,
  target: { uri: organisations[targetId].uri, uuid: targetId, classification: organisations[targetId].classification },
  aggregate: 'organization-core-data',
  kind,
  operations: [],
  config,
});
// the organisation a creation would register: minted, pending, of the proposed classification
const creation = (session, classification = URIS.ilvCode) => ({
  ...ctx(session, IDS.org, 'creation'),
  aggregate: 'new-organisation',
  target: { uri: 'http://data.lblod.info/id/bestuurseenheden/00000000-0000-4000-8000-000000000001', uuid: '00000000-0000-4000-8000-000000000001', classification, pending: true },
});

test('rules are reported under kebab-case names', () => {
  assert.equal(ruleName(ownOrganisation), 'own-organisation');
  assert.equal(ruleName(abbEditsAll), 'abb-edits-all');
  assert.equal(ruleName(mayCreateClassification), 'may-create-classification');
  assert.equal(ruleName(editsApplyAtOnce), 'edits-apply-at-once');
  assert.equal(ruleName(abbAutoApproves), 'abb-auto-approves');
  assert.equal(ruleName(abbDecidesAll), 'abb-decides-all');
  assert.equal(ruleName(requestingOrganisation), 'requesting-organisation');
  assert.equal(ruleName(always), 'always');
});

test('canEdit: an organisation edits itself and registers change events about itself', async () => {
  assert.deepEqual(await evaluate(canEdit, ctx(sessions.orgA, IDS.org)), { decision: 'allow', rule: 'own-organisation' });
  assert.deepEqual(await evaluate(canEdit, ctx(sessions.orgA, IDS.org, 'change-event')), { decision: 'allow', rule: 'own-organisation' });
});

test('canEdit: no rule answers for another organisation, which means deny', async () => {
  assert.deepEqual(await evaluate(canEdit, ctx(sessions.orgA, IDS.orgB)), { decision: 'deny', rule: null });
});

test('canEdit: ABB edits everything, and the first rule that answers decides', async () => {
  assert.deepEqual(await evaluate(canEdit, ctx(sessions.abb, IDS.orgB)), { decision: 'allow', rule: 'abb-edits-all' });
  assert.deepEqual(await evaluate(canEdit, ctx(sessions.abb, IDS.abb)), { decision: 'allow', rule: 'abb-edits-all' });
});

test('canCreate: a gemeente requests the classifications it manages ("Wie beheert"), ABB any; a pending target is never "own"', async () => {
  assert.deepEqual(await evaluate(canCreate, creation(sessions.orgA)), { decision: 'allow', rule: 'may-create-classification' });
  assert.deepEqual(await evaluate(canCreate, creation(sessions.orgA, URIS.gemeenteCode)), { decision: 'deny', rule: null }, 'a gemeente does not request a gemeente');
  assert.deepEqual(await evaluate(canCreate, creation(sessions.orgA, null)), { decision: 'deny', rule: null }, 'no classification proposed');
  assert.deepEqual(await evaluate(canCreate, creation(sessions.abb, URIS.gemeenteCode)), { decision: 'allow', rule: 'abb-edits-all' });
  assert.deepEqual(await evaluate(canEdit, creation(sessions.orgA)), { decision: 'deny', rule: null }, 'ownOrganisation needs an organisation that exists');
});

test('autoApprove: an edit is applied at once; a creation or change event waits unless ABB requests it', async () => {
  assert.deepEqual(await evaluate(autoApprove, { ...ctx(sessions.orgA, IDS.org), conflicts: [] }), { decision: 'allow', rule: 'edits-apply-at-once' });
  assert.deepEqual(await evaluate(autoApprove, { ...ctx(sessions.orgA, IDS.org, 'change-event'), conflicts: [] }), { decision: 'deny', rule: null });
  assert.deepEqual(await evaluate(autoApprove, { ...creation(sessions.orgA), conflicts: [] }), { decision: 'deny', rule: null });
  assert.deepEqual(await evaluate(autoApprove, { ...ctx(sessions.abb, IDS.org, 'change-event'), conflicts: [] }), { decision: 'allow', rule: 'abb-auto-approves' });
  assert.deepEqual(await evaluate(autoApprove, { ...creation(sessions.abb), conflicts: [] }), { decision: 'allow', rule: 'abb-auto-approves' });
});

// a pending request of organisation A about itself
const onRequest = (session, requestedBy = URIS.org) => ({ ...ctx(session, IDS.org), request: { uri: `http://data.lblod.info/id/change-requests/${testUuid('request', 1)}`, uuid: testUuid('request', 1), status: 'ingediend', aggregate: 'organization-core-data', requestingOrganisation: requestedBy } });

test('canDecide: only ABB approves, rejects or asks for information, also on a request an organisation made about itself', async () => {
  assert.deepEqual(await evaluate(canDecide, onRequest(sessions.abb)), { decision: 'allow', rule: 'abb-decides-all' });
  assert.deepEqual(await evaluate(canDecide, onRequest(sessions.orgA)), { decision: 'deny', rule: null });
  assert.deepEqual(await evaluate(canDecide, onRequest(sessions.orgB)), { decision: 'deny', rule: null });
});

test('canReply: the requesting organisation answers a question or contests a rejection; ABB and the target of a request by another do not', async () => {
  assert.deepEqual(await evaluate(canReply, onRequest(sessions.orgA)), { decision: 'allow', rule: 'requesting-organisation' });
  assert.deepEqual(await evaluate(canReply, onRequest(sessions.abb)), { decision: 'deny', rule: null });
  assert.deepEqual(await evaluate(canReply, onRequest(sessions.orgA, URIS.abb)), { decision: 'deny', rule: null });
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
