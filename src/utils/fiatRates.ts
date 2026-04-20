export interface FiatCurrency {
  code: string;
  name: string;
  flag: string;
}

export const SUPPORTED_FIAT_CURRENCIES: FiatCurrency[] = [
  { code: "USD", name: "US Dollar", flag: "🇺🇸" },
  { code: "JPY", name: "Japanese Yen", flag: "🇯🇵" },
  { code: "CNY", name: "Chinese Yuan", flag: "🇨🇳" },
  { code: "SGD", name: "Singapore Dollar", flag: "🇸🇬" },
  { code: "HKD", name: "Hong Kong Dollar", flag: "🇭🇰" },
  { code: "CAD", name: "Canadian Dollar", flag: "🇨🇦" },
  { code: "NZD", name: "New Zealand Dollar", flag: "🇳🇿" },
  { code: "AUD", name: "Australian Dollar", flag: "🇦🇺" },
  { code: "CLP", name: "Chilean Peso", flag: "🇨🇱" },
  { code: "GBP", name: "Great British Pound", flag: "🇬🇧" },
  { code: "DKK", name: "Danish Krone", flag: "🇩🇰" },
  { code: "SEK", name: "Swedish Krona", flag: "🇸🇪" },
  { code: "ISK", name: "Icelandic Krona", flag: "🇮🇸" },
  { code: "CHF", name: "Swiss Franc", flag: "🇨🇭" },
  { code: "BRL", name: "Brazilian Real", flag: "🇧🇷" },
  { code: "EUR", name: "Eurozone Euro", flag: "🇪🇺" },
  { code: "RUB", name: "Russian Ruble", flag: "🇷🇺" },
  { code: "PLN", name: "Polish Złoty", flag: "🇵🇱" },
  { code: "THB", name: "Thai Baht", flag: "🇹🇭" },
  { code: "KRW", name: "South Korean Won", flag: "🇰🇷" },
  { code: "TWD", name: "New Taiwan Dollar", flag: "🇹🇼" },
  { code: "CZK", name: "Czech Koruna", flag: "🇨🇿" },
  { code: "HUF", name: "Hungarian Forint", flag: "🇭🇺" },
  { code: "INR", name: "Indian Rupee", flag: "🇮🇳" },
  { code: "TRY", name: "Turkish Lira", flag: "🇹🇷" },
  { code: "NGN", name: "Nigerian Naira", flag: "🇳🇬" },
  { code: "ARS", name: "Argentine Peso", flag: "🇦🇷" },
  { code: "ILS", name: "Israeli New Shekel", flag: "🇮🇱" },
  { code: "LBP", name: "Lebanese Pound", flag: "🇱🇧" },
  { code: "MYR", name: "Malaysian Ringgit", flag: "🇲🇾" },
  { code: "UAH", name: "Ukrainian Hryvnia", flag: "🇺🇦" },
  { code: "JMD", name: "Jamaican Dollar", flag: "🇯🇲" },
  { code: "COP", name: "Colombian Peso", flag: "🇨🇴" },
  { code: "MXN", name: "Mexican Peso", flag: "🇲🇽" },
  { code: "VES", name: "Venezuelan Bolivar", flag: "🇻🇪" },
  { code: "TZS", name: "Tanzanian Shilling", flag: "🇹🇿" },
  { code: "QAR", name: "Qatari Riyal", flag: "🇶🇦" },
  { code: "TND", name: "Tunisian Dinar", flag: "🇹🇳" },
  { code: "NOK", name: "Norwegian Krone", flag: "🇳🇴" },
  { code: "AED", name: "United Arab Emirates Dirham", flag: "🇦🇪" },
  { code: "TTD", name: "Trinidad & Tobago Dollar", flag: "🇹🇹" },
  { code: "PHP", name: "Philippine Peso", flag: "🇵🇭" },
  { code: "IDR", name: "Indonesian Rupiah", flag: "🇮🇩" },
  { code: "RON", name: "Romanian Leu", flag: "🇷🇴" },
  { code: "CDF", name: "Congolese Franc", flag: "🇨🇩" },
  { code: "XAF", name: "Central African CFA franc", flag: "🇨🇲" },
  { code: "XOF", name: "West African CFA franc", flag: "🇸🇳" },
  { code: "KES", name: "Kenyan Shilling", flag: "🇰🇪" },
  { code: "UGX", name: "Ugandan Shilling", flag: "🇺🇬" },
  { code: "ZAR", name: "South African Rand", flag: "🇿🇦" },
  { code: "CUP", name: "Cuban Peso", flag: "🇨🇺" },
  { code: "DOP", name: "Dominican Peso", flag: "🇩🇴" },
  { code: "BZD", name: "Belize Dollar", flag: "🇧🇿" },
  { code: "BOB", name: "Bolivian Boliviano", flag: "🇧🇴" },
  { code: "CRC", name: "Costa Rican Colón", flag: "🇨🇷" },
  { code: "GTQ", name: "Guatemalan Quetzal", flag: "🇬🇹" },
  { code: "NIO", name: "Nicaraguan Córdoba", flag: "🇳🇮" },
  { code: "PYG", name: "Paraguayan Guaraní", flag: "🇵🇾" },
  { code: "UYU", name: "Uruguayan Peso", flag: "🇺🇾" },
  { code: "MRU", name: "Mauritanian Ouguiya", flag: "🇲🇷" },
  { code: "ALL", name: "Albanian Lek", flag: "🇦🇱" },
  { code: "ANG", name: "Netherlands Antillean Guilder", flag: "🇳🇱" },
  { code: "AOA", name: "Angolan Kwanza", flag: "🇦🇴" },
  { code: "BDT", name: "Bangladeshi Takka", flag: "🇧🇩" },
  { code: "BGN", name: "Bulgarian Lev", flag: "🇧🇬" },
  { code: "BHD", name: "Bahraini Dinar", flag: "🇧🇭" },
  { code: "BIF", name: "Burundian Franc", flag: "🇧🇮" },
  { code: "BMD", name: "Bermudan Dollar", flag: "🇧🇲" },
  { code: "BWP", name: "Botswanan Pula", flag: "🇧🇼" },
  { code: "DJF", name: "Djiboutian Franc", flag: "🇩🇯" },
  { code: "DZD", name: "Algerian Dinar", flag: "🇩🇿" },
  { code: "EGP", name: "Egyptian Pound", flag: "🇪🇬" },
  { code: "ETB", name: "Ethiopian Birr", flag: "🇪🇹" },
  { code: "GEL", name: "Georgian Lari", flag: "🇬🇪" },
  { code: "GHS", name: "Ghanaian Cedi", flag: "🇬🇭" },
  { code: "GNF", name: "Guinean Franc", flag: "🇬🇳" },
  { code: "HNL", name: "Honduran Lempira", flag: "🇭🇳" },
  { code: "IRR", name: "Iranian Rial", flag: "🇮🇷" },
  { code: "JOD", name: "Jordanian Dinar", flag: "🇯🇴" },
  { code: "KGS", name: "Kyrgystani Som", flag: "🇰🇬" },
  { code: "KZT", name: "Kazakhstani Tenge", flag: "🇰🇿" },
  { code: "LKR", name: "Sri Lankan Rupee", flag: "🇱🇰" },
  { code: "MAD", name: "Moroccan Dirham", flag: "🇲🇦" },
  { code: "MGA", name: "Malagasy Ariary", flag: "🇲🇬" },
  { code: "NAD", name: "Namibian Dollar", flag: "🇳🇦" },
  { code: "NPR", name: "Nepalese Rupee", flag: "🇳🇵" },
  { code: "PAB", name: "Panamanian Balboa", flag: "🇵🇦" },
  { code: "PEN", name: "Peruvian Sol", flag: "🇵🇪" },
  { code: "PKR", name: "Pakistani Rupee", flag: "🇵🇰" },
  { code: "RSD", name: "Serbian Dinar", flag: "🇷🇸" },
  { code: "RWF", name: "Rwandan Franc", flag: "🇷🇼" },
  { code: "UZS", name: "Uzbekistani Sum", flag: "🇺🇿" },
  { code: "VND", name: "Vietnamese Dong", flag: "🇻🇳" },
  { code: "ZMW", name: "Zambian Kwacha", flag: "🇿🇲" },
  { code: "MWK", name: "Malawian Kwacha", flag: "🇲🇼" },
  { code: "LSL", name: "Lesotho Loti", flag: "🇱🇸" },
  { code: "SZL", name: "Swazi Lilangeni", flag: "🇸🇿" },
  { code: "SAR", name: "Saudi Riyal", flag: "🇸🇦" },
  { code: "OMR", name: "Omani Rial", flag: "🇴🇲" },
  { code: "XAU", name: "Gold", flag: "🥇" },
  { code: "XAG", name: "Silver", flag: "🥈" },
];

// Surfaced first in the currency picker — most Avark users are in this region.
export const AFRICAN_CURRENCY_CODES: ReadonlySet<string> = new Set([
  "AOA", "BIF", "BWP", "CDF", "DJF", "DZD", "EGP", "ETB", "GHS", "GNF",
  "KES", "LSL", "MAD", "MGA", "MRU", "MWK", "NAD", "NGN", "RWF", "SZL",
  "TND", "TZS", "UGX", "XAF", "XOF", "ZAR", "ZMW",
]);

export interface BtcRate {
  rate: number;
  timestamp: number;
}

const FETCH_TIMEOUT_MS = 8_000;

export async function fetchBtcRate(code: string): Promise<BtcRate | null> {
  try {
    const response = await fetch(`https://api.yadio.io/rate/${code}/BTC`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { rate?: unknown; timestamp?: unknown };
    if (
      typeof body.rate !== "number" ||
      !Number.isFinite(body.rate) ||
      body.rate <= 0 ||
      typeof body.timestamp !== "number"
    ) {
      return null;
    }
    return { rate: body.rate, timestamp: body.timestamp };
  } catch {
    return null;
  }
}

const SATS_PER_BTC = 100_000_000;

// Currencies that conventionally render with no decimals (matches Zeus's
// decimalPlaces: 0 entries).
const ZERO_DECIMAL_CODES = new Set([
  "JPY",
  "KRW",
  "CLP",
  "ISK",
  "BIF",
  "DJF",
  "GNF",
]);

// Three-decimal currencies (Zeus's decimalPlaces: 3 entries).
const THREE_DECIMAL_CODES = new Set(["BHD", "JOD"]);

function decimalsFor(code: string): number {
  if (ZERO_DECIMAL_CODES.has(code)) return 0;
  if (THREE_DECIMAL_CODES.has(code)) return 3;
  return 2;
}

export function formatFiat(sats: number, rate: number, code: string): string {
  const btc = sats / SATS_PER_BTC;
  const amount = btc * rate;
  const digits = decimalsFor(code);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    }).format(amount);
  } catch {
    return `${amount.toFixed(digits)} ${code}`;
  }
}
