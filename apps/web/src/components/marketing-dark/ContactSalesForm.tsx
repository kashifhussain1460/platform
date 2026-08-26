'use client';

import { useState, type FormEvent } from 'react';
import { Send } from 'lucide-react';

/**
 * There is no lead-capture backend anywhere in this codebase (confirmed: no
 * contact/lead module, no CRM webhook). Rather than invent a fake submission
 * API, this composes the same `mailto:sales@orlixa.io` mechanism the pricing
 * FAQ already uses, pre-filled from the form fields, and opens it in the
 * visitor's own mail client — an honest "form" with no backend to fake.
 */
export function ContactSalesForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [teamSize, setTeamSize] = useState('');
  const [message, setMessage] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const subject = `Enterprise inquiry — ${company || name}`;
    const body = [
      `Name: ${name}`,
      `Work email: ${email}`,
      `Company: ${company}`,
      teamSize && `Team size: ${teamSize}`,
      '',
      message,
    ]
      .filter(Boolean)
      .join('\n');
    window.location.href = `mailto:sales@orlixa.io?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="cs-name" className="text-sm font-medium text-zinc-300">
            Full name
          </label>
          <input
            id="cs-name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="field-modern mt-2"
            placeholder="Jordan Lee"
          />
        </div>
        <div>
          <label htmlFor="cs-email" className="text-sm font-medium text-zinc-300">
            Work email
          </label>
          <input
            id="cs-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="field-modern mt-2"
            placeholder="jordan@company.com"
          />
        </div>
        <div>
          <label htmlFor="cs-company" className="text-sm font-medium text-zinc-300">
            Company
          </label>
          <input
            id="cs-company"
            type="text"
            required
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            className="field-modern mt-2"
            placeholder="Acme Inc."
          />
        </div>
        <div>
          <label htmlFor="cs-team-size" className="text-sm font-medium text-zinc-300">
            Team size
          </label>
          <select
            id="cs-team-size"
            value={teamSize}
            onChange={(e) => setTeamSize(e.target.value)}
            className="field-modern mt-2"
          >
            <option value="">Select one</option>
            <option>1–10</option>
            <option>11–50</option>
            <option>51–200</option>
            <option>201–1,000</option>
            <option>1,000+</option>
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="cs-message" className="text-sm font-medium text-zinc-300">
          What are you looking to automate?
        </label>
        <textarea
          id="cs-message"
          rows={4}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="field-modern mt-2"
          placeholder="Tell us about your team and what you'd like your AI workforce to handle."
        />
      </div>

      <button
        type="submit"
        className="inline-flex items-center gap-2 rounded-full bg-violet px-6 py-3.5 text-[15px] font-semibold text-white transition-transform hover:scale-[1.02] hover:bg-violet-hover"
      >
        <Send className="h-4 w-4" aria-hidden />
        Email our sales team
      </button>
      <p className="text-xs text-fg-muted">
        This opens your email client with a message addressed to sales@orlixa.io — nothing is
        sent automatically.
      </p>
    </form>
  );
}
