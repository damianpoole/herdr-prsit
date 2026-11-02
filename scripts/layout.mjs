// Pure layout transformation; never edit Ship-it's mod files or shared caches.
export function integrateLayout(input) {
  const tree = structuredClone(input);
  const nodes = new Map();
  function scan(node) {
    if (!node || typeof node !== "object") return;
    if (node.id) {
      if (nodes.has(node.id)) throw new Error(`Duplicate layout id: ${node.id}`);
      nodes.set(node.id, node);
    }
    for (const child of node.children ?? []) scan(child);
  }
  scan(tree);
  for (const [id, role] of [
    ["prsit-strip", "strip"],
    ["prsit-panel", "panel"],
  ]) {
    const existing = nodes.get(id);
    if (existing && (existing.content?.mod !== "prsit" || existing.content?.props?.role !== role))
      throw new Error(`Layout id ${id} belongs to another block`);
  }
  const block = (id, role) => ({ id, type: "block", content: { mod: "prsit", props: { role } } });
  if (!nodes.has("prsit-strip")) {
    if (nodes.has("prsit-toolbar")) throw new Error("Layout id prsit-toolbar is already taken");
    let inserted = false;
    function insert(node) {
      if (!node || inserted) return;
      const children = node.children ?? [];
      const ship = children.findIndex((child) => child.content?.mod === "ship-it");
      if (ship >= 0) {
        const original = children[ship];
        const size = original.size ?? { px: 40 };
        delete original.size;
        children.splice(ship, 1, {
          id: "prsit-toolbar",
          type: "row",
          size,
          resizable: false,
          children: [
            { ...original, size: { weight: 1 } },
            { ...block("prsit-strip", "strip"), size: { px: 210 } },
          ],
        });
        inserted = true;
        return;
      }
      for (const child of children) insert(child);
    }
    insert(tree);
    if (!inserted) {
      function afterTabs(node) {
        if (!node || inserted) return;
        const children = node.children ?? [];
        const tabs = children.findIndex(
          (child) => child.id === "tabs" || child.content?.mod === "tabs",
        );
        if (tabs >= 0) {
          children.splice(tabs + 1, 0, { ...block("prsit-strip", "strip"), size: { px: 40 } });
          inserted = true;
          return;
        }
        for (const child of children) afterTabs(child);
      }
      afterTabs(tree);
    }
    if (!inserted)
      throw new Error("No Ship-it strip or tabs block found; add the PR Sitter block manually");
  }
  const panel = nodes.get("panel-body");
  if (panel && panel.type === "stack" && !nodes.has("prsit-panel")) {
    panel.children ??= [];
    panel.children.push(block("prsit-panel", "panel"));
  }
  return tree;
}
