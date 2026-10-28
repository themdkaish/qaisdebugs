import { describe, expect, it } from 'vitest';
import { describeValue } from './debugger';

describe('describeValue', () => {
  it('names functions instead of printing their source', () => {
    expect(describeValue({ type: 'function', description: 'async function runScenario(scenario) {\n  setOutput(...);\n}' })).toBe('ƒ runScenario()');
    expect(describeValue({ type: 'function', description: '(a) => a + 1' })).toBe('ƒ anonymous()');
  });

  it('describes other values the way the inspector does', () => {
    expect(describeValue({ type: 'number', value: 2 })).toBe('2');
    expect(describeValue({ type: 'string', value: 'Kia' })).toBe('"Kia"');
  });
});
