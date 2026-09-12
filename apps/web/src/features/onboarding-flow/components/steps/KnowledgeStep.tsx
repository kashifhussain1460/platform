'use client';

import { useRef, useState } from 'react';
import { FileText, Upload, X } from 'lucide-react';
import { KNOWLEDGE_SUGGESTIONS, templateFor } from '../../mockData';
import { useOnboardingFlow } from '../../state';
import { EmployeeContextHeader } from '../EmployeeContextHeader';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

type Tab = 'upload' | 'text' | 'existing';

export function KnowledgeStep() {
  const { state, dispatch, activeEmployee, goToStep, prevStep } = useOnboardingFlow();
  const [tab, setTab] = useState<Tab>('upload');
  const [dragOver, setDragOver] = useState(false);
  const [textValue, setTextValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  if (!activeEmployee) {
    return (
      <FlowShell heading="Knowledge">
        <p className="text-sm text-app-ink-3">No AI Employees selected yet.</p>
        <StepFooter onBack={prevStep} onContinue={() => goToStep('configureEmployees')} />
      </FlowShell>
    );
  }

  const template = templateFor(activeEmployee.templateKey);
  const scope = activeEmployee.id;
  const docs = state.knowledgeDocs.filter((d) => d.scope === scope);
  const backToHub = () => goToStep('configureEmployees');

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      dispatch({
        type: 'ADD_KNOWLEDGE_DOC',
        name: file.name,
        sizeLabel: `${Math.max(1, Math.round(file.size / 1024))} KB`,
        scope,
        source: 'upload',
      });
    }
  };

  const addSuggested = (name: string, sizeLabel: string) => {
    if (docs.some((d) => d.name === name)) return;
    dispatch({ type: 'ADD_KNOWLEDGE_DOC', name, sizeLabel, scope, source: 'suggested' });
  };

  const addText = () => {
    if (!textValue.trim()) return;
    dispatch({
      type: 'ADD_KNOWLEDGE_DOC',
      name: textValue.trim().slice(0, 40) || 'Untitled note',
      sizeLabel: `${textValue.trim().length} chars`,
      scope,
      source: 'text',
    });
    setTextValue('');
  };

  return (
    <FlowShell
      heading={`Add Knowledge for ${activeEmployee.name || template.name}`}
      subtitle="Upload or connect the information this employee will use to give accurate, on-brand answers."
    >
      <EmployeeContextHeader employee={activeEmployee} />

      <div className="flex gap-1 rounded-xl border border-white/[0.08] bg-white/[0.02] p-1">
        {(
          [
            ['upload', 'Upload Files'],
            ['text', 'Add Text'],
            ['existing', 'Use Existing'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`flex-1 rounded-lg py-2 text-sm font-medium transition-colors ${
              tab === id ? 'bg-violet text-white' : 'text-zinc-300 hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-5">
        {tab === 'upload' && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              addFiles(e.dataTransfer.files);
            }}
            className={`rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
              dragOver ? 'border-violet-secondary bg-violet/[0.06]' : 'border-white/[0.12]'
            }`}
          >
            <Upload className="mx-auto h-8 w-8 text-violet-secondary" />
            <p className="mt-3 text-sm text-zinc-300">Drag and drop files here</p>
            <p className="mt-1 text-xs text-fg-muted">PDF, DOC, TXT, MD (Max 10MB)</p>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => addFiles(e.target.files)}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="mt-4 rounded-xl border border-white/[0.1] px-4 py-2 text-sm font-medium text-zinc-300 hover:border-white/[0.2]"
            >
              Browse Files
            </button>
          </div>
        )}

        {tab === 'text' && (
          <div>
            <textarea
              className="field-modern min-h-[140px] resize-none"
              placeholder="Paste or write company context here…"
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
            />
            <button
              type="button"
              onClick={addText}
              disabled={!textValue.trim()}
              className="mt-3 rounded-xl bg-violet px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Add note
            </button>
          </div>
        )}

        {tab === 'existing' && (
          <p className="rounded-xl border border-dashed border-white/[0.1] px-4 py-6 text-center text-sm text-fg-muted">
            No existing knowledge base yet — upload your first document to start one.
          </p>
        )}
      </div>

      {docs.length > 0 && (
        <ul className="mt-5 space-y-2">
          {docs.map((doc) => (
            <li
              key={doc.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-2.5"
            >
              <div className="flex min-w-0 items-center gap-3">
                <FileText className="h-4 w-4 shrink-0 text-violet-secondary" />
                <span className="truncate text-sm text-zinc-200">{doc.name}</span>
                <span className="shrink-0 text-xs text-fg-muted">{doc.sizeLabel}</span>
              </div>
              <button
                type="button"
                aria-label={`Remove ${doc.name}`}
                onClick={() => dispatch({ type: 'REMOVE_KNOWLEDGE_DOC', id: doc.id })}
                className="text-fg-muted hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-5">
        <p className="mb-2 text-xs text-fg-muted">Suggested documents</p>
        <div className="flex flex-wrap gap-2">
          {KNOWLEDGE_SUGGESTIONS.map((s) => {
            const added = docs.some((d) => d.name === s.name);
            return (
              <button
                key={s.name}
                type="button"
                disabled={added}
                onClick={() => addSuggested(s.name, s.sizeLabel)}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  added
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                    : 'border-white/[0.1] text-zinc-300 hover:border-white/[0.2]'
                }`}
              >
                {added ? `✓ ${s.name}` : s.name}
              </button>
            );
          })}
        </div>
      </div>

      <StepFooter onBack={backToHub} onContinue={backToHub} continueLabel="Save & Back to Hub →" />
    </FlowShell>
  );
}
