"use client";

import { useEffect } from "react";

// Shown once per browser tab: the first render (server and hydration) carries the word-by-word rise; after that,
// coming back to Home shows the greeting at rest (DESIGN.md: entrances on first visit only).
let greeted = false;

export function Greeting({ hello, name }: { hello: string; name?: string }) {
  const play = !greeted;
  useEffect(() => {
    greeted = true;
  }, []);
  const words = [
    { text: hello, className: "text-muted-foreground" },
    ...(name ? [{ text: name, className: "text-foreground" }] : []),
  ];
  return (
    <h1 className="break-words text-4xl font-bold sm:text-5xl">
      {words.map((w, i) => (
        <span key={i}>
          {i > 0 ? " " : null}
          <span className={play ? `animate-word ${w.className}` : w.className} style={{ "--i": i } as React.CSSProperties}>
            {w.text}
          </span>
        </span>
      ))}
    </h1>
  );
}
