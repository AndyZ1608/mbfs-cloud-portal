export function getNovaConsoleUrl(response) {
  const url = response?.remote_console?.url || response?.console?.url;
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('OpenStack không trả về URL console.');
  }
  return url;
}
