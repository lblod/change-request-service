import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLock } from '../lib/lock.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('tasks for the same key run one after the other, in the order they were taken', async () => {
  const withLock = createLock();
  const events = [];
  const task = (name, ticks) => async () => {
    events.push(`${name} start`);
    for (let i = 0; i < ticks; i += 1) await tick();
    events.push(`${name} end`);
    return name;
  };
  const results = await Promise.all([withLock('org', task('a', 3)), withLock('org', task('b', 1)), withLock('org', task('c', 0))]);
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.deepEqual(events, ['a start', 'a end', 'b start', 'b end', 'c start', 'c end']);
});

test('tasks for other keys run concurrently', async () => {
  const withLock = createLock();
  const events = [];
  const task = (name) => async () => {
    events.push(`${name} start`);
    await tick();
    await tick();
    events.push(`${name} end`);
  };
  await Promise.all([withLock('org-a', task('a')), withLock('org-b', task('b'))]);
  assert.deepEqual(events.slice(0, 2).sort(), ['a start', 'b start'], 'b does not wait for a');
});

test('a task that throws passes its error on and releases the key', async () => {
  const withLock = createLock();
  const failing = withLock('org', async () => {
    await tick();
    throw new Error('Virtuoso said no');
  });
  const next = withLock('org', async () => 'next');
  await assert.rejects(failing, /Virtuoso said no/);
  assert.equal(await next, 'next');
  assert.equal(await withLock('org', async () => 'again'), 'again');
});
