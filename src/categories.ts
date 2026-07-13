// Fixed dictionary (spec section 7). Enum in tool schemas so the LLM cannot drift.
export const EXPENSE_CATEGORIES = [
  "groceries",
  "restaurants",
  "transport",
  "fuel",
  "housing",
  "utilities",
  "health",
  "pharmacy",
  "clothing",
  "electronics",
  "entertainment",
  "subscriptions",
  "education",
  "travel",
  "gifts",
  "family",
  "personal_care",
  "business",
  "fees",
  "other",
] as const;

export const INCOME_CATEGORIES = [
  "salary",
  "business",
  "freelance",
  "investments",
  "gifts",
  "refunds",
  "other",
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export type IncomeCategory = (typeof INCOME_CATEGORIES)[number];
