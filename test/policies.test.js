import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canEdit, autoApprove, evaluate, ruleName } from '../policies/index.js';
import { abbEditsAll, ownOrganisation, always } from '../policies/rules.js';
import { config, sessions, organisations, IDS } from './support/fixtures.js';

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

test('autoApprove always allows in iteration 1', async () => {
  assert.deepEqual(await evaluate(autoApprove, ctx(sessions.orgA, IDS.org)), { decision: 'allow', rule: 'always' });
});

test('evaluate: the first answer wins, an explicit deny stops the evaluation, a bad answer is an error', async () => {
  const deny = async () => 'deny';
  const silent = async () => undefined;
  assert.deepEqual(await evaluate([silent, deny, always], {}), { decision: 'deny', rule: 'deny' });
  assert.deepEqual(await evaluate([silent, silent], {}), { decision: 'deny', rule: null });
  const wrong = async () => 'maybe';
  await assert.rejects(() => evaluate([wrong], {}), /answered "maybe"/);
});
