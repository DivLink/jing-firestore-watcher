const admin = require("firebase-admin");
const http  = require("http");

// ── Firebase init ──────────────────────────────────────────
const serviceAccount = {
  type:         "service_account",
  project_id:   process.env.FIREBASE_PROJECT_ID,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  private_key:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ── Collections to watch ───────────────────────────────────
const WATCHED = {
  users:    ["points","role","isAdmin","email","phone","status","isBanned","disabled"],
  products: ["price","stock","isAvailable","category","commission"],
  promos:   ["isActive","discountValue","discountType","code","expiresAt"],
};

// ── Helpers ────────────────────────────────────────────────
function getSeverity(changedFields) {
  if (changedFields.some(f => ["points","role","isAdmin","isBanned","discountValue"].includes(f)))
    return "critical";
  if (changedFields.some(f => ["price","disabled","email","phone"].includes(f)))
    return "high";
  return "medium";
}

function getChangedFields(before = {}, after = {}) {
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [];
  for (const key of allKeys) {
    if (["updatedAt","createdAt","timestamp","resolvedAt"].includes(key)) continue;
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null))
      changed.push(key);
  }
  return changed;
}

  const pendingSaves = new Set();

  async function saveAlert({ type, severity, description, col, docId, changedFields, oldData, newData }) {
    try {
      // Dedup — skip if same alert fired in last 10 seconds
      const dedupKey = `${col}:${docId}:${(changedFields ?? []).sort().join(",")}`;
      if (pendingSaves.has(dedupKey)) {
        console.log(`[DEDUP] Skipped duplicate: ${dedupKey}`);
        return;
      }
      pendingSaves.add(dedupKey);
      setTimeout(() => pendingSaves.delete(dedupKey), 10_000);

      await db.collection("systemAlerts").add({
      type,
      severity,
      description,
      collection:    col,
      docId,
      changedFields: changedFields ?? [],
      oldValue:      oldData ?? null,
      newValue:      newData ?? null,
      delta:         (newData?.points != null && oldData?.points != null)
                       ? newData.points - oldData.points : null,
      uid:           newData?.uid ?? newData?.customerId ?? docId ?? null,
      email:         newData?.email ?? oldData?.email ?? null,
      source:        "manual",
      resolved:      false,
      emailSent:     false,
      timestamp:     admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`[ALERT SAVED] ${col}/${docId} — ${changedFields.join(", ")}`);
  } catch (err) {
    console.error("[saveAlert error]", err.message);
  }
}

// ── Watch one collection ───────────────────────────────────
function watchCollection(colName, criticalFields) {
  const baseline = {};
  let firstLoad  = true;

  console.log(`👁 Watching: ${colName}`);

  db.collection(colName).onSnapshot(
    async (snapshot) => {
      if (firstLoad) {
        snapshot.docs.forEach(d => { baseline[d.id] = d.data(); });
        firstLoad = false;
        console.log(`✅ Baseline built: ${colName} (${snapshot.docs.length} docs)`);
        return;
      }

      for (const change of snapshot.docChanges()) {
        const docId   = change.doc.id;
        const newData = change.doc.data();
        const oldData = baseline[docId] ?? null;

        if (change.type === "removed") {
          delete baseline[docId];
        } else {
          baseline[docId] = newData;
        }

        if (change.type === "removed") {
          await saveAlert({
            type: "DOCUMENT_DELETED", severity: "critical",
            description: `🗑️ Document DELETED from [${colName}] — ID: ${docId}`,
            col: colName, docId,
            changedFields: ["__deleted__"],
            oldData, newData: null,
          });
          continue;
        }

        if (change.type === "modified" && oldData) {
          const allChanged      = getChangedFields(oldData, newData);
          const criticalChanged = allChanged.filter(f => criticalFields.includes(f));
          if (!criticalChanged.length) continue;

          const severity = getSeverity(criticalChanged);
          const oldSnap  = {};
          const newSnap  = {};
          criticalChanged.forEach(f => {
            oldSnap[f] = oldData[f] ?? null;
            newSnap[f] = newData[f] ?? null;
          });

          const description = criticalChanged.map(f =>
            `${f}: ${JSON.stringify(oldSnap[f])} → ${JSON.stringify(newSnap[f])}`
          ).join(" | ");

          await saveAlert({
            type: "MANUAL_TAMPER", severity,
            description: `⚠ [${colName}] ${description}`,
            col: colName, docId,
            changedFields: criticalChanged,
            oldData: oldSnap, newData: newSnap,
          });
        }
      }
    },
    (err) => console.error(`[${colName} watcher error]`, err.message)
  );
}

// ── HTTP server (required by Render) ──────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("JING Watcher is running 24/7");
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Watcher server running on port ${process.env.PORT || 3000}`);
});

// ── Self-ping every 15 min to save Render free-tier hours ─
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(async () => {
    try {
      const res = await fetch(RENDER_URL);
      console.log(`🔄 Self-ping OK (${res.status})`);
    } catch (err) {
      console.warn("Self-ping failed:", err.message);
    }
  }, 15 * 60 * 1000); // 15 minutes
} else {
  console.log("⚠ RENDER_EXTERNAL_URL not set — self-ping disabled");
}

// ── Start watching ─────────────────────────────────────────
console.log("🔥 JING Firestore Watcher starting...");
Object.entries(WATCHED).forEach(([colName, fields]) => {
  watchCollection(colName, fields);
});
console.log("✅ All watchers active — running 24/7 on Render");