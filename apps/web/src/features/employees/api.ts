import { apiClient } from '@/lib/apiClient';
import type {
  AiEmployeeDto,
  ConversationDto,
  CreateEmployeeDto,
  CreateFeedbackDto,
  CreateMemoryDto,
  EmployeeFeedbackDto,
  EmployeeMemoryDto,
  EmployeeReadinessDto,
  LearningSummaryDto,
  MessageDto,
  RunResultDto,
  UpdateEmployeeDto,
} from '@vaep/types';

export async function listEmployees(): Promise<AiEmployeeDto[]> {
  const { data } = await apiClient.get<AiEmployeeDto[]>('/employees');
  return data;
}

export async function getEmployee(id: string): Promise<AiEmployeeDto> {
  const { data } = await apiClient.get<AiEmployeeDto>(`/employees/${id}`);
  return data;
}

export async function createEmployee(
  payload: CreateEmployeeDto,
): Promise<AiEmployeeDto> {
  const { data } = await apiClient.post<AiEmployeeDto>('/employees', payload);
  return data;
}

export async function updateEmployee(vars: {
  id: string;
  data: UpdateEmployeeDto;
}): Promise<AiEmployeeDto> {
  const { data } = await apiClient.patch<AiEmployeeDto>(
    `/employees/${vars.id}`,
    vars.data,
  );
  return data;
}

export async function deleteEmployee(id: string): Promise<void> {
  await apiClient.delete(`/employees/${id}`);
}

/** Derived — never stored. See `apps/api/.../readiness/employee-readiness.ts`. */
export async function getEmployeeReadiness(
  id: string,
): Promise<EmployeeReadinessDto> {
  const { data } = await apiClient.get<EmployeeReadinessDto>(
    `/employees/${id}/readiness`,
  );
  return data;
}

export async function listConversations(
  employeeId: string,
): Promise<ConversationDto[]> {
  const { data } = await apiClient.get<ConversationDto[]>(
    `/employees/${employeeId}/conversations`,
  );
  return data;
}

export async function startConversation(vars: {
  employeeId: string;
  title?: string;
}): Promise<ConversationDto> {
  const { data } = await apiClient.post<ConversationDto>(
    `/employees/${vars.employeeId}/conversations`,
    { title: vars.title },
  );
  return data;
}

export async function listMessages(
  conversationId: string,
): Promise<MessageDto[]> {
  const { data } = await apiClient.get<MessageDto[]>(
    `/conversations/${conversationId}/messages`,
  );
  return data;
}

export async function sendMessage(vars: {
  conversationId: string;
  content: string;
}): Promise<RunResultDto> {
  const { data } = await apiClient.post<RunResultDto>(
    `/conversations/${vars.conversationId}/messages`,
    { content: vars.content },
  );
  return data;
}

// --- Continuous Learning (Step 15) -----------------------------------------

export async function submitFeedback(vars: {
  employeeId: string;
  payload: CreateFeedbackDto;
}): Promise<EmployeeFeedbackDto> {
  const { data } = await apiClient.post<EmployeeFeedbackDto>(
    `/employees/${vars.employeeId}/feedback`,
    vars.payload,
  );
  return data;
}

export async function listMemories(
  employeeId: string,
): Promise<EmployeeMemoryDto[]> {
  const { data } = await apiClient.get<EmployeeMemoryDto[]>(
    `/employees/${employeeId}/memories`,
  );
  return data;
}

export async function teachMemory(vars: {
  employeeId: string;
  payload: CreateMemoryDto;
}): Promise<EmployeeMemoryDto> {
  const { data } = await apiClient.post<EmployeeMemoryDto>(
    `/employees/${vars.employeeId}/memories`,
    vars.payload,
  );
  return data;
}

export async function forgetMemory(vars: {
  employeeId: string;
  memoryId: string;
}): Promise<void> {
  await apiClient.delete(
    `/employees/${vars.employeeId}/memories/${vars.memoryId}`,
  );
}

export async function getLearning(
  employeeId: string,
): Promise<LearningSummaryDto> {
  const { data } = await apiClient.get<LearningSummaryDto>(
    `/employees/${employeeId}/learning`,
  );
  return data;
}
