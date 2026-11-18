import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{12}$/;

export function loadUsers(file = new URL('../users.json', import.meta.url)) {
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // JSON parser errors can contain the plaintext token. Never expose them.
    throw new Error('Unable to read or parse users file');
  }
  if (!config?.users || typeof config.users !== 'object' || Array.isArray(config.users)) {
    throw new Error('Users file must contain a users object');
  }

  const tokens = new Set();
  const users = [];
  for (const [name, user] of Object.entries(config.users)) {
    if (!name.trim() || typeof user?.token !== 'string' || user.token.length !== 12 || !TOKEN_PATTERN.test(user.token)
        || typeof user.disabled !== 'boolean') {
      throw new Error('Invalid user: require a name, a 12-character base64url token and boolean disabled');
    }
    if (tokens.has(user.token)) throw new Error('Duplicate token in users file');
    tokens.add(user.token);
    if (!user.disabled) users.push(Buffer.from(user.token));
  }
  return users;
}

export function authenticatePath(rawUrl, users) {
  // Match the raw first segment; never decode or normalize a secret URL.
  if (rawUrl[0] !== '/' || rawUrl.indexOf('/', 1) !== 13) return null;
  const token = rawUrl.slice(1, 13);
  if (!TOKEN_PATTERN.test(token)) return null;
  const supplied = Buffer.from(token);
  if (!users.some((expected) => timingSafeEqual(expected, supplied))) return null;
  return rawUrl.slice(13);
}
