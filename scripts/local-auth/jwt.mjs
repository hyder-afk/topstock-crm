// Signs a long-lived HS256 token for the local auth server only (role: anon or service_role). Never used outside this VM.
import { createHmac } from "node:crypto";
const [secret, role] = process.argv.slice(2);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const head = b64({ alg: "HS256", typ: "JWT" });
const body = b64({ iss: "topstock-local", role, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 });
console.log(`${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`);
