import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { model, NS, MODEL_DIR } from './support/fixtures.js';
import { loadModel, expandCurie } from '../lib/model.js';
import { loadConfig } from '../lib/config.js';

// The assertions hold for app-organization-portal's model files (the default MODEL_DIR) and for
// a stack that loads only part of them, such as app-lokale-verkenner (domain.json and auth.json): assertions on
// types from the other files (change-events.json, file.json, dcat.json) run only when those types
// are in the model under test.
const has = (...names) => names.every((name) => model.has(name));

test('loads every *.json model file of the directory', () => {
  const files = fs.readdirSync(MODEL_DIR).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 1, `expected the model files in ${MODEL_DIR}`);
  for (const name of ['organizations', 'administrative-units', 'registered-organizations', 'kbo-organizations', 'agents', 'sites', 'addresses', 'contact-points', 'identifiers', 'structured-identifiers', 'concepts', 'locations', 'site-types', 'accounts', 'users']) {
    assert.ok(model.has(name), `type ${name} is missing`);
  }
});

test('resolves "super" so a subtype carries the attributes and relationships of its parents', () => {
  assert.deepEqual(model.ancestors('administrative-units'), ['organizations', 'agents']);
  assert.deepEqual(model.ancestors('kbo-organizations'), ['organizations', 'agents']);
  // from organizations
  assert.equal(model.attribute('administrative-units', 'name').predicate, `${NS.skos}prefLabel`);
  assert.equal(model.relationship('administrative-units', 'primary-site').target, 'sites');
  // from agents
  assert.equal(model.relationship('administrative-units', 'contacts').predicate, `${NS.schema}contactPoint`);
  // its own
  assert.equal(model.relationship('administrative-units', 'scope').target, 'locations');
  assert.equal(model.get('administrative-units').class, `${NS.besluit}Bestuurseenheid`);
  assert.equal(model.get('administrative-units').newResourceBase, 'http://data.lblod.info/id/bestuurseenheden/');
});

test('expands CURIEs with the prefixes of their own file and keeps full IRIs', () => {
  assert.equal(model.get('addresses').class, `${NS.locn}Address`);
  assert.equal(model.attribute('addresses', 'number').predicate, `${NS.adres}Adresvoorstelling.huisnummer`);
  assert.equal(model.prefixes.org, NS.org);
  if (has('change-events', 'decisions')) {
    assert.equal(model.relationship('change-events', 'decision').predicate, 'http://data.europa.eu/m8g/hasFormalFramework');
    assert.equal(model.get('decisions').class, `${NS.besluit}Besluit`);
    assert.equal(model.attribute('decisions', 'publication-date').predicate, 'http://data.europa.eu/eli/ontology#date_publication');
  }
});

test('resolves relationship targets given by the singular "name" of a resource', () => {
  assert.equal(model.relationship('users', 'accounts').target, 'accounts');
  if (has('files')) assert.equal(model.relationship('files', 'download').target, 'files');
});

test('keeps the attribute type, the predicate, the target and the cardinality per attribute and relationship', () => {
  assert.equal(model.attribute('organizations', 'name').type, 'string');
  assert.equal(model.attribute('organizations', 'alternative-name').type, 'string-set');
  assert.equal(model.attribute('organizations', 'expected-end-date').type, 'date');
  assert.equal(model.attribute('contact-points', 'website').type, 'uri');
  if (has('catalogs', 'distributions')) {
    assert.equal(model.attribute('catalogs', 'release-date').type, 'datetime');
    assert.equal(model.attribute('distributions', 'byte-size').type, 'number');
  }
  if (has('decisions')) {
    // OP since OP-3925: document-links (uri-set); app-lokale-verkenner still: document-link (url)
    const links = model.attribute('decisions', 'document-links') ?? model.attribute('decisions', 'document-link');
    assert.ok(['uri-set', 'url'].includes(links.type), links.type);
  }
  assert.deepEqual(model.relationship('organizations', 'sites'), {
    name: 'sites',
    predicate: `${NS.org}hasSite`,
    target: 'sites',
    cardinality: 'many',
    inverse: false,
  });
  assert.equal(model.relationship('organizations', 'primary-site').cardinality, 'one');
  assert.equal(model.relationship('organizations', 'memberships').inverse, true);
  assert.equal(model.get('contact-points').newResourceBase, 'http://data.lblod.info/id/contact-punten/');
});

test('classesOf, classTree, isSubtypeOf and descendants follow the inheritance tree', () => {
  const classes = model.classesOf('organizations');
  assert.ok(classes.includes(`${NS.org}Organization`));
  assert.ok(classes.includes(`${NS.besluit}Bestuurseenheid`));
  assert.ok(classes.includes(`${NS.regorg}RegisteredOrganization`));
  assert.ok(!classes.includes(`${NS.org}Site`));
  assert.deepEqual(model.classTree('administrative-units'), [`${NS.besluit}Bestuurseenheid`, `${NS.org}Organization`, `${NS.dct}Agent`], 'as mu-cl-resources writes a create: most specific first');
  assert.deepEqual(model.classTree('sites'), [`${NS.org}Site`]);
  assert.ok(model.isSubtypeOf('kbo-organizations', 'organizations'));
  assert.ok(model.isSubtypeOf('organizations', 'organizations'));
  assert.ok(!model.isSubtypeOf('sites', 'organizations'));
  assert.ok(!model.isSubtypeOf('organizations', 'administrative-units'));
  assert.ok(model.descendants('organizations').includes('kbo-organizations'));
  assert.ok(model.descendants('agents').includes('administrative-units'));
});

test('incomingPredicates lists the relationship predicates that point at a type', () => {
  const contactPoint = model.incomingPredicates('contact-points');
  assert.ok(contactPoint.includes(`${NS.org}siteAddress`), 'sites.contacts');
  assert.ok(contactPoint.includes(`${NS.schema}contactPoint`), 'agents.contacts');
  assert.ok(!contactPoint.includes(`${NS.locn}address`), 'contact-points.contact-address points away from a contact point');
  const site = model.incomingPredicates('sites');
  assert.deepEqual(site, [`${NS.org}hasPrimarySite`, `${NS.org}hasSite`]);
  const address = model.incomingPredicates('addresses');
  assert.deepEqual(address, [`${NS.locn}address`, `${NS.organisatie}bestaatUit`]);
  // an inverse relationship declared on the type itself is incoming too
  assert.ok(model.incomingPredicates('organizations').includes(`${NS.org}member`), 'organizations.memberships-of-organizations (inverse)');
});

test('expandCurie', () => {
  const prefixes = { org: NS.org };
  assert.equal(expandCurie('org:Site', prefixes, 'x'), `${NS.org}Site`);
  assert.equal(expandCurie('http://example.org/a:b', prefixes, 'x'), 'http://example.org/a:b');
  assert.throws(() => expandCurie('nope:Thing', prefixes, 'where'), /where: unknown prefix in "nope:Thing"/);
  assert.throws(() => expandCurie('', prefixes, 'where'), /expected a URI or CURIE/);
});

const writeModel = (name, resources) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-model-'));
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ version: '0.1', prefixes: { ex: 'http://example.org/' }, resources }));
  return dir;
};

test('a subtype overrides an inherited relationship of the same name', () => {
  const small = loadModel(
    writeModel('override', {
      things: { class: 'ex:Thing', relationships: { kind: { predicate: 'ex:kind', target: 'kinds', cardinality: 'one' } } },
      'special-things': { class: 'ex:SpecialThing', super: ['things'], relationships: { kind: { predicate: 'ex:kind', target: 'special-kinds', cardinality: 'one' } } },
      kinds: { class: 'ex:Kind' },
      'special-kinds': { class: 'ex:SpecialKind', super: ['kinds'] },
    }),
  );
  assert.equal(small.relationship('things', 'kind').target, 'kinds');
  assert.equal(small.relationship('special-things', 'kind').target, 'special-kinds');
});

test('refuses a model with an unknown super or a cycle', () => {
  assert.throws(
    () => loadModel(writeModel('a', { things: { class: 'ex:Thing', super: ['nothing'], 'new-resource-base': 'http://example.org/id/things/' } })),
    /refers to the unknown resource type "nothing"/,
  );
  assert.throws(
    () => loadModel(writeModel('c', { a: { class: 'ex:A', super: ['b'] }, b: { class: 'ex:B', super: ['a'] } })),
    /inheritance cycle/,
  );
  assert.throws(() => loadModel(path.join(os.tmpdir(), 'does-not-exist-cr')), /Cannot read the resources model directory/);
});

test('a relationship to a type the loaded files do not define is left out, as mu-cl-resources starts on such a model', () => {
  const partial = loadModel(
    writeModel('dangling', {
      things: {
        class: 'ex:Thing',
        relationships: {
          other: { predicate: 'ex:other', target: 'others', cardinality: 'one' },
          kind: { predicate: 'ex:kind', target: 'kinds', cardinality: 'one' },
        },
      },
      kinds: { class: 'ex:Kind' },
    }),
  );
  assert.equal(partial.relationship('things', 'other'), undefined);
  assert.equal(partial.relationship('things', 'kind').target, 'kinds');
});

test('the configuration is checked against the model: unknown types and references that are also members are refused', () => {
  const write = (config) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-config-')), 'change-requests.json');
    fs.writeFileSync(file, JSON.stringify(config));
    return file;
  };
  const base = { abbUri: 'http://example.org/abb', statusScheme: 'http://example.org/statuses' };
  const loaded = loadConfig(write({ ...base, aggregates: { site: { root: 'sites', members: ['addresses'], references: ['site-types'] } } }), model);
  assert.deepEqual(loaded.aggregates.site.references, ['site-types']);
  assert.throws(() => loadConfig(write({ ...base, aggregates: { site: { root: 'sites', members: ['addresses'], references: ['gebouwen'] } } }), model), /names the type "gebouwen"/);
  assert.throws(() => loadConfig(write({ ...base, aggregates: { site: { root: 'sites', members: ['addresses'], references: ['addresses'] } } }), model), /both as a type it operates on and as a reference/);
  assert.throws(() => loadConfig(write({ ...base, aggregates: { site: { root: 'sites', members: ['addresses'], references: 'site-types' } } }), model), /"references" must be an array/);
});
