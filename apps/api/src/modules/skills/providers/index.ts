import { registerProviderAdapter } from './provider-adapter';
import { smtpAdapter } from './smtp.adapter';
import { gmailAdapter } from './gmail.adapter';
import { calendarAdapter } from './calendar.adapter';
import { gdriveAdapter } from './gdrive.adapter';

/**
 * Provider adapter registration (plan §28/§36).
 *
 * Importing THIS file is what turns a provider on. Adding one is a single line
 * here plus its adapter file — the registry never imports the skills module, so
 * a new provider cannot create an import cycle.
 *
 * Only providers with a REAL verification live here. A skill listed without a
 * working `validateCredentials` would make the §37 gate reject connections it
 * has no way to check, which is worse than the permissive path it replaces.
 */
registerProviderAdapter(smtpAdapter);
registerProviderAdapter(gmailAdapter);
registerProviderAdapter(calendarAdapter);
registerProviderAdapter(gdriveAdapter);

export * from './provider-adapter';
export { smtpAdapter, resolveSmtpSettings, SMTP_FIELDS } from './smtp.adapter';
