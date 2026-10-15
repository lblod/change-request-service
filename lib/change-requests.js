import { v4 as uuidv4 } from 'uuid';
import {
  APPLICATION_GRAPH,
  CHANGE_REQUESTS_GRAPH,
  REQUEST_BASE,
  ACTION_BASE,
  ERROR_BASE,
  STATUS,
  STATUS_KEYS,
  STEP_TYPE_KEYS,
  RESERVED_STEP_TYPE_KEYS,
  SERVICE_AGENT,
  TARGET_TYPE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  NS,
  statusKey,
  stepTypeKey,
} from '../constants.js';
import { HttpError, unprocessable } from './errors.js';
import {
  findOrganisation,
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
} from './queries.js';
import { rows, selectInBatches } from './sparql-result.js';
import { createLock } from './lock.js';
import { isSetKey } from './values.js';
import { canEdit, autoApprove, canDecide, canWithdraw, supersede, evaluate } from '../policies/index.js';

const toIso = (value) => new Date(value).toISOString();
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The steps a request can take: the statuses each one follows, and the status it leads to.
 * A goedkeuring and a hertoepassing apply the versions, so the apply decides: goedgekeurd when it
 * lands, mislukt when it fails. An indiening is only the first step of POST /change-requests.
 * A request whose apply failed can also be rejected or withdrawn, so one that cannot be applied
 * any more (a record it changes was deleted since) does not stay mislukt for good.
 * goedgekeurd, afgekeurd and ingetrokken are final.
 */
const TRANSITIONS = {
  indiening: { from: [] },
  goedkeuring: { from: ['ingediend'] },
  afkeuring: { from: ['ingediend', 'mislukt'], to: 'afgekeurd' },
  intrekking: { from: ['ingediend', 'mislukt'], to: 'ingetrokken' },
  hertoepassing: { from: ['mislukt'] },
};
const FINAL_STATUSES = ['goedgekeurd', 'afgekeurd', 'ingetrokken'];
const STEP_ENDPOINT_TYPES = ['goedkeuring', 'afkeuring', 'intrekking', 'hertoepassing'];
// The steps that apply the versions of a request; they record the states they replaced.
const APPLYING_STEP_TYPES = ['goedkeuring', 'hertoepassing'];

/**
 * The API form of a step. person is the uuid of the person who took it (null for the service),
 * error the message of its oslc:Error, overridden-conflicts the conflicts it applied the request
 * despite (derived from the states it replaced, see overriddenConflicts), as the approver saw them
 * without their competing requests.
 */
function stepJson(step) {
  const byService = step.agent === SERVICE_AGENT;
  const overridden = step.overriddenConflicts ?? [];
  return {
    sequence: step.sequence,
    type: step.type,
    status: step.status,
    at: toIso(step.at),
    agent: byService ? 'service' : 'user',
    person: byService ? null : step.personUuid ?? null,
    organisation: step.organisationUuid ?? null,
    rule: step.rule ?? null,
    reason: step.reason ?? null,
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

/**
 * The JSON:API resource object of a request record with its steps (ordered by sequence), its
 * conflicts and the keys other pending requests compete for (rendered). status is the request's
 * status (statusOf), applied-at the start of the last step with status goedgekeurd, error the
 * error message of the last step, conflicts-token the token that overrides exactly these
 * conflicts in a goedkeuring, replaced-by the uuid of the newer request that replaced this one
 * (dct:isReplacedBy, see supersedeOlder).
 */
export function serialise(record, { steps = [], conflicts = [], competing = [], lids, superseded } = {}) {
  const last = steps.at(-1);
  const applied = steps.filter((step) => step.status === 'goedgekeurd').at(-1);
  const attributes = {
    status: statusOf(record, steps),
    created: toIso(record.created),
    'applied-at': applied ? toIso(applied.at) : null,
    aggregate: record.aggregate,
    error: last?.error?.message ?? null,
    steps: steps.map(stepJson),
    conflicts,
    'conflicts-token': conflictsToken(conflicts),
    competing,
    'replaced-by': record.replacedByUuid ?? null,
  };
  if (lids) attributes.lids = lids;
  // On the answer of an apply: the older pending requests it replaced (see supersedeOlder).
  if (superseded) attributes.superseded = superseded;
  return {
    type: 'change-requests',
    id: record.uuid,
    attributes,
    relationships: {
      target: { data: { type: TARGET_TYPE, id: record.targetUuid } },
      'requesting-organisation': { data: { type: TARGET_TYPE, id: record.actorUuid } },
    },
  };
}

function parseBody(body) {
  const data = body?.data;
  if (!data || typeof data !== 'object') throw unprocessable('the body must be a JSON:API document with "data"', '/data');
  if (data.type !== 'change-requests') throw unprocessable('"type" must be "change-requests"', '/data/type');
  const attributes = data.attributes ?? {};
  if (typeof attributes.aggregate !== 'string') throw unprocessable('"aggregate" is required', '/data/attributes/aggregate');
  const target = data.relationships?.target?.data;
  if (!target || typeof target !== 'object' || typeof target.type !== 'string' || typeof target.id !== 'string') {
    throw unprocessable('the "target" relationship must identify an organisation by type and id', '/data/relationships/target');
  }
  return { aggregateName: attributes.aggregate, operations: attributes.operations, target };
}

/**
 * The body of POST /change-requests/:id/steps: { stepType, reason, override }. override is the
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
  if (!STEP_TYPE_KEYS.includes(stepType)) {
    throw unprocessable(`unknown step type ${JSON.stringify(stepType ?? null)}; one of ${STEP_ENDPOINT_TYPES.join(', ')}`, '/data/attributes/step-type');
  }
  const reason = attributes.reason ?? null;
  if (reason !== null && typeof reason !== 'string') throw unprocessable('"reason" must be a string', '/data/attributes/reason');
  const given = reason !== null && reason.trim() !== '';
  if (stepType === 'afkeuring' && !given) throw unprocessable('an afkeuring needs a reason', '/data/attributes/reason');
  const override = attributes.override ?? null;
  if (override !== null && override !== false && (typeof override !== 'string' || !override)) {
    throw unprocessable(
      '"override" must be the "conflicts-token" of the conflicts you reviewed (GET /change-requests/:id, or the 409 of a goedkeuring), so the approval overrides those and no others',
      '/data/attributes/override',
    );
  }
  return { stepType, reason: given ? reason : null, override: typeof override === 'string' ? override : null };
}

/**
 * The query parameters of GET /change-requests: filter[target] (an organisation uuid),
 * filter[status] (status keys, comma-separated), page[number] (from 0) and page[size] (1 to
 * MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE when absent). A malformed value is a 400.
 */
export function parseListQuery(query = {}) {
  const invalid = (detail) => new HttpError(400, 'Invalid query parameter', { detail });
  const filter = isObject(query.filter) ? query.filter : {};
  const target = filter.target;
  if (target !== undefined && typeof target !== 'string') throw invalid('filter[target] must be the uuid of an organisation');
  let statuses = [];
  if (filter.status !== undefined) {
    if (typeof filter.status !== 'string') throw invalid(`filter[status] must be one or more of ${STATUS_KEYS.join(', ')}, comma-separated`);
    statuses = [...new Set(filter.status.split(',').map((status) => status.trim()).filter(Boolean))];
    const unknown = statuses.filter((status) => !STATUS_KEYS.includes(status));
    if (unknown.length || !statuses.length) throw invalid(`filter[status]: unknown status ${JSON.stringify(unknown[0] ?? filter.status)}; one of ${STATUS_KEYS.join(', ')}`);
  }
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
    page: { number: whole(page.number, 'number', 0, Number.MAX_SAFE_INTEGER, 0), size: whole(page.size, 'size', 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE) },
  };
}

/** The JSON:API pagination links of a listing (first, last, and prev and next where they exist). */
export function pageLinks({ target, statuses, page }, count) {
  const link = (number) => {
    const params = new URLSearchParams();
    if (target !== undefined) params.set('filter[target]', target);
    if (statuses.length) params.set('filter[status]', statuses.join(','));
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

const fromRow = (row) => ({
  uri: row.request,
  uuid: row.uuid,
  status: row.status,
  created: row.created,
  aggregate: row.aggregate,
  targetUri: row.target,
  targetUuid: row.targetUuid,
  actorUri: row.requestingOrganisation,
  actorUuid: row.requestingOrganisationUuid,
  creatorUri: row.creator,
  replacedByUuid: row.replacedByUuid ?? null,
});

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
  const seesAll = (session) => session.actor.uri === config.abbUri;

  // The predicates that lead from a target to the records of its aggregate, per aggregate.
  const paths = Object.fromEntries(
    Object.entries(config.aggregates).map(([name, aggregate]) => [name, pathPredicates(model, aggregate)]),
  );

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
  // The oslc:Error of a failed apply.
  const newError = (message) => {
    const uuid = mintUuid();
    return { uri: ERROR_BASE + uuid, uuid, message, at: clock() };
  };

  /** GET /change-requests/permissions?target=uuid */
  async function permissions(session, targetUuid) {
    const target = await requireTarget(targetUuid);
    const outcome = await evaluate(canEdit, policyContext(session, target));
    return { 'can-edit': outcome.decision === 'allow', rules: outcome.rule ? [outcome.rule] : [] };
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
   * The conflicts the applying steps (goedkeuring, hertoepassing) of requests overrode, rendered
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
   * Applies the versions to the application graph with the step that applies them and the states
   * it replaces (replacedStates). The update is idempotent, so a failure is retried once right
   * away; when that fails too the step is recorded with status mislukt and an oslc:Error, the
   * request becomes mislukt and the caller gets a 409. A hertoepassing applies the stored versions
   * again.
   */
  async function applyOrFail(request, versions, step, states = []) {
    const query = applyQuery({ request, step, versions, states, model, graphs });
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
        await db.update(markFailedQuery({ request, step: { ...step, error: newError(message) }, states, graph: graphs.changeRequests }));
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
        db.query(changeRequestsQuery({ requestUris: candidateUris })),
        selectInBatches(db, candidateUris, (batch) => stepsQuery({ requestUris: batch }), { size: 25 }),
        storedVersions(candidateUris),
      ]);
      const written = new Set(pairs.map(({ subject, predicate }) => `${subject} ${predicate}`));
      const stepsOf = stepsByRequest(stepResult);
      const appliedCreated = new Date(applied.created).getTime();
      for (const row of rows(recordResult)) {
        const record = fromRow(row);
        const steps = stepsOf.get(record.uri) || [];
        if (record.targetUri !== applied.targetUri || statusOf(record, steps) !== 'ingediend') continue;
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
        const step = newStep({
          type: 'intrekking',
          status: 'ingetrokken',
          sequence: (steps.at(-1)?.sequence ?? 1) + 1,
          at: clock(),
          agent: SERVICE_AGENT,
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

  /** POST /change-requests */
  async function create(session, body) {
    const { aggregateName, operations, target: targetRef } = parseBody(body);
    const aggregate = config.aggregates[aggregateName];
    if (!aggregate) {
      throw unprocessable(
        `unknown aggregate "${aggregateName}"; configured: ${Object.keys(config.aggregates).join(', ')}`,
        '/data/attributes/aggregate',
      );
    }
    if (!model.has(targetRef.type) || !model.isSubtypeOf(targetRef.type, TARGET_TYPE)) {
      throw unprocessable(`the target must be of type ${TARGET_TYPE} or a subtype, got "${targetRef.type}"`, '/data/relationships/target/data/type');
    }
    const target = await requireTarget(targetRef.id);
    return withLock(target.uri, () => submit(session, { aggregateName, aggregate, operations, target }));
  }

  async function submit(session, { aggregateName, aggregate, operations, target }) {
    const ctx = policyContext(session, target, { aggregate: aggregateName, operations });
    const edit = await evaluate(canEdit, ctx);
    if (edit.decision !== 'allow') throw forbidden(edit);

    const baseIds = collectBaseReferences(operations);
    const [resources, reachable] = await Promise.all([
      resolveResources(db, [...new Set([...collectReferences(operations), ...baseIds])]),
      reachableFromTarget(db, target.uri, paths[aggregateName]),
    ]);
    const unknownBaseIds = baseIds.filter((id) => !resources.has(id));
    const former = unknownBaseIds.length ? await formerResources(db, unknownBaseIds) : new Map();
    const created = clock();
    const requestUuid = mintUuid();
    const built = buildVersions({ operations, aggregateName, aggregate, model, mintUuid, resources, former, reachable, target });
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
      targetUri: target.uri,
      targetUuid: target.uuid,
      actorUri: session.actor.uri,
      actorUuid: session.actor.uuid,
      creatorUri: session.person,
    };
    const known = new Map([...resources].map(([uuid, { uri }]) => [uri, uuid]));
    for (const [uuid, uri] of former) known.set(uri, uuid);
    for (const version of built.versions) if (version.operation === 'create') known.set(version.masterUri, version.masterUuid);
    const { conflicts, keys, uuids } = await review(versions, settled.conflicts, { requestUri: request.uri, known });
    const rendered = conflicts.map((conflict) => renderConflict(conflict, uuids));
    const competing = keys.map((key) => renderCompeting(key, uuids));

    const submission = personStep(session, { type: 'indiening', status: 'ingediend', sequence: 1, at: created, rule: edit.rule });
    await db.update(requestInsertQuery({ request, step: submission, versions, graph: graphs.changeRequests }));

    const approval = await evaluate(autoApprove, { ...ctx, conflicts: rendered, competing });
    if (approval.decision !== 'allow') {
      return { status: 201, document: serialise(request, { steps: [submission], conflicts: rendered, competing, lids: built.lids }) };
    }
    const decision = newStep({ type: 'goedkeuring', status: 'goedgekeurd', sequence: 2, at: clock(), agent: SERVICE_AGENT, rule: approval.rule });
    // What the masters held when it was applied: what they hold now, read under the lock. A rule
    // that approves despite conflicts overrides them, as the states it replaces keep.
    const states = replacedStates({ versions, current, incoming, model, mintUuid });
    decision.overriddenConflicts = rendered.map(overriddenForm);
    await applyOrFail(request, versions, decision, states);
    const superseded = await supersedeOlder(request, versions);
    // The withdrawn requests no longer compete.
    const stillCompeting = competing
      .map((key) => ({ ...key, 'competing-requests': key['competing-requests'].filter((uuid) => !superseded.includes(uuid)) }))
      .filter((key) => key['competing-requests'].length);
    return {
      status: 201,
      document: serialise({ ...request, status: STATUS.goedgekeurd }, { steps: [submission, decision], competing: stillCompeting, lids: built.lids, superseded }),
    };
  }

  /**
   * The documents of request records: their steps with the conflicts the applying ones overrode,
   * and live conflicts and competing keys for the pending ones.
   */
  async function documents(records, steps) {
    const stepsOf = (record) => steps.get(record.uri) || [];
    const pending = records.filter((record) => statusOf(record, stepsOf(record)) === 'ingediend').map((record) => record.uri);
    const [live] = await Promise.all([liveState(pending), attachOverridden(new Map(records.map((record) => [record.uri, stepsOf(record)])))]);
    return records.map((record) => serialise(record, { steps: stepsOf(record), ...live.get(record.uri) }));
  }

  /**
   * GET /change-requests: one page of the requests the acting organisation may see (ABB sees
   * all), newest first, optionally about one organisation (target) and with given statuses.
   * Steps, versions and current values are read for the requests of the page only. Returns
   * { documents, count }, count the number of requests over all pages.
   */
  async function list(session, { target: targetUuid, statuses = [], page = { number: 0, size: DEFAULT_PAGE_SIZE } } = {}) {
    const visibleTo = seesAll(session) ? null : session.actor.uri;
    let targetUri = null;
    if (targetUuid !== undefined) {
      const target = await findOrganisation(db, targetUuid, model);
      if (!target) return { documents: [], count: 0 };
      targetUri = target.uri;
    }
    const filters = { targetUri, visibleTo, statuses };
    const [pageResult, countResult] = await Promise.all([
      db.query(requestPageQuery({ ...filters, limit: page.size, offset: page.number * page.size })),
      db.query(requestCountQuery(filters)),
    ]);
    const count = Number(rows(countResult)[0]?.count ?? 0);
    const requestUris = [...new Set(rows(pageResult).map((row) => row.request))];
    if (!requestUris.length) return { documents: [], count };
    const [recordResult, stepResult] = await Promise.all([
      db.query(changeRequestsQuery({ requestUris })),
      selectInBatches(db, requestUris, (batch) => stepsQuery({ requestUris: batch }), { size: 25 }),
    ]);
    const byUri = new Map(rows(recordResult).map((row) => [row.request, fromRow(row)]));
    const records = requestUris.map((uri) => byUri.get(uri)).filter(Boolean);
    return { documents: await documents(records, stepsByRequest(stepResult)), count };
  }

  /** A request the acting organisation may see, with its steps, or a 404. */
  const loadVisible = async (session, uuid) => {
    const filters = { uuid, visibleTo: seesAll(session) ? null : session.actor.uri };
    const [requestResult, stepResult] = await Promise.all([db.query(changeRequestsQuery(filters)), db.query(stepsQuery(filters))]);
    const row = rows(requestResult)[0];
    if (!row) throw new HttpError(404, 'Change request not found', { detail: `No change request with id "${uuid}" is visible to this organisation` });
    const record = fromRow(row);
    return { record, steps: stepsByRequest(stepResult).get(record.uri) || [] };
  };

  /** GET /change-requests/:id */
  async function get(session, uuid) {
    const { record, steps } = await loadVisible(session, uuid);
    const [document] = await documents([record], new Map([[record.uri, steps]]));
    return document;
  }

  /**
   * A step on an existing request: a goedkeuring or an afkeuring (canDecide), an intrekking
   * (canWithdraw), a hertoepassing (canEdit on the target). 403 when the policy denies, 409 when
   * the request's status does not admit the step. A goedkeuring and a hertoepassing apply the
   * stored versions with the step, planned against the current values, and record the states
   * they replace; both are refused when a record the request updates was deleted since. A
   * goedkeuring re-checks the conflicts and answers 409 with them and their token unless override
   * is that token: the approver overrides exactly the conflicts they reviewed, which the states
   * the step replaced keep (overriddenConflicts). A hertoepassing is refused when a request on the
   * same organisation that changed something was applied after this one failed, since the stored
   * versions would overwrite what it changed.
   */
  async function takeStep(session, uuid, { stepType, reason = null, override = null }) {
    const { record: found } = await loadVisible(session, uuid);
    return withLock(found.targetUri, async () => {
      const { record, steps } = await loadVisible(session, uuid);
      const status = statusOf(record, steps);
      const target = await requireTarget(record.targetUuid);
      const rules = { intrekking: canWithdraw, hertoepassing: canEdit }[stepType] || canDecide;
      const outcome = await evaluate(
        rules,
        policyContext(session, target, {
          aggregate: record.aggregate,
          operations: [],
          request: { uri: record.uri, uuid: record.uuid, status, aggregate: record.aggregate, requestingOrganisation: record.actorUri },
        }),
      );
      if (outcome.decision !== 'allow') throw forbidden(outcome, `Not allowed to take a ${stepType} step on this change request`);
      if (!TRANSITIONS[stepType].from.includes(status)) throw transitionError(uuid, status, stepType);

      // A request written before steps existed counts its unrecorded indiening as step 1.
      const step = personStep(session, { type: stepType, sequence: (steps.at(-1)?.sequence ?? 1) + 1, at: clock(), rule: outcome.rule, reason });
      const leadsTo = TRANSITIONS[stepType].to;
      if (leadsTo) {
        const taken = { ...step, status: leadsTo };
        await db.update(stepQuery({ request: record, step: taken, graphs }));
        return { status: 201, document: serialise({ ...record, status: STATUS[leadsTo] }, { steps: [...steps, taken] }) };
      }

      const versions = await storedVersions([record.uri]);
      if (stepType === 'hertoepassing') {
        const failedAt = steps.at(-1)?.at ?? record.created;
        const later = rows(await db.query(laterAppliedQuery({ targetUri: record.targetUri, after: failedAt, exclude: record.uri })))[0];
        if (later) {
          throw new HttpError(409, 'A change request on this organisation has been applied since this one failed', {
            detail: `Change request "${later.uuid}" was applied on ${toIso(later.appliedAt)}; submit the change again instead of applying this one`,
            meta: { 'change-request': { id: later.uuid, status: 'goedgekeurd' } },
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
      // The answer shows them; the states the step replaces keep them (attachOverridden reads them back).
      step.overriddenConflicts = rendered.map(overriddenForm);
      const applied = { ...step, status: 'goedgekeurd' };
      const present = (version) => (current.get(`${version.masterUri} ${NS.rdf}type`) || []).length > 0;
      const states = replacedStates({ versions, current, incoming, model, mintUuid, present });
      await applyOrFail(record, planStored(versions, current, model), applied, states);
      const superseded = await supersedeOlder(record, versions);
      return { status: 201, document: serialise({ ...record, status: STATUS.goedgekeurd }, { steps: [...steps, applied], superseded }) };
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
