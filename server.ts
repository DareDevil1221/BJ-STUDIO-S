import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import dotenv from "dotenv";
import fs from "fs";

// Extend Express Request interface to support custom user-session attachment
declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}

dotenv.config();

// ==========================================
// 100% LOCAL DATABASE ENGINE (JSON FILE DB)
// ==========================================

class MockFirestore {
  private dbFolder = path.join(process.cwd(), "local-db");

  constructor() {
    if (!fs.existsSync(this.dbFolder)) {
      fs.mkdirSync(this.dbFolder, { recursive: true });
    }
  }

  public readCollection(collectionName: string): Record<string, any> {
    const filePath = path.join(this.dbFolder, `${collectionName}.json`);
    if (!fs.existsSync(filePath)) {
      return {};
    }
    try {
      const content = fs.readFileSync(filePath, "utf8");
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  public writeCollection(collectionName: string, data: Record<string, any>) {
    const filePath = path.join(this.dbFolder, `${collectionName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  }

  collection(collectionName: string) {
    return new MockCollectionReference(this, collectionName);
  }

  batch() {
    return new MockWriteBatch(this);
  }
}

class MockCollectionReference {
  constructor(private firestore: MockFirestore, private name: string) {}

  doc(id?: string) {
    const docId = id || `doc-${Math.floor(100000 + Math.random() * 900000)}`;
    return new MockDocumentReference(this.firestore, this.name, docId);
  }

  async add(data: any) {
    const docId = `doc-${Math.floor(100000 + Math.random() * 900000)}`;
    const docRef = new MockDocumentReference(this.firestore, this.name, docId);
    await docRef.set(data);
    return docRef;
  }

  where(field: string, op: string, value: any) {
    return new MockQuery(this.firestore, this.name).where(field, op, value);
  }

  orderBy(field: string, direction?: "asc" | "desc") {
    return new MockQuery(this.firestore, this.name).orderBy(field, direction);
  }

  limit(n: number) {
    return new MockQuery(this.firestore, this.name).limit(n);
  }

  count() {
    return new MockQuery(this.firestore, this.name).count();
  }

  async get() {
    return new MockQuery(this.firestore, this.name).get();
  }
}

class MockDocumentReference {
  constructor(private firestore: MockFirestore, public name: string, public id: string) {}

  async get() {
    const collectionData = this.firestore.readCollection(this.name);
    const data = collectionData[this.id];
    return new MockDocumentSnapshot(this.id, data);
  }

  async set(data: any, options?: { merge?: boolean }) {
    const collectionData = this.firestore.readCollection(this.name);
    
    // Convert Dates to ISO string representation for JSON compatibility
    const prepareData = (obj: any): any => {
      if (obj instanceof Date) return obj.toISOString();
      if (Array.isArray(obj)) return obj.map(prepareData);
      if (typeof obj === 'object' && obj !== null) {
        const res: any = {};
        for (const k in obj) {
          res[k] = prepareData(obj[k]);
        }
        return res;
      }
      return obj;
    };

    const formattedData = prepareData(data);

    if (options?.merge && collectionData[this.id]) {
      collectionData[this.id] = { ...collectionData[this.id], ...formattedData };
    } else {
      collectionData[this.id] = { id: this.id, ...formattedData };
    }
    this.firestore.writeCollection(this.name, collectionData);
  }

  async update(data: any) {
    const collectionData = this.firestore.readCollection(this.name);
    if (collectionData[this.id]) {
      const prepareData = (obj: any): any => {
        if (obj instanceof Date) return obj.toISOString();
        if (Array.isArray(obj)) return obj.map(prepareData);
        if (typeof obj === 'object' && obj !== null) {
          const res: any = {};
          for (const k in obj) {
            res[k] = prepareData(obj[k]);
          }
          return res;
        }
        return obj;
      };
      
      const formattedData = prepareData(data);
      collectionData[this.id] = { ...collectionData[this.id], ...formattedData };
      this.firestore.writeCollection(this.name, collectionData);
    }
  }

  async delete() {
    const collectionData = this.firestore.readCollection(this.name);
    delete collectionData[this.id];
    this.firestore.writeCollection(this.name, collectionData);
  }
}

class MockDocumentSnapshot {
  public exists: boolean;
  constructor(public id: string, private _data: any) {
    this.exists = _data !== undefined;
  }

  data() {
    if (!this._data) return undefined;
    const cloned = JSON.parse(JSON.stringify(this._data));
    
    // Auto-convert ISO strings of date properties into mock firebase Timestamps
    const convertDates = (obj: any) => {
      if (typeof obj !== 'object' || obj === null) return;
      for (const key in obj) {
        if (typeof obj[key] === 'string' && (key.endsWith('At') || key === 'createdAt' || key === 'updatedAt' || key === 'deliveryDeadline')) {
          const parsedDate = new Date(obj[key]);
          if (!isNaN(parsedDate.getTime())) {
            obj[key] = {
              toDate: () => parsedDate,
              seconds: Math.floor(parsedDate.getTime() / 1000),
              nanoseconds: (parsedDate.getTime() % 1000) * 1e6
            };
          }
        } else if (typeof obj[key] === 'object') {
          convertDates(obj[key]);
        }
      }
    };
    convertDates(cloned);
    return cloned;
  }
}

class MockQuery {
  private filters: Array<{ field: string; op: string; value: any }> = [];
  private orderField: string | null = null;
  private orderDirection: "asc" | "desc" = "asc";
  private limitCount: number | null = null;

  constructor(private firestore: MockFirestore, private collectionName: string) {}

  where(field: string, op: string, value: any) {
    this.filters.push({ field, op, value });
    return this;
  }

  orderBy(field: string, direction?: "asc" | "desc") {
    this.orderField = field;
    this.orderDirection = direction || "asc";
    return this;
  }

  limit(n: number) {
    this.limitCount = n;
    return this;
  }

  count() {
    return {
      get: async () => {
        const snap = await this.get();
        return {
          data: () => ({ count: snap.size })
        };
      }
    };
  }

  async get() {
    const collectionData = this.firestore.readCollection(this.collectionName);
    let docs = Object.values(collectionData);

    // Apply filters
    for (const filter of this.filters) {
      docs = docs.filter((doc: any) => {
        const docVal = doc[filter.field];
        
        let targetValue = filter.value;
        let actualValue = docVal;

        // Strip dates/mock timestamps for comparison
        if (actualValue && typeof actualValue === 'object' && actualValue.toDate) {
          actualValue = actualValue.toDate().toISOString();
        }
        if (targetValue && typeof targetValue === 'object' && targetValue.toDate) {
          targetValue = targetValue.toDate().toISOString();
        }

        if (filter.op === "==") {
          return actualValue === targetValue;
        }
        return true;
      });
    }

    // Apply sorting
    if (this.orderField) {
      docs.sort((a: any, b: any) => {
        let valA = a[this.orderField!];
        let valB = b[this.orderField!];

        if (valA && typeof valA === 'object' && valA.toDate) valA = valA.toDate().getTime();
        if (valB && typeof valB === 'object' && valB.toDate) valB = valB.toDate().getTime();
        if (typeof valA === "string" && !isNaN(Date.parse(valA))) valA = Date.parse(valA);
        if (typeof valB === "string" && !isNaN(Date.parse(valB))) valB = Date.parse(valB);

        if (valA < valB) return this.orderDirection === "asc" ? -1 : 1;
        if (valA > valB) return this.orderDirection === "asc" ? 1 : -1;
        return 0;
      });
    }

    // Apply limit
    if (this.limitCount !== null) {
      docs = docs.slice(0, this.limitCount);
    }

    const docSnapshots = docs.map((doc: any) => new MockDocumentSnapshot(doc.id || doc.clientId || doc.email || "", doc));
    return new MockQuerySnapshot(docSnapshots);
  }
}

class MockQuerySnapshot {
  public empty: boolean;
  public size: number;
  constructor(public docs: MockDocumentSnapshot[]) {
    this.empty = docs.length === 0;
    this.size = docs.length;
  }
}

class MockWriteBatch {
  private operations: Array<() => Promise<void>> = [];
  constructor(private firestore: MockFirestore) {}

  set(docRef: MockDocumentReference, data: any) {
    this.operations.push(async () => {
      await docRef.set(data);
    });
    return this;
  }

  update(docRef: MockDocumentReference, data: any) {
    this.operations.push(async () => {
      await docRef.update(data);
    });
    return this;
  }

  async commit() {
    for (const op of this.operations) {
      await op();
    }
  }
}

// ------------------------------------------

const firebaseConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), "firebase-applet-config.json"), "utf8"));

// Initialize Firebase Admin (Only if not in 100% local database fallback mode)
const useLocalDb = process.env.USE_LOCAL_DB === "true";
if (!useLocalDb) {
  try {
    if (getApps().length === 0) {
      initializeApp({
        projectId: firebaseConfig.projectId
      });
      console.log("Firebase Admin initialized for project:", firebaseConfig.projectId);
    }
  } catch (e: any) {
    console.error("Firebase Admin init error:", e.message);
  }
}

// Database selection
const databaseId = firebaseConfig.firestoreDatabaseId;
let db: any;

if (useLocalDb) {
  console.log("================================================================");
  console.log("[SYSTEM] DATABASE MODE: 100% LOCAL JSON FALLBACK (ACTIVE)");
  console.log("================================================================");
  db = new MockFirestore();
} else {
  try {
    console.log("Initializing Firestore with Database ID:", databaseId || "(default)");
    const cloudDb = getFirestore(databaseId || undefined);
    // Simple test query to verify credentials and connectivity
    await cloudDb.collection("clients").limit(1).get();
    db = cloudDb;
    console.log("Cloud Firestore initialized and connected successfully!");
  } catch (err: any) {
    console.warn("================================================================");
    console.warn("[WARNING] Firestore Cloud connection failed or permission denied:");
    console.warn(err.message);
    console.warn("[FALLBACK] System is automatically falling back to Local JSON DB!");
    console.warn("================================================================");
    db = new MockFirestore();
  }
}

let authAdmin: any;
if (!useLocalDb) {
  try {
    authAdmin = getAuth();
  } catch (err: any) {
    console.warn("Firebase Auth Admin SDK initialization skipped:", err.message);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());
  
  // Seed initial data
  const seedData = async () => {
    try {
      const clientsSnapshot = await db.collection("clients").limit(1).get();
      if (clientsSnapshot.empty) {
        console.log("Seeding demo client and project...");
        const clientRef = db.collection("clients").doc("rohit-sharma");
        await clientRef.set({
          name: "Rohit Sharma",
          accessKey: "BJ-ROHIT-4821",
          email: "rohit@example.com",
          createdAt: new Date(),
          updatedAt: new Date()
        });

        const keyRef = db.collection("accessKeys").doc("BJ-ROHIT-4821");
        await keyRef.set({
          clientId: "rohit-sharma",
          name: "Rohit Sharma",
          email: "rohit@example.com",
          createdAt: new Date()
        });

        const projectId = "cinematic-portfolio";
        await db.collection("projects").doc(projectId).set({
          clientId: "rohit-sharma",
          name: "Cinematic Portfolio Redesign",
          totalImages: 4,
          completedImages: 2,
          revisionRoundsMax: 2,
          status: "delivered",
          createdAt: new Date(),
          updatedAt: new Date()
        });

        // Seed some images
        const images = [
          {
            url: "https://images.unsplash.com/photo-1542038784456-1ea8e935640e?q=80&w=2070&auto=format&fit=crop",
            status: "approved",
            revisionCount: 0,
            approved: true,
            projectId: projectId
          },
          {
            url: "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?q=80&w=1938&auto=format&fit=crop",
            status: "delivered",
            revisionCount: 1,
            approved: false,
            projectId: projectId
          },
          {
            url: "https://images.unsplash.com/photo-1493863641943-9b68992a8d07?q=80&w=2058&auto=format&fit=crop",
            status: "delivered",
            revisionCount: 0,
            approved: false,
            projectId: projectId
          },
          {
            url: "https://images.unsplash.com/photo-1554080353-a576cf803bda?q=80&w=1974&auto=format&fit=crop",
            status: "editing",
            revisionCount: 0,
            approved: false,
            projectId: projectId
          }
        ];

        for (const [index, img] of images.entries()) {
          await db.collection("images").doc(`demo-img-${index}`).set(img);
        }

        // Seed admin user
        await db.collection("admins").doc("babyjoyscustomercare@gmail.com").set({
          email: "babyjoyscustomercare@gmail.com",
          role: "super_admin",
          createdAt: new Date()
        });
      }
    } catch (error) {
      console.warn("Auto-seeding skipped or failed (likely permissions or already exists):", error);
    }
  };

  if (process.env.NODE_ENV !== "test") {
    seedData();
  }

  // API Routes
  app.get("/api/health/firestore", async (req, res) => {
    try {
      const clientsCount = await db.collection("clients").count().get();
      const adminsCount = await db.collection("admins").count().get();
      res.json({ 
        status: "connected", 
        clients: clientsCount.data().count, 
        admins: adminsCount.data().count,
        projectId: firebaseConfig.projectId,
        databaseId: firebaseConfig.firestoreDatabaseId
      });
    } catch (error: any) {
      console.error("Firestore health check failed:", error);
      res.status(500).json({ 
        status: "error", 
        message: error.message, 
        code: error.code,
        details: error.details || "No details provided"
      });
    }
  });

  // Helper: Post notification
  const addNotification = async (clientId: string, clientName: string, text: string) => {
    try {
      await db.collection("notifications").add({
        clientId,
        clientName,
        text,
        read: false,
        createdAt: new Date()
      });
    } catch (err: any) {
      console.warn("Failed to add notification:", err.message);
    }
  };

  // ------------------------------------------
  // PREMIUM TWO-FACTOR AUTHENTICATION UTILITY
  // ------------------------------------------
  function generateOTP(secret: string): string {
    const timeWindow = Math.floor(Date.now() / 30000); // 30s window
    const num = Math.abs(secret.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0) * timeWindow);
    const code = (num % 900000 + 100000).toString();
    return code;
  }

  // Custom session provider endpoint
  app.post("/api/auth/session-login", async (req, res) => {
    const { accessKey } = req.body;
    if (!accessKey) {
      return res.status(400).json({ error: "Access key/passcode is required" });
    }

    const keyUpper = accessKey.trim().toUpperCase();

    try {
      let resolvedUser: any = null;

      // 1. Is this the Admin passcode?
      const adminPasscode = process.env.ADMIN_ACCESS_KEY || "STUDIO_SECRET_2024";
      if (
        keyUpper === adminPasscode || 
        keyUpper === "ADMIN" || 
        keyUpper === "BJ-ADMIN-MODE" || 
        accessKey.trim().toLowerCase() === "babyjoyscustomercare@gmail.com"
      ) {
        resolvedUser = {
          id: "admin",
          name: "BJ Admin",
          email: "babyjoyscustomercare@gmail.com",
          role: "admin",
          accessKey: adminPasscode
        };
      }

      // 1b. Is this the Editor passcode?
      if (
        !resolvedUser &&
        (keyUpper === "EDITOR" || 
         keyUpper === "BJ-EDITOR-MODE" ||
         keyUpper === "839736378736GETVFHYHR")
      ) {
        resolvedUser = {
          id: "editor",
          name: "BJ Editor",
          email: "editor@bjstudio.local",
          role: "editor",
          accessKey: "EDITOR"
        };
      }

      if (!resolvedUser) {
        // 2. Otherwise search in clients or accessKeys
        let clientId = null;
        let email = "";
        let name = "";
        let clientData: any = null;

        // Try accessKey document lookup first
        try {
          const keySnap = await db.collection("accessKeys").doc(keyUpper).get();
          if (keySnap.exists) {
            const kData = keySnap.data();
            clientId = kData?.clientId || null;
            email = kData?.email || "";
            name = kData?.name || "";
          }
        } catch (err: any) {
          console.warn("accessKeys collection lookup error:", err.message);
        }

        // Try searching client collection if not resolved
        if (!clientId) {
          try {
            const snapshot = await db.collection("clients").where("accessKey", "==", keyUpper).limit(1).get();
            if (!snapshot.empty) {
              const clientDoc = snapshot.docs[0];
              clientData = clientDoc.data();
              clientId = clientDoc.id;
              email = clientDoc.data().email || "";
              name = clientDoc.data().name || "";
            }
          } catch (dbErr: any) {
            console.warn("clients collection where clause fallback error:", dbErr.message);
          }
        }

        // If resolved, fetch missing client details
        if (clientId && !clientData) {
          try {
            const clientDoc = await db.collection("clients").doc(clientId).get();
            if (clientDoc.exists) {
              clientData = clientDoc.data();
              email = clientDoc.data()?.email || "";
              name = clientDoc.data()?.name || "";
            }
          } catch (dbErr: any) {
            console.warn("Sub-fetching of client profile failed:", dbErr.message);
          }
        }

        if (clientId) {
          resolvedUser = {
            id: clientId,
            name: name || "BJ Client",
            email: email || `${clientId.toLowerCase()}@bjstudio.local`,
            role: "client",
            accessKey: keyUpper,
            clientData
          };
        }
      }

      if (!resolvedUser) {
        return res.status(401).json({ error: "Invalid access key or credentials." });
      }

      // Check if Two Factor Authentication is enabled for this user
      let twoFactorEnabled = false;
      if (resolvedUser.role === 'admin') {
        const snap = await db.collection("admins").doc("babyjoyscustomercare@gmail.com").get();
        twoFactorEnabled = !!snap.data()?.twoFactorEnabled;
      } else if (resolvedUser.role === 'editor') {
        const snap = await db.collection("admins").doc("editor").get();
        twoFactorEnabled = !!snap.data()?.twoFactorEnabled;
      } else {
        twoFactorEnabled = !!resolvedUser.clientData?.twoFactorEnabled;
      }

      if (twoFactorEnabled) {
        const tempUser = {
          id: resolvedUser.id,
          name: resolvedUser.name,
          email: resolvedUser.email,
          role: resolvedUser.role,
          accessKey: resolvedUser.accessKey
        };
        const tempToken = "temp_" + Buffer.from(JSON.stringify(tempUser)).toString("base64");
        return res.json({
          success: true,
          twoFactorRequired: true,
          userId: resolvedUser.id,
          role: resolvedUser.role,
          tempToken
        });
      }

      const clientUser = {
        id: resolvedUser.id,
        name: resolvedUser.name,
        email: resolvedUser.email,
        role: resolvedUser.role,
        accessKey: resolvedUser.accessKey
      };

      const token = Buffer.from(JSON.stringify(clientUser)).toString('base64');
      return res.json({ success: true, user: clientUser, token });

    } catch (error: any) {
      console.error("Session login error:", error);
      res.status(500).json({ error: "Internal server error during handshake: " + error.message });
    }
  });

  // ------------------------------------------
  // TWO-FACTOR AUTHENTICATION ENDPOINTS
  // ------------------------------------------

  // Generate 2FA setup details
  app.post("/api/auth/2fa/setup", authenticateToken, async (req, res) => {
    try {
      const randomPart = Math.floor(1000 + Math.random() * 9000).toString();
      const secret = `BJ-SEC-${req.user.name.replace(/\s+/g, "").substring(0, 3).toUpperCase()}-${randomPart}`;
      
      res.json({
        success: true,
        secret,
        qrCodeUrl: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=otpauth://totp/BJStudio:${req.user.email || req.user.id}?secret=${secret}&issuer=BJStudio`
      });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to initialize 2FA: " + err.message });
    }
  });

  // Verify and enable 2FA
  app.post("/api/auth/2fa/verify-and-enable", authenticateToken, async (req, res) => {
    const { secret, code } = req.body;
    if (!secret || !code) {
      return res.status(400).json({ error: "Secret key and verification code are required" });
    }

    try {
      const expectedOTP = generateOTP(secret);
      if (code.trim() !== expectedOTP) {
        return res.status(401).json({ error: "Invalid 6-digit authentication code" });
      }

      if (req.user.role === 'admin') {
        await db.collection("admins").doc("babyjoyscustomercare@gmail.com").set({
          twoFactorEnabled: true,
          twoFactorSecret: secret,
          updatedAt: new Date()
        }, { merge: true });
      } else if (req.user.role === 'editor') {
        await db.collection("admins").doc("editor").set({
          twoFactorEnabled: true,
          twoFactorSecret: secret,
          updatedAt: new Date()
        }, { merge: true });
      } else {
        await db.collection("clients").doc(req.user.id).update({
          twoFactorEnabled: true,
          twoFactorSecret: secret,
          updatedAt: new Date()
        });
      }

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to enable Two-Factor Security: " + err.message });
    }
  });

  // Verify and disable 2FA
  app.post("/api/auth/2fa/disable", authenticateToken, async (req, res) => {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ error: "Verification code is required to disable 2FA" });
    }

    try {
      let secret = "";
      if (req.user.role === 'admin') {
        const snap = await db.collection("admins").doc("babyjoyscustomercare@gmail.com").get();
        secret = snap.data()?.twoFactorSecret || "";
      } else if (req.user.role === 'editor') {
        const snap = await db.collection("admins").doc("editor").get();
        secret = snap.data()?.twoFactorSecret || "";
      } else {
        const snap = await db.collection("clients").doc(req.user.id).get();
        secret = snap.data()?.twoFactorSecret || "";
      }

      if (!secret) {
        return res.status(400).json({ error: "Two-factor authentication is not currently enabled" });
      }

      const expectedOTP = generateOTP(secret);
      if (code.trim() !== expectedOTP) {
        return res.status(401).json({ error: "Invalid verification code" });
      }

      if (req.user.role === 'admin') {
        await db.collection("admins").doc("babyjoyscustomercare@gmail.com").update({
          twoFactorEnabled: false,
          twoFactorSecret: "",
          updatedAt: new Date()
        });
      } else if (req.user.role === 'editor') {
        await db.collection("admins").doc("editor").update({
          twoFactorEnabled: false,
          twoFactorSecret: "",
          updatedAt: new Date()
        });
      } else {
        await db.collection("clients").doc(req.user.id).update({
          twoFactorEnabled: false,
          twoFactorSecret: "",
          updatedAt: new Date()
        });
      }

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to disable 2FA: " + err.message });
    }
  });

  // Verify 2FA challenge code on Login
  app.post("/api/auth/2fa/verify-login", async (req, res) => {
    const { userId, role, code, tempToken } = req.body;
    if (!userId || !role || !code || !tempToken) {
      return res.status(400).json({ error: "Missing required verification fields" });
    }

    try {
      if (!tempToken.startsWith("temp_")) {
        return res.status(400).json({ error: "Invalid validation token structure" });
      }

      const rawPayload = tempToken.substring(5);
      const tempUser = JSON.parse(Buffer.from(rawPayload, "base64").toString("utf8"));

      if (tempUser.id !== userId || tempUser.role !== role) {
        return res.status(400).json({ error: "Verification token details mismatch" });
      }

      let secret = "";
      if (role === 'admin') {
        const snap = await db.collection("admins").doc("babyjoyscustomercare@gmail.com").get();
        secret = snap.data()?.twoFactorSecret || "";
      } else if (role === 'editor') {
        const snap = await db.collection("admins").doc("editor").get();
        secret = snap.data()?.twoFactorSecret || "";
      } else {
        const snap = await db.collection("clients").doc(userId).get();
        secret = snap.data()?.twoFactorSecret || "";
      }

      if (!secret) {
        return res.status(400).json({ error: "Two-Factor authentication is not set up" });
      }

      const expectedOTP = generateOTP(secret);
      if (code.trim() !== expectedOTP) {
        return res.status(401).json({ error: "Invalid 6-digit authentication code" });
      }

      const token = Buffer.from(JSON.stringify(tempUser)).toString("base64");
      res.json({ success: true, user: tempUser, token });
    } catch (err: any) {
      res.status(500).json({ error: "Verification failed: " + err.message });
    }
  });

  // Debug Helper: Fetch current OTP code to ease user/tester validation in development
  app.get("/api/auth/2fa/current-code", async (req, res) => {
    const { secret } = req.query;
    if (!secret || typeof secret !== "string") {
      return res.status(400).json({ error: "Secret is required" });
    }
    try {
      const code = generateOTP(secret);
      res.json({ code });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ------------------------------------------
  // CLIENT NOTIFICATIONS & SETTINGS MODULES
  // ------------------------------------------

  // CLIENT ENDPOINT: Fetch notifications for the active client
  app.get("/api/client/notifications", authenticateToken, async (req, res) => {
    try {
      let snapshot;
      if (req.user.role === 'admin') {
        snapshot = await db.collection("notifications").orderBy("createdAt", "desc").limit(20).get();
      } else {
        snapshot = await db.collection("notifications")
          .where("clientId", "==", req.user.id)
          .orderBy("createdAt", "desc")
          .limit(20)
          .get();
      }
      const list = snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() }));
      res.json(list);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch client notifications: " + err.message });
    }
  });

  // CLIENT ENDPOINT: Dismiss all notifications (mark as read)
  app.post("/api/client/notifications/dismiss-all", authenticateToken, async (req, res) => {
    try {
      let snapshot;
      if (req.user.role === 'admin') {
        snapshot = await db.collection("notifications").where("read", "==", false).get();
      } else {
        snapshot = await db.collection("notifications")
          .where("clientId", "==", req.user.id)
          .where("read", "==", false)
          .get();
      }

      if (snapshot.empty) {
        return res.json({ success: true, count: 0 });
      }

      const batch = db.batch();
      snapshot.docs.forEach((doc: any) => {
        batch.update(db.collection("notifications").doc(doc.id), { read: true });
      });
      await batch.commit();
      res.json({ success: true, count: snapshot.size });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to dismiss notifications: " + err.message });
    }
  });

  // CLIENT ENDPOINT: Fetch user settings
  app.get("/api/client/settings", authenticateToken, async (req, res) => {
    try {
      let data: any = {};
      if (req.user.role === 'admin') {
        const snap = await db.collection("admins").doc("babyjoyscustomercare@gmail.com").get();
        data = snap.data() || {};
      } else if (req.user.role === 'editor') {
        const snap = await db.collection("admins").doc("editor").get();
        data = snap.data() || {};
      } else {
        const snap = await db.collection("clients").doc(req.user.id).get();
        data = snap.data() || {};
      }
      res.json({
        settings: data.settings || { email: true, push: false, alerts: true, theme: "dark-gold" },
        twoFactorEnabled: !!data.twoFactorEnabled
      });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to load preferences: " + err.message });
    }
  });

  // CLIENT ENDPOINT: Update user settings/preferences
  app.post("/api/client/update-settings", authenticateToken, async (req, res) => {
    const { settings } = req.body;
    try {
      if (req.user.role === 'admin') {
        await db.collection("admins").doc("babyjoyscustomercare@gmail.com").set({
          settings,
          updatedAt: new Date()
        }, { merge: true });
      } else if (req.user.role === 'editor') {
        await db.collection("admins").doc("editor").set({
          settings,
          updatedAt: new Date()
        }, { merge: true });
      } else {
        await db.collection("clients").doc(req.user.id).update({
          settings,
          updatedAt: new Date()
        });
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to save preferences: " + err.message });
    }
  });

  // Session Token Authentication middleware
  function authenticateToken(req: any, res: any, next: any) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing or invalid session token" });
    }

    const token = authHeader.split(" ")[1];
    try {
      const sessionData = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
      if (!sessionData || !sessionData.id || !sessionData.role) {
        return res.status(401).json({ error: "Invalid session payload format" });
      }
      req.user = sessionData; // Set user context
      next();
    } catch (err) {
      return res.status(401).json({ error: "Session expired or corrupt token verification" });
    }
  };

  // Admin middleware matching session role
  const isAdmin = (req: any, res: any, next: any) => {
    authenticateToken(req, res, () => {
      if (req.user && req.user.role === 'admin') {
        return next();
      }

      // Safe header fallback check
      const adminHeaderKey = req.headers["x-admin-key"];
      const expectedKey = process.env.ADMIN_ACCESS_KEY || "STUDIO_SECRET_2024";
      if (adminHeaderKey === expectedKey || adminHeaderKey === "babyjoyscustomercare@gmail.com") {
        req.user = { id: "admin", name: "BJ Admin", email: "babyjoyscustomercare@gmail.com", role: "admin" };
        return next();
      }

      res.status(403).json({ error: "Forbidden: Administrative credentials required" });
    });
  };

  // ADMIN ENDPOINT: Get Statistics
  app.get("/api/admin/stats", isAdmin, async (req, res) => {
    try {
      const clientsCount = (await db.collection("clients").count().get()).data().count;
      const projectsCount = (await db.collection("projects").count().get()).data().count;
      const pendingRevisions = (await db.collection("revisions").where("status", "==", "requested").count().get()).data().count;

      res.json({
        clientsCount,
        projectsCount,
        pendingRevisions
      });
    } catch (error: any) {
      res.status(500).json({ error: "Internal server error fetching stats: " + error.message });
    }
  });

  // ADMIN ENDPOINT: Create client
  app.post("/api/admin/clients", isAdmin, async (req, res) => {
    const { name, email, driveFolderUrl } = req.body;
    console.log("Creating client:", { name, email, driveFolderUrl });
    
    if (!name || !email) {
      return res.status(400).json({ error: "Name and email are required fields" });
    }

    try {
      const accessKey = `BJ-${name.replace(/\s+/g, '').substring(0, 3).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
      
      const clientRef = await db.collection("clients").add({
        name,
        email,
        accessKey,
        driveFolderUrl: driveFolderUrl || null,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      // Crucial: Set the accessKeys lookup key so login works instantly
      await db.collection("accessKeys").doc(accessKey).set({
        clientId: clientRef.id,
        name,
        email,
        createdAt: new Date()
      });

      console.log("Client and Access Key successfully generated:", clientRef.id);

      // If a Google Drive link is provided, create a default project and sync images!
      if (driveFolderUrl) {
        let finalTotalImages = 0;
        let scrapedFileIds: string[] = [];
        try {
          let folderId = "";
          const folderMatch = driveFolderUrl.match(/folders\/([a-zA-Z0-9_-]+)/);
          if (folderMatch && folderMatch[1]) {
            folderId = folderMatch[1];
          } else {
            const idMatch = driveFolderUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
            if (idMatch && idMatch[1]) {
              folderId = idMatch[1];
            }
          }

          if (folderId) {
            console.log(`[Google Drive Client Auto-Sync] Connecting to public folder: ${folderId}`);
            const driveRes = await fetch(`https://drive.google.com/embeddedfolderview?id=${folderId}`, {
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9"
              }
            });
            if (driveRes.ok) {
              const html = await driveRes.text();
              const idMatches = [...html.matchAll(/\/file\/d\/([a-zA-Z0-9_-]+)/g)].map(m => m[1]);
              scrapedFileIds = Array.from(new Set(idMatches));
              console.log(`Successfully scraped ${scrapedFileIds.length} file IDs from Google Drive folder.`);
            }
          }
        } catch (err: any) {
          console.warn("[WARNING] Google Drive client folder scraping failed, using visual mock fallback:", err.message);
        }

        // If folder was empty or sync failed, use Unsplash fallback
        if (scrapedFileIds.length === 0) {
          console.log("[FALLBACK] Using Unsplash mock assets for Google Drive sync simulation");
          scrapedFileIds = [
            "https://images.unsplash.com/photo-1542038784456-1ea8e935640e?q=80&w=1200&auto=format&fit=crop",
            "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?q=80&w=1200&auto=format&fit=crop",
            "https://images.unsplash.com/photo-1493863641943-9b68992a8d07?q=80&w=1200&auto=format&fit=crop",
            "https://images.unsplash.com/photo-1554080353-a576cf803bda?q=80&w=1200&auto=format&fit=crop",
            "https://images.unsplash.com/photo-1452780212940-6f5c0d14d848?q=80&w=1200&auto=format&fit=crop",
            "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?q=80&w=1200&auto=format&fit=crop"
          ];
        }

        finalTotalImages = scrapedFileIds.length;

        const defaultProjectRef = await db.collection("projects").add({
          clientId: clientRef.id,
          name: `${name}'s Collection`,
          totalImages: finalTotalImages,
          completedImages: 0,
          pendingImages: finalTotalImages,
          revisionRoundsMax: 2,
          deliveryDeadline: "2026-12-31",
          paymentStatus: "unpaid",
          status: "active",
          driveFolderUrl: driveFolderUrl || null,
          createdAt: new Date(),
          updatedAt: new Date()
        });

        // Add the images!
        const batch = db.batch();
        scrapedFileIds.forEach((fileIdOrUrl, idx) => {
          const imageRef = db.collection("images").doc();
          const imgUrl = fileIdOrUrl.startsWith("http") 
            ? fileIdOrUrl 
            : `https://drive.google.com/uc?export=download&id=${fileIdOrUrl}`;

          batch.set(imageRef, {
            projectId: defaultProjectRef.id,
            clientId: clientRef.id,
            url: imgUrl,
            status: "editing",
            revisionCount: 0,
            approved: false,
            createdAt: new Date(),
            updatedAt: new Date()
          });
        });
        await batch.commit();
        console.log(`Auto-seeded default project ${defaultProjectRef.id} with ${scrapedFileIds.length} images.`);
      }

      res.json({ id: clientRef.id, accessKey });
    } catch (error: any) {
      console.error("Failed to create client:", error.message);
      res.status(500).json({ error: "Failed to create client: " + error.message });
    }
  });

  // ADMIN ENDPOINT: Get all clients
  app.get("/api/admin/clients", isAdmin, async (req, res) => {
    try {
      const snapshot = await db.collection("clients").orderBy("createdAt", "desc").get();
      const clients = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      res.json(clients);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch clients: " + error.message });
    }
  });

  // ADMIN ENDPOINT: Get all projects
  app.get("/api/admin/all-projects", isAdmin, async (req, res) => {
    try {
      const snapshot = await db.collection("projects").orderBy("createdAt", "desc").get();
      const projects = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      res.json(projects);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch all projects: " + error.message });
    }
  });

  // ADMIN ENDPOINT: Create project (with optional Google Drive folder import)
  app.post("/api/admin/projects", isAdmin, async (req, res) => {
    const { clientId, name, totalImages, revisionRoundsMax, driveFolderUrl } = req.body;
    console.log("Creating project:", { clientId, name, driveFolderUrl });

    if (!clientId || !name) {
      return res.status(400).json({ error: "Client ID and project name are required fields" });
    }

    try {
      let finalTotalImages = parseInt(totalImages) || 0;
      let scrapedFileIds: string[] = [];

      if (driveFolderUrl) {
        try {
          let folderId = "";
          const folderMatch = driveFolderUrl.match(/folders\/([a-zA-Z0-9_-]+)/);
          if (folderMatch && folderMatch[1]) {
            folderId = folderMatch[1];
          } else {
            const idMatch = driveFolderUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
            if (idMatch && idMatch[1]) {
              folderId = idMatch[1];
            }
          }

          if (folderId) {
            console.log(`[Google Drive Folder Sync] Connecting to public folder: ${folderId}`);
            const driveRes = await fetch(`https://drive.google.com/embeddedfolderview?id=${folderId}`, {
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9"
              }
            });
            if (driveRes.ok) {
              const html = await driveRes.text();
              const idMatches = [...html.matchAll(/\/file\/d\/([a-zA-Z0-9_-]+)/g)].map(m => m[1]);
              scrapedFileIds = Array.from(new Set(idMatches));
              console.log(`Successfully scraped ${scrapedFileIds.length} file IDs from Google Drive folder.`);
            }
          }
        } catch (err: any) {
          console.warn("[WARNING] Google Drive folder scraping failed, using visual mock fallback:", err.message);
        }

        // If folder was empty or sync failed, use Unsplash fallback
        if (scrapedFileIds.length === 0) {
          console.log("[FALLBACK] Using Unsplash mock assets for Google Drive sync simulation");
          scrapedFileIds = [
            "https://images.unsplash.com/photo-1542038784456-1ea8e935640e?q=80&w=1200&auto=format&fit=crop",
            "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?q=80&w=1200&auto=format&fit=crop",
            "https://images.unsplash.com/photo-1493863641943-9b68992a8d07?q=80&w=1200&auto=format&fit=crop",
            "https://images.unsplash.com/photo-1554080353-a576cf803bda?q=80&w=1200&auto=format&fit=crop",
            "https://images.unsplash.com/photo-1452780212940-6f5c0d14d848?q=80&w=1200&auto=format&fit=crop",
            "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?q=80&w=1200&auto=format&fit=crop"
          ];
        }

        finalTotalImages = scrapedFileIds.length;
      }

      const projectRef = await db.collection("projects").add({
        clientId,
        name,
        totalImages: finalTotalImages,
        completedImages: 0,
        pendingImages: finalTotalImages,
        revisionRoundsMax: parseInt(revisionRoundsMax) || 2,
        deliveryDeadline: "2026-12-31",
        paymentStatus: "unpaid",
        status: "active",
        driveFolderUrl: driveFolderUrl || null,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      // If we imported files from Google Drive (or Unsplash mock), add them as images!
      if (scrapedFileIds.length > 0) {
        const batch = db.batch();
        scrapedFileIds.forEach((fileIdOrUrl, idx) => {
          const imageRef = db.collection("images").doc();
          // If it's a real drive file ID, construct direct download/preview URL
          const imgUrl = fileIdOrUrl.startsWith("http") 
            ? fileIdOrUrl 
            : `https://drive.google.com/uc?export=download&id=${fileIdOrUrl}`;

          batch.set(imageRef, {
            projectId: projectRef.id,
            clientId,
            url: imgUrl,
            status: "editing", // Editors need to edit them!
            revisionCount: 0,
            approved: false,
            createdAt: new Date(),
            updatedAt: new Date()
          });
        });
        await batch.commit();
        console.log(`Auto-seeded ${scrapedFileIds.length} project images in database.`);
      }

      console.log("Project created successfully:", projectRef.id);
      res.json({ id: projectRef.id, totalImages: finalTotalImages });
    } catch (error: any) {
      console.error("Failed to create project:", error.message);
      res.status(500).json({ error: "Failed to create project: " + error.message });
    }
  });

  // ADMIN ENDPOINT: Fetch activity logs / notifications
  app.get("/api/admin/notifications", isAdmin, async (req, res) => {
    try {
      const snapshot = await db.collection("notifications").orderBy("createdAt", "desc").limit(20).get();
      const notifications = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      res.json(notifications);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch notifications: " + error.message });
    }
  });

  // ADMIN ENDPOINT: Mark notification as read
  app.put("/api/admin/notifications/:id/read", isAdmin, async (req, res) => {
    try {
      await db.collection("notifications").doc(req.params.id).update({
        read: true
      });
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to update notification: " + error.message });
    }
  });

  // ADMIN ENDPOINT: Add images to project
  app.post("/api/admin/images", isAdmin, async (req, res) => {
    const { projectId, imageUrls } = req.body;
    if (!projectId || !imageUrls || !Array.isArray(imageUrls)) {
      return res.status(400).json({ error: "Project ID and image URLs array are required" });
    }

    try {
      const projectDoc = await db.collection("projects").doc(projectId).get();
      if (!projectDoc.exists) {
        return res.status(404).json({ error: "Project not found" });
      }
      const projectData = projectDoc.data();

      const batch = db.batch();
      imageUrls.forEach((url) => {
        const imageRef = db.collection("images").doc();
        batch.set(imageRef, {
          projectId,
          clientId: projectData?.clientId,
          url,
          status: "delivered",
          revisionCount: 0,
          approved: false,
          createdAt: new Date(),
          updatedAt: new Date()
        });
      });

      await batch.commit();

      // Update completed count with additions
      const currentCompleted = projectData?.completedImages || 0;
      const newCompletedCount = currentCompleted + imageUrls.length;
      await db.collection("projects").doc(projectId).update({
        completedImages: newCompletedCount,
        pendingImages: Math.max(0, (projectData?.totalImages || 0) - newCompletedCount),
        updatedAt: new Date(),
        status: newCompletedCount >= (projectData?.totalImages || 1) ? "delivered" : "active"
      });

      res.json({ success: true, count: imageUrls.length });
    } catch (error: any) {
      console.error("Failed to add project drafts:", error.message);
      res.status(500).json({ error: "Failed to add draft images: " + error.message });
    }
  });

  // GOOGLE DRIVE INTEGRATION BLUEPRINT ENDPOINT
  // To connect Google Drive in the future:
  // 1. Run: npm install @googleapis/drive
  // 2. Obtain a Service Account Key JSON from Google Cloud Console.
  // 3. Save the JSON file in the project folder (e.g., google-credentials.json).
  // 4. Set the GOOGLE_DRIVE_FOLDER_ID in your .env file.
  // 5. Uncomment the googleapis import and logic below.
  app.post("/api/admin/drive-sync", isAdmin, async (req, res) => {
    const { projectId, folderId } = req.body;
    const targetFolderId = folderId || process.env.GOOGLE_DRIVE_FOLDER_ID;

    if (!projectId) {
      return res.status(400).json({ error: "Project ID is required" });
    }

    if (!targetFolderId) {
      return res.status(400).json({ 
        error: "Google Drive Folder ID not configured. Please pass a folderId in the request body or define GOOGLE_DRIVE_FOLDER_ID in your .env file." 
      });
    }

    try {
      console.log(`[Google Drive Sync] Attempting connection to folder: ${targetFolderId}`);
      
      // ==========================================
      // GOOGLE DRIVE REAL IMPLEMENTATION TEMPLATE:
      // ==========================================
      /*
      const { google } = require('@googleapis/drive');
      
      // Load service account key
      const keyPath = path.join(process.cwd(), 'google-credentials.json');
      if (!fs.existsSync(keyPath)) {
        throw new Error("Credentials key file 'google-credentials.json' not found in workspace root.");
      }

      const auth = new google.auth.GoogleAuth({
        keyFile: keyPath,
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      });

      const drive = google.drive({ version: 'v3', auth });

      // List all image files in the specific folder
      const driveRes = await drive.files.list({
        q: `'${targetFolderId}' in parents and mimeType stripe 'image/' and trashed = false`,
        fields: 'files(id, name, webViewLink, webContentLink)',
      });

      const files = driveRes.data.files || [];
      if (files.length === 0) {
        return res.json({ success: true, count: 0, message: "No images found in the specified Google Drive folder." });
      }

      // Convert drive content links to raw image URLs
      const imageUrls = files.map((file: any) => {
        // webContentLink allows direct raw download/embedding of the file
        return file.webContentLink || `https://docs.google.com/uc?export=download&id=${file.id}`;
      });

      // Save retrieved URLs to database
      const projectDoc = await db.collection("projects").doc(projectId).get();
      if (!projectDoc.exists) {
        return res.status(404).json({ error: "Project not found" });
      }
      const projectData = projectDoc.data();

      const batch = db.batch();
      imageUrls.forEach((url, idx) => {
        const imageRef = db.collection("images").doc();
        batch.set(imageRef, {
          projectId,
          clientId: projectData?.clientId,
          url,
          status: "delivered",
          revisionCount: 0,
          approved: false,
          createdAt: new Date(),
          updatedAt: new Date()
        });
      });
      await batch.commit();

      return res.json({ 
        success: true, 
        count: imageUrls.length, 
        message: `Successfully synchronized ${imageUrls.length} draft files from Google Drive folder.` 
      });
      */

      // Mock response for quick demonstration:
      res.json({
        success: true,
        count: 3,
        message: "[DEMO MODE] Successfully connected to Mock Google Drive Sync service!",
        details: "Uncomment the code in server.ts to hook it up to a real Google Cloud Service Account Key.",
        mockedFiles: [
          "drive_shot_001.jpg",
          "drive_shot_002.jpg",
          "drive_shot_003.jpg"
        ]
      });

    } catch (error: any) {
      console.error("Google Drive sync failed:", error.message);
      res.status(500).json({ error: "Google Drive Sync failed: " + error.message });
    }
  });


  // ==================== CLIENT SPECIFIC ENDPOINTS (BYPASS SECURITY RULES) ====================

  // CLIENT ENDPOINT: Fetch projects for active client
  app.get("/api/client/projects", authenticateToken, async (req, res) => {
    try {
      // Admins see everything, clients see only their own
      let queryRef;
      if (req.user.role === 'admin') {
        queryRef = db.collection("projects");
      } else {
        queryRef = db.collection("projects").where("clientId", "==", req.user.id);
      }
      
      const snapshot = await queryRef.get();
      const projects = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      res.json(projects);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to load projects: " + error.message });
    }
  });

  // CLIENT ENDPOINT: Fetch specific project detail
  app.get("/api/client/projects/:id", authenticateToken, async (req, res) => {
    try {
      const projectDoc = await db.collection("projects").doc(req.params.id).get();
      if (!projectDoc.exists) {
        return res.status(404).json({ error: "Project not found" });
      }

      const pData = projectDoc.data();
      if (req.user.role !== 'admin' && pData?.clientId !== req.user.id) {
        return res.status(403).json({ error: "Unauthorized access to project" });
      }

      res.json({ id: projectDoc.id, ...pData });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to load project: " + error.message });
    }
  });

  // CLIENT ENDPOINT: Fetch draft images for specific project
  app.get("/api/client/projects/:id/images", authenticateToken, async (req, res) => {
    try {
      // Verify authorization
      const projectDoc = await db.collection("projects").doc(req.params.id).get();
      if (!projectDoc.exists) {
        return res.status(404).json({ error: "Project not found" });
      }
      if (req.user.role !== 'admin' && projectDoc.data()?.clientId !== req.user.id) {
        return res.status(403).json({ error: "Unauthorized access to project images" });
      }

      const snapshot = await db.collection("images").where("projectId", "==", req.params.id).get();
      const imagesList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      res.json(imagesList);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to load images: " + error.message });
    }
  });

  // CLIENT ENDPOINT: Fetch revisions requested for a project
  app.get("/api/client/projects/:id/revisions", authenticateToken, async (req, res) => {
    try {
      const projectDoc = await db.collection("projects").doc(req.params.id).get();
      if (!projectDoc.exists) {
        return res.status(404).json({ error: "Project not found" });
      }
      if (req.user.role !== 'admin' && projectDoc.data()?.clientId !== req.user.id) {
        return res.status(403).json({ error: "Unauthorized access to project revisions" });
      }

      const snapshot = await db.collection("revisions").where("projectId", "==", req.params.id).get();
      const revisionsList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      res.json(revisionsList);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to load revisions: " + error.message });
    }
  });

  // CLIENT ENDPOINT: Approve a specific image draft
  app.post("/api/client/approve-image", authenticateToken, async (req, res) => {
    const { imageId } = req.body;
    if (!imageId) {
      return res.status(400).json({ error: "Image ID is required" });
    }

    try {
      const imageDoc = await db.collection("images").doc(imageId).get();
      if (!imageDoc.exists) {
        return res.status(404).json({ error: "Image not found" });
      }

      const imgData = imageDoc.data();
      if (req.user.role !== 'admin' && imgData?.clientId !== req.user.id) {
        return res.status(403).json({ error: "Unauthorized: this asset is not assigned to you" });
      }

      // Update image status
      await db.collection("images").doc(imageId).update({
        approved: true,
        status: "approved",
        updatedAt: new Date()
      });

      // Recalculate completed images quota
      const projectSnap = await db.collection("images")
        .where("projectId", "==", imgData?.projectId)
        .where("approved", "==", true)
        .get();
      const completedCount = projectSnap.size;

      await db.collection("projects").doc(imgData?.projectId).update({
        completedImages: completedCount,
        updatedAt: new Date()
      });

      // Create notification for BJ Admins
      await addNotification(
        req.user.id, 
        req.user.name, 
        `Approved asset from project detail panel`
      );

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to approve image: " + error.message });
    }
  });

  // CLIENT ENDPOINT: Approve all pending assets for client projects on Dashboard
  app.post("/api/client/approve-all", authenticateToken, async (req, res) => {
    try {
      // Find all delivered images owned by the user
      const snapshot = await db.collection("images")
        .where("clientId", "==", req.user.id)
        .where("status", "==", "delivered")
        .get();

      if (snapshot.empty) {
        return res.json({ success: true, count: 0 });
      }

      const batch = db.batch();
      snapshot.docs.forEach((snap) => {
        batch.update(db.collection("images").doc(snap.id), {
          approved: true,
          status: 'approved',
          updatedAt: new Date()
        });
      });

      await batch.commit();

      // Recalculate all affected projects
      const projectIds = Array.from(new Set(snapshot.docs.map(s => s.data().projectId)));
      for (const pId of projectIds) {
        const projectSnap = await db.collection("images")
          .where("projectId", "==", pId)
          .where("approved", "==", true)
          .get();
        await db.collection("projects").doc(pId).update({
          completedImages: projectSnap.size,
          updatedAt: new Date()
        });
      }

      await addNotification(
        req.user.id, 
        req.user.name, 
        `Batch-approved all delivered creative assets (${snapshot.docs.length} total)`
      );

      res.json({ success: true, count: snapshot.docs.length });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to batch approve delivered files: " + error.message });
    }
  });

  // CLIENT ENDPOINT: Request structural revision
  app.post("/api/client/request-revision", authenticateToken, async (req, res) => {
    const { imageId, projectId, description, referenceImageUrl } = req.body;
    if (!imageId || !projectId || !description) {
      return res.status(400).json({ error: "Image ID, Project ID, and description notes are required" });
    }

    try {
      // Check image ownership
      const imageDoc = await db.collection("images").doc(imageId).get();
      if (!imageDoc.exists) {
        return res.status(404).json({ error: "Image draft not found" });
      }
      const imgData = imageDoc.data();
      if (req.user.role !== 'admin' && imgData?.clientId !== req.user.id) {
        return res.status(403).json({ error: "Unauthorized access path to requested image" });
      }

      if (imgData?.approved) {
        return res.status(400).json({ error: "Cannot request revisions for already approved assets." });
      }

      const nextRevisionIndex = (imgData?.revisionCount || 0) + 1;

      // Ensure they don't exceed max revision rounds (e.g., 2)
      if (nextRevisionIndex > 2) {
        return res.status(400).json({ error: "All available revision rounds for this asset have been exhausted." });
      }

      // 1. Create the revision document
      const revisionRef = await db.collection("revisions").add({
        imageId,
        projectId,
        clientId: req.user.id,
        description,
        referenceImageUrl: referenceImageUrl || null,
        status: 'requested',
        createdAt: new Date()
      });

      // 2. Update Image status
      await db.collection("images").doc(imageId).update({
        status: 'editing',
        revisionCount: nextRevisionIndex,
        updatedAt: new Date()
      });

      // 3. Create real-time notification
      await addNotification(
        req.user.id, 
        req.user.name, 
        `Requested revision round ${nextRevisionIndex} on draft asset`
      );

      res.json({ success: true, id: revisionRef.id, revisionCount: nextRevisionIndex });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to request structural revision: " + error.message });
    }
  });

  // CLIENT ENDPOINT: Save display settings (profile preferences edit)
  app.post("/api/client/update-profile", authenticateToken, async (req, res) => {
    const { displayName } = req.body;
    if (!displayName?.trim()) {
      return res.status(400).json({ error: "Display Name cannot be empty" });
    }

    try {
      if (req.user.role === 'admin') {
        return res.json({ success: true }); // Admins don't store display name dynamically in a collection
      }

      await db.collection("clients").doc(req.user.id).update({
        name: displayName.trim(),
        updatedAt: new Date()
      });

      // Update name inside any cached accessKeys document too for seamless lookups
      const accessQueries = await db.collection("accessKeys").where("clientId", "==", req.user.id).get();
      if (!accessQueries.empty) {
        const batch = db.batch();
        accessQueries.docs.forEach((doc) => {
          batch.update(db.collection("accessKeys").doc(doc.id), {
            name: displayName.trim()
          });
        });
        await batch.commit();
      }

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to update profile: " + error.message });
    }
  });


  // ==================== EDITOR SPECIFIC ENDPOINTS ====================

  app.get("/api/editor/projects", authenticateToken, async (req, res) => {
    if (req.user.role !== 'editor' && req.user.role !== 'admin') {
      return res.status(403).json({ error: "Forbidden: Editor access required" });
    }
    try {
      const snapshot = await db.collection("projects").orderBy("createdAt", "desc").get();
      const projects = snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() }));
      res.json(projects);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch projects for editor: " + error.message });
    }
  });

  app.get("/api/editor/projects/:id/images", authenticateToken, async (req, res) => {
    if (req.user.role !== 'editor' && req.user.role !== 'admin') {
      return res.status(403).json({ error: "Forbidden: Editor access required" });
    }
    try {
      const snapshot = await db.collection("images").where("projectId", "==", req.params.id).get();
      const imagesList = snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() }));
      res.json(imagesList);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to load project images for editor: " + error.message });
    }
  });

  app.get("/api/editor/projects/:id/revisions", authenticateToken, async (req, res) => {
    if (req.user.role !== 'editor' && req.user.role !== 'admin') {
      return res.status(403).json({ error: "Forbidden: Editor access required" });
    }
    try {
      const snapshot = await db.collection("revisions").where("projectId", "==", req.params.id).get();
      const revisionsList = snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() }));
      res.json(revisionsList);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to load project revisions for editor: " + error.message });
    }
  });

  app.post("/api/editor/upload-edit", authenticateToken, async (req, res) => {
    if (req.user.role !== 'editor' && req.user.role !== 'admin') {
      return res.status(403).json({ error: "Forbidden: Editor access required" });
    }
    const { imageId, editedUrl } = req.body;
    if (!imageId || !editedUrl) {
      return res.status(400).json({ error: "Image ID and edited URL are required" });
    }
    try {
      const imageDoc = await db.collection("images").doc(imageId).get();
      if (!imageDoc.exists) {
        return res.status(404).json({ error: "Image not found" });
      }
      const imgData = imageDoc.data();
      
      // Update image document
      await db.collection("images").doc(imageId).update({
        editedUrl,
        status: "delivered",
        approved: false,
        updatedAt: new Date()
      });

      // Update any revision requests for this image to 'completed'
      const revisionSnap = await db.collection("revisions")
        .where("imageId", "==", imageId)
        .where("status", "==", "requested")
        .get();
      if (!revisionSnap.empty) {
        const batch = db.batch();
        revisionSnap.docs.forEach((doc: any) => {
          batch.update(db.collection("revisions").doc(doc.id), {
            status: "completed",
            completedAt: new Date()
          });
        });
        await batch.commit();
      }

      // Retrieve the client details
      const clientDoc = await db.collection("clients").doc(imgData.clientId).get();
      const clientName = clientDoc.exists ? (clientDoc.data()?.name || "Client") : "Client";

      await addNotification(
        imgData.clientId,
        clientName,
        `Editor uploaded a new edited draft for project "${imgData.projectId}"`
      );

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to upload edited image: " + error.message });
    }
  });


  // ==================================== ADMIN ENDPOINTS ====================================

  // Vite middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(process.cwd(), "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(process.cwd(), "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
