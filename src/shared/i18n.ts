/**
 * Hindi and Tamil wording for printed bills and the most-used screens (navigation, POS).
 * English stays the source; anything not listed here shows in English. Bills print both languages ("Qty / मात्रा").
 * The translations use common Indian billing terms; have a native speaker review them for your customers.
 */
export type Lang = "en" | "hi" | "ta";
export const LANGS: { value: Lang; label: string }[] = [
  { value: "en", label: "English" },
  { value: "hi", label: "हिन्दी (Hindi)" },
  { value: "ta", label: "தமிழ் (Tamil)" },
];

type Dict = Record<string, { hi: string; ta: string }>;

/** Labels on printed invoices, receipts and thermal bills. */
export const PRINT_WORDS: Dict = {
  "Tax Invoice": { hi: "कर बीजक", ta: "வரி விலைப்பட்டியல்" },
  "Bill of Supply": { hi: "आपूर्ति का बिल", ta: "வழங்கல் பில்" },
  "Invoice": { hi: "बीजक", ta: "விலைப்பட்டியல்" },
  "Credit note": { hi: "क्रेडिट नोट", ta: "கிரெடிட் நோட்" },
  "Quotation": { hi: "कोटेशन", ta: "விலைப்புள்ளி" },
  "Proforma invoice": { hi: "प्रोफार्मा बीजक", ta: "முன்மாதிரி விலைப்பட்டியல்" },
  "Delivery challan": { hi: "डिलीवरी चालान", ta: "டெலிவரி சலான்" },
  "Number": { hi: "क्रमांक", ta: "எண்" },
  "Date": { hi: "दिनांक", ta: "தேதி" },
  "Due date": { hi: "देय तिथि", ta: "செலுத்த வேண்டிய தேதி" },
  "Reference": { hi: "संदर्भ", ta: "குறிப்பு" },
  "Bill to": { hi: "बिल प्राप्तकर्ता", ta: "பில் பெறுநர்" },
  "Supplier": { hi: "आपूर्तिकर्ता", ta: "சப்ளையர்" },
  "Ship to": { hi: "माल भेजने का पता", ta: "அனுப்பும் முகவரி" },
  "Place of supply": { hi: "आपूर्ति का स्थान", ta: "வழங்கல் இடம்" },
  "Description": { hi: "विवरण", ta: "விவரம்" },
  "Qty": { hi: "मात्रा", ta: "அளவு" },
  "Rate": { hi: "दर", ta: "விலை" },
  "Disc.": { hi: "छूट", ta: "தள்ளுபடி" },
  "Taxable": { hi: "कर योग्य", ta: "வரிக்குட்பட்டது" },
  "Taxable value": { hi: "कर योग्य मूल्य", ta: "வரிக்குட்பட்ட மதிப்பு" },
  "Tax": { hi: "कर", ta: "வரி" },
  "Amount": { hi: "राशि", ta: "தொகை" },
  "Round off": { hi: "पूर्णांकन", ta: "முழுமையாக்கல்" },
  "Total": { hi: "कुल", ta: "மொத்தம்" },
  "Paid": { hi: "भुगतान किया", ta: "செலுத்தப்பட்டது" },
  "Balance due": { hi: "शेष देय", ta: "நிலுவைத் தொகை" },
  "Amount in words": { hi: "राशि शब्दों में", ta: "தொகை எழுத்தில்" },
  "Authorised signatory for": { hi: "अधिकृत हस्ताक्षरकर्ता", ta: "அங்கீகரிக்கப்பட்ட கையொப்பம்" },
  "Thank you! Visit again.": { hi: "धन्यवाद! फिर पधारें।", ta: "நன்றி! மீண்டும் வருக." },
  "Scan to pay (UPI)": { hi: "UPI से भुगतान हेतु स्कैन करें", ta: "UPI மூலம் செலுத்த ஸ்கேன் செய்யவும்" },
  "Scan to verify": { hi: "जाँच हेतु स्कैन करें", ta: "சரிபார்க்க ஸ்கேன் செய்யவும்" },
};

/** Navigation and POS wording for the app (per user). */
export const UI_WORDS: Dict = {
  // Sidebar
  "Dashboard": { hi: "डैशबोर्ड", ta: "டாஷ்போர்டு" },
  "Daybook": { hi: "रोज़नामचा", ta: "நாள் புத்தகம்" },
  "Sales & billing": { hi: "बिक्री और बिलिंग", ta: "விற்பனை & பில்லிங்" },
  "POS / counter billing": { hi: "काउंटर बिलिंग (POS)", ta: "கவுண்டர் பில்லிங் (POS)" },
  "Customers": { hi: "ग्राहक", ta: "வாடிக்கையாளர்கள்" },
  "Quotations": { hi: "कोटेशन", ta: "விலைப்புள்ளிகள்" },
  "Proforma invoices": { hi: "प्रोफार्मा बीजक", ta: "முன்மாதிரி விலைப்பட்டியல்கள்" },
  "Sales orders": { hi: "बिक्री आदेश", ta: "விற்பனை ஆணைகள்" },
  "Delivery challans": { hi: "डिलीवरी चालान", ta: "டெலிவரி சலான்கள்" },
  "Invoices / bills": { hi: "बीजक / बिल", ta: "விலைப்பட்டியல்கள் / பில்கள்" },
  "Recurring invoices": { hi: "आवर्ती बीजक", ta: "தொடர் விலைப்பட்டியல்கள்" },
  "Sales returns": { hi: "बिक्री वापसी", ta: "விற்பனை திருப்பம்" },
  "Receipts": { hi: "प्राप्तियाँ", ta: "வரவுகள்" },
  "Purchases": { hi: "खरीद", ta: "கொள்முதல்" },
  "Suppliers": { hi: "आपूर्तिकर्ता", ta: "சப்ளையர்கள்" },
  "Purchase orders": { hi: "खरीद आदेश", ta: "கொள்முதல் ஆணைகள்" },
  "Supplier bills": { hi: "आपूर्तिकर्ता बिल", ta: "சப்ளையர் பில்கள்" },
  "Purchase returns": { hi: "खरीद वापसी", ta: "கொள்முதல் திருப்பம்" },
  "Supplier payments": { hi: "आपूर्तिकर्ता भुगतान", ta: "சப்ளையர் கொடுப்பனவுகள்" },
  "Inventory": { hi: "माल-सूची", ta: "சரக்கு" },
  "Products & stock": { hi: "उत्पाद और स्टॉक", ta: "பொருட்கள் & இருப்பு" },
  "Stock transfers": { hi: "स्टॉक स्थानांतरण", ta: "இருப்பு மாற்றம்" },
  "Product labels / QR": { hi: "उत्पाद लेबल / QR", ta: "பொருள் லேபிள்கள் / QR" },
  "Manufacturing": { hi: "उत्पादन", ta: "உற்பத்தி" },
  "Accounting": { hi: "लेखांकन", ta: "கணக்கியல்" },
  "Reports": { hi: "रिपोर्ट", ta: "அறிக்கைகள்" },
  "Settings": { hi: "सेटिंग्स", ta: "அமைப்புகள்" },
  "Users": { hi: "उपयोगकर्ता", ta: "பயனர்கள்" },
  "Payroll": { hi: "वेतन", ta: "சம்பளம்" },
  "Expenses": { hi: "व्यय", ta: "செலவுகள்" },
  "Banking": { hi: "बैंकिंग", ta: "வங்கி" },
  "GST returns": { hi: "GST रिटर्न", ta: "GST ரிட்டர்ன்" },
  "Journals & ledgers": { hi: "जर्नल और खाता बही", ta: "ஜர்னல் & லெட்ஜர்" },
  "Chart of accounts": { hi: "खातों की सूची", ta: "கணக்குப் பட்டியல்" },
  "Fixed assets": { hi: "स्थायी संपत्ति", ta: "நிலைச் சொத்துகள்" },
  "People": { hi: "कर्मचारी", ta: "பணியாளர்கள்" },
  "Payroll & timesheets": { hi: "वेतन और समय-पत्रक", ta: "சம்பளம் & நேரத்தாள்" },
  "Reports & control": { hi: "रिपोर्ट और नियंत्रण", ta: "அறிக்கைகள் & கட்டுப்பாடு" },
  "Cash / bank book": { hi: "रोकड़ / बैंक बही", ta: "ரொக்கம் / வங்கி புத்தகம்" },
  "Daily report": { hi: "दैनिक रिपोर्ट", ta: "தினசரி அறிக்கை" },
  "Profit & loss": { hi: "लाभ और हानि", ta: "லாபம் & நஷ்டம்" },
  "Balance sheet": { hi: "तुलन पत्र", ta: "இருப்புநிலைக் குறிப்பு" },
  "All reports": { hi: "सभी रिपोर्ट", ta: "அனைத்து அறிக்கைகள்" },
  "Insights": { hi: "विश्लेषण", ta: "பகுப்பாய்வு" },
  "Audit log": { hi: "ऑडिट लॉग", ta: "தணிக்கைப் பதிவு" },
  "Administration": { hi: "प्रशासन", ta: "நிர்வாகம்" },
  "Users & permissions": { hi: "उपयोगकर्ता और अनुमतियाँ", ta: "பயனர்கள் & அனுமதிகள்" },
  "Branches": { hi: "शाखाएँ", ta: "கிளைகள்" },
  "Import from Excel": { hi: "Excel से आयात", ta: "Excel-இலிருந்து இறக்குமதி" },
  "Language": { hi: "भाषा", ta: "மொழி" },
  // POS
  "Search products": { hi: "उत्पाद खोजें", ta: "பொருட்களைத் தேடுங்கள்" },
  "Walk-in customer": { hi: "सामान्य ग्राहक", ta: "நேரடி வாடிக்கையாளர்" },
  "Scan or tap products": { hi: "उत्पाद स्कैन करें या चुनें", ta: "பொருட்களை ஸ்கேன் செய்யவும் அல்லது தொடவும்" },
  "Hold": { hi: "रोकें", ta: "நிறுத்து" },
  "Clear": { hi: "साफ़ करें", ta: "அழி" },
  "Cash": { hi: "नकद", ta: "ரொக்கம்" },
  "Card": { hi: "कार्ड", ta: "அட்டை" },
  "Split": { hi: "विभाजित", ta: "பிரித்து" },
  "Cash given": { hi: "दी गई नकदी", ta: "கொடுத்த ரொக்கம்" },
  "Change": { hi: "बाकी लौटाएँ", ta: "மீதி" },
  "Total": { hi: "कुल", ta: "மொத்தம்" },
  "Pay & print": { hi: "भुगतान और प्रिंट", ta: "செலுத்தி அச்சிடு" },
  "each": { hi: "प्रति", ta: "ஒன்றுக்கு" },
};

/** "Qty" → "Qty / मात्रा" when the bill language is Hindi or Tamil. */
export function bilingual(en: string, lang: Lang | null | undefined): string {
  if (!lang || lang === "en") return en;
  const t = PRINT_WORDS[en]?.[lang];
  return t ? `${en} / ${t}` : en;
}

/** UI wording in the user's language (English when no translation exists). */
export function translate(en: string, lang: Lang | null | undefined): string {
  if (!lang || lang === "en") return en;
  return UI_WORDS[en]?.[lang] ?? en;
}
