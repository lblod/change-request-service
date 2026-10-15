import { abbEditsAll, ownOrganisation, abbDecidesAll, requestingOrganisation, holdOnConflict, supersededByOwnRequest, always } from './rules.js';

// Ordered: the first rule that answers decides; no answer means deny.

// Who may submit a request on a target, and apply a failed one again (hertoepassing).
export const canEdit = [abbEditsAll, ownOrganisation];
// Whether a submitted request is applied at once (a goedkeuring by the service) or waits.
export const autoApprove = [holdOnConflict, always];
// Who approves (goedkeuring) or rejects (afkeuring) a pending request.
export const canDecide = [abbDecidesAll];
// Who withdraws a pending request (intrekking).
export const canWithdraw = [abbEditsAll, requestingOrganisation];
// Which older pending requests about the same organisation a request that was just applied
// replaces; the service withdraws them (an intrekking it takes itself).
export const supersede = [supersededByOwnRequest];

export { evaluate, ruleName } from './evaluate.js';
