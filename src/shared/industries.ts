/**
 * Business types: picking one at company creation adds accounts, units and starter items suited to that kind of
 * business, and tells the UI which modules to highlight. Everything added is ordinary data the user can edit.
 */
import type { SeedAccount } from "./coa";

export interface StarterItem {
  name: string;
  kind: "goods" | "service";
  unit: string;
  /** Sale price in major units, e.g. "120.00". */
  price: string;
  /** Preferred tax code name for India (falls back to the first standard rate). */
  gst?: string;
  hsn?: string;
  /** Code of the income account to use (an industry account below or a default one). */
  income?: string;
  track?: boolean;
}

export type Module = "inventory" | "payroll" | "timesheets" | "projects" | "pos" | "fees";

export interface BusinessType {
  key: string;
  label: string;
  description: string;
  accounts: SeedAccount[];
  units: [string, string][];
  items: StarterItem[];
  modules: Module[];
}

const inc = (code: string, name: string): SeedAccount => ({ code, name, type: "income", subtype: "operating_income", parent: "4000" });
const cogs = (code: string, name: string): SeedAccount => ({ code, name, type: "expense", subtype: "cogs", parent: "5000" });
const opex = (code: string, name: string): SeedAccount => ({ code, name, type: "expense", subtype: "operating_expense", parent: "6000" });
const liab = (code: string, name: string): SeedAccount => ({ code, name, type: "liability", subtype: "current_liability", parent: "2100" });
const asset = (code: string, name: string): SeedAccount => ({ code, name, type: "asset", subtype: "current_asset", parent: "1100" });

export const BUSINESS_TYPES: BusinessType[] = [
  {
    key: "general", label: "General business", description: "Standard chart of accounts for any business.",
    accounts: [], units: [], items: [], modules: ["inventory", "payroll"],
  },
  {
    key: "retail", label: "Supermarket / retail store", description: "Counter sales, stock with reorder levels, barcodes (SKU), shrinkage.",
    accounts: [inc("4301", "Counter Sales"), inc("4302", "Online Orders"), cogs("5401", "Packing Materials"), cogs("5402", "Shrinkage & Wastage"), opex("7001", "Store Supplies")],
    units: [["pcs", "Pieces"], ["pkt", "Packets"], ["dzn", "Dozen"]],
    items: [
      { name: "Rice 5 kg bag", kind: "goods", unit: "pkt", price: "350.00", gst: "GST 5%", hsn: "1006", income: "4301", track: true },
      { name: "Sugar 1 kg", kind: "goods", unit: "pkt", price: "48.00", gst: "GST 5%", hsn: "1701", income: "4301", track: true },
      { name: "Toned milk 1 L", kind: "goods", unit: "pcs", price: "56.00", gst: "GST 0% (Nil rated)", hsn: "0401", income: "4301", track: true },
      { name: "Bath soap", kind: "goods", unit: "pcs", price: "40.00", gst: "GST 18%", hsn: "3401", income: "4301", track: true },
    ],
    modules: ["inventory", "pos", "payroll"],
  },
  {
    key: "jewellery", label: "Jewellery / gold & silver shop",
    description: "Gold and silver sold by weight (grams, 3 decimals), purity-wise rates (24K, 22K, 18K), making charges, old-gold exchange, hallmark (HUID) in the item name, GST 3%.",
    accounts: [inc("4301", "Gold Jewellery Sales"), inc("4302", "Silver & Other Sales"), inc("4303", "Making & Repair Charges"),
      cogs("5401", "Gold & Silver Purchases"), cogs("5402", "Old Gold Purchased (Exchange)"), opex("7001", "Hallmarking & Testing"), asset("1191", "Gold Received for Job Work")],
    units: [["g", "Grams"], ["mg", "Milligrams"], ["ct", "Carats (stones)"], ["pcs", "Pieces"]],
    items: [
      { name: "Gold 22K (916) jewellery — rate per gram", kind: "goods", unit: "g", price: "6800.00", gst: "GST 3%", hsn: "7113", income: "4301", track: true },
      { name: "Gold 18K (750) jewellery — rate per gram", kind: "goods", unit: "g", price: "5600.00", gst: "GST 3%", hsn: "7113", income: "4301", track: true },
      { name: "Gold 24K (999) coin / bar — rate per gram", kind: "goods", unit: "g", price: "7400.00", gst: "GST 3%", hsn: "7108", income: "4301", track: true },
      { name: "Silver (999) — rate per gram", kind: "goods", unit: "g", price: "95.00", gst: "GST 3%", hsn: "7106", income: "4302", track: true },
      { name: "Making charges (with jewellery sold)", kind: "service", unit: "g", price: "450.00", gst: "GST 3%", hsn: "7113", income: "4303" },
      { name: "Job work / repair (customer's gold)", kind: "service", unit: "nos", price: "500.00", gst: "GST 5%", hsn: "998892", income: "4303" },
    ],
    modules: ["inventory", "pos", "payroll"],
  },
  {
    key: "clothing", label: "Clothing / textiles / boutique", description: "Garments by size and colour, fabric by metre, alterations; GST 5% up to ₹2,500 a piece, 18% above.",
    accounts: [inc("4301", "Garment Sales"), inc("4302", "Fabric Sales"), inc("4303", "Alteration & Tailoring"), cogs("5401", "Packing Materials"), opex("7001", "Tailoring Charges")],
    units: [["pcs", "Pieces"], ["set", "Sets"], ["pair", "Pairs"]],
    items: [
      { name: "Cotton shirt (up to ₹2,500)", kind: "goods", unit: "pcs", price: "899.00", gst: "GST 5%", hsn: "6205", income: "4301", track: true },
      { name: "Jeans (up to ₹2,500)", kind: "goods", unit: "pcs", price: "1499.00", gst: "GST 5%", hsn: "6203", income: "4301", track: true },
      { name: "Party wear dress (above ₹2,500)", kind: "goods", unit: "pcs", price: "3999.00", gst: "GST 18%", hsn: "6204", income: "4301", track: true },
      { name: "Cotton fabric (per metre)", kind: "goods", unit: "mtr", price: "180.00", gst: "GST 5%", hsn: "5208", income: "4302", track: true },
      { name: "Alteration / stitching", kind: "service", unit: "nos", price: "250.00", gst: "GST 5%", hsn: "998821", income: "4303" },
    ],
    modules: ["inventory", "pos", "payroll"],
  },
  {
    key: "electronics", label: "Mobile / electronics shop", description: "Phones and appliances with IMEI or serial numbers, accessories, repairs and service.",
    accounts: [inc("4301", "Mobile & Electronics Sales"), inc("4302", "Accessories Sales"), inc("4303", "Repair & Service Income"), cogs("5401", "Spare Parts Used"), opex("7001", "Warranty & Returns")],
    units: [["pcs", "Pieces"], ["set", "Sets"]],
    items: [
      { name: "Smartphone (enter IMEI in the line description)", kind: "goods", unit: "pcs", price: "15999.00", gst: "GST 18%", hsn: "8517", income: "4301", track: true },
      { name: "Mobile charger", kind: "goods", unit: "pcs", price: "699.00", gst: "GST 18%", hsn: "8504", income: "4302", track: true },
      { name: "LED TV 43 inch", kind: "goods", unit: "pcs", price: "27999.00", gst: "GST 18%", hsn: "8528", income: "4301", track: true },
      { name: "Mobile repair / service", kind: "service", unit: "nos", price: "500.00", gst: "GST 18%", hsn: "998714", income: "4303" },
    ],
    modules: ["inventory", "pos", "payroll"],
  },
  {
    key: "pharmacy", label: "Medical store / pharmacy", description: "Medicines with batch and expiry, MRP, schedule-H register, GST 5% on most medicines.",
    accounts: [inc("4301", "Medicine Sales"), inc("4302", "Surgical & FMCG Sales"), cogs("5401", "Expired & Damaged Stock")],
    units: [["strip", "Strips"], ["btl", "Bottles"], ["pcs", "Pieces"]],
    items: [
      { name: "Paracetamol 650 mg (strip of 15)", kind: "goods", unit: "strip", price: "33.00", gst: "GST 5%", hsn: "3004", income: "4301", track: true },
      { name: "Cough syrup 100 ml", kind: "goods", unit: "btl", price: "115.00", gst: "GST 5%", hsn: "3004", income: "4301", track: true },
      { name: "Surgical gloves (pair)", kind: "goods", unit: "pcs", price: "25.00", gst: "GST 5%", hsn: "4015", income: "4302", track: true },
    ],
    modules: ["inventory", "pos", "payroll"],
  },
  {
    key: "hardware", label: "Hardware / paints / building materials", description: "Cement, steel, paints, pipes and fittings by bag, kg, litre or metre; credit sales to contractors.",
    accounts: [inc("4301", "Hardware Sales"), inc("4302", "Paint Sales"), cogs("5401", "Loading & Unloading"), opex("7001", "Freight Inward")],
    units: [["bag", "Bags"], ["pcs", "Pieces"]],
    items: [
      { name: "Cement 50 kg bag", kind: "goods", unit: "bag", price: "390.00", gst: "GST 18%", hsn: "2523", income: "4301", track: true },
      { name: "TMT steel bar", kind: "goods", unit: "kg", price: "68.00", gst: "GST 18%", hsn: "7214", income: "4301", track: true },
      { name: "Emulsion paint 20 L", kind: "goods", unit: "pcs", price: "5200.00", gst: "GST 18%", hsn: "3209", income: "4302", track: true },
      { name: "PVC pipe (per metre)", kind: "goods", unit: "mtr", price: "85.00", gst: "GST 18%", hsn: "3917", income: "4301", track: true },
    ],
    modules: ["inventory", "pos", "payroll"],
  },
  {
    key: "automobile", label: "Automobile garage / spare parts", description: "Vehicle service and repairs, spare parts and lubricants, job cards by vehicle number.",
    accounts: [inc("4301", "Spare Parts Sales"), inc("4302", "Service & Labour Income"), cogs("5401", "Consumables Used"), opex("7001", "Outside Work (Sublet)")],
    units: [["pcs", "Pieces"], ["set", "Sets"]],
    items: [
      { name: "Engine oil 1 L", kind: "goods", unit: "ltr", price: "450.00", gst: "GST 18%", hsn: "2710", income: "4301", track: true },
      { name: "Brake pads (set)", kind: "goods", unit: "set", price: "1200.00", gst: "GST 18%", hsn: "8708", income: "4301", track: true },
      { name: "General service labour", kind: "service", unit: "nos", price: "800.00", gst: "GST 18%", hsn: "998714", income: "4302" },
    ],
    modules: ["inventory", "pos", "payroll"],
  },
  {
    key: "salon", label: "Salon / spa / gym / fitness", description: "Haircut, beauty and spa services, memberships and packages, product sales; services at GST 5%.",
    accounts: [inc("4301", "Service Income"), inc("4302", "Membership & Package Income"), inc("4303", "Product Sales"), opex("7001", "Salon Consumables")],
    units: [["session", "Sessions"], ["month", "Months"], ["pcs", "Pieces"]],
    items: [
      { name: "Haircut", kind: "service", unit: "session", price: "300.00", gst: "GST 5%", hsn: "999721", income: "4301" },
      { name: "Facial / spa treatment", kind: "service", unit: "session", price: "1500.00", gst: "GST 5%", hsn: "999722", income: "4301" },
      { name: "Gym membership (per month)", kind: "service", unit: "month", price: "1200.00", gst: "GST 5%", hsn: "999723", income: "4302" },
      { name: "Hair care product", kind: "goods", unit: "pcs", price: "450.00", gst: "GST 18%", hsn: "3305", income: "4303", track: true },
    ],
    modules: ["pos", "inventory", "payroll"],
  },
  {
    key: "agri", label: "Agri inputs / fertiliser / seeds dealer", description: "Fertilisers, seeds and farm inputs by bag or kg, seasonal credit to farmers.",
    accounts: [inc("4301", "Fertiliser Sales"), inc("4302", "Seed Sales"), inc("4303", "Other Farm Inputs"), opex("7001", "Godown Rent")],
    units: [["bag", "Bags"], ["pkt", "Packets"]],
    items: [
      { name: "Urea 45 kg bag", kind: "goods", unit: "bag", price: "266.50", gst: "GST 5%", hsn: "3102", income: "4301", track: true },
      { name: "Paddy seeds (per kg)", kind: "goods", unit: "kg", price: "60.00", gst: "GST 0% (Nil rated)", hsn: "1006", income: "4302", track: true },
    ],
    modules: ["inventory", "payroll"],
  },
  {
    key: "furniture", label: "Furniture / home décor", description: "Furniture and décor sales, custom orders with advances, delivery and fitting.",
    accounts: [inc("4301", "Furniture Sales"), inc("4302", "Delivery & Fitting Charges"), opex("7001", "Delivery Expenses")],
    units: [["pcs", "Pieces"], ["set", "Sets"]],
    items: [
      { name: "Wooden dining table", kind: "goods", unit: "pcs", price: "18500.00", gst: "GST 18%", hsn: "9403", income: "4301", track: true },
      { name: "Sofa set (3+1+1)", kind: "goods", unit: "set", price: "32000.00", gst: "GST 18%", hsn: "9401", income: "4301", track: true },
      { name: "Delivery & fitting", kind: "service", unit: "nos", price: "800.00", gst: "GST 18%", hsn: "996511", income: "4302" },
    ],
    modules: ["inventory", "payroll"],
  },
  {
    key: "realestate", label: "Real estate / rentals / property management", description: "Rent from properties, maintenance charges, security deposits, brokerage.",
    accounts: [inc("4301", "Rental Income"), inc("4302", "Maintenance Charges"), inc("4303", "Brokerage Income"), liab("2171", "Security Deposits from Tenants"), opex("7001", "Property Repairs")],
    units: [["month", "Months"], ["sqft", "Square feet"]],
    items: [
      { name: "Commercial rent (per month)", kind: "service", unit: "month", price: "45000.00", gst: "GST 18%", hsn: "997212", income: "4301" },
      { name: "Residential rent (per month)", kind: "service", unit: "month", price: "18000.00", gst: "GST Exempt", hsn: "997211", income: "4301" },
      { name: "Maintenance charges", kind: "service", unit: "month", price: "3000.00", gst: "GST 18%", hsn: "995419", income: "4302" },
    ],
    modules: ["payroll"],
  },
  {
    key: "restaurant", label: "Restaurant / café / bakery", description: "Food and beverage sales, kitchen purchases, delivery-app commission, thermal bills.",
    accounts: [inc("4301", "Food Sales"), inc("4302", "Beverage Sales"), inc("4303", "Online Delivery Orders"), cogs("5401", "Food & Beverage Purchases"),
      opex("7001", "Gas & Fuel"), opex("7002", "Kitchen Consumables"), opex("7003", "Delivery Platform Commission")],
    units: [["plate", "Plates"], ["glass", "Glasses"], ["pcs", "Pieces"]],
    items: [
      { name: "Veg meals", kind: "goods", unit: "plate", price: "120.00", gst: "GST 5%", hsn: "996331", income: "4301" },
      { name: "Chicken biryani", kind: "goods", unit: "plate", price: "220.00", gst: "GST 5%", hsn: "996331", income: "4301" },
      { name: "Masala tea", kind: "goods", unit: "glass", price: "20.00", gst: "GST 5%", hsn: "996331", income: "4302" },
      { name: "Fresh lime soda", kind: "goods", unit: "glass", price: "60.00", gst: "GST 5%", hsn: "996331", income: "4302" },
    ],
    modules: ["pos", "inventory", "payroll"],
  },
  {
    key: "software", label: "Software / IT services", description: "Project and hourly billing, AMC, subscriptions, timesheets, cloud costs.",
    accounts: [inc("4301", "Software Development Income"), inc("4302", "AMC & Support Income"), inc("4303", "Subscription (SaaS) Income"),
      opex("7001", "Cloud Hosting & Servers"), opex("7002", "Contractor & Freelancer Fees"), asset("1191", "Unbilled Revenue")],
    units: [["month", "Months"], ["user", "Users"]],
    items: [
      { name: "Software development (per hour)", kind: "service", unit: "hrs", price: "1500.00", gst: "GST 18%", hsn: "998314", income: "4301" },
      { name: "Annual maintenance contract", kind: "service", unit: "nos", price: "25000.00", gst: "GST 18%", hsn: "998313", income: "4302" },
      { name: "SaaS subscription (per user / month)", kind: "service", unit: "user", price: "499.00", gst: "GST 18%", hsn: "998315", income: "4303" },
    ],
    modules: ["timesheets", "projects", "payroll"],
  },
  {
    key: "education", label: "School / college / coaching", description: "Tuition, admission, exam, transport and hostel fees; caution deposits.",
    accounts: [inc("4301", "Tuition Fees"), inc("4302", "Admission Fees"), inc("4303", "Examination Fees"), inc("4304", "Transport (Bus) Fees"), inc("4305", "Hostel Fees"),
      liab("2171", "Caution Deposits Refundable"), liab("2172", "Fees Received in Advance"), opex("7001", "Teaching Materials & Lab Supplies"), opex("7002", "Events & Activities")],
    units: [["term", "Terms"], ["student", "Students"]],
    items: [
      { name: "Tuition fee (per term)", kind: "service", unit: "term", price: "15000.00", gst: "GST Exempt", hsn: "9992", income: "4301" },
      { name: "Admission fee", kind: "service", unit: "nos", price: "5000.00", gst: "GST Exempt", hsn: "9992", income: "4302" },
      { name: "Examination fee", kind: "service", unit: "nos", price: "1000.00", gst: "GST Exempt", hsn: "9992", income: "4303" },
      { name: "School bus fee (per term)", kind: "service", unit: "term", price: "4500.00", gst: "GST Exempt", hsn: "9992", income: "4304" },
    ],
    modules: ["fees", "payroll"],
  },
  {
    key: "healthcare", label: "Clinic / hospital / pharmacy", description: "Consultation, pharmacy and lab income; medical consumables.",
    accounts: [inc("4301", "Consultation Fees"), inc("4302", "Pharmacy Sales"), inc("4303", "Laboratory Income"), cogs("5401", "Medicines Purchased"), opex("7001", "Medical Consumables")],
    units: [["strip", "Strips"], ["visit", "Visits"]],
    items: [
      { name: "Doctor consultation", kind: "service", unit: "visit", price: "500.00", gst: "GST Exempt", hsn: "9993", income: "4301" },
      { name: "Blood test (CBC)", kind: "service", unit: "nos", price: "350.00", gst: "GST Exempt", hsn: "9993", income: "4303" },
      { name: "Paracetamol 500 mg (strip)", kind: "goods", unit: "strip", price: "30.00", gst: "GST 5%", hsn: "3004", income: "4302", track: true },
    ],
    modules: ["inventory", "payroll"],
  },
  {
    key: "manufacturing", label: "Manufacturing / factory", description: "Raw materials, factory wages, power, finished-goods sales.",
    accounts: [inc("4301", "Sales — Finished Goods"), inc("4302", "Scrap Sales"), cogs("5401", "Raw Materials Consumed"), cogs("5402", "Factory Wages"), cogs("5403", "Power & Fuel (Factory)"), opex("7001", "Freight Outward")],
    units: [["pcs", "Pieces"], ["ton", "Tonnes"], ["set", "Sets"]],
    items: [
      { name: "Finished product A", kind: "goods", unit: "pcs", price: "850.00", gst: "GST 18%", income: "4301", track: true },
      { name: "Raw material steel sheet", kind: "goods", unit: "kg", price: "75.00", gst: "GST 18%", hsn: "7208", track: true },
    ],
    modules: ["inventory", "payroll"],
  },
  {
    key: "wholesale", label: "Trading / wholesale / distribution", description: "Bulk purchases and sales, freight, trade discounts.",
    accounts: [inc("4301", "Wholesale Sales"), cogs("5401", "Freight Inward"), opex("7001", "Freight Outward"), opex("7002", "Trade Discounts Allowed")],
    units: [["case", "Cases"], ["bag", "Bags"]],
    items: [{ name: "Product carton (24 units)", kind: "goods", unit: "case", price: "1200.00", gst: "GST 18%", income: "4301", track: true }],
    modules: ["inventory"],
  },
  {
    key: "construction", label: "Construction / contractor", description: "Contract revenue, retention, sub-contractors, site expenses.",
    accounts: [inc("4301", "Contract Revenue"), asset("1191", "Retention Money Receivable"), cogs("5401", "Sub-contractor Charges"), cogs("5402", "Site Materials"), opex("7001", "Site Expenses")],
    units: [["sqft", "Square feet"], ["cum", "Cubic metres"]],
    items: [{ name: "Construction work (per sq. ft.)", kind: "service", unit: "sqft", price: "1800.00", gst: "GST 18%", hsn: "9954", income: "4301" }],
    modules: ["projects", "payroll", "timesheets"],
  },
  {
    key: "hotel", label: "Hotel / guest house", description: "Room revenue, food & beverage, housekeeping.",
    accounts: [inc("4301", "Room Revenue"), inc("4302", "Food & Beverage Revenue"), opex("7001", "Housekeeping Supplies"), opex("7002", "Online Travel Agency Commission")],
    units: [["night", "Room nights"], ["plate", "Plates"]],
    items: [
      { name: "Deluxe room (per night)", kind: "service", unit: "night", price: "3500.00", gst: "GST 5%", hsn: "996311", income: "4301" },
      { name: "Breakfast", kind: "goods", unit: "plate", price: "250.00", gst: "GST 5%", hsn: "996331", income: "4302" },
    ],
    modules: ["pos", "payroll"],
  },
  {
    key: "services", label: "Professional services / agency", description: "CA, consultants, designers, agencies: fees, retainers, reimbursements.",
    accounts: [inc("4301", "Professional Fees"), inc("4302", "Retainer Income"), asset("1191", "Reimbursable Expenses")],
    units: [],
    items: [
      { name: "Consulting (per hour)", kind: "service", unit: "hrs", price: "2000.00", gst: "GST 18%", hsn: "998311", income: "4301" },
      { name: "Monthly retainer", kind: "service", unit: "nos", price: "30000.00", gst: "GST 18%", hsn: "998311", income: "4302" },
    ],
    modules: ["timesheets", "projects"],
  },
  {
    key: "ngo", label: "NGO / trust / society", description: "Donations, grants, programme expenses, restricted funds.",
    accounts: [inc("4301", "Donations Received"), inc("4302", "Grants Received"), liab("2171", "Restricted Grants (Unspent)"), opex("7001", "Programme Expenses"), opex("7002", "Fund-raising Expenses")],
    units: [],
    items: [{ name: "Donation", kind: "service", unit: "nos", price: "1000.00", gst: "Non-GST supply", income: "4301" }],
    modules: ["payroll"],
  },
  {
    key: "transport", label: "Transport / logistics", description: "Freight income, fuel, tolls, vehicle maintenance.",
    accounts: [inc("4301", "Freight Income"), opex("7001", "Fuel"), opex("7002", "Tolls & Permits"), opex("7003", "Vehicle Maintenance")],
    units: [["trip", "Trips"], ["km", "Kilometres"]],
    items: [{ name: "Freight charges (per trip)", kind: "service", unit: "trip", price: "8000.00", gst: "GST 5%", hsn: "9965", income: "4301" }],
    modules: ["payroll"],
  },
];

export function businessType(key: string | null | undefined): BusinessType {
  return BUSINESS_TYPES.find((b) => b.key === key) ?? BUSINESS_TYPES[0];
}
