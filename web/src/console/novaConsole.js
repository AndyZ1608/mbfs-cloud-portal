const CLIENT_PAGES = new Set(['vnc_auto.html', 'vnc_lite.html']);

export function getNovaConsoleUrl(response) {
  const url = response?.remote_console?.url || response?.console?.url;
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('OpenStack không trả về URL console.');
  }
  return url;
}

export function novaConsoleToWebSocket(consoleUrl, pageProtocol = '') {
  let source;
  try {
    source = new URL(consoleUrl);
  } catch {
    throw new Error('URL console do OpenStack trả về không hợp lệ.');
  }

  if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password || source.hash) {
    throw new Error('URL console do OpenStack trả về không hợp lệ.');
  }

  const clientPage = source.pathname.split('/').pop();
  if (!CLIENT_PAGES.has(clientPage)) {
    throw new Error('Định dạng URL noVNC của OpenStack không được hỗ trợ.');
  }

  const encodedPath = source.searchParams.get('path');
  const endpoint = new URL(encodedPath || 'websockify', `${source.origin}/`);
  if (endpoint.origin !== source.origin) {
    throw new Error('Đường dẫn WebSocket noVNC không hợp lệ.');
  }

  for (const [key, value] of source.searchParams) {
    if (key !== 'path' && !endpoint.searchParams.has(key)) endpoint.searchParams.append(key, value);
  }

  endpoint.protocol = source.protocol === 'https:' ? 'wss:' : 'ws:';
  if (pageProtocol === 'https:' && endpoint.protocol === 'ws:') {
    throw new Error('Nova noVNC phải dùng TLS để kết nối từ cổng CMP HTTPS.');
  }
  return endpoint.toString();
}
