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
