import { keyByPredicate, keyJson, itemsFromTerms, isSetKey } from './values.js';

/**
 * The URIs of the records the stored versions of a request link to: the objects of their
 * relationship predicates. uuidsOf (organisations.js) turns them into the uuids the operations
 * show; a record a pending request creates is found through its own version.
 */
export function relatedRecordUris(versions, model) {
  const uris = new Set();
  for (const version of versions) {
    for (const [predicate, bindings] of version.terms) {
      if (keyByPredicate(model, version.type, predicate).kind !== 'relationship') continue;
      for (const binding of bindings) uris.add(binding.value);
    }
  }
  return [...uris];
}

/**
 * The operations of a request as they were submitted, rebuilt from its stored versions
 * (versionsFromStore): one { op, data } per version, data a JSON:API resource object with the
 * record's type and id (the uuid the service minted for a create), the attributes and
 * relationships the version carries and, for an update, the keys it clears (named by
 * cr:changesProperty without a value) as null or an empty list. A delete carries type and id only.
 * The values render as in the conflicts (values.js keyJson); uuids maps the URIs of related
 * records to their uuid.
 */
export function operationsFromVersions(versions, model, uuids = new Map()) {
  return versions.map((version) => {
    const data = { type: version.type, id: version.masterUuid };
    if (version.operation !== 'delete') {
      const attributes = {};
      const relationships = {};
      const render = (predicate, bindings) => {
        const key = keyByPredicate(model, version.type, predicate);
        const value = keyJson(key, itemsFromTerms(key, bindings), uuids);
        if (key.kind === 'attribute') attributes[key.name] = value;
        else relationships[key.name] = { data: value };
      };
      for (const [predicate, bindings] of version.terms) render(predicate, bindings);
      for (const predicate of version.replaces) {
        if (version.terms.has(predicate)) continue;
        const key = keyByPredicate(model, version.type, predicate);
        const empty = isSetKey(key) ? [] : null;
        if (key.kind === 'attribute') attributes[key.name] = empty;
        else relationships[key.name] = { data: empty };
      }
      data.attributes = attributes;
      data.relationships = relationships;
    }
    return { op: version.operation, data };
  });
}
