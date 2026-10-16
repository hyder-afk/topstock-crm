"use client";

// Last-resort boundary for errors in the root layout itself (translations and fonts may be unavailable here).
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", background: "#f5f3ef", color: "#0e0e10", padding: 24 }}>
        <main>
          <h1>
            Something went wrong / <span lang="fr">Une erreur est survenue</span>
          </h1>
          <button type="button" onClick={reset}>
            Try again / <span lang="fr">Réessayer</span>
          </button>
        </main>
      </body>
    </html>
  );
}
