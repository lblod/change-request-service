import { createHash } from 'node:crypto';
import { NS } from '../constants.js';
import { itemsFromTerms, itemsNotIn, isSetKey, keyJson, sameItems, shareItems } from './values.js';

/**
 * Conflicts: a key of a master where a request's proposal disagrees with what the master holds
 * now and the master no longer holds what the request started from. A conflict is
 * { version, key, base, current, proposed, masterExists, competing } internally (values as items,
 * see values.js; current null when the master no longer exists), or, for a link made to the
 * master of a pending tombstone, { version, link: { subject, predicate } } until resolveLinks
 * turns it into a conflict on the record that links. It is rendered for the API as
 * { resource: { type, id }, key, base, current, proposed, "master-exists", "competing-requests": [uuid] }.
 *
 * Versions carry proposals (settleVersions for a submission, versionsFromStore for a stored
 * request): Map predicate -> { key, proposed, base, deleted } for every key the version writes,
 * with the values as items.
 */

const RDF_TYPE = `${NS.rdf}type`;

/**
 * The (master, predicate) pairs a goedkeuring or a hertoepassing reads: whether the master of
 * every update and tombstone still exists (master, rdf:type) and the keys the versions change
 * (the live conflicts, the plan of the apply and the states it replaces).
 */
export function storedPairs(versions) {
  return versions
    .filter((version) => version.operation !== 'create')
    .flatMap((version) => [
      { subject: version.masterUri, predicate: RDF_TYPE },
      ...(version.base ? version.replaces.map((predicate) => ({ subject: version.masterUri, predicate })) : []),
    ]);
}

/** The (object, predicate) pairs of the links to the masters of stored tombstones. */
export function storedIncomingPairs(versions, model) {
  return versions
    .filter((version) => version.deleted && version.base)
    .flatMap((version) => model.incomingPredicates(version.type).map((predicate) => ({ object: version.masterUri, predicate })));
}

const exists = (current, version) => (current.get(`${version.masterUri} ${RDF_TYPE}`) || []).length > 0;

/**
 * The stored updates whose master no longer exists (current: currentTerms over storedPairs): the
 * record was deleted since, and an apply would write values on a record without a type, which
 * sparql-parser refuses. Such a request cannot be applied; it is rejected or withdrawn.
 */
export function missingMasters(versions, current) {
  return versions.filter((version) => version.operation === 'update' && !exists(current, version));
}

/**
 * The live conflicts of stored versions (versionsFromStore): the rules of settleVersions applied
 * to the stored base (B) and proposal (P) and the current values (C, currentTerms over storedPairs).
 *   - An update conflicts on a single-valued key unless P = B, C = B or C = P; a set key merges and
 *     never conflicts. A master that no longer exists conflicts on every key the version replaces,
 *     with current null and masterExists false.
 *   - A tombstone conflicts on a key where C holds a value B does not, and on every link made to
 *     its master after it was submitted (incoming: incomingTerms over storedIncomingPairs, compared
 *     with the links of its base state). A master that is gone already is no conflict for a
 *     tombstone.
 * Versions without a base state (creates) have nothing to compare.
 */
export function storedConflicts({ versions, current, incoming = new Map(), model }) {
  const conflicts = [];
  for (const version of versions) {
    if (version.operation === 'create' || !version.base) continue;
    const present = exists(current, version);
    if (version.deleted && !present) continue;
    for (const [predicate, { key, proposed, base }] of version.proposals) {
      if (!present) {
        conflicts.push({ version, key, base, current: null, proposed, masterExists: false });
        continue;
      }
      const now = itemsFromTerms(key, current.get(`${version.masterUri} ${predicate}`) || []);
      if (version.deleted) {
        if (itemsNotIn(now, base).length) conflicts.push({ version, key, base, current: now, proposed, masterExists: true });
      } else if (!isSetKey(key) && !sameItems(proposed, base) && !sameItems(now, base) && !sameItems(now, proposed)) {
        conflicts.push({ version, key, base, current: now, proposed, masterExists: true });
      }
    }
    if (version.deleted) {
      for (const predicate of model.incomingPredicates(version.type)) {
        const before = new Set(version.base.links.filter((link) => link.predicate === predicate).map((link) => link.subject));
        for (const subject of incoming.get(`${version.masterUri} ${predicate}`) || []) {
          if (!before.has(subject.value)) conflicts.push({ version, link: { subject: subject.value, predicate }, masterExists: true });
        }
      }
    }
  }
  return conflicts;
}

/**
 * The conflicts an apply overrode: the rules of storedConflicts with the states the apply replaced
 * (replacedStates in versions.js, read back with statesFromStore) in place of the current values
 * and links. For a goedkeuring these are the conflicts the approver reviewed and overrode with
 * their token; a step that applied a request without conflicts gets none. versions: the stored
 * versions of the request; states: the states one step replaced.
 */
export function overriddenConflicts({ versions, states, model }) {
  const byMaster = new Map(states.map((state) => [state.masterUri, state]));
  const replaced = versions.filter((version) => version.operation !== 'create' && byMaster.has(version.masterUri));
  const current = new Map();
  const incoming = new Map();
  for (const version of replaced) {
    const state = byMaster.get(version.masterUri);
    // a state is only written for a master that was there when the apply ran
    current.set(`${version.masterUri} ${RDF_TYPE}`, [{ type: 'uri', value: version.classUris[0] ?? version.masterUri }]);
    for (const predicate of version.replaces) current.set(`${version.masterUri} ${predicate}`, state.terms.get(predicate) || []);
    for (const link of state.links) {
      const key = `${version.masterUri} ${link.predicate}`;
      if (!incoming.has(key)) incoming.set(key, []);
      incoming.get(key).push({ type: 'uri', value: link.subject });
    }
  }
  return storedConflicts({ versions: replaced, current, incoming, model });
}

/** The records the link conflicts come from, to look up their uuid and type (describeRecords). */
export function linkingRecords(conflicts) {
  return [...new Set(conflicts.filter((conflict) => conflict.link).map((conflict) => conflict.link.subject))];
}

/**
 * The relationship a record of one of the given classes links to a type with: the non-inverse
 * relationship with the predicate whose target is that type or related to it by inheritance, on
 * the most specific model type among the classes. null when the model has none.
 */
function linkingKey(model, classes, predicate, linkedType) {
  const related = (target) => model.isSubtypeOf(linkedType, target) || model.isSubtypeOf(target, linkedType);
  const candidates = model.names().filter((type) => {
    if (!classes.includes(model.get(type).class)) return false;
    return [...model.relationships(type).values()].some((relationship) => !relationship.inverse && relationship.predicate === predicate && related(relationship.target));
  });
  const [type] = candidates.filter((candidate) => !candidates.some((other) => other !== candidate && model.isSubtypeOf(other, candidate))).sort();
  if (!type) return null;
  const relationship = [...model.relationships(type).values()].find((candidate) => !candidate.inverse && candidate.predicate === predicate && related(candidate.target));
  return { type, key: { name: relationship.name, kind: 'relationship', predicate, cardinality: relationship.cardinality, target: relationship.target } };
}

/**
 * Turns the link conflicts of tombstones (storedConflicts) into conflicts on the record that
 * links: deleting the master would take it out of that record's relationship (key), which holds
 * it now (current) and did not when the tombstone was submitted (base); the proposal is without it.
 * Only the link to the deleted master is shown. records maps the linking records to { uuid,
 * classes } (describeRecords); a record of a type the model does not know keeps the predicate as
 * its key.
 */
export function resolveLinks(conflicts, records, model) {
  return conflicts.map((conflict) => {
    if (!conflict.link) return conflict;
    const { subject, predicate } = conflict.link;
    const record = records.get(subject) || { uuid: null, classes: [] };
    const found = linkingKey(model, record.classes, predicate, conflict.version.type);
    const key = found?.key ?? { name: predicate, kind: 'relationship', predicate, cardinality: 'many', target: conflict.version.type };
    return {
      version: conflict.version,
      resource: { type: found?.type ?? null, id: record.uuid, uri: subject },
      key,
      base: [],
      current: [conflict.version.masterUri],
      proposed: [],
      masterExists: true,
      link: conflict.link,
    };
  });
}

/** The (master, predicate) pairs the versions write, to look up competing requests. */
export function writtenPairs(versions) {
  return versions
    .filter((version) => version.proposals)
    .flatMap((version) => [...version.proposals.keys()].map((predicate) => ({ subject: version.masterUri, predicate })));
}

/**
 * Whether two pending versions that write the same key of the same master disagree. Two set keys
 * with a base merge unless one adds what the other removes; otherwise, and when either is a
 * tombstone (which removes the record), they disagree when they propose different values.
 */
export function disagree(left, right) {
  if (isSetKey(left.key) && left.base && right.base && !left.deleted && !right.deleted) {
    const adds = (proposal) => itemsNotIn(proposal.proposed, proposal.base);
    const removes = (proposal) => itemsNotIn(proposal.base, proposal.proposed);
    return shareItems(adds(left), removes(right)) || shareItems(removes(left), adds(right));
  }
  return !sameItems(left.proposed, right.proposed);
}

/**
 * The competing requests of every key the versions write: other pending requests (their stored
 * versions, others, with requestUri, and uuids: Map request URI -> uuid) whose version writes the
 * same key of the same master and disagrees with it. requestUri is the request of versions that
 * are not stored yet (a submission). Returns Map "<version URI> <predicate>" -> sorted uuids, only
 * for keys that have some.
 */
export function competingRequests(versions, others, uuids, requestUri = null) {
  const byPair = new Map();
  for (const other of others) {
    for (const [predicate, proposal] of other.proposals || []) {
      const pair = `${other.masterUri} ${predicate}`;
      if (!byPair.has(pair)) byPair.set(pair, []);
      byPair.get(pair).push({ requestUri: other.requestUri, proposal });
    }
  }
  const competing = new Map();
  for (const version of versions) {
    const own = version.requestUri ?? requestUri;
    for (const [predicate, proposal] of version.proposals || []) {
      const found = new Set();
      for (const other of byPair.get(`${version.masterUri} ${predicate}`) || []) {
        if (other.requestUri !== own && disagree(proposal, other.proposal)) found.add(uuids.get(other.requestUri));
      }
      if (found.size) competing.set(`${version.uri} ${predicate}`, [...found].sort());
    }
  }
  return competing;
}

/** Sets the competing requests (competingRequests) on conflicts; a link conflict has none. */
export function attachCompeting(conflicts, competing) {
  for (const conflict of conflicts) {
    conflict.competing = conflict.link ? [] : competing.get(`${conflict.version.uri} ${conflict.key.predicate}`) || [];
  }
  return conflicts;
}

/**
 * The keys with competing requests, one entry per key: { version, key, proposed, competing }, for
 * the "competing" attribute of a request.
 */
export function competingKeys(versions, competing) {
  const keys = [];
  for (const version of versions) {
    for (const [predicate, { key, proposed }] of version.proposals || []) {
      const found = competing.get(`${version.uri} ${predicate}`);
      if (found) keys.push({ version, key, proposed, competing: found });
    }
  }
  return keys;
}

/** The URIs of the related records that relationship values of conflicts and competing keys point at. */
export function relatedUris(entries) {
  const uris = new Set();
  for (const entry of entries) {
    if (entry.key?.kind !== 'relationship') continue;
    for (const uri of [...(entry.base || []), ...(entry.current || []), ...(entry.proposed || [])]) uris.add(uri);
  }
  return [...uris];
}

const resourceOf = (entry) => {
  if (entry.resource) return { type: entry.resource.type, id: entry.resource.id };
  return { type: entry.version.type, id: entry.version.masterUuid };
};

/** The API form of a conflict; uuids maps the URIs of related records to their uuid. */
export function renderConflict(conflict, uuids = new Map()) {
  return {
    resource: resourceOf(conflict),
    key: conflict.key.name,
    base: keyJson(conflict.key, conflict.base, uuids),
    current: conflict.current === null ? null : keyJson(conflict.key, conflict.current, uuids),
    proposed: keyJson(conflict.key, conflict.proposed, uuids),
    'master-exists': conflict.masterExists !== false,
    'competing-requests': conflict.competing || [],
  };
}

/** The API form of a key with competing requests (competingKeys). */
export function renderCompeting(entry, uuids = new Map()) {
  return {
    resource: resourceOf(entry),
    key: entry.key.name,
    proposed: keyJson(entry.key, entry.proposed, uuids),
    'competing-requests': entry.competing,
  };
}

/** The form of a rendered conflict a token covers: without its competing requests, which do not count. */
export const overriddenForm = ({ 'competing-requests': _competing, ...conflict }) => conflict;

/**
 * The token of a set of rendered conflicts: a goedkeuring that passes it as "override" overrides
 * exactly these conflicts, as the approver saw them (GET, or the 409 of an earlier attempt). Any
 * change in a resource, key or value gives another token; the competing requests do not count.
 * null without conflicts.
 */
export function conflictsToken(rendered) {
  if (!rendered.length) return null;
  const canonical = rendered.map((conflict) => JSON.stringify(overriddenForm(conflict))).sort();
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
