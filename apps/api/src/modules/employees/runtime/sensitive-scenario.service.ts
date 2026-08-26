import { Injectable } from '@nestjs/common';
import type {
  SensitiveScenarioCategory,
  SensitiveScenarioSignal,
} from '@vaep/types';

interface KeywordRule {
  category: SensitiveScenarioCategory;
  pattern: RegExp;
}

// Each pattern targets an ACTION/REQUEST, not a topic mention — "what is
// your refund policy" or "send a message about our refund policy" must NOT
// trip this (both appear as real chat messages in existing test fixtures);
// "I want a refund for my order" must.
const KEYWORD_RULES: KeywordRule[] = [
  {
    category: 'ACCOUNT_DELETION',
    pattern: /\b(delete|close|remove|erase|deactivate)\s+(my|this|our)\s+(account|profile|data)\b/i,
  },
  {
    category: 'LEGAL_THREAT',
    pattern: /\b(get|contact|hire|involve)\s+(my|a)\s+(lawyer|attorney)\b|\blawsuit\b|\bsue\s+(you|your\s+company|this\s+company)\b|\blegal\s+action\b/i,
  },
  {
    category: 'SECURITY_INCIDENT',
    pattern: /\b(i(?:'|’)?ve\s+been\s+hacked|my\s+account\s+(?:was|is)\s+hacked|unauthorized\s+access|data\s+breach|security\s+breach|account\s+(?:was|is)\s+compromised)\b/i,
  },
  {
    category: 'PII_EXPOSURE',
    // An actual disclosed value (SSN-shaped or a 13-16 digit card-shaped
    // number), or an explicit "my ssn/card number is" phrase — not a bare
    // mention of "credit card" ("can I pay by credit card" is routine).
    pattern: /\b\d{3}-\d{2}-\d{4}\b|\b\d{13,16}\b|\bmy\s+(ssn|social\s+security\s+number|card\s+number|passport\s+number)\s+is\b/i,
  },
  {
    category: 'IDENTITY_VERIFICATION',
    pattern: /\bverify\s+my\s+identity\b|\bprove\s+(who|that)\s+i\s+am\b|\bidentity\s+verification\b/i,
  },
  {
    category: 'REFUND',
    pattern: /\b(i\s+(?:want|need|would\s+like|demand)|please\s+(?:give|issue)\s+me)\s+(a\s+)?refund\b|\brefund\s+my\s+(order|purchase|payment|money)\b|\bchargeback\b|\bcharge\s?back\b|\bmoney\s+back\b|\bdispute\s+(this|the|my)\s+charge\b/i,
  },
  {
    category: 'HUMAN_REQUESTED',
    pattern: /\btalk\s+to\s+a\s+human\b|\bspeak\s+to\s+a\s+(human|person|agent)\b|\breal\s+person\b|\bhuman\s+agent\b|\bescalate\s+(this|me)\b/i,
  },
];

const NEGATIVE_SENTIMENT_WORDS = [
  'furious',
  'outraged',
  'disgusted',
  'unacceptable',
  'ridiculous',
  'awful',
  'horrible',
  'scam',
  'fraud',
  'disgusting',
  'pathetic',
  'terrible service',
  'worst experience',
];

/**
 * S-06: layered, deterministic sensitive-scenario detector. Deliberately NOT
 * a single flat keyword list — 7 categories use exact-phrase/action pattern
 * matching, one (HIGH_RISK_SENTIMENT) uses a scored heuristic over
 * negative-emotion words + exclamation density, per the explicit instruction
 * that keyword matching alone must not be the only protection.
 *
 * Deliberately NOT Support-specific: any AI Employee's incoming user text can
 * carry a sensitive scenario (an HR harassment complaint, a Marketing lead
 * threatening legal action) — this lives beside PlannerService/
 * ValidationService in the shared runtime, not inside the support engine.
 *
 * A genuine LLM-based semantic layer (catching paraphrases neither of the
 * above would match) is a valid future enhancement, deliberately deferred
 * here: it would run on every turn regardless of role, add real latency/cost,
 * and be entirely inert under the deterministic mock provider this repo
 * tests against — shipping it now would be unverifiable theatre for the very
 * environment that has to prove it works. This is a real, stated limitation,
 * not a silent one.
 */
@Injectable()
export class SensitiveScenarioService {
  detect(userText: string): SensitiveScenarioSignal | undefined {
    for (const rule of KEYWORD_RULES) {
      if (rule.pattern.test(userText)) {
        return { category: rule.category, method: 'KEYWORD' };
      }
    }
    if (this.isHighRiskSentiment(userText)) {
      return { category: 'HIGH_RISK_SENTIMENT', method: 'SENTIMENT' };
    }
    return undefined;
  }

  private isHighRiskSentiment(userText: string): boolean {
    const lower = userText.toLowerCase();
    const negativeHits = NEGATIVE_SENTIMENT_WORDS.filter((w) =>
      lower.includes(w),
    ).length;
    const exclamations = (userText.match(/!/g) ?? []).length;
    // A SCORE, not a single keyword hit: needs either 2+ distinct
    // negative-emotion words, or 1 negative word plus a burst of exclamation
    // marks — a single mildly negative word ("terrible wait time today")
    // must not trip this on its own.
    return negativeHits >= 2 || (negativeHits >= 1 && exclamations >= 3);
  }
}
