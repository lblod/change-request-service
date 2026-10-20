// Graph URIs, file locations and vocabularies the service uses. Everything here can be
// overridden through the environment; the defaults match the plan for app-lokale-verkenner.

export const APPLICATION_GRAPH =
  process.env.APPLICATION_GRAPH || process.env.MU_APPLICATION_GRAPH || 'http://mu.semte.ch/application';
export const CHANGE_REQUESTS_GRAPH =
  process.env.CHANGE_REQUESTS_GRAPH || 'http://mu.semte.ch/graphs/change-requests';

export const CONFIG_FILE = process.env.CONFIG_FILE || '/config/change-requests.json';
export const MODEL_DIR = process.env.MODEL_DIR || '/config/resources';

// The URIs the service mints, http://data.lblod.info/id/<type-plural>/<uuid> as in the rest of lblod.
export const REQUEST_BASE = 'http://data.lblod.info/id/change-requests/';
// cr:ProposedVersion: the proposed state of one record.
export const VERSION_BASE = 'http://data.lblod.info/id/proposed-versions/';
// cr:Action: a step of a request (indiening, goedkeuring, ...).
export const ACTION_BASE = 'http://data.lblod.info/id/change-request-actions/';
// cr:RecordState: the values some keys of a record had at one moment, either the state a version
// started from (cr:base) or the state an apply replaced (prov:invalidated).
export const RECORD_STATE_BASE = 'http://data.lblod.info/id/record-states/';
// rdf:Statement: a link that pointed at a deleted record (cr:incomingLink of a record state).
export const LINK_BASE = 'http://data.lblod.info/id/record-links/';
// oslc:Error: why an apply failed, in the shape job-controller and delta-consumer write theirs.
export const ERROR_BASE = 'http://redpencil.data.gift/id/jobs/error/';

// The two code lists (published as SKOS by app-lokale-verkenner's migrations): the status of a
// request, and the type of its steps. The statuses follow the validation flow of the designs:
// ingediend (the request is being validated), informatie-gevraagd (ABB asked the requester for
// more information), afgekeurd, goedgekeurd (ABB or the service approved it, it is being
// applied), afgehandeld (applied: the register holds it), ingetrokken and mislukt (the apply
// failed). "wijziging" (an edit of a pending request) is reserved: it has a concept but the
// service does not take it; a pending request is answered, contested or withdrawn, never amended.
export const STATUS_SCHEME = 'http://lblod.data.gift/concept-schemes/e8274055-0834-4511-8b84-a2af41055633';
export const STATUS = {
  ingediend: 'http://lblod.data.gift/concepts/d57aff85-43ce-4bd0-b962-6bd1b1fbc4b6',
  'informatie-gevraagd': 'http://lblod.data.gift/concepts/f628da38-1583-4bfc-b3f3-eb41a7708944',
  goedgekeurd: 'http://lblod.data.gift/concepts/ca080d1f-f71c-4fe6-a4ed-a13fe1112989',
  afgehandeld: 'http://lblod.data.gift/concepts/362d4aee-2fe3-45b3-a7ef-8602b8516bf0',
  afgekeurd: 'http://lblod.data.gift/concepts/b53c0c43-aa7c-4eb4-b113-81a370c21014',
  ingetrokken: 'http://lblod.data.gift/concepts/3dd55ff1-c322-4660-819d-4641de440544',
  mislukt: 'http://lblod.data.gift/concepts/b610e2dc-902c-4874-b65e-78b7f6411c05',
};
export const STATUS_KEYS = Object.keys(STATUS);
// A request that still waits for a decision: its conflicts are checked live, it competes with
// other requests and a newer request of the same organisation can replace it.
export const PENDING_STATUS_KEYS = ['ingediend', 'informatie-gevraagd'];

export const STEP_TYPE_SCHEME = 'http://lblod.data.gift/concept-schemes/65c4cf4a-f29f-45c9-aa71-498969638e42';
export const STEP_TYPE = {
  indiening: 'http://lblod.data.gift/concepts/9ea4e33a-1745-4159-9a24-5706bad7ab38',
  informatievraag: 'http://lblod.data.gift/concepts/f2665331-48f1-4830-a7c7-0d5a692b7b3d',
  informatieantwoord: 'http://lblod.data.gift/concepts/886d2ed1-34c0-4642-b0f2-cd1e1960738e',
  goedkeuring: 'http://lblod.data.gift/concepts/bb2bb632-fc9f-41c6-a1eb-8f50e4008551',
  afhandeling: 'http://lblod.data.gift/concepts/7f55ec41-b1fe-4145-acf1-15cb2cb13cd2',
  afkeuring: 'http://lblod.data.gift/concepts/765d7fc7-b078-4273-84c1-a7a84b61498e',
  betwisting: 'http://lblod.data.gift/concepts/61e0e81d-bb69-422a-86c9-faa0df69514c',
  intrekking: 'http://lblod.data.gift/concepts/850f35c4-4333-4e6f-ab5a-ea3a2355cc5b',
  hertoepassing: 'http://lblod.data.gift/concepts/942ed957-87e0-477e-9afe-1bc0aedd6771',
  wijziging: 'http://lblod.data.gift/concepts/814430cf-ccb2-40b9-a057-d8a9cbc6bfdb',
};
export const RESERVED_STEP_TYPE_KEYS = ['wijziging'];
export const STEP_TYPE_KEYS = Object.keys(STEP_TYPE).filter((key) => !RESERVED_STEP_TYPE_KEYS.includes(key));

// The kinds of aggregate (config/change-requests.json): an edit of records of an organisation
// that exists, a request to register a new organisation (creation) and a request to register a
// veranderingsgebeurtenis (change-event). Edits are applied at once; the other two wait for ABB.
export const KINDS = ['edit', 'creation', 'change-event'];

const keysByUri = (concepts) => new Map(Object.entries(concepts).map(([key, uri]) => [uri, key]));
const STATUS_KEY_BY_URI = keysByUri(STATUS);
const STEP_TYPE_KEY_BY_URI = keysByUri(STEP_TYPE);
/** The key of a status concept (ingediend, ...); an unknown URI is returned as it is. */
export const statusKey = (uri) => STATUS_KEY_BY_URI.get(uri) ?? uri;
/** The key of a step type concept (indiening, ...); an unknown URI is returned as it is. */
export const stepTypeKey = (uri) => STEP_TYPE_KEY_BY_URI.get(uri) ?? uri;

export const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  mu: 'http://mu.semte.ch/vocabularies/core/',
  ext: 'http://mu.semte.ch/vocabularies/ext/',
  session: 'http://mu.semte.ch/vocabularies/session/',
  cr: 'http://lblod.data.gift/vocabularies/change-requests/',
  dct: 'http://purl.org/dc/terms/',
  pav: 'http://purl.org/pav/',
  adms: 'http://www.w3.org/ns/adms#',
  prov: 'http://www.w3.org/ns/prov#',
  schema: 'http://schema.org/',
  foaf: 'http://xmlns.com/foaf/0.1/',
  task: 'http://redpencil.data.gift/vocabularies/tasks/',
  oslc: 'http://open-services.net/ns/core#',
  as: 'https://www.w3.org/ns/activitystreams#',
  org: 'http://www.w3.org/ns/org#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
};

// cr:operation of a version: the ActivityStreams classes LDES 1.0 uses to mark a create, an update
// or a delete, as values (the version is not typed with them, so it does not become an activity).
export const OPERATION = {
  create: `${NS.as}Create`,
  update: `${NS.as}Update`,
  delete: `${NS.as}Delete`,
};
const OPERATION_KEY_BY_URI = keysByUri(OPERATION);
/** The key (create, update, delete) of an operation IRI, or null for an unknown one. */
export const operationKey = (uri) => OPERATION_KEY_BY_URI.get(uri) ?? null;

// prov:wasAssociatedWith of a step the service took by itself (an automatic goedkeuring, an
// intrekking of a request a newer one replaced), and dct:creator of the errors it records.
export const SERVICE_AGENT = 'http://lblod.data.gift/services/change-request-service';

// The JSON:API type every request target must be, or a subtype of (administrative-units, ...).
export const TARGET_TYPE = 'organizations';

// The most rows the triplestore returns for one SELECT: Virtuoso's ResultSetMaxRows (10000 in
// app-lokale-verkenner's virtuoso.ini). Virtuoso cuts a larger result off without an error, so a result that
// reaches this many rows is taken as cut off: the service queries smaller batches instead.
export const SPARQL_MAX_ROWS = Number.parseInt(process.env.SPARQL_MAX_ROWS, 10) || 10000;

// GET /change-requests is paged: page[size] defaults to DEFAULT_PAGE_SIZE, at most MAX_PAGE_SIZE.
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const PREFIXES = Object.entries(NS)
  .map(([prefix, uri]) => `PREFIX ${prefix}: <${uri}>`)
  .join('\n');
