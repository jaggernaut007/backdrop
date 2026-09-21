import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../../src/config.js";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]);

let s3SendMock = vi.fn().mockResolvedValue({});

vi.mock("@aws-sdk/client-s3", () => {
  class MockS3Client {
    send = s3SendMock;
  }
  class PutObjectCommand {
    _type = "PutObjectCommand";
    constructor(input: Record<string, unknown>) {
      Object.assign(this, input);
    }
  }
  class HeadObjectCommand {
    _type = "HeadObjectCommand";
    constructor(input: Record<string, unknown>) {
      Object.assign(this, input);
    }
  }
  return { S3Client: MockS3Client, PutObjectCommand, HeadObjectCommand };
});

// Import after mocking
import { R2ImageStore } from "../../src/adapters/r2-image-store.js";

describe("R2ImageStore", () => {
  let store: R2ImageStore;
  let fetchMock: ReturnType<typeof vi.fn>;

  const config = (): Config =>
    ({
      r2: {
        bucket: "images",
        endpoint: "https://abc123.r2.cloudflarestorage.com",
        accessKeyId: "test-key",
        secretAccessKey: "test-secret",
        publicBaseUrl: "https://pub-abc123.r2.dev",
      },
      dataDir: "/tmp",
      publicBaseUrl: "https://shots.up.railway.app",
    }) as Config;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    s3SendMock.mockClear();
    s3SendMock.mockResolvedValue({});
    store = new R2ImageStore(config());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads the source URL, uploads to R2, and returns a stable URL", async () => {
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

    expect(url).toBe("https://pub-abc123.r2.dev/hg-002-styled-01.jpg");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://luma.test/out.png?exp=1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(s3SendMock).toHaveBeenCalled();
    const putCmd = s3SendMock.mock.calls[0]?.[0];
    expect(putCmd?._type).toBe("PutObjectCommand");
    expect(putCmd?.Bucket).toBe("images");
    expect(putCmd?.Key).toBe("hg-002-styled-01.jpg");
    expect(putCmd?.Body).toEqual(PNG_BYTES);
  });

  it("writes a long-lived immutable Cache-Control so repeat reads stay on Cloudflare's edge (r2.dev rate limit — ADR 0017)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(PNG_BYTES, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    await store.putFromUrl("hg-002-final-abc12345.jpg", "https://luma.test/o");

    const putCmd = s3SendMock.mock.calls[0]?.[0];
    expect(putCmd?.CacheControl).toBe("public, max-age=31536000, immutable");
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
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it("throws on a non-2xx download", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 403 }));
    await expect(
      store.putFromUrl("x.jpg", "https://luma.test/403"),
    ).rejects.toThrow(/HTTP 403/);
    expect(s3SendMock).not.toHaveBeenCalled();
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
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it("rejects a filename that resolves to nothing safe, before any download", async () => {
    await expect(store.putFromUrl("..", "https://luma.test/x")).rejects.toThrow(
      /invalid image filename/,
    );
    await expect(store.putFromUrl("/", "https://luma.test/x")).rejects.toThrow(
      /invalid image filename/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it("accepts a 200 that omits content-type (some presigned stores do)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(PNG_BYTES, { status: 200 }));
    const url = await store.putFromUrl(
      "hg-002-draft-abcd1234.jpg",
      "https://luma.test/out",
    );
    expect(url).toBe("https://pub-abc123.r2.dev/hg-002-draft-abcd1234.jpg");
    expect(s3SendMock).toHaveBeenCalled();
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
    expect(s3SendMock).not.toHaveBeenCalled();
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
    expect(url).toBe("https://pub-abc123.r2.dev/evil.jpg");
    const putCmd = s3SendMock.mock.calls[0]?.[0];
    expect(putCmd?.Key).toBe("evil.jpg");
  });

  it("urlFor is the write-free stable URL for a filename", () => {
    expect(store.urlFor("hg-009-styled-02.jpg")).toBe(
      "https://pub-abc123.r2.dev/hg-009-styled-02.jpg",
    );
  });

  it("throws if config.r2 is not set", () => {
    const badConfig = { ...config(), r2: undefined };
    expect(() => new R2ImageStore(badConfig as Config)).toThrow(/requires r2 config/);
  });

  it("handles S3 upload errors", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(PNG_BYTES, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    s3SendMock.mockRejectedValueOnce(new Error("S3 access denied"));
    await expect(
      store.putFromUrl("x.jpg", "https://luma.test/out"),
    ).rejects.toThrow(/failed to upload.*S3 access denied/);
  });
});
