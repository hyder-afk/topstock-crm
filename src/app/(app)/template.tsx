// Re-mounts on every navigation inside the app, so each page enters with a short fade and 8 px rise
// (CSS only: content is visible without JavaScript, and reduced motion turns it off globally).
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="animate-page flex flex-1 flex-col">{children}</div>;
}
