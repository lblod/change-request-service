import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseKbo, kboForms, isKboIdName, kboLockKey } from '../lib/kbo.js';

test('a KBO number is kept as its ten digits', () => {
  for (const [given, number] of [
    ['0123456789', '0123456789'],
    ['0123.456.789', '0123456789'],
    [' 0123 456 789 ', '0123456789'],
    ['BE0123456789', '0123456789'],
    ['be 0123.456.789', '0123456789'],
    ['0123-456-789', '0123456789'],
    ['123456789', '0123456789'],
    ['1123456789', '1123456789'],
  ]) {
    assert.equal(normaliseKbo(given), number, given);
  }
  for (const given of ['', '12345', '01234567890', 'BE', 'KBO 0123456789', '0123.456.78x', null, 123456789]) {
    assert.equal(normaliseKbo(given), null, String(given));
  }
});

test('the forms a number may be stored in, for the lookups', () => {
  assert.deepEqual(kboForms('0123456789'), ['0123456789', '0123.456.789', 'BE0123456789', 'BE 0123456789', 'BE0123.456.789', 'BE 0123.456.789', '123456789']);
  assert.ok(!kboForms('1123456789').includes('123456789'), 'only a number with a leading 0 has a nine-digit form');
  assert.equal(kboLockKey('0123456789'), 'kbo:0123456789');
});

test('an identifier named after a KBO number, in any spelling', () => {
  for (const name of ['KBO nummer', 'KBO Nummer', 'kbo-nummer', ' KBO  nummer ', 'kbonummer']) assert.ok(isKboIdName(name), name);
  for (const name of ['SharePoint identificator', 'KBO', 'nummer', null]) assert.ok(!isKboIdName(name), String(name));
});
