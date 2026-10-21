import { StrictMode, Suspense, lazy, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from "react-router";
import "./styles.css";
import { SessionProvider, useSession } from "./lib/session";
import { Spinner, ToastProvider } from "./components/ui";
import { CompanyLayout } from "./components/Layout";
import Landing from "./pages/Landing";
import { Login, Register, Forgot, ResetWithToken, AcceptInvite, ChangePasswordFirst } from "./pages/Auth";
import { AppHome, NewCompany } from "./pages/Onboarding";
import { startOfflineSync } from "./lib/offline";
function named<M, K extends keyof M>(p: Promise<M>, k: K) {
  return p.then((m) => ({ default: m[k] as M[K] & ComponentType<any> }));
}
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Accounts = lazy(() => import("./pages/Accounts"));
const JournalForm = lazy(() => named(import("./pages/Journals"), "JournalForm"));
const JournalList = lazy(() => named(import("./pages/Journals"), "JournalList"));
const JournalView = lazy(() => named(import("./pages/Journals"), "JournalView"));
const OpeningBalances = lazy(() => named(import("./pages/Journals"), "OpeningBalances"));
const ContactList = lazy(() => named(import("./pages/Contacts"), "ContactList"));
const ContactView = lazy(() => named(import("./pages/Contacts"), "ContactView"));
const DocumentForm = lazy(() => named(import("./pages/Documents"), "DocumentForm"));
const DocumentList = lazy(() => named(import("./pages/Documents"), "DocumentList"));
const DocumentView = lazy(() => named(import("./pages/Documents"), "DocumentView"));
const PaymentForm = lazy(() => named(import("./pages/Payments"), "PaymentForm"));
const PaymentList = lazy(() => named(import("./pages/Payments"), "PaymentList"));
const PaymentView = lazy(() => named(import("./pages/Payments"), "PaymentView"));
const Expenses = lazy(() => import("./pages/Expenses"));
const Daybook = lazy(() => import("./pages/Daybook"));
const Labels = lazy(() => import("./pages/Labels"));
const GstReturns = lazy(() => import("./pages/GstReturns"));
const ImportPage = lazy(() => import("./pages/Import"));
const Recurring = lazy(() => import("./pages/Recurring"));
const Pos = lazy(() => import("./pages/Pos"));
const Banking = lazy(() => import("./pages/Banking"));
const Inventory = lazy(() => import("./pages/Inventory"));
const Assets = lazy(() => import("./pages/Assets"));
const Insights = lazy(() => named(import("./pages/Reports"), "Insights"));
const ReportIndex = lazy(() => named(import("./pages/Reports"), "ReportIndex"));
const ReportRouter = lazy(() => named(import("./pages/Reports"), "ReportRouter"));
const Statement = lazy(() => named(import("./pages/Reports"), "Statement"));
const Settings = lazy(() => import("./pages/Settings"));
const Download = lazy(() => import("./pages/Download"));
const Verify = lazy(() => import("./pages/Verify"));
const PrintPage = lazy(() => import("./pages/Print"));
const Payroll = lazy(() => import("./pages/Payroll"));
const Privacy = lazy(() => import("./pages/Privacy"));

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useSession();
  const loc = useLocation();
  if (loading) return <Spinner />;
  if (!me?.user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (me.user.must_change_password) return <ChangePasswordFirst />;
  return <>{children}</>;
}

/** Remount document pages when the type changes so form state never leaks between types. */
function Keyed({ children }: { children: (k: string) => ReactNode }) {
  const p = useParams();
  return <>{children(`${p.docType}-${p.docId ?? "new"}`)}</>;
}

function NotFound() {
  return <div className="p-10 text-center"><p className="text-lg font-semibold">Page not found</p><a className="text-brand-700 underline" href="/app">Go to the app</a></div>;
}

function App() {
  return (
    <Suspense fallback={<Spinner />}>
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/download" element={<Download />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route path="/verify/:token" element={<Verify />} />
      <Route path="/print/:companyId/:kind/:id" element={<RequireAuth><PrintPage /></RequireAuth>} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot" element={<Forgot />} />
      <Route path="/reset" element={<ResetWithToken />} />
      <Route path="/invite" element={<AcceptInvite />} />
      <Route path="/app" element={<RequireAuth><AppHome /></RequireAuth>} />
      <Route path="/app/new-company" element={<RequireAuth><NewCompany /></RequireAuth>} />
      <Route path="/app/:companyId" element={<RequireAuth><CompanyLayout /></RequireAuth>}>
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="daybook" element={<Daybook />} />
        <Route path="labels" element={<Labels />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="recurring" element={<Recurring />} />
        <Route path="pos" element={<Pos />} />
        <Route path="accounts" element={<Accounts />} />
        <Route path="journals" element={<JournalList />} />
        <Route path="journals/new" element={<JournalForm />} />
        <Route path="journals/opening" element={<OpeningBalances />} />
        <Route path="journals/:journalId" element={<JournalView />} />
        <Route path="journals/:journalId/edit" element={<JournalForm />} />
        <Route path="customers" element={<ContactList key="c" kind="customer" />} />
        <Route path="suppliers" element={<ContactList key="s" kind="supplier" />} />
        <Route path="contacts/:contactId" element={<ContactView />} />
        {(["sales", "purchases"] as const).map((area) => [
          <Route key={`${area}-l`} path={`${area}/:docType`} element={<Keyed>{(k) => <DocumentList key={k} />}</Keyed>} />,
          <Route key={`${area}-n`} path={`${area}/:docType/new`} element={<Keyed>{(k) => <DocumentForm key={k} />}</Keyed>} />,
          <Route key={`${area}-v`} path={`${area}/:docType/:docId`} element={<Keyed>{(k) => <DocumentView key={k} />}</Keyed>} />,
          <Route key={`${area}-e`} path={`${area}/:docType/:docId/edit`} element={<Keyed>{(k) => <DocumentForm key={k} />}</Keyed>} />,
        ])}
        <Route path="payments/view/:paymentId" element={<PaymentView />} />
        <Route path="payments/:direction" element={<Keyed>{(k) => <PaymentList key={k} />}</Keyed>} />
        <Route path="payments/:direction/new" element={<PaymentForm />} />
        <Route path="expenses" element={<Expenses />} />
        <Route path="banking" element={<Banking />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="assets" element={<Assets />} />
        <Route path="reports" element={<ReportIndex />} />
        <Route path="reports/statement/:contactId" element={<Statement />} />
        <Route path="reports/gst-returns" element={<GstReturns />} />
        <Route path="reports/:reportKey" element={<ReportRouter />} />
        <Route path="insights" element={<Insights />} />
        <Route path="settings" element={<Settings />} />
        <Route path="payroll" element={<Payroll />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
    </Suspense>
  );
}

startOfflineSync();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
