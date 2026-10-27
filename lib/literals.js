import {
  sparqlEscapeString,
  sparqlEscapeUri,
  sparqlEscapeDate,
  sparqlEscapeDateTime,
  sparqlEscapeBool,
  sparqlEscapeDecimal,
  sparqlEscapeInt,
  sparqlEscapeFloat,
} from 'mu';

/**
 * The datatype table: how a JSON:API attribute value becomes an RDF term, per attribute "type"
 * in the resources model. It mirrors what mu-cl-resources writes (framework/request-parsing.lisp,
 * interpret-json-value-by-type, with mu-cl-support's s-from-json as the default) for a stack that
 * sets *use-custom-boolean-type-p* to nil, as app-organization-portal's domain.lisp does:
 *
 *   string               plain literal
 *   uri                  plain literal: mu-cl-resources has no "uri" write type, so the value takes
 *                        the default path (s-from-json) and is written as a plain string
 *   url                  IRI (s-url)
 *   date                 xsd:date            datetime  xsd:dateTime
 *   time                 xsd:time            g-year    xsd:gYear
 *   number               xsd:decimal         integer   xsd:integer        float  xsd:float
 *   boolean              xsd:boolean
 *   string-set           one plain literal per value
 *   uri-set              one IRI per value
 *   language-string      "content"@language, value { content, language }; the language keeps its
 *                        first run of word characters, as mu-cl-support's escape-language does
 *   language-string-set  one such literal per value
 *   geometry             geo:wktLiteral
 *
 * Unknown types fall back to "string", as mu-cl-resources' default method does. Every value is
 * rendered with the template's sparqlEscape helpers.
 */
export class LiteralError extends Error {}

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const WKT_LITERAL = 'http://www.opengis.net/ont/geosparql#wktLiteral';

// Control characters (other than tab, line feed and carriage return) cannot be stored: Virtuoso
// refuses them after a long wait. Refused here so the caller gets a 422 instead of a 500.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const text = (value) => {
  if (typeof value !== 'string') throw new LiteralError('expected a string');
  if (CONTROL.test(value)) throw new LiteralError('a text cannot contain control characters');
  return value;
};

const string = (value) => sparqlEscapeString(text(value));

// Characters an IRIREF cannot contain (SPARQL 1.1 grammar): the sparqlEscapeUri helper would
// backslash-escape some of them, which sparql-parser rejects as a parse error, and Virtuoso
// takes the others as a malformed IRI. Refused here so the caller gets a 422 instead of a 500.
const IRI_FORBIDDEN = /[\s<>"{}|^`\\]/;
// The schemes of the links the forms store (a besluit, an address in the address register): web
// addresses only, never javascript: or file:.
const IRI_SCHEMES = ['http:', 'https:'];

const iri = (value) => {
  if (typeof value !== 'string' || !value.trim()) throw new LiteralError('expected a URI');
  if (IRI_FORBIDDEN.test(value) || CONTROL.test(value)) {
    throw new LiteralError('a URI cannot contain whitespace, control characters or any of < > " { } | ^ ` \\');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new LiteralError(`"${value}" is not an absolute URI`);
  }
  if (!IRI_SCHEMES.includes(url.protocol)) throw new LiteralError(`"${value}" is not a web address (http or https)`);
  return sparqlEscapeUri(value);
};

// The years a date may have: Virtuoso refuses years of more than four digits, and nothing the
// register records predates the year 1000.
const YEARS = { min: 1000, max: 9999 };

/** Whether year, month and day (numbers) name a day of the calendar. */
const isCalendarDay = (year, month, day) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const date = (value) => {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new LiteralError('expected a date (YYYY-MM-DD)');
  const [year, month, day] = match.slice(1).map(Number);
  if (year < YEARS.min || year > YEARS.max) throw new LiteralError(`a date has a year from ${YEARS.min} to ${YEARS.max}`);
  if (!isCalendarDay(year, month, day)) throw new LiteralError(`${value} is not a day of the calendar`);
  return sparqlEscapeDate(value);
};

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const dateTime = (value) => {
  const match = typeof value === 'string' && value.match(DATE_TIME);
  if (!match || Number.isNaN(Date.parse(value))) throw new LiteralError('expected an ISO 8601 date-time with a time zone (2026-10-21T09:30:00Z)');
  const [year, month, day] = match.slice(1, 4).map(Number);
  if (year < YEARS.min || year > YEARS.max || !isCalendarDay(year, month, day)) throw new LiteralError(`${value} is not a moment of the calendar`);
  return sparqlEscapeDateTime(value);
};

const typed = (datatype) => (value) => `${string(value)}^^<${datatype}>`;

// A g-year has the years of a date.
const gYear = (value) => {
  if (typeof value !== 'string' || !/^\d{4}$/.test(value) || Number(value) < YEARS.min) throw new LiteralError(`expected a year (from ${YEARS.min} to ${YEARS.max})`);
  return typed(XSD + 'gYear')(value);
};

const number = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new LiteralError('expected a number');
  return sparqlEscapeDecimal(value);
};

const integer = (value) => {
  if (!Number.isInteger(value)) throw new LiteralError('expected an integer');
  return sparqlEscapeInt(value);
};

const float = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new LiteralError('expected a number');
  return sparqlEscapeFloat(value);
};

const boolean = (value) => {
  if (typeof value !== 'boolean') throw new LiteralError('expected true or false');
  return sparqlEscapeBool(value);
};

const languageString = (value) => {
  if (!value || typeof value !== 'object' || typeof value.content !== 'string' || typeof value.language !== 'string') {
    throw new LiteralError('expected { "content": "...", "language": "..." }');
  }
  const language = (value.language.match(/\w+/) || [])[0];
  if (!language) throw new LiteralError('expected a language tag');
  return `${sparqlEscapeString(text(value.content))}@${language}`;
};

export const LITERAL_TYPES = {
  string: { form: 'plain literal', render: string },
  uri: { form: 'plain literal (written through the mu-cl-resources default path)', render: string },
  url: { form: 'IRI', render: iri },
  date: { form: 'xsd:date', render: date },
  datetime: { form: 'xsd:dateTime', render: dateTime },
  time: { form: 'xsd:time', render: typed(XSD + 'time') },
  'g-year': { form: 'xsd:gYear', render: gYear },
  geometry: { form: 'geo:wktLiteral', render: typed(WKT_LITERAL) },
  number: { form: 'xsd:decimal', render: number },
  integer: { form: 'xsd:integer', render: integer },
  float: { form: 'xsd:float', render: float },
  boolean: { form: 'xsd:boolean', render: boolean },
  'string-set': { form: 'plain literals', many: true, render: string },
  'uri-set': { form: 'IRIs', many: true, render: iri },
  'language-string': { form: 'literal with language tag', render: languageString },
  'language-string-set': { form: 'literals with language tags', many: true, render: languageString },
};

export const DEFAULT_LITERAL_TYPE = 'string';

export function isKnownLiteralType(type) {
  return Object.hasOwn(LITERAL_TYPES, type);
}

/**
 * Renders the SPARQL object terms for one attribute value: none for null, several for a set.
 * Throws LiteralError when the value does not fit the type.
 */
export function attributeObjects(type, value) {
  const spec = LITERAL_TYPES[type] || LITERAL_TYPES[DEFAULT_LITERAL_TYPE];
  if (value === null || value === undefined) return [];
  if (spec.many) {
    if (!Array.isArray(value)) throw new LiteralError(`expected an array for a ${type}`);
    return value.filter((item) => item !== null && item !== undefined).map(spec.render);
  }
  return [spec.render(value)];
}
