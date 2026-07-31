/**
 * Lab Equipment Tracker — Firebase Realtime Database service
 *
 * This app reuses the existing engineering-861d3 Firebase project and its
 * Firebase Authentication accounts. Tracker records are isolated under the
 * `labEquipmentTracker` root and do not modify the existing `alerts` branch.
 *
 * Realtime Database rules:
 * {
 *   "rules": {
 *     "alerts": {
 *       ".read": "auth != null",
 *       ".write": true,
 *       ".indexOn": ["powerSentAt"]
 *     },
 *     "labEquipmentTracker": {
 *       ".read": "auth != null",
 *       ".write": "auth != null",
 *       "activityLogs": {
 *         ".indexOn": ["occurredAt"]
 *       }
 *     }
 *   }
 * }
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import {
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import {
  get,
  getDatabase,
  limitToLast,
  onValue,
  orderByChild,
  push,
  query,
  ref,
  serverTimestamp,
  set,
  update,
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyAYr824z_XxqfxNiIr4y7gmbd23Tc84h1s",
  authDomain: "engineering-861d3.firebaseapp.com",
  databaseURL: "https://engineering-861d3-default-rtdb.firebaseio.com/",
  projectId: "engineering-861d3",
  storageBucket: "engineering-861d3.firebasestorage.app",
  messagingSenderId: "119129277466",
  appId: "1:119129277466:web:2457e5ea8abccf706e3da3",
};

const firebaseConfigured = true;
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const TRACKER_ROOT = "labEquipmentTracker";

setPersistence(auth, browserLocalPersistence).catch((error) => {
  console.error("Could not enable persistent Firebase login:", error);
});

const PROJECTS = Object.freeze(["Apple", "AQS", "Rogers", "Generic"]);
const ITEM_TYPES = Object.freeze(["Device", "Component"]);
const SITES = Object.freeze({
  EC5: ["Shared Space", "Cage-Chamber Space"],
  E5: ["My Office", "Shared Lab", "Someone Else's Office"],
});

function cleanText(value, maxLength = 500) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function userStamp(user) {
  if (!user?.uid) throw new Error("A signed-in Firebase user is required.");
  return {
    uid: user.uid,
    email: user.email || "",
  };
}

function normalizePhoto(value, subject = "item") {
  const photo = String(value ?? "").trim();
  if (!photo) return "";
  if (!/^data:image\/(jpeg|png|webp);base64,/i.test(photo)) {
    throw new Error(`The ${subject} photo must be a valid Base64 image.`);
  }
  if (photo.length > 750_000) {
    throw new Error(`The Base64 ${subject} photo is too large. Use a smaller image.`);
  }
  return photo;
}

function normalizeLocation(location) {
  const site = cleanText(location?.site, 10);
  const subLocation = cleanText(location?.subLocation, 80);
  const officeOwner = cleanText(location?.officeOwner, 120);
  const exactLocation = cleanText(location?.exactLocation, 240);

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
    exactLocation,
  };
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Select a valid date and time.");
  }
  return date;
}

function normalizeLoan(value, occurredAt, existingLoan = null) {
  const isLoaned = Boolean(value?.isLoaned);
  const memberName = cleanText(value?.memberName, 160);
  if (isLoaned && !memberName) {
    throw new Error("Provide the member name when the serial is marked as lent.");
  }
  return {
    isLoaned,
    memberName: isLoaned ? memberName : "",
    loanedAt: isLoaned
      ? Number(existingLoan?.loanedAt || normalizeDate(occurredAt).getTime())
      : null,
  };
}

function objectValuesWithIds(value) {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([id, data]) => ({ id, ...(data || {}) }));
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

function itemLogBase(item, actionType, occurredAt, user) {
  return {
    itemId: item.id,
    itemName: item.name,
    projectName: item.projectName,
    itemType: item.itemType,
    serialId: "",
    serialNumber: "",
    actionType,
    occurredAt: normalizeDate(occurredAt).getTime(),
    loggedAt: serverTimestamp(),
    actorUid: user.uid,
    actorEmail: user.email || "",
  };
}

function changedLocation(a, b) {
  return JSON.stringify(normalizeLocation(a)) !== JSON.stringify(normalizeLocation(b));
}

export { PROJECTS, ITEM_TYPES, SITES, firebaseConfigured };

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

export function subscribeEquipment(onData, onError) {
  const equipmentRef = ref(db, `${TRACKER_ROOT}/equipment`);
  return onValue(
    equipmentRef,
    (snapshot) => {
      const items = objectValuesWithIds(snapshot.val()).sort(
        (a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)
      );
      onData(items);
    },
    onError
  );
}

export function subscribeSerials(itemId, onData, onError) {
  const serialRef = ref(db, `${TRACKER_ROOT}/serials/${itemId}`);
  return onValue(
    serialRef,
    (snapshot) => {
      const serials = objectValuesWithIds(snapshot.val()).sort((a, b) =>
        String(a.serialNumber || "").localeCompare(String(b.serialNumber || ""), undefined, {
          numeric: true,
          sensitivity: "base",
        })
      );
      onData(serials);
    },
    onError
  );
}

export function subscribeItemNotes(itemId, onData, onError) {
  const notesRef = ref(db, `${TRACKER_ROOT}/notes/${itemId}`);
  return onValue(
    notesRef,
    (snapshot) => {
      const notes = objectValuesWithIds(snapshot.val()).sort(
        (a, b) => Number(b.noteDate || b.updatedAt || 0) - Number(a.noteDate || a.updatedAt || 0)
      );
      onData(notes);
    },
    onError
  );
}

export function subscribeActivityLogs(onData, onError) {
  const activityQuery = query(
    ref(db, `${TRACKER_ROOT}/activityLogs`),
    orderByChild("occurredAt"),
    limitToLast(300)
  );
  return onValue(
    activityQuery,
    (snapshot) => {
      const logs = objectValuesWithIds(snapshot.val()).sort(
        (a, b) => Number(b.occurredAt || 0) - Number(a.occurredAt || 0)
      );
      onData(logs);
    },
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

  const itemRef = push(ref(db, `${TRACKER_ROOT}/equipment`));
  const now = serverTimestamp();
  await set(itemRef, {
    projectName,
    itemType,
    name,
    comment,
    quantity,
    serialCount: 0,
    photoBase64,
    createdAt: now,
    updatedAt: now,
    createdBy: userStamp(user),
    updatedBy: userStamp(user),
  });
  return itemRef.key;
}

export async function updateEquipmentRecord(item, payload, user) {
  const projectName = cleanText(payload.projectName, 30);
  const itemType = cleanText(payload.itemType, 30);
  const name = cleanText(payload.name, 160);
  const comment = cleanText(payload.comment, 4000);
  const quantity = Number.parseInt(payload.quantity, 10);
  const serialSnapshot = await get(ref(db, `${TRACKER_ROOT}/serials/${item.id}`));
  const serialCount = serialSnapshot.exists()
    ? Object.keys(serialSnapshot.val() || {}).length
    : 0;

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
    comment,
    quantity,
    serialCount,
    updatedAt: serverTimestamp(),
    updatedBy: userStamp(user),
  };
  if (Object.prototype.hasOwnProperty.call(payload, "photoBase64")) {
    patch.photoBase64 = normalizePhoto(payload.photoBase64);
  }

  await update(ref(db, `${TRACKER_ROOT}/equipment/${item.id}`), patch);
}

export async function deleteEquipmentRecord(itemId) {
  // Historical activity logs are deliberately preserved.
  await update(ref(db), {
    [`${TRACKER_ROOT}/equipment/${itemId}`]: null,
    [`${TRACKER_ROOT}/serials/${itemId}`]: null,
    [`${TRACKER_ROOT}/notes/${itemId}`]: null,
  });
}

export async function addSerialNumbers(item, entries, occurredAt, user) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Add at least one serial number.");
  }

  const serialSnapshot = await get(ref(db, `${TRACKER_ROOT}/serials/${item.id}`));
  const existingSerials = objectValuesWithIds(serialSnapshot.val());
  const existingNumbers = new Set(
    existingSerials.map((entry) => String(entry.serialNumber || "").toLowerCase())
  );
  const uniqueIncoming = new Map();

  entries.forEach((entry) => {
    const serialNumber = cleanText(entry.serialNumber, 160);
    if (!serialNumber) return;
    const key = serialNumber.toLowerCase();
    if (!existingNumbers.has(key) && !uniqueIncoming.has(key)) {
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
  if (existingSerials.length + serials.length > Number(item.quantity)) {
    throw new Error(
      `This would create ${existingSerials.length + serials.length} serials, above the item quantity of ${item.quantity}.`
    );
  }

  const writes = {};
  const now = serverTimestamp();
  serials.forEach((entry) => {
    const serialKey = push(ref(db, `${TRACKER_ROOT}/serials/${item.id}`)).key;
    const serial = { id: serialKey, serialNumber: entry.serialNumber };
    writes[`${TRACKER_ROOT}/serials/${item.id}/${serialKey}`] = {
      serialNumber: entry.serialNumber,
      currentLocation: entry.currentLocation,
      loan: { isLoaned: false, memberName: "", loanedAt: null },
      createdAt: now,
      updatedAt: now,
      createdBy: userStamp(user),
      updatedBy: userStamp(user),
    };
    const logKey = push(ref(db, `${TRACKER_ROOT}/activityLogs`)).key;
    writes[`${TRACKER_ROOT}/activityLogs/${logKey}`] = {
      ...logBase(item, serial, "Registered", occurredAt, user),
      details: { toLocation: entry.currentLocation },
    };
  });
  writes[`${TRACKER_ROOT}/equipment/${item.id}/serialCount`] =
    existingSerials.length + serials.length;
  writes[`${TRACKER_ROOT}/equipment/${item.id}/updatedAt`] = now;
  writes[`${TRACKER_ROOT}/equipment/${item.id}/updatedBy`] = userStamp(user);

  await update(ref(db), writes);
  return serials.length;
}

export async function updateSerialRecord(item, serial, payload, occurredAt, user) {
  const serialNumber = cleanText(payload.serialNumber, 160);
  if (!serialNumber) throw new Error("Serial number is required.");

  const serialSnapshot = await get(ref(db, `${TRACKER_ROOT}/serials/${item.id}`));
  const serials = objectValuesWithIds(serialSnapshot.val());
  const duplicate = serials.some(
    (entry) =>
      entry.id !== serial.id &&
      String(entry.serialNumber || "").toLowerCase() === serialNumber.toLowerCase()
  );
  if (duplicate) throw new Error("That serial number already exists for this item.");

  const currentLocation = normalizeLocation(payload.currentLocation);
  const loan = normalizeLoan(payload.loan, occurredAt, serial.loan);
  const previous = {
    serialNumber: cleanText(serial.serialNumber, 160),
    currentLocation: normalizeLocation(serial.currentLocation),
    loan: normalizeLoan(serial.loan, occurredAt, serial.loan),
  };
  const next = { serialNumber, currentLocation, loan };

  if (JSON.stringify(previous) === JSON.stringify(next)) return false;

  const now = serverTimestamp();
  const logKey = push(ref(db, `${TRACKER_ROOT}/activityLogs`)).key;
  const writes = {
    [`${TRACKER_ROOT}/serials/${item.id}/${serial.id}/serialNumber`]: serialNumber,
    [`${TRACKER_ROOT}/serials/${item.id}/${serial.id}/currentLocation`]: currentLocation,
    [`${TRACKER_ROOT}/serials/${item.id}/${serial.id}/loan`]: loan,
    [`${TRACKER_ROOT}/serials/${item.id}/${serial.id}/updatedAt`]: now,
    [`${TRACKER_ROOT}/serials/${item.id}/${serial.id}/updatedBy`]: userStamp(user),
    [`${TRACKER_ROOT}/equipment/${item.id}/updatedAt`]: now,
    [`${TRACKER_ROOT}/equipment/${item.id}/updatedBy`]: userStamp(user),
    [`${TRACKER_ROOT}/activityLogs/${logKey}`]: {
      ...logBase(item, { ...serial, serialNumber }, "Serial modified", occurredAt, user),
      details: { previous, next },
    },
  };
  await update(ref(db), writes);
  return true;
}

export async function removeSerialNumber(item, serial, occurredAt, user) {
  const serialSnapshot = await get(ref(db, `${TRACKER_ROOT}/serials/${item.id}`));
  const currentCount = objectValuesWithIds(serialSnapshot.val()).length;
  const logKey = push(ref(db, `${TRACKER_ROOT}/activityLogs`)).key;
  const now = serverTimestamp();
  await update(ref(db), {
    [`${TRACKER_ROOT}/activityLogs/${logKey}`]: {
      ...logBase(item, serial, "Removed", occurredAt, user),
      details: {
        fromLocation: serial.currentLocation || null,
        memberName: serial.loan?.memberName || "",
      },
    },
    [`${TRACKER_ROOT}/serials/${item.id}/${serial.id}`]: null,
    [`${TRACKER_ROOT}/equipment/${item.id}/serialCount`]: Math.max(0, currentCount - 1),
    [`${TRACKER_ROOT}/equipment/${item.id}/updatedAt`]: now,
    [`${TRACKER_ROOT}/equipment/${item.id}/updatedBy`]: userStamp(user),
  });
}

export async function moveSerialNumber(item, serial, fromLocation, toLocation, occurredAt, user) {
  if (serial.loan?.isLoaned) {
    throw new Error("Return this serial from lending before moving it.");
  }
  const normalizedFrom = normalizeLocation(fromLocation);
  const normalizedTo = normalizeLocation(toLocation);
  if (!changedLocation(normalizedFrom, normalizedTo)) {
    throw new Error("Change the destination location or its exact-location note.");
  }

  const logKey = push(ref(db, `${TRACKER_ROOT}/activityLogs`)).key;
  const now = serverTimestamp();
  await update(ref(db), {
    [`${TRACKER_ROOT}/serials/${item.id}/${serial.id}/currentLocation`]: normalizedTo,
    [`${TRACKER_ROOT}/serials/${item.id}/${serial.id}/updatedAt`]: now,
    [`${TRACKER_ROOT}/serials/${item.id}/${serial.id}/updatedBy`]: userStamp(user),
    [`${TRACKER_ROOT}/equipment/${item.id}/updatedAt`]: now,
    [`${TRACKER_ROOT}/equipment/${item.id}/updatedBy`]: userStamp(user),
    [`${TRACKER_ROOT}/activityLogs/${logKey}`]: {
      ...logBase(item, serial, "Moved", occurredAt, user),
      details: { fromLocation: normalizedFrom, toLocation: normalizedTo },
    },
  });
}

export async function lendSerialNumber(item, serial, memberName, occurredAt, user) {
  if (serial.loan?.isLoaned) {
    throw new Error(`This serial is already lent to ${serial.loan.memberName}.`);
  }
  const borrower = cleanText(memberName, 160);
  if (!borrower) throw new Error("Member name is required for lending.");
  const date = normalizeDate(occurredAt);
  const loan = { isLoaned: true, memberName: borrower, loanedAt: date.getTime() };
  const logKey = push(ref(db, `${TRACKER_ROOT}/activityLogs`)).key;
  const now = serverTimestamp();

  await update(ref(db), {
    [`${TRACKER_ROOT}/serials/${item.id}/${serial.id}/loan`]: loan,
    [`${TRACKER_ROOT}/serials/${item.id}/${serial.id}/updatedAt`]: now,
    [`${TRACKER_ROOT}/serials/${item.id}/${serial.id}/updatedBy`]: userStamp(user),
    [`${TRACKER_ROOT}/equipment/${item.id}/updatedAt`]: now,
    [`${TRACKER_ROOT}/equipment/${item.id}/updatedBy`]: userStamp(user),
    [`${TRACKER_ROOT}/activityLogs/${logKey}`]: {
      ...logBase(item, serial, "Lent", date, user),
      details: { memberName: borrower, fromLocation: serial.currentLocation || null },
    },
  });
}

export async function returnSerialNumber(item, serial, returnLocation, occurredAt, user) {
  if (!serial.loan?.isLoaned) {
    throw new Error("This serial is not currently lent out.");
  }
  const normalizedLocation = normalizeLocation(returnLocation);
  const logKey = push(ref(db, `${TRACKER_ROOT}/activityLogs`)).key;
  const now = serverTimestamp();

  await update(ref(db), {
    [`${TRACKER_ROOT}/serials/${item.id}/${serial.id}/currentLocation`]: normalizedLocation,
    [`${TRACKER_ROOT}/serials/${item.id}/${serial.id}/loan`]: {
      isLoaned: false,
      memberName: "",
      loanedAt: null,
    },
    [`${TRACKER_ROOT}/serials/${item.id}/${serial.id}/updatedAt`]: now,
    [`${TRACKER_ROOT}/serials/${item.id}/${serial.id}/updatedBy`]: userStamp(user),
    [`${TRACKER_ROOT}/equipment/${item.id}/updatedAt`]: now,
    [`${TRACKER_ROOT}/equipment/${item.id}/updatedBy`]: userStamp(user),
    [`${TRACKER_ROOT}/activityLogs/${logKey}`]: {
      ...logBase(item, serial, "Returned", occurredAt, user),
      details: { memberName: serial.loan.memberName, toLocation: normalizedLocation },
    },
  });
}

export async function createItemNote(item, payload, user) {
  const text = cleanText(payload.text, 5000);
  const photoBase64 = normalizePhoto(payload.photoBase64, "note");
  const noteDate = normalizeDate(payload.noteDate).getTime();
  if (!text && !photoBase64) {
    throw new Error("Add note text, a note photo, or both.");
  }

  const noteRef = push(ref(db, `${TRACKER_ROOT}/notes/${item.id}`));
  const logKey = push(ref(db, `${TRACKER_ROOT}/activityLogs`)).key;
  const now = serverTimestamp();
  await update(ref(db), {
    [`${TRACKER_ROOT}/notes/${item.id}/${noteRef.key}`]: {
      text,
      photoBase64,
      noteDate,
      createdAt: now,
      updatedAt: now,
      createdBy: userStamp(user),
      updatedBy: userStamp(user),
    },
    [`${TRACKER_ROOT}/equipment/${item.id}/updatedAt`]: now,
    [`${TRACKER_ROOT}/equipment/${item.id}/updatedBy`]: userStamp(user),
    [`${TRACKER_ROOT}/activityLogs/${logKey}`]: {
      ...itemLogBase(item, "Note added", noteDate, user),
      details: { noteId: noteRef.key, noteText: text, hasPhoto: Boolean(photoBase64) },
    },
  });
  return noteRef.key;
}

export async function updateItemNote(item, note, payload, user) {
  const text = cleanText(payload.text, 5000);
  const photoBase64 = normalizePhoto(payload.photoBase64, "note");
  const noteDate = normalizeDate(payload.noteDate).getTime();
  if (!text && !photoBase64) {
    throw new Error("Add note text, a note photo, or both.");
  }

  const previous = {
    text: cleanText(note.text, 5000),
    photoBase64: String(note.photoBase64 || ""),
    noteDate: Number(note.noteDate || 0),
  };
  const next = { text, photoBase64, noteDate };
  if (JSON.stringify(previous) === JSON.stringify(next)) return false;

  const logKey = push(ref(db, `${TRACKER_ROOT}/activityLogs`)).key;
  const now = serverTimestamp();
  await update(ref(db), {
    [`${TRACKER_ROOT}/notes/${item.id}/${note.id}/text`]: text,
    [`${TRACKER_ROOT}/notes/${item.id}/${note.id}/photoBase64`]: photoBase64,
    [`${TRACKER_ROOT}/notes/${item.id}/${note.id}/noteDate`]: noteDate,
    [`${TRACKER_ROOT}/notes/${item.id}/${note.id}/updatedAt`]: now,
    [`${TRACKER_ROOT}/notes/${item.id}/${note.id}/updatedBy`]: userStamp(user),
    [`${TRACKER_ROOT}/equipment/${item.id}/updatedAt`]: now,
    [`${TRACKER_ROOT}/equipment/${item.id}/updatedBy`]: userStamp(user),
    [`${TRACKER_ROOT}/activityLogs/${logKey}`]: {
      ...itemLogBase(item, "Note modified", noteDate, user),
      details: {
        noteId: note.id,
        previousText: previous.text,
        nextText: text,
        previousHadPhoto: Boolean(previous.photoBase64),
        nextHasPhoto: Boolean(photoBase64),
      },
    },
  });
  return true;
}

export async function deleteItemNote(item, note, user) {
  const occurredAt = Date.now();
  const logKey = push(ref(db, `${TRACKER_ROOT}/activityLogs`)).key;
  const now = serverTimestamp();
  await update(ref(db), {
    [`${TRACKER_ROOT}/notes/${item.id}/${note.id}`]: null,
    [`${TRACKER_ROOT}/equipment/${item.id}/updatedAt`]: now,
    [`${TRACKER_ROOT}/equipment/${item.id}/updatedBy`]: userStamp(user),
    [`${TRACKER_ROOT}/activityLogs/${logKey}`]: {
      ...itemLogBase(item, "Note removed", occurredAt, user),
      details: {
        noteId: note.id,
        noteText: cleanText(note.text, 5000),
        hadPhoto: Boolean(note.photoBase64),
      },
    },
  });
}

export async function getInventoryReportData(itemIds = []) {
  const rootSnapshot = await get(ref(db, TRACKER_ROOT));
  const data = rootSnapshot.val() || {};
  const selectedIds = new Set(Array.isArray(itemIds) ? itemIds.filter(Boolean) : []);
  const equipment = objectValuesWithIds(data.equipment)
    .filter((item) => selectedIds.size === 0 || selectedIds.has(item.id))
    .sort((a, b) => {
      const projectCompare = String(a.projectName || "").localeCompare(String(b.projectName || ""));
      if (projectCompare) return projectCompare;
      const typeCompare = String(a.itemType || "").localeCompare(String(b.itemType || ""));
      return typeCompare || String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true });
    });

  return equipment.map((item) => ({
    ...item,
    serials: objectValuesWithIds(data.serials?.[item.id]).sort((a, b) =>
      String(a.serialNumber || "").localeCompare(String(b.serialNumber || ""), undefined, {
        numeric: true,
        sensitivity: "base",
      })
    ),
    notes: objectValuesWithIds(data.notes?.[item.id]).sort(
      (a, b) => Number(b.noteDate || b.updatedAt || 0) - Number(a.noteDate || a.updatedAt || 0)
    ),
  }));
}

export async function getInventoryExportRows() {
  const rootSnapshot = await get(ref(db, TRACKER_ROOT));
  const data = rootSnapshot.val() || {};
  const equipment = objectValuesWithIds(data.equipment);
  const allSerials = data.serials || {};
  const rows = [];

  equipment.forEach((item) => {
    const serials = objectValuesWithIds(allSerials[item.id]);
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
        location: [
          location.site,
          location.subLocation,
          location.officeOwner,
          location.exactLocation,
        ]
          .filter(Boolean)
          .join(" — "),
        lendingStatus: serial.loan?.isLoaned ? "Lent" : "Available",
        memberName: serial.loan?.memberName || "",
      });
    });
  });

  return rows;
}