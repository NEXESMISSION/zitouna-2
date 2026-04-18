// Pure helpers for traversing the Zitouna referral/parrainage tree.
// Inputs are plain rows from public.seller_relations + commission_events;
// this module performs no I/O and has no React / Supabase dependency.

const DEFAULT_MAX_DEPTH = 40;

// Normalize any id-ish value to a string key (Map keys stay consistent even
// when callers mix uuids, ints, or numeric strings).
function asId(value) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length ? s : null;
}

// Build childId -> parentId from seller_relations rows.
// Later rows overwrite earlier ones, mirroring the unique(child_client_id) rule.
export function buildParentMap(sellerRelations) {
  const map = new Map();
  if (!Array.isArray(sellerRelations)) return map;
  for (const row of sellerRelations) {
    if (!row) continue;
    const child = asId(row.child_client_id);
    const parent = asId(row.parent_client_id);
    if (!child || !parent || child === parent) continue; // skip self-parenting
    map.set(child, parent);
  }
  return map;
}

// Build parentId -> [childId, ...]. Preserves insertion order per parent.
export function buildChildrenMap(sellerRelations) {
  const map = new Map();
  if (!Array.isArray(sellerRelations)) return map;
  for (const row of sellerRelations) {
    if (!row) continue;
    const child = asId(row.child_client_id);
    const parent = asId(row.parent_client_id);
    if (!child || !parent || child === parent) continue;
    const bucket = map.get(parent);
    if (bucket) {
      if (!bucket.includes(child)) bucket.push(child);
    } else {
      map.set(parent, [child]);
    }
  }
  return map;
}

// Walk from clientId up to the root ancestor.
// Returned array starts with clientId itself (depth 0) and ends with the
// farthest reachable ancestor. Cycles short-circuit via `seen`; depth is
// bounded by maxDepth so a corrupt chain can never hang the caller.
export function resolveUplineChain(clientId, parentMap, options = {}) {
  const { maxDepth = DEFAULT_MAX_DEPTH } = options;
  const start = asId(clientId);
  if (!start || !(parentMap instanceof Map)) return start ? [start] : [];

  const chain = [start];
  const seen = new Set([start]);
  let cursor = start;
  // +1 because the starting node is already counted in the chain.
  while (chain.length < maxDepth + 1) {
    const parent = parentMap.get(cursor);
    if (!parent || seen.has(parent)) break;
    chain.push(parent);
    seen.add(parent);
    cursor = parent;
  }
  return chain;
}

// Build a nested downline tree rooted at clientId using BFS.
// Node shape: { id, depth, children: [...] }.
// `seen` is shared across the traversal so a descendant that re-points to an
// ancestor (cycle) or a DAG cross-edge only appears once.
export function resolveDownlineTree(clientId, childrenMap, options = {}) {
  const { maxDepth = DEFAULT_MAX_DEPTH } = options;
  const rootId = asId(clientId);
  if (!rootId) return null;

  const root = { id: rootId, depth: 0, children: [] };
  if (!(childrenMap instanceof Map)) return root;

  const seen = new Set([rootId]);
  const queue = [root]; // BFS: expand shallower nodes before deeper ones.
  while (queue.length) {
    const node = queue.shift();
    if (node.depth >= maxDepth) continue; // stop descending, keep node itself
    const kids = childrenMap.get(node.id);
    if (!kids || !kids.length) continue;
    for (const rawChildId of kids) {
      const childId = asId(rawChildId);
      if (!childId || seen.has(childId)) continue;
      seen.add(childId);
      const childNode = { id: childId, depth: node.depth + 1, children: [] };
      node.children.push(childNode);
      queue.push(childNode);
    }
  }
  return root;
}

// Flatten a downline tree (from resolveDownlineTree) into a table-friendly
// array. Output order is a pre-order DFS so parents appear before children,
// which is what the admin table rendering expects.
export function flattenTree(tree) {
  const rows = [];
  if (!tree || !tree.id) return rows;

  const stack = [{ node: tree, parentId: null }];
  while (stack.length) {
    const { node, parentId } = stack.pop();
    rows.push({ id: node.id, depth: node.depth, parentId });
    const children = Array.isArray(node.children) ? node.children : [];
    // Push in reverse so the first child is processed first (pre-order DFS).
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child && child.id) stack.push({ node: child, parentId: node.id });
    }
  }
  return rows;
}

// Sum commission_events where the given client is the beneficiary.
// Recognises `level` values 1/2 (or "l1"/"l2") and returns numeric totals;
// `total` is the sum of all matching events regardless of level, so callers
// can show beneficiary totals even if a new level gets added later.
export function summarizeCommissionsForClient(commissionEvents, clientId) {
  const totals = { l1: 0, l2: 0, total: 0 };
  const target = asId(clientId);
  if (!target || !Array.isArray(commissionEvents)) return totals;

  for (const event of commissionEvents) {
    if (!event) continue;
    const beneficiary = asId(
      event.beneficiary_client_id ?? event.client_id ?? event.parent_client_id,
    );
    if (beneficiary !== target) continue;

    const rawAmount = event.amount ?? event.commission_amount ?? 0;
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount)) continue;

    const rawLevel = event.level ?? event.tier;
    const levelKey = typeof rawLevel === 'string'
      ? rawLevel.toLowerCase().replace(/^l/, '')
      : String(rawLevel);
    if (levelKey === '1') totals.l1 += amount;
    else if (levelKey === '2') totals.l2 += amount;
    totals.total += amount;
  }
  return totals;
}
