import {
  abbEditsAll,
  ownOrganisation,
  mayCreateClassification,
  editsApplyAtOnce,
  conflictsWaitForReview,
  abbAutoApproves,
  abbDecidesAll,
  requestingOrganisation,
  supersededByOwnRequest,
} from './rules.js';

// Ordered: the first rule that answers decides; no answer means deny.

// Who may submit an edit or a change-event request on an organisation that exists.
export const canEdit = [abbEditsAll, ownOrganisation];
// Who may request a new organisation of the classification the request proposes.
export const canCreate = [abbEditsAll, mayCreateClassification];
// Whether a submitted request is applied at once (a goedkeuring by the service) or waits for ABB:
// edits always, creations and change events only ABB's own, and those only when they conflict
// with nothing (ABB then approves them on the request with the conflicts token).
export const autoApprove = [editsApplyAtOnce, conflictsWaitForReview, abbAutoApproves];
// Who applies a request whose apply failed again (hertoepassing): ABB and the organisation that
// submitted it, whatever the request's kind.
export const canReapply = [abbEditsAll, requestingOrganisation];
// Who approves (goedkeuring), rejects (afkeuring) or asks for information (informatievraag).
export const canDecide = [abbDecidesAll];
// Who answers a question (informatieantwoord) or contests a rejection (betwisting).
export const canReply = [requestingOrganisation];
// Who withdraws a pending request (intrekking).
export const canWithdraw = [abbEditsAll, requestingOrganisation];
// Which older pending requests about the same organisation a request that was just applied
// replaces; the service withdraws them (an intrekking it takes itself).
export const supersede = [supersededByOwnRequest];

// Who sees a request is not a rule list but a filter on the listing (lib/change-requests.js), set
// by config.pendingVisibleTo: "everyone" shows every request to every logged-in user, "involved"
// shows a request that still waits only to the requesting organisation, the organisation it is
// about and ABB. ABB always sees everything, and everyone sees a decided request. What a viewer
// sees of a request also depends on who they are: the person who submitted it, the texts of its
// steps (questions, answers, reasons) and the error of a failed apply are shown to the requesting
// organisation and ABB only. The list leaves edits out unless asked for them: they are the
// history of the data, not requests anyone acts on.

export { evaluate, ruleName } from './evaluate.js';
