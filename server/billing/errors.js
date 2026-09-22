export class BillingError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'BillingError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

