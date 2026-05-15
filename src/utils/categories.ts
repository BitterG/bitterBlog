export const CATEGORY_MAP: Record<string, string> = {
  dbhknw: 'Android 内核',
  kb: 'Go',
  koo1se: 'eBPF',
  nohhgp: 'Windows',
};

export function getCategoryName(categoryId: string): string {
  return CATEGORY_MAP[categoryId] ?? categoryId;
}
