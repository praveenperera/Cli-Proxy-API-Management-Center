import { describe, expect, test } from 'bun:test';
import {
  buildAuthFileFieldsPatch,
  type PrefixProxyEditorState,
} from '../src/features/authFiles/hooks/useAuthFilesPrefixProxyEditor';
import { quotaWeightEditorFields, updateQuotaWeight } from '../src/features/authFiles/quotaWeight';

const makeEditor = (
  json: Record<string, unknown>,
  quotaWeight: string
): PrefixProxyEditorState => ({
  fileName: 'credential.json',
  fileInfoText: '',
  loading: false,
  saving: false,
  error: null,
  originalText: JSON.stringify(json),
  rawText: JSON.stringify(json),
  invalidContentPreview: '',
  json,
  providerKey: 'claude',
  prefix: '',
  proxyUrl: '',
  priority: '',
  weight: '',
  weightError: null,
  quotaWeight,
  quotaWeightError: null,
  disableCooling: false,
  disableCoolingTouched: false,
  websockets: false,
  websocketsTouched: false,
  useSiwc: false,
  useSiwcTouched: false,
  usingApi: false,
  usingApiTouched: false,
  note: '',
  noteTouched: false,
  excludedModelsText: '',
  excludedModelsTouched: false,
  headersText: '',
  headersTouched: false,
  headersError: null,
});

const resolveError = (key: string) => key;

describe('auth-file quota weight patch', () => {
  test('writes a decimal weight and uses null to restore the default', () => {
    expect(buildAuthFileFieldsPatch(makeEditor({}, '2'), resolveError)).toEqual({
      quota_weight: 2,
    });
    expect(buildAuthFileFieldsPatch(makeEditor({}, '1.7'), resolveError)).toEqual({
      quota_weight: 1.7,
    });
    expect(buildAuthFileFieldsPatch(makeEditor({ quota_weight: 2 }, ''), resolveError)).toEqual({
      quota_weight: null,
    });
    expect(buildAuthFileFieldsPatch(makeEditor({ quota_weight: 2 }, '2'), resolveError)).toEqual(
      {}
    );
  });

  test('rejects zero, negative, oversized, and non-numeric weights', () => {
    for (const text of ['0', '-1', '1001', 'abc']) {
      expect(() => buildAuthFileFieldsPatch(makeEditor({}, text), resolveError)).toThrow(
        'auth_files.quota_weight_invalid'
      );
    }
  });

  test('loads the stored weight and flags an invalid edit', () => {
    expect(quotaWeightEditorFields({ quota_weight: 5 })).toEqual({
      quotaWeight: '5',
      quotaWeightError: null,
    });
    expect(quotaWeightEditorFields({ quota_weight: 0 }).quotaWeight).toBe('');
    expect(updateQuotaWeight('abc', resolveError).quotaWeightError).toBe(
      'auth_files.quota_weight_invalid'
    );
    expect(updateQuotaWeight('10', resolveError)).toEqual({
      quotaWeight: '10',
      quotaWeightError: null,
    });
  });
});
