import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributeItemsFromJson, attributeItemsFromTerms, itemsFromTerms, sameItems, keyJson, keyByPredicate } from '../lib/values.js';
import { model, NS, IDS, URIS, uri, literal, typed } from './support/fixtures.js';

// A JSON value as the client sends it equals the term the triplestore holds for it.
const equal = (type, json, bindings) => sameItems(attributeItemsFromJson(type, json), attributeItemsFromTerms(type, bindings));

test('strings compare exactly: case, whitespace and accents matter, a language tag on the stored value does not', () => {
  assert.ok(equal('string', 'Stad Aalst', [literal('Stad Aalst')]));
  assert.ok(!equal('string', 'stad aalst', [literal('Stad Aalst')]));
  assert.ok(!equal('string', 'Stad Aalst ', [literal('Stad Aalst')]));
  assert.ok(!equal('string', 'Belgie', [literal('België')]));
  assert.ok(equal('string', 'Aalst', [literal('Aalst', 'nl')]), 'a string attribute compares the lexical value');
  assert.ok(equal('string', null, []), 'null is no value');
  assert.ok(!equal('string', '', []), 'an empty string is a value');
});

test('language strings compare by value and tag; the tag as written (first word, any case)', () => {
  assert.ok(equal('language-string', { content: 'Stad', language: 'nl' }, [literal('Stad', 'nl')]));
  assert.ok(equal('language-string', { content: 'Stad', language: 'nl-BE' }, [literal('Stad', 'NL')]));
  assert.ok(!equal('language-string', { content: 'Stad', language: 'en' }, [literal('Stad', 'nl')]));
  assert.ok(!equal('language-string', { content: 'Stad ', language: 'nl' }, [literal('Stad', 'nl')]));
});

test('dates, datetimes, numbers and booleans compare by value', () => {
  assert.ok(equal('date', '2030-12-31', [typed('2030-12-31', 'date')]));
  assert.ok(equal('date', '2030-12-31', [typed('2030-12-31Z', 'date')]));
  assert.ok(!equal('date', '2030-12-30', [typed('2030-12-31', 'date')]));
  assert.ok(equal('datetime', '2026-01-01T01:00:00+01:00', [typed('2026-01-01T00:00:00Z', 'dateTime')]));
  assert.ok(equal('datetime', '2026-01-01T00:00:00.000Z', [typed('2026-01-01T00:00:00Z', 'dateTime')]));
  assert.ok(!equal('datetime', '2026-01-01T00:00:01Z', [typed('2026-01-01T00:00:00Z', 'dateTime')]));
  assert.ok(equal('number', 42, [typed('42.0', 'decimal')]));
  assert.ok(equal('integer', 7, [typed('7', 'integer')]));
  assert.ok(equal('float', 1.5, [typed('1.5E0', 'float')]));
  assert.ok(!equal('number', 42, [typed('42.5', 'decimal')]));
  assert.ok(equal('boolean', true, [typed('true', 'boolean')]));
  assert.ok(equal('boolean', true, [typed('1', 'boolean')]));
  assert.ok(equal('boolean', false, [typed('0', 'boolean')]));
  assert.ok(!equal('boolean', false, [typed('true', 'boolean')]));
  assert.ok(!equal('number', 12, [literal('twelve')]), 'a stored value that does not parse only equals itself');
});

test('sets compare as sets: order and duplicates do not matter, membership does', () => {
  assert.ok(equal('string-set', ['Aalst', 'Stad Aalst'], [literal('Stad Aalst'), literal('Aalst')]));
  assert.ok(equal('string-set', ['Aalst', 'Aalst'], [literal('Aalst')]));
  assert.ok(!equal('string-set', ['Aalst'], [literal('Aalst'), literal('Stad Aalst')]));
  assert.ok(equal('string-set', [], []));
  assert.ok(equal('uri-set', ['http://example.org/b', 'http://example.org/a'], [uri('http://example.org/a'), uri('http://example.org/b')]));
  assert.ok(equal('url', 'https://data.vlaanderen.be/id/adres/1', [uri('https://data.vlaanderen.be/id/adres/1')]));
  assert.ok(equal('url', 'https://data.vlaanderen.be/id/adres/1', [literal('https://data.vlaanderen.be/id/adres/1')]), 'the IRI, whatever the stored term kind');
  const relationship = { kind: 'relationship', cardinality: 'many', target: 'sites' };
  assert.ok(sameItems(itemsFromTerms(relationship, [uri('http://x/b'), uri('http://x/a')]), ['http://x/a', 'http://x/b']));
  assert.ok(!sameItems(itemsFromTerms(relationship, [uri('http://x/a')]), ['http://x/a', 'http://x/b']));
});

test('values render as JSON: scalars or null, arrays for sets, identifiers for relationships', () => {
  const attribute = (attributeType) => ({ kind: 'attribute', attributeType });
  assert.equal(keyJson(attribute('string'), ['Aalst']), 'Aalst');
  assert.equal(keyJson(attribute('string'), []), null);
  assert.deepEqual(keyJson(attribute('string'), ['Aalst', 'Gent']), ['Aalst', 'Gent'], 'two values on a single-valued key are shown as they are');
  assert.equal(keyJson(attribute('number'), attributeItemsFromTerms('number', [typed('12.5', 'decimal')])), 12.5);
  assert.equal(keyJson(attribute('boolean'), attributeItemsFromTerms('boolean', [typed('false', 'boolean')])), false);
  assert.equal(keyJson(attribute('date'), attributeItemsFromJson('date', '2030-12-31')), '2030-12-31');
  assert.equal(keyJson(attribute('datetime'), attributeItemsFromJson('datetime', '2026-01-01T01:00:00+01:00')), '2026-01-01T00:00:00.000Z');
  assert.deepEqual(keyJson(attribute('string-set'), []), []);
  assert.deepEqual(keyJson(attribute('language-string'), attributeItemsFromTerms('language-string', [literal('Stad', 'nl')])), { content: 'Stad', language: 'nl' });
  const one = { kind: 'relationship', cardinality: 'one', target: 'sites' };
  const many = { kind: 'relationship', cardinality: 'many', target: 'contact-points' };
  const uuids = new Map([[URIS.site, IDS.site], [URIS.oldContact, IDS.oldContact]]);
  assert.deepEqual(keyJson(one, [URIS.site], uuids), { type: 'sites', id: IDS.site });
  assert.equal(keyJson(one, [], uuids), null);
  assert.deepEqual(keyJson(many, [URIS.oldContact, 'http://x/unknown'], uuids), [{ type: 'contact-points', id: IDS.oldContact }, { type: 'contact-points', id: null }]);
  assert.deepEqual(keyJson(many, [], uuids), []);
});

test('keyByPredicate finds the attribute or relationship of a type that writes a predicate', () => {
  assert.deepEqual(keyByPredicate(model, 'administrative-units', `${NS.skos}prefLabel`), { name: 'name', kind: 'attribute', predicate: `${NS.skos}prefLabel`, attributeType: 'string' });
  assert.deepEqual(keyByPredicate(model, 'sites', `${NS.org}siteAddress`), { name: 'contacts', kind: 'relationship', predicate: `${NS.org}siteAddress`, cardinality: 'many', target: 'contact-points' });
  assert.deepEqual(keyByPredicate(model, 'sites', 'http://example.org/gone'), { name: 'http://example.org/gone', kind: 'attribute', predicate: 'http://example.org/gone', attributeType: 'string' });
});
