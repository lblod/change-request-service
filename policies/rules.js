// One function per rule, each: async (ctx) => "allow" | "deny" | undefined.
//
// ctx: { session, account, actor: { uri, uuid, classification },
//        target: { uri, uuid, classification }, aggregate, operations, config }
//
// A rule that has no opinion returns undefined and the next rule is asked. Later rules slot in
// here without touching the flow: memberOfTargetPartnership (a membership from the actor to the
// target exists in the application graph), targetTypeIn([...]), aggregateIn([...]).

/** The acting organisation edits itself. */
export const ownOrganisation = async (ctx) => (ctx.actor.uri === ctx.target.uri ? 'allow' : undefined);

/** ABB (config.abbUri) edits everything. */
export const abbEditsAll = async (ctx) => (ctx.actor.uri === ctx.config.abbUri ? 'allow' : undefined);

/** Always allows; the auto-approve policy of iteration 1. */
export const always = async () => 'allow';
