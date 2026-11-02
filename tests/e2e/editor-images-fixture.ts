import type { Page } from "@playwright/test";

export const imageFixture = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="420" viewBox="0 0 600 420"><rect width="600" height="420" fill="#a3c7d1"/><circle cx="430" cy="120" r="56" fill="#f9d08c"/><path d="M0 300L170 135 330 310 440 220 600 330V420H0Z" fill="#55776c"/><path d="M0 360Q160 300 330 360T600 350V420H0Z" fill="#d5b698"/></svg>`);
const portraitFixture = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="420" height="600" viewBox="0 0 420 600"><rect width="420" height="600" fill="#a3c7d1"/><circle cx="290" cy="140" r="56" fill="#f9d08c"/><path d="M0 460L180 260 300 470 420 330V600H0Z" fill="#55776c"/><path d="M0 540Q140 490 300 560T420 540V600H0Z" fill="#d5b698"/></svg>`);
export const imageFile = (name: string) => ({ name, mimeType: "image/svg+xml", buffer: name === "evening.svg" || name === "two.svg" ? portraitFixture : imageFixture });
export const imageId = (n: number) => `img_${String(n).padStart(32, "0")}`;
export const imageSnapshot = (n: number, name: string, ref = `drafts/${imageId(n)}`) => ({ version: 1 as const, assetId: imageId(n), ref, name, mediaType: "image/svg+xml", width: n === 2 ? 420 : 600, height: n === 2 ? 600 : 420 });
export const replySse = (answer = "Offline fixture reply") => [
  { type: "start", messageId: "editor-image-reply" }, { type: "text-start", id: "text" },
  { type: "text-delta", id: "text", delta: answer }, { type: "text-end", id: "text" }, { type: "finish" },
].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";

export async function mockPhotoReads(page: Page) {
  await page.route("**/api/attachments?*", route => route.fulfill({ contentType: "image/svg+xml", body: decodeURIComponent(route.request().url()).includes(imageId(2)) ? portraitFixture : imageFixture }));
  await page.route("**/api/attachments/upload/*/cancel?*", route => route.fulfill({ json: { cancelled: true } }));
}

export async function mockUploads(page: Page) {
  let count = 0;
  await mockPhotoReads(page);
  await page.route("**/api/attachments/upload", route => {
    const name = /filename="([^"]+)"/.exec(route.request().postData() ?? "")?.[1] ?? "fixture.svg";
    return route.fulfill({ status: 201, json: { attachment: imageSnapshot(++count, name) } });
  });
}
