'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useConnectWhatsAppAccount, useWhatsAppAccount } from '../hooks';

/**
 * The `WhatsAppAccount` connect form.
 *
 * A dedicated form, not the generic Skill Config `api_key` connector: that
 * flow only ever writes `InstalledSkill.credentials`, and `WhatsAppAccount` is
 * its own top-level table with no FK back to `InstalledSkill` — Task 9's
 * catalog entry alone cannot connect this. Posts to
 * `POST /engines/whatsapp/accounts`, which does the encrypt-and-upsert.
 */
export function WhatsAppConnectForm({
  onConnected,
}: { onConnected?: () => void } = {}) {
  const { data: account, isLoading } = useWhatsAppAccount();
  const connect = useConnectWhatsAppAccount();

  const [twilioAccountSid, setTwilioAccountSid] = useState('');
  const [twilioAuthToken, setTwilioAuthToken] = useState('');
  const [whatsappSenderNumber, setWhatsappSenderNumber] = useState('');

  const isConnected = account?.status === 'CONNECTED';
  const canSubmit =
    twilioAccountSid.trim().length > 0 &&
    twilioAuthToken.trim().length > 0 &&
    whatsappSenderNumber.trim().length > 0;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    connect.mutate(
      { twilioAccountSid, twilioAuthToken, whatsappSenderNumber },
      {
        onSuccess: () => {
          setTwilioAuthToken('');
          onConnected?.();
        },
      },
    );
  };

  if (isLoading) {
    return <p className="text-sm text-app-ink-3">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      {isConnected && (
        <div className="rounded-2xl border border-app-border bg-app-surface p-4">
          <p className="text-sm text-app-ink">
            Connected — sending from{' '}
            <span className="font-medium">{account?.whatsappSenderNumber}</span>
          </p>
          <p className="mt-1 text-xs text-app-ink-3">
            Account SID {account?.twilioAccountSid}. Reconnect below to change the
            number or rotate the auth token.
          </p>
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="wa-sid" className="mb-1.5 block text-sm font-medium text-app-ink-2">
              Twilio Account SID <span className="text-red-600">*</span>
            </label>
            <input
              id="wa-sid"
              type="text"
              className="field-modern"
              placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              value={twilioAccountSid}
              onChange={(e) => setTwilioAccountSid(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="wa-token" className="mb-1.5 block text-sm font-medium text-app-ink-2">
              Twilio Auth Token <span className="text-red-600">*</span>
            </label>
            <input
              id="wa-token"
              type="password"
              className="field-modern"
              placeholder="Auth token"
              value={twilioAuthToken}
              onChange={(e) => setTwilioAuthToken(e.target.value)}
            />
            <p className="mt-1 text-xs text-app-ink-3">
              Stored encrypted-at-rest; never returned in responses.
            </p>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="wa-number" className="mb-1.5 block text-sm font-medium text-app-ink-2">
              WhatsApp sender number <span className="text-red-600">*</span>
            </label>
            <input
              id="wa-number"
              type="text"
              className="field-modern"
              placeholder="+15550001111"
              value={whatsappSenderNumber}
              onChange={(e) => setWhatsappSenderNumber(e.target.value)}
            />
            <p className="mt-1 text-xs text-app-ink-3">
              The approved WhatsApp Business number this company sends from, in
              E.164 format.
            </p>
          </div>
        </div>

        {connect.isError && (
          <p className="text-sm text-red-600">
            {connect.error?.message ?? 'Could not connect this account'}
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button type="submit" variant="violet" disabled={!canSubmit || connect.isPending}>
            {connect.isPending ? 'Connecting…' : isConnected ? 'Reconnect' : 'Connect WhatsApp'}
          </Button>
          {connect.isSuccess && !connect.isPending && (
            <span className="text-sm text-green-700">Connected.</span>
          )}
        </div>
      </form>
    </div>
  );
}
