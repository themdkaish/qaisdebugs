import { describe, expect, it } from 'vitest';
import { fuzzyMatch, parseQuickOpen, rankFiles } from './fuzzy';

describe('fuzzyMatch', () => {
  it('needs every character, in order', () => {
    expect(fuzzyMatch('pgts', 'app/page.ts')).toBeDefined();
    expect(fuzzyMatch('xyz', 'app/page.ts')).toBeUndefined();
    expect(fuzzyMatch('stp', 'app/page.ts')).toBeUndefined();
  });

  it('ignores case and spaces', () => {
    expect(fuzzyMatch('Borrow Vehicle', 'src/borrowVehicle.service.ts')).toBeDefined();
  });

  it('reports where the characters matched', () => {
    expect(fuzzyMatch('pg', 'app/pg.ts')?.positions).toEqual([4, 5]);
  });
});

describe('rankFiles', () => {
  const files = [
    'libs/common/src/api/fleetApi/fleetApi.types.ts',
    'apps/rental-portal/src/services/borrowVehicle.service.ts',
    'apps/rental-portal/src/views/Fleet/BorrowVehicleDrawer.tsx',
    'apps/gov-portal/src/views/Borrowing/overview.tsx',
  ];

  it('puts a file whose name contains the query first', () => {
    expect(rankFiles(files, 'borrowvehicle.service')[0].path).toBe('apps/rental-portal/src/services/borrowVehicle.service.ts');
  });

  it('prefers matches in the file name over matches in folders', () => {
    expect(rankFiles(files, 'borrow')[0].path).not.toBe('apps/gov-portal/src/views/Borrowing/overview.tsx');
  });

  it('keeps everything, in order, for an empty query', () => {
    expect(rankFiles(files, '').map((file) => file.path)).toEqual(files);
  });

  it('stops at the limit', () => {
    expect(rankFiles(files, 'ts', 2)).toHaveLength(2);
  });
});

describe('parseQuickOpen', () => {
  it('splits off a line number', () => {
    expect(parseQuickOpen('page.tsx:42')).toEqual({ query: 'page.tsx', line: 42 });
    expect(parseQuickOpen('page.tsx:42:7')).toEqual({ query: 'page.tsx', line: 42 });
  });

  it('treats :42 alone as a line in the open file', () => {
    expect(parseQuickOpen(':42')).toEqual({ query: '', line: 42 });
  });

  it('leaves plain text alone', () => {
    expect(parseQuickOpen(' route.ts ')).toEqual({ query: 'route.ts' });
  });
});
