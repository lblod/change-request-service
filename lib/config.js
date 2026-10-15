import fs from 'node:fs';

/**
 * Loads /config/change-requests.json and checks it against the resources model:
 * every type an aggregate names must exist, so a typo fails at start-up and not on the first POST.
 *
 * An aggregate is { root, members, references? }: root and members are the types a request may
 * create, update and delete; references are types a document may link to but never operate on
 * (code lists such as locations, concepts and site types).
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
    throw new Error(`${file}: "aggregates" must map aggregate names to { root, members, references }`);
  }
  for (const [name, aggregate] of Object.entries(aggregates)) {
    if (!aggregate || typeof aggregate.root !== 'string') {
      throw new Error(`${file}: aggregate "${name}" needs a "root" type name`);
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
  }
  if (typeof config.abbUri !== 'string' || !config.abbUri) {
    throw new Error(`${file}: "abbUri" must be the URI of the ABB organisation`);
  }
  if (typeof config.statusScheme !== 'string' || !config.statusScheme) {
    throw new Error(`${file}: "statusScheme" must be the URI of the change-request status concept scheme`);
  }
  return config;
}

/** The whitelist of an aggregate: its root type and its member types, the types a request operates on. */
export function allowedTypes(aggregate) {
  return [aggregate.root, ...aggregate.members];
}

/** The types a document in the aggregate may link to without operating on them (code lists). */
export function referenceTypes(aggregate) {
  return aggregate.references || [];
}
