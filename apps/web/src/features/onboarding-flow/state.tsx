'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import { skillFor, templateFor } from './mockData';
import type {
  ConnectionState,
  DraftEmployee,
  EmployeeReadiness,
  EmployeeTemplateKey,
  FieldErrors,
  FlowStep,
  OnboardingFlowState,
  PlanKey,
} from './types';
import { FLOW_STEPS } from './types';

const initialState: OnboardingFlowState = {
  step: 'welcome',
  company: { name: '', industry: '', size: '', website: '' },
  goals: [],
  billingCycle: 'monthly',
  planKey: 'BUSINESS',
  selectedTemplateKeys: [],
  employees: [],
  activeEmployeeId: null,
  knowledgeDocs: [],
  activatedEmployeeIds: [],
  errors: {},
};

type Action =
  | { type: 'GO_TO_STEP'; step: FlowStep }
  | { type: 'NEXT_STEP' }
  | { type: 'PREV_STEP' }
  | { type: 'SET_COMPANY_FIELD'; field: keyof OnboardingFlowState['company']; value: string }
  | { type: 'TOGGLE_GOAL'; key: string }
  | { type: 'SET_BILLING_CYCLE'; cycle: 'monthly' | 'yearly' }
  | { type: 'SET_PLAN'; key: PlanKey }
  | { type: 'TOGGLE_EMPLOYEE_TEMPLATE'; key: EmployeeTemplateKey }
  | { type: 'SET_ACTIVE_EMPLOYEE'; id: string }
  | { type: 'UPDATE_EMPLOYEE_FIELD'; id: string; field: 'name' | 'role' | 'persona' | 'language'; value: string }
  | { type: 'TOGGLE_EMPLOYEE_SKILL'; employeeId: string; skillKey: string }
  | { type: 'SET_CONNECTION_STATE'; employeeId: string; skillKey: string; state: ConnectionState }
  | { type: 'ADD_KNOWLEDGE_DOC'; name: string; sizeLabel: string; scope: string; source: 'upload' | 'suggested' | 'text' }
  | { type: 'REMOVE_KNOWLEDGE_DOC'; id: string }
  | { type: 'TOGGLE_EMPLOYEE_WORKFLOW'; employeeId: string; workflowKey: string }
  | { type: 'SET_EMPLOYEE_SETUP_COMPLETE'; id: string; complete: boolean }
  | { type: 'ACTIVATE_EMPLOYEE'; id: string }
  | { type: 'SET_ERRORS'; errors: FieldErrors }
  | { type: 'CLEAR_ERROR'; field: string }
  | { type: 'RESET' };

let draftCounter = 0;
function nextDraftId(prefix: string): string {
  draftCounter += 1;
  return `${prefix}_${draftCounter}`;
}

function makeDraftEmployee(key: EmployeeTemplateKey): DraftEmployee {
  const template = templateFor(key);
  return {
    id: nextDraftId(key.toLowerCase()),
    templateKey: key,
    name: key === 'CUSTOM' ? '' : template.name.replace(' AI', ''),
    role: template.name,
    persona: template.defaultPersona,
    language: 'English',
    skillKeys: [...template.suggestedSkillKeys],
    connections: Object.fromEntries(
      template.suggestedSkillKeys.map((k) => [k, 'not_connected' as ConnectionState]),
    ),
    workflowKeys: [],
    setupComplete: false,
  };
}

/** First employee (in list order) whose turn through the Configure Hub isn't
 * done yet — what the Hub should show, and where "Next Employee" lands. */
export function nextIncompleteEmployee(
  employees: DraftEmployee[],
  excludeId?: string,
): DraftEmployee | null {
  return employees.find((e) => e.id !== excludeId && !e.setupComplete) ?? null;
}

function reducer(state: OnboardingFlowState, action: Action): OnboardingFlowState {
  switch (action.type) {
    case 'GO_TO_STEP':
      return { ...state, step: action.step, errors: {} };

    case 'NEXT_STEP': {
      const idx = FLOW_STEPS.indexOf(state.step);
      const next = FLOW_STEPS[Math.min(idx + 1, FLOW_STEPS.length - 1)];
      return { ...state, step: next, errors: {} };
    }

    case 'PREV_STEP': {
      const idx = FLOW_STEPS.indexOf(state.step);
      const prev = FLOW_STEPS[Math.max(idx - 1, 0)];
      return { ...state, step: prev, errors: {} };
    }

    case 'SET_COMPANY_FIELD':
      return {
        ...state,
        company: { ...state.company, [action.field]: action.value },
      };

    case 'TOGGLE_GOAL': {
      const has = state.goals.includes(action.key);
      return {
        ...state,
        goals: has ? state.goals.filter((g) => g !== action.key) : [...state.goals, action.key],
      };
    }

    case 'SET_BILLING_CYCLE':
      return { ...state, billingCycle: action.cycle };

    case 'SET_PLAN':
      return { ...state, planKey: action.key };

    case 'TOGGLE_EMPLOYEE_TEMPLATE': {
      const has = state.selectedTemplateKeys.includes(action.key);
      if (has) {
        // Selecting is reversible; unselecting drops any draft built for it too,
        // so `employees[]` never holds a row for a template the user unchecked.
        return {
          ...state,
          selectedTemplateKeys: state.selectedTemplateKeys.filter((k) => k !== action.key),
          employees: state.employees.filter((e) => e.templateKey !== action.key),
        };
      }
      return {
        ...state,
        selectedTemplateKeys: [...state.selectedTemplateKeys, action.key],
        employees: [...state.employees, makeDraftEmployee(action.key)],
      };
    }

    case 'SET_ACTIVE_EMPLOYEE':
      return { ...state, activeEmployeeId: action.id };

    case 'UPDATE_EMPLOYEE_FIELD':
      return {
        ...state,
        employees: state.employees.map((e) =>
          e.id === action.id ? { ...e, [action.field]: action.value } : e,
        ),
      };

    case 'TOGGLE_EMPLOYEE_SKILL':
      return {
        ...state,
        employees: state.employees.map((e) => {
          if (e.id !== action.employeeId) return e;
          const has = e.skillKeys.includes(action.skillKey);
          return {
            ...e,
            skillKeys: has
              ? e.skillKeys.filter((k) => k !== action.skillKey)
              : [...e.skillKeys, action.skillKey],
            connections: has
              ? e.connections
              : { ...e.connections, [action.skillKey]: e.connections[action.skillKey] ?? 'not_connected' },
          };
        }),
      };

    case 'SET_CONNECTION_STATE':
      return {
        ...state,
        employees: state.employees.map((e) =>
          e.id === action.employeeId
            ? { ...e, connections: { ...e.connections, [action.skillKey]: action.state } }
            : e,
        ),
      };

    case 'ADD_KNOWLEDGE_DOC':
      return {
        ...state,
        knowledgeDocs: [
          ...state.knowledgeDocs,
          {
            id: nextDraftId('doc'),
            name: action.name,
            sizeLabel: action.sizeLabel,
            scope: action.scope,
            source: action.source,
          },
        ],
      };

    case 'REMOVE_KNOWLEDGE_DOC':
      return {
        ...state,
        knowledgeDocs: state.knowledgeDocs.filter((d) => d.id !== action.id),
      };

    case 'TOGGLE_EMPLOYEE_WORKFLOW':
      return {
        ...state,
        employees: state.employees.map((e) => {
          if (e.id !== action.employeeId) return e;
          const has = e.workflowKeys.includes(action.workflowKey);
          return {
            ...e,
            workflowKeys: has
              ? e.workflowKeys.filter((k) => k !== action.workflowKey)
              : [...e.workflowKeys, action.workflowKey],
          };
        }),
      };

    case 'SET_EMPLOYEE_SETUP_COMPLETE':
      return {
        ...state,
        employees: state.employees.map((e) =>
          e.id === action.id ? { ...e, setupComplete: action.complete } : e,
        ),
      };

    case 'ACTIVATE_EMPLOYEE':
      return {
        ...state,
        activatedEmployeeIds: state.activatedEmployeeIds.includes(action.id)
          ? state.activatedEmployeeIds
          : [...state.activatedEmployeeIds, action.id],
      };

    case 'SET_ERRORS':
      return { ...state, errors: action.errors };

    case 'CLEAR_ERROR': {
      if (!(action.field in state.errors)) return state;
      const errors = { ...state.errors };
      delete errors[action.field];
      return { ...state, errors };
    }

    case 'RESET':
      return initialState;

    default:
      return state;
  }
}

/**
 * Readiness, computed the same shape as the REAL backend's
 * `employee-readiness.ts` (BLOCKER only for a genuinely broken dependency —
 * a required skill with no connection; WARNING for things that are merely
 * incomplete but don't stop the employee from being hired). Kept as a pure
 * function so Phase 2 can literally replace this with the real endpoint
 * without touching any component that reads its shape.
 */
export function computeReadiness(employee: DraftEmployee): EmployeeReadiness {
  const issues: EmployeeReadiness['issues'] = [];

  const skillsMissing = employee.skillKeys.length === 0;
  if (skillsMissing) {
    issues.push({
      code: 'NO_SKILLS_ASSIGNED',
      severity: 'WARNING',
      message: `${employee.name || 'This employee'} has no skills yet, so it can answer questions but cannot take any action.`,
    });
  }

  const unreadySkills = employee.skillKeys.filter((key) => {
    const def = skillFor(key);
    if (!def?.requiresConnection) return false;
    return employee.connections[key] !== 'connected';
  });
  for (const key of unreadySkills) {
    const def = skillFor(key);
    issues.push({
      code: 'SKILL_NOT_CONNECTED',
      severity: 'BLOCKER',
      message: `${def?.name ?? key} is not connected, so ${employee.name || 'this employee'} cannot use it yet.`,
    });
  }

  if (employee.workflowKeys.length === 0) {
    issues.push({
      code: 'NO_WORKFLOWS',
      severity: 'WARNING',
      message: `${employee.name || 'This employee'} is not used by any workflow yet, so it only works in chat.`,
    });
  }

  const ready = issues.every((i) => i.severity !== 'BLOCKER');

  return {
    ready,
    issues,
    checks: [
      { key: 'BASIC', label: 'Basic Information', status: employee.name.trim() ? 'PASS' : 'FAIL' },
      { key: 'SKILLS', label: 'Skills Assigned', status: skillsMissing ? 'WARN' : 'PASS' },
      {
        key: 'CONNECTIONS',
        label: 'Connections',
        status: unreadySkills.length > 0 ? 'FAIL' : 'PASS',
      },
      { key: 'KNOWLEDGE', label: 'Knowledge', status: 'PASS' },
      {
        key: 'WORKFLOWS',
        label: 'Workflows',
        status: employee.workflowKeys.length === 0 ? 'WARN' : 'PASS',
      },
    ],
  };
}

interface OnboardingFlowContextValue {
  state: OnboardingFlowState;
  dispatch: (action: Action) => void;
  goToStep: (step: FlowStep) => void;
  nextStep: () => void;
  prevStep: () => void;
  activeEmployee: DraftEmployee | null;
  readinessFor: (employeeId: string) => EmployeeReadiness;
  setErrors: (errors: FieldErrors) => void;
}

const OnboardingFlowContext = createContext<OnboardingFlowContextValue | null>(null);

export function OnboardingFlowProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const goToStep = useCallback((step: FlowStep) => dispatch({ type: 'GO_TO_STEP', step }), []);
  const nextStep = useCallback(() => dispatch({ type: 'NEXT_STEP' }), []);
  const prevStep = useCallback(() => dispatch({ type: 'PREV_STEP' }), []);
  const setErrors = useCallback((errors: FieldErrors) => dispatch({ type: 'SET_ERRORS', errors }), []);

  const activeEmployee = useMemo(
    () => state.employees.find((e) => e.id === state.activeEmployeeId) ?? state.employees[0] ?? null,
    [state.employees, state.activeEmployeeId],
  );

  const readinessFor = useCallback(
    (employeeId: string): EmployeeReadiness => {
      const employee = state.employees.find((e) => e.id === employeeId);
      return employee
        ? computeReadiness(employee)
        : { ready: false, checks: [], issues: [] };
    },
    [state.employees],
  );

  const value = useMemo<OnboardingFlowContextValue>(
    () => ({ state, dispatch, goToStep, nextStep, prevStep, activeEmployee, readinessFor, setErrors }),
    [state, goToStep, nextStep, prevStep, activeEmployee, readinessFor, setErrors],
  );

  return (
    <OnboardingFlowContext.Provider value={value}>{children}</OnboardingFlowContext.Provider>
  );
}

export function useOnboardingFlow(): OnboardingFlowContextValue {
  const ctx = useContext(OnboardingFlowContext);
  if (!ctx) {
    throw new Error('useOnboardingFlow must be used within OnboardingFlowProvider');
  }
  return ctx;
}
