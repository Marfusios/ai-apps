/** Case records of the mock API, the fixture corpus's projection (web/mock/cases.json), as copies to change. */
import type { CaseDetail } from '../../shared/contracts/cases.js';
import cases from '../../web/mock/cases.json' with { type: 'json' };

export function mockCase(ntsbNo: string): CaseDetail {
  const detail = (cases as unknown as Record<string, CaseDetail>)[ntsbNo];
  if (!detail) throw new Error(`no fixture ${ntsbNo}`);
  return structuredClone(detail);
}
