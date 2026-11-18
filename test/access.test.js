import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authenticatePath, loadUsers } from '../lib/access.js';

const activeToken = 'LiveToken_01';
const disabledToken = 'DeadToken_01';

test('users file validation and path authentication', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'nyenschantz-access-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'users.json');
  const load = (config) => {
    writeFileSync(file, JSON.stringify(config));
    return loadUsers(file);
  };
  const users = load({ users: {
    active: { token: activeToken, disabled: false },
    inactive: { token: disabledToken, disabled: true }
  } });

  assert.equal(authenticatePath(`/${activeToken}/gemini/models?x=1`, users), '/gemini/models?x=1');
  assert.equal(authenticatePath(`/${activeToken}/openrouter/a/../b?x=%2F&x=2`, users), '/openrouter/a/../b?x=%2F&x=2');
  assert.equal(authenticatePath(`/${activeToken}/`, users), '/');
  for (const path of [
    '/', '/gemini/models', '/unknown/gemini/', `/${disabledToken}/gemini/`,
    `/${activeToken.toLowerCase()}/gemini/`, `/${activeToken}`, `/${activeToken}?q=/gemini`,
    `//${activeToken}/gemini/`, `/${activeToken}x/gemini/`,
    `/%4CiveToken_01/gemini/`, `/${activeToken.slice(0, -1)}!/gemini/`
  ]) {
    assert.equal(authenticatePath(path, users), null);
  }
  assert.equal(authenticatePath(`/${activeToken}/gemini/`, []), null);
  assert.deepEqual(load({ users: {} }), []);
  assert.deepEqual(load({ users: { inactive: { token: disabledToken, disabled: true } } }), []);

  for (const config of [null, {}, { users: null }, { users: [] }, { users: 'users' },
    { users: { ' ': { token: activeToken, disabled: false } } },
    { users: { active: null } },
    { users: { active: { token: '', disabled: false } } },
    { users: { active: { token: 'short', disabled: false } } },
    { users: { active: { token: activeToken + 'x', disabled: false } } },
    { users: { active: { token: activeToken + '\n', disabled: false } } },
    { users: { active: { token: 'Token/Bad_01', disabled: false } } },
    { users: { active: { token: activeToken } } },
    { users: { active: { token: activeToken, disabled: 'false' } } },
    { users: { first: { token: activeToken, disabled: false }, second: { token: activeToken, disabled: true } } }
  ]) {
    assert.throws(() => load(config), (error) => !error.message.includes(activeToken));
  }

  writeFileSync(file, `{"users": {"secret": "${activeToken}" BROKEN JSON`);
  assert.throws(() => loadUsers(file), { message: 'Unable to read or parse users file' });
  assert.throws(() => loadUsers(join(directory, 'missing.json')), { message: 'Unable to read or parse users file' });
});
