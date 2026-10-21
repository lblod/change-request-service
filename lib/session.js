import { sparqlEscapeUri } from 'mu';
import { PREFIXES } from '../constants.js';
import { HttpError } from './errors.js';
import { rows } from './sparql-result.js';

/**
 * Resolves the mu-session-id header into the account, the person and the acting organisation,
 * as mock-login and the login service write them: <session> session:account ?account ;
 * ext:sessionGroup ?organisation, and ?person foaf:account ?account. The person is who the
 * service records: the dct:creator of a request, the agent of the steps the session takes and the
 * ext:lastModifiedBy of what a request changes, as everywhere else in lblod. The organisation's
 * classification is loaded for the policy context. A session that names two organisations or an
 * account with two persons is ambiguous: who acts would depend on the order of the rows, so it
 * is refused (null) rather than one of them taken.
 *
 * db: { query } from the template; it forwards the session and the service scope.
 */
export async function resolveSession(db, sessionUri) {
  if (typeof sessionUri !== 'string' || !sessionUri) return null;
  const result = await db.query(`${PREFIXES}

SELECT DISTINCT ?account ?accountUuid ?person ?personUuid ?organisation ?organisationUuid ?classification
WHERE {
  ${sparqlEscapeUri(sessionUri)} session:account ?account ;
    ext:sessionGroup ?organisation .
  ?organisation mu:uuid ?organisationUuid .
  OPTIONAL { ?account mu:uuid ?accountUuid . }
  OPTIONAL {
    ?person foaf:account ?account .
    OPTIONAL { ?person mu:uuid ?personUuid . }
  }
  OPTIONAL { ?organisation org:classification ?classification . }
}
ORDER BY ?account ?organisation ?person ?classification
LIMIT 10`);
  const found = rows(result);
  const row = found[0];
  if (!row) return null;
  const actors = new Set(found.map((other) => `${other.account} ${other.organisation} ${other.person ?? ''}`));
  if (actors.size > 1) {
    console.warn(`Session ${sessionUri} names ${actors.size} accounts, organisations or persons; refused as ambiguous`);
    return null;
  }
  return {
    session: sessionUri,
    account: row.account,
    accountUuid: row.accountUuid || null,
    person: row.person || null,
    personUuid: row.personUuid || null,
    actor: { uri: row.organisation, uuid: row.organisationUuid, classification: row.classification || null },
  };
}

/** The session of a request, or a 401: no account, no acting organisation or no person. */
export async function requireSession(db, req) {
  const session = await resolveSession(db, req.get('mu-session-id'));
  if (!session) {
    throw new HttpError(401, 'Not logged in', {
      detail: 'The session has no account or no acting organisation',
    });
  }
  if (!session.person) {
    throw new HttpError(401, 'Not logged in', {
      detail: `The account of the session (${session.account}) is not linked to a person (foaf:account)`,
    });
  }
  return session;
}
