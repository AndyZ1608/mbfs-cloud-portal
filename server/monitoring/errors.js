export class MonitoringError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'MonitoringError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}
