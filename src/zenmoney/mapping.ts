import type { ZenTag } from "./client";

/**
 * ZenMoney -> MyFinance static mapping. Server does dumb lookups only; the
 * LLM client is the rules engine for anything the dictionary misses (unmapped
 * tags come back in the sync report with counts).
 */

// loan/debt excluded: liability modelling is out of Z1 scope; those accounts
// are reported as skipped so the client can tell the user.
export const ZEN_ACCOUNT_TYPE: Record<string, string> = {
  cash: "cash",
  ccard: "card",
  checking: "bank",
  emoney: "card",
  deposit: "bank",
};

// Stock ZenMoney tag titles (RU/UK/EN), normalized: lowercase, no punctuation.
// Child tag is matched before parent; first match wins.
const TAG_DICT: Record<string, string> = {
  // groceries
  "продукты": "groceries", "продукти": "groceries", "groceries": "groceries", "супермаркет": "groceries",
  // restaurants
  "кафеирестораны": "restaurants", "кафе": "restaurants", "рестораны": "restaurants", "ресторани": "restaurants",
  "бары": "restaurants", "фастфуд": "restaurants", "eatingout": "restaurants", "restaurants": "restaurants", "кофе": "restaurants",
  // transport
  "транспорт": "transport", "общественныйтранспорт": "transport", "такси": "transport", "таксі": "transport",
  "каршеринг": "transport", "transport": "transport", "публічнийтранспорт": "transport", "парковка": "transport",
  // fuel
  "бензин": "fuel", "азс": "fuel", "заправка": "fuel", "пальне": "fuel", "fuel": "fuel", "автомобиль": "fuel", "авто": "fuel",
  // housing
  "жилье": "housing", "житло": "housing", "аренда": "housing", "оренда": "housing", "ипотека": "housing", "rent": "housing", "housing": "housing",
  // utilities
  "жкх": "utilities", "коммуналка": "utilities", "комуналка": "utilities", "коммунальныеуслуги": "utilities",
  "комунальніпослуги": "utilities", "utilities": "utilities", "интернет": "utilities", "інтернет": "utilities", "связь": "utilities", "звязок": "utilities",
  // health
  "здоровье": "health", "здоровя": "health", "медицина": "health", "врач": "health", "health": "health", "стоматология": "health",
  // pharmacy
  "аптека": "pharmacy", "лекарства": "pharmacy", "ліки": "pharmacy", "pharmacy": "pharmacy",
  // clothing
  "одежда": "clothing", "одяг": "clothing", "обувь": "clothing", "взуття": "clothing", "clothing": "clothing", "одеждаиобувь": "clothing",
  // electronics
  "техника": "electronics", "техніка": "electronics", "электроника": "electronics", "електроніка": "electronics", "electronics": "electronics",
  // entertainment
  "развлечения": "entertainment", "розваги": "entertainment", "кино": "entertainment", "кіно": "entertainment",
  "entertainment": "entertainment", "хобби": "entertainment", "хобі": "entertainment", "игры": "entertainment",
  // subscriptions
  "подписки": "subscriptions", "підписки": "subscriptions", "subscriptions": "subscriptions", "сервисы": "subscriptions",
  // education
  "образование": "education", "освіта": "education", "курсы": "education", "курси": "education", "education": "education", "книги": "education",
  // travel
  "путешествия": "travel", "подорожі": "travel", "отпуск": "travel", "відпустка": "travel", "travel": "travel", "отели": "travel", "авиабилеты": "travel",
  // gifts (expense side; income side resolved by kind)
  "подарки": "gifts", "подарунки": "gifts", "gifts": "gifts", "подарок": "gifts", "подарунок": "gifts",
  // family
  "семья": "family", "сімя": "family", "дети": "family", "діти": "family", "family": "family", "школа": "family",
  // personal_care
  "красота": "personal_care", "краса": "personal_care", "косметика": "personal_care", "парикмахерская": "personal_care",
  "перукарня": "personal_care", "спорт": "personal_care", "фитнес": "personal_care", "фітнес": "personal_care", "personalcare": "personal_care",
  // business
  "бизнес": "business", "бізнес": "business", "business": "business", "работа": "business",
  // fees
  "комиссии": "fees", "комісії": "fees", "комиссия": "fees", "банк": "fees", "налоги": "fees", "податки": "fees", "fees": "fees", "штрафы": "fees",
  // income
  "зарплата": "salary", "зп": "salary", "salary": "salary", "аванс": "salary",
  "фриланс": "freelance", "фріланс": "freelance", "freelance": "freelance", "подработка": "freelance",
  "проценты": "investments", "відсотки": "investments", "дивиденды": "investments", "дивіденди": "investments",
  "инвестиции": "investments", "інвестиції": "investments", "кэшбэк": "refunds", "кешбек": "refunds",
  "возврат": "refunds", "повернення": "refunds", "refunds": "refunds",
};

// MCC fallback for untagged rows (major ranges only; precision is the tag's job).
const MCC_MAP: Array<[test: (mcc: number) => boolean, category: string]> = [
  [(m) => m === 5411 || m === 5422 || m === 5451 || m === 5462 || m === 5499, "groceries"],
  [(m) => (m >= 5812 && m <= 5814) || m === 5811, "restaurants"],
  [(m) => m === 5541 || m === 5542 || m === 5983, "fuel"],
  [(m) => (m >= 4111 && m <= 4131) || m === 4121 || m === 4789 || m === 7523, "transport"],
  [(m) => m === 4511 || m === 4722 || (m >= 3000 && m <= 3999) || m === 7011, "travel"],
  [(m) => m === 5912 || m === 5122, "pharmacy"],
  [(m) => (m >= 8011 && m <= 8099), "health"],
  [(m) => (m >= 5611 && m <= 5699) || m === 5651, "clothing"],
  [(m) => m === 5732 || m === 5045 || m === 5734, "electronics"],
  [(m) => m === 7832 || m === 7922 || m === 7994 || m === 7996 || m === 7999, "entertainment"],
  [(m) => m === 8211 || m === 8220 || m === 8299 || m === 5942, "education"],
  [(m) => m === 7230 || m === 7298 || m === 7997, "personal_care"],
  [(m) => m === 4814 || m === 4899 || m === 4900, "utilities"],
  [(m) => m === 6012 || m === 6051, "fees"],
];

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export interface CategoryResult {
  category: string;
  unmappedTag?: string; // set when the dictionary missed; feeds the sync report
}

export function mapCategory(tags: ZenTag[], tagById: Map<string, ZenTag>, mcc?: number | null): CategoryResult {
  for (const tag of tags) {
    const own = TAG_DICT[normalize(tag.title)];
    if (own) return { category: own };
    const parent = tag.parent ? tagById.get(tag.parent) : undefined;
    if (parent) {
      const viaParent = TAG_DICT[normalize(parent.title)];
      if (viaParent) return { category: viaParent };
    }
  }
  if (mcc) {
    for (const [test, category] of MCC_MAP) if (test(mcc)) return { category };
  }
  return { category: "other", unmappedTag: tags[0]?.title };
}
