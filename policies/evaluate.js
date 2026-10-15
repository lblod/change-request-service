/** The name a rule is reported under: ownOrganisation -> own-organisation. */
export function ruleName(rule) {
  return rule.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Evaluates an ordered list of rules: the first rule that answers decides, no answer means deny.
 * Returns { decision: 'allow' | 'deny', rule: name of the deciding rule or null }.
 */
export async function evaluate(rules, ctx) {
  for (const rule of rules) {
    const answer = await rule(ctx);
    if (answer === 'allow' || answer === 'deny') return { decision: answer, rule: ruleName(rule) };
    if (answer !== undefined) {
      throw new Error(`Rule ${ruleName(rule)} answered ${JSON.stringify(answer)}; expected "allow", "deny" or undefined`);
    }
  }
  return { decision: 'deny', rule: null };
}
