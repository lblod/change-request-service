import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reachableFromTarget } from '../lib/organisations.js';
import { parses } from './support/sparql.js';
import { URIS, NS, uri } from './support/fixtures.js';

test('reachableFromTarget follows forward and inverse paths from the target, the target included', async () => {
  const queries = [];
  const db = {
    async query(query) {
      parses(query);
      queries.push(query);
      return { results: { bindings: [{ resource: uri(URIS.site) }] } };
    },
  };

  const reachable = await reachableFromTarget(db, URIS.org, [
    `^${NS.org}member`,
    `${NS.org}hasSite`,
  ]);

  assert.deepEqual([...reachable], [URIS.org, URIS.site]);
  assert.equal(queries.length, 1);
  assert.ok(
    queries[0].includes(
      `<${URIS.org}> (^<${NS.org}member>|<${NS.org}hasSite>)+ ?resource .`,
    ),
  );
});

test('reachableFromTarget returns the target alone when the aggregate has no paths', async () => {
  const db = {
    async query() {
      throw new Error('no query expected');
    },
  };

  assert.deepEqual([...await reachableFromTarget(db, URIS.org, [])], [URIS.org]);
});
