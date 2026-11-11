/** Simulated finance environments. Bill Pay is built; the rest show where the lab goes next. */
export const WORLDS = [
  {
    id: "bill_pay",
    name: "Bill Pay & AP",
    status: "ready" as const,
    blurb: "Vendor bills, approvals, payments, settlement and ERP sync.",
    objects: ["Bills", "Vendors", "Approvals", "Payments", "Ledger", "AP inbox"],
  },
  {
    id: "reimbursements",
    name: "Reimbursements",
    status: "planned" as const,
    blurb: "Employee expenses, receipt images, per-diem and policy limits.",
    objects: ["Expenses", "Receipts", "Policies", "Payouts"],
  },
  {
    id: "cards",
    name: "Cards & disputes",
    status: "planned" as const,
    blurb: "Card transactions, merchant refunds, disputes and limits.",
    objects: ["Transactions", "Cards", "Disputes", "Refunds"],
  },
  {
    id: "close",
    name: "Reconciliation & close",
    status: "planned" as const,
    blurb: "Bank feeds, matching, accruals and month-end close.",
    objects: ["Bank feed", "Matches", "Journal entries", "Close checklist"],
  },
  {
    id: "procurement",
    name: "Procurement",
    status: "planned" as const,
    blurb: "Purchase requests, POs, three-way match.",
    objects: ["Requests", "POs", "Receipts", "Invoices"],
  },
];
