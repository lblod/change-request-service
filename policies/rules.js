// One function per rule, each: async (ctx) => "allow" | "deny" | undefined.
//
// ctx: { session, account, actor: { uri, uuid, classification },
//        target: { uri, uuid, classification }, aggregate, operations, config }
// plus, for autoApprove, conflicts (the conflicts of the request) and competing (the keys it
// writes that other pending requests propose something else for), both as the API renders them
// (see lib/conflicts.js), and for the steps of an existing request,
// request: { uri, uuid, status, aggregate, requestingOrganisation }.
// The supersede rules get { applied, candidate, config } instead: applied: { uri, uuid,
// requestingOrganisation, target } is the request that was just applied, candidate: { uri, uuid,
// requestingOrganisation, fullyCovered } an older pending request about the same organisation
// that writes one of its keys.
//
// A rule that has no opinion returns undefined and the next rule is asked. Later rules slot in
// here without touching the flow: memberOfTargetPartnership (a membership from the actor to the
// target exists in the application graph), targetTypeIn([...]), aggregateIn([...]).

/** The acting organisation edits itself. */
export const ownOrganisation = async (ctx) => (ctx.actor.uri === ctx.target.uri ? 'allow' : undefined);

/** ABB (config.abbUri) edits everything. */
export const abbEditsAll = async (ctx) => (ctx.actor.uri === ctx.config.abbUri ? 'allow' : undefined);

/** ABB decides on every pending request: it approves (goedkeuring) or rejects (afkeuring) it. */
export const abbDecidesAll = async (ctx) => (ctx.actor.uri === ctx.config.abbUri ? 'allow' : undefined);

/** The organisation that submitted a request withdraws it. */
export const requestingOrganisation = async (ctx) =>
  ctx.request && ctx.actor.uri === ctx.request.requestingOrganisation ? 'allow' : undefined;

/** A request with conflicts is not approved automatically: it waits for ABB's decision. */
export const holdOnConflict = async (ctx) => (ctx.conflicts?.length ? 'deny' : undefined);

/**
 * A request that was just applied replaces an older pending request of the same organisation
 * when it rewrote every key the older one proposes (candidate.fullyCovered). The older request
 * is then withdrawn by the service. An older request with other keys, set keys, creates or
 * deletes is not fully covered and keeps waiting for ABB, as does one of another organisation.
 */
export const supersededByOwnRequest = async (ctx) =>
  ctx.candidate.fullyCovered && ctx.candidate.requestingOrganisation === ctx.applied.requestingOrganisation ? 'allow' : undefined;

/** Always allows; the last rule of autoApprove. */
export const always = async () => 'allow';
