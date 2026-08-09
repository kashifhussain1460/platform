import { makeWriteTools } from './assist-write-tools';
import type { AssistToolContext } from './assist-tool-registry';

const ctx: AssistToolContext = { companyId: 'co_1', userId: 'u_1', sessionId: 's_1' };
const tool = () => {
  const t = makeWriteTools({} as never).find((x) => x.name === 'request_connection');
  if (!t) throw new Error('request_connection tool missing');
  return t;
};
const run = (skillKeys: string) => tool().run(ctx, { skillKeys } as never);

describe('request_connection tool', () => {
  it('declares known catalog skills for the connection card', async () => {
    const out = await run('gmail, calendar');
    expect(out.ok).toBe(true);
    expect((out.result as { requestedConnectionSkills: string[] }).requestedConnectionSkills).toEqual([
      'gmail',
      'calendar',
    ]);
  });

  it('drops unknown skills but keeps the known ones', async () => {
    const out = await run('gmail, sap');
    expect(out.ok).toBe(true);
    expect((out.result as { requestedConnectionSkills: string[] }).requestedConnectionSkills).toEqual([
      'gmail',
    ]);
  });

  it('fails (self-correctable) when nothing is a real skill', async () => {
    const out = await run('sap, foo');
    expect(out.ok).toBe(false);
    expect((out.result as { error: string }).error).toContain('list_skills');
  });

  it('de-duplicates repeated keys', async () => {
    const out = await run('slack,slack');
    expect((out.result as { requestedConnectionSkills: string[] }).requestedConnectionSkills).toEqual([
      'slack',
    ]);
  });
});
