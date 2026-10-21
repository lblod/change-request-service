import { app, query, update } from 'mu';
import bodyParser from 'body-parser';
import { MODEL_DIR, CONFIG_FILE, APPLICATION_GRAPH, CHANGE_REQUESTS_GRAPH } from './constants.js';
import { loadModel } from './lib/model.js';
import { loadConfig } from './lib/config.js';
import { createService, parseListQuery, pageLinks } from './lib/change-requests.js';
import { requireSession } from './lib/session.js';
import { HttpError } from './lib/errors.js';

// The template's query/update forward the user's session and send DEFAULT_MU_AUTH_SCOPE;
// sparql-parser decides what that scope may read and write. No sudo anywhere.
const db = { query, update };

const model = loadModel(MODEL_DIR);
const config = loadConfig(CONFIG_FILE, model);
const service = createService({ model, config, db });

// The template parses application/vnd.api+json bodies up to MAX_BODY_SIZE before any route
// runs (its server.js), so that variable is the one limit; the Dockerfile sets it to 5mb. The
// route below parses application/json, which the template leaves alone, with the same limit.
const bodyLimit = process.env.MAX_BODY_SIZE || '100kb';

console.log(
  `change-request-service: ${model.names().length} resource types from ${MODEL_DIR}; ` +
    `aggregates ${Object.keys(config.aggregates).join(', ')}; ` +
    `graphs ${APPLICATION_GRAPH} and ${CHANGE_REQUESTS_GRAPH}; ` +
    `scope ${process.env.DEFAULT_MU_AUTH_SCOPE || '(none: set DEFAULT_MU_AUTH_SCOPE)'}; body limit ${bodyLimit}`,
);

// An id (a uuid) never holds control characters; one that does would only reach the triplestore
// to fail there after a long wait.
const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);

app.param('id', (req, _res, next, id) => {
  next(isId(id) ? undefined : new HttpError(404, 'Change request not found', { detail: 'No change request has this id' }));
});

// The bodies of the POST routes are JSON (application/json, or application/vnd.api+json, which
// the template parses); anything else is refused before it is read.
const acceptsJson = (req, _res, next) => {
  if (req.is('application/json') || req.is('application/vnd.api+json')) return next();
  next(new HttpError(415, 'Unsupported media type', { detail: 'Send the body as application/json or application/vnd.api+json' }));
};

// Before /change-requests/:id, or "permissions" would be taken for an id. With ?target= the
// rights on that organisation; without, the rights of the session itself (which organisations
// it may request, whether it decides).
app.get('/change-requests/permissions', async (req, res, next) => {
  try {
    const session = await requireSession(db, req);
    const target = req.query.target;
    if (target !== undefined && !isId(target)) {
      throw new HttpError(400, 'Invalid target', { detail: 'Pass the uuid of the organisation as ?target=, or leave it out' });
    }
    res.status(200).json(await service.permissions(session, target));
  } catch (error) {
    next(error);
  }
});

// One page of requests: ?filter[target]=<uuid>&filter[status]=ingediend&page[number]=0&page[size]=20
app.get('/change-requests', async (req, res, next) => {
  try {
    const session = await requireSession(db, req);
    const query = parseListQuery(req.query);
    const { documents, count } = await service.list(session, query);
    res.status(200).json({ data: documents, meta: { count }, links: pageLinks(query, count) });
  } catch (error) {
    next(error);
  }
});

app.get('/change-requests/:id', async (req, res, next) => {
  try {
    const session = await requireSession(db, req);
    res.status(200).json({ data: await service.get(session, req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.post('/change-requests', acceptsJson, bodyParser.json({ type: 'application/json', limit: bodyLimit }), async (req, res, next) => {
  try {
    const session = await requireSession(db, req);
    const { status, document } = await service.create(session, req.body);
    res.status(status).json({ data: document });
  } catch (error) {
    next(error);
  }
});

// A step on an existing request: goedkeuring, afkeuring, informatievraag, informatieantwoord,
// betwisting, intrekking or hertoepassing.
app.post('/change-requests/:id/steps', acceptsJson, bodyParser.json({ type: 'application/json', limit: bodyLimit }), async (req, res, next) => {
  try {
    const session = await requireSession(db, req);
    const { status, document } = await service.addStep(session, req.params.id, req.body);
    res.status(status).json({ data: document });
  } catch (error) {
    next(error);
  }
});

// Applies the stored versions of a failed request (status mislukt) again: a hertoepassing step.
app.post('/change-requests/:id/apply', async (req, res, next) => {
  try {
    const session = await requireSession(db, req);
    const { status, document } = await service.apply(session, req.params.id);
    res.status(status).json({ data: document });
  } catch (error) {
    next(error);
  }
});

// JSON:API error documents; unexpected errors are logged and answered with a 500.
app.use((error, _req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ errors: [error.toJSON()] });
  } else if (error?.type === 'entity.too.large') {
    // body-parser, the template's as well as the route's
    res.status(413).json({ errors: [{ status: '413', title: 'Request body too large', detail: `The body exceeds MAX_BODY_SIZE (${bodyLimit})` }] });
  } else if (error?.type === 'entity.parse.failed') {
    res.status(400).json({ errors: [{ status: '400', title: 'Malformed JSON', detail: error.message }] });
  } else if (typeof error?.status === 'number' && error.status >= 400 && error.status < 500) {
    res.status(error.status).json({ errors: [{ status: String(error.status), title: error.message }] });
  } else {
    console.error(error);
    res.status(500).json({ errors: [{ status: '500', title: 'Internal server error' }] });
  }
});
