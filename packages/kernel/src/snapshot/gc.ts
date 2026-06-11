import { KernelError } from "../errors.js";
import type { ListableSnapshotStore } from "./store.js";

export interface GcOptions {
  /**
   * Racines vivantes : ids de snapshots encore référencés. C'est l'HÔTE qui les
   * fournit — il connaît ses pointeurs / sa base. Pattern usuel (un pointeur par
   * user connu) :
   *
   * ```ts
   * const roots: string[] = [];
   * for (const userId of knownUserIds) {
   *   const p = await pointers.get(userId);
   *   if (p) roots.push(p.snapshotId);
   * }
   * await gcSnapshots(store, { roots });
   * ```
   *
   * À enrichir avec les snapshots référencés par des sessions / threads actifs.
   *
   * IMPORTANT — réachabilité par POINTEUR, pas par lignée : un snapshot orphelin
   * (commit perdant d'un CAS) n'est PAS une racine, même si une racine vivante
   * descend de lui. La chaîne `meta.workspace.parent` ne sert qu'à
   * {@link GcOptions.keepLineageDepth}, jamais à élargir l'ensemble des racines.
   */
  roots: Iterable<string>;
  /**
   * Conserve EN PLUS les N ancêtres de chaque racine, remontés via
   * `meta.workspace.parent` (résolus par getTree). Défaut 0 = racines seules.
   * Un ancêtre absent du store interrompt silencieusement la remontée.
   */
  keepLineageDepth?: number;
  /** Ne supprime rien ; renvoie quand même les compteurs (audit). */
  dryRun?: boolean;
  /**
   * Autorise un GC alors que `roots` est vide et que le store contient ≥1 arbre.
   * Sans ce drapeau ce cas lève EINVAL — garde-fou contre un bug qui viderait
   * tout le bucket.
   */
  force?: boolean;
}

export interface GcResult {
  keptTrees: number;
  deletedTrees: number;
  keptBlobs: number;
  deletedBlobs: number;
}

/**
 * Garbage-collect un store de snapshots par mark-and-sweep depuis des racines
 * vivantes (content-addressed → la suppression est sûre tant qu'on part des
 * pointeurs réellement référencés).
 *
 * Algorithme :
 *  1. Ensemble gardé = racines (+ ancêtres jusqu'à `keepLineageDepth`).
 *  2. MARK : pour chaque arbre gardé, collecte les hashes de blobs de ses entrées.
 *  3. SWEEP arbres : tout arbre listé hors de l'ensemble gardé → deleteTree.
 *  4. SWEEP blobs : tout blob listé non marqué → deleteBlob.
 *
 * CONCURRENCE — à exécuter SANS commit en vol sur les workspaces concernés
 * (fenêtre de maintenance, ou après avoir pris les locks user de l'hôte). Sinon
 * race : un commit concurrent du sweep peut écrire un arbre après le listing ;
 * ses blobs déjà présents, s'ils n'étaient partagés QU'avec des arbres morts,
 * seraient balayés. La réécriture par re-snapshot ne couvre pas ce cas.
 */
export async function gcSnapshots(store: ListableSnapshotStore, opts: GcOptions): Promise<GcResult> {
  const depth = opts.keepLineageDepth ?? 0;

  // --- 1. Ensemble gardé : racines + ancêtres de lignée ---
  const kept = new Set<string>(opts.roots);
  if (depth > 0) {
    for (const root of [...kept]) {
      let current: string | null = root;
      for (let i = 0; i < depth && current; i += 1) {
        const manifest = await store.getTree(current);
        const parent = extractParent(manifest?.meta);
        if (!parent) break; // racine de lignée ou ancêtre absent → stop
        kept.add(parent);
        current = parent;
      }
    }
  }

  // --- Garde-fou : pas de racines + store non vide = refus ---
  if (kept.size === 0 && !opts.force) {
    for await (const _ of store.listTrees()) {
      throw new KernelError("EINVAL", "refusing to GC with no roots");
    }
  }

  // --- 2. MARK : blobs atteignables depuis les arbres gardés ---
  const markedBlobs = new Set<string>();
  for (const id of kept) {
    const manifest = await store.getTree(id);
    if (!manifest) continue; // racine pointant un arbre absent → ignorée
    for (const entry of Object.values(manifest.entries)) {
      if (entry.kind === "file") markedBlobs.add(entry.hash);
    }
  }

  // --- 3. SWEEP arbres ---
  let keptTrees = 0;
  let deletedTrees = 0;
  for await (const id of store.listTrees()) {
    if (kept.has(id)) {
      keptTrees += 1;
    } else {
      deletedTrees += 1;
      if (!opts.dryRun) await store.deleteTree(id);
    }
  }

  // --- 4. SWEEP blobs ---
  let keptBlobs = 0;
  let deletedBlobs = 0;
  for await (const hash of store.listBlobs()) {
    if (markedBlobs.has(hash)) {
      keptBlobs += 1;
    } else {
      deletedBlobs += 1;
      if (!opts.dryRun) await store.deleteBlob(hash);
    }
  }

  return { keptTrees, deletedTrees, keptBlobs, deletedBlobs };
}

/** Extrait `meta.workspace.parent` (string | null) d'un meta opaque, défensivement. */
function extractParent(meta: unknown): string | null {
  if (typeof meta !== "object" || meta === null) return null;
  const ws = (meta as { workspace?: unknown }).workspace;
  if (typeof ws !== "object" || ws === null) return null;
  const parent = (ws as { parent?: unknown }).parent;
  return typeof parent === "string" ? parent : null;
}
