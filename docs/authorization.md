# Authorization

sparql-parser stays the single place where access is defined. The template sends
`DEFAULT_MU_AUTH_SCOPE` with every query and forwards the user's session, so every write is still
attributed to the user in deltas and logs. The service uses no sudo.

## The configuration in app-lokale-verkenner

The organisation data lives in `http://mu.semte.ch/graphs/administrative-unit`, the graph OP keeps
it in, and logged-in sessions read it. The public graph holds the code lists, the locations and the
accounts of mock-login, which everyone reads (`config/authorization/config.lisp`):

```lisp
;; everyone reads it, also without a login: code lists, locations, the mock-login accounts, and of
;; the organisation of a mock account its type and uuid (the mock-login page needs them)
(define-graph public ("http://mu.semte.ch/graphs/public")
  (_ -> _))

;; the organisation data, read by every logged-in session; nobody gets a write grant on this spec
(define-graph organisations ("http://mu.semte.ch/graphs/administrative-unit")
  (_ -> _))

;; the same graph as the service may write it: only the types of its aggregates
(define-graph organisation-data ("http://mu.semte.ch/graphs/administrative-unit")
  ("org:Organization" -> _) ("besluit:Bestuurseenheid" -> _) ("regorg:RegisteredOrganization" -> _)
  ("org:Site" -> _) ("locn:Address" -> _) ("schema:ContactPoint" -> _) ("adms:Identifier" -> _)
  ("generiek:GestructureerdeIdentificator" -> _)
  ;; what a creation or a veranderingsgebeurtenis applies on approval
  ("org:ChangeEvent" -> _) ("code:VeranderingsgebeurtenisResultaat" -> _) ("besluit:Besluit" -> _)
  ("besluitvorming:Beslissingsactiviteit" -> _))

(define-graph change-requests ("http://mu.semte.ch/graphs/change-requests" :delta nil)
  ("cr:ChangeRequest" -> _) ("cr:Action" -> _) ("cr:ProposedVersion" -> _) ("cr:RecordState" -> _)
  ("rdf:Statement" -> _) ("oslc:Error" -> _))

(define-graph sessions ("http://mu.semte.ch/graphs/sessions")
  ("session:Session" -> _))

(supply-allowed-group "public")

;; a session with an organisation and a role, as mock-login (later the login with ACM/IDM) writes it
(supply-allowed-group "logged-in"
  :parameters ()
  :query "... SELECT DISTINCT ?session_group ?session_role WHERE {
            <SESSION_ID> ext:sessionGroup/mu:uuid ?session_group ; ext:sessionRole ?session_role . }")

;; Nobody writes the organisation data directly: every edit is a change request.
(grant (read) :to-graph public :for-allowed-group "public")
(grant (read) :to-graph organisations :for-allowed-group "logged-in")

(with-scope "http://services.lblod.info/change-request-service"
  (grant (read) :to-graph (public organisations sessions) :for-allowed-group "public")
  (grant (read write) :to-graph (organisation-data change-requests) :for-allowed-group "public"))
```

The service's `APPLICATION_GRAPH` is that organisation graph: its updates name it.

## What it rests on

- **The scope header can only come from inside the stack.** mu-identifier 1.11.0 is the first
  version that strips `mu-auth-scope` from what a browser sends (1.10.3 strips `mu-auth-sudo` and
  `mu-auth-allowed-groups` but lets `mu-auth-scope` through). No proxied service may forward an
  incoming `mu-auth-scope`: mu-cl-resources 1.27.2 forwards only `mu-session-id`, `mu-call-id` and
  `mu-auth-allowed-groups`, and the template sets the scope from `DEFAULT_MU_AUTH_SCOPE` only.
  `scripts/integration.sh` checks both: a PATCH with a forged `mu-auth-scope` is refused through
  the dispatcher and, with `IDENTIFIER_URL` set, through the identifier.
- **Scoped grants are the only grants a scoped call gets.** sparql-parser matches a grant on the
  scope of the call (`acl/acl.lisp`, `accessible-graphs`); a grant without `with-scope` belongs to
  the no-scope call only. The service resolves the session with the same scoped query, so the
  scope must also read the graph where mock-login writes `session:account` and `ext:sessionGroup`
  (`sessions`) and the graph of the persons (`foaf:account`; the public graph in app-lokale-verkenner).
- **Placement follows the type specs, not the GRAPH clause.** The service names the graphs in its
  updates (correct on a bare triplestore too), but sparql-parser writes every quad to *every*
  writable graph whose `define-graph` matches the type of its subject, and refuses the update when
  a quad matches none. So every class the service writes must be in a writable spec, and the
  writable spec of the data graph must not be `(_ -> _)`: it would match the service's own records
  too and put them in the data graph, which every logged-in session reads. Hence the second, typed
  spec on the same graph.
- **Reads are per graph.** A group that may read one spec of a graph reads all of that graph: a
  typed spec narrows where writes go, not what a read returns. So the organisation data is in a
  graph of its own rather than in the public one behind a typed read spec. What a visitor without
  a session needs of it, the organisation of a mock account on the mock-login page, is in the
  public graph as its type and uuid, which never change (the migration that moved the data out
  keeps them there).
- **No other write grant on the data graph**, so a direct POST, PATCH or DELETE on a resource route
  has no writable graph and is refused (mu-cl-resources answers 500).
- **Reads see all accessible graphs.** sparql-parser does not narrow a pattern to the graph a
  `GRAPH` clause names, and the scope reads the change-requests graph too, where versions and
  record states hold the same predicates as the records. The queries and the apply that look for
  the links to a record (a tombstone) therefore leave out subjects of type `cr:ProposedVersion` and
  `cr:RecordState`; without that, deleting a record also stripped the stored versions that named
  it. A link a record state remembers is an `rdf:Statement`, which does not hold the predicate.
- sparql-parser 0.0.15 passes the service's property-path query (the records reachable from the
  target), its `VALUES (?s ?p)` queries, the UNIONs and nested OPTIONALs of its step and version
  queries, `FILTER NOT EXISTS`, `COUNT` and `LIMIT`/`OFFSET` through to Virtuoso unchanged.

## Policies

`policies/rules.js` holds one function per rule, `async (ctx) => "allow" | "deny" | undefined`.
`ctx` is `{ session, account, actor: { uri, uuid, classification }, target: { uri, uuid,
classification, pending? }, aggregate, kind, operations, config }`, plus `conflicts` and
`competing` (as the API renders them) for `autoApprove`, and `request: { uri, uuid, status,
aggregate, requestingOrganisation }` for the steps on an existing request. `kind` is the kind of
the aggregate (edit, creation, change-event); for a creation the target is the organisation the
request would register, minted at submission, with the classification the document proposes. The
`supersede` rules get `{ applied: { uri, uuid, requestingOrganisation, target }, candidate: { uri,
uuid, requestingOrganisation, fullyCovered }, config }`.

`policies/index.js` orders them; the first rule that answers decides, no answer means deny:

```js
export const canEdit = [abbEditsAll, ownOrganisation];                                   // an edit or a change event on an existing organisation
export const canCreate = [abbEditsAll, mayCreateClassification];                         // a new organisation of a classification the actor manages
export const autoApprove = [editsApplyAtOnce, conflictsWaitForReview, abbAutoApproves];  // edits always; creations and change events only ABB's own, without conflicts
export const canReapply = [abbEditsAll, requestingOrganisation];                         // hertoepassing
export const canDecide = [abbDecidesAll];                                                // goedkeuring, afkeuring, informatievraag
export const canReply = [requestingOrganisation];                                        // informatieantwoord, betwisting
export const canWithdraw = [abbEditsAll, requestingOrganisation];                        // intrekking
export const supersede = [supersededByOwnRequest];                                       // older pending requests an apply withdraws
```

- The permissions endpoint, the POST and the steps run the same lists; the rule that allowed or
  decided a step is recorded on it (`cr:rule`), under its kebab-case name (`own-organisation`,
  `abb-edits-all`, `may-create-classification`, `edits-apply-at-once`, `abb-auto-approves`,
  `requesting-organisation`). `conflictsWaitForReview` only denies: ABB's own creation or change
  event from a stale form waits for ABB's goedkeuring with the conflicts token, as anyone's would.
- `can-create` without a target evaluates `canCreate` once without a classification: a rule that
  allows that (ABB's `abbEditsAll`) lets the session request every classification of
  `registration.types`.
- `mayCreateClassification` reads `creatableClassifications` of the configuration: the
  classification of the acting organisation maps to the classifications it may request ("Wie
  beheert": a gemeente an AGB, an OCMW a welzijnsvereniging, ...).
- Who sees a request is not a rule list but a filter on the listing: with `pendingVisibleTo`
  `everyone` every logged-in user sees every request; with `involved` an organisation sees the
  requests about it, those it submitted and the decided ones, and ABB all. Whoever sees a request,
  the person who submitted it, the texts of its steps (questions, answers, reasons) and the error
  of a failed apply are shown to the requesting organisation and ABB only. The list leaves edits
  out unless `filter[kind]` asks for them.
- Later rules slot in without touching the flow: `memberOfTargetPartnership`,
  `targetTypeIn([...])`, `aggregateIn([...])`. Holding a request that another pending request
  competes with is a one-line rule (`ctx.competing.length ? 'deny' : undefined`). The service does
  not hold those: a competing request is pending because it was stale, and the newer form is the
  one that saw the current values. Instead `supersededByOwnRequest` withdraws the older request
  when it comes from the same organisation and the newer one rewrote all of its fields.
