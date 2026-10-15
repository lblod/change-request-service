import { sparqlEscapeString, sparqlEscapeUri } from 'mu';
import { SPARQL_MAX_ROWS } from '../constants.js';

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

/**
 * Runs a SELECT over a list of items in batches of `size`: buildQuery(batch) returns the query
 * for some of the items, and the bindings of all batches are returned together as one SPARQL JSON
 * result. Virtuoso cuts a result off at its row limit (SPARQL_MAX_ROWS) without an error, so a
 * batch whose result reaches the limit is split in two and queried again; one item whose result
 * still reaches it is an error instead of a silently partial answer.
 */
export async function selectInBatches(db, items, buildQuery, { size = 100, maxRows = SPARQL_MAX_ROWS } = {}) {
  const bindings = [];
  const run = async (batch) => {
    const found = (await db.query(buildQuery(batch)))?.results?.bindings || [];
    if (found.length < maxRows) {
      bindings.push(...found);
      return;
    }
    if (batch.length === 1) {
      throw new Error(`A query returned ${found.length} rows, the row limit of the triplestore (SPARQL_MAX_ROWS); its result may be cut off`);
    }
    const half = Math.ceil(batch.length / 2);
    await run(batch.slice(0, half));
    await run(batch.slice(half));
  };
  for (let start = 0; start < items.length; start += size) await run(items.slice(start, start + size));
  return { results: { bindings } };
}
