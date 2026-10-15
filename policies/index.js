import { abbEditsAll, ownOrganisation, always } from './rules.js';

// Ordered: the first rule that answers decides; no answer means deny.
export const canEdit = [abbEditsAll, ownOrganisation];
export const autoApprove = [always];

export { evaluate, ruleName } from './evaluate.js';
