import { z } from "zod";

// Only the public Supabase URL and the publishable (anon) key may reach the browser.
const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
});

const parsed = publicEnvSchema.safeParse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
});

if (!parsed.success) {
  // Names only, never values. Fails the build early so a misconfigured deployment never goes live.
  const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ");
  throw new Error(
    `Missing or invalid environment variables: ${names}. Set them in Vercel (Settings > Environment Variables) for this environment.`,
  );
}

export const publicEnv = parsed.data;
