import { SensitiveScenarioService } from './sensitive-scenario.service';

describe('SensitiveScenarioService', () => {
  const svc = new SensitiveScenarioService();

  it('detects an explicit refund request', () => {
    expect(svc.detect('I want a refund for my order')).toEqual({
      category: 'REFUND',
      method: 'KEYWORD',
    });
    expect(svc.detect('Please issue a chargeback on this charge')).toEqual({
      category: 'REFUND',
      method: 'KEYWORD',
    });
  });

  it('does NOT flag a benign refund-policy question', () => {
    expect(svc.detect('What is the refund policy and how many days do customers have to request a refund?')).toBeUndefined();
    expect(svc.detect('Send a slack message to #general about our refund policy')).toBeUndefined();
  });

  it('detects a legal threat', () => {
    expect(svc.detect("I'm going to get my lawyer involved")).toEqual({
      category: 'LEGAL_THREAT',
      method: 'KEYWORD',
    });
    expect(svc.detect('This is heading to a lawsuit')).toEqual({
      category: 'LEGAL_THREAT',
      method: 'KEYWORD',
    });
  });

  it('detects an account deletion request', () => {
    expect(svc.detect('Please delete my account right now')).toEqual({
      category: 'ACCOUNT_DELETION',
      method: 'KEYWORD',
    });
  });

  it('detects an identity verification request', () => {
    expect(svc.detect('I need to verify my identity before we continue')).toEqual({
      category: 'IDENTITY_VERIFICATION',
      method: 'KEYWORD',
    });
  });

  it('detects a security incident report', () => {
    expect(svc.detect("I've been hacked, someone accessed my account")).toEqual({
      category: 'SECURITY_INCIDENT',
      method: 'KEYWORD',
    });
  });

  it('detects a disclosed PII value but not a routine card-payment mention', () => {
    expect(svc.detect('My ssn is 123-45-6789')).toEqual({
      category: 'PII_EXPOSURE',
      method: 'KEYWORD',
    });
    expect(svc.detect('Can I pay with credit card?')).toBeUndefined();
  });

  it('detects an explicit human-agent request', () => {
    expect(svc.detect('I want to talk to a human please')).toEqual({
      category: 'HUMAN_REQUESTED',
      method: 'KEYWORD',
    });
  });

  it('detects high-risk sentiment via the scored heuristic, not a single word', () => {
    expect(svc.detect('This is terrible service and I am furious')).toEqual({
      category: 'HIGH_RISK_SENTIMENT',
      method: 'SENTIMENT',
    });
    // A single mildly negative word alone must not trip it.
    expect(svc.detect('The wait was pretty awful today')).toBeUndefined();
    // One negative word plus a burst of exclamation marks also trips it.
    expect(svc.detect('This is ridiculous!!!')).toEqual({
      category: 'HIGH_RISK_SENTIMENT',
      method: 'SENTIMENT',
    });
  });

  it('returns undefined for ordinary support messages', () => {
    expect(svc.detect('How do I reset my password?')).toBeUndefined();
    expect(svc.detect('Thanks for the quick help!')).toBeUndefined();
  });
});
