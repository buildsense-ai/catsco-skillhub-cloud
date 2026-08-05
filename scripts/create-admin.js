import { hashPassword } from "../packages/auth/index.js";
import { loadConfig } from "../packages/config/index.js";
import { createStore, closePools } from "../packages/database/store.js";

const config = loadConfig();
const store = createStore(config);

const email = process.env.SKILLHUB_ADMIN_EMAIL || process.argv[2];
const password = process.env.SKILLHUB_ADMIN_PASSWORD || process.argv[3];
const displayName = process.env.SKILLHUB_ADMIN_NAME || process.argv[4] || "SkillHub Admin";

if (!email || !password) {
  console.error(`Usage:
  SKILLHUB_ADMIN_EMAIL=admin@example.com SKILLHUB_ADMIN_PASSWORD='strong-password' npm run admin:create
or:
  node scripts/create-admin.js admin@example.com 'strong-password' 'Admin Name'`);
  process.exit(1);
}

try {
  let user = await store.getUserByEmail(email);
  if (!user) {
    user = await store.createUser({
      email,
      passwordHash: hashPassword(password),
      displayName
    });
    console.log(`created user ${user.email}`);
  } else {
    console.log(`user exists ${user.email}`);
  }
  await store.grantRole({ userId: user.id, role: "admin", grantedBy: "bootstrap" });
  await store.grantRole({ userId: user.id, role: "reviewer", grantedBy: "bootstrap" });
  console.log(`granted admin and reviewer roles to ${user.email}`);
} finally {
  await closePools();
}

