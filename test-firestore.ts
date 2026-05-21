import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "fs";
import path from "path";

async function test() {
  console.log("GOOGLE_CLOUD_PROJECT:", process.env.GOOGLE_CLOUD_PROJECT);
  console.log("GAE_APPLICATION:", process.env.GAE_APPLICATION);
  console.log("CLOUD_RUN_SERVICE:", process.env.CLOUD_RUN_SERVICE);
  
  const firebaseConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), "firebase-applet-config.json"), "utf8"));
  console.log("Config Project Id:", firebaseConfig.projectId);
  console.log("Config Database Id:", firebaseConfig.firestoreDatabaseId);

  // Initialize with no config (let it auto-detect)
  try {
    const app = initializeApp();
    console.log("Initialized default Admin App via auto-detect.");
    const db = getFirestore(firebaseConfig.firestoreDatabaseId || undefined);
    console.log("Testing query on auto-detected app with custom database ID...");
    const snap = await db.collection("clients").limit(1).get();
    console.log("Success! Docs:", snap.size);
  } catch (err: any) {
    console.error("Auto-detect custom DB error:", err.message);
  }
}

test();
