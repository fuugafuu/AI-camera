import type {
  FaceAnalysis,
  MatchCandidate,
  RegisteredFaceDescriptor,
  RegisteredPerson,
} from "../types";
import { cosineSimilarity, normalizeVector } from "./geometry";

const DB_NAME = "assist-camera-face-db";
const DB_VERSION = 1;
const PEOPLE_STORE = "people";
const SETTINGS_STORE = "settings";

let dbPromise: Promise<IDBDatabase> | null = null;

export async function openFaceDb(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PEOPLE_STORE)) {
        db.createObjectStore(PEOPLE_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

export async function listPeople(): Promise<RegisteredPerson[]> {
  const db = await openFaceDb();
  return transactionRequest<RegisteredPerson[]>((resolve, reject) => {
    const tx = db.transaction(PEOPLE_STORE, "readonly");
    const request = tx.objectStore(PEOPLE_STORE).getAll();
    request.onsuccess = () =>
      resolve(
        (request.result as RegisteredPerson[]).sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        ),
      );
    request.onerror = () => reject(request.error);
  });
}

export async function upsertPerson(person: RegisteredPerson): Promise<void> {
  const db = await openFaceDb();
  return transactionRequest<void>((resolve, reject) => {
    const tx = db.transaction(PEOPLE_STORE, "readwrite");
    const request = tx.objectStore(PEOPLE_STORE).put(person);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function deletePerson(personId: string): Promise<void> {
  const db = await openFaceDb();
  return transactionRequest<void>((resolve, reject) => {
    const tx = db.transaction(PEOPLE_STORE, "readwrite");
    const request = tx.objectStore(PEOPLE_STORE).delete(personId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function clearFaceData(): Promise<void> {
  const db = await openFaceDb();
  return transactionRequest<void>((resolve, reject) => {
    const tx = db.transaction(PEOPLE_STORE, "readwrite");
    const request = tx.objectStore(PEOPLE_STORE).clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function saveDescriptor(params: {
  name: string;
  vector: number[];
  analysis: FaceAnalysis;
  personId?: string;
  iconDataUrl?: string;
}): Promise<RegisteredPerson> {
  const people = await listPeople();
  const now = new Date().toISOString();
  const normalized = normalizeVector(params.vector);
  const descriptor: RegisteredFaceDescriptor = {
    id: crypto.randomUUID(),
    vector: normalized,
    quality: registrationQualityScore(params.analysis),
    createdAt: now,
    source: params.personId ? "additional" : "registration",
  };
  const existing =
    params.personId !== undefined ? people.find((person) => person.id === params.personId) : undefined;
  const person: RegisteredPerson = existing
    ? {
        ...existing,
        name: params.name.trim() || existing.name,
        iconDataUrl: params.iconDataUrl ?? existing.iconDataUrl,
        descriptors: [...existing.descriptors, descriptor],
        updatedAt: now,
      }
    : {
        id: crypto.randomUUID(),
        name: params.name.trim(),
        iconDataUrl: params.iconDataUrl,
        descriptors: [descriptor],
        createdAt: now,
        updatedAt: now,
      };
  await upsertPerson(person);
  return person;
}

export async function renamePerson(personId: string, name: string): Promise<void> {
  const people = await listPeople();
  const person = people.find((item) => item.id === personId);
  if (!person) {
    return;
  }
  await upsertPerson({ ...person, name: name.trim() || person.name, updatedAt: new Date().toISOString() });
}

export async function removeDescriptor(personId: string, descriptorId: string): Promise<void> {
  const people = await listPeople();
  const person = people.find((item) => item.id === personId);
  if (!person) {
    return;
  }
  await upsertPerson({
    ...person,
    descriptors: person.descriptors.filter((descriptor) => descriptor.id !== descriptorId),
    updatedAt: new Date().toISOString(),
  });
}

export async function matchRegisteredPeople(
  vector: number[],
  allowedPersonIds?: string[],
): Promise<MatchCandidate[]> {
  const normalized = normalizeVector(vector);
  const people = await listPeople();
  const allowed = allowedPersonIds ? new Set(allowedPersonIds) : null;
  const candidates: MatchCandidate[] = [];
  for (const person of people) {
    if (allowed && !allowed.has(person.id)) {
      continue;
    }
    for (const descriptor of person.descriptors) {
      const confidence = Math.round(clamp01(cosineSimilarity(normalized, descriptor.vector)) * 100);
      candidates.push({
        personId: person.id,
        name: person.name,
        confidence,
        descriptorId: descriptor.id,
      });
    }
  }
  return candidates.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}

export function classifyCandidates(candidates: MatchCandidate[]): {
  status: "matched" | "candidate" | "multiple" | "none";
  matchedName?: string;
} {
  const high = candidates.filter((candidate) => candidate.confidence >= 85);
  if (high.length === 1) {
    return { status: "matched", matchedName: high[0].name };
  }
  if (high.length > 1) {
    return { status: "multiple" };
  }
  const medium = candidates.filter((candidate) => candidate.confidence >= 70);
  if (medium.length > 0) {
    return { status: medium.length > 1 ? "multiple" : "candidate" };
  }
  return { status: "none" };
}

export function canRegisterFace(analysis: FaceAnalysis, boxAreaRatio: number): {
  ok: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (boxAreaRatio < 0.035) {
    reasons.push("顔が小さすぎます");
  }
  if (analysis.blur === "high" || analysis.focus === "soft") {
    reasons.push("ブレが大きいです");
  }
  if (analysis.brightness !== "ok") {
    reasons.push("明るさを調整してください");
  }
  if (analysis.pose === "turned") {
    reasons.push("顔の向きが外れています");
  }
  return { ok: reasons.length === 0, reasons };
}

function registrationQualityScore(analysis: FaceAnalysis): number {
  let score = 100;
  if (analysis.blur === "medium") {
    score -= 12;
  }
  if (analysis.blur === "high") {
    score -= 35;
  }
  if (analysis.brightness !== "ok") {
    score -= 18;
  }
  if (analysis.pose === "turned") {
    score -= 20;
  }
  score -= Math.round((1 - analysis.trackingStability) * 12);
  return Math.max(0, score);
}

function transactionRequest<T>(
  factory: (resolve: (value: T) => void, reject: (reason?: unknown) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => factory(resolve, reject));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
