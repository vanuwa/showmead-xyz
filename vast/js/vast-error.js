export class VASTError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.code = code;
    this.context = context;
    this.name = 'VASTError';
  }
}
