/**
 * Inventory and finance rules shared by the desktop process and the UI.
 *
 * Money is never converted between currencies. Summaries are grouped by the
 * currency recorded on each row so a total can never silently mix units.
 */

export const CURRENCIES = [
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
  'NZD',
  'JPY',
  'CNY',
  'INR',
  'CHF',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
  'CZK',
  'ZAR',
  'BRL',
  'MXN',
  'SGD',
  'HKD',
  'ILS',
  'AED',
  'TRY',
  'KRW',
] as const;

export const INVENTORY_CATEGORIES = [
  'Propulsion',
  'Structure',
  'Electronics',
  'Sensors',
  'Power',
  'Fasteners',
  'Consumables',
  'Tools',
  'Safety',
  'Other',
];

export const FINANCE_KINDS = [
  { value: 'income', label: 'Income' },
  { value: 'expenditure', label: 'Expenditure' },
];

export const FINANCE_CATEGORIES = [
  'Components',
  'Materials',
  'Propellant',
  'Tools and equipment',
  'Testing fees',
  'Travel',
  'Software',
  'Services',
  'Grant',
  'Sponsorship',
  'Donation',
  'Sales',
  'Other',
];

export const PAYMENT_METHODS = ['Card', 'Bank transfer', 'Cash', 'PayPal', 'Other'];

export interface InventoryCurrencySummary {
  currency: string;
  itemCount: number;
  lowStockCount: number;
  totalValue: number;
}

export interface FinanceCurrencySummary {
  currency: string;
  income: number;
  expenditure: number;
  net: number;
  count: number;
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function numericValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function normalizeCurrency(value: unknown): string {
  return String(value ?? 'USD').trim().toUpperCase();
}

export function inventoryValue(item: { quantity?: unknown; unit_cost?: unknown }): number {
  const quantity = numericValue(item.quantity) ?? 0;
  const unitCost = numericValue(item.unit_cost) ?? 0;
  return roundMoney(Math.max(0, quantity) * Math.max(0, unitCost));
}

export function isLowStock(item: { quantity?: unknown; reorder_level?: unknown }): boolean {
  const quantity = numericValue(item.quantity) ?? 0;
  const reorder = numericValue(item.reorder_level) ?? 0;
  return reorder > 0 && quantity <= reorder;
}

export function summarizeInventory(items: { quantity?: unknown; unit_cost?: unknown; reorder_level?: unknown; currency?: unknown }[]): InventoryCurrencySummary[] {
  const groups = new Map<string, InventoryCurrencySummary>();
  for (const item of items) {
    const currency = normalizeCurrency(item.currency);
    const group = groups.get(currency) ?? { currency, itemCount: 0, lowStockCount: 0, totalValue: 0 };
    group.itemCount += 1;
    if (isLowStock(item)) group.lowStockCount += 1;
    group.totalValue = roundMoney(group.totalValue + inventoryValue(item));
    groups.set(currency, group);
  }
  return [...groups.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export function summarizeFinance(entries: { kind?: unknown; amount?: unknown; currency?: unknown }[]): FinanceCurrencySummary[] {
  const groups = new Map<string, FinanceCurrencySummary>();
  for (const entry of entries) {
    const currency = normalizeCurrency(entry.currency);
    const group = groups.get(currency) ?? { currency, income: 0, expenditure: 0, net: 0, count: 0 };
    const amount = Math.max(0, numericValue(entry.amount) ?? 0);
    if (String(entry.kind) === 'income') group.income = roundMoney(group.income + amount);
    else group.expenditure = roundMoney(group.expenditure + amount);
    group.count += 1;
    group.net = roundMoney(group.income - group.expenditure);
    groups.set(currency, group);
  }
  return [...groups.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export function validateInventoryItem(item: Record<string, any>): string[] {
  const errors: string[] = [];
  if (!String(item.name ?? '').trim()) errors.push('Item name is required');
  const quantity = numericValue(item.quantity);
  const unitCost = numericValue(item.unit_cost);
  const reorder = numericValue(item.reorder_level ?? 0);
  if (quantity === null || quantity < 0) errors.push('Quantity must be zero or greater');
  if (unitCost === null || unitCost < 0) errors.push('Unit cost must be zero or greater');
  if (reorder === null || reorder < 0) errors.push('Reorder level must be zero or greater');
  if (!/^[A-Z]{3}$/.test(normalizeCurrency(item.currency))) errors.push('Currency must be a three-letter code such as USD');
  return errors;
}

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function validateFinanceEntry(entry: Record<string, any>): string[] {
  const errors: string[] = [];
  const kind = String(entry.kind ?? '');
  if (!['income', 'expenditure'].includes(kind)) errors.push('Type must be income or expenditure');
  if (!String(entry.description ?? '').trim()) errors.push('Description is required');
  const amount = numericValue(entry.amount);
  if (amount === null || amount <= 0) errors.push('Amount must be greater than zero');
  const date = String(entry.occurred_on ?? '').slice(0, 10);
  if (!isValidDate(date)) errors.push('Date must be a valid YYYY-MM-DD date');
  if (!/^[A-Z]{3}$/.test(normalizeCurrency(entry.currency))) errors.push('Currency must be a three-letter code such as USD');
  return errors;
}
