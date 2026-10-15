import { sparqlEscapeString, sparqlEscapeUri } from 'mu';

/**
 * Flattens a SPARQL JSON result into plain objects: one per row, variable name -> value.
 */
export function rows(result) {
  return (result?.results?.bindings || []).map((binding) =>
    Object.fromEntries(Object.entries(binding).map(([name, term]) => [name, term.value])),
  );
}

/**
 * Renders one binding of a SPARQL JSON result back into a SPARQL term, so a triple read from
 * the triplestore can be written again as it was: IRIs in angle brackets, literals with their
 * language tag or datatype. Virtuoso reports typed literals as "typed-literal".
 */
export function term(binding) {
  switch (binding.type) {
    case 'uri':
      return sparqlEscapeUri(binding.value);
    case 'literal':
    case 'typed-literal': {
      const literal = sparqlEscapeString(binding.value);
      if (binding['xml:lang']) return `${literal}@${binding['xml:lang']}`;
      if (binding.datatype) return `${literal}^^${sparqlEscapeUri(binding.datatype)}`;
      return literal;
    }
    default:
      throw new Error(`Cannot render a SPARQL term of type "${binding.type}"`);
  }
}
