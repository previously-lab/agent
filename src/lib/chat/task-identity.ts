function hashText(text: string, seed: number): number {
  let hash = seed;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}

export function stableTaskOperationId(namespace: string, parts: string[]): string {
  const material = JSON.stringify(parts);
  const plain = `${namespace}:${parts.join(":")}`;
  if (plain.length <= 200) return plain;
  const left = hashText(material, 0x811c9dc5).toString(36);
  const right = hashText(material, 0x9e3779b9).toString(36);
  return `${namespace}:${left}${right}`.slice(0, 200);
}
