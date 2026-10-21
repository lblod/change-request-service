/**
 * KBO numbers (the enterprise numbers of the Kruispuntbank van Ondernemingen) as the service
 * compares them. A KBO number is kept as its ten digits, as the forms send it (their input mask
 * strips the dots); the register may hold older forms, which the lookups try too.
 */

/** The name of the identifier that holds a KBO number, as the forms and the register write it. */
export const KBO_ID_NAME = 'KBO nummer';

/** The names, in lower case, under which the register may hold a KBO number. */
export const KBO_ID_NAMES = ['kbo nummer', 'kbo-nummer', 'kbonummer'];

/** Whether an identifier name names a KBO number, in any spelling ("KBO nummer", "KBO Nummer", "kbo-nummer"). */
export const isKboIdName = (name) => typeof name === 'string' && KBO_ID_NAMES.includes(name.trim().toLowerCase().replace(/\s+/g, ' '));

/**
 * A KBO number as its ten digits: spaces, dots, dashes and slashes and a leading "BE" are
 * stripped, and a number of nine digits (the form before 2001) gets its leading 0. null when what
 * is left is not a number of nine or ten digits.
 */
export function normaliseKbo(value) {
  if (typeof value !== 'string') return null;
  const digits = value.trim().replace(/^BE/i, '').replace(/[\s./-]/g, '');
  if (!/^\d{9,10}$/.test(digits)) return null;
  return digits.length === 9 ? `0${digits}` : digits;
}

/**
 * The forms a KBO number (ten digits) may be stored in, for the lookups in the register and in
 * other requests: 0123456789, 0123.456.789, with "BE" or "BE " before either, and 123456789 for a
 * number that starts with 0.
 */
export function kboForms(number) {
  const dotted = `${number.slice(0, 4)}.${number.slice(4, 7)}.${number.slice(7)}`;
  const forms = [number, dotted, `BE${number}`, `BE ${number}`, `BE${dotted}`, `BE ${dotted}`];
  if (number.startsWith('0')) forms.push(number.slice(1));
  return forms;
}

/** The key under which the service serialises the requests that propose or claim a KBO number. */
export const kboLockKey = (number) => `kbo:${number}`;
