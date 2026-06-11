/**
 * Fake S3 en-process : un handler `(req: Request) => Promise<Response>` qui
 * implémente GET / PUT / HEAD sur une Map en mémoire, avec ETags et écritures
 * conditionnelles (If-None-Match: * et If-Match: <etag>).
 *
 * Fidélité visée (suffisante pour valider le CAS) :
 *  - GET objet absent → 404 ; présent → 200 + corps + ETag.
 *  - HEAD absent → 404 ; présent → 200 + ETag, sans corps.
 *  - PUT pose/écrase l'objet, renvoie 200 + nouvel ETag.
 *  - If-None-Match: *  → 412 si l'objet existe déjà (création atomique).
 *  - If-Match: <etag>  → 412 si l'objet est absent ou si son ETag diffère.
 *  - Les écritures conditionnelles sont évaluées atomiquement (pas d'await entre
 *    le test de précondition et la pose) → un seul gagnant sur des PUT concurrents.
 *
 * Branché comme `fetchImpl` (l'adaptateur bypasse la signature SigV4 dans ce mode).
 */
export interface FakeS3Options {
  /** Force toutes les réponses PUT conditionnelles à 501 (backend sans support). */
  noConditional?: boolean;
  /** N'émet jamais d'ETag (simule un backend cassé pour le CAS). */
  noEtag?: boolean;
  /** Taille de page ListObjectsV2 (défaut 1000). Petit → exerce la pagination. */
  listPageSize?: number;
}

interface StoredObject {
  body: Uint8Array;
  etag: string;
}

export class FakeS3 {
  readonly objects = new Map<string, StoredObject>();
  #counter = 0;
  putCount = 0;
  deleteCount = 0;

  constructor(private readonly opts: FakeS3Options = {}) {}

  #nextEtag(): string {
    this.#counter += 1;
    return `"etag-${this.#counter}"`;
  }

  /** La clé objet = path de l'URL (sans le slash initial). */
  #keyOf(url: string): string {
    return new URL(url).pathname.replace(/^\/+/, "");
  }

  /** Réponse XML ListObjectsV2 : tri lexicographique + pagination par token. */
  #listObjectsV2(params: URLSearchParams): Response {
    // Le prefix S3 inclut le path du bucket : nos clés stockées commencent par
    // "<bucket>/...". On reconstruit donc le prefix complet attendu.
    const prefix = params.get("prefix") ?? "";
    const pageSize = this.opts.listPageSize ?? 1000;
    const token = params.get("continuation-token");

    // Les clés stockées sont "<bucket>/<prefix-complet>" ; le prefix de la
    // requête est relatif au bucket. On matche sur le suffixe après "<bucket>/".
    const matched = [...this.objects.keys()]
      .map((full) => ({ full, rel: full.replace(/^[^/]+\//, "") }))
      .filter(({ rel }) => rel.startsWith(prefix))
      .map(({ rel }) => rel)
      .sort();

    const start = token ? matched.findIndex((k) => k > token) : 0;
    const from = start < 0 ? matched.length : start;
    const page = matched.slice(from, from + pageSize);
    const truncated = from + pageSize < matched.length;
    const nextToken = truncated ? page[page.length - 1] : undefined;

    const keysXml = page.map((k) => `<Contents><Key>${escapeXml(k)}</Key></Contents>`).join("");
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<ListBucketResult>` +
      `<IsTruncated>${truncated}</IsTruncated>` +
      keysXml +
      (nextToken ? `<NextContinuationToken>${escapeXml(nextToken)}</NextContinuationToken>` : "") +
      `</ListBucketResult>`;
    return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
  }

  readonly fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    const parsed = new URL(url);
    const key = this.#keyOf(url);
    const headers = new Headers(init.headers);

    // ListObjectsV2 : GET sur la racine du bucket avec ?list-type=2&prefix=...
    if (method === "GET" && parsed.searchParams.get("list-type") === "2") {
      return this.#listObjectsV2(parsed.searchParams);
    }

    if (method === "DELETE") {
      const existed = this.objects.delete(key);
      this.deleteCount += 1;
      // S3 renvoie 204 No Content que l'objet ait existé ou non.
      return new Response(null, { status: existed ? 204 : 204 });
    }

    if (method === "GET") {
      const existing = this.objects.get(key);
      if (!existing) return new Response("NoSuchKey", { status: 404 });
      return new Response(toArrayBuffer(existing.body), {
        status: 200,
        headers: this.opts.noEtag ? {} : { etag: existing.etag },
      });
    }

    if (method === "HEAD") {
      const existing = this.objects.get(key);
      if (!existing) return new Response(null, { status: 404 });
      return new Response(null, {
        status: 200,
        headers: this.opts.noEtag ? {} : { etag: existing.etag },
      });
    }

    if (method === "PUT") {
      const ifNoneMatch = headers.get("if-none-match");
      const ifMatch = headers.get("if-match");
      const conditional = ifNoneMatch !== null || ifMatch !== null;

      if (conditional && this.opts.noConditional) {
        return new Response("NotImplemented", { status: 501 });
      }

      // On draine le corps AVANT de tester les préconditions, pour que la
      // séquence test-précondition → pose soit ensuite synchrone (aucun await
      // entre les deux) : c'est ce qui garantit « exactement un gagnant » sur
      // des PUT conditionnels concurrents.
      const bodyBytes = await readBody(init.body);
      // --- section critique synchrone ---
      const cur = this.objects.get(key);
      if (ifNoneMatch === "*" && cur) {
        return new Response("PreconditionFailed", { status: 412 });
      }
      if (ifMatch !== null) {
        if (!cur || cur.etag !== ifMatch) {
          return new Response("PreconditionFailed", { status: 412 });
        }
      }
      const etag = this.#nextEtag();
      this.objects.set(key, { body: bodyBytes, etag });
      this.putCount += 1;
      return new Response(null, { status: 200, headers: this.opts.noEtag ? {} : { etag } });
    }

    return new Response("MethodNotAllowed", { status: 405 });
  };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function readBody(body: RequestInit["body"]): Promise<Uint8Array> {
  if (body == null) return new Uint8Array();
  if (body instanceof Uint8Array) return new Uint8Array(toArrayBuffer(body));
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  // Fallback : Request/ReadableStream → on passe par Response pour drainer.
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(data);
  return bytes.buffer;
}
