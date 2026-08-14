import { describe, expect, it, vi } from 'vitest';
import { measureAsyncOperation } from '../tools/elapsed-evidence.mjs';

describe('elapsed evidence', () => {
  it('measures the actual awaited operation using a monotonic clock', async () => {
    const now = vi.fn().mockReturnValueOnce(100.25).mockReturnValueOnce(107.5);
    const operation = vi.fn().mockResolvedValue('result');

    await expect(measureAsyncOperation(operation, now)).resolves.toEqual({
      value: 'result',
      elapsedMs: 7.25,
    });
    expect(operation).toHaveBeenCalledOnce();
  });

  it('rejects a clock that moves backwards instead of emitting false evidence', async () => {
    const now = vi.fn().mockReturnValueOnce(5).mockReturnValueOnce(4);
    await expect(measureAsyncOperation(async () => 'result', now)).rejects.toThrow('ELAPSED_CLOCK_INVALID');
  });
});
