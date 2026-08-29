const STORAGE_KEY = 'lifeline:project-access-token';

consumeAccessTokenFromUrl();

export function projectAccessHeaders(headers = {}) {
  const token = currentProjectAccessToken();
  return {
    ...headers,
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

export function clearProjectAccessToken() {
  sessionStorage.removeItem(STORAGE_KEY);
}

export function projectShareUrl({ projectId, token, path = '/client.html' }) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set('project', projectId);
  url.searchParams.set('access', token);
  return url.href;
}

function currentProjectAccessToken() {
  const value = sessionStorage.getItem(STORAGE_KEY) ?? '';
  return /^lfp_[A-Za-z0-9_-]{20,}$/.test(value) ? value : null;
}

function consumeAccessTokenFromUrl() {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('access');
  if (!token) return;
  if (/^lfp_[A-Za-z0-9_-]{20,}$/.test(token)) sessionStorage.setItem(STORAGE_KEY, token);
  url.searchParams.delete('access');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}
