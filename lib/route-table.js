import { readFileSync } from 'node:fs';

export function loadRouteConfig() {
  return JSON.parse(readFileSync(new URL('../proxy.config.json', import.meta.url), 'utf8'));
}

export function loadRoutes(config = loadRouteConfig()) {
  if (!config.routes || typeof config.routes !== 'object' || Array.isArray(config.routes)) {
    throw new Error('Config must contain a routes object');
  }

  const routes = new Map();
  for (const [key, route] of Object.entries(config.routes)) {
    if (!key || key === 'routes' || /[/?#\s]/.test(key) || typeof route?.target !== 'string') {
      throw new Error(`Invalid route: ${key}`);
    }
    const target = new URL(route.target);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash) {
      throw new Error(`Invalid target for route: ${key}`);
    }
    routes.set(key, target);
  }
  return routes;
}

export function resolveRoute(rawUrl, routes) {
  // Keep the raw path and query: URL parsing would normalize dot segments.
  const separator = rawUrl.indexOf('?');
  const pathname = separator < 0 ? rawUrl : rawUrl.slice(0, separator);
  const query = separator < 0 ? '' : rawUrl.slice(separator + 1);
  const [, key, tail = ''] = pathname.match(/^\/([^/]+)(.*)$/) || [];
  const target = routes.get(key);
  if (!target) return null;

  const search = [target.search.slice(1), query].filter(Boolean).join('&');
  return {
    key,
    target,
    path: target.pathname.replace(/\/$/, '') + (tail || '/') + (search ? `?${search}` : '')
  };
}
