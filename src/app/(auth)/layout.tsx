import { Logo } from "@/components/logo";
import { SettingsBar } from "@/components/settings-bar";

// Sign-in screens: the brand header, then one narrow card in the middle of the page.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-safe-screen w-full max-w-5xl flex-col gap-10 px-4 py-8 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Logo className="h-auto w-[184px] text-foreground" />
        <SettingsBar />
      </header>
      <main id="main" className="flex flex-1 flex-col items-center sm:justify-center sm:pb-24">
        {children}
      </main>
    </div>
  );
}
