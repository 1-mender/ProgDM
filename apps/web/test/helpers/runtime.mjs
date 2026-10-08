import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(new URL("../../package.json", import.meta.url));

export function loadTs(path, overrides = {}, cache = new Map()) {
  const file = path instanceof URL ? fileURLToPath(path) : resolve(path);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const code = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText;
  new Function("require", "module", "exports", code)((name) => {
    if (Object.hasOwn(overrides, name)) return overrides[name];
    if (name.endsWith(".css")) return {};
    if (name.startsWith(".")) {
      const base = resolve(dirname(file), name);
      for (const candidate of [base, base + ".ts", base + ".tsx"]) {
        if (existsSync(candidate)) return loadTs(candidate, overrides, cache);
      }
    }
    return require(name);
  }, module, module.exports);
  return module.exports;
}

// Exercises real component handlers/effects, not DOM layout or a full React renderer.
export function componentRuntime() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let dirty = false;
  let tree;
  let Component;
  let props;
  const memo = (factory, dependencies) => {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || !dependencies || dependencies.some((item, i) => !Object.is(item, previous.dependencies[i]))) {
      slots[index] = { value: factory(), dependencies };
    }
    return slots[index].value;
  };
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; dirty = true; }];
    },
    useRef(initial) { return memo(() => ({ current: initial }), []); },
    useMemo: memo,
    useCallback: (callback, deps) => memo(() => callback, deps),
    useEffect(callback, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || !deps || deps.some((item, i) => !Object.is(item, previous.dependencies[i]))) {
        effects.push(() => {
          previous?.cleanup?.();
          slots[index] = { dependencies: deps, cleanup: callback() };
        });
      }
    },
    useLayoutEffect(callback, deps) { react.useEffect(callback, deps); }
  };
  const render = () => {
    let iterations = 0;
    do {
      if (++iterations > 30) throw new Error("Render did not settle");
      cursor = 0; dirty = false; effects = [];
      tree = Component(props);
      for (const effect of effects) effect();
    } while (dirty);
    return tree;
  };
  return {
    react,
    mount(component, properties) { Component = component; props = properties; return render(); },
    rerender(properties) { props = properties; return render(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
    render,
    async settle() {
      for (let i = 0; i < 5; i++) { await new Promise((done) => setImmediate(done)); render(); }
      return tree;
    },
    get tree() { return tree; }
  };
}

export function elements(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((node) => elements(node, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [...(predicate(tree) ? [tree] : []), ...elements(tree.props?.children, predicate)];
}

export function button(tree, text) {
  return elements(tree, (node) => node.type === "button" && JSON.stringify(node.props.children).includes(text))[0];
}

export function memoryStorage() {
  const values = new Map();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

export function setGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete globalThis[name];
  });
}
