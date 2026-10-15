/**
 * An error that maps onto one JSON:API error object and an HTTP status.
 */
export class HttpError extends Error {
  constructor(status, title, { detail, pointer, meta } = {}) {
    super(detail ? `${title}: ${detail}` : title);
    this.status = status;
    this.title = title;
    this.detail = detail;
    this.pointer = pointer;
    this.meta = meta;
  }

  toJSON() {
    const error = { status: String(this.status), title: this.title };
    if (this.detail) error.detail = this.detail;
    if (this.pointer) error.source = { pointer: this.pointer };
    if (this.meta) error.meta = this.meta;
    return error;
  }
}

/** 422: the request is well-formed but an operation cannot be turned into a version. */
export const unprocessable = (detail, pointer) =>
  new HttpError(422, 'Unprocessable change request', { detail, pointer });
