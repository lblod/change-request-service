# API

All calls need a logged-in session (`mu-session-id`, as mu-identifier sets it): no session, or a
session without account, acting organisation or person, is a 401. Bodies and answers are JSON:API
(`application/vnd.api+json`; the POSTs also accept `application/json`). Bodies up to
`MAX_BODY_SIZE` (5 MB in the image) are accepted; above that the answer is 413.

- [What happens on a POST](#what-happens-on-a-post)
- [`POST /change-requests`](#post-change-requests), [base values](#base-values), [the answer](#the-answer)
- [`GET /change-requests` and `GET /change-requests/:id`](#get-change-requests-and-get-change-requestsid)
- [`POST /change-requests/:id/steps`](#post-change-requestsidsteps)
- [`GET /change-requests/permissions`](#get-change-requestspermissionstargetuuid)
- [Conflicts](#conflicts), [errors](#errors)

## What happens on a POST

1. **Session.** `<session> session:account ?account` and `ext:sessionGroup ?organisation` (the
   Loket shape mock-login writes), and the person of the account (`?person foaf:account ?account`).
2. **Policy.** The `canEdit` rules; denied is a 403 with the rule.
3. **Lock.** Steps 4 to 10 run for one request at a time per target organisation.
4. **Look up records.** The records the operations and their bases name, and the target's
   aggregate: everything reachable from the target over the relationships between the aggregate's
   types (`org:hasSite`, `org:hasPrimarySite`, `org:siteAddress`, `locn:address`, `adms:identifier`,
   `generiek:gestructureerdeIdentificator`, `schema:contactPoint` for the kerngegevens). A base may
   name a record deleted since; it is found through its versions.
5. **Build versions.** One per operation: an update takes the record from its id, a create mints a
   uuid and a URI from the type's `new-resource-base`, a delete gives a tombstone that removes every
   field of its type. Anything that does not fit is a 422 (see the rules below).
6. **Settle.** Read the current value of every field the updates and tombstones carry, and the
   links to the records they delete; apply the [base rule](#base-values). An update that changes
   nothing leaves no version.
7. **Competing requests.** Other pending requests that write the same field of the same record with
   another value.
8. **Write** the request, its indiening step and the versions with their base states, in one
   `INSERT DATA`, status `ingediend`.
9. **Decide.** The `autoApprove` rules: `holdOnConflict` keeps a request with conflicts for ABB,
   `always` approves the rest. Held: 201 with status `ingediend`, the conflicts and their token.
10. **Apply**, one SPARQL update: per version delete the values of the single-valued fields it
    changes and the list values it removes, insert its triples on the record; a create also writes
    the class tree and the uuid; a tombstone deletes the record's triples and the links to it. The
    same update stamps `dct:modified` and `ext:lastModifiedBy` (the person) on the target, adds the
    goedkeuring step with the states it replaced and sets the request to `goedgekeurd`. The update
    is idempotent but not one transaction (sparql-parser sends the effective quads in several
    requests, deletes first), so a failure is retried once; a second failure records the step as
    `mislukt` with an `oslc:Error` and answers 409.
11. **Replace older requests.** The `supersede` rules: a pending request of the same organisation
    about the same target, older, whose every version updates only single-valued fields this
    request wrote, is withdrawn by the service (rule `superseded-by-own-request`, reason
    "Vervangen door wijzigingsaanvraag <uuid>", `dct:isReplacedBy`). A failure here is logged and
    does not undo the apply.
12. **Answer** 201 with the request, its conflicts, its competing keys and the uuids it replaced.

## `POST /change-requests`

The kerngegevens page of a gemeente as one request: its address, a new contact point, its primary
site, its KBO number and the organisation itself. Each update carries in `meta.base` the values its
form loaded.

```json
{
  "data": {
    "type": "change-requests",
    "attributes": {
      "aggregate": "organization-core-data",
      "operations": [
        { "op": "update", "data": { "type": "addresses", "id": "4b6e…",
            "attributes": { "street": "Grote Markt", "number": "3", "box-number": null, "postcode": "9300",
                            "municipality": "Aalst", "province": "Oost-Vlaanderen", "country": "België",
                            "full-address": "Grote Markt 3, 9300 Aalst, België",
                            "address-register-uri": "https://data.vlaanderen.be/id/adres/123456" },
            "meta": { "base": { "attributes": { "street": "Grote Markt", "number": "1", "box-number": null, "postcode": "9300",
                                                "municipality": "Aalst", "province": "Oost-Vlaanderen", "country": "België",
                                                "full-address": "Grote Markt 1, 9300 Aalst, België",
                                                "address-register-uri": "https://data.vlaanderen.be/id/adres/123455" } } } } },
        { "op": "create", "data": { "type": "contact-points", "lid": "c1",
            "attributes": { "email": "info@aalst.be", "telephone": "+32 53 77 93 00", "type": "Primary" } } },
        { "op": "update", "data": { "type": "sites", "id": "77c2…",
            "relationships": { "address": { "data": { "type": "addresses", "id": "4b6e…" } },
                               "contacts": { "data": [ { "type": "contact-points", "lid": "c1" } ] },
                               "site-type": { "data": { "type": "site-types", "id": "dcc0…" } } },
            "meta": { "base": { "relationships": { "address": { "data": { "type": "addresses", "id": "4b6e…" } },
                                                   "contacts": { "data": [ { "type": "contact-points", "id": "c0ff…" } ] },
                                                   "site-type": { "data": null } } } } } },
        { "op": "delete", "data": { "type": "contact-points", "id": "c0ff…" } },
        { "op": "update", "data": { "type": "structured-identifiers", "id": "2e4a…", "attributes": { "local-id": "0207437468" },
            "meta": { "base": { "attributes": { "local-id": "0207437468" } } } } },
        { "op": "update", "data": { "type": "administrative-units", "id": "9a01…",
            "attributes": { "name": "Stad Aalst", "legal-name": "Stad Aalst", "alternative-name": ["Aalst"], "purpose": null, "expected-end-date": null },
            "relationships": { "primary-site": { "data": { "type": "sites", "id": "77c2…" } },
                               "identifiers": { "data": [ { "type": "identifiers", "id": "1d3f…" } ] },
                               "scope": { "data": { "type": "locations", "id": "a2f6…" } },
                               "classification": { "data": { "type": "administrative-unit-classification-codes", "id": "5ab0…" } } },
            "meta": { "base": { "attributes": { "name": "Aalst", "legal-name": null, "alternative-name": ["Aalst"], "purpose": null, "expected-end-date": null },
                                "relationships": { "primary-site": { "data": { "type": "sites", "id": "77c2…" } },
                                                   "identifiers": { "data": [ { "type": "identifiers", "id": "1d3f…" } ] },
                                                   "scope": { "data": { "type": "locations", "id": "a2f6…" } },
                                                   "classification": { "data": { "type": "administrative-unit-classification-codes", "id": "5ab0…" } } } } } } }
      ]
    },
    "relationships": { "target": { "data": { "type": "organizations", "id": "9a01…" } } }
  }
}
```

In this example the structured identifier changes nothing and leaves no version; the address
writes its number, full address and register link; the site its contacts and site type; the
organisation its name and legal name.

### The rules

- `aggregate` names an aggregate of the configuration. It whitelists the types the operations may
  touch (the configured types and their subtypes: a gemeente is an `administrative-units` document
  under the `organizations` root) and the code lists a document may link to (`references`).
- `target` is the organisation the request is about (`organizations` or a subtype). The acting
  organisation comes from the session, never from the body.
- `op` is `create`, `update` or `delete`. A create carries a `lid` (local id) instead of an `id`;
  other operations refer to it with `{ "type": "contact-points", "lid": "c1" }`, before or after it.
- **Every id must belong to the target.** The id of an update or delete, and every id a
  relationship inside the aggregate points at, must be reachable from the target organisation over
  the aggregate's relationships. Anything else is a 422, for ABB too. A record that is no longer
  linked to the organisation is no longer part of its aggregate, so unlink and delete in the same
  request, as the pages do. References only have to exist.
- **An organisation is only ever updated, and only the target itself.** Creating or deleting an
  organisation, or updating another one, is a 422.
- **Per-field semantics**, as a mu-cl-resources PATCH: a version changes exactly the attributes and
  relationships it carries; an absent field is left alone; `null` or `[]` clears it. A list that is
  carried holds the whole list; with a base only the user's additions and removals are applied.
- **A relationship outside the aggregate** (`classification`, `organization-status`, ...) may be
  carried, as the frontend's serializer does, but not changed: it must equal its base or the
  current value, else 422. Inverse relationships (`memberships`, ...) are ignored.
- Attribute values follow the model's type (see [the datatype table](development.md#datatypes));
  `null` means no value.

### Base values

The pages send every attribute of a record, not only the changed ones, so a form loaded before
someone else saved would put old values back. An update therefore carries in `meta.base` the
values its form started from, for the fields it carries: `attributes` by name, `relationships` by
name as `{ "data": identifier | [identifiers] | null }`.

For every single-valued field (an attribute that is not a set, a to-one relationship), with base
**B**, proposal **P** and current value **C** (read under the lock):

| Case | Written | Conflict |
| --- | --- | --- |
| P = B: the user did not change it | no, so a change made since stays | no |
| P ≠ B and C = B | yes | no |
| P ≠ B and C = P: the same change was made already | no | no |
| P ≠ B and C is neither B nor P: someone else changed it | yes, the proposal is kept in the version | yes |

- **Lists merge.** A to-many relationship, a `string-set`, `uri-set` or `language-string-set`
  adds what P has and B had not, and removes what B had and P has not; what others changed stays.
  Two changes from the same base cannot disagree on an item, so a list never conflicts. The version
  keeps P and B, so a request approved later merges the same way into what the record holds then.
- **No base** for a field means B = C: written when P ≠ C, never a conflict. A client that sends no
  base at all gets exactly that, and a list is then replaced by P.
- Values compare under their type: strings exactly, language strings by value and tag, dates,
  datetimes, numbers and booleans by value, relationships by the URIs they point at. A base refers
  to records by `id` (never `lid`); the id only has to be known, also for a record deleted since.
- **A delete** may carry `meta.base` too: the record as its page loaded it. A tombstone removes
  every field of its type and every link to the record, so it conflicts on a field the record now
  holds a value for that its base did not have. A field cleared since is no conflict. The tombstone
  stores its base and the records that linked to it, so a delete that waits for ABB is checked
  again before approval: a value set or a link made in the meantime is a conflict then.
- A request with a conflict is not approved automatically (`holdOnConflict`): 201, status
  `ingediend`, its conflicts, and it waits for ABB.

### The answer

`201 Created`:

```json
{
  "data": {
    "type": "change-requests",
    "id": "e0b1…",
    "attributes": {
      "status": "goedgekeurd",
      "created": "2026-11-03T10:12:00.000Z",
      "applied-at": "2026-11-03T10:12:01.000Z",
      "aggregate": "organization-core-data",
      "error": null,
      "lids": { "c1": "6f3a…" },
      "steps": [
        { "sequence": 1, "type": "indiening", "status": "ingediend", "at": "2026-11-03T10:12:00.000Z",
          "agent": "user", "person": "1e2f…", "organisation": "9a01…", "rule": "own-organisation",
          "reason": null, "error": null, "overrides-conflict": false, "overridden-conflicts": [] },
        { "sequence": 2, "type": "goedkeuring", "status": "goedgekeurd", "at": "2026-11-03T10:12:01.000Z",
          "agent": "service", "person": null, "organisation": null, "rule": "always",
          "reason": null, "error": null, "overrides-conflict": false, "overridden-conflicts": [] }
      ],
      "conflicts": [],
      "conflicts-token": null,
      "competing": [],
      "replaced-by": null,
      "superseded": []
    },
    "relationships": {
      "target": { "data": { "type": "organizations", "id": "9a01…" } },
      "requesting-organisation": { "data": { "type": "organizations", "id": "9a01…" } }
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `status` | the status of the last step: `ingediend`, `goedgekeurd`, `afgekeurd`, `ingetrokken`, `mislukt` |
| `applied-at` | the start of the last step with status `goedgekeurd`, or null |
| `error` | the error message of the last step, or null |
| `lids` | each create's local id → the uuid the service minted (POST only), so the frontend reloads the right records |
| `steps` | ordered by `sequence`. `agent` is `user` (then `person` and `organisation` are the session's) or `service`; `rule` the policy rule; `reason` the comment (required on an afkeuring); `error` why an apply failed; `overridden-conflicts` the conflicts an applying step applied the request despite, as the approver saw them, derived from the states the step replaced |
| `conflicts`, `conflicts-token` | see [Conflicts](#conflicts); the token overrides exactly these conflicts in a goedkeuring |
| `competing` | the fields other pending requests propose something else for, `{ resource, key, proposed, "competing-requests": [uuid] }`, also without a conflict |
| `superseded` | on the answer of an apply: the uuids of the older pending requests this one replaced |
| `replaced-by` | on a request the service withdrew that way: the uuid of the newer request |

The same request from a form that loaded the name "Aalst" after ABB renamed the organisation:

```json
"attributes": {
  "status": "ingediend", "applied-at": null, "error": null, "…": "…",
  "steps": [ { "sequence": 1, "type": "indiening", "status": "ingediend", "…": "…" } ],
  "conflicts": [
    { "resource": { "type": "administrative-units", "id": "9a01…" }, "key": "name",
      "base": "Aalst", "current": "Aalst (ABB)", "proposed": "Stad Aalst",
      "master-exists": true, "competing-requests": [] }
  ],
  "conflicts-token": "5ac5a8f6…",
  "competing": []
}
```

| Status | When |
| --- | --- |
| 201 | the request is written; `status` says whether it was applied or waits for ABB |
| 400 | the JSON could not be parsed |
| 401 | no session, or the session has no account, no acting organisation or no person |
| 403 | the policy denies; `meta.rule` names the rule that denied (`null` when no rule allowed it) |
| 404 | the target organisation does not exist |
| 409 | the apply failed twice; the goedkeuring step is kept with status `mislukt`, `meta["change-request"]` carries the request's id, and a hertoepassing applies it again |
| 413 | the body exceeds `MAX_BODY_SIZE` |
| 422 | an operation breaks one of the rules above; `source.pointer` points at it |

## `GET /change-requests` and `GET /change-requests/:id`

`GET /change-requests?filter[target]=<organisation uuid>&filter[status]=ingediend&page[number]=0&page[size]=20`

- The requests the acting organisation may see: those about it and those it submitted; ABB sees
  all. Newest first.
- `page[number]` counts from 0; `page[size]` is 20 by default and at most 100. `meta.count` is the
  total; `links` has `first`, `last` and, where they exist, `prev` and `next`.
- `filter[target]` narrows to one organisation; `filter[status]` to one or more statuses
  (comma-separated), so an approval screen asks for `ingediend` only.
- A filter on another or an unknown organisation gives an empty list; a malformed filter or page a
  400; a single request that is not visible a 404.
- The steps, versions and current values are read for the requests of the page only, in batches
  under Virtuoso's row limit (a result that would reach it is an error, never a cut-off answer).
- The documents have the shape above, without `lids`. A pending request shows its conflicts, their
  token and its competing keys computed live, so they change as others edit; a decided request
  shows none, but its applying steps show the conflicts they overrode.

## `POST /change-requests/:id/steps`

```json
{ "data": { "type": "change-request-steps",
            "attributes": { "step-type": "afkeuring", "reason": "Het KBO-nummer hoort bij een andere organisatie" } } }
```

| `step-type` | from status | to status | allowed by |
| --- | --- | --- | --- |
| `goedkeuring` | `ingediend` | `goedgekeurd`, or `mislukt` when the apply fails | `canDecide`: ABB |
| `afkeuring` | `ingediend`, `mislukt` | `afgekeurd` | `canDecide`: ABB; `reason` required |
| `intrekking` | `ingediend`, `mislukt` | `ingetrokken` | `canWithdraw`: ABB, the requesting organisation |
| `hertoepassing` | `mislukt` | `goedgekeurd`, or `mislukt` | `canEdit` on the target, as a POST |

- `indiening` is only the first step of `POST /change-requests`; `wijziging` is reserved.
- **A goedkeuring** applies the stored versions with the step in one update, as the POST does, and
  stamps the target with the person who submitted the request. It checks the conflicts again
  first, live: when there are any it answers 409 with them in `meta.conflicts` and their token in
  `meta["conflicts-token"]`, unless the body says `"override": "<that token>"` (the token GET shows,
  or the one of the 409). So the approver overrides exactly the conflicts they reviewed; a change
  that lands after the review gives another token and another 409. The states the step replaced
  keep what it overwrote; the step shows `"overrides-conflict": true` and `overridden-conflicts`.
- A goedkeuring or hertoepassing of a request that updates a record deleted since is refused with
  409 (`meta["missing-records"]`), also with `override`: it could never succeed. Reject or
  withdraw it.
- The apply plans the stored versions against what the records hold at that moment: a list merges
  the request's additions and removals, as at submission.
- **A hertoepassing** applies what was approved before, without a new review; what it overwrites
  shows as its `overridden-conflicts`. It is refused with 409 when another request on the
  organisation that changed something was applied after this one failed. The frontend then asks
  for a reload and the user enters the change again.
- `reason` is optional on the other steps and kept on the step. The step gets the next `sequence`.
- `POST /change-requests/:id/apply` is the same as a `hertoepassing` step, answered with 200, as
  the first version of the service offered it.

Answer: `201 Created` with the request, its `steps` ending with the new one.

| Status | When |
| --- | --- |
| 201 | the step is taken |
| 401 | no session, or the session has no account, no acting organisation or no person |
| 403 | the policy denies; `meta.rule` as for the POST |
| 404 | the request is not visible to the acting organisation |
| 409 | the status does not admit the step (`meta.status`, `meta["step-type"]`); a goedkeuring without the token of the current conflicts (`meta.conflicts`, `meta["conflicts-token"]`); a request that updates deleted records (`meta["missing-records"]`); a hertoepassing after a later applied request; an apply that failed twice |
| 422 | an unknown or reserved `step-type`, an afkeuring without `reason`, an `override` that is not a token (`true` is not one), a malformed body |

## `GET /change-requests/permissions?target=<uuid>`

```json
{ "can-edit": true, "rules": ["own-organisation"] }
```

The same `canEdit` evaluation the POST runs, so the frontend and the server cannot disagree.
`rules` names the rule that decided (empty when none did, which is a deny). 404 when the
organisation does not exist.

## Conflicts

```json
{ "resource": { "type": "contact-points", "id": "c0ff…" }, "key": "email",
  "base": "loket@aalst.be", "current": "info@aalst.be", "proposed": null,
  "master-exists": true, "competing-requests": ["5e97…"] }
```

A field (`key`) of a record (`resource`) where the proposal disagrees with the current value, and
the record no longer holds what the request started from. Values are JSON: a string, number,
boolean or null, an array for a list, `{ type, id }` identifiers for relationships.

- An update conflicts on a single-valued field someone changed to another value since its base;
  a list merges and does not conflict.
- A record that no longer exists is a conflict on every field the update writes, with `current`
  null and `"master-exists": false`; such a request cannot be applied.
- A delete conflicts on a value someone set on the record since its base, and on every link to the
  record made since it was submitted. Such a link is shown on the record that links: its
  relationship holds the deleted record now (`current`), not in `base` and `proposed`:

```json
{ "resource": { "type": "sites", "id": "8d2a…" }, "key": "contacts",
  "base": [], "current": [ { "type": "contact-points", "id": "c0ff…" } ], "proposed": [],
  "master-exists": true, "competing-requests": [] }
```

- `competing-requests` are the other pending requests that write the same field of the same
  record and disagree: another value for a single-valued field, an addition of what the other
  removes for a list, anything but removal against a delete.
- `conflicts-token` is a hash of the conflicts as rendered (without their competing requests); a
  goedkeuring passes it as `override`.

## Errors

```json
{ "errors": [ { "status": "422", "title": "Unprocessable change request",
                "detail": "unknown attribute \"colour\" for type \"addresses\"",
                "source": { "pointer": "/data/attributes/operations/0/data/attributes/colour" } } ] }
```
