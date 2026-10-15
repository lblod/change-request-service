FROM semtech/mu-javascript-template:1.9.1
LABEL maintainer="info@redpencil.io"

# The scope under which sparql-parser grants this service its write access
# (see README, "Authorization"). Override in docker-compose when the stack uses another URI.
ENV DEFAULT_MU_AUTH_SCOPE="http://services.lblod.info/change-request-service"

# A request carries whole aggregates. The template parses application/vnd.api+json bodies
# with this limit before any route runs, so it is the one knob for the body size (its default
# is 100kb). A stack that runs the template image with the sources mounted (development mode)
# does not get this ENV and must set it in its docker-compose.
ENV MAX_BODY_SIZE="5mb"
