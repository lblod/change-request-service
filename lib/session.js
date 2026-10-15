import { sparqlEscapeUri } from 'mu';
import { PREFIXES } from '../constants.js';
import { HttpError } from './errors.js';
import { rows } from './sparql-result.js';

/**
 * Resolves the mu-session-id header into the account and the acting organisation, as mock-login
 * writes them: <session> session:account ?account ; ext:sessionGroup ?organisation.
 * The organisation's classification is loaded for the policy context.
 *
 * db: { query } from the template; it forwards the session and the service scope.
 */
export async function resolveSession(db, sessionUri) {
  if (typeof sessionUri !== 'string' || !sessionUri) return null;
  const result = await db.query(`${PREFIXES}

SELECT ?account ?organisation ?organisationUuid ?classification
WHERE {
  ${sparqlEscapeUri(sessionUri)} session:account ?account ;
    ext:sessionGroup ?organisation .
  ?organisation mu:uuid ?organisationUuid .
  OPTIONAL { ?organisation org:classification ?classification . }
}
LIMIT 1`);
  const row = rows(result)[0];
  if (!row) return null;
  return {
    session: sessionUri,
    account: row.account,
    actor: { uri: row.organisation, uuid: row.organisationUuid, classification: row.classification || null },
  };
}

/** The session of a request, or a 401. */
export async function requireSession(db, req) {
  const session = await resolveSession(db, req.get('mu-session-id'));
  if (!session) {
    throw new HttpError(401, 'Not logged in', {
      detail: 'The session has no account or no acting organisation',
    });
  }
  return session;
}
