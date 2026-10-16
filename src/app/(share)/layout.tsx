// The client stock page's group (design 8.6): no app chrome, no session, no providers but the root layout's. The proxy
// serves /s and /api/share before any session code, with the share CSP and no cookies.
export default function ShareLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-safe-screen bg-background">{children}</div>;
}
