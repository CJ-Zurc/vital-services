import { z } from 'zod';
import { DomainError } from '../../contracts/actor.js';
import { dateOnly } from './appointment-contracts.js';
export const blockSelection = z.object({ mode: z.enum(['range', 'custom', 'weekly']),
  startDate: dateOnly.optional(), endDate: dateOnly.optional(), dates: z.array(dateOnly).max(2000).refine(dates => new Set(dates).size <= 100).optional(),
  weekday: z.number().int().min(0).max(6).optional() }).strict();
export function selectedBlockDates(raw: unknown, now = Date.now()) {
  const input = blockSelection.parse(raw), today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  let dates: string[];
  if (input.mode === 'custom') {
    if (input.startDate || input.endDate || input.weekday !== undefined) throw new DomainError(400, 'DATE_BLOCK_INVALID', 'Use individual dates for Custom selection.');
    dates = [...new Set(input.dates ?? [])].sort();
  } else {
    if (!input.startDate || !input.endDate || input.dates || input.endDate < input.startDate || input.mode === 'range' && input.weekday !== undefined || input.mode === 'weekly' && input.weekday === undefined)
      throw new DomainError(400, 'DATE_BLOCK_INVALID', 'Select a valid date range.');
    const days = (Date.parse(input.endDate) - Date.parse(input.startDate)) / 86400000 + 1;
    if (days > 366) throw new DomainError(400, 'DATE_BLOCK_LIMIT', 'Select at most 366 calendar days.');
    dates = Array.from({ length: days }, (_, index) => new Date(Date.parse(input.startDate!) + index * 86400000))
      .filter(day => input.mode !== 'weekly' || day.getUTCDay() === input.weekday).map(day => day.toISOString().slice(0, 10));
  }
  if (!dates.length || dates[0]! < today) throw new DomainError(400, 'DATE_BLOCK_INVALID', 'Select dates on or after today.');
  return dates;
}
