import { v4 as uuidv4 } from 'uuid';
import { sparqlEscapeString, sparqlEscapeUri } from 'mu';
import {
  APPLICATION_GRAPH,
  CHANGE_REQUESTS_GRAPH,
  REQUEST_BASE,
  ACTION_BASE,
  ERROR_BASE,
  STATUS,
  STATUS_KEYS,
  PENDING_STATUS_KEYS,
  RESERVED_STEP_TYPE_KEYS,
  KINDS,
  LISTED_KINDS,
  SERVICE_AGENT,
  TARGET_TYPE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_OPERATIONS,
  MAX_TEXT_LENGTH,
  SPARQL_MAX_ROWS,
  NS,
  statusKey,
  stepTypeKey,
} from '../constants.js';
import { HttpError, unprocessable } from './errors.js';
import { aggregateKind, aggregateNamed, aggregatesOfKind, registrableClassifications, registrationType } from './config.js';
import {
  findOrganisation,
  organisationWithIdentifier,
  resolveResources,
  reachableFromTarget,
  currentTerms,
  incomingTerms,
  describeRecords,
  uuidsOf,
  formerResources,
} from './organisations.js';
import {
  buildVersions,
  carriedPairs,
  incomingPairs,
  collectReferences,
  collectBaseReferences,
  pathPredicates,
  settleVersions,
  planStored,
  replacedStates,
  versionsFromStore,
  statesFromStore,
} from './versions.js';
import {
  storedPairs,
  storedIncomingPairs,
  storedConflicts,
  overriddenConflicts,
  missingMasters,
  linkingRecords,
  resolveLinks,
  writtenPairs,
  competingRequests,
  attachCompeting,
  competingKeys,
  relatedUris,
  renderConflict,
  renderCompeting,
  overriddenForm,
  conflictsToken,
} from './conflicts.js';
import {
  requestInsertQuery,
  applyQuery,
  stepQuery,
  statusQueries,
  markFailedQuery,
  cleanupStepQuery,
  changeRequestsQuery,
  requestPageQuery,
  requestCountQuery,
  stepsQuery,
  storedVersionsQuery,
  replacedStatesQuery,
  laterAppliedQuery,
  versionsChangingQuery,
  requestsOfVersionsQuery,
  proposedLocalIdsQuery,
  proposedIdentifiersQuery,
  identifierNamesQuery,
  existingTriplesQuery,
  leftoversQuery,
  storedStepsQuery,
  storedSubmissionQuery,
} from './queries.js';
import { operationsFromVersions, relatedRecordUris } from './operations.js';
import { rows, selectInBatches, term } from './sparql-result.js';
import { createLock } from './lock.js';
import { isSetKey } from './values.js';
import { KBO_ID_NAME, KBO_ID_NAMES, isKboIdName, normaliseKbo, kboForms, kboLockKey } from './kbo.js';
import { canEdit, canCreate, autoApprove, canDecide, canReply, canWithdraw, canReapply, supersede, evaluate } from '../policies/index.js';

const toIso = (value) => new Date(value).toISOString();
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const iri = sparqlEscapeUri;

/**
 * The steps a request can take: the statuses each one follows, the status it leads to, and
 * whether it needs a text (reason). The flow of the designs: a request is submitted (indiening,
 * ingediend) and validated. ABB asks for information (informatievraag, informatie-gevraagd), the
 * requester answers (informatieantwoord, back to ingediend); ABB rejects (afkeuring, afgekeurd),
 * the requester contests (betwisting, back to ingediend); ABB approves (goedkeuring,
 * goedgekeurd), and the service applies the versions at once (afhandeling, afgehandeld, or
 * mislukt when the apply fails). A request the service approves itself (an edit, or what ABB
 * requests) takes the goedkeuring and the afhandeling in one go. A hertoepassing applies a failed
 * request again. A request whose apply failed can also be rejected or withdrawn, so one that
 * cannot be applied any more (a record it changes was deleted since) does not stay mislukt for
 * good. afgehandeld and ingetrokken are final; afgekeurd is not, since a rejection can be
 * contested. Nothing amends a pending request: it is answered, contested or withdrawn. An edit
 * goes through none of the validation: it only takes a hertoepassing or an intrekking, after its
 * apply failed (EDIT_STEP_TYPES).
 */
const TRANSITIONS = {
  indiening: { from: [] },
  informatievraag: { from: ['ingediend'], to: 'informatie-gevraagd', text: true },
  informatieantwoord: { from: ['informatie-gevraagd'], to: 'ingediend', text: true },
  goedkeuring: { from: ['ingediend'] },
  afhandeling: { from: ['goedgekeurd'] },
  afkeuring: { from: ['ingediend', 'informatie-gevraagd', 'mislukt'], to: 'afgekeurd', text: true },
  betwisting: { from: ['afgekeurd'], to: 'ingediend', text: true },
  intrekking: { from: ['ingediend', 'informatie-gevraagd', 'mislukt'], to: 'ingetrokken' },
  hertoepassing: { from: ['mislukt'] },
};
const FINAL_STATUSES = ['afgehandeld', 'ingetrokken'];
// The steps POST /change-requests/:id/steps takes; indiening is the POST, afhandeling the service's.
const STEP_ENDPOINT_TYPES = ['goedkeuring', 'afkeuring', 'informatievraag', 'informatieantwoord', 'betwisting', 'intrekking', 'hertoepassing'];
// The steps that apply the versions of a request; they record the states they replaced.
const APPLYING_STEP_TYPES = ['afhandeling', 'hertoepassing'];
// The steps the requesting organisation takes on its own request.
const REPLY_STEP_TYPES = ['informatieantwoord', 'betwisting'];
// The steps an edit takes after its submission: it applies at once, so only a failed apply is
// handled, by applying it again or giving it up.
const EDIT_STEP_TYPES = ['hertoepassing', 'intrekking'];
// The statuses everyone sees a request in while config.pendingVisibleTo is "involved": every
// status but those of a request that still waits for a decision.
const SHOWN_TO_ALL_STATUSES = STATUS_KEYS.filter((key) => !PENDING_STATUS_KEYS.includes(key));
// The steps on a creation that claim its KBO number again: approving or re-applying it puts the
// number in the register, contesting a rejection puts the request back among the pending ones.
const KBO_CLAIMING_STEP_TYPES = ['goedkeuring', 'hertoepassing', 'betwisting'];
// The resource type of the records that mirror an organisation's KBO data (ext:KboOrganisatie):
// they repeat its KBO number and hold none of their own.
const KBO_MIRROR_TYPE = 'kbo-organizations';
const LIST_FILTERS = ['target', 'status', 'kind', 'mine', 'requester', 'target-classification', 'created'];

/** Whether a text has more than white space (zero-width characters count as white space). */
const hasText = (text) => typeof text === 'string' && /[^\s​-‍⁠﻿]/.test(text);

/**
 * The text of a step or a submission: a string of at most MAX_TEXT_LENGTH characters, or null.
 * Returns null for a text that is only white space.
 */
function parseText(value, pointer) {
  const text = value ?? null;
  if (text !== null && typeof text !== 'string') throw unprocessable('"reason" must be a string', pointer);
  if (text !== null && text.length > MAX_TEXT_LENGTH) throw unprocessable(`"reason" is at most ${MAX_TEXT_LENGTH} characters long`, pointer);
  return hasText(text) ? text : null;
}

/**
 * The API form of a step. person is the uuid of the person who took it (null for the service),
 * reason its text, error the message of its oslc:Error, overridden-conflicts the conflicts it
 * applied the request despite (derived from the states it replaced, see overriddenConflicts), as
 * the approver saw them without their competing requests. A viewer that is not the requesting
 * organisation or ABB sees neither the person, nor the texts, nor the error (viewer.seesDetails).
 */
function stepJson(step, viewer) {
  const byService = step.agent === SERVICE_AGENT;
  const overridden = step.overriddenConflicts ?? [];
  return {
    sequence: step.sequence,
    type: step.type,
    status: step.status,
    at: toIso(step.at),
    agent: byService ? 'service' : 'user',
    person: byService || !viewer.seesDetails ? null : step.personUuid ?? null,
    organisation: step.organisationUuid ?? null,
    rule: step.rule ?? null,
    reason: viewer.seesDetails ? step.reason ?? null : null,
    error: viewer.seesDetails ? step.error?.message ?? null : null,
    'overrides-conflict': overridden.length > 0,
    'overridden-conflicts': overridden,
  };
}

/**
 * The status of a request: its adms:status (statusQueries sets it after every step, adding the
 * new status before it removes the old one). A request that carries two (the second update
 * failed) takes the one of its last step; one that carries none (a status lost before the service
 * wrote statuses this way) the status of its last step.
 */
export function statusOf(record, steps = []) {
  const statuses = (record.statuses ?? (record.status ? [record.status] : [])).map(statusKey);
  const last = steps.at(-1)?.status ?? null;
  if (statuses.length === 1) return statuses[0];
  if (statuses.length > 1) return statuses.includes(last) ? last : statuses[0];
  return last;
}

// A viewer who sees nothing of the details: the default, so a caller that forgets the viewer
// shows less, not more.
const NOBODY = { personUri: null, seesDetails: false };

/**
 * The JSON:API resource object of a request record with its steps (ordered by sequence), its
 * conflicts and the keys other pending requests compete for (rendered). status is the request's
 * status (statusOf), kind the kind of its aggregate, mine whether the viewer submitted it,
 * applied-at the start of the last step with status afgehandeld, error the error message of the
 * last step (for the requesting organisation and ABB), target-name and target-classification what
 * the listing shows of the organisation (from the application data, or from the proposed version
 * of a creation whose organisation is not registered), conflicts-token the token that overrides
 * exactly these conflicts in a goedkeuring, replaced-by the uuid of the newer request that
 * replaced this one (dct:isReplacedBy, see supersedeOlder), operations the submitted operations
 * rebuilt from the stored versions (the detail only). The target of a creation whose organisation
 * is not registered carries meta: { registered: false, pending }, pending while the request still
 * waits.
 */
export function serialise(record, { steps = [], conflicts = [], competing = [], lids, superseded, operations, viewer = NOBODY } = {}) {
  const last = steps.at(-1);
  const applied = steps.filter((step) => step.status === 'afgehandeld').at(-1);
  const status = statusOf(record, steps);
  const attributes = {
    status,
    kind: record.kind ?? null,
    created: toIso(record.created),
    'applied-at': applied ? toIso(applied.at) : null,
    aggregate: record.aggregate,
    mine: Boolean(viewer.personUri) && record.creatorUri === viewer.personUri,
    'target-name': record.targetName ?? null,
    'target-classification': record.targetClassificationUuid ?? null,
    error: viewer.seesDetails ? last?.error?.message ?? null : null,
    steps: steps.map((step) => stepJson(step, viewer)),
    conflicts,
    'conflicts-token': conflictsToken(conflicts),
    competing,
    'replaced-by': record.replacedByUuid ?? null,
  };
  if (lids) attributes.lids = lids;
  // On the answer of an apply: the older pending requests it replaced (see supersedeOlder).
  if (superseded) attributes.superseded = superseded;
  if (operations) attributes.operations = operations;
  const target = { data: { type: TARGET_TYPE, id: record.targetUuid } };
  if (record.registered === false) target.meta = { registered: false, pending: PENDING_STATUS_KEYS.includes(status) };
  return {
    type: 'change-requests',
    id: record.uuid,
    attributes,
    relationships: {
      target,
      'requesting-organisation': { data: { type: TARGET_TYPE, id: record.actorUuid ?? null } },
    },
  };
}

/**
 * The body of POST /change-requests: the aggregate, the operations, the target (the organisation
 * the request is about; absent for a creation, whose organisation does not exist yet) and an
 * optional reason, the submitter's text, kept on the indiening step.
 */
function parseBody(body) {
  const data = body?.data;
  if (!isObject(data)) throw unprocessable('the body must be a JSON:API document with "data"', '/data');
  if (data.type !== 'change-requests') throw unprocessable('"type" must be "change-requests"', '/data/type');
  const attributes = data.attributes ?? {};
  if (!isObject(attributes)) throw unprocessable('"attributes" must be an object', '/data/attributes');
  if (typeof attributes.aggregate !== 'string') throw unprocessable('"aggregate" is required', '/data/attributes/aggregate');
  const operations = attributes.operations;
  if (!Array.isArray(operations) || operations.length === 0) throw unprocessable('"operations" must be a non-empty array', '/data/attributes/operations');
  if (operations.length > MAX_OPERATIONS) {
    throw unprocessable(`a request carries at most ${MAX_OPERATIONS} operations, this one ${operations.length}`, '/data/attributes/operations');
  }
  const target = data.relationships?.target?.data ?? null;
  if (target !== null && (!isObject(target) || typeof target.type !== 'string' || typeof target.id !== 'string')) {
    throw unprocessable('the "target" relationship must identify an organisation by type and id', '/data/relationships/target');
  }
  const reason = parseText(attributes.reason, '/data/attributes/reason');
  return { aggregateName: attributes.aggregate, operations, target, reason };
}

/**
 * The body of POST /change-requests/:id/steps: { stepType, reason, override }. reason is the text
 * of the step: the question of an informatievraag, the answer of an informatieantwoord, the reason
 * of an afkeuring or a betwisting (required on those), a comment on the others. override is the
 * conflicts-token of the conflicts the approver reviewed (null for none): a goedkeuring overrides
 * those conflicts and no others.
 */
export function parseStepBody(body) {
  const data = body?.data;
  if (!isObject(data)) throw unprocessable('the body must be a JSON:API document with "data"', '/data');
  if (data.type !== 'change-request-steps') throw unprocessable('"type" must be "change-request-steps"', '/data/type');
  const attributes = data.attributes ?? {};
  if (!isObject(attributes)) throw unprocessable('"attributes" must be an object', '/data/attributes');
  const stepType = attributes['step-type'];
  if (RESERVED_STEP_TYPE_KEYS.includes(stepType)) {
    throw unprocessable(`the step type "${stepType}" is reserved and not implemented`, '/data/attributes/step-type');
  }
  if (!STEP_ENDPOINT_TYPES.includes(stepType)) {
    throw unprocessable(`unknown step type ${JSON.stringify(stepType ?? null)}; one of ${STEP_ENDPOINT_TYPES.join(', ')}`, '/data/attributes/step-type');
  }
  const reason = parseText(attributes.reason, '/data/attributes/reason');
  if (TRANSITIONS[stepType].text && !reason) throw unprocessable(`${/^[aeiou]/.test(stepType) ? 'an' : 'a'} ${stepType} needs a reason`, '/data/attributes/reason');
  const override = attributes.override ?? null;
  if (override !== null && override !== false && (typeof override !== 'string' || !override)) {
    throw unprocessable(
      '"override" must be the "conflicts-token" of the conflicts you reviewed (GET /change-requests/:id, or the 409 of a goedkeuring), so the approval overrides those and no others',
      '/data/attributes/override',
    );
  }
  return { stepType, reason, override: typeof override === 'string' ? override : null };
}

const SORTS = ['created', '-created'];

/**
 * The query parameters of GET /change-requests: filter[target] (an organisation uuid, or the uuid
 * a waiting creation minted for the organisation it would register), filter[status] (status keys,
 * comma-separated), filter[kind] (edit, creation, change-event, comma-separated; without it the
 * list holds creations and change events, LISTED_KINDS: edits are the history only),
 * filter[mine]=true (the requests the session's person submitted), filter[requester] (the uuid of
 * the organisation that submitted them), filter[target-classification] (the uuid of a
 * classification concept), filter[created][gte] and filter[created][lte] (ISO 8601, inclusive),
 * sort (created, the default: oldest first, or -created), page[number] (from 0) and page[size] (1
 * to MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE when absent); a page must end within the triplestore's row
 * limit (SPARQL_MAX_ROWS). A malformed value or an unknown filter is a 400.
 */
export function parseListQuery(query = {}) {
  const invalid = (detail) => new HttpError(400, 'Invalid query parameter', { detail });
  const filter = isObject(query.filter) ? query.filter : {};
  for (const name of Object.keys(filter)) {
    if (!LIST_FILTERS.includes(name)) throw invalid(`unknown filter[${name}]; the filters are ${LIST_FILTERS.join(', ')}`);
  }
  const uuidFilter = (name, what) => {
    const value = filter[name];
    if (value !== undefined && (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value))) throw invalid(`filter[${name}] must be the uuid of ${what}`);
    return value;
  };
  const target = uuidFilter('target', 'an organisation');
  const requester = uuidFilter('requester', 'an organisation');
  const targetClassification = uuidFilter('target-classification', 'a classification');
  const listFilter = (name, known) => {
    if (filter[name] === undefined) return [];
    if (typeof filter[name] !== 'string') throw invalid(`filter[${name}] must be one or more of ${known.join(', ')}, comma-separated`);
    const values = [...new Set(filter[name].split(',').map((value) => value.trim()).filter(Boolean))];
    const unknown = values.filter((value) => !known.includes(value));
    if (unknown.length || !values.length) throw invalid(`filter[${name}]: unknown value ${JSON.stringify(unknown[0] ?? filter[name])}; one of ${known.join(', ')}`);
    return values;
  };
  const statuses = listFilter('status', STATUS_KEYS);
  const kinds = listFilter('kind', KINDS);
  let mine = false;
  if (filter.mine !== undefined) {
    if (filter.mine !== 'true' && filter.mine !== 'false') throw invalid('filter[mine] must be true or false');
    mine = filter.mine === 'true';
  }
  const created = { from: undefined, until: undefined };
  if (filter.created !== undefined) {
    if (!isObject(filter.created)) throw invalid('filter[created] takes [gte] and [lte] as ISO 8601 date-times');
    for (const bound of Object.keys(filter.created)) {
      if (bound !== 'gte' && bound !== 'lte') throw invalid(`unknown filter[created][${bound}]; use [gte] and [lte]`);
    }
    for (const [bound, key] of [['gte', 'from'], ['lte', 'until']]) {
      const value = filter.created[bound];
      if (value === undefined) continue;
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw invalid(`filter[created][${bound}] must be an ISO 8601 date-time`);
      created[key] = new Date(value).toISOString();
    }
  }
  const sort = query.sort ?? 'created';
  if (!SORTS.includes(sort)) throw invalid(`sort must be one of ${SORTS.join(', ')}`);
  const page = isObject(query.page) ? query.page : {};
  const whole = (value, name, min, max, fallback) => {
    if (value === undefined) return fallback;
    const number = typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isInteger(number) || number < min || number > max) throw invalid(`page[${name}] must be a whole number from ${min} to ${max}`);
    return number;
  };
  const size = whole(page.size, 'size', 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  const number = whole(page.number, 'number', 0, Math.floor(SPARQL_MAX_ROWS / size) - 1, 0);
  return { target, statuses, kinds, mine, requester, targetClassification, created, sort, page: { number, size } };
}

/** The JSON:API pagination links of a listing (first, last, and prev and next where they exist). */
export function pageLinks({ target, statuses = [], kinds = [], mine = false, requester, targetClassification, created = {}, sort = 'created', page }, count) {
  const link = (number) => {
    const params = new URLSearchParams();
    if (target !== undefined) params.set('filter[target]', target);
    if (statuses.length) params.set('filter[status]', statuses.join(','));
    if (kinds.length) params.set('filter[kind]', kinds.join(','));
    if (mine) params.set('filter[mine]', 'true');
    if (requester !== undefined) params.set('filter[requester]', requester);
    if (targetClassification !== undefined) params.set('filter[target-classification]', targetClassification);
    if (created.from) params.set('filter[created][gte]', created.from);
    if (created.until) params.set('filter[created][lte]', created.until);
    if (sort !== 'created') params.set('sort', sort);
    params.set('page[number]', String(number));
    params.set('page[size]', String(page.size));
    return `/change-requests?${params}`;
  };
  // The last page the triplestore can serve (parseListQuery refuses the ones after it).
  const last = Math.min(Math.max(0, Math.ceil(count / page.size) - 1), Math.floor(SPARQL_MAX_ROWS / page.size) - 1);
  const links = { first: link(0), last: link(last) };
  if (page.number > 0) links.prev = link(Math.min(page.number - 1, last));
  if (page.number < last) links.next = link(page.number + 1);
  return links;
}

const stepFromRow = (row) => ({
  uri: row.step,
  uuid: row.stepUuid,
  sequence: Number(row.sequence),
  type: stepTypeKey(row.type),
  status: statusKey(row.status),
  at: row.at,
  agent: row.agent,
  personUuid: row.agentUuid ?? null,
  organisation: row.organisation ?? null,
  organisationUuid: row.organisationUuid ?? null,
  rule: row.rule ?? null,
  reason: row.reason ?? null,
  error: row.error ? { message: row.error } : null,
});

/** The rows of stepsQuery as Map request URI -> steps ordered by sequence. */
function stepsByRequest(result) {
  const byRequest = new Map();
  const seen = new Set();
  for (const row of rows(result)) {
    if (seen.has(row.step)) continue;
    seen.add(row.step);
    if (!byRequest.has(row.request)) byRequest.set(row.request, []);
    byRequest.get(row.request).push(stepFromRow(row));
  }
  for (const steps of byRequest.values()) steps.sort((a, b) => a.sequence - b.sequence);
  return byRequest;
}

function transitionError(uuid, status, stepType) {
  let detail;
  if (stepType === 'indiening') detail = `Change request "${uuid}" has status ${status}; an indiening is only the first step of a request (POST /change-requests)`;
  else if (FINAL_STATUSES.includes(status)) detail = `Change request "${uuid}" has status ${status}, which is final; no ${stepType} can follow`;
  else detail = `Change request "${uuid}" has status ${status}; a ${stepType} follows ${TRANSITIONS[stepType].from.join(' or ')} only`;
  return new HttpError(409, 'The change request cannot take this step', { detail, meta: { status, 'step-type': stepType } });
}

/**
 * The 409 for a request that changes records deleted since it was submitted: applying it would
 * write values on records without a type, which sparql-parser refuses, so neither a goedkeuring
 * (also with override) nor a hertoepassing can apply it.
 */
function missingRecordsError(uuid, missing, stepType) {
  const records = missing.map((version) => ({ type: version.type, id: version.masterUuid }));
  const listed = records.map(({ type, id }) => `${type} "${id}"`).join(', ');
  return new HttpError(409, 'The change request changes records that no longer exist', {
    detail: `Change request "${uuid}" changes ${listed}, deleted since it was submitted; a ${stepType} cannot apply it. Reject it (afkeuring) or withdraw it (intrekking), and submit the change again if it is still needed`,
    meta: { 'missing-records': records },
  });
}

/**
 * The 409 for an edit that conflicts with what changed since its form was loaded: an edit is
 * applied at once or not at all, nothing waits for ABB, so the user reloads the form and saves
 * again. The conflicts and the keys other pending requests compete for are in the meta.
 */
function conflictingEditError(conflicts, competing) {
  const count = `${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}`;
  return new HttpError(409, 'The change conflicts with changes made since the form was loaded', {
    detail: `${count} with what changed since the form was loaded; nothing was saved. Reload the form and save the change again`,
    meta: { conflicts, 'conflicts-token': conflictsToken(conflicts), competing },
  });
}

/**
 * The service behind the endpoints. db is { query, update } (the template's, forwarding the
 * session and the scope); mintUuid and clock are injectable for tests, and so is verifyWrites:
 * whether an apply is read back before the request is marked applied (verifyApplied), which a
 * stand-in for the triplestore that does not keep the data cannot answer.
 */
export function createService({
  model,
  config,
  db,
  graphs = { application: APPLICATION_GRAPH, changeRequests: CHANGE_REQUESTS_GRAPH },
  mintUuid = uuidv4,
  clock = () => new Date(),
  verifyWrites = true,
}) {
  // Per target organisation: reading the current values, the conflict check, the writes and the
  // apply of one request or step happen before those of the next (see lock.js). Requests that
  // propose or claim a KBO number also take a lock per number, always after the target's and in
  // the order of the numbers, so two of them never wait for each other.
  const withLock = createLock();
  const withLocks = (keys, task) => [...new Set(keys)].sort().reduceRight((next, key) => () => withLock(key, next), task)();
  const isAbb = (session) => session.actor.uri === config.abbUri;
  const kindOf = (aggregateName) => aggregateKind(aggregateNamed(config, aggregateName));
  const creationAggregates = aggregatesOfKind(config, 'creation');

  // The predicates that lead from a target to the records of its aggregate, per aggregate.
  const paths = Object.fromEntries(
    Object.entries(config.aggregates).map(([name, aggregate]) => [name, pathPredicates(model, aggregate)]),
  );
  // What the listing shows of an organisation, and how an identifier hangs off one, in the model's terms.
  const predicateOf = (type, name, kind) => {
    const definition = kind === 'attribute' ? model.attribute(type, name) : model.relationship(type, name);
    if (!definition) throw new Error(`The resources model has no ${kind} "${name}" on ${type}, which the change-request service needs`);
    return definition.predicate;
  };
  const organisationPredicates = {
    name: predicateOf(TARGET_TYPE, 'name', 'attribute'),
    classification: predicateOf(TARGET_TYPE, 'classification', 'relationship'),
  };
  // The classes an organisation record carries (the organisation types and their subtypes), and
  // those of the records that only mirror one (KBO data).
  const organisationClasses = model.classesOf(TARGET_TYPE);
  const mirrorClasses = model.has(KBO_MIRROR_TYPE) ? model.classesOf(KBO_MIRROR_TYPE) : [];
  const identifierPredicates = {
    identifiers: predicateOf(TARGET_TYPE, 'identifiers', 'relationship'),
    idName: predicateOf('identifiers', 'id-name', 'attribute'),
    structuredIdentifier: predicateOf('identifiers', 'structured-identifier', 'relationship'),
    localId: predicateOf('structured-identifiers', 'local-id', 'attribute'),
  };
  const identifierClass = model.get('identifiers').class;
  // How a change event names the organisations it is about, and its type.
  const eventPredicates = model.has('change-events')
    ? {
        type: predicateOf('change-events', 'type', 'relationship'),
        organisations: [predicateOf('change-events', 'original-organizations', 'relationship'), predicateOf('change-events', 'resulting-organizations', 'relationship')],
      }
    : null;

  const policyContext = (session, target, extra = {}) => ({
    session: session.session,
    account: session.account,
    actor: session.actor,
    target,
    config,
    ...extra,
  });

  const forbidden = (outcome, title = 'Not allowed to edit this organisation') =>
    new HttpError(403, title, {
      detail: outcome.rule ? `Denied by rule ${outcome.rule}` : 'No rule allows it',
      meta: { rule: outcome.rule, rules: outcome.rule ? [outcome.rule] : [] },
    });

  const requireTarget = async (uuid) => {
    const target = await findOrganisation(db, uuid, model);
    if (!target) throw new HttpError(404, 'Target organisation not found', { detail: `No organisation with id "${uuid}"` });
    return target;
  };

  /**
   * The target of a stored request: the organisation it is about, or, when that organisation is
   * not in the register (a creation that is not applied yet, or an organisation removed since),
   * what the request knows of it, so the request can still be read, decided and closed. A
   * creation's classification is the one it proposes.
   */
  const resolveTarget = async (record) => {
    const found = await findOrganisation(db, record.targetUuid, model);
    if (found) return found;
    const classification = record.kind === 'creation' && record.targetClassificationUuid
      ? ((await resolveResources(db, [record.targetClassificationUuid])).get(record.targetClassificationUuid)?.uri ?? null)
      : null;
    return { uri: record.targetUri, uuid: record.targetUuid, classification, classes: [], pending: true };
  };

  /**
   * Who sees a request: ABB and, while config.pendingVisibleTo is "everyone", everyone sees all;
   * otherwise an organisation sees the requests about it, those it submitted and the decided ones
   * (the filter of requestFilters in queries.js). What a viewer sees of a request: the requesting
   * organisation and ABB see the persons, the texts and the errors of the steps (stepJson).
   */
  const visibilityOf = (session) =>
    isAbb(session) || config.pendingVisibleTo === 'everyone' ? null : { organisation: session.actor.uri, statuses: SHOWN_TO_ALL_STATUSES };
  const viewerOf = (session, record) => ({ personUri: session.person, seesDetails: isAbb(session) || record.actorUri === session.actor.uri });

  const newStep = (fields) => {
    const uuid = mintUuid();
    return { uri: ACTION_BASE + uuid, uuid, ...fields };
  };
  // A step a person takes: the session's person and organisation.
  const personStep = (session, fields) =>
    newStep({
      agent: session.person,
      personUuid: session.personUuid ?? null,
      organisation: session.actor.uri,
      organisationUuid: session.actor.uuid,
      ...fields,
    });
  // A step the service takes by itself.
  const serviceStep = (fields) => newStep({ agent: SERVICE_AGENT, ...fields });
  // The oslc:Error of a failed apply.
  const newError = (message) => {
    const uuid = mintUuid();
    return { uri: ERROR_BASE + uuid, uuid, message, at: clock() };
  };

  /**
   * Sets the status of a request: the new one is added, then the others removed (statusQueries).
   * Adding is tried twice (an INSERT DATA, so a second try writes nothing twice) and throws when
   * both fail; a failure to remove the old one is logged only, since statusOf reads the right one
   * from the steps.
   */
  async function setStatus(request, status) {
    const [add, removeOthers] = statusQueries({ request, status, graph: graphs.changeRequests });
    try {
      await db.update(add);
    } catch (error) {
      console.warn(`Setting the status of ${request.uri} failed, trying once more:`, error?.message || error);
      await db.update(add);
    }
    try {
      await db.update(removeOthers);
    } catch (error) {
      console.error(`Removing the previous status of ${request.uri} failed; it carries two until the next step:`, error);
    }
  }

  /**
   * The classifications the session may request a new organisation of: every classification the
   * service registers when a rule lets it request any (ABB, abbEditsAll), else the ones
   * config.creatableClassifications lists for the classification of its organisation.
   */
  async function creatableClassifications(session) {
    const any = await evaluate(canCreate, policyContext(session, { uri: null, uuid: null, classification: null, classes: [], pending: true }, { kind: 'creation' }));
    if (any.decision === 'allow') return registrableClassifications(config);
    return config.creatableClassifications[session.actor.classification] ?? [];
  }

  /**
   * GET /change-requests/permissions: with a target, the rights on that organisation (can-edit:
   * edits and change events, the canEdit rules; can-decide; the rule that decided); without one,
   * the rights of the session (can-create: the classifications it may request; can-decide).
   */
  async function permissions(session, targetUuid) {
    const decides = await evaluate(canDecide, policyContext(session, null));
    if (targetUuid === undefined) {
      return { 'can-create': await creatableClassifications(session), 'can-decide': decides.decision === 'allow' };
    }
    const target = await requireTarget(targetUuid);
    const outcome = await evaluate(canEdit, policyContext(session, target, { kind: 'edit' }));
    return {
      'can-edit': outcome.decision === 'allow',
      'can-submit-change-event': outcome.decision === 'allow',
      'can-decide': decides.decision === 'allow',
      rules: outcome.rule ? [outcome.rule] : [],
    };
  }

  /** The stored versions of requests, queried in batches of requests. */
  async function storedVersions(requestUris) {
    if (!requestUris.length) return [];
    return versionsFromStore(await selectInBatches(db, requestUris, (batch) => storedVersionsQuery({ requestUris: batch }), { size: 20 }), model);
  }

  /**
   * The requests whose indiening generated the given versions: Map request URI -> { uri, uuid,
   * statuses, aggregate, actorUri }.
   */
  async function requestsOfVersions(versionUris) {
    const requests = new Map();
    if (!versionUris.length) return requests;
    const found = rows(await selectInBatches(db, versionUris, (batch) => requestsOfVersionsQuery({ versionUris: batch }), { size: 100 }));
    for (const row of found) {
      const request = requests.get(row.request) ?? { uri: row.request, uuid: row.uuid, statuses: [], aggregate: row.aggregate, actorUri: row.requestingOrganisation };
      if (!request.statuses.includes(row.status)) request.statuses.push(row.status);
      requests.set(row.request, request);
    }
    return requests;
  }

  const isPending = (request) => request.statuses.some((status) => PENDING_STATUS_KEYS.includes(statusKey(status)));

  /**
   * The pending requests (ingediend, informatie-gevraagd) whose versions write one of the given
   * (master, predicate) pairs: Map request URI -> uuid. Two anchored lookups (see queries.js).
   */
  async function pendingWriting(pairs) {
    if (!pairs.length) return new Map();
    const versions = rows(await selectInBatches(db, pairs, (batch) => versionsChangingQuery({ pairs: batch }), { size: 200 })).map((row) => row.version);
    const requests = await requestsOfVersions([...new Set(versions)]);
    return new Map([...requests.values()].filter(isPending).map((request) => [request.uri, request.uuid]));
  }

  /**
   * The competing requests of every key the versions write (competingRequests in conflicts.js):
   * the pending requests that write one of those keys are looked up, and their stored versions
   * compared. Versions of a pending request among the given ones are not read again. requestUri
   * is the request of versions that are not stored yet (a submission).
   */
  async function competingFor(versions, requestUri = null) {
    const pairs = writtenPairs(versions);
    if (!pairs.length) return new Map();
    const uuids = await pendingWriting(pairs);
    const given = new Set(versions.map((version) => version.requestUri).filter(Boolean));
    const known = versions.filter((version) => uuids.has(version.requestUri));
    const others = [...known, ...(await storedVersions([...uuids.keys()].filter((uri) => !given.has(uri))))];
    return competingRequests(versions, others, uuids, requestUri);
  }

  /**
   * The conflicts of versions, ready to render: link conflicts resolved to the records that link,
   * competing requests attached, and the keys of the versions other pending requests compete for.
   * Returns { conflicts, keys, uuids }, uuids holding the uuids of every related record they
   * show (known ones plus one lookup for the rest).
   */
  async function review(versions, found, { requestUri = null, known = new Map() } = {}) {
    const linking = linkingRecords(found);
    const conflicts = resolveLinks(found, linking.length ? await describeRecords(db, linking) : new Map(), model);
    const competing = await competingFor(versions, requestUri);
    attachCompeting(conflicts, competing);
    const keys = competingKeys(versions, competing);
    const masters = new Map([...versions.map((version) => [version.masterUri, version.masterUuid]), ...known]);
    const missing = relatedUris([...conflicts, ...keys]).filter((uri) => !masters.has(uri));
    const uuids = missing.length ? new Map([...masters, ...(await uuidsOf(db, missing))]) : masters;
    return { conflicts, keys, uuids };
  }

  /** The live conflicts and competing keys of pending requests, rendered: Map request URI -> { conflicts, competing }. */
  async function liveState(requestUris) {
    const state = new Map(requestUris.map((uri) => [uri, { conflicts: [], competing: [] }]));
    if (!requestUris.length) return state;
    const versions = await storedVersions(requestUris);
    const current = await currentTerms(db, storedPairs(versions));
    const incoming = await incomingTerms(db, storedIncomingPairs(versions, model));
    const { conflicts, keys, uuids } = await review(versions, storedConflicts({ versions, current, incoming, model }));
    for (const conflict of conflicts) state.get(conflict.version.requestUri)?.conflicts.push(renderConflict(conflict, uuids));
    for (const key of keys) state.get(key.version.requestUri)?.competing.push(renderCompeting(key, uuids));
    return state;
  }

  /**
   * The conflicts the applying steps (afhandeling, hertoepassing) of requests overrode, rendered
   * without their competing requests: derived from the stored versions and the states each step
   * replaced (overriddenConflicts in conflicts.js). Sets overriddenConflicts on those steps.
   * stepsOf: Map request URI -> steps.
   */
  async function attachOverridden(stepsOf) {
    const applying = [...stepsOf].filter(([, steps]) => steps.some((step) => APPLYING_STEP_TYPES.includes(step.type))).map(([uri]) => uri);
    if (!applying.length) return;
    const [versions, statesResult] = await Promise.all([
      storedVersions(applying),
      selectInBatches(db, applying, (batch) => replacedStatesQuery({ requestUris: batch }), { size: 20 }),
    ]);
    const statesOf = statesFromStore(statesResult);
    const found = [];
    for (const uri of applying) {
      const requestVersions = versions.filter((version) => version.requestUri === uri);
      for (const step of stepsOf.get(uri)) {
        if (!APPLYING_STEP_TYPES.includes(step.type)) continue;
        const states = statesOf.get(step.uri) || [];
        found.push({ step, conflicts: states.length ? overriddenConflicts({ versions: requestVersions, states, model }) : [] });
      }
    }
    const all = found.flatMap(({ conflicts }) => conflicts);
    if (!all.length) return;
    const linking = linkingRecords(all);
    const records = linking.length ? await describeRecords(db, linking) : new Map();
    const resolved = found.map(({ step, conflicts }) => ({ step, conflicts: resolveLinks(conflicts, records, model) }));
    const masters = new Map(versions.map((version) => [version.masterUri, version.masterUuid]));
    const missing = relatedUris(resolved.flatMap(({ conflicts }) => conflicts)).filter((uri) => !masters.has(uri));
    const uuids = missing.length ? new Map([...masters, ...(await uuidsOf(db, missing))]) : masters;
    for (const { step, conflicts } of resolved) step.overriddenConflicts = conflicts.map((conflict) => overriddenForm(renderConflict(conflict, uuids)));
  }

  /**
   * The operations of a request, rebuilt from its stored versions, with the related records as
   * uuids: per record the keys the request changes (an update that was submitted with keys it did
   * not change carries only the changed ones). The versions keep no order, so the operations come
   * in a fixed one: the document of the aggregate's root type first (the organisation of a
   * creation, the change event of a change-event request), then the others by type and uuid.
   */
  async function operationsOf(record) {
    const versions = await storedVersions([record.uri]);
    const root = aggregateNamed(config, record.aggregate)?.root;
    const rank = (version) => (root && model.has(version.type) && model.isSubtypeOf(version.type, root) ? 0 : 1);
    const ordered = [...versions].sort((a, b) => rank(a) - rank(b) || a.type.localeCompare(b.type) || a.masterUuid.localeCompare(b.masterUuid));
    const related = relatedRecordUris(ordered, model);
    const uuids = new Map(ordered.map((version) => [version.masterUri, version.masterUuid]));
    const missing = related.filter((uri) => !uuids.has(uri));
    if (missing.length) for (const [uri, uuid] of await uuidsOf(db, missing)) uuids.set(uri, uuid);
    return operationsFromVersions(ordered, model, uuids);
  }

  /**
   * Reads back what an apply wrote and returns what is missing, as messages (none when the apply
   * is complete): sparql-parser sends an update in several requests and does not always report a
   * request that failed. Checked: the triples the versions insert are there (a create's class,
   * uuid and values, an update's new values, the target's audit stamps); a key an update replaces
   * holds no other value; the values a set key removes are gone; a deleted record has no triples
   * and no links left; the steps and the replaced states are recorded.
   */
  async function verifyApplied({ request, versions, steps, states }) {
    const problems = [];
    const inserted = new Map();
    const valueCounts = new Map();
    const removed = [];
    const deleted = [];
    const add = (subject, predicate, object) => inserted.set(`${subject} ${predicate} ${object}`, { subject: iri(subject), predicate: iri(predicate), object });
    for (const version of versions) {
      if (version.operation === 'delete') {
        deleted.push(version);
        continue;
      }
      const plan = version.apply ?? { replace: version.replaces, remove: [], insert: version.triples };
      if (version.operation === 'create') {
        for (const rdfClass of version.classUris) add(version.masterUri, `${NS.rdf}type`, iri(rdfClass));
        add(version.masterUri, `${NS.mu}uuid`, sparqlEscapeString(version.masterUuid));
      }
      for (const triple of plan.insert) add(version.masterUri, triple.predicate, triple.object);
      for (const predicate of plan.replace) {
        const objects = new Set(plan.insert.filter((triple) => triple.predicate === predicate).map((triple) => triple.object));
        valueCounts.set(`${version.masterUri} ${predicate}`, { subject: version.masterUri, predicate, expected: objects.size });
      }
      for (const triple of plan.remove) removed.push({ subject: iri(version.masterUri), predicate: iri(triple.predicate), object: triple.object });
    }
    if (versions.length) {
      for (const predicate of [`${NS.dct}modified`, `${NS.ext}lastModifiedBy`]) valueCounts.set(`${request.targetUri} ${predicate}`, { subject: request.targetUri, predicate, expected: 1 });
      add(request.targetUri, `${NS.ext}lastModifiedBy`, iri(request.creatorUri));
    }
    for (const state of states) add(state.uri, `${NS.rdf}type`, iri(`${NS.cr}RecordState`));

    const expected = [...inserted.values()];
    if (expected.length) {
      const found = rows(await selectInBatches(db, expected, (batch) => existingTriplesQuery({ triples: batch }), { size: 100 })).length;
      if (found < expected.length) problems.push(`${expected.length - found} of the ${expected.length} triples the apply inserts are missing`);
    }
    if (valueCounts.size) {
      // what the replaced fields hold now, counted per field (a value stored twice counts once)
      const now = await currentTerms(db, [...valueCounts.values()]);
      for (const [pair, { expected: count }] of valueCounts) {
        const held = new Set((now.get(pair) || []).map(term)).size;
        if (held !== count) problems.push(`${pair} holds ${held} values instead of ${count}`);
      }
    }
    if (removed.length) {
      const left = rows(await selectInBatches(db, removed, (batch) => existingTriplesQuery({ triples: batch }), { size: 100 })).length;
      if (left) problems.push(`${left} of the values the apply removes are still there`);
    }
    if (deleted.length) {
      const incoming = [...new Set(deleted.flatMap((version) => model.incomingPredicates(version.type)))];
      const left = rows(await db.query(leftoversQuery({ uris: deleted.map((version) => version.masterUri), incoming })));
      for (const row of left) problems.push(`the deleted record ${row.record} still has triples or links`);
    }
    const found = Number(rows(await db.query(storedStepsQuery({ steps })))[0]?.n ?? 0);
    if (found < steps.length) problems.push(`${steps.length - found} of the ${steps.length} steps of the apply are not recorded`);
    return problems;
  }

  /**
   * Applies the versions to the application graph with the step that applies them (an
   * afhandeling, with the goedkeuring it follows, or a hertoepassing) and the states it replaces
   * (replacedStates), reads back what it wrote (verifyApplied), and only then sets the request's
   * status. The update is idempotent, so an attempt that fails or leaves something out is run
   * once more right away. When that fails too, the failure is recorded: the goedkeuring, the step
   * with status mislukt and an oslc:Error, the request mislukt, and the caller gets a 409. When
   * even that record cannot be written, the outcome is unknown and the caller gets a 500 that
   * says so. A hertoepassing applies the stored versions again.
   */
  async function applyOrFail(request, versions, step, states = [], decision = null) {
    const query = applyQuery({ request, step, decision, versions, states, model, graphs });
    const steps = [...(decision ? [decision] : []), step];
    let problems = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await db.update(query);
        problems = verifyWrites ? await verifyApplied({ request, versions, steps, states }) : [];
      } catch (error) {
        problems = [error?.message || String(error)];
      }
      if (!problems.length) break;
      console.warn(`Applying change request ${request.uri} failed (attempt ${attempt}):`, problems.join('; '));
    }
    if (!problems.length) {
      try {
        await setStatus(request, step.status);
      } catch (error) {
        console.error(`Change request ${request.uri} is applied, but its status could not be recorded:`, error);
        throw new HttpError(500, 'The change request is applied, but its status could not be recorded', {
          detail: `Change request "${request.uuid}" is applied; reload before changing the same data again.`,
          meta: { 'change-request': { id: request.uuid } },
        });
      }
      return;
    }

    const message = problems.join('; ');
    console.error(`Applying change request ${request.uri} failed:`, message);
    // The failure is recorded under a step of its own; whatever the attempts wrote of the step is removed.
    const failedUuid = mintUuid();
    const failed = { ...step, uri: ACTION_BASE + failedUuid, uuid: failedUuid, error: newError(message) };
    let recorded = false;
    try {
      await db.update(markFailedQuery({ request, step: failed, decision, states, graph: graphs.changeRequests }));
      await setStatus(request, 'mislukt');
      recorded = true;
    } catch (markError) {
      console.error(`Recording the failure on ${request.uri} failed too:`, markError);
    }
    try {
      await db.update(cleanupStepQuery({ stepUri: step.uri, graph: graphs.changeRequests }));
    } catch (cleanupError) {
      console.error(`Removing the interrupted step ${step.uri} of ${request.uri} failed:`, cleanupError);
    }
    if (!recorded) {
      throw new HttpError(500, 'Applying the change request failed, and the failure could not be recorded', {
        detail: `${message}. Change request "${request.uuid}" may be partly applied; reload before changing the same data again.`,
        meta: { 'change-request': { id: request.uuid } },
      });
    }
    throw new HttpError(409, 'Applying the change request failed', {
      detail: `${message}. The request is kept with status mislukt; a hertoepassing (POST /change-requests/${request.uuid}/steps) applies its stored versions again.`,
      meta: { 'change-request': { id: request.uuid, status: 'mislukt' } },
    });
  }

  /**
   * Writes a submission (requestInsertQuery) and reads it back (unless verifyWrites is off): the
   * request with its status and every version. sparql-parser sends a large INSERT DATA in several
   * requests, so a submission can be cut short without an error; it is written once more, and a
   * submission that is still incomplete is withdrawn by the service and answered with a 500, so no
   * incomplete request waits for a decision.
   */
  async function storeSubmission(request, submission, versions) {
    const query = requestInsertQuery({ request, step: submission, versions, graph: graphs.changeRequests });
    const complete = async () => {
      const found = rows(await db.query(storedSubmissionQuery({ request, step: submission })));
      return found.some((row) => row.status === STATUS.ingediend && Number(row.versions) === versions.length);
    };
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await db.update(query);
        if (!verifyWrites || (await complete())) return;
      } catch (error) {
        console.warn(`Storing change request ${request.uri} failed (attempt ${attempt}):`, error?.message || error);
      }
    }
    try {
      const step = serviceStep({ type: 'intrekking', status: 'ingetrokken', sequence: 2, at: clock(), reason: 'Onvolledig opgeslagen' });
      await db.update(stepQuery({ request, step, graphs }));
      await setStatus(request, 'ingetrokken');
    } catch (error) {
      console.error(`Withdrawing the incomplete change request ${request.uri} failed:`, error);
    }
    throw new HttpError(500, 'The change request could not be stored', {
      detail: `Change request "${request.uuid}" was not stored completely and is withdrawn; nothing was changed. Submit it again.`,
      meta: { 'change-request': { id: request.uuid, status: 'ingetrokken' } },
    });
  }

  /**
   * After a request was applied: withdraws the older pending requests it replaces, as the
   * supersede rules decide (policies/index.js), with an intrekking the service takes and a reason
   * that names the applied request. A candidate is a pending request about the same organisation,
   * submitted before the applied one, that writes one of the keys the applied request wrote; so
   * approving an old request never withdraws a newer one. It is fully covered when every version
   * is an update of single-valued keys only and the applied request wrote each of those keys.
   * Requests about another organisation are left alone: this runs under the lock of the applied
   * request's target, which the caller holds. The withdrawn request records the applied one as
   * dct:isReplacedBy. A failure here does not undo the apply: it is logged and the candidate keeps
   * waiting. Returns the uuids of the withdrawn requests.
   */
  async function supersedeOlder(applied, appliedVersions) {
    const withdrawn = [];
    try {
      const pairs = writtenPairs(appliedVersions);
      if (!pairs.length) return withdrawn;
      const candidateUris = [...(await pendingWriting(pairs)).keys()].filter((uri) => uri !== applied.uri);
      if (!candidateUris.length) return withdrawn;
      const [recordResult, stepResult, candidateVersions] = await Promise.all([
        db.query(changeRequestsQuery({ requestUris: candidateUris, predicates: organisationPredicates })),
        selectInBatches(db, candidateUris, (batch) => stepsQuery({ requestUris: batch }), { size: 25 }),
        storedVersions(candidateUris),
      ]);
      const written = new Set(pairs.map(({ subject, predicate }) => `${subject} ${predicate}`));
      const stepsOf = stepsByRequest(stepResult);
      const appliedCreated = new Date(applied.created).getTime();
      for (const record of recordsFromRows(rows(recordResult))) {
        const steps = stepsOf.get(record.uri) || [];
        if (record.targetUri !== applied.targetUri || !PENDING_STATUS_KEYS.includes(statusOf(record, steps))) continue;
        // Only older requests are replaced: approving an old request never withdraws a newer one.
        if (!(new Date(record.created).getTime() < appliedCreated)) continue;
        const versions = candidateVersions.filter((version) => version.requestUri === record.uri);
        const fullyCovered =
          versions.length > 0 &&
          versions.every(
            (version) =>
              version.operation === 'update' &&
              !version.deleted &&
              version.proposals?.size > 0 &&
              [...version.proposals].every(([predicate, proposal]) => !isSetKey(proposal.key) && written.has(`${version.masterUri} ${predicate}`)),
          );
        const outcome = await evaluate(supersede, {
          applied: { uri: applied.uri, uuid: applied.uuid, requestingOrganisation: applied.actorUri, target: applied.targetUri },
          candidate: { uri: record.uri, uuid: record.uuid, requestingOrganisation: record.actorUri, fullyCovered },
          config,
        });
        if (outcome.decision !== 'allow') continue;
        const step = serviceStep({
          type: 'intrekking',
          status: 'ingetrokken',
          sequence: (steps.at(-1)?.sequence ?? 1) + 1,
          at: clock(),
          rule: outcome.rule,
          reason: `Vervangen door wijzigingsaanvraag ${applied.uuid}`,
        });
        await db.update(stepQuery({ request: record, step, graphs, replacedBy: applied.uri }));
        await setStatus(record, 'ingetrokken');
        withdrawn.push(record.uuid);
      }
    } catch (error) {
      console.error(`Withdrawing the requests that ${applied.uri} replaces failed; they keep waiting:`, error);
    }
    return withdrawn;
  }

  /**
   * Request records from the rows of changeRequestsQuery, one per request in the order of the
   * rows; a request with two statuses gives two rows, whose statuses are kept together. A creation
   * whose organisation is not registered shows its proposed organisation.
   */
  const recordsFromRows = (found) => {
    const records = new Map();
    for (const row of found) {
      const known = records.get(row.request);
      if (known) {
        if (row.status && !known.statuses.includes(row.status)) known.statuses.push(row.status);
        continue;
      }
      records.set(row.request, {
        uri: row.request,
        uuid: row.uuid,
        statuses: row.status ? [row.status] : [],
        created: row.created,
        aggregate: row.aggregate,
        kind: kindOf(row.aggregate),
        targetUri: row.target,
        targetUuid: row.targetUuid ?? row.proposedUuid ?? null,
        targetName: row.targetName ?? row.proposedName ?? null,
        targetClassificationUuid: row.targetClassificationUuid ?? row.proposedClassificationUuid ?? null,
        registered: Boolean(row.targetUuid),
        actorUri: row.requestingOrganisation,
        actorUuid: row.requestingOrganisationUuid ?? null,
        creatorUri: row.creator,
        replacedByUuid: row.replacedByUuid ?? null,
      });
    }
    return [...records.values()];
  };

  /**
   * The organisation a creation registers: the one create of an organisation type among the
   * operations, with its lid, a minted uuid and URI (the target of the request) and the
   * classification it proposes (the uuid of the classification concept). The classification must
   * be one the service registers (config.registration), and the document must be of the resource
   * type registered for it: an AGB is an administrative unit, a zorgraad a registered organisation.
   */
  async function organisationToCreate(operations) {
    const found = operations
      .map((operation, index) => ({ operation, index }))
      .filter(({ operation }) => isObject(operation) && isObject(operation.data) && typeof operation.data.type === 'string' && model.has(operation.data.type) && model.isSubtypeOf(operation.data.type, TARGET_TYPE));
    if (found.length !== 1) {
      throw unprocessable(`a request to register an organisation carries exactly one organisation document (${TARGET_TYPE} or a subtype), got ${found.length}`, '/data/attributes/operations');
    }
    const { operation, index } = found[0];
    const data = operation.data;
    const pointer = (...rest) => ['/data/attributes/operations', index, ...rest].join('/');
    if (operation.op !== 'create') throw unprocessable('a request to register an organisation creates it: "op" must be create', pointer('op'));
    if (typeof data.lid !== 'string' || !data.lid) throw unprocessable('a create needs a "lid" (local id)', pointer('data/lid'));
    const classificationRef = data.relationships?.classification?.data;
    const classificationId = isObject(classificationRef) && typeof classificationRef.id === 'string' ? classificationRef.id : null;
    if (!classificationId) throw unprocessable('a new organisation needs a classification', pointer('data/relationships/classification'));
    const classification = (await resolveResources(db, [classificationId])).get(classificationId)?.uri ?? null;
    const expectedType = classification ? registrationType(config, classification) : null;
    if (!expectedType) {
      throw unprocessable(`the service does not register organisations of the classification "${classificationId}"`, pointer('data/relationships/classification'));
    }
    if (data.type !== expectedType) {
      throw unprocessable(`an organisation of this classification is registered as ${expectedType}, not as ${data.type}`, pointer('data/type'));
    }
    const base = model.get(data.type).newResourceBase;
    if (!base) throw unprocessable(`the model has no new-resource-base for "${data.type}"`, pointer('data/type'));
    const uuid = mintUuid();
    const name = typeof data.attributes?.name === 'string' ? data.attributes.name : null;
    return { lid: data.lid, type: data.type, uuid, uri: base + uuid, classification, classificationId, name };
  }

  /**
   * The KBO numbers the operations propose, normalised in place to their ten digits (normaliseKbo):
   * the local ids of the structured identifiers behind an identifier named "KBO nummer", whether
   * that identifier is in the request or, for a structured identifier an edit changes, in the
   * register. An identifier named after a KBO number in another spelling, or a KBO number that is
   * not a number of nine or ten digits, is a 422. Returns [{ number, where, index }], one per
   * number, index the operation that carries it.
   */
  async function kboNumbersOf(operations) {
    const operationOf = (type, ref) =>
      operations.find(
        (operation) =>
          isObject(operation?.data) &&
          model.has(operation.data.type) &&
          model.isSubtypeOf(operation.data.type, type) &&
          ((typeof ref.lid === 'string' && operation.data.lid === ref.lid) || (typeof ref.id === 'string' && operation.data.id === ref.id)),
      );
    // the structured identifiers that hold a KBO number, with the pointer of the identifier that names them
    const kbo = new Map();
    operations.forEach((operation, index) => {
      const data = operation?.data;
      if (!isObject(data) || !model.has(data.type) || !model.isSubtypeOf(data.type, 'identifiers') || operation.op === 'delete') return;
      const name = data.attributes?.['id-name'];
      if (isKboIdName(name) && name !== KBO_ID_NAME) {
        throw unprocessable(`the identifier of a KBO number is named "${KBO_ID_NAME}"`, `/data/attributes/operations/${index}/data/attributes/id-name`);
      }
      const ref = data.relationships?.['structured-identifier']?.data;
      const structured = name === KBO_ID_NAME && isObject(ref) ? operationOf('structured-identifiers', ref) : null;
      if (structured) kbo.set(structured, `/data/attributes/operations/${index}/data/relationships/structured-identifier`);
    });
    // A structured identifier an edit changes without its identifier in the request: the register says whether it is a KBO number.
    const changed = operations.filter(
      (operation) =>
        operation?.op === 'update' &&
        isObject(operation.data) &&
        model.has(operation.data.type) &&
        model.isSubtypeOf(operation.data.type, 'structured-identifiers') &&
        !kbo.has(operation) &&
        isObject(operation.data.attributes) &&
        Object.hasOwn(operation.data.attributes, 'local-id'),
    );
    if (changed.length) {
      const resources = await resolveResources(db, changed.map((operation) => operation.data.id).filter((id) => typeof id === 'string'));
      const byUri = new Map(changed.filter((operation) => resources.has(operation.data.id)).map((operation) => [resources.get(operation.data.id).uri, operation]));
      if (byUri.size) {
        const names = rows(await db.query(identifierNamesQuery({ structuredUris: [...byUri.keys()], predicates: identifierPredicates, idClass: identifierClass })));
        for (const row of names) if (isKboIdName(row.idName)) kbo.set(byUri.get(row.structured), null);
      }
    }
    const numbers = new Map();
    for (const [operation, identifierPointer] of kbo) {
      const index = operations.indexOf(operation);
      const value = operation.data.attributes?.['local-id'];
      if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) continue;
      const number = normaliseKbo(value);
      const where = `/data/attributes/operations/${index}/data/attributes/local-id`;
      if (!number) throw unprocessable('a KBO number has ten digits (0123456789 or 0123.456.789)', where);
      operation.data.attributes['local-id'] = number;
      if (!numbers.has(number)) numbers.set(number, { number, where: identifierPointer ?? where, index });
    }
    return [...numbers.values()];
  }

  /** The KBO numbers a stored request proposes: the local ids of its structured identifiers behind an identifier named after a KBO number. */
  function kboNumbersOfVersions(versions) {
    const numbers = new Set();
    for (const version of versions) {
      if (!model.has(version.type) || !model.isSubtypeOf(version.type, 'identifiers')) continue;
      if (!(version.terms.get(identifierPredicates.idName) || []).some((binding) => isKboIdName(binding.value))) continue;
      for (const structured of version.terms.get(identifierPredicates.structuredIdentifier) || []) {
        const structuredVersion = versions.find((other) => other.masterUri === structured.value);
        for (const localId of structuredVersion?.terms.get(identifierPredicates.localId) || []) numbers.add(normaliseKbo(localId.value) ?? localId.value);
      }
    }
    return [...numbers];
  }

  /**
   * The pending creation (ingediend, informatie-gevraagd) that proposes a KBO number, other than
   * the request except: { uri, uuid, actorUri } or null. Three anchored lookups (see queries.js):
   * the structured-identifier versions with that number, the identifier versions of the same
   * submissions named after a KBO number, and the requests behind those.
   */
  async function pendingCreationWithKbo(number, except = null) {
    const structured = rows(await db.query(proposedLocalIdsQuery({ localIds: kboForms(number), predicates: identifierPredicates })));
    if (!structured.length) return null;
    const pairs = structured.map((row) => ({ structured: row.structured, structuredVersion: row.structuredVersion }));
    const identifiers = rows(await selectInBatches(db, pairs, (batch) => proposedIdentifiersQuery({ pairs: batch, predicates: identifierPredicates }), { size: 50 }));
    const kboVersions = [...new Set(identifiers.filter((row) => isKboIdName(row.idName)).map((row) => row.identifierVersion))];
    const requests = await requestsOfVersions(kboVersions);
    return [...requests.values()].find((request) => request.uri !== except && creationAggregates.includes(request.aggregate) && isPending(request)) ?? null;
  }

  /**
   * Refuses KBO numbers someone else holds, with a 409: an organisation in the register that holds
   * the number (other than except, the organisation the request is about or registers), and, when
   * pending is set, a pending creation that proposes it (other than exceptRequest). The 409 names
   * the holder; it names a waiting request only to who may see that request.
   */
  async function refuseTakenKbo(session, numbers, { except = null, exceptRequest = null, pending = true } = {}) {
    for (const { number, where } of numbers) {
      const holder = await organisationWithIdentifier(db, {
        idNames: KBO_ID_NAMES,
        localIds: kboForms(number),
        predicates: identifierPredicates,
        classes: organisationClasses,
        excludedClasses: mirrorClasses,
        except,
      });
      if (holder) {
        throw new HttpError(409, 'An organisation with this KBO number is already registered', {
          detail: `KBO number ${number} belongs to organisation "${holder.uuid}"`,
          pointer: where,
          meta: { 'kbo-number': number, organisation: { type: TARGET_TYPE, id: holder.uuid } },
        });
      }
      if (!pending) continue;
      const waiting = await pendingCreationWithKbo(number, exceptRequest);
      if (waiting) {
        const visible = !visibilityOf(session) || waiting.actorUri === session.actor.uri;
        throw new HttpError(409, 'A request to register an organisation with this KBO number is already waiting', {
          detail: visible ? `KBO number ${number} is proposed by change request "${waiting.uuid}"` : `KBO number ${number} is proposed by a request that waits for a decision`,
          pointer: where,
          meta: { 'kbo-number': number, ...(visible ? { 'change-request': { id: waiting.uuid } } : {}) },
        });
      }
    }
  }

  /**
   * The change events a creation or a change-event request carries: a creation registers its
   * organisation with exactly one oprichting (a change event of config.registration's
   * foundingEventType), a change-event request carries exactly one change event, which names the
   * organisation the request is about as an original or resulting organisation.
   */
  function refuseWrongEvents(kind, versions, target) {
    if (kind === 'edit' || !eventPredicates) return;
    const events = versions.filter((version) => version.operation === 'create' && model.isSubtypeOf(version.type, 'change-events'));
    const typeOf = (event) => event.triples.find((triple) => triple.predicate === eventPredicates.type)?.object ?? null;
    if (kind === 'creation') {
      const founding = iri(config.registration.foundingEventType);
      if (events.length !== 1 || typeOf(events[0]) !== founding) {
        throw unprocessable(`a request to register an organisation carries exactly one change event, its oprichting (type ${config.registration.foundingEventType}); got ${events.length}`, '/data/attributes/operations');
      }
      return;
    }
    if (events.length !== 1) throw unprocessable(`a change-event request carries exactly one change event, got ${events.length}`, '/data/attributes/operations');
    const aboutTarget = events[0].triples.some((triple) => eventPredicates.organisations.includes(triple.predicate) && triple.object === iri(target.uri));
    if (!aboutTarget) throw unprocessable('the change event must name the organisation the request is about as an original or resulting organisation', '/data/attributes/operations');
  }

  /**
   * Refuses the delete of a record that records outside the organisation's data still link to
   * (incoming: the links to the deleted masters now; reachable: the records of the target's
   * aggregate; masters: the records of the request): the apply would remove those links, and so
   * change data of another organisation. A 409, since it depends on the data of the moment.
   */
  function refuseForeignLinks(versions, incoming, reachable) {
    const masters = new Set(versions.map((version) => version.masterUri));
    for (const version of versions.filter((candidate) => candidate.deleted)) {
      for (const predicate of model.incomingPredicates(version.type)) {
        for (const subject of incoming.get(`${version.masterUri} ${predicate}`) || []) {
          if (reachable.has(subject.value) || masters.has(subject.value)) continue;
          throw new HttpError(409, 'The record is used outside the organisation', {
            detail: `${version.type} "${version.masterUuid}" is linked from ${subject.value}, which does not belong to the organisation; deleting it would change that record too`,
            meta: { record: { type: version.type, id: version.masterUuid } },
          });
        }
      }
    }
  }

  /** POST /change-requests */
  async function create(session, body) {
    const { aggregateName, operations, target: targetRef, reason } = parseBody(body);
    const aggregate = aggregateNamed(config, aggregateName);
    if (!aggregate) {
      throw unprocessable(
        `unknown aggregate ${JSON.stringify(aggregateName)}; configured: ${Object.keys(config.aggregates).join(', ')}`,
        '/data/attributes/aggregate',
      );
    }
    const kind = aggregateKind(aggregate);
    if (kind === 'creation') {
      if (targetRef) {
        throw unprocessable('a request to register an organisation has no target: the organisation does not exist yet', '/data/relationships/target');
      }
      const creation = await organisationToCreate(operations);
      const kbo = await kboNumbersOf(operations);
      const target = {
        uri: creation.uri,
        uuid: creation.uuid,
        classification: creation.classification,
        classificationUuid: creation.classificationId,
        name: creation.name,
        classes: model.classTree(creation.type),
        pending: true,
      };
      return withLock(target.uri, () => withLocks(kbo.map(({ number }) => kboLockKey(number)), () => submit(session, { aggregateName, aggregate, kind, operations, target, creation, reason, kbo })));
    }
    if (!targetRef) throw unprocessable('the "target" relationship must identify an organisation by type and id', '/data/relationships/target');
    if (!model.has(targetRef.type) || !model.isSubtypeOf(targetRef.type, TARGET_TYPE)) {
      throw unprocessable(`the target must be of type ${TARGET_TYPE} or a subtype, got "${targetRef.type}"`, '/data/relationships/target/data/type');
    }
    const target = await requireTarget(targetRef.id);
    const kbo = await kboNumbersOf(operations);
    return withLock(target.uri, () => withLocks(kbo.map(({ number }) => kboLockKey(number)), () => submit(session, { aggregateName, aggregate, kind, operations, target, creation: null, reason, kbo })));
  }

  async function submit(session, { aggregateName, aggregate, kind, operations, target, creation, reason, kbo }) {
    const ctx = policyContext(session, target, { aggregate: aggregateName, kind, operations });
    const allowed = await evaluate(creation ? canCreate : canEdit, ctx);
    if (allowed.decision !== 'allow') throw forbidden(allowed, creation ? 'Not allowed to request this organisation' : undefined);
    if (creation) {
      if (!kbo.length && !config.registration.kboOptional.includes(creation.classification)) {
        throw unprocessable(`an organisation of this classification is registered with its KBO number (an identifier "${KBO_ID_NAME}")`, '/data/attributes/operations');
      }
      if (kbo.length > 1) throw unprocessable('an organisation has one KBO number', kbo[1].where);
    }

    const baseIds = collectBaseReferences(operations);
    const [resources, reachable] = await Promise.all([
      resolveResources(db, [...new Set([...collectReferences(operations), ...baseIds])]),
      reachableFromTarget(db, target.uri, paths[aggregateName]),
    ]);
    const unknownBaseIds = baseIds.filter((id) => !resources.has(id));
    const former = unknownBaseIds.length ? await formerResources(db, unknownBaseIds) : new Map();
    const created = clock();
    const requestUuid = mintUuid();
    const built = buildVersions({ operations, aggregateName, aggregate, model, mintUuid, resources, former, reachable, target, creation });
    refuseWrongEvents(kind, built.versions, target);
    // What the masters hold now and what links to the records it deletes, read under the lock: a
    // request on the same organisation that was being applied a moment ago is part of it.
    const [current, incoming] = await Promise.all([
      currentTerms(db, carriedPairs(built.versions)),
      incomingTerms(db, incomingPairs(built.versions, model)),
    ]);
    const settled = settleVersions({ versions: built.versions, current, incoming, model, aggregateName, mintUuid });
    const versions = settled.versions;
    refuseForeignLinks(versions, incoming, reachable);
    // The KBO numbers the request writes (a new one, or one it changes; not one it carries as it
    // is) must be free, checked under the lock of the number.
    const written = kbo.filter(({ index }) =>
      versions.some((version) => version.masterUri === built.versions[index].masterUri && (version.operation === 'create' || version.replaces.includes(identifierPredicates.localId))),
    );
    if (written.length) await refuseTakenKbo(session, written, { except: target.uri });
    // An edit that changes nothing is not stored: there is nothing to keep in the history.
    if (kind === 'edit' && !versions.length) return { status: 200, document: null, meta: { unchanged: true } };

    const request = {
      uri: REQUEST_BASE + requestUuid,
      uuid: requestUuid,
      status: STATUS.ingediend,
      created,
      aggregate: aggregateName,
      kind,
      targetUri: target.uri,
      targetUuid: target.uuid,
      registered: !creation,
      actorUri: session.actor.uri,
      actorUuid: session.actor.uuid,
      creatorUri: session.person,
      // What the listing shows of the organisation; for a creation, what the request proposes.
      targetName: target.name ?? null,
      targetClassificationUuid: target.classificationUuid ?? null,
    };
    const known = new Map([...resources].map(([uuid, { uri }]) => [uri, uuid]));
    for (const [uuid, uri] of former) known.set(uri, uuid);
    for (const version of built.versions) if (version.operation === 'create') known.set(version.masterUri, version.masterUuid);
    const { conflicts, keys, uuids } = await review(versions, settled.conflicts, { requestUri: request.uri, known });
    const rendered = conflicts.map((conflict) => renderConflict(conflict, uuids));
    const competing = keys.map((key) => renderCompeting(key, uuids));
    // An edit is applied at once or not at all: a conflict sends the user back to the form.
    if (kind === 'edit' && rendered.length) throw conflictingEditError(rendered, competing);

    const viewer = viewerOf(session, request);
    const submission = personStep(session, { type: 'indiening', status: 'ingediend', sequence: 1, at: created, rule: allowed.rule, reason });
    await storeSubmission(request, submission, versions);

    const approval = await evaluate(autoApprove, { ...ctx, conflicts: rendered, competing });
    if (approval.decision !== 'allow') {
      return { status: 201, document: serialise(request, { steps: [submission], conflicts: rendered, competing, lids: built.lids, viewer }) };
    }
    // Approved at once: the service's goedkeuring, then the afhandeling that applies the versions.
    const decision = serviceStep({ type: 'goedkeuring', status: 'goedgekeurd', sequence: 2, at: clock(), rule: approval.rule });
    const handling = serviceStep({ type: 'afhandeling', status: 'afgehandeld', sequence: 3, at: clock() });
    const states = replacedStates({ versions, current, incoming, model, mintUuid });
    await applyOrFail(request, versions, handling, states, decision);
    const superseded = await supersedeOlder(request, versions);
    // The withdrawn requests no longer compete.
    const stillCompeting = competing
      .map((key) => ({ ...key, 'competing-requests': key['competing-requests'].filter((uuid) => !superseded.includes(uuid)) }))
      .filter((key) => key['competing-requests'].length);
    return {
      status: 201,
      document: serialise({ ...request, status: STATUS.afgehandeld, registered: true }, { steps: [submission, decision, handling], competing: stillCompeting, lids: built.lids, superseded, viewer }),
    };
  }

  /**
   * The documents of request records for a session: their steps with the conflicts the applying
   * ones overrode, live conflicts and competing keys for the pending ones, and, when asked, the
   * submitted operations.
   */
  async function documents(session, records, steps, { withOperations = false } = {}) {
    const stepsOf = (record) => steps.get(record.uri) || [];
    const pending = records.filter((record) => PENDING_STATUS_KEYS.includes(statusOf(record, stepsOf(record)))).map((record) => record.uri);
    const [live, , operations] = await Promise.all([
      liveState(pending),
      attachOverridden(new Map(records.map((record) => [record.uri, stepsOf(record)]))),
      withOperations ? Promise.all(records.map((record) => operationsOf(record))) : [],
    ]);
    return records.map((record, index) =>
      serialise(record, { steps: stepsOf(record), ...live.get(record.uri), operations: withOperations ? operations[index] : undefined, viewer: viewerOf(session, record) }),
    );
  }

  /**
   * GET /change-requests: one page of the requests the session may see (visibilityOf), oldest
   * first unless sorted otherwise, filtered (parseListQuery); creations and change events only
   * unless filter[kind] names edits. Steps, versions and current values are read for the requests
   * of the page only. Returns { documents, count }, count the number of requests over all pages.
   */
  async function list(session, { target: targetUuid, statuses = [], kinds = [], mine = false, requester, targetClassification, created = {}, sort = 'created', page = { number: 0, size: DEFAULT_PAGE_SIZE } } = {}) {
    const none = { documents: [], count: 0 };
    const listed = kinds.length ? kinds : LISTED_KINDS;
    const filters = {
      visibility: visibilityOf(session),
      statuses,
      aggregates: listed.flatMap((kind) => aggregatesOfKind(config, kind)),
      creatorUri: mine ? session.person : undefined,
      createdFrom: created.from,
      createdUntil: created.until,
    };
    if (mine && !filters.creatorUri) return none;
    if (!filters.aggregates.length) return none;
    if (targetUuid !== undefined) {
      // An organisation, or the one a waiting creation would register (known from its versions).
      const target = (await findOrganisation(db, targetUuid, model))?.uri ?? (await formerResources(db, [targetUuid])).get(targetUuid);
      if (!target) return none;
      filters.targetUri = target;
    }
    if (requester !== undefined) {
      const organisation = await findOrganisation(db, requester, model);
      if (!organisation) return none;
      filters.requesterUri = organisation.uri;
    }
    if (targetClassification !== undefined) {
      const concept = (await resolveResources(db, [targetClassification])).get(targetClassification);
      if (!concept) return none;
      filters.classification = { uri: concept.uri, predicate: organisationPredicates.classification };
    }
    const [pageResult, countResult] = await Promise.all([
      db.query(requestPageQuery({ ...filters, sort, limit: page.size, offset: page.number * page.size })),
      db.query(requestCountQuery(filters)),
    ]);
    const count = Number(rows(countResult)[0]?.count ?? 0);
    const requestUris = [...new Set(rows(pageResult).map((row) => row.request))];
    if (!requestUris.length) return { documents: [], count };
    const [recordResult, stepResult] = await Promise.all([
      db.query(changeRequestsQuery({ requestUris, predicates: organisationPredicates })),
      selectInBatches(db, requestUris, (batch) => stepsQuery({ requestUris: batch }), { size: 25 }),
    ]);
    const byUri = new Map(recordsFromRows(rows(recordResult)).map((record) => [record.uri, record]));
    const records = requestUris.map((uri) => byUri.get(uri)).filter(Boolean);
    return { documents: await documents(session, records, stepsByRequest(stepResult)), count };
  }

  /** A request the session may see, with its steps, or a 404. The steps are read once the request is known to be visible. */
  const loadVisible = async (session, uuid) => {
    const [record] = recordsFromRows(rows(await db.query(changeRequestsQuery({ uuid, visibility: visibilityOf(session), predicates: organisationPredicates }))));
    if (!record) throw new HttpError(404, 'Change request not found', { detail: `No change request with id "${uuid}" is visible to this organisation` });
    const steps = stepsByRequest(await db.query(stepsQuery({ requestUris: [record.uri] }))).get(record.uri) || [];
    return { record, steps };
  };

  /** GET /change-requests/:id: the request with its steps, conflicts and the submitted operations. */
  async function get(session, uuid) {
    const { record, steps } = await loadVisible(session, uuid);
    const [document] = await documents(session, [record], new Map([[record.uri, steps]]), { withOperations: true });
    return document;
  }

  /**
   * A step on an existing request: a goedkeuring, an afkeuring or an informatievraag (canDecide),
   * an informatieantwoord or a betwisting (canReply), an intrekking (canWithdraw), a hertoepassing
   * (canReapply). 403 when the policy denies, 409 when the request's status or kind does not admit
   * the step. A goedkeuring records the decision and the afhandeling that applies the stored
   * versions, planned against the current values, with the states it replaces; a hertoepassing
   * applies them again. Both are refused when a record the request updates was deleted since, or
   * when a record it deletes is linked from outside the organisation now. A goedkeuring re-checks
   * the conflicts and answers 409 with them and their token unless override is that token: the
   * approver overrides exactly the conflicts they reviewed, which the states the apply replaced
   * keep (overriddenConflicts). A hertoepassing is refused when a request on the same organisation
   * that changed something was applied after this one failed, since the stored versions would
   * overwrite what it changed. The KBO number of a creation is claimed again by a goedkeuring, a
   * hertoepassing (the register must not hold it) and a betwisting (no other creation may wait
   * with it either), under the lock of the number.
   */
  async function takeStep(session, uuid, { stepType, reason = null, override = null }) {
    const { record: found } = await loadVisible(session, uuid);
    return withLock(found.targetUri, async () => {
      const { record, steps } = await loadVisible(session, uuid);
      const status = statusOf(record, steps);
      const target = await resolveTarget(record);
      const rules =
        stepType === 'intrekking' ? canWithdraw
        : REPLY_STEP_TYPES.includes(stepType) ? canReply
        : stepType === 'hertoepassing' ? canReapply
        : canDecide;
      const outcome = await evaluate(
        rules,
        policyContext(session, target, {
          aggregate: record.aggregate,
          kind: record.kind,
          operations: [],
          request: { uri: record.uri, uuid: record.uuid, status, aggregate: record.aggregate, requestingOrganisation: record.actorUri },
        }),
      );
      if (outcome.decision !== 'allow') throw forbidden(outcome, `Not allowed to take a ${stepType} step on this change request`);
      if (record.kind === 'edit' && !EDIT_STEP_TYPES.includes(stepType)) {
        throw new HttpError(409, 'The change request cannot take this step', {
          detail: `Change request "${uuid}" is an edit, which is applied at once; after a failed apply it takes only a hertoepassing or an intrekking`,
          meta: { status, 'step-type': stepType, kind: record.kind },
        });
      }
      if (!TRANSITIONS[stepType].from.includes(status)) throw transitionError(uuid, status, stepType);
      const claimsKbo = record.kind === 'creation' && KBO_CLAIMING_STEP_TYPES.includes(stepType);
      const versions = claimsKbo || !TRANSITIONS[stepType].to ? await storedVersions([record.uri]) : [];
      const kbo = claimsKbo ? kboNumbersOfVersions(versions).map((number) => ({ number, where: undefined })) : [];
      return withLocks(kbo.map(({ number }) => kboLockKey(number)), async () => {
        if (kbo.length) await refuseTakenKbo(session, kbo, { except: record.targetUri, exceptRequest: record.uri, pending: stepType === 'betwisting' });
        return continueStep(session, { record, steps, status, target, stepType, reason, override, outcome, versions });
      });
    });
  }

  /** The rest of takeStep, under the locks: the step itself, and for a goedkeuring or a hertoepassing the apply. */
  async function continueStep(session, { record, steps, target, stepType, reason, override, outcome, versions }) {
    const viewer = viewerOf(session, record);
    // A request written before steps existed counts its unrecorded indiening as step 1.
    const step = personStep(session, { type: stepType, sequence: (steps.at(-1)?.sequence ?? 1) + 1, at: clock(), rule: outcome.rule, reason });
    const leadsTo = TRANSITIONS[stepType].to;
    if (leadsTo) {
      const taken = { ...step, status: leadsTo };
      await db.update(stepQuery({ request: record, step: taken, graphs }));
      await setStatus(record, leadsTo);
      const updated = { ...record, statuses: [STATUS[leadsTo]] };
      // A request that waits again shows its live conflicts and competing keys, as a GET does.
      const [document] = await documents(session, [updated], new Map([[record.uri, [...steps, taken]]]));
      return { status: 201, document };
    }

    if (stepType === 'hertoepassing') {
      const failedAt = steps.at(-1)?.at ?? record.created;
      const later = rows(await db.query(laterAppliedQuery({ targetUri: record.targetUri, after: failedAt, exclude: record.uri })))[0];
      if (later) {
        throw new HttpError(409, 'A change request on this organisation has been applied since this one failed', {
          detail: `Change request "${later.uuid}" was applied on ${toIso(later.appliedAt)}; submit the change again instead of applying this one`,
          meta: { 'change-request': { id: later.uuid, status: 'afgehandeld' } },
        });
      }
    }
    const current = await currentTerms(db, storedPairs(versions));
    const missing = missingMasters(versions, current);
    if (missing.length) throw missingRecordsError(record.uuid, missing, stepType);
    const incoming = await incomingTerms(db, storedIncomingPairs(versions, model));
    if (versions.some((version) => version.deleted)) {
      refuseForeignLinks(versions, incoming, await reachableFromTarget(db, record.targetUri, paths[record.aggregate] ?? []));
    }
    const { conflicts, uuids } = await review(versions, storedConflicts({ versions, current, incoming, model }));
    const rendered = conflicts.map((conflict) => renderConflict(conflict, uuids));
    const token = conflictsToken(rendered);
    // A hertoepassing applies what was approved before; it overwrites without a new review.
    if (stepType === 'goedkeuring' && token && override !== token) {
      const count = `${rendered.length} conflict${rendered.length === 1 ? '' : 's'}`;
      throw new HttpError(409, 'The change request conflicts with the current data', {
        detail: override
          ? `The conflicts changed since they were reviewed: ${count} now; review them and approve with "override": "${token}" to apply it anyway`
          : `${count} with what changed since it was submitted; review them and approve with "override": "${token}" to apply it anyway`,
        meta: { conflicts: rendered, 'conflicts-token': token },
      });
    }
    // The goedkeuring is the person's decision; the afhandeling that applies it is the service's.
    // A hertoepassing applies by itself. The answer shows the conflicts the apply overrides; the
    // states it replaces keep them (attachOverridden reads them back).
    const decision = stepType === 'goedkeuring' ? { ...step, status: 'goedgekeurd' } : null;
    const applying = decision
      ? serviceStep({ type: 'afhandeling', status: 'afgehandeld', sequence: step.sequence + 1, at: clock() })
      : { ...step, status: 'afgehandeld' };
    applying.overriddenConflicts = rendered.map(overriddenForm);
    const present = (version) => (current.get(`${version.masterUri} ${NS.rdf}type`) || []).length > 0;
    const states = replacedStates({ versions, current, incoming, model, mintUuid, present });
    await applyOrFail(record, planStored(versions, current, model), applying, states, decision);
    const superseded = await supersedeOlder(record, versions);
    return {
      status: 201,
      document: serialise({ ...record, statuses: [STATUS.afgehandeld], registered: true }, { steps: [...steps, ...(decision ? [decision] : []), applying], superseded, viewer }),
    };
  }

  /** POST /change-requests/:id/steps */
  async function addStep(session, uuid, body) {
    return takeStep(session, uuid, parseStepBody(body));
  }

  /** POST /change-requests/:id/apply: a hertoepassing, answered with 200 as before steps existed. */
  async function apply(session, uuid) {
    const { document } = await takeStep(session, uuid, { stepType: 'hertoepassing' });
    return { status: 200, document };
  }

  return { permissions, create, list, get, addStep, apply };
}
