// In-memory Raindrop client for engine tests (patched onto RaindropClient via
// patchClient). Collections, live raindrops and Trash are plain Maps; `_calls`
// counts requests per method so tests can assert on API spend.
//
// exportRaindropsCsv returns a real `id,title,url` CSV of the live (non-Trash)
// raindrops, the same shape the presence snapshot parses.

/** Quote one CSV field (RFC 4180). */
function csvField(v) {
  const t = String(v ?? "");
  return /[",\n\r]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t;
}

/** One listRaindrops page of `all` plus the total count. */
function pageOf(all, page, perPage) {
  const start = page * perPage;
  return { items: all.slice(start, start + perPage), count: all.length };
}

export function makeMockRaindrop() {
  let seq = 1;
  const collections = new Map(); // id -> { _id, title, parent }
  const raindrops = new Map(); // id -> item
  const trash = new Map();
  /** @type {{ listRaindrops: number, createRaindrop: number, deleteRaindrop: number, exportRaindropsCsv: number, getRaindrop: number, updateRaindrop: number, searchRaindrops: number }} */
  const calls = {
    listRaindrops: 0,
    createRaindrop: 0,
    deleteRaindrop: 0,
    exportRaindropsCsv: 0,
    getRaindrop: 0,
    updateRaindrop: 0,
    searchRaindrops: 0,
  };

  /** Store a new live raindrop with a fresh id. */
  const addRaindrop = (collectionId, { link, title, tags, note }) => {
    const _id = seq++;
    const item = {
      _id,
      link,
      title,
      collection: { $id: collectionId },
      tags: tags || [],
      note: note || "",
    };
    raindrops.set(_id, item);
    return item;
  };

  return {
    async getUser() {
      return { _id: 1, fullName: "mock" };
    },
    async getRootCollections() {
      return [...collections.values()].filter((c) => !c.parent?.$id);
    },
    async getChildCollections() {
      return [...collections.values()].filter((c) => c.parent?.$id);
    },
    async createCollection(title, parentId) {
      const _id = seq++;
      const item = {
        _id,
        title,
        parent: parentId != null ? { $id: parentId } : null,
      };
      collections.set(_id, item);
      return item;
    },
    async createRaindrop({ link, title, collectionId }) {
      calls.createRaindrop++;
      return addRaindrop(collectionId, { link, title: title || link });
    },
    async listRaindrops(
      collectionId,
      { nested = false, page = 0, perPage = 50, search = undefined } = {}
    ) {
      calls.listRaindrops++;
      // Trash is a system collection — items live in `_trash`, not under a real parent.
      if (Number(collectionId) === -99) {
        return pageOf([...trash.values()], page, perPage);
      }
      if (search != null && String(search).trim() !== "") {
        const q = String(search).toLowerCase();
        const all = [...raindrops.values()].filter(
          (r) =>
            String(r.link || "")
              .toLowerCase()
              .includes(q) ||
            String(r.title || "")
              .toLowerCase()
              .includes(q)
        );
        return pageOf(all, page, perPage);
      }
      const under = new Set();
      const walk = (id) => {
        under.add(Number(id));
        for (const c of collections.values()) {
          if (c.parent?.$id === Number(id) || String(c.parent?.$id) === String(id)) walk(c._id);
        }
      };
      if (nested) walk(collectionId);
      else under.add(Number(collectionId));
      const all = [...raindrops.values()].filter((r) => under.has(Number(r.collection?.$id)));
      return pageOf(all, page, perPage);
    },
    async searchRaindrops(query, { perPage = 50 } = {}) {
      calls.searchRaindrops++;
      return this.listRaindrops(0, { page: 0, perPage, search: query });
    },
    async getRaindrop(id) {
      calls.getRaindrop++;
      // Live items only — trashed ids are "gone" for delete-detection confirms.
      return raindrops.get(Number(id)) || null;
    },
    async updateRaindrop(id, patch) {
      calls.updateRaindrop++;
      const item = raindrops.get(Number(id));
      if (!item) throw new Error(`Raindrop PUT /raindrop/${id} failed: 404`);
      if (patch.link != null) item.link = patch.link;
      if (patch.title != null) item.title = patch.title;
      if (patch.collectionId != null) item.collection = { $id: patch.collectionId };
      // intentionally never clear tags/note unless provided — engine won't send them
      return item;
    },
    async updateCollection(id, { title } = {}) {
      const item = collections.get(Number(id));
      if (!item) throw new Error(`Raindrop PUT /collection/${id} failed: 404`);
      if (title != null) item.title = title;
      return item;
    },
    async deleteRaindrop(id) {
      calls.deleteRaindrop++;
      const item = raindrops.get(Number(id));
      if (item) {
        raindrops.delete(Number(id));
        trash.set(Number(id), { ...item, collection: { $id: -99 } });
      }
    },
    async exportRaindropsCsv(collectionId = 0) {
      calls.exportRaindropsCsv++;
      void collectionId;
      const rows = [...raindrops.values()].map((r) =>
        [r._id, r.title, r.link].map(csvField).join(",")
      );
      return ["id,title,url", ...rows].join("\n") + "\n";
    },
    // test helpers
    _collections: collections,
    _raindrops: raindrops,
    _trash: trash,
    _calls: calls,
    /** Total requests across every counted method. */
    _totalCalls() {
      return Object.values(calls).reduce((a, b) => a + b, 0);
    },
    _seedRich(collectionId, fields) {
      return addRaindrop(collectionId, fields);
    },
  };
}
