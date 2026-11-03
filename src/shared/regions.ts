/**
 * States, provinces, emirates and regions for the address of a company or contact, per country. Codes follow
 * ISO 3166-2 (India uses its GST state codes, which decide CGST + SGST or IGST). Only India uses the region for tax;
 * elsewhere it is part of the address. A country with no list here simply has no region field.
 */
import { INDIA_STATES } from "./tax";

type Regions = Record<string, string>;

const REGIONS: Record<string, { label: string; list: Regions }> = {
  IN: { label: "State", list: Object.fromEntries(Object.entries(INDIA_STATES).filter(([k]) => Number(k) < 90)) },
  AE: { label: "Emirate", list: { AZ: "Abu Dhabi", DU: "Dubai", SH: "Sharjah", AJ: "Ajman", UQ: "Umm Al Quwain", RK: "Ras Al Khaimah", FU: "Fujairah" } },
  SA: { label: "Region", list: { "01": "Riyadh", "02": "Makkah", "03": "Madinah", "04": "Eastern Province", "05": "Al-Qassim", "06": "Ha'il", "07": "Tabuk", "08": "Northern Borders", "09": "Jazan", "10": "Najran", "11": "Al-Bahah", "12": "Al-Jawf", "14": "Asir" } },
  BH: { label: "Governorate", list: { "13": "Capital", "14": "Southern", "15": "Muharraq", "17": "Northern" } },
  QA: { label: "Municipality", list: { DA: "Doha", RA: "Al Rayyan", WA: "Al Wakrah", KH: "Al Khor", MS: "Al Shamal", ZA: "Al Daayen", US: "Umm Salal", SH: "Al Shahaniya" } },
  KW: { label: "Governorate", list: { KU: "Capital (Al Asimah)", HA: "Hawalli", FA: "Farwaniya", AH: "Al Ahmadi", JA: "Al Jahra", MU: "Mubarak Al-Kabeer" } },
  OM: { label: "Governorate", list: { MA: "Muscat", ZU: "Dhofar", MU: "Musandam", BU: "Al Buraimi", DA: "Ad Dakhiliyah", BS: "North Al Batinah", BJ: "South Al Batinah", SS: "North Ash Sharqiyah", SJ: "South Ash Sharqiyah", ZA: "Ad Dhahirah", WU: "Al Wusta" } },
  PK: { label: "Province", list: { PB: "Punjab", SD: "Sindh", KP: "Khyber Pakhtunkhwa", BA: "Balochistan", IS: "Islamabad Capital Territory", GB: "Gilgit-Baltistan", JK: "Azad Jammu and Kashmir" } },
  GB: { label: "Nation", list: { ENG: "England", SCT: "Scotland", WLS: "Wales", NIR: "Northern Ireland" } },
  CA: { label: "Province", list: { AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick", NL: "Newfoundland and Labrador", NS: "Nova Scotia", NT: "Northwest Territories", NU: "Nunavut", ON: "Ontario", PE: "Prince Edward Island", QC: "Quebec", SK: "Saskatchewan", YT: "Yukon" } },
  AU: { label: "State", list: { ACT: "Australian Capital Territory", NSW: "New South Wales", NT: "Northern Territory", QLD: "Queensland", SA: "South Australia", TAS: "Tasmania", VIC: "Victoria", WA: "Western Australia" } },
  MY: { label: "State", list: { "01": "Johor", "02": "Kedah", "03": "Kelantan", "04": "Melaka", "05": "Negeri Sembilan", "06": "Pahang", "07": "Pulau Pinang", "08": "Perak", "09": "Perlis", "10": "Selangor", "11": "Terengganu", "12": "Sabah", "13": "Sarawak", "14": "Kuala Lumpur", "15": "Labuan", "16": "Putrajaya" } },
  US: { label: "State", list: {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida",
    GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
    MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
    NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
    SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  } },
};

/** The region list for a country, or null when the country has none. */
export function regionsFor(country: string | null | undefined): Regions | null {
  return (country && REGIONS[country]?.list) || null;
}

/** "State", "Emirate", "Region", "Province"… */
export function regionLabel(country: string | null | undefined): string {
  return (country && REGIONS[country]?.label) || "State / region";
}

/** Name of a region code, e.g. regionName("AE", "DU") = "Dubai". India also knows the special GST codes (97, 96). */
export function regionName(country: string | null | undefined, code: string | null | undefined): string {
  if (!code) return "";
  if (country === "IN") return INDIA_STATES[code] ?? code;
  return regionsFor(country)?.[code] ?? code;
}

/** A message when the code is not a region of that country (for server validation). */
export function regionProblem(country: string | null | undefined, code: string | null | undefined): string | null {
  if (!code) return null;
  if (country === "IN") return INDIA_STATES[code] ? null : "Unknown Indian state code";
  const list = regionsFor(country);
  if (!list) return null;
  return list[code] ? null : `Unknown ${regionLabel(country).toLowerCase()} for this country`;
}
