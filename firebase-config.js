/**
 * Lab Equipment Tracker — Firebase configuration and Realtime Database service
 *
 * This app deliberately reuses the existing Firebase project so every account
 * already created in Firebase Authentication can sign in here with the same
 * email address and password.
 *
 * Existing Firebase project:
 *   Project ID: engineering-861d3
 *   Realtime Database: engineering-861d3-default-rtdb
 *
 * Dedicated data tree used only by this website:
 *   labEquipmentTracker/
 *     equipment/{itemId}
 *     serials/{itemId}/{serialId}
 *     activityLogs/{logId}
 *
 * The existing alerts/ tree is not read, changed, or deleted by this app.
 *
 * SECURITY RULES
 * Merge the following branch into your EXISTING Realtime Database rules.
 * Do not remove the current alerts rules when adding it.
 *
 * "labEquipmentTracker": {
 *   ".read": "auth != null",
 *   ".write": "auth != null",
 *   "activityLogs": {
 *     ".indexOn": ["occurredAt"]
 *   }
 * }
 *
 * Firebase Web configuration values are public project identifiers. Never put
 * a service-account private key or Admin SDK credentials in this browser file.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  get,
  getDatabase,
  increment,
  limitToLast,
  onValue,
  orderByChild,
  push,
  query,
  ref,
  serverTimestamp,
  set,
  update,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyAYr824z_XxqfxNiIr4y7gmbd23Tc84h1s",
  authDomain: "engineering-861d3.firebaseapp.com",
  databaseURL: "https://engineering-861d3-default-rtdb.firebaseio.com/",
  projectId: "engineering-861d3",
  storageBucket: "engineering-861d3.firebasestorage.app",
  messagingSenderId: "119129277466",
  appId: "1:119129277466:web:2457e5ea8abccf706e3da3",
};

const DATABASE_ROOT = "labEquipmentTracker";
const firebaseConfigured = true;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

setPersistence(auth, browserLocalPersistence).catch((error) => {
  console.error("Could not enable persistent Firebase login:", error);
});

const PROJECTS = Object.freeze(["Apple", "AQS", "Rogers"]);
const ITEM_TYPES = Object.freeze(["Device", "Component"]);
const SITES = Object.freeze({
  EC5: ["Shared Space", "Cage-Chamber Space"],
  E5: ["My Office", "Shared Lab", "Someone Else's Office"],
});

function databasePath(...parts) {
  return [DATABASE_ROOT, ...parts].filter(Boolean).join("/");
}

function userStamp(user) {
  return {
    uid: user.uid,
    email: user.email || "",
    displayName: user.displayName || "",
  };
}

function cleanText(value, maxLength = 500) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizePhoto(value) {
  const photo = String(value ?? "").trim();
  if (!photo) return "";
  if (!/^data:image\/(jpeg|png|webp);base64,/i.test(photo)) {
    throw new Error("The item photo must be a valid Base64 image.");
  }
  if (photo.length > 750_000) {
    throw new Error("The Base64 item photo is too large. Use a smaller image.");
  }
  return photo;
}

function normalizeLocation(location) {
  const site = cleanText(location?.site, 10);
  const subLocation = cleanText(location?.subLocation, 80);
  const officeOwner = cleanText(location?.officeOwner, 120);

  if (!Object.prototype.hasOwnProperty.call(SITES, site)) {
    throw new Error("Select a valid site.");
  }
  if (!SITES[site].includes(subLocation)) {
    throw new Error("Select a valid sub-location.");
  }
  if (site === "E5" && subLocation === "Someone Else's Office" && !officeOwner) {
    throw new Error("Provide the office owner's name.");
  }

  return {
    site,
    subLocation,
    officeOwner:
      site === "E5" && subLocation === "Someone Else's Office" ? officeOwner : "",
  };
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Select a valid date and time.");
  }
  return date;
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function objectEntries(value) {
  return value && typeof value === "object" ? Object.entries(value) : [];
}

function equipmentArray(value) {
  return objectEntries(value)
    .map(([id, item]) => ({ id, ...item }))
    .sort((a, b) => asNumber(b.updatedAt) - asNumber(a.updatedAt));
}

function serialArray(value) {
  return objectEntries(value)
    .map(([id, serial]) => ({ id, ...serial }))
    .sort((a, b) =>
      String(a.serialNumber || "").localeCompare(String(b.serialNumber || ""), undefined, {
        numeric: true,
        sensitivity: "base",
      })
    );
}

function activityArray(value) {
  return objectEntries(value)
    .map(([id, log]) => ({ id, ...log }))
    .sort((a, b) => asNumber(b.occurredAt) - asNumber(a.occurredAt));
}

function logBase(item, serial, actionType, occurredAt, user) {
  return {
    itemId: item.id,
    itemName: item.name,
    projectName: item.projectName,
    itemType: item.itemType,
    serialId: serial.id,
    serialNumber: serial.serialNumber,
    actionType,
    occurredAt: normalizeDate(occurredAt).getTime(),
    loggedAt: serverTimestamp(),
    actorUid: user.uid,
    actorEmail: user.email || "",
  };
}

async function readSerials(itemId) {
  const snapshot = await get(ref(db, databasePath("serials", itemId)));
  return serialArray(snapshot.val());
}

export {
  DATABASE_ROOT,
  ITEM_TYPES,
  PROJECTS,
  SITES,
  firebaseConfigured,
};

export function observeAuthentication(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function loginWithEmail(email, password) {
  return signInWithEmailAndPassword(auth, cleanText(email, 320), String(password ?? ""));
}

export async function logout() {
  return signOut(auth);
}

export async function sendResetEmail(email) {
  return sendPasswordResetEmail(auth, cleanText(email, 320));
}

/**
 * Every authenticated account in engineering-861d3 is allowed into this app.
 * The function name is retained so index.html can use the same clean interface.
 */
export async function getAuthorizationProfile(user) {
  if (!user) return null;
  const emailName = String(user.email || "").split("@")[0];
  return {
    id: user.uid,
    active: true,
    name: user.displayName || emailName || "Authenticated member",
    email: user.email || "",
  };
}

export function subscribeEquipment(onData, onError) {
  return onValue(
    ref(db, databasePath("equipment")),
    (snapshot) => onData(equipmentArray(snapshot.val())),
    onError
  );
}

export function subscribeSerials(itemId, onData, onError) {
  return onValue(
    ref(db, databasePath("serials", itemId)),
    (snapshot) => onData(serialArray(snapshot.val())),
    onError
  );
}

export function subscribeActivityLogs(onData, onError) {
  const logsQuery = query(
    ref(db, databasePath("activityLogs")),
    orderByChild("occurredAt"),
    limitToLast(300)
  );

  return onValue(
    logsQuery,
    (snapshot) => onData(activityArray(snapshot.val())),
    onError
  );
}

export async function createEquipment(payload, user) {
  const projectName = cleanText(payload.projectName, 30);
  const itemType = cleanText(payload.itemType, 30);
  const name = cleanText(payload.name, 160);
  const comment = cleanText(payload.comment, 4000);
  const quantity = Number.parseInt(payload.quantity, 10);
  const photoBase64 = normalizePhoto(payload.photoBase64);

  if (!PROJECTS.includes(projectName)) throw new Error("Select a valid project.");
  if (!ITEM_TYPES.includes(itemType)) throw new Error("Select a valid item type.");
  if (!name) throw new Error("Item name is required.");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) {
    throw new Error("Quantity must be a whole number between 1 and 10,000.");
  }

  const itemRef = push(ref(db, databasePath("equipment")));
  const item = {
    projectName,
    itemType,
    name,
    comment,
    quantity,
    serialCount: 0,
    photoBase64,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdBy: userStamp(user),
    updatedBy: userStamp(user),
  };

  await set(itemRef, item);
  return { id: itemRef.key, ...item };
}

export async function updateEquipmentRecord(item, payload, user) {
  const quantity = Number.parseInt(payload.quantity, 10);
  const serialCount = Number(item.serialCount || 0);
  const projectName = cleanText(payload.projectName, 30);
  const itemType = cleanText(payload.itemType, 30);
  const name = cleanText(payload.name, 160);

  if (!PROJECTS.includes(projectName)) throw new Error("Select a valid project.");
  if (!ITEM_TYPES.includes(itemType)) throw new Error("Select a valid item type.");
  if (!name) throw new Error("Item name is required.");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) {
    throw new Error("Quantity must be a whole number between 1 and 10,000.");
  }
  if (quantity < serialCount) {
    throw new Error(`Quantity cannot be below the ${serialCount} registered serial numbers.`);
  }

  const patch = {
    projectName,
    itemType,
    name,
    comment: cleanText(payload.comment, 4000),
    quantity,
    updatedAt: serverTimestamp(),
    updatedBy: userStamp(user),
  };

  if (Object.prototype.hasOwnProperty.call(payload, "photoBase64")) {
    patch.photoBase64 = normalizePhoto(payload.photoBase64);
  }

  await update(ref(db, databasePath("equipment", item.id)), patch);
}

export async function deleteEquipmentRecord(itemId) {
  const rootRef = ref(db, DATABASE_ROOT);
  await update(rootRef, {
    [`equipment/${itemId}`]: null,
    [`serials/${itemId}`]: null,
  });
  // activityLogs are deliberately preserved as immutable audit history.
}

export async function addSerialNumbers(item, entries, occurredAt, user) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Add at least one serial number.");
  }

  const existingSerials = await readSerials(item.id);
  const existing = new Set(
    existingSerials.map((entry) => String(entry.serialNumber).toLowerCase())
  );
  const uniqueIncoming = new Map();

  entries.forEach((entry) => {
    const serialNumber = cleanText(entry.serialNumber, 160);
    if (!serialNumber) return;
    const key = serialNumber.toLowerCase();
    if (!existing.has(key) && !uniqueIncoming.has(key)) {
      uniqueIncoming.set(key, {
        serialNumber,
        currentLocation: normalizeLocation(entry.currentLocation),
      });
    }
  });

  const serials = [...uniqueIncoming.values()];
  if (serials.length === 0) {
    throw new Error("All entered serial numbers already exist or are empty.");
  }

  const currentCount = existingSerials.length;
  if (currentCount + serials.length > Number(item.quantity)) {
    throw new Error(
      `This would create ${currentCount + serials.length} serials, above the item quantity of ${item.quantity}.`
    );
  }

  const rootRef = ref(db, DATABASE_ROOT);
  const updates = {};

  serials.forEach((entry) => {
    const serialRef = push(ref(db, databasePath("serials", item.id)));
    const logRef = push(ref(db, databasePath("activityLogs")));
    const serial = {
      id: serialRef.key,
      serialNumber: entry.serialNumber,
    };

    updates[`serials/${item.id}/${serialRef.key}`] = {
      serialNumber: entry.serialNumber,
      currentLocation: entry.currentLocation,
      loan: {
        isLoaned: false,
        memberName: "",
        loanedAt: null,
      },
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: userStamp(user),
      updatedBy: userStamp(user),
    };

    updates[`activityLogs/${logRef.key}`] = {
      ...logBase(item, serial, "Registered", occurredAt, user),
      details: {
        toLocation: entry.currentLocation,
      },
    };
  });

  updates[`equipment/${item.id}/serialCount`] = increment(serials.length);
  updates[`equipment/${item.id}/updatedAt`] = serverTimestamp();
  updates[`equipment/${item.id}/updatedBy`] = userStamp(user);

  await update(rootRef, updates);
  return serials.length;
}

export async function renameSerialNumber(item, serial, nextSerialNumber, occurredAt, user) {
  const cleaned = cleanText(nextSerialNumber, 160);
  if (!cleaned) throw new Error("Serial number is required.");

  const serials = await readSerials(item.id);
  const duplicate = serials.some(
    (entry) =>
      entry.id !== serial.id &&
      String(entry.serialNumber).toLowerCase() === cleaned.toLowerCase()
  );

  if (duplicate) throw new Error("That serial number already exists for this item.");
  if (cleaned === serial.serialNumber) return;

  const logRef = push(ref(db, databasePath("activityLogs")));
  await update(ref(db, DATABASE_ROOT), {
    [`serials/${item.id}/${serial.id}/serialNumber`]: cleaned,
    [`serials/${item.id}/${serial.id}/updatedAt`]: serverTimestamp(),
    [`serials/${item.id}/${serial.id}/updatedBy`]: userStamp(user),
    [`activityLogs/${logRef.key}`]: {
      ...logBase(item, { ...serial, serialNumber: cleaned }, "Serial renamed", occurredAt, user),
      details: {
        previousSerialNumber: serial.serialNumber,
        newSerialNumber: cleaned,
      },
    },
    [`equipment/${item.id}/updatedAt`]: serverTimestamp(),
    [`equipment/${item.id}/updatedBy`]: userStamp(user),
  });
}

export async function removeSerialNumber(item, serial, occurredAt, user) {
  const logRef = push(ref(db, databasePath("activityLogs")));
  await update(ref(db, DATABASE_ROOT), {
    [`activityLogs/${logRef.key}`]: {
      ...logBase(item, serial, "Removed", occurredAt, user),
      details: {
        fromLocation: serial.currentLocation || null,
        memberName: serial.loan?.memberName || "",
      },
    },
    [`serials/${item.id}/${serial.id}`]: null,
    [`equipment/${item.id}/serialCount`]: increment(-1),
    [`equipment/${item.id}/updatedAt`]: serverTimestamp(),
    [`equipment/${item.id}/updatedBy`]: userStamp(user),
  });
}

export async function moveSerialNumber(item, serial, fromLocation, toLocation, occurredAt, user) {
  if (serial.loan?.isLoaned) {
    throw new Error("Return this serial from lending before moving it.");
  }

  const normalizedFrom = normalizeLocation(fromLocation);
  const normalizedTo = normalizeLocation(toLocation);
  if (JSON.stringify(normalizedFrom) === JSON.stringify(normalizedTo)) {
    throw new Error("Select a different destination location.");
  }

  const logRef = push(ref(db, databasePath("activityLogs")));
  await update(ref(db, DATABASE_ROOT), {
    [`serials/${item.id}/${serial.id}/currentLocation`]: normalizedTo,
    [`serials/${item.id}/${serial.id}/updatedAt`]: serverTimestamp(),
    [`serials/${item.id}/${serial.id}/updatedBy`]: userStamp(user),
    [`activityLogs/${logRef.key}`]: {
      ...logBase(item, serial, "Moved", occurredAt, user),
      details: {
        fromLocation: normalizedFrom,
        toLocation: normalizedTo,
      },
    },
    [`equipment/${item.id}/updatedAt`]: serverTimestamp(),
    [`equipment/${item.id}/updatedBy`]: userStamp(user),
  });
}

export async function lendSerialNumber(item, serial, memberName, occurredAt, user) {
  if (serial.loan?.isLoaned) {
    throw new Error(`This serial is already lent to ${serial.loan.memberName}.`);
  }

  const borrower = cleanText(memberName, 160);
  if (!borrower) throw new Error("Member name is required for lending.");
  const date = normalizeDate(occurredAt);
  const logRef = push(ref(db, databasePath("activityLogs")));

  await update(ref(db, DATABASE_ROOT), {
    [`serials/${item.id}/${serial.id}/loan`]: {
      isLoaned: true,
      memberName: borrower,
      loanedAt: date.getTime(),
    },
    [`serials/${item.id}/${serial.id}/updatedAt`]: serverTimestamp(),
    [`serials/${item.id}/${serial.id}/updatedBy`]: userStamp(user),
    [`activityLogs/${logRef.key}`]: {
      ...logBase(item, serial, "Lent", date, user),
      details: {
        memberName: borrower,
        fromLocation: serial.currentLocation || null,
      },
    },
    [`equipment/${item.id}/updatedAt`]: serverTimestamp(),
    [`equipment/${item.id}/updatedBy`]: userStamp(user),
  });
}

export async function returnSerialNumber(item, serial, returnLocation, occurredAt, user) {
  if (!serial.loan?.isLoaned) {
    throw new Error("This serial is not currently lent out.");
  }

  const normalizedLocation = normalizeLocation(returnLocation);
  const logRef = push(ref(db, databasePath("activityLogs")));

  await update(ref(db, DATABASE_ROOT), {
    [`serials/${item.id}/${serial.id}/currentLocation`]: normalizedLocation,
    [`serials/${item.id}/${serial.id}/loan`]: {
      isLoaned: false,
      memberName: "",
      loanedAt: null,
    },
    [`serials/${item.id}/${serial.id}/updatedAt`]: serverTimestamp(),
    [`serials/${item.id}/${serial.id}/updatedBy`]: userStamp(user),
    [`activityLogs/${logRef.key}`]: {
      ...logBase(item, serial, "Returned", occurredAt, user),
      details: {
        memberName: serial.loan.memberName,
        toLocation: normalizedLocation,
      },
    },
    [`equipment/${item.id}/updatedAt`]: serverTimestamp(),
    [`equipment/${item.id}/updatedBy`]: userStamp(user),
  });
}

export async function getInventoryExportRows() {
  const [equipmentSnapshot, serialsSnapshot] = await Promise.all([
    get(ref(db, databasePath("equipment"))),
    get(ref(db, databasePath("serials"))),
  ]);

  const equipment = equipmentArray(equipmentSnapshot.val());
  const serialsByItem = serialsSnapshot.val() || {};
  const rows = [];

  equipment.forEach((item) => {
    const serials = serialArray(serialsByItem[item.id]);

    if (serials.length === 0) {
      rows.push({
        projectName: item.projectName,
        itemType: item.itemType,
        itemName: item.name,
        quantity: item.quantity,
        comment: item.comment || "",
        serialNumber: "",
        location: "",
        lendingStatus: "Unregistered",
        memberName: "",
      });
      return;
    }

    serials.forEach((serial) => {
      const location = serial.currentLocation || {};
      rows.push({
        projectName: item.projectName,
        itemType: item.itemType,
        itemName: item.name,
        quantity: item.quantity,
        comment: item.comment || "",
        serialNumber: serial.serialNumber,
        location: [location.site, location.subLocation, location.officeOwner]
          .filter(Boolean)
          .join(" — "),
        lendingStatus: serial.loan?.isLoaned ? "Lent" : "Available",
        memberName: serial.loan?.memberName || "",
      });
    });
  });

  return rows;
}
