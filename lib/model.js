import fs from 'node:fs';
import path from 'node:path';
import { isKnownLiteralType } from './literals.js';

/**
 * Loads the mu-cl-resources JSON model files (the same files mu-cl-resources reads through
 * read-domain-file) and resolves them into one Model: full URIs, "super" inheritance,
 * relationship targets given by the singular "name" of a resource.
 *
 * Nothing here talks to the database; the model is read once at start-up.
 */
export function loadModel(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort();
  } catch (error) {
    throw new Error(`Cannot read the resources model directory ${dir}: ${error.message}`);
  }
  if (!files.length) throw new Error(`No resources model files (*.json) in ${dir}`);

  const prefixes = {};
  const raw = new Map();
  const aliases = new Map();
  for (const file of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const filePrefixes = doc.prefixes || {};
    for (const [prefix, uri] of Object.entries(filePrefixes)) {
      if (!prefixes[prefix]) prefixes[prefix] = uri;
      else if (prefixes[prefix] !== uri) {
        console.warn(`Model: prefix ${prefix} is ${prefixes[prefix]} and ${uri} (${file}); keeping the first`);
      }
    }
    for (const [name, def] of Object.entries(doc.resources || {})) {
      if (raw.has(name)) {
        throw new Error(`Model: resource type "${name}" is defined in both ${raw.get(name).file} and ${file}`);
      }
      raw.set(name, { name, def, prefixes: filePrefixes, file });
    }
  }
  // A relationship target may be the path name ("files") or the singular "name" ("file").
  for (const { name } of raw.values()) aliases.set(name, name);
  for (const { name, def } of raw.values()) {
    if (typeof def.name === 'string' && !aliases.has(def.name)) aliases.set(def.name, name);
  }
  const resolveName = (value, where) => {
    const resolved = aliases.get(value);
    if (!resolved) throw new Error(`Model: ${where} refers to the unknown resource type "${value}"`);
    return resolved;
  };

  const types = new Map();
  for (const { name, def, prefixes: filePrefixes, file } of raw.values()) {
    const where = `${file}#${name}`;
    const expand = (value, what) => expandCurie(value, filePrefixes, `${where} ${what}`);
    const ownAttributes = new Map();
    for (const [attributeName, attribute] of Object.entries(def.attributes || {})) {
      if (!isKnownLiteralType(attribute.type)) {
        console.warn(
          `Model: ${where}.${attributeName} has the type "${attribute.type}", which mu-cl-resources does not know; ` +
            'it is written as a plain string, as mu-cl-resources does',
        );
      }
      ownAttributes.set(attributeName, {
        name: attributeName,
        type: attribute.type,
        predicate: expand(attribute.predicate, `attribute ${attributeName}`),
      });
    }
    const ownRelationships = new Map();
    for (const [relationshipName, relationship] of Object.entries(def.relationships || {})) {
      if (relationship.cardinality !== 'one' && relationship.cardinality !== 'many') {
        throw new Error(`Model: ${where}.${relationshipName} needs cardinality "one" or "many"`);
      }
      // A stack may load only part of a model (app-lokale-verkenner loaded domain.json and auth.json
      // without the change-events.json that organizations.changed-by points into, until 15 October
      // 2026). mu-cl-resources starts on such a model and only fails when the relationship is
      // used, so the service leaves the relationship out instead of refusing to start; a document
      // that carries it gets a 422.
      const target = aliases.get(relationship.target);
      if (!target) {
        console.warn(
          `Model: ${where}.${relationshipName} refers to the unknown resource type "${relationship.target}"; ` +
            'the relationship is left out',
        );
        continue;
      }
      ownRelationships.set(relationshipName, {
        name: relationshipName,
        predicate: expand(relationship.predicate, `relationship ${relationshipName}`),
        target,
        cardinality: relationship.cardinality,
        inverse: relationship.inverse === true,
      });
    }
    types.set(name, {
      name,
      class: expand(def.class, 'class'),
      super: (def.super || []).map((parent) => resolveName(parent, `${where} super`)),
      newResourceBase: def['new-resource-base'],
      features: def.features || [],
      ownAttributes,
      ownRelationships,
    });
  }
  return new Model(types, prefixes);
}

/**
 * Expands prefix:local with the prefixes of the file the value comes from; keeps full IRIs.
 */
export function expandCurie(value, prefixes, where) {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${where}: expected a URI or CURIE, got ${JSON.stringify(value)}`);
  }
  const colon = value.indexOf(':');
  if (colon > 0) {
    const prefix = value.slice(0, colon);
    if (Object.hasOwn(prefixes, prefix)) return prefixes[prefix] + value.slice(colon + 1);
  }
  if (value.includes('://') || /^(urn|mailto|tel):/i.test(value)) return value;
  throw new Error(`${where}: unknown prefix in "${value}"`);
}

/**
 * Walks "super" for every type: ancestors nearest first, and the attributes and relationships
 * a type carries, where a type overrides what it inherits under the same name.
 */
function resolveInheritance(types) {
  const resolved = new Map();
  const resolve = (name, trail) => {
    if (resolved.has(name)) return resolved.get(name);
    if (trail.includes(name)) throw new Error(`Model: inheritance cycle ${[...trail, name].join(' -> ')}`);
    const type = types.get(name);
    const ancestors = [];
    const attributes = new Map();
    const relationships = new Map();
    for (const parent of type.super) {
      const parentResolved = resolve(parent, [...trail, name]);
      for (const ancestor of [parent, ...parentResolved.ancestors]) {
        if (!ancestors.includes(ancestor)) ancestors.push(ancestor);
      }
      for (const [key, value] of parentResolved.attributes) attributes.set(key, value);
      for (const [key, value] of parentResolved.relationships) relationships.set(key, value);
    }
    for (const [key, value] of type.ownAttributes) attributes.set(key, value);
    for (const [key, value] of type.ownRelationships) relationships.set(key, value);
    const entry = { ancestors, attributes, relationships };
    resolved.set(name, entry);
    return entry;
  };
  for (const name of types.keys()) resolve(name, []);
  return resolved;
}

export class Model {
  constructor(types, prefixes) {
    this.types = types;
    this.prefixes = prefixes;
    this.resolved = resolveInheritance(types);
  }

  has(name) {
    return this.types.has(name);
  }

  get(name) {
    const type = this.types.get(name);
    if (!type) throw new Error(`Unknown resource type "${name}"`);
    return type;
  }

  names() {
    return [...this.types.keys()];
  }

  /** Ancestors of a type, nearest first. */
  ancestors(name) {
    this.get(name);
    return this.resolved.get(name).ancestors;
  }

  descendants(name) {
    this.get(name);
    return this.names().filter((other) => this.resolved.get(other).ancestors.includes(name));
  }

  /** True when name is ancestor, or inherits from it. */
  isSubtypeOf(name, ancestor) {
    return name === ancestor || this.ancestors(name).includes(ancestor);
  }

  /** All attributes of a type, inherited ones included: Map name -> { name, type, predicate }. */
  attributes(name) {
    this.get(name);
    return this.resolved.get(name).attributes;
  }

  /** All relationships of a type, inherited ones included: Map name -> { name, predicate, target, cardinality, inverse }. */
  relationships(name) {
    this.get(name);
    return this.resolved.get(name).relationships;
  }

  attribute(typeName, attributeName) {
    return this.attributes(typeName).get(attributeName);
  }

  relationship(typeName, relationshipName) {
    return this.relationships(typeName).get(relationshipName);
  }

  /** The RDF classes of a type and of all its subtypes. */
  classesOf(name) {
    return [...new Set([name, ...this.descendants(name)].map((type) => this.get(type).class))];
  }

  /**
   * The classes a new instance of a type carries, most specific first: its own class and the
   * classes of its ancestors, as mu-cl-resources writes them on a create (flattened-ld-class-tree).
   */
  classTree(name) {
    return [...new Set([name, ...this.ancestors(name)].map((type) => this.get(type).class))];
  }

  /**
   * Predicates of triples that point at an instance of this type: the non-inverse relationships
   * of any type targeting it (or a type related to it by inheritance), and the inverse
   * relationships declared on it. Used to remove the links to a deleted entity.
   */
  incomingPredicates(name) {
    const related = new Set([name, ...this.ancestors(name), ...this.descendants(name)]);
    const predicates = new Set();
    for (const type of this.types.keys()) {
      for (const relationship of this.relationships(type).values()) {
        if (!relationship.inverse && related.has(relationship.target)) predicates.add(relationship.predicate);
        if (relationship.inverse && related.has(type)) predicates.add(relationship.predicate);
      }
    }
    return [...predicates].sort();
  }
}
