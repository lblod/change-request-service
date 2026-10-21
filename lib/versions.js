import { sparqlEscapeUri } from 'mu';
import { VERSION_BASE, RECORD_STATE_BASE, LINK_BASE, TARGET_TYPE, NS, MAX_OPERATIONS, MAX_VALUES_PER_KEY, operationKey } from '../constants.js';
import { allowedTypes, referenceTypes } from './config.js';
import { attributeObjects, LiteralError } from './literals.js';
import { attributeItemsFromJson, itemKey, itemsFromTerms, itemsNotIn, isSetKey, keyByPredicate, sameItems } from './values.js';
import { unprocessable } from './errors.js';
import { term } from './sparql-result.js';

const OPERATIONS = new Set(['create', 'update', 'delete']);

/** A document type may be operated on when it is a whitelisted type or a subtype of one. */
export function isTypeInAggregate(model, aggregate, type) {
  return allowedTypes(aggregate).some((allowed) => model.isSubtypeOf(type, allowed));
}

/**
 * A relationship target belongs to the aggregate when its type is whitelisted, or related to a
 * whitelisted type by inheritance (organizations <-> administrative-units).
 */
export function isTargetInAggregate(model, aggregate, target) {
  return allowedTypes(aggregate).some(
    (allowed) => model.isSubtypeOf(target, allowed) || model.isSubtypeOf(allowed, target),
  );
}

/** A relationship target is a reference type of the aggregate: linkable, never operated on. */
export function isReferenceType(model, aggregate, target) {
  return referenceTypes(aggregate).some(
    (reference) => model.isSubtypeOf(target, reference) || model.isSubtypeOf(reference, target),
  );
}

/**
 * The keys (attribute and relationship names) the aggregate may change on a record of this type
 * that exists, as its "writable" lists them for the type or a type it inherits from; null when
 * no list applies, so every key may change.
 */
export function writableKeys(model, aggregate, type) {
  const lists = Object.entries(aggregate.writable ?? {}).filter(([listed]) => model.isSubtypeOf(type, listed));
  return lists.length ? new Set(lists.flatMap(([, keys]) => keys)) : null;
}

/** Whether the aggregate may change a key of a record of this type (writableKeys). */
export function isWritableKey(model, aggregate, type, name) {
  const keys = writableKeys(model, aggregate, type);
  return !keys || keys.has(name);
}

/**
 * A relationship is part of a document's state inside the aggregate when it is not inverse, its
 * target is in the aggregate or one of its references, and the aggregate may change it on the
 * document's type (writable). Any other relationship a document carries (classification,
 * organization-status, a werkingsgebied the kerngegevens may not change, ...) must be unchanged.
 */
export function isAdmittedRelationship(model, aggregate, definition, type = null) {
  if (definition.inverse) return false;
  if (!isTargetInAggregate(model, aggregate, definition.target) && !isReferenceType(model, aggregate, definition.target)) return false;
  return !type || isWritableKey(model, aggregate, type, definition.name);
}

/** The type is the target type (organizations) or a subtype: the one organisation of a request. */
const isOrganisationType = (model, type) => model.isSubtypeOf(type, TARGET_TYPE);

/**
 * The predicates a document of this type may change inside the aggregate: every attribute and
 * every admitted relationship the aggregate may write on the type. A version replaces, on the
 * master, exactly the predicates of the keys it writes (see buildVersions and settleVersions),
 * which are a subset of these.
 */
export function aggregatePredicates(model, aggregate, type) {
  const predicates = new Set();
  for (const attribute of model.attributes(type).values()) {
    if (isWritableKey(model, aggregate, type, attribute.name)) predicates.add(attribute.predicate);
  }
  for (const relationship of model.relationships(type).values()) {
    if (isAdmittedRelationship(model, aggregate, relationship, type)) predicates.add(relationship.predicate);
  }
  return [...predicates].sort();
}

/**
 * The predicates that lead from the target organisation to the records of its aggregate: the
 * non-inverse relationships between the aggregate's types, organisations excluded (an
 * organisation is never part of another organisation's aggregate). Following them from the
 * target gives the set of records a request may operate on or link to.
 */
export function pathPredicates(model, aggregate) {
  const predicates = new Set();
  for (const type of model.names()) {
    if (!isTypeInAggregate(model, aggregate, type)) continue;
    for (const relationship of model.relationships(type).values()) {
      if (relationship.inverse) continue;
      if (!isTargetInAggregate(model, aggregate, relationship.target)) continue;
      if (isOrganisationType(model, relationship.target) || model.isSubtypeOf(TARGET_TYPE, relationship.target)) continue;
      predicates.add(relationship.predicate);
    }
  }
  return [...predicates].sort();
}

const identifiersIn = (relationship) =>
  Array.isArray(relationship?.data) ? relationship.data : relationship?.data ? [relationship.data] : [];

/** Every uuid the operations refer to: the ids of updates and deletes and the ids in relationships. */
export function collectReferences(operations) {
  const ids = new Set();
  if (!Array.isArray(operations)) return [];
  for (const operation of operations) {
    const data = operation?.data;
    if (!data || typeof data !== 'object') continue;
    if (typeof data.id === 'string') ids.add(data.id);
    for (const relationship of Object.values(data.relationships || {})) {
      for (const ref of identifiersIn(relationship)) if (ref && typeof ref.id === 'string') ids.add(ref.id);
    }
  }
  return [...ids];
}

/** Every uuid the base values of the operations (data.meta.base.relationships) refer to. */
export function collectBaseReferences(operations) {
  const ids = new Set();
  if (!Array.isArray(operations)) return [];
  for (const operation of operations) {
    const relationships = operation?.data?.meta?.base?.relationships;
    if (!relationships || typeof relationships !== 'object') continue;
    for (const relationship of Object.values(relationships)) {
      for (const ref of identifiersIn(relationship)) if (ref && typeof ref.id === 'string') ids.add(ref.id);
    }
  }
  return [...ids];
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Turns the operations of a request into version objects.
 *
 * @param operations   the ordered list of { op, data } from the request
 * @param aggregateName, aggregate   the aggregate the request names
 * @param model        the resources model
 * @param mintUuid     () => uuid, injected so tests are deterministic
 * @param resources    Map uuid -> { uri, classes } for every id in collectReferences(operations)
 *                     and collectBaseReferences(operations)
 * @param former       Map uuid -> uri for ids of the base values that no longer exist (a record
 *                     deleted through a change request, found through its versions)
 * @param reachable    Set of the URIs that belong to the target's aggregate (reachableFromTarget)
 * @param target       { uri, uuid } of the target organisation
 * @param creation     for a request that registers a new organisation: { lid, uuid, uri } of the
 *                     organisation document, whose uuid and URI were minted before (they are the
 *                     target of the request); null for a request about an organisation that exists
 * @returns { versions, lids }  lids maps each create's lid to the uuid minted for it
 *
 * A version is { uri, uuid, type, classUris, masterUri, masterUuid, operation, lid, deleted,
 * replaces, triples, keys, unchanged }:
 *   replaces   on an update, the predicates of the keys the document carried; applying the
 *              version changes exactly these on the master (per-key semantics: a key that is
 *              absent is left as it is, null or [] clears it); empty on a create, whose master is
 *              new. settleVersions narrows it to the keys that change, and sets it on a tombstone
 *              to every key of its type.
 *   triples    [{ predicate, object }] with the object as a rendered SPARQL term
 *   keys       on an update, one entry per carried attribute and admitted relationship the
 *              aggregate may write; on a delete, one per attribute and non-inverse relationship of
 *              the type (deleting the master removes them all), each proposing no value:
 *              { name, kind, predicate, attributeType | cardinality and target, objects (rendered),
 *              proposed (items, see values.js), base?: { objects, items }, where }; base is the
 *              value the client started from, when its meta.base carries the key
 *   unchanged  [{ key, items, where, base?: { items } }]: the keys an update carried that the
 *              aggregate may not change (relationships outside the aggregate, keys its "writable"
 *              leaves out), key as above without values, items the proposed value;
 *              settleVersions refuses the request when the document changes them
 *
 * An update or a delete may carry data.meta.base: { attributes: { name: value }, relationships:
 * { name: { data } } }, the values of the keys as the client loaded them (for a delete, the
 * record as the page showed it before it was removed). A base relationship refers to records by
 * id, never by lid, and its ids only have to be known (they are compared, never linked). A create
 * carries no base.
 *
 * Rules, each a 422 HttpError with a pointer at the operation:
 *   - at most MAX_OPERATIONS operations, at most MAX_VALUES_PER_KEY values per key (proposed or
 *     base);
 *   - a type outside the aggregate, an unknown attribute or relationship, a value that does not
 *     fit its datatype (proposed or base);
 *   - an organisation (the target type or a subtype) is only ever updated, and only the target
 *     itself: no creates, no deletes, no other organisation; except that a creation creates
 *     exactly the organisation document of creation.lid;
 *   - the id of an update or delete, and every id a relationship points at inside the aggregate,
 *     must belong to the target's aggregate (reachable from the target); references (code lists)
 *     must exist and be of the right type;
 *   - a relationship outside the aggregate, or a key the aggregate may not write, cannot be set
 *     on a create, and such a relationship cannot point at a lid;
 *   - every create is linked, directly or through other records of the request, to the target
 *     or to a record that exists: nothing the request creates is left without a link;
 *   - a create that carries an inverse relationship (result-from of a change-event result) is
 *     linked from the other side in the same request (results of the change event): the service
 *     writes the forward triple only, so a link given on the inverse side alone would be lost;
 *   - meta.base only on an update or a delete, well-formed, naming keys of the type.
 */
export function buildVersions({ operations, aggregateName, aggregate, model, mintUuid, resources, former = new Map(), reachable, target, creation = null }) {
  const pointer = (index, ...rest) => ['/data/attributes/operations', index, ...rest].join('/');
  if (!Array.isArray(operations) || operations.length === 0) {
    throw unprocessable('"operations" must be a non-empty array', '/data/attributes/operations');
  }
  if (operations.length > MAX_OPERATIONS) {
    throw unprocessable(`a request carries at most ${MAX_OPERATIONS} operations, this one ${operations.length}`, '/data/attributes/operations');
  }
  const tooMany = (count, label, where) => {
    if (count > MAX_VALUES_PER_KEY) throw unprocessable(`${label} carries at most ${MAX_VALUES_PER_KEY} values, here ${count}`, where);
  };

  // Pass 1: shape, types, ids; mint the master uuids of creates so relationships can refer to them.
  const seenIds = new Set();
  const lids = new Map();
  const parsed = operations.map((operation, index) => {
    if (!operation || typeof operation !== 'object') throw unprocessable('an operation must be an object', pointer(index));
    if (!OPERATIONS.has(operation.op)) throw unprocessable('"op" must be create, update or delete', pointer(index, 'op'));
    const data = operation.data;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
      throw unprocessable('"data" must be a JSON:API resource object with a type', pointer(index, 'data'));
    }
    if (!model.has(data.type)) throw unprocessable(`unknown type "${data.type}"`, pointer(index, 'data/type'));
    if (!isTypeInAggregate(model, aggregate, data.type)) {
      throw unprocessable(
        `type "${data.type}" is outside the aggregate "${aggregateName}" (${allowedTypes(aggregate).join(', ')})`,
        pointer(index, 'data/type'),
      );
    }
    if (isOrganisationType(model, data.type)) {
      if (creation && operation.op === 'create') {
        if (data.lid !== creation.lid) {
          throw unprocessable(`a request to register an organisation creates one organisation, the document with lid "${creation.lid}"`, pointer(index, 'data/lid'));
        }
      } else if (operation.op !== 'update') {
        throw unprocessable(
          `an organisation cannot be ${operation.op === 'create' ? 'created' : 'deleted'} through a change request; only "update" of the target is allowed`,
          pointer(index, 'op'),
        );
      } else if (data.id !== target.uuid) {
        throw unprocessable(`an organisation document must be the target of the request ("${target.uuid}")`, pointer(index, 'data/id'));
      }
    }
    if (operation.op === 'create') {
      if (data.id !== undefined) throw unprocessable('a create must not carry an id; give it a "lid"', pointer(index, 'data/id'));
      if (typeof data.lid !== 'string' || !data.lid) throw unprocessable('a create needs a "lid" (local id)', pointer(index, 'data/lid'));
      if (lids.has(data.lid)) throw unprocessable(`duplicate lid "${data.lid}"`, pointer(index, 'data/lid'));
      const base = model.get(data.type).newResourceBase;
      if (!base) throw unprocessable(`the model has no new-resource-base for "${data.type}"`, pointer(index, 'data/type'));
      if (creation && data.lid === creation.lid) {
        // the organisation the request registers: minted before, it is the request's target
        lids.set(data.lid, { uuid: creation.uuid, uri: creation.uri, type: data.type });
      } else {
        const uuid = mintUuid();
        lids.set(data.lid, { uuid, uri: base + uuid, type: data.type });
      }
    } else {
      if (typeof data.id !== 'string' || !data.id) throw unprocessable(`a ${operation.op} needs an id`, pointer(index, 'data/id'));
      if (data.lid !== undefined) throw unprocessable('only a create carries a lid', pointer(index, 'data/lid'));
      if (seenIds.has(data.id)) throw unprocessable(`duplicate operation on id "${data.id}"`, pointer(index, 'data/id'));
      seenIds.add(data.id);
    }
    if (data.meta !== undefined && !isObject(data.meta)) throw unprocessable('"meta" must be an object', pointer(index, 'data/meta'));
    const base = data.meta?.base;
    if (base !== undefined) {
      if (operation.op === 'create') {
        throw unprocessable('only an update or a delete carries meta.base; a create has no values to start from', pointer(index, 'data/meta/base'));
      }
      if (!isObject(base)) throw unprocessable('"meta.base" must be an object', pointer(index, 'data/meta/base'));
      for (const part of ['attributes', 'relationships']) {
        if (base[part] !== undefined && !isObject(base[part])) {
          throw unprocessable(`"meta.base.${part}" must be an object`, pointer(index, 'data/meta/base', part));
        }
      }
      // a base names keys of the type, as the document does
      for (const name of Object.keys(base.attributes ?? {})) {
        if (!model.attribute(data.type, name)) throw unprocessable(`unknown attribute "${name}" for type "${data.type}"`, pointer(index, 'data/meta/base/attributes', name));
      }
      for (const name of Object.keys(base.relationships ?? {})) {
        if (!model.relationship(data.type, name)) throw unprocessable(`unknown relationship "${name}" for type "${data.type}"`, pointer(index, 'data/meta/base/relationships', name));
      }
    }
    return { op: operation.op, data, index, base: base ?? null };
  });

  /**
   * The URI behind an existing id, checked to be of the expected type. A record of a type the
   * aggregate operates on must also belong to the target's aggregate; a reference or any other
   * record only has to exist.
   */
  const resolveExisting = (id, type, where) => {
    const resource = resources.get(id);
    if (!resource) throw unprocessable(`no ${type} with id "${id}" exists`, where);
    const expected = model.classesOf(type);
    if (!resource.classes.some((rdfClass) => expected.includes(rdfClass))) {
      throw unprocessable(`id "${id}" is not of type ${type}`, where);
    }
    if (isTargetInAggregate(model, aggregate, type) && resource.uri !== target.uri && !reachable.has(resource.uri)) {
      throw unprocessable(`id "${id}" (${type}) does not belong to the target organisation`, where);
    }
    return resource.uri;
  };

  /**
   * The resource identifiers of a relationship value ({ data }), checked for shape, cardinality
   * and type: [{ ref, where }]. label names the value in the messages.
   */
  const identifiersOf = (label, definition, relationship, where) => {
    if (!relationship || typeof relationship !== 'object' || !('data' in relationship)) {
      throw unprocessable(`${label} must carry "data"`, where);
    }
    const many = definition.cardinality === 'many';
    if (many && !Array.isArray(relationship.data)) throw unprocessable(`${label} has cardinality many and needs an array`, where);
    if (!many && Array.isArray(relationship.data)) throw unprocessable(`${label} has cardinality one and needs an object or null`, where);
    const refs = many ? relationship.data : relationship.data === null ? [] : [relationship.data];
    tooMany(refs.length, label, where);
    return refs.map((ref, position) => {
      const refWhere = many ? `${where}/data/${position}` : `${where}/data`;
      if (!ref || typeof ref !== 'object' || typeof ref.type !== 'string') {
        throw unprocessable(`${label}: a resource identifier needs a type`, refWhere);
      }
      const compatible =
        model.has(ref.type) && (model.isSubtypeOf(ref.type, definition.target) || model.isSubtypeOf(definition.target, ref.type));
      if (!compatible) throw unprocessable(`${label} expects ${definition.target}, got ${ref.type}`, refWhere);
      return { ref, where: refWhere };
    });
  };

  /** The URIs of a base relationship value: records as the client loaded them, by id. */
  const baseUris = (name, definition, relationship, where) => {
    const label = `meta.base of relationship "${name}"`;
    return identifiersOf(label, definition, relationship, where).map(({ ref, where: refWhere }) => {
      if (ref.lid !== undefined) {
        throw unprocessable(`${label} holds the records as they were loaded and cannot refer to a lid`, refWhere);
      }
      if (typeof ref.id !== 'string') throw unprocessable(`${label}: a resource identifier needs an id`, refWhere);
      const uri = resources.get(ref.id)?.uri ?? former.get(ref.id);
      if (!uri) throw unprocessable(`${label} refers to "${ref.id}", which is not a known record`, refWhere);
      return uri;
    });
  };

  /** The base value of an attribute as the client loaded it: { objects, items }. */
  const baseAttribute = (name, attribute, value, index) => {
    if (Array.isArray(value)) tooMany(value.length, `meta.base of attribute "${name}"`, pointer(index, 'data/meta/base/attributes', name));
    let objects;
    try {
      objects = attributeObjects(attribute.type, value);
    } catch (error) {
      if (error instanceof LiteralError) {
        throw unprocessable(`meta.base of attribute "${name}" (${attribute.type}): ${error.message}`, pointer(index, 'data/meta/base/attributes', name));
      }
      throw error;
    }
    return { objects, items: attributeItemsFromJson(attribute.type, value) };
  };

  /**
   * The keys of a tombstone: every attribute and every non-inverse relationship of the type, one
   * per predicate, since deleting the master removes them all; none proposes a value. The base
   * comes from the delete's meta.base where it carries the key.
   */
  const tombstoneKeys = (type, base, index) => {
    const baseAttributes = base?.attributes ?? {};
    const baseRelationships = base?.relationships ?? {};
    for (const name of Object.keys(baseAttributes)) {
      if (!model.attribute(type, name)) throw unprocessable(`unknown attribute "${name}" for type "${type}"`, pointer(index, 'data/meta/base/attributes', name));
    }
    for (const name of Object.keys(baseRelationships)) {
      if (!model.relationship(type, name)) throw unprocessable(`unknown relationship "${name}" for type "${type}"`, pointer(index, 'data/meta/base/relationships', name));
    }
    const keys = [];
    const covered = new Set();
    const where = pointer(index, 'data');
    for (const [name, attribute] of model.attributes(type)) {
      if (covered.has(attribute.predicate)) continue;
      covered.add(attribute.predicate);
      const key = { name, kind: 'attribute', predicate: attribute.predicate, attributeType: attribute.type, objects: [], proposed: [], where };
      if (Object.hasOwn(baseAttributes, name)) key.base = baseAttribute(name, attribute, baseAttributes[name], index);
      keys.push(key);
    }
    for (const [name, definition] of model.relationships(type)) {
      if (definition.inverse || covered.has(definition.predicate)) continue;
      covered.add(definition.predicate);
      const key = { name, kind: 'relationship', predicate: definition.predicate, cardinality: definition.cardinality, target: definition.target, objects: [], proposed: [], where };
      if (Object.hasOwn(baseRelationships, name)) {
        const uris = baseUris(name, definition, baseRelationships[name], pointer(index, 'data/meta/base/relationships', name));
        key.base = { objects: uris.map(sparqlEscapeUri), items: uris };
      }
      keys.push(key);
    }
    return keys;
  };

  // Pass 2: the versions, with the carried attributes and relationships as triples. links: the
  // links between records of the aggregate the versions write; inverseClaims: the inverse links
  // creates carry (both checked after this pass).
  const links = [];
  const inverseClaims = [];
  const versions = parsed.map(({ op, data, index, base }) => {
    const type = data.type;
    let masterUri;
    let masterUuid;
    let lid;
    if (op === 'create') {
      ({ uri: masterUri, uuid: masterUuid } = lids.get(data.lid));
      lid = data.lid;
    } else {
      masterUri = resolveExisting(data.id, type, pointer(index, 'data/id'));
      masterUuid = data.id;
    }
    const uuid = mintUuid();
    const version = {
      uri: VERSION_BASE + uuid,
      uuid,
      type,
      classUris: model.classTree(type),
      masterUri,
      masterUuid,
      operation: op,
      lid,
      deleted: op === 'delete',
      replaces: [],
      triples: [],
      keys: [],
      unchanged: [],
    };
    if (op === 'delete') {
      version.keys = tombstoneKeys(type, base, index);
      return version;
    }

    const attributes = data.attributes ?? {};
    if (typeof attributes !== 'object' || Array.isArray(attributes)) {
      throw unprocessable('"attributes" must be an object', pointer(index, 'data/attributes'));
    }
    for (const [name, value] of Object.entries(attributes)) {
      const attribute = model.attribute(type, name);
      const where = pointer(index, 'data/attributes', name);
      if (!attribute) throw unprocessable(`unknown attribute "${name}" for type "${type}"`, where);
      if (Array.isArray(value)) tooMany(value.length, `attribute "${name}"`, where);
      let objects;
      try {
        objects = attributeObjects(attribute.type, value);
      } catch (error) {
        if (error instanceof LiteralError) throw unprocessable(`attribute "${name}" (${attribute.type}): ${error.message}`, where);
        throw error;
      }
      const key = { name, kind: 'attribute', predicate: attribute.predicate, attributeType: attribute.type };
      const proposed = attributeItemsFromJson(attribute.type, value);
      const baseValue = base?.attributes && Object.hasOwn(base.attributes, name) ? baseAttribute(name, attribute, base.attributes[name], index) : null;
      if (!isWritableKey(model, aggregate, type, name)) {
        if (op === 'create' && objects.length) {
          throw unprocessable(`attribute "${name}" cannot be set on a new ${type} through the aggregate "${aggregateName}"`, where);
        }
        if (op === 'update') version.unchanged.push({ key, items: proposed, where, ...(baseValue ? { base: { items: baseValue.items } } : {}) });
        continue;
      }
      if (op === 'update') {
        version.replaces.push(attribute.predicate);
        const written = { ...key, objects, proposed, where };
        if (baseValue) written.base = baseValue;
        version.keys.push(written);
      }
      for (const object of objects) version.triples.push({ predicate: attribute.predicate, object });
    }

    const relationships = data.relationships ?? {};
    if (typeof relationships !== 'object' || Array.isArray(relationships)) {
      throw unprocessable('"relationships" must be an object', pointer(index, 'data/relationships'));
    }
    for (const [name, relationship] of Object.entries(relationships)) {
      const definition = model.relationship(type, name);
      const where = pointer(index, 'data/relationships', name);
      if (!definition) throw unprocessable(`unknown relationship "${name}" for type "${type}"`, where);
      // The other record's state (memberships, kbo-organization, ...): never part of a document.
      // A create's inverse links must be given on the other side too (checked below).
      if (definition.inverse) {
        if (op === 'create') {
          const refs = identifiersOf(`relationship "${name}"`, definition, relationship, where);
          if (refs.length) inverseClaims.push({ masterUri: version.masterUri, type, name, definition, refs, where });
        }
        continue;
      }
      const refs = identifiersOf(`relationship "${name}"`, definition, relationship, where);
      const admitted = isAdmittedRelationship(model, aggregate, definition, type);
      if (!admitted && op === 'create' && refs.length) {
        throw unprocessable(`relationship "${name}" cannot be set on a new ${type} through the aggregate "${aggregateName}"`, where);
      }
      const uris = refs.map(({ ref, where: refWhere }) => {
        if (typeof ref.lid === 'string') {
          if (!admitted) {
            throw unprocessable(`relationship "${name}" is not part of the aggregate "${aggregateName}" and cannot point at a new record`, refWhere);
          }
          const local = lids.get(ref.lid);
          if (!local) throw unprocessable(`relationship "${name}" refers to the unknown lid "${ref.lid}"`, refWhere);
          if (!model.isSubtypeOf(local.type, definition.target)) {
            throw unprocessable(`relationship "${name}" expects ${definition.target}, lid "${ref.lid}" is a ${local.type}`, refWhere);
          }
          return local.uri;
        }
        if (typeof ref.id === 'string') return resolveExisting(ref.id, definition.target, refWhere);
        throw unprocessable(`relationship "${name}": a resource identifier needs an id or a lid`, refWhere);
      });
      const hasBase = op === 'update' && base?.relationships && Object.hasOwn(base.relationships, name);
      const startedFrom = hasBase ? baseUris(name, definition, base.relationships[name], pointer(index, 'data/meta/base/relationships', name)) : null;
      const key = { name, kind: 'relationship', predicate: definition.predicate, cardinality: definition.cardinality, target: definition.target };
      if (admitted) {
        if (op === 'update') {
          version.replaces.push(definition.predicate);
          const written = { ...key, objects: uris.map(sparqlEscapeUri), proposed: uris, where };
          if (startedFrom) written.base = { objects: startedFrom.map(sparqlEscapeUri), items: startedFrom };
          version.keys.push(written);
        }
        for (const uri of uris) version.triples.push({ predicate: definition.predicate, object: sparqlEscapeUri(uri) });
        if (isTargetInAggregate(model, aggregate, definition.target)) for (const uri of uris) links.push([version.masterUri, uri]);
      } else if (op === 'update') {
        version.unchanged.push({ key, items: uris, where, ...(startedFrom ? { base: { items: startedFrom } } : {}) });
      }
    }
    version.replaces.sort();
    return version;
  });

  refuseUnlinkedCreates({ versions, links, target, pointerOf: (version) => pointer(parsed[versions.indexOf(version)].index) });
  refuseOneSidedLinks({ versions, inverseClaims, lids, resources, model });

  return {
    versions,
    lids: Object.fromEntries([...lids].map(([lid, { uuid }]) => [lid, uuid])),
  };
}

/**
 * Every record a request creates must be linked to the organisation, directly or through other
 * records of the request: the links between the records of the aggregate (links: [subject URI,
 * object URI], either way) connect each create to the target, to a record the request updates or
 * deletes, or to a record that exists (which buildVersions checked to belong to the target's
 * aggregate). A create that is not connected would stay in the register as an orphan.
 */
function refuseUnlinkedCreates({ versions, links, target, pointerOf }) {
  const neighbours = new Map();
  const connect = (a, b) => {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a).add(b);
  };
  for (const [subject, object] of links) {
    connect(subject, object);
    connect(object, subject);
  }
  const created = new Set(versions.filter((version) => version.operation === 'create').map((version) => version.masterUri));
  const reached = new Set([target.uri, ...versions.filter((version) => version.operation !== 'create').map((version) => version.masterUri)]);
  // A record the links name that the request does not create exists already
  for (const uri of neighbours.keys()) if (!created.has(uri)) reached.add(uri);
  const queue = [...reached];
  while (queue.length) {
    for (const next of neighbours.get(queue.pop()) ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  for (const version of versions) {
    if (version.operation === 'create' && !reached.has(version.masterUri)) {
      throw unprocessable(
        `the new ${version.type} "${version.lid}" is not linked to the organisation: link it from a record of the request (a new contact point from its site, a new site from the organisation, ...)`,
        pointerOf(version),
      );
    }
  }
}

/**
 * A create that names records on an inverse relationship (inverseClaims: { masterUri, type, name,
 * definition, refs, where }) must be named by them on the forward side in the same request: the
 * record behind each ref is part of the request and carries the forward relationship (the same
 * predicate) with the new record among its values. Only the forward triple is ever written.
 */
function refuseOneSidedLinks({ versions, inverseClaims, lids, resources, model }) {
  for (const { masterUri, type, name, definition, refs, where } of inverseClaims) {
    for (const { ref, where: refWhere } of refs) {
      const otherUri = typeof ref.lid === 'string' ? lids.get(ref.lid)?.uri : resources.get(ref.id)?.uri;
      const other = otherUri ? versions.find((version) => version.masterUri === otherUri) : null;
      const linked = other?.triples.some((triple) => triple.predicate === definition.predicate && triple.object === sparqlEscapeUri(masterUri));
      if (!linked) {
        const forward = [...model.relationships(definition.target).values()].find((relationship) => !relationship.inverse && relationship.predicate === definition.predicate);
        throw unprocessable(
          `relationship "${name}" of a new ${type} is the inverse of "${forward?.name ?? definition.predicate}" on ${definition.target}: set the link there, on the ${definition.target} in the same request`,
          refWhere ?? where,
        );
      }
    }
  }
}

/** The (master, predicate) pairs whose current values settleVersions compares with. */
export function carriedPairs(versions) {
  return versions
    .filter((version) => version.operation !== 'create')
    .flatMap((version) => [
      ...version.keys.map((key) => ({ subject: version.masterUri, predicate: key.predicate })),
      ...version.unchanged.map((check) => ({ subject: version.masterUri, predicate: check.key.predicate })),
    ]);
}

/**
 * The (object, predicate) pairs of the links that point at the masters of the tombstones: the
 * relationship predicates the model knows to point at their type, which the apply removes.
 */
export function incomingPairs(versions, model) {
  return versions
    .filter((version) => version.deleted)
    .flatMap((version) => model.incomingPredicates(version.type).map((predicate) => ({ object: version.masterUri, predicate })));
}

/**
 * The change a set key (a to-many relationship or a set attribute) makes to what the master
 * holds now: it adds what the proposal (P) has and its base (B) had not, and removes what B had
 * and P has not; whatever others added or removed meanwhile stays. Two such changes from the same
 * base cannot disagree on an item (one only removes what B has, the other only adds what B lacks),
 * so a set key never conflicts; it merges.
 *
 * proposed and proposedObjects are the items and the rendered terms of P, in the same order; base
 * the items of B; currentBindings the SPARQL JSON bindings of what the master holds now. Returns
 * { remove, insert }: the current terms to delete and the proposed terms the master lacks, both
 * rendered; both empty when the master already reflects the change. Linear in the sizes of P, B
 * and the current values.
 */
export function mergeSet({ key, proposed, proposedObjects, base, currentBindings }) {
  const removed = new Set(itemsNotIn(base, proposed).map(itemKey));
  const currentItems = itemsFromTerms(key, currentBindings);
  const missing = new Set(itemsNotIn(itemsNotIn(proposed, base), currentItems).map(itemKey));
  const remove = currentBindings.filter((_, position) => removed.has(itemKey(currentItems[position]))).map(term);
  const insert = proposedObjects.filter((_, position) => missing.has(itemKey(proposed[position])));
  return { remove, insert };
}

/**
 * A new record state (cr:RecordState, stateBlock in queries.js): the values of some keys of a
 * master at one moment, triples [{ predicate, object }] with the objects rendered, and for a
 * deleted master the links that pointed at it, subjects [{ subject, predicate }], each minted as
 * an rdf:Statement of its own.
 */
const newRecordState = (mintUuid, masterUri, triples, subjects = null) => {
  const uuid = mintUuid();
  const state = { uri: RECORD_STATE_BASE + uuid, uuid, masterUri, triples };
  if (subjects) {
    state.links = subjects.map(({ subject, predicate }) => {
      const linkUuid = mintUuid();
      return { uri: LINK_BASE + linkUuid, uuid: linkUuid, subject, predicate };
    });
  }
  return state;
};

/** The links that point at a master now: [{ subject, predicate }] from incoming (incomingTerms over incomingPairs). */
const linksTo = (version, incoming, model) =>
  model.incomingPredicates(version.type).flatMap((predicate) =>
    (incoming.get(`${version.masterUri} ${predicate}`) || []).map((subject) => ({ subject: subject.value, predicate })),
  );

/**
 * Decides, for every key an update carries, whether its version writes it: from the value the
 * client started from (meta.base, B), the value it proposes (P) and the value the master holds
 * now (C). current maps "<subject> <predicate>" to the SPARQL JSON bindings of the objects
 * (currentTerms in organisations.js); values compare as values.js describes.
 *
 *   P = B                  the user did not change the key: not written
 *   P ≠ B and C = B        written
 *   P ≠ B and C = P        the master already holds the proposal: not written, no conflict
 *   P ≠ B and C ∉ {B, P}   a conflict: written (the proposal is kept) and reported
 *
 * A set key (a to-many relationship, a set attribute) merges instead (mergeSet): it is written
 * when its additions and removals change what the master holds now, and never conflicts. A key
 * without a client base starts from the current value (B = C): written when P ≠ C, never a
 * conflict. A key the aggregate may not change (a relationship outside the aggregate, a key its
 * "writable" leaves out) is never written: it may be carried as it was loaded (P = B) or as the
 * master holds it (P = C), anything else is a 422.
 *
 * A tombstone proposes no value for every key of its type. It conflicts on a key where C holds a
 * value B does not: someone set or added it after the page loaded the record (or, without a
 * client base, after the submission), and deleting the master would wipe it. Its base state
 * holds B for every key and the links (records that linked to the master) when it was submitted:
 * incoming maps "<object> <predicate>" to the bindings of the subjects (incomingTerms in
 * organisations.js over incomingPairs), so a link made later is found at a goedkeuring.
 *
 * Returns { versions, conflicts }. versions: the creates as they are, the tombstones with
 * replaces (every key) and a base state with links, and the updates that still write a key, with
 * replaces and triples narrowed to those keys, a base state { uri, uuid, masterUri, triples }
 * holding B for them (no triple for a key that was empty) and the plan of their apply ({ replace,
 * remove, insert }, see applyQuery); an update that writes nothing is left out. The updates and
 * tombstones carry proposals: Map predicate -> { key, proposed, base, deleted } with the items of
 * the keys they write, for the competing requests (conflicts.js). conflicts: [{ version, key,
 * base, current, proposed }] with the values as items.
 */
export function settleVersions({ versions, current, incoming = new Map(), model, aggregateName, mintUuid }) {
  const kept = [];
  const conflicts = [];
  for (const version of versions) {
    if (version.operation === 'create') {
      kept.push(version);
      continue;
    }
    const now = (predicate) => current.get(`${version.masterUri} ${predicate}`) || [];
    if (version.deleted) {
      const baseTriples = [];
      const proposals = new Map();
      for (const key of version.keys) {
        const currentBindings = now(key.predicate);
        const currentItems = itemsFromTerms(key, currentBindings);
        const baseItems = key.base ? key.base.items : currentItems;
        for (const object of key.base ? key.base.objects : currentBindings.map(term)) baseTriples.push({ predicate: key.predicate, object });
        if (itemsNotIn(currentItems, baseItems).length) conflicts.push({ version, key, base: baseItems, current: currentItems, proposed: [] });
        proposals.set(key.predicate, { key, proposed: [], base: baseItems, deleted: true });
      }
      kept.push({
        ...version,
        replaces: version.keys.map((key) => key.predicate).sort(),
        base: newRecordState(mintUuid, version.masterUri, baseTriples, linksTo(version, incoming, model)),
        proposals,
      });
      continue;
    }
    for (const check of version.unchanged) {
      const currentItems = itemsFromTerms(check.key, now(check.key.predicate));
      const startedFrom = check.base ? check.base.items : currentItems;
      if (!sameItems(check.items, startedFrom) && !sameItems(check.items, currentItems)) {
        throw unprocessable(`${check.key.kind} "${check.key.name}" cannot be changed through the aggregate "${aggregateName}"`, check.where);
      }
    }
    const replaces = new Set();
    const triples = [];
    const baseTriples = [];
    const plan = { replace: [], remove: [], insert: [] };
    const proposals = new Map();
    for (const key of version.keys) {
      const currentBindings = now(key.predicate);
      const currentItems = itemsFromTerms(key, currentBindings);
      const baseItems = key.base ? key.base.items : currentItems;
      if (sameItems(key.proposed, baseItems)) continue;
      if (isSetKey(key)) {
        const { remove, insert } = mergeSet({ key, proposed: key.proposed, proposedObjects: key.objects, base: baseItems, currentBindings });
        if (!remove.length && !insert.length) continue;
        for (const object of remove) plan.remove.push({ predicate: key.predicate, object });
        for (const object of insert) plan.insert.push({ predicate: key.predicate, object });
      } else {
        if (!sameItems(currentItems, baseItems)) {
          if (sameItems(currentItems, key.proposed)) continue;
          conflicts.push({ version, key, base: baseItems, current: currentItems, proposed: key.proposed });
        }
        plan.replace.push(key.predicate);
        for (const object of key.objects) plan.insert.push({ predicate: key.predicate, object });
      }
      replaces.add(key.predicate);
      proposals.set(key.predicate, { key, proposed: key.proposed, base: baseItems, deleted: false });
      for (const object of key.objects) triples.push({ predicate: key.predicate, object });
      for (const object of key.base ? key.base.objects : currentBindings.map(term)) baseTriples.push({ predicate: key.predicate, object });
    }
    if (!replaces.size) continue;
    plan.replace.sort();
    kept.push({ ...version, replaces: [...replaces].sort(), triples, base: newRecordState(mintUuid, version.masterUri, baseTriples), apply: plan, proposals });
  }
  return { versions: kept, conflicts };
}

/**
 * The states an apply replaces (prov:invalidated on its step, stateBlock in queries.js): for every
 * update and tombstone whose master is present, what the master holds now (current: "<subject>
 * <predicate>" -> SPARQL JSON bindings, read under the lock) for the keys the version changes, and
 * for a tombstone the links that point at the master now (incoming, as for settleVersions). A
 * create has no state before it. With the base states of the versions they give the old and the
 * new value of every key an apply changed, and the conflicts it overrode (overriddenConflicts in
 * conflicts.js).
 */
export function replacedStates({ versions, current, incoming = new Map(), model, mintUuid, present = () => true }) {
  return versions
    .filter((version) => version.operation !== 'create' && present(version))
    .map((version) => {
      const triples = version.replaces.flatMap((predicate) =>
        (current.get(`${version.masterUri} ${predicate}`) || []).map((binding) => ({ predicate, object: term(binding) })),
      );
      return newRecordState(mintUuid, version.masterUri, triples, version.deleted ? linksTo(version, incoming, model) : null);
    });
}

/**
 * The plan of applying stored versions (versionsFromStore) to the masters as they are now
 * (current, currentTerms over storedPairs in conflicts.js), the same plan settleVersions makes for
 * a submission: on an update a set key merges (mergeSet) with its base state and any other key
 * replaces the master's values with the proposal; an update without a base state (which the
 * service does not write) replaces every key it lists. Creates and tombstones need no plan.
 * Returns the versions, the updates with their plan (apply).
 */
export function planStored(versions, current, model) {
  return versions.map((version) => {
    if (version.operation !== 'update') return version;
    if (!version.base) return { ...version, apply: { replace: version.replaces, remove: [], insert: version.triples } };
    const plan = { replace: [], remove: [], insert: [] };
    for (const predicate of version.replaces) {
      const key = keyByPredicate(model, version.type, predicate);
      const proposedBindings = version.terms.get(predicate) || [];
      if (isSetKey(key)) {
        const { remove, insert } = mergeSet({
          key,
          proposed: itemsFromTerms(key, proposedBindings),
          proposedObjects: proposedBindings.map(term),
          base: itemsFromTerms(key, version.base.terms.get(predicate) || []),
          currentBindings: current.get(`${version.masterUri} ${predicate}`) || [],
        });
        for (const object of remove) plan.remove.push({ predicate, object });
        for (const object of insert) plan.insert.push({ predicate, object });
      } else {
        plan.replace.push(predicate);
        for (const binding of proposedBindings) plan.insert.push({ predicate, object: term(binding) });
      }
    }
    return { ...version, apply: plan };
  });
}

// What a version carries besides the master's values: its own bookkeeping.
const BOOKKEEPING = new Set([
  `${NS.rdf}type`,
  `${NS.mu}uuid`,
  `${NS.dct}isVersionOf`,
  `${NS.prov}generatedAtTime`,
  `${NS.cr}resourceType`,
  `${NS.cr}operation`,
  `${NS.cr}masterUuid`,
  `${NS.cr}changesProperty`,
  `${NS.cr}base`,
]);

// What a record state carries besides the master's values.
const STATE_BOOKKEEPING = new Set([`${NS.rdf}type`, `${NS.mu}uuid`, `${NS.dct}isVersionOf`, `${NS.cr}incomingLink`]);

/**
 * Whether a triple on a version is the version's own bookkeeping rather than a value of the
 * master. None of these predicates is a predicate of the model, so a value of the master is never
 * taken for bookkeeping (prov:wasGeneratedBy, the harvest source of OP's addresses and contact
 * points, is a value).
 */
export function isVersionBookkeeping(predicate) {
  return BOOKKEEPING.has(predicate);
}

const push = (map, key, value) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
};

/**
 * Adds one row of a record state to state ({ uri, masterUri, terms, linkRows }): a value of the
 * master (a row without ?link) or a triple of one of its links (rdf:subject, rdf:predicate).
 */
function addStateRow(state, binding) {
  const predicate = binding.p.value;
  if (binding.link) {
    const link = state.linkRows.get(binding.link.value) ?? {};
    if (predicate === `${NS.rdf}subject`) link.subject = binding.o.value;
    else if (predicate === `${NS.rdf}predicate`) link.predicate = binding.o.value;
    state.linkRows.set(binding.link.value, link);
    return;
  }
  if (!STATE_BOOKKEEPING.has(predicate)) push(state.terms, predicate, binding.o);
}

/** A record state read from the store: { uri, masterUri, terms, links: [{ subject, predicate }] }. */
const finishState = ({ linkRows, ...state }) => ({
  ...state,
  links: [...linkRows.values()].filter((link) => link.subject && link.predicate),
});

/**
 * Rebuilds the version objects of one or more requests from the rows of storedVersionsQuery, in
 * the shape buildVersions produces, so a stored request can be applied again and checked for
 * conflicts. Each version also gets requestUri, terms (Map predicate -> SPARQL JSON bindings of
 * its values), base: null for a version without base state (a create), else { uri, masterUri,
 * terms, links } with the values of the keys it changes (a changed key without a triple was empty)
 * and, for a tombstone, the links that pointed at its master when it was submitted ([{ subject,
 * predicate }]), and proposals as settleVersions gives them, for every key the version changes.
 * The unchanged checks were done when the request was made and are not repeated.
 */
export function versionsFromStore(result, model) {
  const versions = new Map();
  for (const binding of result?.results?.bindings || []) {
    const uri = binding.version.value;
    let version = versions.get(uri);
    if (!version) {
      const type = binding.type.value;
      const operation = operationKey(binding.operation.value);
      if (!operation) throw new Error(`Version ${uri} has an unknown cr:operation <${binding.operation.value}>`);
      version = {
        uri,
        uuid: null,
        requestUri: binding.request?.value ?? null,
        type,
        classUris: model.has(type) ? model.classTree(type) : [],
        masterUri: binding.master.value,
        masterUuid: binding.masterUuid.value,
        operation,
        lid: undefined,
        deleted: operation === 'delete',
        replaces: [],
        triples: [],
        terms: new Map(),
        base: null,
        keys: [],
        unchanged: [],
      };
      versions.set(uri, version);
    }
    if (binding.base) {
      // a triple of the state the version started from, or of one of its links
      version.base ??= { uri: binding.base.value, masterUri: version.masterUri, terms: new Map(), linkRows: new Map() };
      addStateRow(version.base, binding);
      continue;
    }
    const predicate = binding.p.value;
    if (predicate === `${NS.mu}uuid`) version.uuid = binding.o.value;
    else if (predicate === `${NS.cr}changesProperty`) version.replaces.push(binding.o.value);
    else if (!isVersionBookkeeping(predicate)) {
      version.triples.push({ predicate, object: term(binding.o) });
      push(version.terms, predicate, binding.o);
    }
  }
  for (const version of versions.values()) {
    if (version.base) version.base = finishState(version.base);
    version.replaces.sort();
    version.proposals = new Map(
      version.replaces.map((predicate) => {
        const key = keyByPredicate(model, version.type, predicate);
        const proposed = itemsFromTerms(key, version.terms.get(predicate) || []);
        const base = version.base ? itemsFromTerms(key, version.base.terms.get(predicate) || []) : null;
        return [predicate, { key, proposed, base, deleted: version.deleted }];
      }),
    );
  }
  return [...versions.values()];
}

/**
 * The states steps replaced when they applied their request, from the rows of
 * replacedStatesQuery: Map step URI -> [{ uri, stepUri, requestUri, masterUri, terms, links }],
 * in the shape of a version's base state.
 */
export function statesFromStore(result) {
  const states = new Map();
  for (const binding of result?.results?.bindings || []) {
    const uri = binding.state.value;
    let state = states.get(uri);
    if (!state) {
      state = { uri, stepUri: binding.step.value, requestUri: binding.request?.value ?? null, masterUri: binding.master.value, terms: new Map(), linkRows: new Map() };
      states.set(uri, state);
    }
    addStateRow(state, binding);
  }
  const byStep = new Map();
  for (const state of states.values()) {
    const finished = finishState(state);
    if (!byStep.has(finished.stepUri)) byStep.set(finished.stepUri, []);
    byStep.get(finished.stepUri).push(finished);
  }
  return byStep;
}
