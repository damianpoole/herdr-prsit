export const host = {
  props: {},
  calls: [],
  timers: [],
  exec: async () => {
    throw new Error("Unexpected backend call");
  },
  layout: {},
};
export class View {}
function element() {
  const node = { children: [], attributes: {} };
  let proxy;
  proxy = new Proxy(node, {
    get(target, key) {
      if (key === "child")
        return (child) => {
          target.children.push(child);
          return proxy;
        };
      if (key === "children")
        return (children) => {
          target.children.push(...children);
          return proxy;
        };
      if (key === "when") return (condition, fn) => (condition ? fn(proxy) : proxy);
      if (key === "attributes") return target.attributes;
      if (key === "nodes") return target.children;
      return (...args) => {
        target.attributes[key] = args;
        return proxy;
      };
    },
  });
  return proxy;
}
export const div = element,
  h_flex = element,
  v_flex = element;
export const InputState = {
  new(options) {
    let value = options.value ?? "";
    return {
      value: () => value,
      set_value: (next) => {
        value = next;
      },
      focus() {},
    };
  },
};
export const Input = { new: element };
export const exec = (...args) => host.exec(...args);
export const props = () => host.props;
export const layout = () => host.layout;
export const theme = () => new Proxy({}, { get: (_target, key) => String(key) });
export const run = (...args) => host.calls.push(args);
export const notify = (notification) => host.calls.push(["notify", notification]);
export const focused = () => ({ space: "fixture-space" });
export const panes = () => [];
export const nextCommand = () => new Promise(() => {});
export function context() {
  return {
    notify() {},
    focus_handle: () => ({ focus() {} }),
    timer: { every: (_ms, fn) => host.timers.push(fn) },
    spawn(fn) {
      fn(this).catch((e) => {
        host.error = e;
      });
    },
  };
}
export function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.attributes?.id?.[0] === id) return node;
  for (const child of node.nodes ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
