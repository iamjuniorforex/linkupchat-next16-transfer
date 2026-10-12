/**
 * Chat wallpaper settings e2e (HTTP against the running server).
 *
 * Covers: the UserSettings.wallpaper default, switching between wallpapers,
 * persistence across sessions (page refresh semantics), partial updates that
 * must not clobber wallpaper, validation bounds, and that the per-user
 * wallpaper setting is conversation-agnostic (the schema has ONE wallpaper per
 * user — it serves both DIRECT and GROUP conversations; there is no
 * per-conversation wallpaper state).
 *
 * Run: npm run test:wallpaper:e2e   (SERVER_URL=http://localhost:3300)
 */
import assert from 'node:assert/strict';
import { SERVER_URL, api, createReporter, login, uniq, type Session } from './helpers';

const report = createReporter();

interface SettingsDTO {
  wallpaper: string;
  theme: string;
  enterToSend: boolean;
  [key: string]: unknown;
}

async function register(username: string): Promise<Session> {
  const res = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: 'Passw0rd123',
      displayName: 'Wallpaper Tester',
      email: `${username}@example.com`
    })
  });
  assert.ok(res.ok || res.status === 409, `register failed: ${res.status}`);
  return login(username, 'Passw0rd123');
}

async function getSettings(s: Session): Promise<SettingsDTO> {
  const res = await api<{ data?: SettingsDTO }>(s, 'GET', '/api/users/me/settings');
  assert.equal(res.status, 200, `GET settings: ${res.status}`);
  assert.ok(res.json.data, 'no settings payload');
  return res.json.data!;
}

async function patchSettings(s: Session, patch: Record<string, unknown>): Promise<{ status: number; json: { ok?: boolean; data?: SettingsDTO; error?: { code?: string } } }> {
  return api(s, 'PATCH', '/api/users/me/settings', patch);
}

async function main() {
  console.log('■ wallpaper-settings: selection + persistence');
  const username = `wp_${uniq().replace(/-/g, '')}`;
  const s = await register(username);

  await report.check('fresh account starts on the default wallpaper', async () => {
    const settings = await getSettings(s);
    assert.equal(settings.wallpaper, 'default', `wallpaper=${settings.wallpaper}`);
  });

  await report.check("selecting 'aurora' persists", async () => {
    const res = await patchSettings(s, { wallpaper: 'aurora' });
    assert.equal(res.status, 200, `PATCH: ${res.status}`);
    assert.equal(res.json.data?.wallpaper, 'aurora');
    const settings = await getSettings(s);
    assert.equal(settings.wallpaper, 'aurora', 'GET did not return aurora');
  });

  await report.check("switching to 'plain' replaces 'aurora' (two-wallpaper switch)", async () => {
    const res = await patchSettings(s, { wallpaper: 'plain' });
    assert.equal(res.status, 200);
    assert.equal(res.json.data?.wallpaper, 'plain');
    const settings = await getSettings(s);
    assert.equal(settings.wallpaper, 'plain');
  });

  await report.check('wallpaper survives a fresh login (page-refresh persistence)', async () => {
    const s2 = await login(username, 'Passw0rd123');
    const me = await api<{ data?: { settings?: SettingsDTO } }>(s2, 'GET', '/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.data?.settings?.wallpaper, 'plain', 'auth/me lost the wallpaper');
  });

  await report.check('partial updates (e.g. theme) never clobber the wallpaper', async () => {
    const res = await patchSettings(s, { theme: 'DARK' });
    assert.equal(res.status, 200);
    assert.equal(res.json.data?.wallpaper, 'plain', 'wallpaper was clobbered');
    const settings = await getSettings(s);
    assert.equal(settings.wallpaper, 'plain');
    assert.equal(settings.theme, 'DARK');
  });

  await report.check('wallpaper over 40 characters is rejected (422 VALIDATION_ERROR)', async () => {
    const res = await patchSettings(s, { wallpaper: 'x'.repeat(41) });
    assert.equal(res.status, 422, `status=${res.status}`);
    assert.equal(res.json.error?.code, 'VALIDATION_ERROR');
    const settings = await getSettings(s);
    assert.equal(settings.wallpaper, 'plain', 'invalid value must not be stored');
  });

  await report.check('wallpaper is per-user and conversation-agnostic (direct + group)', async () => {
    // The architecture stores ONE wallpaper per user (UserSettings); the same
    // value serves every conversation surface. Verify the setting coexists with
    // both conversation types and is returned identically afterwards.
    const b = await register(`wpb_${uniq().replace(/-/g, '')}`);
    const direct = await api<{ data?: { id?: string } }>(s, 'POST', '/api/conversations', {
      type: 'DIRECT',
      username: b.username
    });
    assert.equal(direct.status, 201, `DIRECT create: ${direct.status}`);
    const group = await api<{ data?: { id?: string } }>(s, 'POST', '/api/conversations', {
      type: 'GROUP',
      title: 'Wallpaper Group',
      memberIds: [b.id]
    });
    assert.equal(group.status, 201, `GROUP create: ${group.status}`);
    const settings = await getSettings(s);
    assert.equal(settings.wallpaper, 'plain', 'wallpaper changed while creating conversations');
    // And it can still be switched afterwards.
    const res = await patchSettings(s, { wallpaper: 'aurora' });
    assert.equal(res.json.data?.wallpaper, 'aurora');
    void direct;
    void group;
  });

  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
