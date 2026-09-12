/**
 * Carlton CRM — Lead statuses (single source of truth)
 * ─────────────────────────────────────────────────────────────────────────────
 * Every status list in the backend derives from here: the Mongoose enum, the
 * LeadStatus type, and the Zod schemas. Add a status once, in this file.
 */

/** Statuses any user may set. */
export const GENERAL_LEAD_STATUSES = [
  "new", "assigned", "followup", "closed", "invalid", "cnc", "booking",
  "notinterested", "interested", "rnr", "callback", "whatsapp", "student",
] as const;

/**
 * Statuses only the Closing team may SET. Everyone can still see and filter by
 * them — the restriction is on writing, not reading.
 */
export const CLOSING_ONLY_STATUSES = [
  "nextbatch", "reschedule", "paid100", "paid200", "paid500",
] as const;

export const LEAD_STATUSES = [
  ...GENERAL_LEAD_STATUSES,
  ...CLOSING_ONLY_STATUSES,
] as const;

export type LeadStatus = typeof LEAD_STATUSES[number];

/** Mutable copy — Mongoose `enum` and Zod `z.enum` both want a plain array. */
export const LEAD_STATUS_VALUES: string[] = [...LEAD_STATUSES];

const CLOSING_ONLY_SET = new Set<string>(CLOSING_ONLY_STATUSES);

/** True when only Closing-team members may set this status. */
export function isClosingOnlyStatus(status: string): boolean {
  return CLOSING_ONLY_SET.has(status);
}
