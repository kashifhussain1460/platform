import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { Prisma } from '@prisma/client';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { readCredentials } from '../../skills/connectors/credentials.util';

/** `{{secret.NAME}}` — deliberately its own namespace, never a plain `{{NAME}}`. */
const SECRET_RE = /\{\{\s*secret\.([\w-]+)\s*\}\}/g;

/** What replaces a secret in anything persisted or logged. */
export const SECRET_MASK = '***';

export class UnknownSecretRefError extends Error {
  constructor(key: string, workflowId: string) {
    super(
      `Workflow ${workflowId} references secret "${key}" but no WorkflowSecretRef ` +
        `is registered for it. Register the reference first — a secret can never ` +
        `be inlined into node config.`,
    );
    this.name = 'UnknownSecretRefError';
  }
}

/**
 * P2-01 — resolves `{{secret.NAME}}` at EXECUTION time (doc 17 §7.17, doc 26 §7).
 *
 * This is the whole reason `WorkflowSecretRef` exists. A node config may only
 * ever contain a *reference*; the value is fetched from the connector's
 * encrypted credentials at the moment of the call and never written anywhere.
 *
 * Why it cannot be done earlier:
 *   • node config lives in `WorkflowVersion.definition`, which is IMMUTABLE and
 *     surfaced in run history, the builder UI and DLQ dumps
 *   • step output and the run context are both persisted verbatim
 * So a secret resolved even one step too early leaks into storage. Resolution
 * happens on the args handed to the connector, and `maskSecrets()` produces the
 * copy that is safe to persist.
 */
@Injectable()
export class SecretResolverService {
  private readonly logger = new Logger(SecretResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /** Every `{{secret.X}}` name mentioned anywhere in a value tree. */
  collectReferences(value: unknown): string[] {
    const found = new Set<string>();
    const walk = (node: unknown): void => {
      if (typeof node === 'string') {
        for (const match of node.matchAll(SECRET_RE)) {
          found.add(match[1]);
        }
        return;
      }
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node && typeof node === 'object') {
        Object.values(node as Record<string, unknown>).forEach(walk);
      }
    };
    walk(value);
    return [...found];
  }

  /**
   * Replace every `{{secret.X}}` with its real value.
   *
   * Returns the resolved tree AND the names it substituted, so the caller can
   * mask exactly those before persisting anything.
   */
  async resolve(
    companyId: string,
    workflowId: string,
    value: unknown,
  ): Promise<{ resolved: unknown; used: string[]; secretValues: string[] }> {
    const names = this.collectReferences(value);
    if (names.length === 0) {
      return { resolved: value, used: [], secretValues: [] };
    }

    const refs = await this.prisma.workflowSecretRef.findMany({
      where: { companyId, workflowId, key: { in: names } },
      include: { installedSkill: true },
    });

    const byKey = new Map(refs.map((r) => [r.key, r]));
    for (const name of names) {
      if (!byKey.has(name)) {
        // Fail loudly. Substituting an empty string would send a request with no
        // credential and surface as a confusing 401 from the provider.
        throw new UnknownSecretRefError(name, workflowId);
      }
    }

    const values = new Map<string, string>();
    for (const ref of refs) {
      values.set(ref.key, this.readCredentialField(ref));
    }

    const substitute = (node: unknown): unknown => {
      if (typeof node === 'string') {
        return node.replace(SECRET_RE, (_m, key: string) => values.get(key) ?? '');
      }
      if (Array.isArray(node)) return node.map(substitute);
      if (node && typeof node === 'object') {
        return Object.fromEntries(
          Object.entries(node as Record<string, unknown>).map(([k, v]) => [
            k,
            substitute(v),
          ]),
        );
      }
      return node;
    };

    this.logger.log(
      `secret.resolve workflow=${workflowId} company=${companyId} keys=[${names.join(', ')}]`,
    );
    // The VALUES are returned alongside the names so the caller can mask them
    // before persisting. Returning only the names would be useless — a secret is
    // substituted INTO an arg value, not stored under a key named after itself.
    return {
      resolved: substitute(value),
      used: names,
      secretValues: [...values.values()],
    };
  }

  /**
   * The version of a value that is safe to persist: every `{{secret.X}}` is left
   * as the literal placeholder, and any raw secret VALUE that leaked in is
   * replaced by `***`.
   *
   * Called on step output rather than trusting that nothing echoed a credential
   * back — a provider error message quoting the token it rejected is exactly the
   * kind of thing that would otherwise land in the run log.
   */
  mask(value: unknown, secretValues: string[]): unknown {
    if (secretValues.length === 0) return value;
    const walk = (node: unknown): unknown => {
      if (typeof node === 'string') {
        let out = node;
        for (const secret of secretValues) {
          if (secret && secret.length >= 4) {
            out = out.split(secret).join(SECRET_MASK);
          }
        }
        return out;
      }
      if (Array.isArray(node)) return node.map(walk);
      if (node && typeof node === 'object') {
        return Object.fromEntries(
          Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, walk(v)]),
        );
      }
      return node;
    };
    return walk(value);
  }

  /**
   * Read one field out of the connector's credential bundle.
   *
   * Uses the SHARED `readCredentials` util rather than decrypting here: secrets
   * live in an encrypted `{ enc: … }` envelope with a legacy-plaintext fallback,
   * and re-implementing that unwrapping would drift from the connector layer.
   */
  private readCredentialField(ref: {
    key: string;
    fieldName: string;
    installedSkill: { credentials: Prisma.JsonValue | null; skillKey: string };
  }): string {
    const creds = readCredentials(this.crypto, ref.installedSkill.credentials);
    const field = creds[ref.fieldName];
    if (typeof field !== 'string' || !field) {
      // Never echo the bundle or the attempted value into the message.
      throw new Error(
        `Secret "${ref.key}": connector "${ref.installedSkill.skillKey}" has no credential field "${ref.fieldName}"`,
      );
    }
    return field;
  }
}
