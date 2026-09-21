import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildHttpServer } from "../../src/runtime/http.js";

describe("GET /img/:filename", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "img-"));
  writeFileSync(
    path.join(dir, "hg-002-styled-01.jpg"),
    Buffer.from("JPEGBYTES"),
  );

  let app: Awaited<ReturnType<typeof buildHttpServer>> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("serves an existing published image with its bytes", async () => {
    app = await buildHttpServer({ imagesDir: dir, logger: false });
    const res = await app.inject({
      method: "GET",
      url: "/img/hg-002-styled-01.jpg",
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.toString()).toBe("JPEGBYTES");
    expect(res.headers["cache-control"]).toContain("max-age");
  });

  it("404s a missing image", async () => {
    app = await buildHttpServer({ imagesDir: dir, logger: false });
    const res = await app.inject({
      method: "GET",
      url: "/img/does-not-exist.jpg",
    });
    expect(res.statusCode).toBe(404);
  });

  it("blocks path traversal out of the images dir", async () => {
    app = await buildHttpServer({ imagesDir: dir, logger: false });
    for (const url of [
      "/img/../package.json",
      "/img/..%2f..%2fpackage.json",
      "/img/%2e%2e/%2e%2e/package.json",
    ]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.payload).not.toContain('"name": "backdrop"');
    }
  });

  it("does not directory-list at /img/", async () => {
    app = await buildHttpServer({ imagesDir: dir, logger: false });
    const res = await app.inject({ method: "GET", url: "/img/" });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  describe("R2 mode (imgRedirectBase set)", () => {
    it("302-redirects /img/<file> to the R2 public base", async () => {
      app = await buildHttpServer({
        imagesDir: dir,
        logger: false,
        imgRedirectBase: "https://pub-abc.r2.dev/",
      });
      const res = await app.inject({
        method: "GET",
        url: "/img/hg-044-styled-01.jpg",
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers["location"]).toBe(
        "https://pub-abc.r2.dev/hg-044-styled-01.jpg",
      );
    });

    it("refuses traversal / nested paths with a 404, no redirect", async () => {
      app = await buildHttpServer({
        imagesDir: dir,
        logger: false,
        imgRedirectBase: "https://pub-abc.r2.dev",
      });
      for (const url of ["/img/../package.json", "/img/a/b.jpg", "/img/"]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode).toBe(404);
      }
    });
  });
});
