// The SPARQL the service sends, parsed as SPARQL 1.1 in the tests: the stand-in for the triplestore
// answers queries by their shape, so without this a query that Virtuoso would refuse as malformed
// passes every test. sparqljs is a development dependency only (scripts/setup-ide.sh installs it).
import sparqljs from 'sparqljs';

const parser = new sparqljs.Parser();

/** Returns the query (or update) when it parses as SPARQL 1.1; throws with the query when it does not. */
export function parses(query) {
  try {
    parser.parse(query);
  } catch (error) {
    throw new Error(`Not valid SPARQL 1.1: ${error.message}\n${query}`);
  }
  return query;
}
