# Changelog

## Unreleased

- Initial version: `POST /change-requests` turns the JSON:API operations of one aggregate into RDF version objects, checks the edit policy, writes the request and applies it in one SPARQL update inside the service scope; `GET /change-requests`, `GET /change-requests/:id` and `GET /change-requests/permissions`; the resources model is read from the mounted mu-cl-resources JSON files, with the datatype table of mu-cl-resources; unit tests and `scripts/integration.sh`.
- Every id an operation touches or links to must belong to the target organisation's aggregate (reachable from the target); an organisation is only ever updated, and only the target itself.
- Per-key semantics: a version replaces only the keys its document carries (`cr:replaces`); a relationship outside the aggregate must be unchanged, references (`references` per aggregate: locations, concepts, site types) are part of the version; `organizations` is a member of the `site` aggregate.
- The apply is idempotent and retried once; a failed request can be applied again from its stored versions with `POST /change-requests/:id/apply` (`cr:operation`, `cr:masterUuid`, `cr:replaces` on every version).
- A relationship to a type the loaded model files do not define is logged and left out instead of stopping the service (app-rvs loads only `domain.json` and `auth.json`).
- `scripts/e2e-mock-login.sh`: the end-to-end flow against app-rvs through mu-identifier with mock-login sessions.
- A create writes the class tree of its type; `url` and `uri-set` values are checked to be IRIs; `MAX_BODY_SIZE=5mb` in the image, 413 above it; mu-identifier 1.11.0 or later required and checked by the integration script.
