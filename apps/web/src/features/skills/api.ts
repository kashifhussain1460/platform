import { apiClient } from '@/lib/apiClient';
import type {
  ConfigureSkillDto,
  ConnectorHealthDto,
  ConnectSkillDto,
  EmployeeSkillDto,
  InstallSkillDto,
  InstalledSkillDto,
  OAuthAuthorizeDto,
  SkillDefinitionDto,
  UpdateInstalledSkillDto,
  WorkflowSkillRequirementsDto,
} from '@vaep/types';

// --- Catalog + installed skills --------------------------------------------

export async function listCatalog(): Promise<SkillDefinitionDto[]> {
  const { data } = await apiClient.get<SkillDefinitionDto[]>('/skills/catalog');
  return data;
}

export async function listInstalledSkills(): Promise<InstalledSkillDto[]> {
  const { data } =
    await apiClient.get<InstalledSkillDto[]>('/skills/installed');
  return data;
}

export async function installSkill(
  payload: InstallSkillDto,
): Promise<InstalledSkillDto> {
  const { data } = await apiClient.post<InstalledSkillDto>(
    '/skills/install',
    payload,
  );
  return data;
}

export async function updateInstalledSkill(vars: {
  id: string;
  data: UpdateInstalledSkillDto;
}): Promise<InstalledSkillDto> {
  const { data } = await apiClient.patch<InstalledSkillDto>(
    `/skills/installed/${vars.id}`,
    vars.data,
  );
  return data;
}

export async function uninstallSkill(id: string): Promise<void> {
  await apiClient.delete(`/skills/installed/${id}`);
}

export async function configureSkill(vars: {
  id: string;
  data: ConfigureSkillDto;
}): Promise<InstalledSkillDto> {
  const { data } = await apiClient.patch<InstalledSkillDto>(
    `/skills/installed/${vars.id}/config`,
    vars.data,
  );
  return data;
}

export async function connectSkill(vars: {
  id: string;
  data: ConnectSkillDto;
}): Promise<InstalledSkillDto> {
  const { data } = await apiClient.post<InstalledSkillDto>(
    `/skills/installed/${vars.id}/connect`,
    vars.data,
  );
  return data;
}

export async function disconnectSkill(id: string): Promise<InstalledSkillDto> {
  const { data } = await apiClient.post<InstalledSkillDto>(
    `/skills/installed/${id}/disconnect`,
    {},
  );
  return data;
}

// --- Connector health (Unit B) ---------------------------------------------
// A "connector" is an installed skill; health uses the /connectors/:id/* routes.

/** Current connector health snapshot. */
export async function getConnectorHealth(
  id: string,
): Promise<ConnectorHealthDto> {
  const { data } = await apiClient.get<ConnectorHealthDto>(
    `/connectors/${id}/health`,
  );
  return data;
}

/** Run an active health probe now and return the updated health. */
export async function checkConnectorHealth(
  id: string,
): Promise<ConnectorHealthDto> {
  const { data } = await apiClient.post<ConnectorHealthDto>(
    `/connectors/${id}/health-check`,
    {},
  );
  return data;
}

/** One stage of the connection state machine (plan §3). */
export interface VerifyStepResult {
  key: 'credentials' | 'account' | 'outbound' | 'inbound' | 'health';
  label: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  detail?: string;
  code?: string;
}

export interface VerifyConnectionResult {
  ok: boolean;
  steps: VerifyStepResult[];
  account: string | null;
  code?: string;
  connectionStatus: string;
  adapterAvailable: boolean;
}

/**
 * Run the connection state machine (plan §3/§26): authenticate, identify the
 * account, and — only when `sendTest` is set — run the provider's real test
 * action. The API promotes the connector to CONNECTED only when it passes.
 */
export async function verifyConnection(vars: {
  id: string;
  sendTest?: boolean;
  testTo?: string;
}): Promise<VerifyConnectionResult> {
  const { data } = await apiClient.post<VerifyConnectionResult>(
    `/skills/installed/${vars.id}/verify`,
    { sendTest: vars.sendTest, testTo: vars.testTo || undefined },
  );
  return data;
}

/**
 * Begin the real OAuth authorization-code flow for an `oauth` skill: ask the API
 * for the provider authorize URL (carrying a signed state). The caller then
 * redirects the browser there; the provider calls back to the API which stores
 * the tokens and bounces to /skills?connected=<skillKey>.
 */
export async function authorizeOAuth(
  id: string,
  returnTo?: string,
): Promise<OAuthAuthorizeDto> {
  const { data } = await apiClient.get<OAuthAuthorizeDto>(
    `/skills/installed/${id}/oauth/authorize`,
    { params: returnTo ? { returnTo } : undefined },
  );
  return data;
}

/**
 * Live connection readiness for a set of skills (capability-first). Backs the
 * in-chat AI Assist Skill card so it can refresh a skill's status after the user
 * returns from an OAuth connect, without needing a persisted workflow.
 */
export async function getSkillRequirements(
  skillKeys: string[],
): Promise<WorkflowSkillRequirementsDto> {
  const { data } = await apiClient.get<WorkflowSkillRequirementsDto>(
    '/skills/requirements',
    { params: { skillKeys: skillKeys.join(',') } },
  );
  return data;
}

// --- Employee ↔ skill assignments ------------------------------------------

export async function listEmployeeSkills(
  employeeId: string,
): Promise<EmployeeSkillDto[]> {
  const { data } = await apiClient.get<EmployeeSkillDto[]>(
    `/employees/${employeeId}/skills`,
  );
  return data;
}

export async function assignSkill(vars: {
  employeeId: string;
  installedSkillId: string;
}): Promise<EmployeeSkillDto> {
  const { data } = await apiClient.post<EmployeeSkillDto>(
    `/employees/${vars.employeeId}/skills`,
    { installedSkillId: vars.installedSkillId },
  );
  return data;
}

export async function unassignSkill(vars: {
  employeeId: string;
  installedSkillId: string;
}): Promise<void> {
  await apiClient.delete(
    `/employees/${vars.employeeId}/skills/${vars.installedSkillId}`,
  );
}
