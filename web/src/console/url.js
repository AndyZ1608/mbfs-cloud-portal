export function consoleUrlToWebSocket(consoleUrl) {
  const source = new URL(consoleUrl);
  if (source.protocol === 'ws:' || source.protocol === 'wss:') return source.toString();
  if (!['http:', 'https:'].includes(source.protocol)) throw new Error('Console URL không sử dụng giao thức được hỗ trợ.');

  const path = source.searchParams.get('path') || 'websockify';

  const separator = path.indexOf('?');
  const pathname = separator >= 0 ? path.slice(0, separator) : path;
  const search = separator >= 0 ? path.slice(separator + 1) : '';
  const token = source.searchParams.get('token');
  source.protocol = source.protocol === 'https:' ? 'wss:' : 'ws:';
  source.pathname = pathname ? `/${pathname.replace(/^\/+/, '')}` : '/';
  source.search = search;
  if (!search && token) source.searchParams.set('token', token);
  source.hash = '';
  return source.toString();
}
