import { Logo } from "@/components/logo";
import { Dock } from "@/components/shell/dock";
import { requireSession } from "@/lib/auth";

// Everything behind the sign-in wall: a slim top bar, the page, and the floating dock.
// Each page also calls requireSession() (layouts are not re-run on client navigation, and prefetches skip the proxy).
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireSession();
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col px-4 sm:px-8">
      <header className="flex h-[72px] shrink-0 items-center justify-between gap-4">
        <Logo className="h-auto w-[184px] text-foreground" />
      </header>
      {/* Bottom padding keeps the last content clear of the dock and its bead. */}
      <main id="main" className="flex flex-1 flex-col pb-36">
        {children}
      </main>
      <Dock />
    </div>
  );
}
