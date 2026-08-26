'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AiEmployeeDto,
  ConversationDto,
  CreateEmployeeDto,
  CreateFeedbackDto,
  CreateMemoryDto,
  EmployeeFeedbackDto,
  EmployeeMemoryDto,
  LearningSummaryDto,
  MessageDto,
  RunResultDto,
  UpdateEmployeeDto,
} from '@vaep/types';
import type { NormalizedApiError } from '@/lib/apiClient';
import { useSessionStore } from '@/stores/session.store';
import {
  createEmployee,
  deleteEmployee,
  forgetMemory,
  getEmployee,
  getLearning,
  listConversations,
  listEmployees,
  listMemories,
  listMessages,
  sendMessage,
  startConversation,
  submitFeedback,
  teachMemory,
  updateEmployee,
} from './api';

export const employeeKeys = {
  all: ['employees'] as const,
  list: ['employees', 'list'] as const,
  detail: (id: string) => ['employees', 'detail', id] as const,
  conversations: (employeeId: string) =>
    ['employees', employeeId, 'conversations'] as const,
  messages: (conversationId: string) =>
    ['conversations', conversationId, 'messages'] as const,
  memories: (employeeId: string) =>
    ['employees', employeeId, 'memories'] as const,
  learning: (employeeId: string) =>
    ['employees', employeeId, 'learning'] as const,
};

// --- Employees -------------------------------------------------------------

export function useEmployees() {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<AiEmployeeDto[], NormalizedApiError>({
    queryKey: employeeKeys.list,
    queryFn: listEmployees,
    enabled: Boolean(accessToken),
  });
}

export function useEmployee(id: string) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<AiEmployeeDto, NormalizedApiError>({
    queryKey: employeeKeys.detail(id),
    queryFn: () => getEmployee(id),
    enabled: Boolean(accessToken && id),
  });
}

interface EmployeesContext {
  previous?: AiEmployeeDto[];
}

/** Create (optimistic): prepend a temp employee, roll back on error, settle-invalidate. */
export function useCreateEmployee() {
  const qc = useQueryClient();
  return useMutation<
    AiEmployeeDto,
    NormalizedApiError,
    CreateEmployeeDto,
    EmployeesContext
  >({
    mutationFn: createEmployee,
    onMutate: async (payload) => {
      await qc.cancelQueries({ queryKey: employeeKeys.list });
      const previous = qc.getQueryData<AiEmployeeDto[]>(employeeKeys.list);
      const optimistic: AiEmployeeDto = {
        id: `temp_${Date.now()}`,
        companyId: '',
        name: payload.name,
        role: payload.role,
        status: 'ACTIVE',
        persona: payload.persona ?? null,
        model: payload.model ?? null,
        department: null,
        managerName: null,
        workingHoursStart: null,
        workingHoursEnd: null,
        timezone: null,
        language: null,
        knowledgeAccess: 'ALL',
        budgetLimit: null,
        monthToDateCostUsd: null,
        maxCreditsPerExecution: null,
        maxCreditsPerTask: null,
        permissions: null,
        approvalRules: null,
        goals: null,
        kpiTargets: null,
        // A brand-new employee is never archived.
        archivedAt: null,
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData<AiEmployeeDto[]>(employeeKeys.list, (old) => [
        optimistic,
        ...(old ?? []),
      ]);
      return { previous };
    },
    onError: (_err, _payload, context) => {
      if (context?.previous) {
        qc.setQueryData(employeeKeys.list, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: employeeKeys.list });
    },
  });
}

interface UpdateVars {
  id: string;
  data: UpdateEmployeeDto;
}

/** Update (optimistic status/persona): patch the cached row, roll back on error. */
export function useUpdateEmployee() {
  const qc = useQueryClient();
  return useMutation<
    AiEmployeeDto,
    NormalizedApiError,
    UpdateVars,
    EmployeesContext
  >({
    mutationFn: updateEmployee,
    onMutate: async ({ id, data }) => {
      await qc.cancelQueries({ queryKey: employeeKeys.list });
      const previous = qc.getQueryData<AiEmployeeDto[]>(employeeKeys.list);
      qc.setQueryData<AiEmployeeDto[]>(employeeKeys.list, (old) =>
        (old ?? []).map((e) => (e.id === id ? { ...e, ...data } : e)),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(employeeKeys.list, context.previous);
      }
    },
    onSettled: (_data, _err, { id }) => {
      void qc.invalidateQueries({ queryKey: employeeKeys.list });
      void qc.invalidateQueries({ queryKey: employeeKeys.detail(id) });
    },
  });
}

/** Delete (optimistic): remove the row immediately, roll back on error. */
export function useDeleteEmployee() {
  const qc = useQueryClient();
  return useMutation<void, NormalizedApiError, string, EmployeesContext>({
    mutationFn: deleteEmployee,
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: employeeKeys.list });
      const previous = qc.getQueryData<AiEmployeeDto[]>(employeeKeys.list);
      qc.setQueryData<AiEmployeeDto[]>(employeeKeys.list, (old) =>
        (old ?? []).filter((e) => e.id !== id),
      );
      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous) {
        qc.setQueryData(employeeKeys.list, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: employeeKeys.list });
    },
  });
}

// --- Conversations ---------------------------------------------------------

export function useConversations(employeeId: string) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<ConversationDto[], NormalizedApiError>({
    queryKey: employeeKeys.conversations(employeeId),
    queryFn: () => listConversations(employeeId),
    enabled: Boolean(accessToken && employeeId),
  });
}

export function useStartConversation(employeeId: string) {
  const qc = useQueryClient();
  return useMutation<
    ConversationDto,
    NormalizedApiError,
    { title?: string }
  >({
    mutationFn: (vars) => startConversation({ employeeId, title: vars.title }),
    onSettled: () => {
      void qc.invalidateQueries({
        queryKey: employeeKeys.conversations(employeeId),
      });
    },
  });
}

// --- Messages --------------------------------------------------------------

export function useMessages(conversationId: string) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<MessageDto[], NormalizedApiError>({
    queryKey: employeeKeys.messages(conversationId),
    queryFn: () => listMessages(conversationId),
    enabled: Boolean(accessToken && conversationId),
  });
}

interface MessagesContext {
  previous?: MessageDto[];
}

/**
 * Send message (optimistic): append the user's message immediately; on success
 * append the assistant message from the RunResultDto; roll back on error; then
 * invalidate so the server truth (both persisted turns) replaces the optimism.
 */
export function useSendMessage(conversationId: string) {
  const qc = useQueryClient();
  return useMutation<
    RunResultDto,
    NormalizedApiError,
    { content: string },
    MessagesContext
  >({
    mutationFn: ({ content }) => sendMessage({ conversationId, content }),
    onMutate: async ({ content }) => {
      await qc.cancelQueries({ queryKey: employeeKeys.messages(conversationId) });
      const previous = qc.getQueryData<MessageDto[]>(
        employeeKeys.messages(conversationId),
      );
      const optimistic: MessageDto = {
        id: `temp_${Date.now()}`,
        companyId: '',
        conversationId,
        role: 'USER',
        content,
        metadata: null,
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData<MessageDto[]>(
        employeeKeys.messages(conversationId),
        (old) => [...(old ?? []), optimistic],
      );
      return { previous };
    },
    onSuccess: (result) => {
      qc.setQueryData<MessageDto[]>(
        employeeKeys.messages(conversationId),
        (old) => [...(old ?? []), result.message],
      );
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(
          employeeKeys.messages(conversationId),
          context.previous,
        );
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({
        queryKey: employeeKeys.messages(conversationId),
      });
    },
  });
}

// --- Continuous Learning (Step 15) -----------------------------------------

/** Learning summary (feedback tallies + memory counts + recent feedback). */
export function useEmployeeLearning(employeeId: string) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<LearningSummaryDto, NormalizedApiError>({
    queryKey: employeeKeys.learning(employeeId),
    queryFn: () => getLearning(employeeId),
    enabled: Boolean(accessToken && employeeId),
  });
}

/** Durable memories the employee has learned (FACT/SUMMARY, newest first). */
export function useEmployeeMemories(employeeId: string) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<EmployeeMemoryDto[], NormalizedApiError>({
    queryKey: employeeKeys.memories(employeeId),
    queryFn: () => listMemories(employeeId),
    enabled: Boolean(accessToken && employeeId),
  });
}

/**
 * Submit 👍/👎 feedback (optionally teaching a correction). Invalidates the
 * learning summary + memories (a taught correction becomes a FACT memory).
 */
export function useSubmitFeedback(employeeId: string) {
  const qc = useQueryClient();
  return useMutation<EmployeeFeedbackDto, NormalizedApiError, CreateFeedbackDto>({
    mutationFn: (payload) => submitFeedback({ employeeId, payload }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: employeeKeys.learning(employeeId) });
      void qc.invalidateQueries({ queryKey: employeeKeys.memories(employeeId) });
    },
  });
}

interface MemoriesContext {
  previous?: EmployeeMemoryDto[];
}

/** Teach a durable memory (optimistic prepend, roll back on error). */
export function useTeachMemory(employeeId: string) {
  const qc = useQueryClient();
  return useMutation<
    EmployeeMemoryDto,
    NormalizedApiError,
    CreateMemoryDto,
    MemoriesContext
  >({
    mutationFn: (payload) => teachMemory({ employeeId, payload }),
    onMutate: async (payload) => {
      await qc.cancelQueries({ queryKey: employeeKeys.memories(employeeId) });
      const previous = qc.getQueryData<EmployeeMemoryDto[]>(
        employeeKeys.memories(employeeId),
      );
      const optimistic: EmployeeMemoryDto = {
        id: `temp_${Date.now()}`,
        companyId: '',
        employeeId,
        kind: payload.kind,
        content: payload.content,
        source: 'MANUAL',
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData<EmployeeMemoryDto[]>(
        employeeKeys.memories(employeeId),
        (old) => [optimistic, ...(old ?? [])],
      );
      return { previous };
    },
    onError: (_err, _payload, context) => {
      if (context?.previous) {
        qc.setQueryData(employeeKeys.memories(employeeId), context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: employeeKeys.memories(employeeId) });
      void qc.invalidateQueries({ queryKey: employeeKeys.learning(employeeId) });
    },
  });
}

/** Forget a durable memory (optimistic removal, roll back on error). */
export function useForgetMemory(employeeId: string) {
  const qc = useQueryClient();
  return useMutation<void, NormalizedApiError, string, MemoriesContext>({
    mutationFn: (memoryId) => forgetMemory({ employeeId, memoryId }),
    onMutate: async (memoryId) => {
      await qc.cancelQueries({ queryKey: employeeKeys.memories(employeeId) });
      const previous = qc.getQueryData<EmployeeMemoryDto[]>(
        employeeKeys.memories(employeeId),
      );
      qc.setQueryData<EmployeeMemoryDto[]>(
        employeeKeys.memories(employeeId),
        (old) => (old ?? []).filter((m) => m.id !== memoryId),
      );
      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous) {
        qc.setQueryData(employeeKeys.memories(employeeId), context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: employeeKeys.memories(employeeId) });
      void qc.invalidateQueries({ queryKey: employeeKeys.learning(employeeId) });
    },
  });
}
