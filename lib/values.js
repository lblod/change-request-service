import { LITERAL_TYPES } from './literals.js';

/**
 * The values of one key (an attribute or a relationship of a master) as the base contract
 * compares them, and their JSON rendering in the conflicts of the API.
 *
 * A key is { name, kind: 'attribute' | 'relationship', predicate } plus attributeType for an
 * attribute, cardinality and target for a relationship. Its value is a list of items, compared
 * as a set; a single-valued key has zero or one item. An item is a value in canonical form:
 *
 *   string, uri, time, g-year, geometry,   the lexical form, exactly
 *   unknown types
 *   url, uri-set                           the IRI
 *   date                                   YYYY-MM-DD, as the template writes it (sparqlEscapeDate)
 *   datetime                               ISO 8601 in UTC with milliseconds (sparqlEscapeDateTime)
 *   number, integer, float                 the number
 *   boolean                                true or false
 *   language-string(-set)                  { content, language }, the language as written (its
 *                                          first run of word characters), in lower case
 *   a relationship                         the URI of the record it points at
 *
 * A lexical form that does not parse under its type stays a string, so it only equals itself.
 */

const isMany = (type) => LITERAL_TYPES[type]?.many === true;
const isLanguage = (type) => type === 'language-string' || type === 'language-string-set';

const DATE_ONLY = /^(\d{4}-\d{2}-\d{2})(Z|[+-]\d{2}:\d{2})?$/;

const languageTag = (language) => ((typeof language === 'string' && language.match(/\w+/)) || [''])[0].toLowerCase();

function canonical(type, value) {
  switch (type) {
    case 'date': {
      if (typeof value !== 'string') return value;
      const dateOnly = value.match(DATE_ONLY);
      if (dateOnly) return dateOnly[1];
      const time = Date.parse(value);
      return Number.isNaN(time) ? value : new Date(time).toISOString().slice(0, 10);
    }
    case 'datetime': {
      if (typeof value !== 'string') return value;
      const time = Date.parse(value);
      return Number.isNaN(time) ? value : new Date(time).toISOString();
    }
    case 'number':
    case 'integer':
    case 'float': {
      if (typeof value === 'number') return value;
      const number = Number(value);
      return value.trim() === '' || Number.isNaN(number) ? value : number;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === '1') return true;
      if (value === 'false' || value === '0') return false;
      return value;
    case 'language-string':
    case 'language-string-set':
      return { content: value.content, language: languageTag(value.language) };
    default:
      return String(value);
  }
}

const itemKey = (item) => JSON.stringify(item);

/** Set equality of two lists of items. */
export function sameItems(left, right) {
  const a = new Set(left.map(itemKey));
  const b = new Set(right.map(itemKey));
  return a.size === b.size && [...a].every((key) => b.has(key));
}

/** The items of left that right does not hold. */
export function itemsNotIn(left, right) {
  const keys = new Set(right.map(itemKey));
  return left.filter((item) => !keys.has(itemKey(item)));
}

/** Whether two lists of items share an item. */
export function shareItems(left, right) {
  const keys = new Set(right.map(itemKey));
  return left.some((item) => keys.has(itemKey(item)));
}

/** A key that holds a set: a to-many relationship or a set attribute. */
export function isSetKey(key) {
  return key.kind === 'relationship' ? key.cardinality === 'many' : isMany(key.attributeType);
}

/**
 * The items of a JSON:API attribute value. The value must have passed attributeObjects (the
 * datatype check); null gives no item, a set one item per value.
 */
export function attributeItemsFromJson(type, value) {
  if (value === null || value === undefined) return [];
  const values = isMany(type) ? value.filter((item) => item !== null && item !== undefined) : [value];
  return values.map((item) => canonical(type, item));
}

/** The items of an attribute from SPARQL JSON bindings of its objects. */
export function attributeItemsFromTerms(type, bindings) {
  return bindings.map((binding) =>
    isLanguage(type) ? canonical(type, { content: binding.value, language: binding['xml:lang'] || '' }) : canonical(type, binding.value),
  );
}

/** The items of a key from SPARQL JSON bindings of its objects. */
export function itemsFromTerms(key, bindings) {
  if (key.kind === 'relationship') return bindings.map((binding) => binding.value);
  return attributeItemsFromTerms(key.attributeType, bindings);
}

/**
 * The JSON rendering of a key's items: a string, number, boolean, { content, language } or null
 * for a single-valued attribute, an array for a set; a { type, id } identifier or null for a
 * to-one relationship, an array of them for a to-many. More than one value on a single-valued
 * key (data the model does not expect) is shown as the array it is. uuids maps the URIs of
 * related records to their mu:uuid; the type is the relationship's target type.
 */
export function keyJson(key, items, uuids = new Map()) {
  const many = isSetKey(key);
  const values = key.kind === 'relationship' ? items.map((uri) => ({ type: key.target, id: uuids.get(uri) ?? null })) : items;
  if (many || values.length > 1) return values;
  return values[0] ?? null;
}

/**
 * The key of a type that writes a predicate: its attribute, else its non-inverse relationship.
 * Used to read stored versions, which record predicates. A predicate the model no longer has is
 * read as a string attribute named after the predicate.
 */
export function keyByPredicate(model, type, predicate) {
  if (model.has(type)) {
    for (const attribute of model.attributes(type).values()) {
      if (attribute.predicate === predicate) return { name: attribute.name, kind: 'attribute', predicate, attributeType: attribute.type };
    }
    for (const relationship of model.relationships(type).values()) {
      if (!relationship.inverse && relationship.predicate === predicate) {
        return { name: relationship.name, kind: 'relationship', predicate, cardinality: relationship.cardinality, target: relationship.target };
      }
    }
  }
  return { name: predicate, kind: 'attribute', predicate, attributeType: 'string' };
}
