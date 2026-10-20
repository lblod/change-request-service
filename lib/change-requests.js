import { v4 as uuidv4 } from 'uuid';
import {
  APPLICATION_GRAPH,
  CHANGE_REQUESTS_GRAPH,
  REQUEST_BASE,
  ACTION_BASE,
  ERROR_BASE,
  STATUS,
  STATUS_KEYS,
  PENDING_STATUS_KEYS,
  STEP_TYPE_KEYS,
  RESERVED_STEP_TYPE_KEYS,
  KINDS,
  SERVICE_AGENT,
  TARGET_TYPE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  NS,
  statusKey,
  stepTypeKey,
} from '../constants.js';
import { HttpError, unprocessable } from './errors.js';
import { aggregateKind, aggregatesOfKind } from './config.js';
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
  markFailedQuery,
  changeRequestsQuery,
  requestPageQuery,
  requestCountQuery,
  stepsQuery,
  storedVersionsQuery,
  replacedStatesQuery,
  laterAppliedQuery,
  competingQuery,
  pendingIdentifierQuery,
} from './queries.js';
import { operationsFromVersions, relatedRecordUris } from './operations.js';
import { rows, selectInBatches } from './sparql-result.js';
import { createLock } from './lock.js';
import { isSetKey } from './values.js';
import { canEdit, canCreate, autoApprove, canDecide, canReply, canWithdraw, supersede, evaluate } from '../policies/index.js';

const toIso = (value) => new Date(value).toISOString();
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

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
 * contested. Nothing amends a pending request: it is answered, contested or withdrawn.
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
// The statuses everyone sees a request in while config.pendingVisibleTo is "involved".
const SHOWN_TO_ALL_STATUSES = ['afgehandeld'];
// The name of the identifier that must be unique over the register and the pending creations.
const KBO_ID_NAME = 'KBO nummer';

/**
 * The API form of a step. person is the uuid of the person who took it (null for the service),
 * reason its text, error the message of its oslc:Error, overridden-conflicts the conflicts it
 * applied the request despite (derived from the states it replaced, see overriddenConflicts), as
 * the approver saw them without their competing requests. A viewer that is not the requesting
 * organisation or ABB sees neither the person nor the texts (viewer.seesDetails).
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
    error: step.error?.message ?? null,
    'overrides-conflict': overridden.length > 0,
    'overridden-conflicts': overridden,
  };
}

/**
 * The status of a request: its adms:status, the status of its last step, which the update that
 * adds a step sets in the same update. A request record built in memory carries it too.
 */
const statusOf = (record, steps = []) => (record.status ? statusKey(record.status) : steps.at(-1)?.status ?? null);

const EVERYTHING = { personUri: null, seesDetails: true };

/**
 * The JSON:API resource object of a request record with its steps (ordered by sequence), its
 * conflicts and the keys other pending requests compete for (rendered). status is the request's
 * status (statusOf), kind the kind of its aggregate, mine whether the viewer submitted it,
 * applied-at the start of the last step with status afgehandeld, error the error message of the
 * last step, target-name and target-classification what the listing shows of the organisation
 * (from the application data, or from the proposed version of a creation that still waits),
 * conflicts-token the token that overrides exactly these conflicts in a goedkeuring, replaced-by
 * the uuid of the newer request that replaced this one (dct:isReplacedBy, see supersedeOlder),
 * operations the submitted operations rebuilt from the stored versions (the detail only). The
 * target of a creation that still waits carries meta.pending.
 */
export function serialise(record, { steps = [], conflicts = [], competing = [], lids, superseded, operations, viewer = EVERYTHING } = {}) {
  const last = steps.at(-1);
  const applied = steps.filter((step) => step.status === 'afgehandeld').at(-1);
  const attributes = {
    status: statusOf(record, steps),
    kind: record.kind ?? 'edit',
    created: toIso(record.created),
    'applied-at': applied ? toIso(applied.at) : null,
    aggregate: record.aggregate,
    mine: Boolean(viewer.personUri) && record.creatorUri === viewer.personUri,
    'target-name': record.targetName ?? null,
    'target-classification': record.targetClassificationUuid ?? null,
    error: last?.error?.message ?? null,
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
  if (record.pending) target.meta = { pending: true };
  return {
    type: 'change-requests',
    id: record.uuid,
    attributes,
    relationships: {
      target,
      'requesting-organisation': { data: { type: TARGET_TYPE, id: record.actorUuid } },
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
  if (!data || typeof data !== 'object') throw unprocessable('the body must be a JSON:API document with "data"', '/data');
  if (data.type !== 'change-requests') throw unprocessable('"type" must be "change-requests"', '/data/type');
  const attributes = data.attributes ?? {};
  if (typeof attributes.aggregate !== 'string') throw unprocessable('"aggregate" is required', '/data/attributes/aggregate');
  const target = data.relationships?.target?.data ?? null;
  if (target !== null && (typeof target !== 'object' || typeof target.type !== 'string' || typeof target.id !== 'string')) {
    throw unprocessable('the "target" relationship must identify an organisation by type and id', '/data/relationships/target');
  }
  const reason = attributes.reason ?? null;
  if (reason !== null && typeof reason !== 'string') throw unprocessable('"reason" must be a string', '/data/attributes/reason');
  return { aggregateName: attributes.aggregate, operations: attributes.operations, target, reason: reason?.trim() ? reason : null };
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
  const reason = attributes.reason ?? null;
  if (reason !== null && typeof reason !== 'string') throw unprocessable('"reason" must be a string', '/data/attributes/reason');
  const given = reason !== null && reason.trim() !== '';
  if (TRANSITIONS[stepType].text && !given) throw unprocessable(`${/^[aeiou]/.test(stepType) ? 'an' : 'a'} ${stepType} needs a reason`, '/data/attributes/reason');
  const override = attributes.override ?? null;
  if (override !== null && override !== false && (typeof override !== 'string' || !override)) {
    throw unprocessable(
      '"override" must be the "conflicts-token" of the conflicts you reviewed (GET /change-requests/:id, or the 409 of a goedkeuring), so the approval overrides those and no others',
      '/data/attributes/override',
    );
  }
  return { stepType, reason: given ? reason : null, override: typeof override === 'string' ? override : null };
}

const SORTS = ['created', '-created'];

/**
 * The query parameters of GET /change-requests: filter[target] (an organisation uuid),
 * filter[status] (status keys, comma-separated), filter[kind] (edit, creation, change-event,
 * comma-separated), filter[mine]=true (the requests the session's person submitted),
 * filter[requester] (the uuid of the organisation that submitted them),
 * filter[target-classification] (the uuid of a classification concept),
 * filter[created][gte] and filter[created][lte] (ISO 8601, inclusive), sort (created, the
 * default: oldest first, or -created), page[number] (from 0) and page[size] (1 to MAX_PAGE_SIZE,
 * DEFAULT_PAGE_SIZE when absent). A malformed value is a 400.
 */
export function parseListQuery(query = {}) {
  const invalid = (detail) => new HttpError(400, 'Invalid query parameter', { detail });
  const filter = isObject(query.filter) ? query.filter : {};
  const uuidFilter = (name, what) => {
    const value = filter[name];
    if (value !== undefined && (typeof value !== 'string' || !value)) throw invalid(`filter[${name}] must be the uuid of ${what}`);
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
    const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isInteger(number) || number < min || number > max) throw invalid(`page[${name}] must be a whole number from ${min} to ${max}`);
    return number;
  };
  return {
    target,
    statuses,
    kinds,
    mine,
    requester,
    targetClassification,
    created,
    sort,
    page: { number: whole(page.number, 'number', 0, Number.MAX_SAFE_INTEGER, 0), size: whole(page.size, 'size', 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE) },
  };
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
  const last = Math.max(0, Math.ceil(count / page.size) - 1);
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
 * session and the scope); mintUuid and clock are injectable for tests.
 */
export function createService({
  model,
  config,
  db,
  graphs = { application: APPLICATION_GRAPH, changeRequests: CHANGE_REQUESTS_GRAPH },
  mintUuid = uuidv4,
  clock = () => new Date(),
}) {
  // Per target organisation: reading the current values, the conflict check, the writes and the
  // apply of one request or step happen before those of the next (see lock.js).
  const withLock = createLock();
  const isAbb = (session) => session.actor.uri === config.abbUri;
  const kindOf = (aggregateName) => aggregateKind(config.aggregates[aggregateName]);
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
  // The classes an organisation record carries (the organisation types and their subtypes).
  const organisationClasses = model.classesOf(TARGET_TYPE);
  const identifierPredicates = {
    identifiers: predicateOf(TARGET_TYPE, 'identifiers', 'relationship'),
    idName: predicateOf('identifiers', 'id-name', 'attribute'),
    structuredIdentifier: predicateOf('identifiers', 'structured-identifier', 'relationship'),
    localId: predicateOf('structured-identifiers', 'local-id', 'attribute'),
  };

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
   * The target of a stored request: the organisation it is about, or, for a creation that is not
   * applied yet, the organisation it would register (which exists in the request only).
   */
  const resolveTarget = async (record) => {
    const found = await findOrganisation(db, record.targetUuid, model);
    if (found) return found;
    if (record.kind === 'creation') return { uri: record.targetUri, uuid: record.targetUuid, classification: null, classes: [], pending: true };
    throw new HttpError(404, 'Target organisation not found', { detail: `No organisation with id "${record.targetUuid}"` });
  };

  /**
   * Who sees a request: ABB and, while config.pendingVisibleTo is "everyone", everyone sees all;
   * otherwise an organisation sees the requests about it, those it submitted and the applied ones
   * (the filter of requestFilters in queries.js). What a viewer sees of a request: the requesting
   * organisation and ABB see the persons and the texts of the steps (stepJson).
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

  /** The classifications the session's organisation may request a new organisation of; ABB every configured one. */
  const creatableClassifications = (session) => {
    if (isAbb(session)) return [...new Set(Object.values(config.creatableClassifications).flat())];
    return config.creatableClassifications[session.actor.classification] ?? [];
  };

  /**
   * GET /change-requests/permissions: with a target, the rights on that organisation (can-edit:
   * edits and change events, the canEdit rules; can-decide; the rule that decided); without one,
   * the rights of the session (can-create: the classifications it may request; can-decide).
   */
  async function permissions(session, targetUuid) {
    const decides = await evaluate(canDecide, policyContext(session, null));
    if (targetUuid === undefined) {
      return { 'can-create': creatableClassifications(session), 'can-decide': decides.decision === 'allow' };
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
   * The competing requests of every key the versions write (competingRequests in conflicts.js):
   * the pending requests that write one of those keys are looked up, and their stored versions
   * compared. Versions of a pending request among the given ones are not read again. requestUri
   * is the request of versions that are not stored yet (a submission).
   */
  async function competingFor(versions, requestUri = null) {
    const pairs = writtenPairs(versions);
    if (!pairs.length) return new Map();
    const found = rows(await selectInBatches(db, pairs, (batch) => competingQuery({ pairs: batch }), { size: 200 }));
    const uuids = new Map(found.map((row) => [row.request, row.uuid]));
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
   * The operations of a request as submitted, rebuilt from its stored versions, with the related
   * records as uuids. The versions keep no order, so the operations come in a fixed one: the
   * document of the aggregate's root type first (the organisation of a creation, the change event
   * of a change-event request), then the others by type and uuid.
   */
  async function operationsOf(record) {
    const versions = await storedVersions([record.uri]);
    const root = config.aggregates[record.aggregate]?.root;
    const rank = (version) => (root && model.has(version.type) && model.isSubtypeOf(version.type, root) ? 0 : 1);
    const ordered = [...versions].sort((a, b) => rank(a) - rank(b) || a.type.localeCompare(b.type) || a.masterUuid.localeCompare(b.masterUuid));
    const related = relatedRecordUris(ordered, model);
    const uuids = new Map(ordered.map((version) => [version.masterUri, version.masterUuid]));
    const missing = related.filter((uri) => !uuids.has(uri));
    if (missing.length) for (const [uri, uuid] of await uuidsOf(db, missing)) uuids.set(uri, uuid);
    return operationsFromVersions(ordered, model, uuids);
  }

  /**
   * Applies the versions to the application graph with the step that applies them (an
   * afhandeling, with the goedkeuring it follows, or a hertoepassing) and the states it replaces
   * (replacedStates). The update is idempotent, so a failure is retried once right away; when
   * that fails too the step is recorded with status mislukt and an oslc:Error (the goedkeuring
   * with it), the request becomes mislukt and the caller gets a 409. A hertoepassing applies the
   * stored versions again.
   */
  async function applyOrFail(request, versions, step, states = [], decision = null) {
    const query = applyQuery({ request, step, decision, versions, states, model, graphs });
    try {
      try {
        await db.update(query);
      } catch (firstError) {
        console.warn(`Applying change request ${request.uri} failed, retrying once:`, firstError?.message || firstError);
        await db.update(query);
      }
    } catch (error) {
      console.error(`Applying change request ${request.uri} failed:`, error);
      const message = error?.message || String(error);
      try {
        await db.update(markFailedQuery({ request, step: { ...step, error: newError(message) }, decision, states, graph: graphs.changeRequests }));
      } catch (markError) {
        console.error(`Recording the failure on ${request.uri} failed too:`, markError);
      }
      throw new HttpError(409, 'Applying the change request failed', {
        detail: `${message}. The request is kept with status mislukt; a hertoepassing (POST /change-requests/${request.uuid}/steps) applies its stored versions again.`,
        meta: { 'change-request': { id: request.uuid, status: 'mislukt' } },
      });
    }
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
      const found = rows(await selectInBatches(db, pairs, (batch) => competingQuery({ pairs: batch }), { size: 200 }));
      const candidateUris = [...new Set(found.map((row) => row.request))].filter((uri) => uri !== applied.uri);
      if (!candidateUris.length) return withdrawn;
      const [recordResult, stepResult, candidateVersions] = await Promise.all([
        db.query(changeRequestsQuery({ requestUris: candidateUris, predicates: organisationPredicates })),
        selectInBatches(db, candidateUris, (batch) => stepsQuery({ requestUris: batch }), { size: 25 }),
        storedVersions(candidateUris),
      ]);
      const written = new Set(pairs.map(({ subject, predicate }) => `${subject} ${predicate}`));
      const stepsOf = stepsByRequest(stepResult);
      const appliedCreated = new Date(applied.created).getTime();
      for (const row of rows(recordResult)) {
        const record = fromRow(row);
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
        withdrawn.push(record.uuid);
      }
    } catch (error) {
      console.error(`Withdrawing the requests that ${applied.uri} replaces failed; they keep waiting:`, error);
    }
    return withdrawn;
  }

  /** A request record from a row of changeRequestsQuery; a creation that still waits shows its proposed organisation. */
  const fromRow = (row) => ({
    uri: row.request,
    uuid: row.uuid,
    status: row.status,
    created: row.created,
    aggregate: row.aggregate,
    kind: kindOf(row.aggregate),
    targetUri: row.target,
    targetUuid: row.targetUuid ?? row.proposedUuid ?? null,
    targetName: row.targetName ?? row.proposedName ?? null,
    targetClassificationUuid: row.targetClassificationUuid ?? row.proposedClassificationUuid ?? null,
    pending: !row.targetUuid,
    actorUri: row.requestingOrganisation,
    actorUuid: row.requestingOrganisationUuid,
    creatorUri: row.creator,
    replacedByUuid: row.replacedByUuid ?? null,
  });

  /**
   * The organisation a creation registers: the one create of an organisation type among the
   * operations, with its lid, a minted uuid and URI (the target of the request) and the
   * classification it proposes (the uuid of the classification concept).
   */
  function organisationToCreate(operations) {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw unprocessable('"operations" must be a non-empty array', '/data/attributes/operations');
    }
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
    const base = model.get(data.type).newResourceBase;
    if (!base) throw unprocessable(`the model has no new-resource-base for "${data.type}"`, pointer('data/type'));
    const classification = data.relationships?.classification?.data;
    const classificationId = isObject(classification) && typeof classification.id === 'string' ? classification.id : null;
    const uuid = mintUuid();
    const name = typeof data.attributes?.name === 'string' ? data.attributes.name : null;
    return { lid: data.lid, type: data.type, uuid, uri: base + uuid, classificationId, name };
  }

  /**
   * The KBO numbers a creation proposes: the local ids of the structured identifiers behind the
   * identifiers named KBO nummer, with the pointer of the value.
   */
  function kboNumbersOf(operations) {
    const structured = new Map();
    for (const operation of operations) {
      const data = operation?.data;
      if (operation?.op === 'create' && isObject(data) && data.type === 'structured-identifiers' && typeof data.lid === 'string') structured.set(data.lid, data);
    }
    const numbers = [];
    operations.forEach((operation, index) => {
      const data = operation?.data;
      if (operation?.op !== 'create' || !isObject(data) || data.type !== 'identifiers' || data.attributes?.['id-name'] !== KBO_ID_NAME) return;
      const lid = data.relationships?.['structured-identifier']?.data?.lid;
      const localId = typeof lid === 'string' ? structured.get(lid)?.attributes?.['local-id'] : undefined;
      if (typeof localId === 'string' && localId.trim()) numbers.push({ localId: localId.trim(), where: `/data/attributes/operations/${index}/data/relationships/structured-identifier` });
    });
    return numbers;
  }

  /**
   * A creation that proposes a KBO number the register already holds, or that a pending creation
   * already proposes, is refused with 409: a samenwerkingsverband is registered once.
   */
  async function refuseDuplicateRegistration(operations) {
    for (const { localId, where } of kboNumbersOf(operations)) {
      const holder = await organisationWithIdentifier(db, { idName: KBO_ID_NAME, localId, predicates: identifierPredicates, classes: organisationClasses });
      if (holder) {
        throw new HttpError(409, 'An organisation with this KBO number is already registered', {
          detail: `KBO number ${localId} belongs to organisation "${holder.uuid}"`,
          pointer: where,
          meta: { 'kbo-number': localId, organisation: { type: TARGET_TYPE, id: holder.uuid } },
        });
      }
      const pending = rows(await db.query(pendingIdentifierQuery({ aggregates: creationAggregates, idName: KBO_ID_NAME, localId, predicates: identifierPredicates })))[0];
      if (pending) {
        throw new HttpError(409, 'A request to register an organisation with this KBO number is already waiting', {
          detail: `KBO number ${localId} is proposed by change request "${pending.uuid}"`,
          pointer: where,
          meta: { 'kbo-number': localId, 'change-request': { id: pending.uuid } },
        });
      }
    }
  }

  /** POST /change-requests */
  async function create(session, body) {
    const { aggregateName, operations, target: targetRef, reason } = parseBody(body);
    const aggregate = config.aggregates[aggregateName];
    if (!aggregate) {
      throw unprocessable(
        `unknown aggregate "${aggregateName}"; configured: ${Object.keys(config.aggregates).join(', ')}`,
        '/data/attributes/aggregate',
      );
    }
    const kind = aggregateKind(aggregate);
    if (kind === 'creation') {
      if (targetRef) {
        throw unprocessable('a request to register an organisation has no target: the organisation does not exist yet', '/data/relationships/target');
      }
      const creation = organisationToCreate(operations);
      const classification = creation.classificationId ? ((await resolveResources(db, [creation.classificationId])).get(creation.classificationId)?.uri ?? null) : null;
      const target = {
        uri: creation.uri,
        uuid: creation.uuid,
        classification,
        classificationUuid: classification ? creation.classificationId : null,
        name: creation.name,
        classes: model.classTree(creation.type),
        pending: true,
      };
      return withLock(target.uri, () => submit(session, { aggregateName, aggregate, kind, operations, target, creation, reason }));
    }
    if (!targetRef) throw unprocessable('the "target" relationship must identify an organisation by type and id', '/data/relationships/target');
    if (!model.has(targetRef.type) || !model.isSubtypeOf(targetRef.type, TARGET_TYPE)) {
      throw unprocessable(`the target must be of type ${TARGET_TYPE} or a subtype, got "${targetRef.type}"`, '/data/relationships/target/data/type');
    }
    const target = await requireTarget(targetRef.id);
    return withLock(target.uri, () => submit(session, { aggregateName, aggregate, kind, operations, target, creation: null, reason }));
  }

  async function submit(session, { aggregateName, aggregate, kind, operations, target, creation, reason }) {
    const ctx = policyContext(session, target, { aggregate: aggregateName, kind, operations });
    const allowed = await evaluate(creation ? canCreate : canEdit, ctx);
    if (allowed.decision !== 'allow') throw forbidden(allowed, creation ? 'Not allowed to request this organisation' : undefined);
    if (creation) await refuseDuplicateRegistration(operations);

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
    // What the masters hold now and what links to the records it deletes, read under the lock: a
    // request on the same organisation that was being applied a moment ago is part of it.
    const [current, incoming] = await Promise.all([
      currentTerms(db, carriedPairs(built.versions)),
      incomingTerms(db, incomingPairs(built.versions, model)),
    ]);
    const settled = settleVersions({ versions: built.versions, current, incoming, model, aggregateName, mintUuid });
    const versions = settled.versions;

    const request = {
      uri: REQUEST_BASE + requestUuid,
      uuid: requestUuid,
      status: STATUS.ingediend,
      created,
      aggregate: aggregateName,
      kind,
      targetUri: target.uri,
      targetUuid: target.uuid,
      pending: Boolean(creation),
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
    await db.update(requestInsertQuery({ request, step: submission, versions, graph: graphs.changeRequests }));

    const approval = await evaluate(autoApprove, { ...ctx, conflicts: rendered, competing });
    if (approval.decision !== 'allow') {
      return { status: 201, document: serialise(request, { steps: [submission], conflicts: rendered, competing, lids: built.lids, viewer }) };
    }
    // Approved at once: the service's goedkeuring, then the afhandeling that applies the versions.
    // A rule that approves despite conflicts overrides them, as the states the apply replaces keep.
    const decision = serviceStep({ type: 'goedkeuring', status: 'goedgekeurd', sequence: 2, at: clock(), rule: approval.rule });
    const handling = serviceStep({ type: 'afhandeling', status: 'afgehandeld', sequence: 3, at: clock() });
    const states = replacedStates({ versions, current, incoming, model, mintUuid });
    handling.overriddenConflicts = rendered.map(overriddenForm);
    await applyOrFail(request, versions, handling, states, decision);
    const superseded = await supersedeOlder(request, versions);
    // The withdrawn requests no longer compete.
    const stillCompeting = competing
      .map((key) => ({ ...key, 'competing-requests': key['competing-requests'].filter((uuid) => !superseded.includes(uuid)) }))
      .filter((key) => key['competing-requests'].length);
    return {
      status: 201,
      document: serialise({ ...request, status: STATUS.afgehandeld, pending: false }, { steps: [submission, decision, handling], competing: stillCompeting, lids: built.lids, superseded, viewer }),
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
   * first unless sorted otherwise, filtered (parseListQuery). Steps, versions and current values
   * are read for the requests of the page only. Returns { documents, count }, count the number of
   * requests over all pages.
   */
  async function list(session, { target: targetUuid, statuses = [], kinds = [], mine = false, requester, targetClassification, created = {}, sort = 'created', page = { number: 0, size: DEFAULT_PAGE_SIZE } } = {}) {
    const none = { documents: [], count: 0 };
    const filters = {
      visibility: visibilityOf(session),
      statuses,
      aggregates: kinds.length ? kinds.flatMap((kind) => aggregatesOfKind(config, kind)) : undefined,
      creatorUri: mine ? session.person : undefined,
      createdFrom: created.from,
      createdUntil: created.until,
    };
    if (mine && !filters.creatorUri) return none;
    if (kinds.length && !filters.aggregates.length) return none;
    if (targetUuid !== undefined) {
      const target = await findOrganisation(db, targetUuid, model);
      if (!target) return none;
      filters.targetUri = target.uri;
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
    const byUri = new Map(rows(recordResult).map((row) => [row.request, fromRow(row)]));
    const records = requestUris.map((uri) => byUri.get(uri)).filter(Boolean);
    return { documents: await documents(session, records, stepsByRequest(stepResult)), count };
  }

  /** A request the session may see, with its steps, or a 404. */
  const loadVisible = async (session, uuid) => {
    const filters = { uuid, visibility: visibilityOf(session) };
    const [requestResult, stepResult] = await Promise.all([
      db.query(changeRequestsQuery({ ...filters, predicates: organisationPredicates })),
      db.query(stepsQuery(filters)),
    ]);
    const row = rows(requestResult)[0];
    if (!row) throw new HttpError(404, 'Change request not found', { detail: `No change request with id "${uuid}" is visible to this organisation` });
    const record = fromRow(row);
    return { record, steps: stepsByRequest(stepResult).get(record.uri) || [] };
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
   * (canEdit on the target, canCreate for a creation). 403 when the policy denies, 409 when the
   * request's status does not admit the step. A goedkeuring records the decision and the
   * afhandeling that applies the stored versions, planned against the current values, with the
   * states it replaces; a hertoepassing applies them again. Both are refused when a record the
   * request updates was deleted since. A goedkeuring re-checks the conflicts and answers 409 with
   * them and their token unless override is that token: the approver overrides exactly the
   * conflicts they reviewed, which the states the apply replaced keep (overriddenConflicts). A
   * hertoepassing is refused when a request on the same organisation that changed something was
   * applied after this one failed, since the stored versions would overwrite what it changed.
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
        : stepType === 'hertoepassing' ? (record.kind === 'creation' ? canCreate : canEdit)
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
      if (!TRANSITIONS[stepType].from.includes(status)) throw transitionError(uuid, status, stepType);
      const viewer = viewerOf(session, record);

      // A request written before steps existed counts its unrecorded indiening as step 1.
      const step = personStep(session, { type: stepType, sequence: (steps.at(-1)?.sequence ?? 1) + 1, at: clock(), rule: outcome.rule, reason });
      const leadsTo = TRANSITIONS[stepType].to;
      if (leadsTo) {
        const taken = { ...step, status: leadsTo };
        await db.update(stepQuery({ request: record, step: taken, graphs }));
        return { status: 201, document: serialise({ ...record, status: STATUS[leadsTo] }, { steps: [...steps, taken], viewer }) };
      }

      const versions = await storedVersions([record.uri]);
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
      if (missing.length) throw missingRecordsError(uuid, missing, stepType);
      const incoming = await incomingTerms(db, storedIncomingPairs(versions, model));
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
        document: serialise({ ...record, status: STATUS.afgehandeld, pending: false }, { steps: [...steps, ...(decision ? [decision] : []), applying], superseded, viewer }),
      };
    });
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
