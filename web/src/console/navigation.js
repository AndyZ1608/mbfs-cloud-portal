export const CONSOLE_ROUTE = '/console/:instanceId';

// Call directly from the user's click, before any asynchronous session request.
export function openInstanceConsole(instanceId) {
  window.open(`/console/${encodeURIComponent(instanceId)}`, '_blank', 'noopener,noreferrer');
}
