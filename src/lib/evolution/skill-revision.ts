export function opaqueContentRevision(
  namespace: string,
  origin: string,
  content: string | null,
): string {
  const input = JSON.stringify([namespace, origin, content]);
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ (code + index), 0x85ebca6b);
  }
  return [
    namespace,
    "v1",
    origin,
    content === null ? "absent" : "present",
    input.length.toString(36),
    (left >>> 0).toString(36),
    (right >>> 0).toString(36),
  ].join(":");
}
