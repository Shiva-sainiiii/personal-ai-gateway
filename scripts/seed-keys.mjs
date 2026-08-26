// One-time setup script. Run locally with: npm run seed
// Reads MASTER_KEY_* and provider keys from your local .env file,
// hashes/encrypts them, and writes to Firestore.
//
// You do NOT have to run this — you can also add keys one-by-one from
// the admin frontend (POST /api/admin/keys). This script just makes
// bulk-loading your already-generated 25 keys faster.

import "dotenv/config";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import crypto from "node:crypto";

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function encrypt(plaintext) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, "hex");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

const app = initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});
const db = getFirestore(app);

async function seedMasterKeys() {
  const types = { text: process.env.MASTER_KEY_TEXT, image: process.env.MASTER_KEY_IMAGE, audio: process.env.MASTER_KEY_AUDIO };
  for (const [type, plain] of Object.entries(types)) {
    if (!plain || plain.startsWith("replace_me")) {
      console.log(`  skip masterKeys/${type} (not set in .env)`);
      continue;
    }
    await db.collection("masterKeys").doc(type).set({
      hash: sha256Hex(plain),
      active: true,
      createdAt: FieldValue.serverTimestamp(),
    });
    console.log(`  wrote masterKeys/${type}`);
  }
}

async function seedProviderKeys() {
  const accounts = ["acc1", "acc2", "acc3", "acc4"];
  const providerEnvPrefix = {
    openrouter: "OPENROUTER",
    googleAiStudio: "GOOGLE_AI",
    groq: "GROQ",
    cerebras: "CEREBRAS",
    cloudflare: "CLOUDFLARE",
  };

  for (const [provider, prefix] of Object.entries(providerEnvPrefix)) {
    for (const acc of accounts) {
      const envKeyName = `${prefix}_${acc.toUpperCase()}_KEY`;
      const plain = process.env[envKeyName];
      if (!plain) {
        console.log(`  skip ${provider}_${acc} (${envKeyName} not set)`);
        continue;
      }

      const docData = {
        provider,
        accountLabel: acc,
        encryptedKey: encrypt(plain),
        accountId: null,
        status: "active",
        cooldownUntil: null,
        failCount: 0,
        successCount: 0,
        lastUsedAt: null,
        lastError: null,
        createdAt: FieldValue.serverTimestamp(),
      };

      if (provider === "cloudflare") {
        const accIdEnvName = `${prefix}_${acc.toUpperCase()}_ACCOUNT_ID`;
        docData.accountId = process.env[accIdEnvName] || null;
        if (!docData.accountId) {
          console.log(`  warning: ${accIdEnvName} not set — cloudflare calls for ${acc} will fail without it`);
        }
      }

      await db.collection("apiKeys").doc(`${provider}_${acc}`).set(docData);
      console.log(`  wrote apiKeys/${provider}_${acc}`);
    }
  }
}

async function main() {
  console.log("Seeding master keys...");
  await seedMasterKeys();
  console.log("\nSeeding provider keys...");
  await seedProviderKeys();
  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
