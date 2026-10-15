// Graph URIs, file locations and vocabularies the service uses. Everything here can be
// overridden through the environment; the defaults match the plan for app-rvs.

export const APPLICATION_GRAPH =
  process.env.APPLICATION_GRAPH || process.env.MU_APPLICATION_GRAPH || 'http://mu.semte.ch/application';
export const CHANGE_REQUESTS_GRAPH =
  process.env.CHANGE_REQUESTS_GRAPH || 'http://mu.semte.ch/graphs/change-requests';

export const CONFIG_FILE = process.env.CONFIG_FILE || '/config/change-requests.json';
export const MODEL_DIR = process.env.MODEL_DIR || '/config/resources';

export const REQUEST_BASE = 'http://data.lblod.info/id/change-requests/';
export const VERSION_BASE = 'http://data.lblod.info/id/versions/';

export const STATUS_BASE = 'http://lblod.data.gift/concepts/change-request-status/';
export const STATUS_KEYS = ['ingediend', 'goedgekeurd', 'afgekeurd', 'ingetrokken', 'mislukt'];
export const STATUS = Object.fromEntries(STATUS_KEYS.map((key) => [key, STATUS_BASE + key]));

// The JSON:API type every request target must be, or a subtype of (administrative-units, ...).
export const TARGET_TYPE = 'organizations';

export const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  mu: 'http://mu.semte.ch/vocabularies/core/',
  ext: 'http://mu.semte.ch/vocabularies/ext/',
  session: 'http://mu.semte.ch/vocabularies/session/',
  cr: 'http://lblod.data.gift/vocabularies/change-requests/',
  dct: 'http://purl.org/dc/terms/',
  adms: 'http://www.w3.org/ns/adms#',
  prov: 'http://www.w3.org/ns/prov#',
  org: 'http://www.w3.org/ns/org#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
};

export const PREFIXES = Object.entries(NS)
  .map(([prefix, uri]) => `PREFIX ${prefix}: <${uri}>`)
  .join('\n');
