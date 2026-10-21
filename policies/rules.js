// One function per rule, each: async (ctx) => "allow" | "deny" | undefined.
//
// ctx: { session, account, actor: { uri, uuid, classification },
//        target: { uri, uuid, classification, pending? }, aggregate, kind, operations, config }
// kind is the kind of the aggregate: edit, creation or change-event (lib/config.js). For a
// creation the target is the organisation the request would register: its URI and uuid are minted
// at submission, its classification is the one the document proposes, and pending is true until
// the request is applied. The autoApprove rules also get conflicts (the conflicts of the request)
// and competing (the keys it writes that other pending requests propose something else for), both
// as the API renders them (see lib/conflicts.js), and the rules on the steps of an existing
// request get request: { uri, uuid, status, aggregate, requestingOrganisation }.
// The supersede rules get { applied, candidate, config } instead: applied: { uri, uuid,
// requestingOrganisation, target } is the request that was just applied, candidate: { uri, uuid,
// requestingOrganisation, fullyCovered } an older pending request about the same organisation
// that writes one of its keys.
//
// A rule that has no opinion returns undefined and the next rule is asked. Later rules slot in
// here without touching the flow: memberOfTargetPartnership (a membership from the actor to the
// target exists in the application graph), targetTypeIn([...]), aggregateIn([...]).

/** The acting organisation edits itself, or registers a change event about itself. */
export const ownOrganisation = async (ctx) => (ctx.target && !ctx.target.pending && ctx.actor.uri === ctx.target.uri ? 'allow' : undefined);

/** ABB (config.abbUri) edits everything and requests any organisation. */
export const abbEditsAll = async (ctx) => (ctx.actor.uri === ctx.config.abbUri ? 'allow' : undefined);

/**
 * An organisation requests a new organisation of a classification it manages ("Wie beheert"):
 * config.creatableClassifications maps the classification of the acting organisation to the
 * classifications it may request (a gemeente an AGB, an OCMW a welzijnsvereniging, ...).
 */
export const mayCreateClassification = async (ctx) => {
  const allowed = ctx.config.creatableClassifications?.[ctx.actor.classification] ?? [];
  return ctx.target?.classification && allowed.includes(ctx.target.classification) ? 'allow' : undefined;
};

/** An edit of the records of an organisation that exists (kind edit) is applied at once: no validation. */
export const editsApplyAtOnce = async (ctx) => (ctx.kind === 'edit' ? 'allow' : undefined);

/**
 * A request that conflicts with what changed since its form was loaded waits, also ABB's own: it
 * is applied by a goedkeuring that overrides exactly those conflicts (the conflicts token), so an
 * older form never overwrites newer values unseen. Edits never get here: a conflicting edit is
 * refused before (409).
 */
export const conflictsWaitForReview = async (ctx) => (ctx.conflicts?.length ? 'deny' : undefined);

/** What ABB requests itself (a new organisation, a change event) is applied at once; anyone else's request waits for ABB. */
export const abbAutoApproves = async (ctx) => (ctx.actor.uri === ctx.config.abbUri ? 'allow' : undefined);

/** ABB decides on every pending request: it approves (goedkeuring), rejects (afkeuring) or asks for information (informatievraag). */
export const abbDecidesAll = async (ctx) => (ctx.actor.uri === ctx.config.abbUri ? 'allow' : undefined);

/** The organisation that submitted a request answers for it (informatieantwoord, betwisting) and withdraws it. */
export const requestingOrganisation = async (ctx) =>
  ctx.request && ctx.actor.uri === ctx.request.requestingOrganisation ? 'allow' : undefined;

/**
 * A request that was just applied replaces an older pending request of the same organisation
 * when it rewrote every key the older one proposes (candidate.fullyCovered). The older request
 * is then withdrawn by the service. An older request with other keys, set keys, creates or
 * deletes is not fully covered and keeps waiting for ABB, as does one of another organisation.
 */
export const supersededByOwnRequest = async (ctx) =>
  ctx.candidate.fullyCovered && ctx.candidate.requestingOrganisation === ctx.applied.requestingOrganisation ? 'allow' : undefined;

/** Always allows. */
export const always = async () => 'allow';
