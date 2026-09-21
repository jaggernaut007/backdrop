import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VolumeImageStore } from "../../src/adapters/volume-image-store.js";
import type { Config } from "../../src/config.js";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]);

describe("VolumeImageStore", () => {
  let dir: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let store: VolumeImageStore;

  const config = (): Config =>
    ({ dataDir: dir, publicBaseUrl: "https://shots.up.railway.app" }) as Config;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "vis-"));
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    store = new VolumeImageStore(config());
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it("downloads the source URL, writes the bytes under images/, and returns a stable URL", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(PNG_BYTES, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    const url = await store.putFromUrl(
      "hg-002-styled-01.jpg",
      "https://luma.test/out.png?exp=1",
    );

    expect(url).toBe("https://shots.up.railway.app/img/hg-002-styled-01.jpg");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://luma.test/out.png?exp=1",
    );
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBeInstanceOf(
      AbortSignal,
    );
    const written = await readFile(
      path.join(dir, "images", "hg-002-styled-01.jpg"),
    );
    expect(written.equals(PNG_BYTES)).toBe(true);
  });

  it("refuses a non-image payload (an expired presigned URL answers with XML, HTTP 200)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<Error>AccessDenied</Error>", {
        status: 200,
        headers: { "content-type": "application/xml" },
      }),
    );
    await expect(
      store.putFromUrl("x.jpg", "https://luma.test/expired"),
    ).rejects.toThrow(/non-image payload/);
  });

  it("throws on a non-2xx download", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 403 }));
    await expect(
      store.putFromUrl("x.jpg", "https://luma.test/403"),
    ).rejects.toThrow(/HTTP 403/);
  });

  it("throws on a 0-byte body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(Buffer.alloc(0), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    await expect(
      store.putFromUrl("x.jpg", "https://luma.test/empty"),
    ).rejects.toThrow(/0 bytes/);
  });

  it("rejects a filename that resolves to nothing safe, before any download", async () => {
    await expect(store.putFromUrl("..", "https://luma.test/x")).rejects.toThrow(
      /invalid image filename/,
    );
    await expect(store.putFromUrl("/", "https://luma.test/x")).rejects.toThrow(
      /invalid image filename/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a 200 that omits content-type (some presigned stores do)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(PNG_BYTES, { status: 200 }));
    const url = await store.putFromUrl(
      "hg-002-draft-abcd1234.jpg",
      "https://luma.test/out",
    );
    expect(url).toBe(
      "https://shots.up.railway.app/img/hg-002-draft-abcd1234.jpg",
    );
  });

  it("rejects an image past the byte ceiling rather than buffering it whole", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(Buffer.alloc(26 * 1024 * 1024), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    await expect(
      store.putFromUrl("big.jpg", "https://luma.test/big"),
    ).rejects.toThrow(/over the .*-byte ceiling/);
  });

  it("strips any path in the filename — no directory traversal", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(PNG_BYTES, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    const url = await store.putFromUrl(
      "../../etc/evil.jpg",
      "https://luma.test/out.png",
    );
    expect(url).toBe("https://shots.up.railway.app/img/evil.jpg");
    await expect(
      readFile(path.join(dir, "images", "evil.jpg")),
    ).resolves.toBeInstanceOf(Buffer);
  });

  it("urlFor is the write-free stable URL for a filename", () => {
    expect(store.urlFor("hg-009-styled-02.jpg")).toBe(
      "https://shots.up.railway.app/img/hg-009-styled-02.jpg",
    );
  });
});
