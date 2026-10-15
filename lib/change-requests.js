import { v4 as uuidv4 } from 'uuid';
import { APPLICATION_GRAPH, CHANGE_REQUESTS_GRAPH, REQUEST_BASE, STATUS, STATUS_BASE, TARGET_TYPE } from '../constants.js';
import { HttpError, unprocessable } from './errors.js';
import { findOrganisation, resolveResources, reachableFromTarget, currentObjects } from './organisations.js';
import { buildVersions, collectReferences, pathPredicates, versionsFromStore } from './versions.js';
import {
  requestInsertQuery,
  applyQuery,
  markFailedQuery,
  changeRequestsQuery,
  storedVersionsQuery,
  laterAppliedQuery,
} from './queries.js';
import { rows } from './sparql-result.js';
import { canEdit, autoApprove, evaluate } from '../policies/index.js';

const toIso = (value) => new Date(value).toISOString();
const statusKey = (uri) => (uri.startsWith(STATUS_BASE) ? uri.slice(STATUS_BASE.length) : uri);

/** The JSON:API resource object of a request record. */
export function serialise(record, { lids } = {}) {
  const attributes = {
    status: statusKey(record.status),
    created: toIso(record.created),
    'applied-at': record.appliedAt ? toIso(record.appliedAt) : null,
    aggregate: record.aggregate,
  };
  if (record.error) attributes.error = record.error;
  if (lids) attributes.lids = lids;
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

  const forbidden = (outcome) =>
    new HttpError(403, 'Not allowed to edit this organisation', {
      detail: outcome.rule ? `Denied by rule ${outcome.rule}` : 'No rule allows it',
      meta: { rule: outcome.rule, rules: outcome.rule ? [outcome.rule] : [] },
    });

  const requireTarget = async (uuid) => {
    const target = await findOrganisation(db, uuid, model);
    if (!target) throw new HttpError(404, 'Target organisation not found', { detail: `No organisation with id "${uuid}"` });
    return target;
  };

  /** GET /change-requests/permissions?target=uuid */
  async function permissions(session, targetUuid) {
    const target = await requireTarget(targetUuid);
    const outcome = await evaluate(canEdit, policyContext(session, target));
    return { 'can-edit': outcome.decision === 'allow', rules: outcome.rule ? [outcome.rule] : [] };
  }

  /**
   * A relationship a document carries without the aggregate admitting it must equal what the
   * master holds: the aggregate does not allow changing it, and ignoring it would lose an edit.
   */
  async function requireUnchanged(versions, aggregateName) {
    const checks = versions.flatMap((version) => version.unchanged.map((check) => ({ ...check, subject: version.masterUri })));
    if (!checks.length) return;
    const current = await currentObjects(db, checks.map(({ subject, predicate }) => ({ subject, predicate })));
    for (const check of checks) {
      const now = current.get(`${check.subject} ${check.predicate}`);
      const wanted = new Set(check.objects);
      const same = now.size === wanted.size && [...wanted].every((object) => now.has(object));
      if (!same) {
        throw unprocessable(
          `relationship "${check.name}" is not part of the aggregate "${aggregateName}" and cannot be changed through it`,
          check.where,
        );
      }
    }
  }

  /**
   * Applies the versions to the application graph. The update is idempotent, so a failure is
   * retried once right away; when that fails too the request is marked mislukt with the error
   * and the caller gets a 409. The stored versions can be applied again with apply().
   */
  async function applyOrFail(request, versions, appliedAt) {
    const query = applyQuery({ request, versions, model, appliedAt, graphs });
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
        await db.update(markFailedQuery({ requestUri: request.uri, message, graph: graphs.changeRequests }));
      } catch (markError) {
        console.error(`Recording the failure on ${request.uri} failed too:`, markError);
      }
      throw new HttpError(409, 'Applying the change request failed', {
        detail: `${message}. The request is kept with status mislukt; POST /change-requests/${request.uuid}/apply applies its stored versions again.`,
        meta: { 'change-request': { id: request.uuid, status: 'mislukt' } },
      });
    }
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

    const ctx = policyContext(session, target, { aggregate: aggregateName, operations });
    const edit = await evaluate(canEdit, ctx);
    if (edit.decision !== 'allow') throw forbidden(edit);

    const [resources, reachable] = await Promise.all([
      resolveResources(db, collectReferences(operations)),
      reachableFromTarget(db, target.uri, paths[aggregateName]),
    ]);
    const created = clock();
    const requestUuid = mintUuid();
    const { versions, lids } = buildVersions({ operations, aggregateName, aggregate, model, mintUuid, resources, reachable, target });
    await requireUnchanged(versions, aggregateName);

    const request = {
      uri: REQUEST_BASE + requestUuid,
      uuid: requestUuid,
      created,
      aggregate: aggregateName,
      targetUri: target.uri,
      targetUuid: target.uuid,
      actorUri: session.actor.uri,
      actorUuid: session.actor.uuid,
      accountUri: session.account,
    };
    await db.update(requestInsertQuery({ request, versions, graph: graphs.changeRequests }));

    const approval = await evaluate(autoApprove, ctx);
    if (approval.decision !== 'allow') {
      return { status: 201, document: serialise({ ...request, status: STATUS.ingediend }, { lids }) };
    }

    const appliedAt = clock();
    await applyOrFail(request, versions, appliedAt);
    return { status: 201, document: serialise({ ...request, status: STATUS.goedgekeurd, appliedAt }, { lids }) };
  }

  const fromRow = (row) => ({
    uri: row.request,
    uuid: row.uuid,
    status: row.status,
    created: row.created,
    appliedAt: row.appliedAt,
    aggregate: row.aggregate,
    targetUri: row.target,
    targetUuid: row.targetUuid,
    actorUri: row.requestingOrganisation,
    actorUuid: row.requestingOrganisationUuid,
    accountUri: row.account,
    error: row.error,
  });

  /** GET /change-requests?filter[target]=uuid */
  async function list(session, targetUuid) {
    const visibleTo = seesAll(session) ? null : session.actor.uri;
    let targetUri = null;
    if (targetUuid !== undefined) {
      const target = await findOrganisation(db, targetUuid, model);
      if (!target) return [];
      targetUri = target.uri;
    }
    const result = await db.query(changeRequestsQuery({ targetUri, visibleTo }));
    return rows(result).map(fromRow).map((record) => serialise(record));
  }

  const requireVisible = async (session, uuid) => {
    const visibleTo = seesAll(session) ? null : session.actor.uri;
    const row = rows(await db.query(changeRequestsQuery({ uuid, visibleTo })))[0];
    if (!row) throw new HttpError(404, 'Change request not found', { detail: `No change request with id "${uuid}" is visible to this organisation` });
    return fromRow(row);
  };

  /** GET /change-requests/:id */
  async function get(session, uuid) {
    return serialise(await requireVisible(session, uuid));
  }

  /**
   * POST /change-requests/:id/apply: applies the stored versions of a request that failed
   * (status mislukt) again. The same policy as a POST decides, and the re-apply is refused when
   * a later request on the organisation was applied since, because the stored versions would
   * overwrite what it changed; the change is then submitted again instead.
   */
  async function apply(session, uuid) {
    const record = await requireVisible(session, uuid);
    if (record.status !== STATUS.mislukt) {
      throw new HttpError(409, 'Only a failed change request can be applied again', {
        detail: `Change request "${uuid}" has status ${statusKey(record.status)}`,
      });
    }
    const target = await requireTarget(record.targetUuid);
    const edit = await evaluate(canEdit, policyContext(session, target, { aggregate: record.aggregate, operations: [] }));
    if (edit.decision !== 'allow') throw forbidden(edit);

    const later = rows(await db.query(laterAppliedQuery({ targetUri: record.targetUri, after: record.created })))[0];
    if (later) {
      throw new HttpError(409, 'A later change request on this organisation has been applied since', {
        detail: `Change request "${later.uuid}" was applied on ${toIso(later.appliedAt)}; submit the change again instead of applying this one`,
        meta: { 'change-request': { id: later.uuid, status: 'goedgekeurd' } },
      });
    }

    const versions = versionsFromStore(await db.query(storedVersionsQuery({ requestUri: record.uri })), model);
    if (!versions.length) {
      throw new HttpError(409, 'The change request has no stored versions to apply', { detail: `Nothing is stored for change request "${uuid}"` });
    }
    const appliedAt = clock();
    await applyOrFail(record, versions, appliedAt);
    return { status: 200, document: serialise({ ...record, status: STATUS.goedgekeurd, appliedAt, error: null }) };
  }

  return { permissions, create, list, get, apply };
}
