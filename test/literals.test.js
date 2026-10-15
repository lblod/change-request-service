import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributeObjects, LiteralError, LITERAL_TYPES, isKnownLiteralType } from '../lib/literals.js';

// The template escapes strings as """...""", mu-cl-resources as "..."; the terms are the same.
const term = (rendered) => rendered.replace(/^"""(.*?)"""/s, '"$1"');

// What mu-cl-resources writes for each attribute type (framework/request-parsing.lisp with
// *use-custom-boolean-type-p* nil), for the values of one organisation and its records.
const expectations = [
  ['string', 'Stad Aalst', ['"Stad Aalst"']],
  ['string-set', ['Aalst', 'Stad Aalst'], ['"Aalst"', '"Stad Aalst"']],
  ['date', '2030-12-31', ['"2030-12-31"^^xsd:date']],
  ['datetime', '2026-01-01T00:00:00.000Z', ['"2026-01-01T00:00:00.000Z"^^xsd:dateTime']],
  ['boolean', true, ['"true"^^xsd:boolean']],
  ['boolean', false, ['"false"^^xsd:boolean']],
  ['number', 12.5, ['"12.5"^^xsd:decimal']],
  ['number', 42, ['"42"^^xsd:decimal']],
  ['integer', 7, ['"7"^^xsd:integer']],
  ['float', 1.5, ['"1.5"^^xsd:float']],
  ['url', 'https://data.vlaanderen.be/id/adres/123456', ['<https://data.vlaanderen.be/id/adres/123456>']],
  // "uri" is not a mu-cl-resources write type: the value goes through its default path, a plain string
  ['uri', 'https://www.aalst.be', ['"https://www.aalst.be"']],
  ['uri-set', ['http://example.org/a', 'http://example.org/b'], ['<http://example.org/a>', '<http://example.org/b>']],
  ['language-string', { content: 'Stad', language: 'nl' }, ['"Stad"@nl']],
  ['language-string', { content: 'Stad', language: 'nl-BE' }, ['"Stad"@nl']],
  ['language-string-set', [{ content: 'Stad', language: 'nl' }, { content: 'City', language: 'en' }], ['"Stad"@nl', '"City"@en']],
  ['time', '10:12:00', ['"10:12:00"^^<http://www.w3.org/2001/XMLSchema#time>']],
  ['g-year', '2026', ['"2026"^^<http://www.w3.org/2001/XMLSchema#gYear>']],
  ['geometry', 'POINT(4.04 50.94)', ['"POINT(4.04 50.94)"^^<http://www.opengis.net/ont/geosparql#wktLiteral>']],
  ['string', null, []],
  ['string-set', [], []],
  ['string-set', ['a', null], ['"a"']],
  ['no-such-type', 'as a string', ['"as a string"']],
];

for (const [type, value, expected] of expectations) {
  test(`${type} ${JSON.stringify(value)} is written as mu-cl-resources writes it`, () => {
    assert.deepEqual(attributeObjects(type, value).map(term), expected);
  });
}

test('escapes quotes and backslashes in strings', () => {
  assert.equal(attributeObjects('string', 'He said "hi" \\ there')[0], '"""He said \\"hi\\" \\\\ there"""');
});

test('a datetime is normalised to UTC, as the template helper does', () => {
  assert.equal(term(attributeObjects('datetime', '2026-01-01T01:00:00+01:00')[0]), '"2026-01-01T00:00:00.000Z"^^xsd:dateTime');
});

test('url and uri-set values must be absolute IRIs without forbidden characters', () => {
  const bad = [
    'https://x/a> . } } ; DROP ALL #',
    'https://x/a b',
    'not a uri at all',
    'https://x/a"b',
    'https://x/{a}',
    'https://x/a\\b',
    'https://x/a`b',
    'https://x/a|b',
    'https://x/a^b',
    '/relative/path',
  ];
  for (const value of bad) {
    assert.throws(() => attributeObjects('url', value), LiteralError, value);
    assert.throws(() => attributeObjects('uri-set', [value]), LiteralError, value);
  }
  assert.deepEqual(attributeObjects('url', 'https://data.vlaanderen.be/id/adres/123456?x=1&y=2#frag'), ['<https://data.vlaanderen.be/id/adres/123456?x=1&y=2#frag>']);
  assert.deepEqual(attributeObjects('url', 'urn:uuid:4b6e8d0f-2a4c-4e6f-8a0b-2c4d6e8f0a1b'), ['<urn:uuid:4b6e8d0f-2a4c-4e6f-8a0b-2c4d6e8f0a1b>']);
  assert.deepEqual(attributeObjects('url', 'mailto:info@aalst.be'), ['<mailto:info@aalst.be>']);
});

test('refuses values that do not fit the type', () => {
  const bad = [
    ['boolean', 'true'],
    ['number', '12'],
    ['integer', 1.5],
    ['date', 'not a date'],
    ['datetime', 42],
    ['string', 12],
    ['string-set', 'single'],
    ['url', ''],
    ['language-string', 'plain'],
    ['language-string', { content: 'x', language: '' }],
  ];
  for (const [type, value] of bad) {
    assert.throws(() => attributeObjects(type, value), LiteralError, `${type} ${JSON.stringify(value)}`);
  }
});

test('the table covers the mu-cl-resources types', () => {
  for (const type of ['string', 'number', 'integer', 'float', 'boolean', 'date', 'datetime', 'time', 'url', 'uri-set', 'string-set', 'language-string', 'language-string-set', 'g-year', 'geometry']) {
    assert.ok(isKnownLiteralType(type), type);
    assert.ok(LITERAL_TYPES[type].form);
  }
  assert.ok(!isKnownLiteralType('uuid'));
});
