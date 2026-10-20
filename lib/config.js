import fs from 'node:fs';
import { KINDS, TARGET_TYPE } from '../constants.js';

const VISIBILITY = ['everyone', 'involved'];

/**
 * Loads /config/change-requests.json and checks it against the resources model:
 * every type an aggregate names must exist, so a typo fails at start-up and not on the first POST.
 *
 * An aggregate is { kind?, root, members, references? }: root and members are the types a request
 * may create, update and delete; references are types a document may link to but never operate
 * on (code lists such as locations, concepts and site types). kind is "edit" (the default: records
 * of an organisation that exists, applied at once), "creation" (a request to register a new
 * organisation: the root must be the organisation type, and the request creates it) or
 * "change-event" (a request to register a veranderingsgebeurtenis about an organisation that
 * exists). Creations and change events wait for ABB (policies/index.js).
 *
 * creatableClassifications maps the classification of an organisation to the classifications of
 * the organisations it may request ("Wie beheert"): a gemeente requests an AGB, an OCMW a
 * welzijnsvereniging. pendingVisibleTo says who sees a request that still waits: "everyone" (every
 * logged-in user, the default) or "involved" (the requesting organisation, the organisation the
 * request is about, and ABB; everyone sees it once it is applied).
 */
export function loadConfig(file, model) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read the change-request configuration ${file}: ${error.message}`);
  }
  const aggregates = config.aggregates;
  if (!aggregates || typeof aggregates !== 'object' || Array.isArray(aggregates) || !Object.keys(aggregates).length) {
    throw new Error(`${file}: "aggregates" must map aggregate names to { kind, root, members, references }`);
  }
  for (const [name, aggregate] of Object.entries(aggregates)) {
    if (!aggregate || typeof aggregate.root !== 'string') {
      throw new Error(`${file}: aggregate "${name}" needs a "root" type name`);
    }
    if (aggregate.kind !== undefined && !KINDS.includes(aggregate.kind)) {
      throw new Error(`${file}: aggregate "${name}": "kind" must be one of ${KINDS.join(', ')}`);
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
  }
  const creatable = config.creatableClassifications ?? {};
  if (typeof creatable !== 'object' || Array.isArray(creatable)) {
    throw new Error(`${file}: "creatableClassifications" must map a classification URI to the classification URIs it may request`);
  }
  for (const [classification, classifications] of Object.entries(creatable)) {
    if (!Array.isArray(classifications) || classifications.some((uri) => typeof uri !== 'string' || !uri)) {
      throw new Error(`${file}: "creatableClassifications": "${classification}" must list classification URIs`);
    }
  }
  config.creatableClassifications = creatable;
  config.pendingVisibleTo ??= 'everyone';
  if (!VISIBILITY.includes(config.pendingVisibleTo)) {
    throw new Error(`${file}: "pendingVisibleTo" must be one of ${VISIBILITY.join(', ')}`);
  }
  if (typeof config.abbUri !== 'string' || !config.abbUri) {
    throw new Error(`${file}: "abbUri" must be the URI of the ABB organisation`);
  }
  if (typeof config.statusScheme !== 'string' || !config.statusScheme) {
    throw new Error(`${file}: "statusScheme" must be the URI of the change-request status concept scheme`);
  }
  return config;
}

/** The kind of an aggregate: edit (the default), creation or change-event. */
export function aggregateKind(aggregate) {
  return aggregate?.kind ?? 'edit';
}

/** The names of the aggregates of a kind. */
export function aggregatesOfKind(config, kind) {
  return Object.entries(config.aggregates)
    .filter(([, aggregate]) => aggregateKind(aggregate) === kind)
    .map(([name]) => name);
}

/** The whitelist of an aggregate: its root type and its member types, the types a request operates on. */
export function allowedTypes(aggregate) {
  return [aggregate.root, ...aggregate.members];
}

/** The types a document in the aggregate may link to without operating on them (code lists). */
export function referenceTypes(aggregate) {
  return aggregate.references || [];
}
