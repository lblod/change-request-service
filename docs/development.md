# Development

## Running the service in app-lokale-verkenner

The configuration and the model are mounted side by side (`docker-compose.yml`):

```yaml
change-requests:
  image: lblod/change-request-service:0.1.0
  environment:
    DEFAULT_MU_AUTH_SCOPE: "http://services.lblod.info/change-request-service"
    APPLICATION_GRAPH: "http://mu.semte.ch/graphs/public"
    CONFIG_FILE: "/config/change-requests/change-requests.json"
  volumes:
    - ./config/change-requests:/config/change-requests:ro
    - ./config/resources:/config/resources:ro
```

```elixir
match "/change-requests/*path", %{accept: [:json], layer: :api} do
  Proxy.forward(conn, path, "http://change-requests/change-requests/")
end
```

- The template talks to `http://database:8890/sparql`, which is sparql-parser in app-lokale-verkenner.
- A model that loads only part of OP's files may hold relationships to types it does not define;
  the service logs them at start-up and leaves them out, as mu-cl-resources only fails when such
  a relationship is used (app-lokale-verkenner loads `domain.json`, `auth.json` and
  `change-events.json`; the creation and change-event aggregates need the last one).
- A mounted checkout (`docker-compose.dev.yml`: `NODE_ENV: development`, sources at `/app`) does not
  get the Dockerfile's `ENV`, so set `MAX_BODY_SIZE` in the compose file.
- Every type an aggregate names must exist in the model, and a reference cannot also be a member,
  or the service refuses to start.

## Tests and scripts

```sh
npm run setup      # once: installs the template's node_modules, its `mu` helper and the dev dependencies (needs docker)
npm test           # unit tests (node:test) against OP's model files; runs on Node 20, the template's
MODEL_DIR=../app-lokale-verkenner/config/resources npm test   # the same against app-lokale-verkenner's files
npm run check      # node --check app.js
```

- The tests read the model from `MODEL_DIR`, by default `../app-organization-portal/config/resources`.
  They assert on the types both models define, so the suite holds for either.
- `test/fixtures/*.sparql` are golden copies of the generated updates for a small
  organization-core-data request; `UPDATE_GOLDEN=1 npm test` rewrites them after an intended
  change. Review the diff.
- The service tests run against a stand-in for the triplestore that answers each query by its
  shape. Every query and update it receives is parsed as SPARQL 1.1 first (`test/support/sparql.js`,
  with the dev dependency sparqljs, deprecated upstream but enough for a syntax check), so a
  malformed query fails the test that sends it. It does not check what sparql-parser accepts:
  sparql-parser 0.0.15 refuses some valid SPARQL (`GROUP BY` over two variables), which only the
  end-to-end script finds. The read-backs of a submission and an apply (`verifyWrites`) are tested
  with a stand-in of their own.
- `scripts/e2e-mock-login.sh` runs the whole flow against app-lokale-verkenner as a browser would: through
  mu-identifier, logged in with mock-login as two gemeenten and ABB. It covers the permissions; an
  edit applied at once with its steps, listed only when edits are asked for, and an edit that
  changes nothing (not stored); refused cross-organisation requests and refused direct,
  forged-scope and forged-groups writes; the paged listings and their limits; a stale edit (409, the
  same form changing another field without reverting the first); what a vestiging may change; a
  new organisation through the whole validation flow (question, answer, rejection, contest,
  approval) with its oprichting, result and date in the register; KBO numbers (normalised, required
  but for an ILV, unique, claimed again at approval); ABB's own registration; a withdrawal; a
  veranderingsgebeurtenis approved over a conflict and the overridden conflict read back from the
  replaced state; ABB's own stale change event that waits for its goedkeuring; a new vestiging, a
  second one from a page that did not show the first (the lists merge), a delete from a stale page;
  the graphs the records land in, the history keeping its links to deleted records. It puts the
  data back at the end, also when interrupted (a trap), including A's audit stamps, so it can run
  again. It refuses a `SPARQL_ENDPOINT` that is not on this machine (it writes there directly;
  `E2E_ALLOW_REMOTE=1` overrides). Run it while nobody else writes to the stack. Needs `curl` and
  `python3`; `BASE_URL` (default `http://localhost:88`), `SPARQL_ENDPOINT` (default
  `http://localhost:8899/sparql`), `ORG_A_LABEL`, `ORG_B_LABEL` can be set.
- `scripts/integration.sh` runs a larger set of calls (validation errors, body limits, the re-apply
  endpoint) with the sessions sent as a raw `mu-session-id` header, which only works on a port that
  bypasses mu-identifier (the dispatcher's or the service's). See its header for the variables.

## Datatypes

`lib/literals.js` turns a JSON:API attribute value into an RDF term per attribute `type` of the
model. It mirrors what mu-cl-resources writes (`framework/request-parsing.lisp`) for a stack with
`*use-custom-boolean-type-p*` set to nil, as OP's `domain.lisp` does; `test/literals.test.js`
compares the two for the values of one organisation.

| model type | written as |
| --- | --- |
| `string` | plain literal |
| `uri` | plain literal: mu-cl-resources has no `uri` write type, the value takes its default path |
| `url` | IRI; the value must be an absolute URI without whitespace or `< > " { } \| ^ \` \\` |
| `date`, `datetime`, `time`, `g-year` | `xsd:date`, `xsd:dateTime` (normalised to UTC), `xsd:time`, `xsd:gYear` |
| `number`, `integer`, `float` | `xsd:decimal`, `xsd:integer`, `xsd:float` |
| `boolean` | `xsd:boolean` |
| `string-set`, `uri-set` | one literal or IRI per value (IRIs checked as for `url`) |
| `language-string`, `language-string-set` | `"content"@language` from `{ "content", "language" }` |
| `geometry` | `geo:wktLiteral` |

A value that does not fit its type is a 422. Every term is rendered with the template's
`sparqlEscape` helpers. Unknown types fall back to `string`, as mu-cl-resources does.

## Code map

| File | Holds |
| --- | --- |
| `app.js` | the routes |
| `lib/change-requests.js` | the flow: submit, list, get, steps, apply, supersede |
| `lib/versions.js` | building versions from operations, the base rule, record states, reading stored versions |
| `lib/conflicts.js` | live and overridden conflicts, competing requests, the token |
| `lib/queries.js` | every SPARQL query and update |
| `lib/organisations.js` | reading records: the target, the aggregate, current values, links |
| `lib/session.js` | the session: account, organisation, person |
| `lib/model.js`, `lib/config.js` | the resources model and the aggregates configuration |
| `lib/literals.js`, `lib/values.js` | datatypes, and comparing values |
| `lib/lock.js` | the lock per organisation (and per KBO number) |
| `lib/kbo.js` | KBO numbers: their forms and how they are compared |
| `policies/` | the rules |
| `constants.js` | URIs, graphs, the code lists |
| `vocabulary/change-requests.ttl` | the `cr:` vocabulary |
