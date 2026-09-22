export function traceNovaConsole(data, requestId, {
  enabled = process.env.NODE_ENV !== 'production' && process.env.CMP_CONSOLE_DIAGNOSTICS === 'true',
  write = (entry) => console.info('[console diagnostics]', entry),
} = {}) {
  if (!enabled) return;
  let shape = '<invalid URL>';
  try {
    const url = new URL(data?.remote_console?.url || data?.console?.url);
    if (['http:', 'https:'].includes(url.protocol)) {
      const page = url.pathname.split('/').pop();
      const publicPage = ['vnc_auto.html', 'vnc_lite.html', 'vnc.html'].includes(page) ? page : '<redacted>';
      const prefix = url.pathname === `/${page}` ? '/' : '/<redacted>/';
      shape = `${url.origin}${prefix}${publicPage}${url.search ? '?<redacted>' : ''}${url.hash ? '#<redacted>' : ''}`;
    }
  } catch { /* Do not log the URL parsing error; it can contain the token. */ }
  write({ event: 'nova_received_and_forwarded', requestId, url: shape });
}
