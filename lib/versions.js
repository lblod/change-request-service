import { sparqlEscapeUri } from 'mu';
import { VERSION_BASE, TARGET_TYPE, NS } from '../constants.js';
import { allowedTypes, referenceTypes } from './config.js';
import { attributeObjects, LiteralError } from './literals.js';
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
 * A relationship is part of a document's state inside the aggregate when it is not inverse and
 * its target is in the aggregate or one of its references. Any other relationship a document
 * carries (classification, organization-status, ...) must be unchanged.
 */
export function isAdmittedRelationship(model, aggregate, definition) {
  return !definition.inverse && (isTargetInAggregate(model, aggregate, definition.target) || isReferenceType(model, aggregate, definition.target));
}

/** The type is the target type (organizations) or a subtype: the one organisation of a request. */
const isOrganisationType = (model, type) => model.isSubtypeOf(type, TARGET_TYPE);

/**
 * The predicates a document of this type may carry inside the aggregate: every attribute of the
 * type and every admitted relationship. A version replaces, on the master, exactly the predicates
 * of the keys its document carried (see buildVersions), which are a subset of these.
 */
export function aggregatePredicates(model, aggregate, type) {
  const predicates = new Set();
  for (const attribute of model.attributes(type).values()) predicates.add(attribute.predicate);
  for (const relationship of model.relationships(type).values()) {
    if (isAdmittedRelationship(model, aggregate, relationship)) predicates.add(relationship.predicate);
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

/** Every uuid the operations refer to: the ids of updates and deletes and the ids in relationships. */
export function collectReferences(operations) {
  const ids = new Set();
  if (!Array.isArray(operations)) return [];
  for (const operation of operations) {
    const data = operation?.data;
    if (!data || typeof data !== 'object') continue;
    if (typeof data.id === 'string') ids.add(data.id);
    for (const relationship of Object.values(data.relationships || {})) {
      const refs = Array.isArray(relationship?.data) ? relationship.data : relationship?.data ? [relationship.data] : [];
      for (const ref of refs) if (ref && typeof ref.id === 'string') ids.add(ref.id);
    }
  }
  return [...ids];
}

/**
 * Turns the operations of a request into version objects.
 *
 * @param operations   the ordered list of { op, data } from the request
 * @param aggregateName, aggregate   the aggregate the request names
 * @param model        the resources model
 * @param mintUuid     () => uuid, injected so tests are deterministic
 * @param resources    Map uuid -> { uri, classes } for every id in collectReferences(operations)
 * @param reachable    Set of the URIs that belong to the target's aggregate (reachableFromTarget)
 * @param target       { uri, uuid } of the target organisation
 * @returns { versions, lids }  lids maps each create's lid to the uuid minted for it
 *
 * A version is { uri, uuid, type, classUris, masterUri, masterUuid, operation, lid, deleted,
 * replaces, triples, unchanged }:
 *   replaces   on an update, the predicates of the keys the document carried; applying the
 *              version removes exactly these from the master before inserting the triples
 *              (per-key semantics: a key that is absent is left as it is, null or [] clears it);
 *              empty on a create, whose master is new
 *   triples    [{ predicate, object }] with the object as a rendered SPARQL term
 *   unchanged  [{ name, predicate, objects, where }]: relationships the document carried that are
 *              not part of the aggregate; the service refuses the request when the master's
 *              value differs, since the aggregate does not admit changing them
 *
 * Rules, each a 422 HttpError with a pointer at the operation:
 *   - a type outside the aggregate, an unknown attribute or relationship, a value that does not
 *     fit its datatype;
 *   - an organisation (the target type or a subtype) is only ever updated, and only the target
 *     itself: no creates, no deletes, no other organisation;
 *   - the id of an update or delete, and every id a relationship points at inside the aggregate,
 *     must belong to the target's aggregate (reachable from the target); references (code lists)
 *     must exist and be of the right type;
 *   - a relationship outside the aggregate cannot be set on a create and cannot point at a lid.
 */
export function buildVersions({ operations, aggregateName, aggregate, model, mintUuid, resources, reachable, target }) {
  const pointer = (index, ...rest) => ['/data/attributes/operations', index, ...rest].join('/');
  if (!Array.isArray(operations) || operations.length === 0) {
    throw unprocessable('"operations" must be a non-empty array', '/data/attributes/operations');
  }

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
      if (operation.op !== 'update') {
        throw unprocessable(
          `an organisation cannot be ${operation.op === 'create' ? 'created' : 'deleted'} through a change request; only "update" of the target is allowed`,
          pointer(index, 'op'),
        );
      }
      if (data.id !== target.uuid) {
        throw unprocessable(`an organisation document must be the target of the request ("${target.uuid}")`, pointer(index, 'data/id'));
      }
    }
    if (operation.op === 'create') {
      if (data.id !== undefined) throw unprocessable('a create must not carry an id; give it a "lid"', pointer(index, 'data/id'));
      if (typeof data.lid !== 'string' || !data.lid) throw unprocessable('a create needs a "lid" (local id)', pointer(index, 'data/lid'));
      if (lids.has(data.lid)) throw unprocessable(`duplicate lid "${data.lid}"`, pointer(index, 'data/lid'));
      const base = model.get(data.type).newResourceBase;
      if (!base) throw unprocessable(`the model has no new-resource-base for "${data.type}"`, pointer(index, 'data/type'));
      const uuid = mintUuid();
      lids.set(data.lid, { uuid, uri: base + uuid, type: data.type });
    } else {
      if (typeof data.id !== 'string' || !data.id) throw unprocessable(`a ${operation.op} needs an id`, pointer(index, 'data/id'));
      if (data.lid !== undefined) throw unprocessable('only a create carries a lid', pointer(index, 'data/lid'));
      if (seenIds.has(data.id)) throw unprocessable(`duplicate operation on id "${data.id}"`, pointer(index, 'data/id'));
      seenIds.add(data.id);
    }
    return { op: operation.op, data, index };
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

  // Pass 2: the versions, with the carried attributes and relationships as triples.
  const versions = parsed.map(({ op, data, index }) => {
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
      unchanged: [],
    };
    if (op === 'delete') return version;

    const attributes = data.attributes ?? {};
    if (typeof attributes !== 'object' || Array.isArray(attributes)) {
      throw unprocessable('"attributes" must be an object', pointer(index, 'data/attributes'));
    }
    for (const [name, value] of Object.entries(attributes)) {
      const attribute = model.attribute(type, name);
      const where = pointer(index, 'data/attributes', name);
      if (!attribute) throw unprocessable(`unknown attribute "${name}" for type "${type}"`, where);
      let objects;
      try {
        objects = attributeObjects(attribute.type, value);
      } catch (error) {
        if (error instanceof LiteralError) throw unprocessable(`attribute "${name}" (${attribute.type}): ${error.message}`, where);
        throw error;
      }
      if (op === 'update') version.replaces.push(attribute.predicate);
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
      if (definition.inverse) continue;
      if (!relationship || typeof relationship !== 'object' || !('data' in relationship)) {
        throw unprocessable(`relationship "${name}" must carry "data"`, where);
      }
      let refs;
      if (definition.cardinality === 'many') {
        if (!Array.isArray(relationship.data)) throw unprocessable(`relationship "${name}" has cardinality many and needs an array`, where);
        refs = relationship.data;
      } else {
        if (Array.isArray(relationship.data)) throw unprocessable(`relationship "${name}" has cardinality one and needs an object or null`, where);
        refs = relationship.data === null ? [] : [relationship.data];
      }
      const admitted = isAdmittedRelationship(model, aggregate, definition);
      if (!admitted && op === 'create' && refs.length) {
        throw unprocessable(`relationship "${name}" is not part of the aggregate "${aggregateName}" and cannot be set on a new ${type}`, where);
      }
      const uris = refs.map((ref, position) => {
        const refWhere = definition.cardinality === 'many' ? `${where}/data/${position}` : `${where}/data`;
        if (!ref || typeof ref !== 'object' || typeof ref.type !== 'string') {
          throw unprocessable(`relationship "${name}": a resource identifier needs a type`, refWhere);
        }
        const compatible =
          model.has(ref.type) &&
          (model.isSubtypeOf(ref.type, definition.target) || model.isSubtypeOf(definition.target, ref.type));
        if (!compatible) throw unprocessable(`relationship "${name}" expects ${definition.target}, got ${ref.type}`, refWhere);
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
      if (admitted) {
        if (op === 'update') version.replaces.push(definition.predicate);
        for (const uri of uris) version.triples.push({ predicate: definition.predicate, object: sparqlEscapeUri(uri) });
      } else if (op === 'update') {
        version.unchanged.push({ name, predicate: definition.predicate, objects: uris, where });
      }
    }
    version.replaces.sort();
    return version;
  });

  return {
    versions,
    lids: Object.fromEntries([...lids].map(([lid, { uuid }]) => [lid, uuid])),
  };
}

const BOOKKEEPING = new Set([
  `${NS.rdf}type`,
  `${NS.mu}uuid`,
  `${NS.dct}isVersionOf`,
  `${NS.prov}generatedAtTime`,
  `${NS.prov}wasGeneratedBy`,
  `${NS.cr}resourceType`,
  `${NS.cr}operation`,
  `${NS.cr}masterUuid`,
  `${NS.cr}deleted`,
]);

/**
 * Rebuilds the version objects of a request from the rows of storedVersionsQuery, in the shape
 * buildVersions produces, so a stored request can be applied again. The unchanged checks were
 * done when the request was made and are not repeated.
 */
export function versionsFromStore(result, model) {
  const versions = new Map();
  for (const binding of result?.results?.bindings || []) {
    const uri = binding.version.value;
    let version = versions.get(uri);
    if (!version) {
      const type = binding.type.value;
      const operation = binding.operation.value;
      version = {
        uri,
        uuid: null,
        type,
        classUris: model.classTree(type),
        masterUri: binding.master.value,
        masterUuid: binding.masterUuid.value,
        operation,
        lid: undefined,
        deleted: operation === 'delete',
        replaces: [],
        triples: [],
        unchanged: [],
      };
      versions.set(uri, version);
    }
    const predicate = binding.p.value;
    if (predicate === `${NS.mu}uuid`) version.uuid = binding.o.value;
    else if (predicate === `${NS.cr}replaces`) version.replaces.push(binding.o.value);
    else if (!BOOKKEEPING.has(predicate)) version.triples.push({ predicate, object: term(binding.o) });
  }
  for (const version of versions.values()) version.replaces.sort();
  return [...versions.values()];
}
