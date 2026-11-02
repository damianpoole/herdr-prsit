export async function resolve(specifier, context, next) {
  if (["herdr", "gpui-kit", "gpui-base"].includes(specifier))
    return { url: new URL("./mod-host.mjs", import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
