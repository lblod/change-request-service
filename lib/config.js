import fs from 'node:fs';
import { KINDS, TARGET_TYPE } from '../constants.js';

const VISIBILITY = ['everyone', 'involved'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isUriList = (value) => Array.isArray(value) && value.every((uri) => typeof uri === 'string' && uri);

/**
 * Loads /config/change-requests.json and checks it against the resources model:
 * every type an aggregate names must exist, so a typo fails at start-up and not on the first POST.
 * Nothing has a default that widens what a request may do: a missing kind or visibility is an
 * error, not "edit, applied at once" or "everyone".
 *
 * An aggregate is { kind, root, members, references?, writable? }: root and members are the types
 * a request may create, update and delete; references are types a document may link to but never
 * operate on (code lists such as locations, concepts and site types). kind is "edit" (records of
 * an organisation that exists, applied at once), "creation" (a request to register a new
 * organisation: the root must be the organisation type, and the request creates it) or
 * "change-event" (a request to register a veranderingsgebeurtenis about an organisation that
 * exists). Creations and change events wait for ABB (policies/index.js). writable narrows, per
 * type, the keys (attributes and relationships) the aggregate may change on a record that exists:
 * { "organizations": ["name", "sites"] } lets an update of an organisation (or of a subtype)
 * change only those two keys; any other key it carries must be unchanged. A type without an entry
 * may change every attribute and every relationship to a type of the aggregate or a reference.
 *
 * registration describes the organisations a creation registers: types maps the resource type a
 * new organisation is created as to the classifications (URIs) registered as that type, which are
 * all the classifications the service registers; foundingEventType is the change-event type (URI)
 * of the oprichting every creation carries; kboOptional lists the classifications registered
 * without a KBO number (every other one needs one). creatableClassifications maps the
 * classification of an organisation to the classifications of the organisations it may request
 * ("Wie beheert"): a gemeente requests an AGB, an OCMW a welzijnsvereniging; ABB may request every
 * classification of registration.types. pendingVisibleTo says who sees a request that still waits:
 * "everyone" (every logged-in user) or "involved" (the requesting organisation, the organisation
 * the request is about, and ABB; everyone sees it once it is decided).
 */
export function loadConfig(file, model) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read the change-request configuration ${file}: ${error.message}`);
  }
  const aggregates = config.aggregates;
  if (!isObject(aggregates) || !Object.keys(aggregates).length) {
    throw new Error(`${file}: "aggregates" must map aggregate names to { kind, root, members, references, writable }`);
  }
  for (const [name, aggregate] of Object.entries(aggregates)) {
    if (!aggregate || typeof aggregate.root !== 'string') {
      throw new Error(`${file}: aggregate "${name}" needs a "root" type name`);
    }
    if (!KINDS.includes(aggregate.kind)) {
      throw new Error(`${file}: aggregate "${name}" needs a "kind", one of ${KINDS.join(', ')}`);
    }
    if (!Array.isArray(aggregate.members) || aggregate.members.some((member) => typeof member !== 'string')) {
      throw new Error(`${file}: aggregate "${name}" needs a "members" array of type names`);
    }
    if (aggregate.references !== undefined && (!Array.isArray(aggregate.references) || aggregate.references.some((type) => typeof type !== 'string'))) {
      throw new Error(`${file}: aggregate "${name}": "references" must be an array of type names`);
    }
    for (const type of [...allowedTypes(aggregate), ...referenceTypes(aggregate)]) {
      if (!model.has(type)) {
        throw new Error(`${file}: aggregate "${name}" names the type "${type}", which the resources model does not define`);
      }
    }
    for (const type of referenceTypes(aggregate)) {
      if (allowedTypes(aggregate).includes(type)) {
        throw new Error(`${file}: aggregate "${name}" lists "${type}" both as a type it operates on and as a reference`);
      }
    }
    if (aggregateKind(aggregate) === 'creation' && !model.isSubtypeOf(aggregate.root, TARGET_TYPE)) {
      throw new Error(`${file}: aggregate "${name}" is a creation, so its root must be ${TARGET_TYPE} or a subtype, not "${aggregate.root}"`);
    }
    checkWritable(file, name, aggregate, model);
  }
  checkRegistration(file, config, model);
  const creatable = config.creatableClassifications ?? {};
  if (!isObject(creatable)) {
    throw new Error(`${file}: "creatableClassifications" must map a classification URI to the classification URIs it may request`);
  }
  const registrable = new Set(registrableClassifications(config));
  for (const [classification, classifications] of Object.entries(creatable)) {
    if (!isUriList(classifications)) {
      throw new Error(`${file}: "creatableClassifications": "${classification}" must list classification URIs`);
    }
    for (const uri of classifications) {
      if (!registrable.has(uri)) {
        throw new Error(`${file}: "creatableClassifications": "${classification}" lists ${uri}, which "registration.types" does not register`);
      }
    }
  }
  config.creatableClassifications = creatable;
  if (!VISIBILITY.includes(config.pendingVisibleTo)) {
    throw new Error(`${file}: "pendingVisibleTo" must be one of ${VISIBILITY.join(', ')}`);
  }
  if (typeof config.abbUri !== 'string' || !config.abbUri) {
    throw new Error(`${file}: "abbUri" must be the URI of the ABB organisation`);
  }
  return config;
}

/** Checks the writable keys of an aggregate: types it operates on, keys those types (or their subtypes) have. */
function checkWritable(file, name, aggregate, model) {
  if (aggregate.writable === undefined) return;
  if (!isObject(aggregate.writable)) {
    throw new Error(`${file}: aggregate "${name}": "writable" must map a type name to the keys the aggregate may change on it`);
  }
  for (const [type, keys] of Object.entries(aggregate.writable)) {
    if (!model.has(type) || !allowedTypes(aggregate).some((allowed) => model.isSubtypeOf(type, allowed) || model.isSubtypeOf(allowed, type))) {
      throw new Error(`${file}: aggregate "${name}": "writable" names "${type}", which is not a type the aggregate operates on`);
    }
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) {
      throw new Error(`${file}: aggregate "${name}": "writable.${type}" must be an array of attribute and relationship names`);
    }
    const family = [type, ...model.descendants(type)];
    for (const key of keys) {
      if (!family.some((member) => model.attribute(member, key) || model.relationship(member, key))) {
        throw new Error(`${file}: aggregate "${name}": "writable.${type}" names "${key}", which no attribute or relationship of ${type} has`);
      }
    }
  }
}

/** Checks the registration block, required as soon as an aggregate registers organisations. */
function checkRegistration(file, config, model) {
  const creations = Object.entries(config.aggregates).filter(([, aggregate]) => aggregateKind(aggregate) === 'creation');
  if (config.registration === undefined && !creations.length) return;
  const registration = config.registration;
  if (!isObject(registration) || !isObject(registration.types) || !Object.keys(registration.types).length) {
    throw new Error(`${file}: "registration.types" must map the type a new organisation is created as to the classification URIs registered as that type`);
  }
  const seen = new Map();
  for (const [type, classifications] of Object.entries(registration.types)) {
    if (!model.has(type) || !model.isSubtypeOf(type, TARGET_TYPE)) {
      throw new Error(`${file}: "registration.types" names "${type}", which is not ${TARGET_TYPE} or a subtype`);
    }
    for (const [name, aggregate] of creations) {
      if (!allowedTypes(aggregate).some((allowed) => model.isSubtypeOf(type, allowed))) {
        throw new Error(`${file}: "registration.types" names "${type}", which the creation aggregate "${name}" does not operate on`);
      }
    }
    if (!isUriList(classifications)) throw new Error(`${file}: "registration.types.${type}" must list classification URIs`);
    for (const uri of classifications) {
      if (seen.has(uri)) throw new Error(`${file}: "registration.types" registers ${uri} as both ${seen.get(uri)} and ${type}`);
      seen.set(uri, type);
    }
  }
  if (typeof registration.foundingEventType !== 'string' || !registration.foundingEventType) {
    throw new Error(`${file}: "registration.foundingEventType" must be the URI of the change-event type of an oprichting`);
  }
  registration.kboOptional ??= [];
  if (!isUriList(registration.kboOptional) || registration.kboOptional.some((uri) => !seen.has(uri))) {
    throw new Error(`${file}: "registration.kboOptional" must list classification URIs of "registration.types"`);
  }
}

/** The kind of an aggregate: edit, creation or change-event (loadConfig requires it). */
export function aggregateKind(aggregate) {
  return aggregate?.kind ?? null;
}

/** The names of the aggregates of a kind. */
export function aggregatesOfKind(config, kind) {
  return Object.entries(config.aggregates)
    .filter(([, aggregate]) => aggregateKind(aggregate) === kind)
    .map(([name]) => name);
}

/** The configured aggregate of a name, or undefined; never a property of Object.prototype. */
export function aggregateNamed(config, name) {
  return typeof name === 'string' && Object.hasOwn(config.aggregates, name) ? config.aggregates[name] : undefined;
}

/** The whitelist of an aggregate: its root type and its member types, the types a request operates on. */
export function allowedTypes(aggregate) {
  return [aggregate.root, ...aggregate.members];
}

/** The types a document in the aggregate may link to without operating on them (code lists). */
export function referenceTypes(aggregate) {
  return aggregate.references || [];
}

/** Every classification (URI) the service registers organisations of. */
export function registrableClassifications(config) {
  return Object.values(config.registration?.types ?? {}).flat();
}

/** The resource type a new organisation of a classification is created as, or null. */
export function registrationType(config, classificationUri) {
  for (const [type, classifications] of Object.entries(config.registration?.types ?? {})) {
    if (classifications.includes(classificationUri)) return type;
  }
  return null;
}
